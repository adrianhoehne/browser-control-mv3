---
description: Ergänzt not_readable um den echten Content-Type, geholt per HEAD-Anfrage mit knapper Frist — damit der Agent bei Adressen ohne Endung (etwa /download?id=7) trotzdem erfährt, ob ein PDF, ein Bild oder eine HTML-Seite dahinterliegt.
status: active
---

# Der echte Typ: `contentType` per HEAD

**Dieses Inkrement ist der abgetrennte zweite Teil von Spec 10** — dort wurde es
nach der dritten Review-Runde herausgeschnitten, weil es eine eigene Fähigkeit
ist: Spec 10 leitet den Typ aus der **Adresse** ab, dieses hier fragt den
**Server**.

Der Fall, der es nötig macht: `/download?id=7` ist in Spec 10 `kind: "unknown"`,
obwohl ein PDF dahinterliegt. Und bei einer Seite hinter einer Anmeldung ist nicht
einmal die Endung eine Hilfe.

**Voraussetzung:** Spec 10 **und Spec 13** sind umgesetzt. Der Anreicherungspunkt heißt
heute **`notReadableErrorForTab(tab)`** (nicht mehr `notReadableError(tabId)`) und ist
**synchron**; er wird aus dem `catch` in `injectPageCode` aufgerufen, der drei Fälle
unterscheidet:

| Fall | Code | Felder |
|---|---|---|
| Tab weg | `no_agent_tab` | keine |
| Tab lädt noch | `page_busy` | **keine** — und das bleibt so |
| Seite gibt nichts her | `not_readable` | `url`, `kind` — hier kommt `contentType` hinzu |

**Nachtrag 2026-10-23:** Diese Spec ist vor zwölf Inkrementen geschrieben worden; die
Namen oben sind die heutigen. Ein `fetch` gibt es im Harness **noch nicht** (weder in
`extension/background.js` noch in `test/extension.test.js`), und `AbortController`
ebenso wenig — beides muss dieses Inkrement erst schaffen.

## Ziel

`error` bekommt ein drittes Feld, **nur** bei `not_readable`:

```json
{"code":"not_readable","message":"…",
 "url":"https://example.org/download?id=7","kind":"unknown",
 "contentType":"application/pdf"}
```

- **`contentType`** — der `Content-Type` aus einer **HEAD-Anfrage**, die die
  Extension nach dem Fehler stellt.
- **`null`**, wenn die Anfrage scheitert, **mit einem Status außerhalb 2xx
  antwortet**, zu lange braucht (**1,5 s**) oder für `kind: "internal"` und
  `"file"` gar nicht erst gestellt wird.
- Der Status wird geprüft, weil eine 401- oder 403-Seite brav `text/html`
  liefert — das ist der Typ der Fehlerseite, nicht der des Dokuments.
- Die Anfrage läuft mit `credentials: "omit"` und `redirect: "follow"`: ohne
  Cookies ist die Antwort ehrlicher, und bei einer Weiterleitung beschreibt
  `contentType` das Ziel — das ist, was der Browser zeigen würde.

Die Anreicherung ist **best effort und wirft nie**: jeder Fehler ergibt `null`.

## Non-goals

- **Kein Auslesen** von PDFs oder Bildern — der Typ wird benannt, nicht gelesen.
- **Kein Download**, kein Speichern.
- **Keine neue Berechtigung**: `fetch` läuft über die vorhandene Host-Erlaubnis
  `<all_urls>`.
- Keine Änderung an `kind`, `url` oder den MCP-Sätzen aus Spec 10 — nur ein
  zusätzlicher Klammerinhalt.

## Wire-Protokoll

Das Fehlerobjekt aus Spec 10 bekommt ein optionales drittes Feld:

```json
{"ok":false,"error":{"code":"not_readable","message":"…","url":"…","kind":"pdf","contentType":"application/pdf"}}
```

`contentType` erscheint **immer** bei `not_readable` — mit `null`, wenn nichts
bekannt ist. Andere Codes bleiben unverändert.

## MCP-Werkzeug

Erweitert die Sätze aus Spec 10 (`## MCP-Werkzeug` dort):

