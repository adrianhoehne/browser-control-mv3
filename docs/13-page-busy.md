---
description: not_readable wird ehrlich — wenn die Seite beim Zugriff noch lädt, sagt die Antwort page_busy statt „die Seite gibt keinen lesbaren Inhalt her", damit der Agent es erneut versucht statt aufzugeben.
status: active
---

# Ehrliche Fehlercodes: `page_busy` statt „nicht lesbar"

Drei Messungen aus dem Alltag, alle am 2026-10-23:

1. **Erster `click` direkt nach `navigate`** antwortete
   „Diese Seite kann die Extension nicht lesen (interne Seite oder Sonderformat)" (so die Antwort damals; englisch seit `docs/54`),
   obwohl die Seite gewöhnlich war — `inspect` funktionierte im selben Moment, der
   zweite Versuch ging durch.
2. **`thomas-innovation.de`** stand im Tab als „Problem loading page", und
   `browser_read` antwortete „nicht lesbar".
3. Beim Warenkorb-Test dasselbe Muster: der erste Zugriff nach einer Navigation
   schlug fehl, der zweite nicht.

Gemeinsame Ursache: `injectPageCode` übersetzt **jede** Ablehnung von
`executeScript` in `not_readable`. „Die Seite ist nicht lesbar" und „die Seite war
noch nicht bereit" sind aber zwei verschiedene Dinge — und der Agent behandelt sie
gleich: er gibt auf, statt es erneut zu versuchen.

## Ziel

Wenn die Injektion abgelehnt wird, entscheidet **der Zustand des Tabs**, welcher
Code die Antwort trägt:

| Zustand des Tabs | Code | Bedeutung |
|---|---|---|
| `status: "loading"` | **`page_busy`** | die Seite lädt noch — ein neuer Versuch ist sinnvoll |
| alles andere | `not_readable` | Die Seite gibt nichts her (intern, PDF, Sonderformat) |
| `tabs.get` scheitert, Tab weg | `no_agent_tab` | Es gibt keinen Agenten-Tab mehr |

- `page_busy` trägt **keine** Felder (`url`, `kind`): es ist keine Aussage über die
  Seite, sondern über den Moment.
- `not_readable` behält alles aus Spec 10 (`url`, `kind`).
- **Kein automatischer Wiederholungsversuch.** Die Antwort wird ehrlich, das
  Verhalten bleibt eines: ein Aufruf, ein Ergebnis. Das Warten selbst ist
  Roadmap 09/10, nicht dieses Inkrement — und wer beides in einem Schritt baut,
  kann hinterher nicht sagen, welches von beidem geholfen hat.
- Die Entscheidung fällt an **einer** Stelle, in `injectPageCode`, also für `read`,
  `click`, `type` und `inspect` gleich.

## Non-goals

- **Kein Retry, keine Wartezeit, kein Timer.** Kein `document.readyState`-Warten,
  keine Ruhe-Erkennung (Roadmap 09/10).
- **Keine Änderung an `navigate`.** Es bleibt bei seinem eigenen Vertrag.
- **Kein neuer Code für „Tab hängt"**, „Seite zu groß" oder „CSP verbietet es" —
  dafür gibt es keine Messung, und geraten wird nicht.
- Keine neue Berechtigung, keine Änderung an `manifest.json`.

## Wire-Protokoll

Neuer Code `page_busy`, Fehlerobjekt **ohne** Zusatzfelder:

```json
{"ok":false,"error":{"code":"page_busy","message":"The page is still loading."}}
```

Alles andere unverändert.

## MCP-Werkzeug

| Code | Satz |
|---|---|
| `page_busy` | „The page is still loading — try again in a moment." |
| `no_agent_tab` bei fehlendem Tab nach der Injektion | derselbe Satz wie bisher (`TOOL_TEXTS.NO_AGENT_TAB`) |

Der Satz gilt für alle vier Werkzeuge, die `read`-Fehler melden können.

## Hub

Keine Änderung, keine neue Logzeile. Der Fehlercode steht wie jeder andere im
Log (`… failed peer=… code=page_busy`) — das ist die bestehende Zeile, kein neuer
Aufbau.