| Fall | Satz |
|---|---|
| `kind: "pdf"` + `contentType` | „… (Typ: pdf, Content-Type: application/pdf). Adresse: …" |
| `kind: "unknown"` + `contentType` | „… (Content-Type: application/pdf). Adresse: …" — Klammer ohne Typ |
| `kind: "pdf"`, `contentType: null` | wie Spec 10: „… (Typ: pdf). Adresse: …" |
| alles `null` | der heutige Satz, unverändert |

## Hub

Keine Änderung. Die Durchreiche aus Spec 10 trägt das dritte Feld mit, weil sie
`message.error` spreizt.

## Extension

- `contentTypeOf(url, kind)` — `internal`/`file` ⇒ sofort `null`, sonst
  `fetch(url, {method:"HEAD", credentials:"omit", redirect:"follow"})` mit
  `AbortController` und 1,5 s Frist; `clearTimeout` im `finally`; liefert
  `response.ok ? response.headers.get("content-type") : null`. Wirft nie.
- `notReadableErrorForTab(tab)` ruft `contentTypeOf` **nach** `kind` auf und legt das
  Ergebnis in `details`. **Damit wird die Funktion asynchron** — heute ist sie synchron,
  und der `catch` in `injectPageCode` muss sie mit `await` aufrufen (wie er es vor
  Spec 13 schon tat). `page_busy` und `no_agent_tab` bekommen weiterhin **kein**
  `contentType`.
- **`kindFromUrl` und `contentTypeOf` sehen die volle Adresse**; gekürzt wird nur
  `url` in `details` (2 048 Zeichen, Spec 10).
- **Der Wächter aus Spec 14 gilt auch hier:** ein HEAD, der nie antwortet, darf den
  Aufruf nicht hängen lassen — es gibt bereits `guardAfter`/`SETTLE_GUARD_MS` als Muster
  für eine extension-seitige Frist.

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `test/extension.test.js` — HEAD antwortet 200 mit `application/pdf` | `contentType` steht in der Fehlerantwort |
| dito — HEAD antwortet 200 **ohne** `Content-Type`-Header | `contentType: null`, Fehlercode unverändert |
| dito — HEAD antwortet 403 mit `text/html` | `contentType: null` (Statusprüfung) |
| dito — HEAD wirft (Netzfehler) | `contentType: null`, kein Wurf nach außen |
| dito — Frist läuft ab | `contentType: null`; `clock.runByDelay(1500)` beweist die Frist, danach `assert.deepStrictEqual(clock.pendingDelays(), [])`. **Kein `runNext()`**: der Ruhe-Wächter aus Spec 14 ist zuerst scharf und gäbe `4000` |
| dito — `about:config` und `file:///tmp/a.pdf` | **kein** `fetch`-Aufruf (Zähler bleibt 0) |
| dito — nach dem Fehler steht keine Frist mehr offen | `clock.pendingDelays() === []` (`clearTimeout` im `finally`) |
| dito — `kind: "pdf"` **und** `contentType: "text/html"` | Satz lautet „(Typ: pdf, Content-Type: text/html)" — **gewollt**: die Endung sagt pdf, der Server sagt etwas anderes |
| dito — HEAD antwortet mit einem Objekt **ohne `headers`** | `contentType: null`, kein Wurf, kein `read_failed` |
| dito — `AbortController.abort()` wirft | `contentType: null`, kein Wurf, kein `read_failed` |
| `read_onAnUnreadablePdfPage_shouldAskTheServerExactlyOnce` | der Ruhe-Pfad zahlt keinen zweiten HEAD (`headFetch.calls.length === 1`) |
| `test/hub.test.js` — Fehler mit `contentType` | `deepEqual` beweist die Durchreiche, die Logzeile bleibt wörtlich |
| `test/mcp.test.js` — `contentType` vorhanden | Satz nennt ihn, in beiden Klammerformen |
| `test/mcp.test.js` — `contentType` fehlt | Satz wie in Spec 10 |

## Acceptance criteria

1. `npm test; echo $?` → `0`, Ausgabe enthält `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. Alle Fälle aus Spec 10 laufen unverändert — am Diff
   geprüft, nicht an der Gesamtzahl.
2. Auf **`https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf`**
   ist `contentType` **nicht `null`** und enthält `pdf` (der Server antwortet
   `application/pdf; qs=0.001`; der Parameter stört nicht). Die Adresse ist festgenagelt, weil sie
   zur Abnahme mit `curl -I` belegt wurde — sie hängt weiterhin an einem fremden Server, und genau
   dafür gibt es die datierte Ausnahme.
3. Auf `about:config` wird **kein** `fetch` gestellt (`headFetch.calls.length === 0`), ebenso
   wenig auf einer `file:///`-Adresse — der Beleg für die Ausnahme in `## Ziel`.
4. Eine 403-Antwort mit `text/html` ergibt `contentType: null` — der Typ der
   Fehlerseite wird nicht als Typ des Dokuments ausgegeben.

**Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 2 ist
ein Live-Beleg und erst nach den Handgriffen möglich (Extension neu laden, pi neu
starten, `git pull` aus dem Betreiber-Klon). Kriterien 1, 3 und 4 laufen vor dem
Commit, Kriterium 2 danach; fällt es rot aus, wird vorwärts korrigiert und die
rote Zeile steht mit Datum unter `## Bekannte Lücken`. Ist die **Kernannahme**
widerlegt (der HEAD-Pfad stürzt ab statt `null` zu liefern), geht das Inkrement
zurück in diese Spec. Fällt **nur** Kriterium 2 (kein `contentType`), bleibt es
beim Inkrement: Spec 10 trägt den Nutzen allein, dieses hier ist die Zugabe.

## Messlauf (Kriterium 2, 2026-10-23, live)

Nach Reload der Erweiterung **und Neustart des Dienstes** (`systemctl --user restart
browser-control`). Der erste Versuch schlug fehl, weil nur die Erweiterung neu geladen war —
der Dienst lief noch mit dem Code von vor dem Commit. Das ist selbst ein Befund: **Extension
und Dienst müssen beide neu starten**, sonst zeigt die Antwort den alten Satz.

**1. PDF mit Endung** (`…/resources/pdf/dummy.pdf`):

> Diese Seite kann die Extension nicht lesen **(Typ: pdf, Content-Type: application/pdf;
> qs=0.001)**. Adresse: https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf

(so die Antworten damals; englisch seit `docs/54`)

**2. Dokument ohne Endung** (`https://arxiv.org/pdf/2101.00001` — arXiv liefert PDFs unter
`/pdf/<id>`, die Adresse verrät nichts):

> Diese Seite kann die Extension nicht lesen **(Content-Type: application/pdf)**. Adresse:
> https://arxiv.org/pdf/2101.00001

**Das ist der Fall, für den die Spec geschrieben wurde:** `kind` ist `unknown` (keine Endung), und
trotzdem weiß der Agent, dass ein PDF dahinterliegt. Vorher stand dort „interne Seite oder
Sonderformat" — eine Sackgasse. Die zweite Klammerform (ohne Typ) ist damit ebenfalls live belegt.

## Bekannte Lücken

- **Der `qs=0.001`-Parameter** wird durchgereicht, wie er kommt. Wer ihn weghaben will, braucht eine
  Normalisierung — bewusst nicht hier.
- **`data:`/`blob:`-Adressen** lösen einen HEAD aus, der scheitert und `null` ergibt.
- **Extension und Dienst müssen zusammen neu starten.** Ein Reload nur der Erweiterung lässt den
  alten Satz stehen, weil `mcp.mjs` im Dienstprozess läuft.

## Dev plan

**Die sieben Entscheidungen, vorab:**

1. **Das `await` steht an genau zwei Stellen:** in `notReadableErrorForTab(tab, {head = true})`
   auf `contentTypeOf`, und im `catch` von `injectPageCode` als
   `throw await notReadableErrorForTab(tab, {head})`. Die Falle aus Spec 10 kommt dadurch
   **nicht** zurück, solange das Wartende selbst nie ablehnt: `contentTypeOf` fängt alles
   (`try`/`catch`/`finally`, `fetch(...).catch(() => null)`, und `guardAfter` löst auf, es lehnt
   nie ab). Ein vergessenes `await` macht die heutigen Fälle
   `read_whenTheTabIsCompleteAndTheInjectionIsRefused…`, `…InternalAddress…` und
   `…PathEndsInPdf…` sofort rot — mit `read_failed` im Diff.