## Extension

- `injectPageCode(tabId, code)`: im `catch` **zuerst** `tabs.get(tabId)`.
  - wirft ⇒ `ReadError(no_agent_tab)` (der Tab ist wirklich weg)
  - `tab.status === "loading"` ⇒ `ReadError(page_busy)`, ohne Felder
  - sonst ⇒ `throw await notReadableError(tabId)` (Spec 10, unverändert)
- Der Tab-Blick darf die bestehende Anreicherung **nicht** doppelt lesen: der
  bereits geholte Tab wird an `notReadableError` weitergereicht, statt dort ein
  zweites `tabs.get` zu machen.
- `PAGE_BUSY_CODE`/`PAGE_BUSY_MESSAGE` als Konstanten neben den anderen.

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `test/extension.test.js` — Tab mit `status: "loading"`, Injektion abgelehnt | `page_busy`, **ohne** `url`/`kind` |
| dito — Tab mit `status: "complete"`, Injektion abgelehnt | `not_readable` **mit** `url`/`kind` (Spec 10 unverändert) |
| dito — `tabs.get` wirft im Fehlerpfad | `no_agent_tab` |
| dito — `click`, `type`, `inspect` im selben Zustand | alle drei antworten `page_busy` (eine Stelle, vier Werkzeuge) |
| `test/mcp.test.js` — `page_busy` für `read` und für `click` | der Satz aus `## MCP-Werkzeug` |
| `test/mcp.test.js` — `page_busy` für `type` und `inspect` | die zwei sonst ungetesteten Zweige; das Fixture kann den Code schon (`BC_TEST_*_ANSWER: "error:page_busy"`), es braucht **keine** Änderung |

## Acceptance criteria

1. `npm test; echo $?` → `0`, Ausgabe enthält `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. **Die 308 bestehenden Fälle laufen nicht wörtlich
   unverändert** — das ist am Diff zu prüfen (`git diff -U0 test/extension.test.js`)
   und besteht aus genau drei Sorten Änderung:
   - **vierzehn Fälle** setzen `status: "complete"` im Fixture (Bedeutung
     unverändert): `createAgentTabFixture` trägt heute `"loading"` als Default, und
     der Fehlerpfad liest den Zustand ab jetzt. Davon sind **dreizehn** über
     `answerForUnreadableAddress` und die Aufrufstellen erreichbar; der vierzehnte
     ist der umbenannte Fall aus Kriterium 3 — genau deshalb braucht auch
     `createReadTabs` die Option.
   - **eine Umbenennung**: `read_whenTheInjectionIsRefusedByTheBrowser_shouldAnswerNotReadable`
     heißt jetzt `read_whenTheTabIsCompleteAndTheInjectionIsRefused_shouldAnswerNotReadable`
     (das ist Kriterium 3 — zwei Fälle für dieselbe Aussage wären eine Dopplung).
   - **ein ersetzter Fall**: `read_whenTheTabLookupFailsAfterTheFirstCall_shouldReportNullUrlAndKindUnknown`
     prüfte das Best-Effort-Verhalten, das dieses Inkrement abschafft; an seine
     Stelle tritt `read_whenTheTabIsGoneInTheFailurePath_shouldAnswerNoAgentTab`.
2. Tab mit `status: "loading"` ⇒ `page_busy` ohne Zusatzfelder; Fall
   `read_whenTheTabIsStillLoading_shouldAnswerPageBusy`.
3. Tab mit `status: "complete"` ⇒ `not_readable` mit `url` und `kind`; Fall
   `read_whenTheTabIsCompleteAndTheInjectionIsRefused_shouldAnswerNotReadable`.
4. `tabs.get` wirft im Fehlerpfad ⇒ `no_agent_tab`; Fall
   `read_whenTheTabIsGoneInTheFailurePath_shouldAnswerNoAgentTab`.
5. `click`, `type`, `inspect` antworten im selben Zustand ebenfalls `page_busy`;
   Fälle `click_whenTheTabIsStillLoading_shouldAnswerPageBusy`,
   `type_whenTheTabIsStillLoading_shouldAnswerPageBusy`,
   `inspect_whenTheTabIsStillLoading_shouldAnswerPageBusy`.
6. **Live-Beleg**: Extension neu laden, pi neu starten, dann eine schwere Seite
   laden und **sofort** `browser_read` aufrufen — erwartet wird `page_busy` (oder,
   wenn die Seite schnell genug war, ein Erfolg; **nicht** erwartet wird
   `not_readable`).
   **Rot aus dem in `## Risiken` genannten Grund** (ein Tab meldet `complete`,
   während das neue Dokument noch getauscht wird) ist von einer echten Regression
   nicht zu unterscheiden — dann gehört die rote Zeile nach `## Bekannte Lücken`
   und **nicht** in eine Vorwärts-Korrektur. Die **Kernannahme** ist erst
   widerlegt, wenn `page_busy` über mehrere Versuche **nie** erscheint.

**Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 6 ist
erst nach den Handgriffen messbar, und der Betreiber lädt die Erweiterung aus
seinem eigenen Klon — also nach dem `git pull`. Kriterien 1–5 laufen vor dem
Commit, Kriterium 6 danach. **Fällt Kriterium 6 rot aus, gilt die Regel aus dem
Kriterium selbst:** rot wegen `complete`-während-Tausch ⇒ `## Bekannte Lücken`,
keine Vorwärts-Korrektur; erscheint `page_busy` über mehrere Versuche **nie** ⇒
zurück in diese Spec.

## Bekannte Lücken

- **Ein Tab, der `complete` meldet, während das neue Dokument noch getauscht
  wird**, bleibt `not_readable`. Das ist die Grenze dieses Inkrements: es
  etikettiert, es repariert nicht. Roadmap 09/10 nimmt sich das Warten vor.
- **Kriterium 6 ist live nicht beobachtbar gewesen** (2026-10-23, 13 Versuche):
  Drei schwere Seiten nach `navigate` gelesen, vier Klicks auf navigierende Links,
  zwei große Wikipedia-Artikel, eine absichtlich endlos ladende Adresse
  (`httpbin.org/drip`) — **jede Injektion gelang**, keine wurde abgelehnt. Ohne
  Ablehnung gibt es keinen Fehlerpfad, und ohne Fehlerpfad kein `page_busy`.
  Der Code ist damit **nur im Sandkasten belegt** (vier Fälle, per Mutation
  gegengeprüft: `page_busy`-Zweig gelöscht ⇒ vier Extension-Fälle rot). Das ist
  eine Messgrenze, keine rote Zeile: die Vorbedingung trat nicht ein, die Annahme
  wurde also nicht widerlegt — aber sie ist auch nicht draußen bestätigt.
  `httpbin.org` war aus dieser Umgebung nicht erreichbar; die eine Adresse, die
  das Rennen deterministisch erzwingen sollte, fiel damit aus.
- **Der Nutzen bleibt trotzdem:** wenn die Lage eintritt, sagt die Antwort jetzt
  das Richtige. Und Roadmap 09/10 (Ruhe-Erkennung) nimmt der Lage den Boden weg,
  statt sie nur zu benennen.

## Dev plan

1. **Testharness und Fixtures, ohne Verhaltenseffekt — nur
   `test/extension.test.js`.** `createReadTabs` **und `createInspectTabs`** bekommen
   eine Option `tabs` (Default unverändert), wie `createClickTabs`/`createTypeTabs`
   sie schon haben — ohne die zweite lassen sich die zwei `inspect`-Fälle nicht auf
   `complete` stellen, und Stufe 2s „ganzer Lauf `fail 0`" wäre unerreichbar.
   `answerForUnreadableAddress` und dreizehn bestehende Fälle setzen
   `status: "complete"` — **sechs über `answerForUnreadableAddress`, sieben je
   Aufrufstelle** (2 `click`, 2 `type`, 3 `inspect`), dazu der umbenannte Fall aus
   Kriterium 3 —, weil
   `createAgentTabFixture` heute `"loading"` als Default trägt und der Fehlerpfad
   den Zustand ab jetzt liest.
   **Die Umbenennung gehört hierher**, nicht in Stufe 2:
   `read_whenTheInjectionIsRefusedByTheBrowser_shouldAnswerNotReadable` heißt ab
   jetzt `read_whenTheTabIsCompleteAndTheInjectionIsRefused_shouldAnswerNotReadable`
   (Kriterium 3; zwei Fälle für dieselbe Aussage wären eine Dopplung).
   Proof: `node --test --test-reporter=tap test/extension.test.js | grep -E '^# (fail|cancelled|pass)'`
   → `fail 0`, `cancelled 0`, `pass` unverändert (niemand liest `status` in diesem
   Pfad, solange Stufe 2 fehlt). **Completed 2026-10-23** (zusammen mit Stufe 2) —
   308 Tests grün, `# pass 175` in der Extension.