2. **Kleinster ehrlicher Stub:** ein `FakeFetch` neben `FakeTimerClock` in
   `test/extension.test.js`, dazu ein `FakeAbortController` (`signal = {}`, `abort()` merkt sich
   `aborted`). Der Stub sammelt `calls = [{url, options}]` und antwortet mit
   `{ok, headers: new Map([["content-type", …]])}`. Eingehängt in `createSandbox` als Kontextschlüssel
   `fetch`/`AbortController`, Option `headFetch`, durchgereicht über `startBackground`/
   `connectedBackground` und **zurückgegeben**, damit Fälle `headFetch.calls.length` lesen.
   **Default-Antwort wirft** — jeder Fall ohne eigene Antwort bekommt `contentType: null`, und an
   `read`/`click`/`type`/`inspect` ändert sich nichts.
3. **Die 1,5 s brauchen `guardAfter` *und* einen Controller.** Der Wächter garantiert, dass der
   Aufruf endet, auch wenn das `fetch` das Signal ignoriert; der Controller gibt im echten Browser
   den Socket frei. Beides wird im `finally` abgeräumt, **erst `guard.cancel()`, dann
   `controller.abort()`**. Im Fake-Clock-Beweis ist der Wächter der einzige Timer, also fällt
   `runByDelay(1500)` exakt (nicht `runNext()`: der Ruhe-Wächter ist zuerst scharf).
4. **`response.ok` auf der finalen Antwort ist das richtige Prädikat; die finale URL wird nicht
   geprüft.** Ein `redirect: "follow"` auf eine Anmeldeseite endet als 200 `text/html` — genau das,
   was der Browser zeigen würde. Eine finale-URL-Prüfung machte diesen gewollten Fall still zu
   `null`; 401/403/404 erledigt `ok` allein.
5. **Eine Aufrufstelle, aber ein zweiter Aufrufer des `catch`.** `click`/`type`/`inspect` erben den
   HEAD über `injectPageCode`. Der zweite Aufrufer ist **`settleAgentTab`**: sein Fehler wird
   verschluckt, ein HEAD dort wäre eine Anfrage für den Papierkorb (bis 1,5 s vor dem Lesen).
   Deshalb `injectPageCode(tabId, code, {head = true})` und `settleAgentTab` ruft mit `{head: false}`.
6. **Keine Kollision mit bestehenden Fällen.** Kein `not_readable`-Fall prüft den *Satz* der
   Schlüssel; `page_busy`/`no_agent_tab`/`read_failed` prüfen die *Abwesenheit* von `url`/`kind` —
   dort kommt `contentType` als dritte Abwesenheit dazu. `test/mcp.test.js` bricht nicht, weil die
   drei Zeilen in `NOT_READABLE_DETAIL_CASES` kein `contentType` tragen. `test/fixtures/fake-extension.mjs`
   bleibt unverändert (`BC_TEST_ERROR_DETAILS` spreizt beliebige Schlüssel).
7. **Der Hub protokolliert den Typ nicht.** Er schreibt bei `ok:false` nur
   `${method} failed peer=… code=${code}` und reicht `message.error` als `details` weiter. Keine
   Zeile wird angefasst; Stufe 5 pinnt das.

**Stufen:**

1. **Harness: `fetch` und `AbortController` in den Sandkasten.** `createHeadFetchStub(answer)` und
   `FakeAbortController` neben `FakeTimerClock`; `createSandbox` setzt die zwei Kontextschlüssel,
   nimmt die Option `headFetch` und gibt sie zurück; `startBackground`/`connectedBackground` reichen
   sie durch.
   Dazu gehört **`FakeTimerClock.advance(ms)`/`runByDelay(ms)`** — die Uhr kann heute nur FIFO
   (`runNext`), und genau das macht die Frist unfalsifizierbar, sobald der Ruhe-Wächter mitspielt.
   Proof: `npm test; echo $?` → `0` mit `# fail 0` und `# cancelled 0`. **Allein ist diese Stufe
   nicht rot zu bekommen** — reine Harness-Arbeit ohne Aufrufer. Sie schließt deshalb erst mit dem
   Frist-Fall aus Stufe 2 ab, und das steht als Reihenfolge fest, statt einen Scheinbeweis zu
   behaupten.
2. **Extension: `contentTypeOf` und die Anreicherung.** `HEAD_DEADLINE_MS = 1500` neben
   `SETTLE_GUARD_MS`; `contentTypeOf(url, kind)` — `internal`/`file` ⇒ sofort `null`, sonst
   `guardAfter` + `AbortController` + `Promise.race` über
   `fetch(url, {method:"HEAD", credentials:"omit", redirect:"follow", signal}).catch(() => null)`;
   im `finally` beide abbauen — **jeder Abbau selbst in einem `try`** (`guard.cancel()`, dann
   `try { controller.abort() } catch {}`), denn ein werfendes `abort()` würde den bereits
   ermittelten Rückgabewert ersetzen und die Funktion ablehnen lassen; Rückgabe in einem
   **eigenen `try`**
   (`response?.ok ? response.headers.get("content-type") : null`, `catch` ⇒ `null`), damit ein
   Antwortobjekt **ohne `headers`** oder ein werfendes `abort()` nicht als Ablehnung durchschlägt —
   sonst würde daraus genau das `read_failed`, das Entscheidung 1 ausschließen will.
   `notReadableErrorForTab(tab, {head = true})` wird `async`, leitet `kind` aus `asUrl(tab.url)` ab,
   kappt nur `details.url` und legt `contentType` dazu. `injectPageCode` ruft
   `throw await notReadableErrorForTab(tab, {head})`. `no_agent_tab`/`page_busy` bleiben ohne
   `details`.
   Proof (rot zuerst, das Feld fehlt heute): `read_whenTheHeadAnswers200WithAType_shouldCarryTheContentType`,
   `…200WithoutAContentTypeHeader_shouldAnswerNull`, `…403WithHtml_shouldAnswerNull`,
   `…NetworkError_shouldAnswerNullWithoutThrowing`, `…Deadline_shouldAnswerNullAfter1500ms`
   — **nicht** mit `clock.runNext()`: der Ruhe-Wächter aus Spec 14 (`guardAfter(SETTLE_GUARD_MS)`)
   wird **vor** der HEAD-Frist scharf, `runNext()` gäbe `4000` zurück und der Fall hinge, statt rot
   zu werden. Statt dessen bekommt `FakeTimerClock` ein `advance(ms)` bzw. `runByDelay(1500)`, und
   der Fall prüft danach `assert.deepStrictEqual(clock.pendingDelays(), [])`. **Das ist zugleich der entscheidbare Beleg für
   Stufe 1** — ohne ihn hieße „grün" dort nichts.
   `…InternalAndFileAddress_shouldNotAskTheServer` (`headFetch.calls.length === 0`).
   Kommando: `--test-name-pattern='Head'` → `# fail 0`, `# cancelled 0`.
3. **Der Ruhe-Pfad zahlt keinen HEAD.** `settleAgentTab` ruft
   `injectPageCode(tabId, settlePageCode(), {head: false})`.
   Proof: neuer Fall `read_onAnUnreadablePdfPage_shouldAskTheServerExactlyOnce` mit
   `assert.equal(headFetch.calls.length, 1)` — ohne die Stufe wären es zwei.
4. **MCP: der Satz nennt den Content-Type.** Zwei neue Einträge in `TOOL_TEXTS`:
   `NOT_READABLE_WITH_KIND_AND_TYPE(kind, contentType, url)` und
   `NOT_READABLE_WITH_TYPE(contentType, url)`; `notReadableText(details)` liest
   `nonEmptyString(details?.contentType)` und wählt zwischen den vier Formen — **keine Whitelist**,
   ein Medientyp hat keine geschlossene Menge. `test/mcp.test.js`: zwei Zeilen in
   `NOT_READABLE_DETAIL_CASES`, die drei bestehenden bleiben unverändert.
   Proof: `--test-name-pattern='NotReadable'` → `# fail 0`; vorher fallen genau die zwei neuen.
5. **Hub: durchreichen, nicht protokollieren.** In
   `hub_requestAnsweredWithOkFalse_shouldRejectWithTheExtensionErrorAttached` kommt
   `contentType: "application/pdf"` ins Fehler-Literal — der `deepEqual` beweist damit die
   Durchreiche, und die bestehende Zeilenprüfung (`assert.equal(failedLine, …)`) bricht bei jedem
   angehängten Feld. Eine zusätzliche `includes`-Prüfung ist deshalb überflüssig und bleibt weg. `bridge/hub.mjs` bleibt unangetastet.
   Proof: `--test-name-pattern='WithTheExtensionErrorAttached'` → `# pass 1`. **Auch diese Stufe ist
   nicht rot zu bekommen** — sie ist der Pin gegen eine spätere Logzeile, und das soll sie sein.