2. **Der Fehlerpfad entscheidet.** `PAGE_BUSY_CODE`/`PAGE_BUSY_MESSAGE` neben
   `NOT_READABLE_*`. `notReadableError(tabId)` wird zu
   `notReadableErrorForTab(tab)` und **synchron**:
   `const address = asUrl(tab?.url); return new ReadError(NOT_READABLE_CODE,
   NOT_READABLE_MESSAGE, { url: cappedAddress(address), kind: kindFromUrl(address) })`.
   `tabAddressOrNull` entfällt (einziger Aufrufer). Der `catch` benutzt das
   vorhandene `readTabOrNull(tabId)`: `null` ⇒ `no_agent_tab`;
   `tab.status === TAB_STATUS_LOADING` ⇒ `page_busy`; sonst
   `throw notReadableErrorForTab(tab)`. Kommentar über dem `catch` mitziehen (der
   `await` gehört jetzt zu `readTabOrNull`). **Zwei weitere Kommentare nennen
   `notReadableError` und ziehen mit** (`extension/background.js` bei den
   Konstanten und am Injektions-Helfer). `injectPageCode` behält Signatur und alle
   sechs Aufrufstellen. Dazu: der Tab-weg-Fall wird ersetzt (siehe
   Kriterium 1).
   Proof: `node --test --test-reporter=tap --test-name-pattern='read_whenTheTabIsGoneInTheFailurePath|read_whenTheTabIsCompleteAndTheInjectionIsRefused' test/extension.test.js`
   → `# pass 2`; ganzer Lauf `fail 0`, `cancelled 0`.
3. **Neue Fälle: eine Stelle, vier Werkzeuge.**
   `read_whenTheTabIsStillLoading_shouldAnswerPageBusy` (zusätzlich
   `assert.equal("url" in error, false)` und dasselbe für `kind`), dazu die drei
   Fälle aus Kriterium 5. „Genau ein `tabs.get` im Fehlerpfad" ist mit dem
   bestehenden Zähler belegt — `createTabsStub` schreibt `tabs.get` nicht in
   `calls`, ein zweiter Zählpunkt wäre ein neuer Schalter für eine Aussage, die
   schon steht.
   Proof: `node --test --test-reporter=tap --test-name-pattern='PageBusy' test/extension.test.js`
   → `# pass 4`, `fail 0`; ganzer Lauf `pass` = heutige Zahl + 4.
   **Completed 2026-10-23** — 316 Tests grün.
4. **MCP: der Satz.** `PAGE_BUSY_CODE`, `TOOL_TEXTS.PAGE_BUSY = "Die Seite lädt
   noch — bitte gleich noch einmal versuchen."`, und je ein Zweig **innerhalb** der
   Blöcke `BROWSER_READ`, `BROWSER_CLICK`, `BROWSER_TYPE` sowie in
   `inspectFailureTextFor` — vier Zweige, nicht einer über dem Werkzeug-Switch
   (der würde auch `navigate` und `status` mitbeantworten). `test/mcp.test.js`:
   `PAGE_BUSY_TEXT` als eigene Konstante und vier Fälle mit
   `BC_TEST_*_ANSWER: "error:page_busy"`. `test/fixtures/fake-extension.mjs` bleibt
   **unverändert** — `answerModeFromEnv` schneidet `error:` ab und gibt jeden Code
   weiter.
   Proof: `node --test --test-reporter=tap test/mcp.test.js | grep -E '^# (fail|cancelled|pass)'`
   → `fail 0`, `cancelled 0`, `pass` = 69 im MCP-Test.
   **Completed 2026-10-23** — Gesamt 316 grün.