### What could go wrong

- **Verschlucktes oder überflüssiges `await`.** Ohne `await` wird ein Promise geworfen ⇒
  `read_failed`; dürfte `contentTypeOf` ablehnen, ersetzt die Ablehnung den `throw` ⇒ ebenfalls
  `read_failed`. Beide Seiten der Falle sind eine Zeile entfernt.
- **Doppelter HEAD:** ohne `{head: false}` fragt eine PDF-Seite zweimal, und das erste Mal bezahlt
  der Aufruf bis zu 1,5 s vor dem Lesen.
- **Frist nicht im `finally` abgeräumt** ⇒ `pendingDelays()` bleibt belegt und im echten Browser
  steht ein Timer.
- **Default-Stub, der 200 mit `application/pdf` antwortet,** würde bestehende PDF-Fälle still
  verändern — der Default **wirft**.
- **`details.url` kappen vor der Ableitung** wäre der Spec-10-Fehler in Neu.
- **Kriterium 2 ist live** (Ausnahme mit Datum) und gehört dem Betreiber; Kriterien 1, 3, 4 laufen
  vor dem Commit, Kriterium 1 am Diff.
- **`data:`/`blob:`-Adressen** lösen einen HEAD aus, der scheitert und `null` ergibt; ein
  `isHttpUrl`-Wächter bleibt bewusst draußen.
- **Nichts in eine Logzeile** — Header-Werte sind Fremddaten.

### Ordering and dependencies

1 → 2 → 3; 4 und 5 hängen an keiner Extension-Stufe, werden aber in dieser Reihenfolge gebaut, weil
5 den Wortlaut aus 4 im Literal trägt. Nach jeder Stufe `npm test` grün, `npm run check` grün.
Nicht Teil des Plans: `docs/README.md`, `docs/PROJECT-STATE.md`, Abnahme, Commit (Schritt 7) und
der Live-Beleg zu Kriterium 2.

### What the next increment inherits

- **Kein Auslesen** von PDFs oder Bildern, kein Download; `contentType` benennt, es liest nicht.
- **`contentType` gilt nur für `not_readable`** — `page_busy` und `no_agent_tab` tragen weiter
  nichts.
- **Kein `isHttpUrl`-Wächter, keine Zwischenspeicherung, kein zweiter HEAD-Vorstoß.**
- **Der Ruhe-Pfad bleibt ohne Anreicherung**; wer den verschluckten Fehler aus `settleAgentTab`
  sichtbar macht, muss entscheiden, ob er den Typ dort nachholt.
- **Der Hub protokolliert Fehlerfelder nicht** — auch künftige Felder gehören in den Rahmen und in
  den Satz; der Pin in `test/hub.test.js` bricht, wenn jemand es anders will.

## Risiken

- **Der HEAD ist eine zweite Anfrage — zwei Fälle, zwei Antworten.** Antwortet die Seite
  **direkt mit 401/403** (etwa eine geschützte Ressource), bleibt `contentType` `null`, statt den
  Typ der Fehlerseite zu melden. **Leitet** sie dagegen auf eine Anmeldung um, die mit 200
  `text/html` antwortet, steht `text/html` im Feld — das ist gewollt (es ist, was der Browser
  zeigen würde) und die einzige Stelle, an der das Feld über die **Seite** statt über das
  **Dokument** spricht.
- **Manche Server verbieten HEAD** (405): dann `null`. Verlangt ist kein Erfolg.
- **1,5 s Frist bei jedem unlesbaren Lesevorgang** — nur im Fehlerfall, aber der
  Agent wartet dann einmal länger.
- **`redirect: "follow"`** kann auf eine andere Adresse führen; `contentType`
  beschreibt dann das Ziel. Gewollt, steht als Kommentar an `contentTypeOf`.