### What could go wrong

- **Der `status`-Default im Harness ist die Falle.** Wer ihn in
  `createAgentTabFixture` auf `"complete"` dreht, macht die Navigate-Wartefälle
  rot; geändert wird je Fall, nicht am Default.
- **`undefined` heißt „nicht ladend".** Der Vergleich ist strikt
  `=== TAB_STATUS_LOADING`, ohne Rückfall: ein Fixture oder eine ältere
  Firefox-Version ohne `status` antwortet `not_readable`, also wie vorher.
- **Toter Code.** `tabAddressOrNull` verliert seinen einzigen Aufrufer und muss
  weg — `npm run check` bliebe auch mit ihm grün, der Review nicht.
- **Zweite Quelle für `no_agent_tab`.** Geprüft: kein MCP-Satz und kein Test nimmt
  an, dass der Code nur aus dem frühen Pfad kommt.
- **Der Satz im Log.** `bridge/hub.mjs` schreibt `code=${code}`; `code=page_busy`
  erscheint ohne Zutun. Keine Zeile, kein Test dort.
- **`settleAsyncWork` reicht.** Der zusätzliche `await` ist reiner Microtask.

### Ordering and dependencies

1 inert, 2 braucht 1, 3 braucht 2, 4 ist im Code unabhängig, braucht 2 aber für
den Live-Pfad — und bleibt beim selben Schreiber. Kriterium 6 fährt der Betreiber
nach dem Commit; die Abnahme davor sind die drei Kommandos.

### What the next increment inherits

- **Kein Retry, keine Wartezeit** — Roadmap 09/10. `page_busy` ist ein Etikett,
  keine Reparatur.
- Ein Tab, der `complete` meldet, während das neue Dokument noch getauscht wird,
  bleibt `not_readable` (der `updateKeepsStatusCompleteFor`-Fall des Stubs). Diese
  Grenze ist bewusst und bleibt offen.
- **`notReadableErrorForTab(tab)` ist jetzt der einzige Anreicherungspunkt** für
  `not_readable` und bekommt den Tab statt einer Id: Spec 11 hängt sich dort ein
  und fasst den `catch` nicht an.
- **`no_agent_tab` hat zwei Quellen.** Ein späteres Inkrement darf nicht mehr
  annehmen, der Code heiße „nie navigiert".

## Risiken

- **Kriterium 6 ist nicht deterministisch.** Ob die Seite im Moment des Fehlers
  noch lädt, hängt von Leitung und Seite ab. Deshalb ist die Zusage „nicht
  `not_readable`" und nicht „garantiert `page_busy`".
- **`status: "loading"` deckt nicht jeden Fall.** Eine Seite, die fertig geladen
  ist, aber noch nicht injizierbar (etwa weil sie gerade ersetzt wird), bleibt
  `not_readable`. Das ist die Grenze dieses Inkrements; Roadmap 09/10 nimmt sich
  das Warten vor, nicht das Etikett.
- **Ein zusätzliches `tabs.get` im Fehlerpfad.** Nur im Fehlerfall, und der Tab
  wird für die Anreicherung ohnehin gebraucht — es bleibt bei einem Aufruf.
- **`no_agent_tab` aus dem Fehlerpfad** ist eine neue Quelle für diesen Code. Wer
  ihn behandelt, muss nichts ändern; er bedeutet dasselbe wie vorher.
  **Aber der Satz passt nur halb:** `TOOL_TEXTS.NO_AGENT_TAB` sagt „zuerst
  `browser_navigate` aufrufen", und für einen Tab, der **mitten im Aufruf**
  verschwunden ist, ist „zuerst" die falsche Hälfte. Die Handlung stimmt trotzdem
  (ein `navigate` legt einen neuen an), deshalb bleibt der Satz — umformuliert
  wird er in einem eigenen Inkrement, nicht hier.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine neue Berechtigung, kein Seitentext
  in Logs, Tests, Fixtures oder Doku.
- `extension/manifest.json`, `extension/options.*`, `bridge/hub.mjs`,
  `bridge/websocket.mjs`, `bridge/config.mjs` bleiben unverändert.
- `docs/PROJECT-STATE.md`, `docs/README.md`, `docs/ROADMAP.md` und `INSTALL.md`
  pflegt der Orchestrator.

## Open questions

Keine. Die Roadmap-Zeile 08g verlangt „`not_readable` nur, wenn die Seite wirklich
nicht lesbar ist"; der Betreiber hat die Reihenfolge am 2026-10-23 bestätigt
(08g vor 09/10 und 11).

## Review

**Runde 1 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Sechs Befunde, alle
übernommen. Der Reviewer hat Stufe 2 gegen eine Wegwerf-Kopie gespielt und bestätigt:
genau fünfzehn Fälle gehen rot (dreizehn Fixtures, die Umbenennung, der ersetzte
Fall) — die Liste in Kriterium 1 ist vollständig.

1. **`## Amendments` fehlte gegen Spec 10** — vier Zusagen (Signatur, `catch`,
   Testing-Zeile, Risiken-Zeile) wären stillschweigend abgeschafft worden. Jetzt
   benannt, mit Eigentümer (Stufe 2).
2. **Eine Testing-Zeile, die niemand bauen darf** — „genau ein `tabs.get`" war
   nicht beobachtbar (der Stub schreibt `tabs.get` nicht in `calls`, und Stufe 3
   lehnt einen Zähler ab). **Zeile gestrichen.**
3. **Die Umbenennung hatte keine Stufe** — jetzt in Stufe 1.
4. **Kriterium 6 konnte rot werden, ohne etwas zu beweisen** — die Ausnahme steht
   jetzt im Kriterium: dieser Grund gehört nach `## Bekannte Lücken`, Kernannahme
   erst widerlegt, wenn `page_busy` nie erscheint.
5. **Der `no_agent_tab`-Satz passt nur halb** — in `## Risiken` benannt, nicht
   umformuliert (eigenes Inkrement).
6. **Zwei stale Kommentare** nannten `notReadableError` — in Stufe 2 aufgenommen.

## Log

Noch keine Befunde.

Befunde beim Schreiben des Dev-Plans (2026-10-23), vom Architekten:

- **Kriterium 1 war falsch** („308 unverändert"): dreizehn Fixtures tragen heute
  `status: "loading"`, ein Fall wird ersetzt, einer umbenannt. **Übernommen**,
  die drei Sorten Änderung stehen jetzt namentlich im Kriterium.
- **Die Fixture braucht keine Änderung** — `BC_TEST_*_ANSWER: "error:page_busy"`
  kann den Code schon. Testzeile korrigiert.
- **`tabAddressOrNull` wird toter Code** und muss im selben Zug weg.

**Runde 3 (2026-10-23, `grizzled-senior-dev`): ✅ Ship it.** Keine Befunde, drei
Notizen für den Umsetzer:

1. Der Einleitungssatz der Amendments sagte noch „in Stufe 2 mitgezogen" — der
   Eigentümer ist der Orchestrator (Schritt 7). **Korrigiert.**
2. Es sind **vierzehn** Statuszeilen im Fixture, nicht dreizehn — der umbenannte
   Fall ist die vierzehnte, und genau deshalb braucht auch `createReadTabs` die
   Option. **Korrigiert.**
3. `url`/`kind` in Kriterium 3 tragen die sechs Helfer-Fälle, nicht der umbenannte
   Fall. **Im Kriterium so gelesen, nichts geändert.**
**Nachtrag 2026-10-23 (Spec 11):** `injectPageCode` hat jetzt ein drittes Argument
`{head = true}`; `settleAgentTab` ruft mit `{head: false}`, damit der Ruhe-Pfad keine
HEAD-Anfrage für den Papierkorb zahlt. Die Zusage „behält Signatur und alle sechs
Aufrufstellen" gilt damit nicht mehr.