- **Nicht-http-Schemata mit `kind: "unknown"`** (etwa `data:`) lösen einen HEAD
  aus. Spec-konform; ein `isHttpUrl`-Wächter wäre eine Zeile, ist aber eine
  eigene Entscheidung.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine neue Berechtigung, kein Seitentext
  in Logs, Tests, Fixtures oder Doku. `extension/manifest.json` und
  `extension/options.*` bleiben unverändert; `bridge/hub.mjs` wird **nicht**
  angefasst (Spec 10 hat es erledigt).

## Open questions

Keine. Die Frist (1,5 s), `credentials: "omit"` und die Statusprüfung sind mit dem
Betreiber am 2026-10-23 als Zuschnitt dieses Inkrements festgelegt.

## Review

**Runde 1 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Acht Befunde, alle übernommen. Der
wichtigste war eine **Unmöglichkeit**: der Frist-Beweis über `clock.runNext()` konnte nicht halten,
weil der Ruhe-Wächter aus Spec 14 zuerst scharf wird und `4000` zurückgäbe — der Fall wäre nicht rot
geworden, sondern hätte gehangen.

**Runde 2 (2026-10-23): 🔧 Fix these.** Sechs Befunde — und zwei der Runde-1-Korrekturen waren
**halb** gelandet (ein `runNext() === 1500` stand noch an zwei Stellen), während beim Umnummerieren
**Kriterium 3 verloren ging**. Genau der Fehler von Spec 17: dem eigenen Bericht glauben statt der
Datei. Seither ist jede Stelle einzeln gegengegrept.

**Runde 3 (2026-10-23): ✅ Ship it.** Sechs-Punkte-Prüfung am Dateizustand, alle bestanden. Drei
Notizen, übernommen.

## Log

Je Runde eine Zeile pro Befund, alle **übernommen**:

- **Runde 1** (8): Frist-Beweis über `runNext()` unmöglich → `runByDelay`/`advance`. `contentTypeOf`
  konnte über `headers.get` und das `finally` doch werfen → eigenes `try`, Testzeile. Zwei fehlende
  Testzeilen → ergänzt. `## Risiken` widersprach `## Ziel` (401 direkt vs. 302 auf Anmeldung) →
  beide Fälle benannt. `## Amendments` fehlte für 13/14 → ergänzt. Kriterium 2 behauptete
  Unabhängigkeit von fremden Servern → ehrlich gemacht. Redundante `includes`-Prüfung → entfernt.
  `kind: pdf` + `text/html` → als gewollt benannt.
- **Runde 2** (6): zwei Runde-1-Korrekturen waren halb gelandet, Kriterium 3 war beim Umnummerieren
  verloren → wiederhergestellt, Liste durchgehend. Dazu: werfendes `abort()` im `finally` → selbst
  abgesichert, mit Testzeile; `FakeTimerClock.advance` gehört in Stufe 1; Kommasplice beseitigt.
- **Runde 3** (3 Notizen): `pendingDelays`-Vergleich als `assert.deepStrictEqual`; die Notiz, dass
  Stufe 1 rot-first sein könnte, bleibt als Vorschlag; Review und Log gefüllt.

**Code-Review (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these → ✅ Ship it.** Acht Regressionen
selbst gesetzt, alle neuen Fälle rotten an der richtigen Stelle. Zwei Testlücken waren zu schließen:

- **`guard.cancel()` war ungepinnt** — alle acht HEAD-Fälle blieben grün, wenn man ihn löscht; die
  Zeile nach dem Fehler war nur im Frist-Fall geprüft, und dort hatte `runByDelay` den Timer schon
  verbraucht. Jetzt läuft der 200-mit-Typ-Fall über die Uhr und verlangt `pendingDelays() === []`
  nach der Antwort. Gegenprobe: ohne `cancel` steht dort `[1500]`.
- **Die „dritte Abwesenheit" aus Entscheidung 6 war nie gelandet** — `page_busy` und
  `no_agent_tab`/`read_failed` prüfen jetzt auch `"contentType" in error === false`. Gegenprobe:
  ein `contentType` in den `page_busy`-Details macht vier Zusicherungen rot.

Nebenbefund des Reviewers, übernommen: die `?? null`-Abweichung des Umsetzers ist **tragend** —
ohne sie verschwände das Feld aus dem Rahmen, weil `undefined` von `JSON.stringify` verschluckt
wird.
