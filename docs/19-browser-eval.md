---
description: browser_eval wertet Code im Seitenkontext des Agenten-Tabs aus und liefert das Ergebnis als JSON — hinter dem Options-Schalter „Code-Auswertung erlauben" (Default aus), weil dieser Aufruf die Seite ändern kann.
status: active
---

# Code im Agenten-Tab: `browser_eval`

Die Roadmap-Zeile 08f lag seit dem 2026-10-23 still, weil sie eine
Betreiberentscheidung brauchte: `browser_inspect` (Spec 09) beantwortet eine
Frage, `browser_eval` **führt Code aus** — und Code kann mehr als lesen. Der
Betreiber hat am 2026-10-23 entschieden: **Seitenänderungen mit Schalter.**

Damit ist der Zuschnitt derselbe wie bei den Passwortfeldern (Spec 07): ein
Optionsfeld, Default aus, bei **jedem** Aufruf gelesen, und ein eigener
Fehlercode, den der Agent nicht als „kaputt" missverstehen kann.

## Ziel

> **Geändert am 2026-11-19 (`docs/50`):** Der Code ist der Rumpf einer **async**-Funktion,
> `await` ist auf oberster Ebene erlaubt, `return` bleibt Pflicht. Alles andere in diesem
> Abschnitt gilt unverändert.

`browser_eval({code, tab?})` führt `code` im Seitenkontext des Agenten-Tabs aus
und gibt das Ergebnis zurück:

```json
{"tabId":18,"url":"https://…","title":"…","elapsedMs":7,"result":{"a":1}}
```

- **Was `elapsedMs` misst:** die Differenz zweier `Date.now()` — von unmittelbar
  vor dem Aufruf des Codes bis **nach** der Abbildung auf JSON, auf ganze
  Millisekunden gerundet. Eine Wartezeit auf ein Promise ist darin enthalten,
  die Injektion selbst nicht. Eine Zahl ohne dieses Fenster wäre keine Messung.

- **Der Code ist ein Funktionsrumpf**, nicht ein Ausdruck: ausgeführt wird
  `new Function(code)()`. Statements und `return` sind erlaubt, ein impliziter
  Rückgabewert eines Ausdrucks ohne `return` gibt es nicht (dann ist das Ergebnis
  `null`). Eigener Scope: `browser`, `sendResponse`, die Tab-Id und alles andere
  aus der Extension sind **nicht** sichtbar. Sichtbar ist das DOM über den
  Xray-Wrapper von Firefox (`document`, `location`, `querySelector`, Attribute) —
  **nicht** zwingend die globalen Variablen, die die Seite selbst gesetzt hat
  (`window.jQuery` bleibt typischerweise `undefined`, weil das Inhalts-Skript
  eine eigene Kapsel hat). Wer Seiten-Globals braucht, ist mit diesem Werkzeug
  nicht bedient; das gehört gemessen und, falls es trägt, nach `## Bekannte Lücken`.
- **Leerer oder fehlender Code** ist `invalid_params` (nichts auszuführen ist ein
  Aufruffehler, kein Ergebnis). Obergrenze `EVAL_CODE_LIMIT = 20000` Zeichen,
  darüber ebenfalls `invalid_params` — die Grenze steht gegen einen Aufruf, der
  die Nachrichtengrenze von 5 MiB nur knapp verfehlt.
- **Das Ergebnis wird auf JSON abgebildet**, im Seitenkontext, vor der Antwort:
  - Primitive (`number`, `string`, `boolean`, `null`) wie sie sind,
  - `undefined` → `null` (JSON kennt es nicht; ein Feld, das fehlt, ist etwas
    anderes als eines mit `null`, deshalb `null` statt Weglassen),
  - Funktion → `"[function]"`, Symbol → `"[symbol]"`, `BigInt` → sein Dezimal-
    String,
  - ein DOM-`Element` (`nodeType === 1`) → `{"kind":"node","tag":"…","selector":"…"}`
    mit dem Selektor aus dem vorhandenen `selectorForElement` (dieselbe Mechanik
    wie `inspect`, damit der Agent das Ergebnis direkt an `click` weitergeben
    kann),
  - ein anderer DOM-Knoten (Textknoten, Kommentar, Dokument) →
    `{"kind":"node","nodeType":<n>}` — **ohne** `tag` und `selector`, weil es
    beide nicht gibt; den Inhalt holt der Aufrufer mit `.textContent` in einem
    zweiten Aufruf, statt dass dieses Werkzeug zwei Formate erfindet,
  - zirkuläre oder anders nicht serialisierbare Strukturen → `eval_result_unserializable`,
  - mehr als `EVAL_RESULT_LIMIT = 10000` Zeichen JSON → `eval_result_too_large`
    (die Antwort wird nicht geschnitten: ein halbes JSON ist keine Antwort).
- **Ein Promise als Ergebnis wird abgewartet**, höchstens
  `EVAL_TIMEOUT_MS = 2000`; danach antwortet die Extension `eval_timeout`.
  Der Code selbst wird dabei **nicht** unterbrochen — er kann nicht unterbrochen
  werden —, nur die Antwort wird nicht länger aufgehalten.
- **Ein Fehler im Code** ist `eval_failed` mit der Meldung aus der Seite
  (`error.message`, auf 500 Zeichen gekürzt), ohne Stack: der Stack ist unsere
  Seite, nicht die des Aufrufers.
- **Keine Ruhe, kein Slot.** `eval` wartet nicht auf DOM-Ruhe und belegt den
  Warte-Slot nicht: was der Code anstößt, ist unbekannt, und ein `settled` wäre
  eine Behauptung. Auch abgelöst wird nichts — `superseded` würde eine
  Ausführung behaupten, die weiterläuft. Zwei Aufrufe im selben Tab laufen
  deshalb schlicht beide.
- **`tab`** wie bei allen Werkzeugen seit Spec 16: mit `tab` genau dieser
  Agenten-Tab, ohne `tab` der zuletzt benutzte.
- **Die Fehlerwahrheit bleibt geerbt.** Der Code geht durch dieselbe Injektion
  wie `read` und `inspect` (`injectPageCode`): eine fehlende Tab-Id ist
  `no_agent_tab`, eine noch ladende Seite `page_busy`, eine wirklich
  unlesbare Seite `not_readable` mit Typ und Adresse (Specs 10/11/13). `eval`
  erfindet keine eigene Seite dieses Dreiecks.
- **Nur der Hauptrahmen** (`frameId: 0`) ohne `frame`; seit Spec 25 adressiert `eval` optional einen Rahmen (URL-Teilstring), wie jedes Werkzeug bis Zeile 15 der
  Roadmap. Ein iframe ist für `eval` nicht erreichbar.

## Non-goals

- **Keine Sandbox und keine Prüfung des Codes.** Ein Schalter, der „nur Lesen"
  durchsetzen soll, bräuchte eine statische Analyse von JavaScript; die gibt es
  nicht zuverlässig. Der Schalter ist deshalb ganz oder gar nicht (siehe
  `## Open questions`).
- **Kein Warten auf Spätfolgen.** `setTimeout(() => …, 5000)` im Code läuft nach
  der Antwort weiter; `eval` wartet nicht darauf und liest die Seite danach nicht
  neu.
- **Kein `timeoutMs`-Parameter.** Eine Zahl am Aufruf wäre eine zweite Grenze
  neben `CALL_TIMEOUT_MS` (20 s) und `EVAL_TIMEOUT_MS` (2 s).
- **Kein Ersatz für die bestehenden Werkzeuge.** `inspect`, `click`, `type` und
  `read` bleiben der Weg für ihre Fälle — sie prüfen Sichtbarkeit, Passwortfelder
  und Ruhe, was `eval` nicht tut.
- **Keine neue Berechtigung.** `<all_urls>` und `executeScript` decken das
  Inkrement; `manifest.json` bleibt in `permissions` unverändert.
- **Kein Frames-Zugriff mehr** (Spec 25 hat ihn für `eval` gebracht); **kein Shadow-DOM-Werkzeug** — beides sind eigene Zeilen
  (15, 16). `eval` sieht offene Schattenbäume nur, weil JavaScript sie sieht.
- **Kein Netzwerk-Intercepting** über das hinaus, was der Seitenkontext ohnehin
  erlaubt.

## Konfiguration (neu): Code-Auswertung

| Schlüssel | Element-Id | Typ | Default | Wirkung |
|---|---|---|---|---|
| `allowEval` | `allowEval` | Boolean | `false` | Ist er nicht `true`, lehnt die Extension **jeden** `eval`-Aufruf mit `eval_not_allowed` ab, bevor eine Injektion stattfindet |

- Gelesen wird der Wert **bei jedem Aufruf** aus `browser.storage.local`, nicht
  beim Start zwischengespeichert — ein Umstellen wirkt sofort, ohne Reload.
- Nur der Boolean `true` zählt; ein handgeschriebenes `"true"` in der Ablage
  öffnet nichts. **Ein Lesefehler zählt als aus**: ist `storage.local` nicht
  lesbar, lehnt `eval` ab und loggt den Grund — bei einem Schalter, der
  Passwortfelder freigibt, ist das Schließen Vertrag und nicht
  Implementierungsdetail. Dieselbe Regel wie bei `allowPasswordFields`.
- `options.html` bekommt eine zweite Checkbox „Code-Auswertung erlauben" mit
  einem Hinweistext, der **benennt, was sie freischaltet**: Code im Seitenkontext
  kommt an dieselben Daten wie die Seite selbst, einschließlich `document.cookie`
  (nicht die `HttpOnly`-Cookies), `localStorage` und `fetch` mit den Cookies des
  Profils — **und Passwortfelder**: mit diesem Schalter darf der Agent auch ein
  `input[type=password]` füllen, unabhängig von „Passwortfelder erlauben"
  (Betreiberentscheidung 2026-10-23, siehe `## Open questions`).
- Die Regel in `CONTRIBUTING.md` („Der Browser gehört dem Betreiber") wird in derselben
  Stufe nachgezogen — **eng**: `allowEval` hebt die Passwortfeld-Sperre nur für
  `eval` auf. `browser_type` bleibt unverändert und lehnt `input[type=password]`
  weiter ab, solange `allowPasswordFields` aus ist.
- Die Schreibweise des Schlüssels steht in `options.html`, `options.js` und
  `background.js`; `test/manifest.test.js` pinnt `options.html` und `options.js`
  (wie bei `allowPasswordFields`), die Zeile in `background.js` wird von einem
  eigenen Fall dort gepinnt (`const ALLOW_EVAL = "allowEval";`).

## Wire-Protokoll (neu: `eval`)

`PROTOCOL.METHODS` bekommt in **beiden** Kopien (`extension/protocol.js`,
`bridge/protocol.mjs`) `EVAL: "eval"`.

Anfrage:

```json
{"type":"request","id":9,"method":"eval","params":{"code":"return document.title","tab":18}}
```

Antwort, Erfolg:

```json
{"type":"response","id":9,"ok":true,
 "result":{"tabId":18,"url":"https://example.org/","title":"Example Domain",
           "elapsedMs":4,"result":"Example Domain"}}
```

Antwort, abgelehnt:

```json
{"type":"response","id":9,"ok":false,
 "error":{"code":"eval_not_allowed","message":"Code-Auswertung ist in den Einstellungen der Erweiterung nicht erlaubt."}}
```

Neue Codes, alle in `bridge/mcp.mjs` und `extension/background.js` mit derselben
Schreibweise:

| Code | Wann |
|---|---|
| `eval_not_allowed` | Schalter `allowEval` ist nicht `true` |
| `eval_failed` | der Code hat geworfen |
| `eval_timeout` | das Promise kam nicht innerhalb von 2 000 ms |
| `eval_result_too_large` | das JSON-Ergebnis überschreitet 10 000 Zeichen |
| `eval_result_unserializable` | das Ergebnis lässt sich nicht auf JSON abbilden (zirkulär) |

Dazu die geerbten Codes `invalid_params`, `no_agent_tab`, `page_busy`,
`not_readable` — keiner davon neu.

## MCP-Werkzeug

Neunter Eintrag der Tabelle in `bridge/mcp.mjs` ist heute `browser_close_tab`;
`browser_eval` wird **angehängt** (Position 9, zehnter Eintrag), nicht eingefügt —
fünf Assertions in `test/mcp.test.js` indizieren die Tabelle nach Position, und
`test/mcp.test.js` pinnt heute `tools.length === 9`.

- Name: `browser_eval`
- Beschreibung (deutsch, im Stil der anderen):
  „Wertet Code im Seitenkontext des Agenten-Tabs aus und liefert das Ergebnis als
  JSON; Code darf die Seite ändern, auch Passwortfelder füllen. Nur möglich, wenn
  „Code-Auswertung erlauben" in den Einstellungen der Erweiterung eingeschaltet
  ist — sonst `eval_not_allowed`. Mit `tab` genau diesen Tab, ohne `tab` den
  zuletzt benutzten."
- `inputSchema`: `{code: string, frame?: string, tab: integer ≥ 1}`, `required: ["code"]`,
  `additionalProperties: false`. Keine Längenprüfung im Schema: die Grenze
  (`20 000`) ist die Regel der Extension, und eine zweite Meinung hier würde
  einen Aufruf ablehnen, den die Extension ohnehin abgelehnt hätte — oder einen
  durchlassen, den sie ablehnt. Dieselbe Linie wie `limit` bei `inspect`.

## Hub

- `request(PROTOCOL.METHODS.EVAL, params)` — nichts Eigenes, derselbe Weg wie
  `inspect`.
- Logzeile bei Erfolg: `eval tab=18 elapsedMs=4 ok=true`. Das `ok` ist ein
  **Literal** `true`, kein Feld aus dem Ergebnis: `#reportResult` läuft
  ausschließlich für `ok: true`, und das Ergebnisobjekt trägt kein `ok`. Bei
  Ablehnung ergänzt `#handleResponse` wie heute `<method> failed` mit dem Code.
- **Weder Code noch Ergebnis stehen im Log.** Das ist die Log-Hygiene dieses
  Inkrements: der Code kann ein Passwort oder ein Token als Literal enthalten, und
  das Ergebnis kann der Seiteninhalt sein. Geloggt werden Tab-Id, Laufzeit und
  Zustand — kein Inhalt —, solange Zeile 18 der Roadmap (Whitelist statt
  Sperrliste) nicht gebaut ist.
- `CALL_TIMEOUT_MS` bleibt 20 000 ms; die Extension antwortet spätestens nach
  `EVAL_GUARD_MS` = 2 500 ms (`EVAL_TIMEOUT_MS` 2 000 plus 500 ms Luft), weil sie
  ein Promise nicht länger abwartet und der Seitentimer gedrosselt sein kann.

## Extension

- Konstanten: `EVAL_TIMEOUT_MS = 2000`, `EVAL_CODE_LIMIT = 20000`,
  `EVAL_RESULT_LIMIT = 10000`, `EVAL_MESSAGE_LIMIT = 500`, `ALLOW_EVAL = "allowEval"`,
  `EVAL_NOT_ALLOWED_CODE`, `EVAL_FAILED_CODE`, `EVAL_TIMEOUT_CODE`,
  `EVAL_RESULT_TOO_LARGE_CODE`, `EVAL_RESULT_UNSERIALIZABLE_CODE`, dazu die
  englischen Sätze (seit `docs/54`).
- `evalRequestParams(params)` prüft **nur** `code`: String, nicht leer,
  höchstens 20 000 Zeichen. `tab` prüft `addressedAgentTab` (Typ und
  Untergrenze), nicht diese Funktion. Die Reihenfolge in `evalAgentTab` ist
  Vertrag: **(1)** Schalter (`evalAllowed()`; aus ⇒ `eval_not_allowed`), **(2)**
  `evalRequestParams`, **(3)** `addressedAgentTab`, **(4)** Injektion. Ein
  ausgeschaltetes `eval` sortiert also keine Parameter, bevor es ablehnt.
- `evalAgentTab(params)`: Tab auflösen (`addressedAgentTab`), Code injizieren
  (`injectPageCode(tab.id, evalPageCode({code, …}))`), Ergebnis durch
  `evalResultOf`.
- `evalPageSource(cfg)`: die Seitenfunktion. Sie baut die Funktion
  (`new Function(cfg.code)`), ruft sie, wartet ein Promise mit
  `Promise.race` gegen einen Timer, bildet das Ergebnis über `serialize` ab
  (inklusive `selectorForElement` für Elemente), prüft die Größe und antwortet mit
  einem `outcome` — `ok`, `threw`, `timeout`, `too_large`, `unserializable`.
  Ein Fehler **im Aufbau** der Funktion (Syntaxfehler) ist `threw` mit der
  Meldung des Parsers: für den Aufrufer ist das dasselbe wie ein Wurf.
- `evalResultOf(tabId, results)`: dünn, wie `inspectResultOf` — nichts wird
  nachgerechnet. `result` und `elapsedMs` sind die Worte der Seite.
- `answerRequest` bekommt den `eval`-Zweig neben `inspect`. `evalErrorFor`
  bildet drei Fälle ab: `EvalError` ⇒ `{code, message}`, **`ReadError` ⇒
  `readErrorFrame(error)`** (sonst würden `page_busy` und `not_readable` zu
  `eval_failed`, und die geerbte Fehlerwahrheit aus `## Ziel` wäre verloren),
  alles andere ⇒ `eval_failed` mit dem allgemeinen Satz. `inspectErrorFor` hat
  genau diese dritte Zeile; sie wird übernommen, nicht neu erfunden.
- Die Optionsseite: zweite Checkbox, `loadSettings`/`handleSubmit` um
  `allowEval` erweitert, `readChecked` unverändert.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/protocol.test.js` | `METHODS.EVAL === "eval"` **auf beiden Seiten** wörtlich | die Methode fehlt nicht in einer der Kopien (der `deepStrictEqual`-Vergleich fängt nur Abweichung, nicht beidseitiges Fehlen) |
| `test/manifest.test.js` | `allowEval` steht in `options.html` und `options.js` gleich geschrieben; `background.js` trägt `const ALLOW_EVAL = "allowEval";` | der Schalter speichert, wo die Extension liest |
| `test/mcp.test.js` | Tabelle hat zehn Einträge, der zehnte heißt `browser_eval` | neues Werkzeug ist angehängt, nicht eingefügt |
| `test/mcp.test.js` | `browser_eval` ohne `code` → Schema-Ablehnung; `code` als Zahl → Ablehnung; `timeoutMs` als Argument → Ablehnung | `required` und `additionalProperties: false` gelten |
| `test/mcp.test.js` | jeder der fünf neuen Codes bekommt einen eigenen Satz, keiner fällt auf den allgemeinen zurück | der Agent liest eine Ursache, keine Zahl |
| `test/hub.test.js` | `eval` löst über die `id` auf und ruft `onStatus` nicht | der Hub unterscheidet die Methoden (wie `navigate`) |
| `test/hub.test.js` | Logzeile `eval tab=18 elapsedMs=4 ok=true`, mit `BC_LOG: "debug"` gestartet; **kein** Vorkommen des Codes und des Ergebnisses im Log | Log-Hygiene dieses Inkrements — mit dem Vorgabe-Level `info` wäre der Fall blind gegen den Debug-Block |
| `test/hub.test.js` | `eval` mit `ok:false` → `ExtensionError` mit `code` | Ablehnungen kommen unverfälscht an |
| `test/extension.test.js` | Schalter aus → `eval_not_allowed`, **keine** Injektion (der Harness zählt `executeScript`-Aufrufe) | der Schalter schützt wirklich, nicht nur die Antwort |
| `test/extension.test.js` | Schalter `"true"` (String) → `eval_not_allowed` | nur der Boolean öffnet |
| `test/extension.test.js` | `return document.title` → `result` ist der Titel; `elapsedMs` ist eine ganze Zahl ≥ 0 | der Grundfall |
| `test/extension.test.js` | mehrzeiliger Code mit `const` und `return` → Ergebnis wie erwartet | Funktionsrumpf, nicht Ausdruck |
| `test/extension.test.js` | Code ohne `return` → `result: null` | dokumentierte Semantik |
| `test/extension.test.js` | Code wirft → `eval_failed` mit der Meldung, gekürzt auf 500 Zeichen, ohne Stack | Fehler kommen an, ohne Stack |
| `test/extension.test.js` | Syntaxfehler im Code → `eval_failed` | Aufbau und Ausführung sind derselbe Fehlerpfad |
| `test/extension.test.js` | `return undefined` → `null`; `return {a: undefined}` → `{"a": null}` (das Feld fehlt **nicht**); `return () => 1` → `"[function]"`; `return 10n` → `"10"` | Abbildungsregeln, inklusive des Replacers, der `undefined`-Felder hält |
| `test/extension.test.js` | zirkuläres Objekt → `eval_result_unserializable` | Abbildung scheitert benannt |
| `test/extension.test.js` | Ergebnis mit 10 001 Zeichen → `eval_result_too_large`, mit 10 000 → `ok` | Grenze ist exakt |
| `test/extension.test.js` | Promise, das nach 50 ms auflöst → `ok` und Wert; Promise, das nach 3 000 ms auflöst → `eval_timeout` | Warten und Frist |
| `test/extension.test.js` | Code mit 20 001 Zeichen → `invalid_params`, leerer Code → `invalid_params` | Code-Grenze |
| `test/extension.test.js` | Tab fehlt → `no_agent_tab`; Seite lädt → `page_busy`; interne Seite → `not_readable` mit `kind` und `url` — Fälle `eval_withoutAnAgentTab_shouldAnswerNoAgentTab`, `eval_whenTheTabIsStillLoading_shouldAnswerPageBusy`, `eval_whenThePageIsInternal_shouldAnswerNotReadableWithKindAndUrl` | geerbte Fehlerwahrheit, alle drei Seiten des Dreiecks, und der einzige Beleg für `readErrorFrame` in `evalErrorFor` |
| `test/extension.test.js` | zwei `eval`-Aufrufe im selben Tab im selben Tick → beide `ok`, keiner `superseded`, kein Slot-Eintrag | kein Slot, keine Ablösung |
| `test/extension.test.js` | `eval` ohne `tab` adressiert den zuletzt benutzten Agenten-Tab | `tab`-Regel wie überall |
| `test/manifest.test.js` | `options.html` und `options.js` tragen die Id `allowEval`, und der Hinweistext nennt „Passwortfelder" | der Schalter sagt selbst, was er aufhebt |
| `test/http-mcp.test.js` | `tools/list` über HTTP nennt `browser_eval` mit `code` als Pflichtfeld | das Werkzeug ist auch über den Dienst erreichbar |

Die bestehenden Fälle bleiben bis auf drei benannte Pins unverändert grün:
`tools.length === 9` (`test/mcp.test.js`), `TOOL_COUNT = 9` und das
Werkzeug-Namensarray (`test/http-mcp.test.js`) **müssen** sich ändern — sie
werden auf zehn erweitert, nicht umgeschrieben. `test/fixtures/fake-extension.mjs`
bekommt `eval` als beantwortbare Methode.

## Acceptance criteria

Jedes Kriterium trägt seine Art in Klammern: **lokal** ist mit dem genannten
Befehl, Testfall oder Exit-Code entschieden; **live** braucht den echten Browser
des Betreibers (Reload der Erweiterung, pi-Neustart) und wird von **ihm**
abgehakt, nicht vom Orchestrator. Kein Kriterium hier ersetzt das
Code-Review-Gate aus `CONTRIBUTING.md` (Schritt 6) — das bleibt ein Gate.

**Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Acceptance`): die Live-Kriterien
2, 3, 8, 9 und die Zeitaussage aus 5 sind erst nach dem `git pull` im eigenen
Klon des Betreibers messbar, also nach dem Commit. Dann gilt: die lokal entscheidbaren Kriterien
laufen vor dem Commit, die Messung danach; fällt ein Messkriterium rot aus, wird
vorwärts korrigiert und die rote Zeile steht unter `## Bekannte Lücken`.
**Kernannahme** dieses Inkrements sind Kriterium 2 und 3: der Code erreicht den
Seitenkontext und darf ihn ändern. Ist das widerlegt, geht das Inkrement zurück
in die Spec — `## Bekannte Lücken` ist dafür kein Ersatz.

1. **Der Schalter schützt** (lokal). Mit `allowEval` aus (Default) antwortet
   `browser_eval {code:"return document.title"}` mit `eval_not_allowed`, und die
   Zahl der `executeScript`-Aufrufe ist davor und danach gleich. Beleg:
   `node --test test/extension.test.js` → die Fälle
   `eval_whenTheSwitchIsOff_shouldRefuseWithoutInjecting` und
   `eval_whenTheSwitchHoldsTheStringTrue_shouldRefuseWithoutInjecting` sind grün
   (`# fail 0`). Ein `grep` auf die Zusammenfassungszeile belegt hier nichts — der
   Fall mit seiner `scriptCalls`-Zahl tut es.
2. **Der Grundfall läuft** (live, Kernannahme). Mit `allowEval` an liefert
   `browser_eval {code:"return document.title"}` auf `https://example.org/`
   `result: "Example Domain"`, `tabId` als Zahl und `elapsedMs ≥ 0`. Beleg:
   Aufruf über pi, Antwort im Verlauf. Lokal vorbelegt durch
   `eval_withReturnDocumentTitle_shouldAnswerTheTitle`.
3. **Die Seite lässt sich ändern** (live, Kernannahme).
   `browser_eval {code:"document.body.dataset.probe = '1'; return 1"}`
   antwortet `ok`, und ein anschließendes
   `browser_inspect {selector:"body[data-probe='1']"}` findet genau ein Element.
   Beleg: beide Antworten im Verlauf; ohne `eval` gäbe es kein `data-probe`.
4. **Statements und `return`** (lokal). Mehrzeiliger Code
   (`const a = 6; const b = 7; return a * b`) liefert `42`; ein Code ohne
   `return` liefert `null`. Beleg: die Fälle
   `eval_withMultiLineCodeAndReturn_shouldAnswer42` und
   `eval_withoutAReturn_shouldAnswerNull`.
5. **Promises werden abgewartet, aber nicht ewig** (lokal gestellt, live im
   Zeitverhalten). `return new Promise(r => setTimeout(() => r(42), 50))` liefert
   `42` (`eval_withAPromiseThatResolvesAfter50ms_shouldAnswerTheValue`);
   `return new Promise(r => setTimeout(() => r(1), 3000))` liefert
   `eval_timeout` (`eval_withAPromisePastTheDeadline_shouldAnswerEvalTimeout`,
   `eval_whenThePageNeverAnswers_shouldAnswerEvalTimeoutThroughTheGuard`). Live
   ist nur die Zusatzaussage, dass die Antwort **in unter 3 s** kommt — das prüft
   den Wächter gegen den gedrosselten Seitentimer.
6. **Ein Fehler im Code ist ein Fehler im Code** (lokal gestellt, live nachgemessen).
   `browser_eval {code:"throw new Error('probe')"}` liefert `eval_failed` mit
   „probe" in der Meldung und **nicht** `not_readable` oder `read_failed`. Beleg
   hat **zwei** Hälften: die Extension
   (`eval_whenTheCodeThrows_shouldAnswerEvalFailedWithTheMessageAndNoStack`, dazu
   `eval_withAThrownMessageOf600Characters_shouldCutItAt500`) und die Bridge
   (`mcp_toolsCallBrowserEval_whenTheExtensionAnswersEvalFailedWithThePageMessage_shouldReturnTheSentenceForThatCode`).
   Die zweite Hälfte fehlte bei der ersten Live-Messung — die Extension schickte
   die Seitenmeldung, die Bridge warf sie weg; siehe `## Bekannte Lücken`.
7. **Geerbte Fehlerwahrheit** (lokal). Fehlender Tab → `no_agent_tab`, ladende
   Seite → `page_busy`, interne Seite → `not_readable` mit `kind: "internal"` und
   `url`. Beleg: die drei genannten Fälle in `test/extension.test.js`. Sie
   entstehen dort, wo `read` sie auch prüft: **nicht** im Seitenspiegel, sondern
   in `injectPageCode`s `catch` — `executeScript` wird abgelehnt, und der Tab
   entscheidet (`status: "loading"` ⇒ `page_busy`, sonst
   `notReadableErrorForTab` ⇒ `not_readable` mit `kind`/`url`); `browser_navigate`
   keine `about:`-Adresse öffnet.
8. **Das Log bleibt sauber** (live). Eine Marke, die **nur** im `eval`-Code und im
   `eval`-Ergebnis vorkommt (etwa `evalmarker-ergebnis-4711`), steht nach einem
   `eval` nicht im Journal, und die Zeile `eval tab=… elapsedMs=… ok=true` steht
   dort. Beleg:
   `journalctl --user -u browser-control -n 200 | grep -c 'evalmarker'` → `0`,
   `… | grep -c 'eval tab='` → `≥ 1`. Eine fremde Marke taugt dafür nicht: `inspect`
   loggt seinen Selektor (`inspect selector=… found=…`, Spec 09), also findet ein
   `grep` auf den Mutations-Selektor `data-probe` dessen Zeile — das ist kein Leck
   von `eval`, sondern die Logzeile eines anderen Werkzeugs. Lokal vorbelegt durch
   `hub_eval_shouldLogOnlyTabElapsedAndOk` mit `BC_LOG: "debug"`.
9. **Kein Slot, keine Ablösung** (live). Zwei `browser_eval`-Aufrufe im selben Tab
   im selben Tick werden beide mit `ok` beantwortet; keiner meldet `superseded`.
   Beleg: Live-Aufruf wie bei Spec 17, **Kriterium 5** (`## Messlauf`); lokal
   vorbelegt durch `eval_inParallelInTheSameTab_shouldAnswerBoth`.
10. **Keine neue Berechtigung** (lokal). `git diff` an `extension/manifest.json`
    ist leer (die `permissions`-Liste bleibt, wie Spec 05 sie hinterlassen hat).
    Beleg: `git diff --exit-code extension/manifest.json`.
11. **Die Abnahme ist grün** (lokal). `npm test; echo $?` → `0` mit `# fail 0`
    **und** `# cancelled 0`, darin die Abbildungsgrenzen
    (`eval_withAResultOfExactlyTenThousandJsonCharacters_shouldAnswerOk`,
    `…TenThousandAndOne…_shouldAnswerTooLarge`,
    `eval_withACircularResult_shouldAnswerEvalResultUnserializable`) und
    `invalid_params` (`eval_whenTheCodeIsMissingOrTooLong_shouldAnswerInvalidParams`);
    `npm run check; echo $?` → `0`;
    `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → keine Ausgabe, Exit 1.
    Genau vier bestehende Pins müssen sich ändern (zehn statt neun Werkzeuge):
    `tools.length` und das `tools.map((tool) => tool.name)`-Array in
    `test/mcp.test.js`, `TOOL_COUNT` und das Namensarray in
    `test/http-mcp.test.js`. `tools[8].name` bleibt gültig, weil angehängt wird.
12. **Der Schalter sagt, was er aufhebt** (lokal). `extension/options.html`
    enthält den Hinweistext zur Checkbox `allowEval`, und er nennt die
    Passwortfelder; in `CONTRIBUTING.md` steht die Ausnahme für `allowEval` neben der
    für `allowPasswordFields`. Beleg: `grep -c 'allowEval' CONTRIBUTING.md` → `≥ 1`,
    `grep -c 'Code-Auswertung' extension/options.html` → `≥ 1`,
    `grep -A12 'id="allowEval"' extension/options.html | grep -c 'Passwortfelder'`
    → `≥ 1`, `… | grep -c 'einfrieren'` → `≥ 1`. Der Schnitt auf den Block ist
    nötig (das Label „Passwortfelder erlauben" steht schon heute in der Datei),
    und `-A12` statt `-A8`, weil der Hinweis länger wird als der alte: fällt ein
    Pflichtwort aus dem Fenster, wird ein **korrektes** Kriterium rot.

## Dev plan

**Am Code geprüft, vorab — vier Befunde, die den Zuschnitt bestimmen:**

1. **Die Werkzeugtabelle hat neun Einträge; `browser_eval` ist der zehnte**, `tools[9]`. Die Prosa dieser Spec sagte an einer Stelle „Neunter Eintrag" — korrigiert auf „Zehnter" (Position 9, nach `browser_close_tab`); `test/mcp.test.js` pinnt `tools.length === 9` von heute.
2. **`runPageCode` macht `JSON.stringify(vm.runInNewContext(…))` synchron** (`test/extension.test.js:374`) — ein Promise aus einem Schnipsel kommt dort als `{}` an. Genau deshalb braucht `read` den Wächter und `eval` eigenen Harness: **jeder** `eval`-Fall fährt die Injektion über `runWaitingPageCode` (Seitenuhr, `await` des Rückgabewerts), nie über `runsOnDefaultPage`.
3. **Der Seitentimer ist in Firefox gedrosselt** (Spec 14, `docs/PROJECT-STATE.md`: `read` hing im nicht fokussierten Fenster bis zur Zeitüberschreitung; deshalb `SETTLE_GUARD_MS = 4000`, `guardAfter`). `EVAL_TIMEOUT_MS` allein im Seitenkontext reicht nicht: die Extension braucht denselben Wächter, sonst sieht der Aufrufer nach 10 s `ExtensionTimeout` statt `eval_timeout` und Kriterium 5 („antwortet in unter 3 s") fällt um.
4. **`slotMapKeys` behauptet, `background.js` baut genau *eine* `Map`** (`test/extension.test.js:1247`). `eval` darf keine `Map` anlegen (kein Pending-Buch, kein Cache), sonst werden alle Slot-Fälle rot, nicht nur die neuen.

**Stufen:**

1. **Wire-Konstante `eval` in beiden Kopien.** `bridge/protocol.mjs` und `extension/protocol.js`: `METHODS.EVAL: "eval"` angehängt nach `CLOSE_TAB`. Neuer Fall in `test/protocol.test.js` nach dem Muster des `INSPECT`-Falls (`extensionAndBridgeProtocols_methodsEval_shouldBothSpellItOutLiterally`, zwei wörtliche `assert.equal(…METHODS.EVAL, "eval")` — der Ganzvergleich ist blind gegen einen Schlüssel, der in beiden Kopien fehlt).
   Proof: `node --test --test-reporter=tap test/protocol.test.js | grep -E '^# (pass|fail)'` → ein Fall mehr, `# fail 0`. **Completed 2026-10-27**

2. **Der Schalter `allowEval`.** `extension/options.html`: zweite `.checkbox` nach der Passwortfeld-Box, `<input id="allowEval" name="allowEval" type="checkbox" />`, Label „Code-Auswertung erlauben", darunter ein `<p class="hint">`, der benennt, was frei wird: Code im Seitenkontext kommt an dieselben Daten wie die Seite (`document.cookie` ohne `HttpOnly`, `localStorage`, `fetch` mit den Cookies des Profils), darf die Seite **ändern**, hebt **die Passwortfeld-Sperre** auf und kann den Tab **einfrieren**, wenn der Code nie zurückkehrt; Wert bei jedem Aufruf gelesen. `extension/options.js`: `const ALLOW_EVAL = "allowEval"` neben `ALLOW_PASSWORD_FIELDS`, in `loadSettings` (`stored[ALLOW_EVAL] === true`) und in `handleSubmit` (`[ALLOW_EVAL]: readChecked(ALLOW_EVAL)`); `readChecked` und `readFieldValue` bleiben unverändert. `extension/background.js`: `const ALLOW_EVAL = "allowEval"` neben `ALLOW_PASSWORD_FIELDS_KEY` und `async function evalAllowed()` als Zwilling von `passwordFieldsAllowed` (Array-Form, `=== true`, `catch` ⇒ `false` plus `console.warn` — eine unlesbare Ablage schließt, sie öffnet nie). `CONTRIBUTING.md`, `## Rules`, „Der Browser gehört dem Betreiber": der Passwortfeld-Absatz nennt `allowPasswordFields` **und** `allowEval` mit der Betreiberentscheidung vom 2026-10-23. `test/manifest.test.js`: zwei Fälle nach dem Muster der Passwortfelder (Checkbox vorhanden **und** `type="checkbox"`; `const ALLOW_EVAL = "allowEval";` und `\[ALLOW_EVAL\]:\s*readChecked\(ALLOW_EVAL\)`, gepinnt an der Zuweisung) und der Hinweistext enthält „Passwortfelder".
   Proof: `node --test --test-reporter=tap test/manifest.test.js` → `# fail 0`; `grep -c 'allowEval' CONTRIBUTING.md` → ≥ 1; `grep -c 'Code-Auswertung' extension/options.html` → ≥ 1; `grep -A12 'id="allowEval"' extension/options.html | grep -c 'Passwortfelder'` → ≥ 1 und `… | grep -c 'einfrieren'` → ≥ 1 (Kriterium 12 ist damit vor dem ersten `eval` entschieden). Die beiden Pflichtwörter stehen **wörtlich** im Hinweistext: „Passwortfelder" und „einfrieren" — nicht als Synonym, sonst grept der Proof ins Leere. Die Assertion in `test/manifest.test.js` muss auf den **Block** der `allowEval`-Box geschnitten sein, nicht auf `html`: das alte Label „Passwortfelder erlauben" erfüllt jeden Test, der den ganzen Text nimmt, ohne dass der neue Hinweis geschrieben wurde. **Completed 2026-10-27**

3. **Ablehnung ohne Injektion — der Schalter zuerst, dann alles andere.** In `extension/background.js`: alle Konstanten des Inkrements in einem Block (`EVAL_TIMEOUT_MS = 2000`, `EVAL_CODE_LIMIT = 20000`, `EVAL_RESULT_LIMIT = 10000`, `EVAL_MESSAGE_LIMIT = 500`, die fünf Codes, die deutschen Sätze), `class EvalError extends Error` neben `InspectError`. `answerRequest` bekommt den `EVAL`-Zweig neben `INSPECT` (mit `return`, wie jeder andere). Neu: `answerEval(target, request)` (Muster `answerInspect`), `evalErrorFor(error)` — `EvalError` ⇒ `{code, message}`, **`ReadError` ⇒ `readErrorFrame(error)`** (ohne diese Zeile würde `page_busy`/`not_readable` zu `eval_failed`; `inspectErrorFor` hat genau diese Zeile, sie wird kopiert, nicht neu erfunden), sonst `eval_failed` mit dem allgemeinen Satz. `evalRequestParams(params)` prüft nur `code`: `typeof === "string"`, `!== ""`, `length <= EVAL_CODE_LIMIT` ⇒ sonst `EvalError(INVALID_PARAMS_CODE, …)`; **kein `trim`** (ein Code aus Leerzeichen ist kein leerer Code; er läuft und ergibt `null` — die wörtliche Lesart, und kein Fall pinnt den Leerraum). `tab` bleibt `addressedAgentTab(params, EvalError)`s Sache (`requestTabId` erledigt Typ und Untergrenze). Reihenfolge in `evalAgentTab(params)`: **(a)** `if (!(await evalAllowed())) throw new EvalError(EVAL_NOT_ALLOWED_CODE, EVAL_NOT_ALLOWED_MESSAGE)`, **(b)** `evalRequestParams`, **(c)** Tab auflösen, **(d)** Injektion. In dieser Stufe endet (d) mit `throw new EvalError(EVAL_FAILED_CODE, EVAL_FAILED_MESSAGE)` — kein erfundenes Ergebnis; Stufe 4 ersetzt genau diese Zeile. Harness: `sendEval(socket, id, params)` neben `sendInspect`.
   Proof: neue Fälle `eval_whenTheSwitchIsOff_shouldRefuseWithoutInjecting` (Schalter aus, `code: "return document.title"` ⇒ `eval_not_allowed`, `tabs.scriptCalls.length === 0` — **vor** und nach dem Aufruf gleich), `eval_whenTheSwitchHoldsTheStringTrue_shouldRefuseWithoutInjecting` (`settings: { ...STORED_TAB_SETTINGS, allowEval: "true" }`), `eval_whenTheSwitchIsOffAndTheCodeIsEmpty_shouldAnswerEvalNotAllowed` (pinnt die Reihenfolge aus der Spec), `eval_whenTheCodeIsMissingOrTooLong_shouldAnswerInvalidParams` (leer und 20 001 Zeichen, mit `settings: { ...STORED_TAB_SETTINGS, allowEval: true }` — ohne den Schalter wäre der Fall grün und bewiese nichts), `eval_withoutAnAgentTab_shouldAnswerNoAgentTab`, **`eval_whenTheTabIsStillLoading_shouldAnswerPageBusy`** und **`eval_whenThePageIsInternal_shouldAnswerNotReadableWithKindAndUrl`** — die beiden letzteren sind der einzige Fall, der `readErrorFrame` in `evalErrorFor` rot macht, wenn jemand die Zeile weglässt; ohne sie ist Befund B1 nur ein Satz. Der Weg ist der von `read`, nicht der Seitenspiegel: `executeScript` wird abgelehnt, der Tab trägt `status: "loading"` bzw. eine `about:`-Adresse (Spec 10/13 machen es genauso). **Completed 2026-10-27**

4. **Ausführen: die Seitenfunktion, der Wurf, die Frist.** `evalPageSource(cfg)` in `extension/background.js` — verschachtelt, schließt über nichts, alle Zahlen als Argument (`cfg.code`, `cfg.timeoutMs`, `cfg.messageLimit`); `Date.now()` am Anfang; `new Function(cfg.code)()` in `try`; ein `thenable` wird per `Promise.race` gegen einen `setTimeout` über `cfg.timeoutMs` abgewartet und der Timer danach mit `clearTimeout` entschärft. Rückgabe in jedem Fall ein `outcome`: `{outcome:"ok", url, title, elapsedMs, json}`, `{outcome:"threw", message}` (auch ein Syntaxfehler aus `new Function` — für den Aufrufer dasselbe), `{outcome:"timeout"}`, später `too_large`/`unserializable`. Meldung: `String(error?.message ?? error).slice(0, cfg.messageLimit)` — ein geworfener String hat kein `message`, deshalb der Fallback. `evalPageCode(cfg)` = `pageSnippetCode(evalPageSource, [cfg])`. `evalResultOf(tabId, results)` (Muster `inspectResultOf`): `threw` ⇒ `EvalError(EVAL_FAILED_CODE, message)`, `timeout` ⇒ `EvalError(EVAL_TIMEOUT_CODE, …)`, `ok` ⇒ `{tabId, url, title, elapsedMs, result: JSON.parse(first.json)}` (der Parse ist die einzige Arbeit dort und kann nur an unserem Fehler scheitern), alles andere ⇒ `console.warn` + `eval_failed` mit dem allgemeinen Satz. In `evalAgentTab`: `const guard = guardAfter(EVAL_GUARD_MS)` mit `const EVAL_GUARD_MS = EVAL_TIMEOUT_MS + 500`, `Promise.race([injectPageCode(tab.id, evalPageCode(cfg)), guard.promise])`, gewinnt der Wächter ⇒ `EvalError(EVAL_TIMEOUT_CODE, …)`, `guard.cancel()` im `finally` (Begründung: Befund 3 oben, `docs/PROJECT-STATE.md` zu Spec 14 — der Trap wird zitiert, nicht neu hergeleitet). Harness: `runEvalPageCode(code, page)`, das `runWaitingPageCode` mit derselben Seitenuhr benutzt, und in den Fällen `executeScript: async (tabId, details) => [await runEvalPageCode(details.code, page)]`; ein Marker wie `/*bc:settle*/` ist **nicht** nötig, weil `eval` genau einen Schnipsel injiziert und nie den Ruhe-Schnipsel (`tabs.scriptCalls.length === 1` pinnt das).
   Proof: Fälle `eval_withReturnDocumentTitle_shouldAnswerTheTitle` (plus `Number.isInteger(elapsedMs)` und `elapsedMs >= 0`), `eval_withMultiLineCodeAndReturn_shouldAnswer42`, `eval_withoutAReturn_shouldAnswerNull`, `eval_whenTheCodeThrows_shouldAnswerEvalFailedWithTheMessageAndNoStack` (Meldung enthält `probe`, nicht `at `), `eval_withASyntaxError_shouldAnswerEvalFailed`, `eval_withAPromiseThatResolvesAfter50ms_shouldAnswerTheValue`, `eval_withAPromisePastTheDeadline_shouldAnswerEvalTimeout` (Seitenuhr bis 3 000 ms ⇒ `outcome: timeout`), `eval_whenThePageNeverAnswers_shouldAnswerEvalTimeoutThroughTheGuard` (`executeScript` liefert ein nie erfülltes Promise, `clock.runByDelay(EVAL_GUARD_MS)`, Antwort `eval_timeout`), `eval_inParallelInTheSameTab_shouldAnswerBoth`; am Ende jedes Falls `clock.pendingDelays()` ohne `EVAL_GUARD_MS` (Wächter entschärft) und `pendingDelays()` der Seitenuhr leer. Alle Fälle, die ausführen sollen, tragen `settings: { ...STORED_TAB_SETTINGS, allowEval: true }` — mit einem nackten `{ allowEval: true }` gäbe es keinen Agenten-Tab und jeder Fall endete grün als `no_agent_tab`. Neue Pins in `test/protocol.test.js`: `CALL_TIMEOUT_MS > 2500` mit den Literalen als Kommentar — die Extension muss vor dem Hub antworten (Risiko „Zwei Grenzen statt einer"); `EVAL_GUARD_MS` selbst steckt in der IIFE und ist von außen nicht prüfbar, der Pin deckt die 2 500 also nicht wörtlich.
   Proof-Kommando: `node --test --test-name-pattern="eval_" test/extension.test.js` → `# fail 0`. **Completed 2026-10-27**

5. **Abbildung und Grenzen.** `serialize` in `evalPageSource` (verschachtelt, `WeakSet` gegen Zyklen, wirft nie nach außen — ein Fehler wird `{outcome:"unserializable"}`): `undefined` ⇒ `null` (auch als *Feld*, deshalb explizit gesetzt statt von `JSON.stringify` weggelassen — `JSON.stringify(…, replacer)` mit einem Replacer, der `null` statt `undefined` zurückgibt, ist der kürzere Weg und hält den Schlüssel), `function` ⇒ `"[function]"`, `symbol` ⇒ `"[symbol]"`, `bigint` ⇒ Dezimal-String, `Element` (`nodeType === 1`) ⇒ `{kind:"node", tag, selector}` mit `selectorForElement(node, cfg.valueLimit, cfg.classLimit)` — die beiden Grenzen sind `INSPECT_TEXT_LIMIT`/`INSPECT_CLASS_LIMIT` als Argumente, keine neuen Zahlen. Andere Knoten (`nodeType !== 1`) ⇒ `{kind:"node", nodeType}` ohne weitere Felder — der Vertrag sagt das ausdrücklich, damit ein Textknoten nicht als `{}` ankommt und wie eine stille Nicht-Antwort aussieht. `evalPageCode(cfg)` bekommt dafür `selectorForElement.toString()` als `extraHelpers` (wie `inspectPageCode`); die Hilfsfunktionen sind für den Nutzercode **nicht** sichtbar, weil `new Function` im globalen Scope der Seite kompiliert, nicht in der IIFE — das ist die Zusage „eigener Scope" aus der Spec und wird nicht durch eine Prüfung, sondern durch die Bauart gehalten. Größe: `json = JSON.stringify(serialize(produced))` in der Seite, `json.length > cfg.resultLimit` ⇒ `{outcome:"too_large"}`; `evalResultOf` bildet das auf `EvalError(EVAL_RESULT_TOO_LARGE_CODE, …)` ab.
   Proof: `eval_withUndefinedFunctionAndBigIntResults_shouldMapThemAsDocumented` (`null`, `"[function]"`, `"10"`), `eval_withAnUndefinedField_shouldKeepTheKeyWithNull` (`return {a: undefined}` ⇒ `{"a": null}` — sonst ist der Replacer unbelegt), `eval_withACircularResult_shouldAnswerEvalResultUnserializable`, `eval_withAResultOfExactlyTenThousandJsonCharacters_shouldAnswerOk` / `…TenThousandAndOne…_shouldAnswerTooLarge` — gebaut als `"x".repeat(9998)` bzw. `"x".repeat(9999)`, weil `JSON.stringify("x".repeat(n))` genau `n + 2` Zeichen hat (wer `repeat(10001)` schreibt, prüft 10 003), `eval_withAThrownMessageOf600Characters_shouldCutItAt500`, `eval_withADomNodeResult_shouldAnswerTheSelectorOfThatElement` (Basis `createInspectFixture()` mit `page.dom === true`, Code `return document.querySelector("#warenkorb-link")` — ohne `page.dom` hat der Seitenspiegel kein `querySelectorAll` und `selectorForElement` liefe in den `catch`), `eval_withATextNodeResult_shouldAnswerKindNodeAndNodeType` (`return document.createTextNode("x")` ⇒ `{"kind":"node","nodeType":3}` — der einzige Fall für den zweiten Knoten-Zweig). **Completed 2026-10-27**

6. **Hub und Fixture.** `bridge/hub.mjs`: `formatEvalLine(result)` ⇒ `eval tab=${tabId} elapsedMs=${elapsedMs} ok=true` — `ok` ist ein **Literal** und kein Feld aus dem Ergebnis (`#reportResult` läuft nur für `ok: true`, das Ergebnis trägt kein `ok`; `NO_FIELD` gilt nur für die beiden Zahlen, wenn sie fehlen), `#reportEval(result)` ruft **nur** diese Zeile, **kein `#logDebugResult`** (der Debug-Block würde das Ergebnis drucken; die Log-Hygiene ist der Punkt des Inkrements), `#reportResult` bekommt den `EVAL`-Zweig mit `return` — `#reportResult` schreibt für eine unbekannte Methode gar nichts, ein fehlender Zweig wäre Unsichtbarkeit. `test/fixtures/fake-extension.mjs`: `EVAL_RESULT`, `evalResponse(id)`, `case "eval"` in `responseFor`, `BC_TEST_EVAL_ANSWER` in `answerModeFromEnv` und im Doku-Kopf.
   Proof: `test/hub.test.js` (Fallnamen im `hub_`-Muster der Datei): `hub_eval_shouldResolveByItsIdAndKeepOnStatusQuiet` (`statusResults.length` bleibt 0), `hub_eval_shouldLogOnlyTabElapsedAndOk` (die Logzeile wörtlich `eval tab=18 elapsedMs=4 ok=true`, `joinedLog` enthält weder den Code-String noch den Ergebnis-String — beide im Fall gewählt, z. B. `data-probe` —, mit `BC_LOG: "debug"` gestartet, sonst ist der Fall blind gegen den Debug-Block), `hub_eval_withOkFalse_shouldRejectWithTheExtensionsCode` ⇒ `ExtensionError.code`. `node --test test/hub.test.js` → `# fail 0`. **Completed 2026-10-27**

7. **MCP-Werkzeug.** `bridge/mcp.mjs`: `const BROWSER_EVAL = "browser_eval"`, `EVAL_ARGUMENTS = ["code", TAB_ARGUMENT]`, `UNEXPECTED_ARGUMENTS[BROWSER_EVAL]`, zehnter Eintrag in `TOOLS` **angehängt** (Position 9, mit der Spec-Beschreibung wörtlich und `inputSchema: {code: string, tab: integer ≥1}`, `required: ["code"]`, `additionalProperties: false`, **keine** Längenprüfung), `evalTool(id, params, {hub, log})` nach dem Muster von `inspectTool` (Typ von `code` ⇒ `-32602`, `hasDeclaredTabArgument`, `hasUndeclaredArgument` ⇒ Werkzeugsatz, `hub.request(PROTOCOL.METHODS.EVAL, withOptionalTab({code}, …))`), `TOOL_TEXTS` um fünf Sätze (je Code einer) und `evalFailureTextFor(code, details)` mit `extensionFailureText`-Zweig: `eval_not_allowed`/`eval_failed`/`eval_timeout`/`eval_result_too_large`/`eval_result_unserializable` plus die geerbten `no_agent_tab`, `not_readable` (`notReadableText(details)`), `page_busy`, `invalid_params`. Testseite: `test/mcp.test.js` — `mcp_toolsList_shouldOfferExactlyTheTenToolsOfTheContract` (Name, `tools.length === 10`, `tools[9]`-Schema), `browser_eval` ohne `code`/mit `code: 3`/mit `timeoutMs` ⇒ je `-32602` bzw. Werkzeugsatz, und eine Tabelle `EVAL_REFUSAL_CASES` mit allen fünf Codes nach dem Muster von `TYPE_REFUSAL_CASES`; `test/http-mcp.test.js`: `TOOL_COUNT` auf 10 und der Namens-Array um `browser_eval` ergänzt.
   Proof: `node --test --test-reporter=tap test/mcp.test.js test/http-mcp.test.js | grep -E '^# (pass|fail)'` → `# fail 0`; `git grep -n 'TOOL_COUNT = 9' -- bridge test extension` → keine Ausgabe, Exit 1 (repo-weit bleibt der Treffer in dieser Spec, die den alten Pin zitiert). **Completed 2026-10-27**

8. **Abnahme und Messung.** Die lokal entscheidbaren Kriterien 1, 4, 6, 7, 10, 11, 12 durch den Umsetzer (`npm test; echo $?`, `npm run check; echo $?`, `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → Exit 1, `git diff --exit-code extension/manifest.json`), Kriterium 5 zur Hälfte (die drei `eval_timeout`-Fälle). Das Code-Review-Gate aus `CONTRIBUTING.md` Schritt 6 bleibt ein Gate und ist **kein** Abnahmekriterium. Die Live-Kriterien 2, 3, 8 und 9 (plus die Zeitaussage aus 5) gehören dem Betreiber (Reload der Erweiterung, pi-Neustart, echter Profil-Tab) — der Umsetzer bereitet sie als Kette im Messbericht vor und hakt sie nicht ab. Letzte Stufe: `status: active`, Prosa beschreibend, `docs/README.md`-Statuszeile — beim Orchestrator.
   Proof: die drei Abnahmebefehle mit Exit 0 und `# fail 0` **und** `# cancelled 0`; der Messbericht mit den Live-Antworten. **Completed 2026-10-27**: `npm test` → 478 Fälle, `# fail 0`, `# cancelled 0`, Exit 0; `npm run check` → 0; Secret-grep → keine Ausgabe, Exit 1; `git diff --exit-code extension/manifest.json` → 0. Die Live-Kriterien 2, 3, 8, 9 und die Zeitaussage aus 5 stehen noch aus — sie brauchen Reload der Erweiterung, den Schalter „Code-Auswertung erlauben" und einen pi-Neustart, also den Betreiber.

### What could go wrong

- **Der Seitentimer ist gedrosselt, die Frist also nicht die Frist.** Ohne den Extension-Wächter (`EVAL_GUARD_MS`) antwortet ein `eval` in einem nicht fokussierten Fenster erst, wenn der Hub nach 10 s aufgibt — Kriterium 5 fällt dann als `ExtensionTimeout` aus, und die Ursache steht in `docs/PROJECT-STATE.md` (Spec 14) seit einem gemessenen Vorfall. Der Fall `eval_whenThePageNeverAnswers…` ist der einzige, der den Wächter beweist; ohne ihn ist die Zeile Behauptung.
- **`new Function` im Content-Script-Sandbox ist nicht der Seitenkontext.** Der Code sieht das DOM (durch Xray-Wrapper) und `document`/`location`, aber **nicht** die Javascript-Globals, die die Seite selbst gesetzt hat (`window.jQuery` bleibt `undefined`). Die Spec formuliert inzwischen entsprechend; kein Kriterium hängt daran (3 und 4 arbeiten auf `document`), aber der Satz gehört nach der Live-Messung als Zeile in `## Bekannte Lücken`. Ebenso ungemessen: ob eine strikte Seiten-CSP (`script-src` ohne `unsafe-eval`) `new Function` im injizierten Schnipsel blockiert. Fällt das auf, ist die Antwort `eval_failed` mit der Meldung der Seite — das ist kein Fehler des Codes, sondern eine Grenze, und ein Ausweg wäre eine eigene Spec, nicht eine stille Zusatzstufe.
- **`pageSnippetCode` schickt den Code als JSON-Literal in den Schnipsel.** 20 000 Zeichen Code werden zu ~20 kB Injektion (plus Escapes) — weit unter 1 MiB, aber der Code steht damit zweimal im Speicher und wird zweimal kompiliert. Wer die Code-Grenze in der Extension *nicht* prüft, merkt das erst an der Nachrichtengrenze.
- **`evalResultOf` darf nicht nachrechnen.** Sobald dort `elapsedMs` oder die Größe neu bestimmt wird, sind es zwei Wahrheiten; die Seite ist die einzige Quelle (`inspectResultOf` macht es vor).
- **Die 10 000-Zeichen-Grenze ist leicht um ein Zeichen falsch gepinnt** — siehe `repeat(9998)`/`repeat(9999)`; die Grenze ist exakt, der Test muss es auch sein.
- **`new Map()` in `background.js` bricht fremde Fälle.** `slotMapKeys` behauptet „genau eine Map" (Befund 4). Kein Cache, kein Buch — `eval` hat strukturell keinen Slot, das ist die billigere und richtigere Bauart.
- **Der Debug-Log-Level ist die Falle für Kriterium 8.** Ein `#logDebugResult(result)` in `#reportEval` wäre mit `BC_LOG=info` unsichtbar und mit `BC_LOG=debug` ein Seiteninhalt im Journal. Der Fall muss `BC_LOG: "debug"` setzen, sonst prüft er die Zeile nicht, die er zu prüfen behauptet.
- **Ein `settings: {}` in einem `eval`-Fall lässt ihn grün werden, ohne etwas zu beweisen** — der Schalter ist per Default aus, jeder Fall, der *ausführen* will, braucht `settings: { allowEval: true }`.

### Ordering and dependencies

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Stufe 1 ist reine Addition und ohne Verhaltensänderung grün; Stufe 2 ist noch ohne `eval`-Pfad prüfbar (Kriterium 12) und muss es sein, weil Stufe 3 `evalAllowed()` schon aufruft. Stufe 3 ist die Stufe, die der Betreiber verlangt hat: **der Schalter antwortet, bevor eine Injektion stattfindet**, und die Zahl der `executeScript`-Aufrufe ist der Beleg — sie ist auch die einzige Stelle, an der die Reihenfolge „Schalter vor Parametern" (Spec) gepinnt werden kann. Stufe 4 hängt an nichts außer 3; Stufe 5 ersetzt nur den Serialisierungsteil von 4 (`evalPageCode`s `extraHelpers` und `outcome`-Zweige) und ist deshalb keine eigene Abhängigkeit für 6/7. Stufe 6 (Hub) und 7 (MCP) sind unabhängig voneinander, aber 7 ohne 6 hätte ein Werkzeug ohne Logzeile — Kriterium 8 wäre nicht entscheidbar, also 6 zuerst. 8 braucht alles. Die Live-Kriterien laufen nach dem Commit durch den Betreiber (`CONTRIBUTING.md`, `## Acceptance`, Ausnahme mit Datum).

### What the next increment inherits

- `eval` ist das zehnte Werkzeug; die Tabelle wächst ab jetzt nur noch **angehängt**, weil `test/mcp.test.js` sie nach Position liest. Wer eins einfügt, macht fünf bestehende Assertions rot.
- Der Extension-Wächter (`guardAfter` + `EVAL_GUARD_MS`) ist jetzt zweimal im Einsatz (`read`/`click`, `eval`) — ein dritter Aufruf, der im Seitenkontext auf etwas wartet, erbt die Regel: **die Extension bringt ihre eigene Frist mit**, der Seitentimer ist nur die erste Meinung.
- Der Seitenspiegel des Harness (`runEvalPageCode` über `runWaitingPageCode`) ist jetzt der Weg für jeden Schnipsel, der ein Promise zurückgibt; `runPageCode` bleibt der synchrone Weg und liefert für Promises weiter `{}`.
- Nicht in diesem Inkrement und nicht nachzuholen: Sandbox oder statische Prüfung des Codes (Non-goal), ein `timeoutMs`-Parameter, Frames (`frameId` bleibt 0), Warten auf Spätfolgen des Codes, eine Whitelist im Log (Roadmap-Zeile 18 — bis dahin bleibt die Regel „Tab-Id,
Laufzeit und Zustand, nie Inhalt"), und jede neue Berechtigung: `extension/manifest.json` bleibt unberührt (Kriterium 10).
- `allowEval` ist die zweite Option, die bei **jedem** Aufruf aus `browser.storage.local` gelesen wird; das Muster (`=== true`, Lesefehler schließt) ist damit etabliert und wird nicht mehr neu entschieden.
## Risiken

- **Der Schalter schaltet mehr frei als Lesen.** Code im Seitenkontext kommt an
  dieselben Daten wie die Seite: `document.cookie` (nicht die `HttpOnly`-Cookies),
  `localStorage`, `sessionStorage`, und über `fetch` an alles, was das Profil mit
  seinen Cookies erreicht. Das ist mit der Entscheidung „Seitenänderungen mit
  Schalter" angenommen und steht so im Hinweistext der Optionsseite.
- **`eval` kann die Passwortfelder-Sperre umgehen** — technisch, nicht durch
  Zufall: `document.querySelector('input[type=password]').value = "…"` ist ein
  Einzeiler. Der Betreiber hat am 2026-10-23 entschieden, dass **der Schalter das
  freigibt** (siehe `## Open questions`): der Code kann es ohnehin nicht
  verhindern, ohne den Aufruf zu verbieten, und eine halbe Sperre wäre eine
  Behauptung. `CONTRIBUTING.md` und der Hinweistext der Optionsseite sagen es.
- **Ergebnisse ziehen Kontext.** Deshalb die 10 000-Zeichen-Grenze und die
  Empfehlung in der Beschreibung, `inspect` für Listen zu nehmen.
- **Zwei Grenzen statt einer.** `EVAL_TIMEOUT_MS` (2 s) und `CALL_TIMEOUT_MS`
  (10 s) müssen zusammenpassen: die Extension muss vor dem Hub antworten, sonst
  sieht der Aufrufer `ExtensionTimeout` statt `eval_timeout`. Gepinnt durch einen
  Test, der `CALL_TIMEOUT_MS > 2500` prüft; `EVAL_GUARD_MS` = 2 500 steckt in der
  IIFE der Extension und ist von außen nicht prüfbar — der Pin deckt die Ordnung,
  nicht die Zahl.
- **Eine strikte Seiten-CSP kann `new Function` blockieren.** Seiten mit
  `script-src` ohne `unsafe-eval` verbieten die Auswertung von Strings; dann
  antwortet `eval` mit `eval_failed` und der Meldung der Seite. Das ist eine
  Grenze des Browsers, kein Fehler des Codes — ein Ausweg wäre eine eigene Spec,
  keine stille Zusatzstufe.
- **Der Code wird als JSON-Literal in den Schnipsel geschrieben.** 20 000 Zeichen
  Code sind ~20 kB Injektion; weit unter der Nachrichtengrenze von 1 MiB, aber der
  Code existiert damit zweimal. Die Grenze in der Extension ist der Riegel, nicht
  die Hoffnung.
- **Ein synchroner Endlos-Loop friert den Tab des Betreibers ein.** `while (true) {}`
  blockiert den Inhaltsprozess; `eval_timeout` befreit ihn **nicht** (der Wächter
  läuft im Hintergrund), und jeder weitere `executeScript` in diesen Tab reiht
  sich dahinter ein. Auflösen kann das nur der Betreiber, indem er den Tab
  schließt. Deshalb steht es im Hinweistext der Optionsseite: der Schalter öffnet
  Code, der den Browser anhalten kann. Ein Kriterium gibt es dafür nicht — die
  Lage ist nur durch Handgriff messbar und gehört nicht in die Abnahme.

## Touch boundary

Angefasst werden:

- `extension/protocol.js`, `bridge/protocol.mjs` (eine Methode, zwei Dateien),
- `extension/background.js` (Schalter, Injektion, Abbildung, Fehlerpfade),
- `extension/options.html`, `extension/options.js` (zweite Checkbox),
- `bridge/hub.mjs` (Logzeile `formatEvalLine`, `#reportEval`, `#reportResult`-Zweig),
- `bridge/mcp.mjs` (Werkzeug, fünf Sätze),
- `CONTRIBUTING.md` (die Passwortfeld-Ausnahme in `## Rules`, 
  „Der Browser gehört dem Betreiber"),
- `test/{protocol,manifest,mcp,hub,extension,http-mcp}.test.js`,
  `test/fixtures/fake-extension.mjs`,
- beim Orchestrator in der letzten Stufe: `docs/README.md` (Statuszeile),
  `docs/PROJECT-STATE.md`, `docs/ROADMAP.md` (Zeile 08f).

**Nicht** angefasst: `extension/manifest.json` (keine neue Berechtigung),
`bridge/{websocket,config,bridge,http-transport}.mjs`, `INSTALL.md` (der Schalter
ist eine Option der Erweiterung, kein DienstThema), andere Specs.

## Bekannte Lücken

Stand 2026-10-27, nach der Umsetzung der Stufen 1–7 und der Live-Abnahme.

### Live-Abnahme (2026-10-27, Betreiber-Profil)

Gemessen über den systemd-Dienst (`curl` gegen `http://127.0.0.1:8111/mcp`), nach
Reload der Erweiterung, eingeschaltetem Schalter „Code-Auswertung erlauben" und
pi-Neustart, auf `https://example.org/` im Agenten-Tab 4:

- **Kriterium 2 grün.** `{code:"return document.title"}` → `result: "Example Domain"`,
  `tabId: 4`, `elapsedMs: 0`.
- **Kriterium 3 grün.** `{code:"document.body.dataset.probe = "1"; return 1"}` →
  `result: 1`; danach `browser_inspect {selector:"body[data-probe=\"1\"]"}` →
  `count: 1`, `elements[0].tag: "body"`. Die Kernannahme hält: der Code erreicht
  den Seitenkontext und darf ihn ändern.
- **Kriterium 4 grün.** Mehrzeilig mit `const`/`return` → `42`; ohne `return` →
  `null`.
- **Kriterium 5 grün, mit einem Befund.** `new Promise(r => setTimeout(() => r(42), 50))`
  → `result: 42`, aber `elapsedMs: 1001` — Firefox drosselt Timer im
  **nicht aktiven** Tab auf etwa 1 s (dieselbe Beobachtung wie bei Spec 14). Die
  Frist ist also nicht die Frist der Seite, sondern die der Extension; genau davor
  schützt `EVAL_GUARD_MS`. Das 3 000-ms-Promise antwortete `eval_timeout` in
  **2 538 ms** Wandzeit — Kriterium 5 („unter 3 s") hält.
- **Kriterium 6 war rot und ist vorwärts korrigiert.** Die Extension lieferte die
  Seitenmeldung, die **Bridge** (`evalFailureTextFor`) ersetzte sie durch den
  statischen Satz; der Agent las „Der Code im Agenten-Tab ist gescheitert
  (Ausnahme oder Syntaxfehler)." ohne Ursache. Behoben in `bridge/mcp.mjs`
  (`EVAL_FAILED_WITH_MESSAGE`, `evalFailedText`), Beleg: zweiter Teil von
  Kriterium 6. Nach der Korrektur live: „Der Code im Agenten-Tab ist gescheitert:
  can't access property \"textContent\", document.querySelector(...) is null".
  **Lehre für die Spec:** Kriterium 6 nannte nur den Extension-Fall; die Bridge
  hat keinen eigenen, und deshalb war lokal alles grün, während der Agent live
  nichts Brauchbares las.
- **Kriterium 7 lokal belegt, live nicht messbar** — `browser_navigate` öffnet nur
  http(s), also kommt keine interne Seite in den Agenten-Tab; die drei Fälle
  stehen im Sandkasten (siehe `## Testing`).
- **Kriterium 8 hält für `eval`, der wörtliche Beleg greift daneben.** Der
  Messbefehl aus dem Kriterium (`grep -c 'data-probe'`) fand **eine** Zeile — sie
  stammt von `inspect`, das seit Spec 09 `inspect selector=… found=…` loggt, nicht
  von `eval`. Mit einer Marke, die nur im `eval`-Code und im `eval`-Ergebnis
  vorkommt (`evalmarker-ergebnis-4711` / `evalmarker-fehler-0815`): **0 Treffer**
  im Journal. Die Logzeilen der Messung lauten `eval tab=4 elapsedMs=0 ok=true`
  und `eval failed peer=127.0.0.1 code=eval_failed` — Code und Ergebnis bleiben
  draußen. Das Kriterium ist entsprechend präzisiert (eigene Marke statt des
  `inspect`-Selektors).
- **Kriterium 9 grün.** Zwei `eval` im selben Tab im selben Tick → `result: 2`
  und `result: 4`, kein `superseded` in beiden Antworten.

### Offene Follow-ups (kein Blocker, mit Datum)

- **`throw undefined` liefert das Wort „undefined"** (2026-10-27, Code-Review 3):
  `messageOf` in `extension/background.js` macht `String(error?.message ?? error)`,
  also wird aus einem geworfenen `undefined`/`null` die Meldung `"undefined"`. Der
  Agent liest dann `… gescheitert: undefined`. Sauber wäre, nur echte Strings und
  `error.message` durchzulassen und sonst auf den allgemeinen Satz zu fallen.
- **`nonEmptyString` trimmt nicht** (2026-10-27): ein `throw "   "` ergibt
  `… gescheitert:    ` mit unsichtbarem Rest. Kosmetisch, ein `.trim()` im Guard.
- **Für den Fehlerpfad fehlt der Log-Hygiene-Test** (2026-10-27): der Erfolgsfall
  ist mit `BC_LOG: "debug"` gepinnt (`hub_eval_shouldLogOnlyTabElapsedAndOk`),
  der Ablehnungsfall nicht. `#logDebugResult` hängt strukturell nur am
  `ok:true`-Pfad — „strukturell unmöglich" ist aber die Aussage, für die man eine
  Zeile Test schreibt.
- **Die Bridge kann Seitenmeldung und Extension-Meldung nicht unterscheiden**
  (2026-10-27): für die zwei internen `eval_failed`-Pfade der Extension liest der
  Agent künftig „… gescheitert: Das Ergebnis der Auswertung war unbrauchbar." —
  ein Vorwurf an den Code, obwohl die Extension selbst gescheitert ist. Ein eigener
  Code wäre ein Spec-Schnitt, nicht eine Zeile.
- **`Date`, `Map`, `Set` und `Error` kommen als `{}` an** (2026-10-27, Code-Review 1):
  `serialize` läuft für alles ohne `nodeType` über `Object.keys`, und bei diesen
  Typen sind die Werte nicht eigene Eigenschaften — das Ergebnis ist `{}` mit
  `ok: true`. Kein Vertragsbruch (die Spec nennt Primitive, `Element`, andere
  Knoten und Zyklen), aber es ist genau die stille Nicht-Antwort, gegen die der
  Vertrag beim Textknoten argumentiert. Wer sie braucht, holt sie mit einem
  zweiten Aufruf (`.toISOString()`, `Array.from(…)`).
- **Der `clearTimeout` der Seitenuhr war bis zum Code-Review unbelegt**
  (2026-10-27): `runWaitingPageCode` lässt die Seitenuhr vorher leerlaufen, also
  konnte die Prüfung „kein Timer übrig" nie rot werden. Nachgezogen mit einem
  Fall, der bei 60 ms anhält und den 2 000-ms-Timer sonst stehen sähe.

## Open questions

Keine offenen mehr. Beantwortet vom Betreiber am 2026-10-23:

1. **Ein Schalter, nicht zwei.** Aus ⇒ jeder Aufruf `eval_not_allowed`, an ⇒
   beliebiger Code. Die Variante „Lesen immer, Ändern nur mit Schalter" wäre nur
   durch eine statische Analyse von JavaScript durchsetzbar, die es nicht
   zuverlässig gibt.
2. **Passwortfelder sind mit dem Schalter freigegeben.** `eval` ist kein
   Hintertürchen, das die Regel umgeht, sondern der Schalter hebt sie auf: mit
   `allowEval` darf der Agent auch `input[type=password]` füllen. `CONTRIBUTING.md`
   wird entsprechend nachgezogen, der Hinweistext der Optionsseite nennt es.
3. **Im Log steht nur der Zustand**: `eval tab=… elapsedMs=… ok=…`, **weder Code
   noch Ergebnis**, solange die Whitelist aus Roadmap-Zeile 18 fehlt.

## Review

**Runde 1 (2026-10-23, `grizzled-senior-dev`): `🔧 Fix these`.** „Der Zuschnitt ist
richtig und der Dev-Plan zitiert den Code ehrlich — ich habe jede genannte Datei,
Funktion und Zeilennummer nachgeschlagen, keine Erfindung dabei. Was nicht stimmt,
sind Vertragssätze, die dem Plan widersprechen (B1), ein Abnahmeteil, der die
Projektregel nicht erfüllt (B10), und eine Touch-Boundary, die eine Datei
verschweigt, die der Plan ändert (B9)." 19 Befunde, alle übernommen — der
Zuschnitt bleibt unverändert.

**Runde 2 (2026-10-23, `grizzled-senior-dev`): `🔧 Fix these`.** „Runde 1 hat den
Zuschnitt richtig gestellt, und diesmal habe ich jede Behauptung im Plan gegen den
Code geschlagen statt gegen die Prosa: `inspectErrorFor` (drei Zeilen, `ReadError`
inklusive), `guardAfter` (`{promise, cancel}`), `pageSnippetCode` mit
`extraHelpers`, `STORED_TAB_SETTINGS`, `createInspectFixture` mit
`#warenkorb-link`, `tools.length === 9`, `TOOL_COUNT`, `slotMapKeys`, die
`#reportResult`-Zweige, Roadmap 08f, `manifest.json` — alles trifft zu, nichts
erfunden. Von den 19 Befunden tragen 17 wirklich; zwei tragen halb (B7: der
Einfrier-Satz stand in `## Risiken`, aber nicht in der Hinweis-Liste der Stufe 2;
B14: der `Passwortfelder`-grep war mit dem alten Checkbox-Label heute schon
erfüllt). Dazu vier Widersprüche aus den Korrekturen selbst: `ok` war in Stufe 6
wieder ein Feld statt Literal, der Verweis in Kriterium 9 zeigte auf Spec 17,
Kriterium 4 statt 5, `eval_shouldLogOnlyTabElapsedAndOk` existierte in keiner
Stufe, und `## Ziel` versprach `Node`, während Stufe 5 nur `Element` baut. Dazu
ein Loch mit Zähnen: die `readErrorFrame`-Zeile (der Kern von B1) hatte keinen
Fall." 8 Befunde, C1–C8; der Zuschnitt bleibt unverändert.

**Runde 3 (2026-10-23, `grizzled-senior-dev`): `✅ Ship it`.** „Diesmal habe ich
die Reparaturen dort gelesen, wo sie wirken, und gegen den Code geschlagen statt
gegen die eigene Zusammenfassung: der Block-Schnitt in Kriterium 12 schließt das
alte Label wirklich aus (die neue Box steht dahinter), Spec 17 hat `## Messlauf`
und Kriterium 5, `ok` ist in Stufe 6 ein Literal, alle drei Hub-Fälle heißen
`hub_eval_…`, `## Ziel` und Stufe 5 bauen beide Knoten-Zweige mit
`selectorForElement(node, valueLimit, classLimit)` und den `INSPECT_`-Grenzen als
Argumenten, und ‚Länge und Zustand' ist an beiden Stellen zu ‚Laufzeit'
geworden. Nummerierung 1–12 zeigt nirgends ins Leere, keine Fallnamen-Leiche
mehr. Fünf Textstellen bleiben, alle ohne Entscheidungswert … **Gate offen** —
die fünf Stellen sind Zeilen, keine Runden; sie gehören vor die Stufe, in der sie
geprüft werden." Übernommen als D1–D5 (siehe `## Log`); der Reviewer hat
dafür ausdrücklich keine vierte Runde verlangt.

**Code-Review 1 (2026-10-27, `grizzled-senior-dev`): `🔧 Fix these`.** „Der
Schalter schützt wirklich — die `evalAllowed`-Zeile steht vor Injektion,
Parametern und Tab, und `eval_whenTheSwitchIsOff_shouldRefuseWithoutInjecting`
belegt es über die Zahl der `executeScript`-Aufrufe statt über eine Antwort. Die
geerbte Fehlerwahrheit ist da (`ReadError ⇒ readErrorFrame`), und die beiden
Fälle `…TheTabIsStillLoading` und `…ThePageIsInternal` machen sie rot, wenn sie
jemand herausnimmt. Die Seitenfunktion hält den Vertrag Punkt für Punkt. Zwei
Fristen, ein Wächter, und der Fall mit dem nie erfüllten `executeScript` ist der
Beweis dafür, dass ohne `EVAL_GUARD_MS` kein `eval_timeout` käme. Im Log steht
`eval tab=… elapsedMs=… ok=true` mit literalem `ok`, kein `#logDebugResult`,
geprüft mit `BC_LOG: "debug"` und zwei Markern. `eval` kommt in keiner
Slot-Zeile vor, das Werkzeug ist angehängt, die fünf Sätze sind je Code einer,
`manifest.json` unberührt. Zu reparieren sind zwei Beweise, nicht das Verhalten:
der in `## Testing` verlangte Fall ‚`eval` ohne `tab` adressiert den zuletzt
benutzten Agenten-Tab' existiert nicht, und die Seitenuhr-Hälfte von
`assertNoTimerLeft` kann nie fehlschlagen, weil `runWaitingPageCode` die Uhr
vorher leerlaufen lässt — der `clearTimeout` in `withinDeadline` ist damit
unbelegt. Dazu zwei Kleinigkeiten (ein Kommentar, der mehr verspricht als die
Assertion; `Date`/`Map`/`Set` landen als `{}`)." Befunde R1–R5, siehe
`## Log`.

**Code-Review 2 (2026-10-27, `grizzled-senior-dev`): `✅ Ship it`.** „Runde 1 hat
drei Löcher in den Belegen genannt, und diesmal habe ich sie nicht geglaubt,
sondern nachgestellt. Die zwei `tab`-Fälle fahren zwei Kandidaten in gekreuzter
Ordnung (Ablage `[501, 500]`, Tab-Array `500, 501`) und werden bei eingebautem
Fehler rot: `lastUsedAgentTab` auf `.at(0)` ⇒ `expected 500, actual 501`,
`resolveAgentTab` ohne die benannte Id ⇒ `expected 501, actual 500`. R2 trägt
die Nachstellung: mit ausgehängtem `clearTimeout` in `withinDeadline` bleibt
`[1940]` in der Seitenuhr stehen und
`eval_withAPromiseThatResolvesAfter50ms_shouldAnswerTheValue` fällt an
`assertNoTimerLeft`. R3 ist auf ‚exactly one injection' reduziert, R4 steht als
Aussage unter `## Bekannte Lücken`. Der Rest ist beim Alten: Schalter vor
Parametern vor Tab vor Injektion, `readErrorFrame` im `evalErrorFor`,
`pageSlots` unberührt, `browser_eval` als zehnter Eintrag angehängt,
`extension/manifest.json` unberührt, `npm test` 478 grün mit `# fail 0` und
`# cancelled 0`. Zwei Nits bleiben (`scriptCalls[0].tabId` würde bei fehlender
Injektion als `TypeError` scheitern; der `withoutATab`-Fall pinnt keine
Injektionszahl) — Zeilen ohne Entscheidungswert, als Follow-up notiert.
**Gate offen.**"

**Code-Review 3 (Nacharbeit Kriterium 6, 2026-10-27, `grizzled-senior-dev`):
`✅ Ship it`.** „Die Vorwärts-Korrektur ist kleiner als ihr Anlass und trifft ihn
genau: die Meldung der Seite hängt jetzt am Satz, und die drei Zusagen, auf die
es ankommt, habe ich am Code geprüft statt am Bericht. Kein Auslecken —
`bridge/hub.mjs` ist unberührt, die einzige Log-Zeile einer Ablehnung ist `:603`
mit `${code}`, `#logDebugResult` hängt nur am `ok:true`-Pfad, und der MCP-Layer
loggt für `ExtensionError` gar nichts. Kein hängendes `: ` — `nonEmptyString`
fängt fehlend, leer und Nicht-String ab. Nur `eval_failed`: die anderen acht
Zweige sind byte-gleich. Die Behauptung ‚gekappt, kein Stack' hält gegen
`extension/background.js:240` und `messageOf`. Beide neuen Tabellenzeilen sind
scharf: das Fixture schreibt in jede `ok:false`-Frame eine Message,
`BC_TEST_ERROR_DETAILS` wird danach gespreizt, also geht `{message:""}` wirklich
gegen den Guard und die Mit-Message-Zeile gegen den alten Code." Sieben Zeilen
bleiben (T1–T8), keine blockiert einen Commit; T3/T4/T5 (drei Kommentare) und die
tautologische `includes`-Assertion (T6) hat der Orchestrator mitgenommen, T1, T2,
T4b und T7 stehen unter `## Bekannte Lücken`.

## Log

Runde 1 des Spec-Reviews — alle 19 Befunde übernommen:

- **B1** (`evalErrorFor` warf die geerbte Fehlerwahrheit weg und widersprach
  `## Ziel` und dem Plan) — übernommen: `ReadError ⇒ readErrorFrame(error)` steht
  jetzt als dritter Fall im Vertrag.
- **B2** (2 000 ms gegen `EVAL_GUARD_MS` 2 500) — übernommen: `## Hub` nennt
  `EVAL_GUARD_MS`, der Pin prüft `CALL_TIMEOUT_MS > 2500` und sagt, dass die 2 500
  selbst nicht von außen prüfbar sind.
- **B3** (`ok=true` hatte keine Quelle, „Länge" stand im Log-Absatz ohne Feld) —
  übernommen: `ok` ist ein Literal, der Absatz nennt Tab-Id, Laufzeit und Zustand.
- **B4** (Kriterium 7 war mit den Werkzeugen des Projekts nicht live entscheidbar) —
  übernommen: Kriterium 7 ist lokal, die `not_readable`-Zeile steht in
  `## Testing`, und der Grund (kein `about:`-
  `navigate`) steht dabei.
- **B5** (`settings: {allowEval: true}` hätte jeden Fall ins `no_agent_tab` laufen
  lassen) — übernommen: `settings: { ...STORED_TAB_SETTINGS, allowEval: true }`,
  und die Falle steht im Plan.
- **B6** (die rhetorische Frage in `## Extension`) — übernommen: die Reihenfolge
  steht als Vertrag (Schalter, Parameter, Tab, Injektion), die Frage ist weg.
- **B7** (synchroner Endlos-Loop friert den Tab ein) — übernommen: eigener
  Risiko-Punkt, ohne Kriterium, mit dem Satz für den Hinweistext.
- **B8** (a: Lesefehler-Schließer fehlte im Vertrag; b: `CONTRIBUTING.md`-Ausnahme klang
  nach `browser_type`) — beides übernommen: „ein Lesefehler zählt als aus" steht
  in `## Konfiguration`, und `allowEval` hebt die Sperre **nur für `eval`** auf.
- **B9** (`bridge/hub.mjs` fehlte in der Boundary und stand unter „nicht
  angefasst") — übernommen: `hub.mjs` ist angefasst, `websocket/config/bridge/
  http-transport` bleiben unberührt.
- **B10** (datierte Ausnahme und Betreiber-Abhaken fehlten) — übernommen: der
  Absatz steht wörtlich im Abnahmeteil, mit den Live-Kriterien 2, 3, 8, 9 und der
  Kernannahme (2 und 3).
- **B11** (Präambel behauptete für alle Kriterien einen Befehl; 6 war zu Unrecht
  live) — übernommen: jede Nummer trägt `(lokal)` oder `(live)`, 6 ist lokal, 5
  ist geteilt (Fälle lokal, Zeitaussage live).
- **B12** (`eval_result_too_large`/`-unserializable` ohne Kriterium) —
  übernommen: Kriterium 11 nennt die Grenzfälle namentlich.
- **B13** (`test/manifest.test.js` pinnt `background.js` nicht) — übernommen: die
  Behauptung nennt zwei Dateien, der `background.js`-Pin ist ein eigener Fall.
- **B14** (`grep -c 'Code-Auswertung' ≥ 2` war mit dem geplanten Hinweistext nicht
  erfüllbar) — übernommen: `≥ 1` für „Code-Auswertung" **und** `≥ 1` für
  „Passwortfelder".
- **B15** (`{a: undefined}` war nicht gepinnt, obwohl der Replacer Aufwand macht)
  — übernommen: eigener Fall in `## Testing` und in Stufe 5.
- **B16** (Log-Fall ohne `BC_LOG: "debug"` beweist nichts) — übernommen, in
  `## Testing` und im Plan.
- **B17** (Baseline fehlte, drei Pins müssen sich ändern) — übernommen: die drei
  Stellen stehen namentlich in Kriterium 11 und unter `## Testing`.
- **B18** (`elapsedMs` ohne Messfenster; Kriterium 12 doppelte das Review-Gate) —
  übernommen: das Fenster steht in `## Ziel`, das Gate-Kriterium ist gestrichen,
  die Nummerierung endet bei 12.
- **B19** (Doku-Dateien fehlten in der Boundary, Roadmap-Zeile 08f war veraltet) —
  übernommen: `docs/README.md`, `docs/PROJECT-STATE.md`, `docs/ROADMAP.md` stehen
  in der Boundary, Zeile 08f ist nachgezogen.

Runde 2 des Spec-Reviews — alle 8 Befunde übernommen:

- **C1** (die `readErrorFrame`-Zeile aus B1 hatte keinen Fall, Kriterium 7 keinen
  Beleg) — übernommen: Stufe 3 baut
  `eval_whenThePageIsLoading_shouldAnswerPageBusy` und
  `eval_whenThePageIsInternal_shouldAnswerNotReadableWithKindAndUrl`, die
  `## Testing`-Zeile nennt sie, Kriterium 7 zeigt darauf.
- **C2** (Kriterium 12 war mit dem alten Label „Passwortfelder erlauben" schon
  heute grün) — übernommen: der Beleg schneidet auf den `allowEval`-Block
  (`grep -A8 'id="allowEval"'`), und Stufe 2 verlangt die Assertion auf den
  Block, nicht auf `html`.
- **C3** (Verweis auf Spec 17, Kriterium 4 statt 5; der Ausnahme-Absatz ließ die
  Zeitaussage aus 5 weg) — übernommen: Verweis auf Spec 17, **Kriterium 5**
  (`## Messlauf`), Live-Liste im Ausnahme-Absatz vollständig.
- **C4** (Stufe 6 machte `ok` wieder zum Feld) — übernommen:
  `… ok=true` als Literal, `NO_FIELD` nur für die beiden Zahlen.
- **C5** (Kriterium 8 zitierte einen Fall, den keine Stufe baut; Hub-Namen passten
  nicht ins `hub_`-Muster) — übernommen: Stufe 6 führt
  `hub_eval_shouldLogOnlyTabElapsedAndOk` (mit `BC_LOG: "debug"`) als eigenen
  Fall, Kriterium 8 zitiert ihn, alle drei Hub-Fälle heißen `hub_eval_…`.
- **C6** (der Einfrier-Satz aus B7 war bekannt, aber nicht verdrahtet) —
  übernommen: Stufe 2 schreibt ihn in den Hinweistext („kann den Tab einfrieren"),
  Kriterium 12 prüft `einfrieren` im Block.
- **C7** (`## Ziel` versprach `Node`, Stufe 5 baut `Element`) — übernommen: der
  Vertrag nennt `Element` mit `selector` und andere Knoten als
  `{kind:"node", nodeType}` ohne weitere Felder; Stufe 5 baut den zweiten Zweig.
- **C8** („Länge und Zustand" lebte im Vererbungs-Absatz weiter) — übernommen:
  „Tab-Id, Laufzeit und Zustand, nie Inhalt".

Runde 3 des Spec-Reviews — Gate mit `✅ Ship it` geöffnet; die fünf Textstellen
ohne Entscheidungswert als D1–D5 übernommen:

- **D1** (`page_busy`/`not_readable` entstehen nicht im Seitenspiegel, sondern in
  `injectPageCode`s `catch` aus einem abgelehnten `executeScript` plus Tab-Zustand;
  das Wort „Seitenspiegel" war hier erfunden, und der Fallname sprach von der
  Seite statt vom Tab) — übernommen: der Weg steht ausgeschrieben, der Fall heißt
  `eval_whenTheTabIsStillLoading_shouldAnswerPageBusy`, und Kriterium 7 nennt alle
  drei Namen.
- **D2** („genau drei bestehende Pins" waren vier — das Namensarray in
  `test/mcp.test.js` fehlte) — übernommen: vier Pins, beide Arrays namentlich,
  `tools[8].name` bleibt gültig.
- **D3** (Stufe 2 grepte `einfriert` gegen ihr eigenes „einfrieren" und nie das
  Pflichtwort „Passwortfelder") — übernommen: `einfrieren`, beide Pflichtwörter
  wörtlich im Hinweistext.
- **D4** (`grep -A8` zu kurz für den längeren Hinweisabsatz) — übernommen:
  `-A12`.
- **D5** (der neue `nodeType`-Zweig aus C7 hatte keinen Fall) — übernommen:
  `eval_withATextNodeResult_shouldAnswerKindNodeAndNodeType`; dazu zwei Nits:
  `selectorForElement` gilt für Elemente (nicht „für Knoten"), und Stufe 4 ruft
  `evalPageCode(cfg)` statt `evalPageCode(pageRequest)`.

Code-Review Runde 1 — alle fünf Befunde behandelt:

- **R1** (`## Testing` verlangte „`eval` ohne `tab` adressiert den zuletzt
  benutzten Agenten-Tab", und kein `eval`-Fall übergab je ein `tab`) —
  übernommen: zwei Fälle, `eval_withTab_shouldEvaluateInThatTab` und
  `eval_withoutATab_shouldAddressTheLastUsedAgentTab`, mit zwei Kandidaten in
  gekreuzter Ordnung.
- **R2** (die Seitenuhr-Hälfte von `assertNoTimerLeft` konnte nie fehlschlagen,
  also war der `clearTimeout` in `withinDeadline` unbelegt) — übernommen:
  `advanceMs` wird durchgereicht, der 50-ms-Promise-Fall fährt mit
  `advanceMs: 60`; mit ausgehängtem `clearTimeout` bleibt `[1940]` stehen, und
  der Fall ist rot.
- **R3** (Kommentar versprach eine Warnungsprüfung, die die Assertion nicht
  machte) — übernommen: der Kommentar sagt jetzt „exactly one injection".
- **R4** (`Date`/`Map`/`Set`/`Error` kommen als `{}` an) — übernommen, aber
  **nicht im Code**: es ist kein Vertragsbruch, sondern eine Grenze der
  Abbildung. Sie steht mit Ursache und Ausweg unter `## Bekannte Lücken`.
- **R5** (der Arbeitsbaum bewegte sich während des Reviews) — übernommen als
  Prozessregel: die Abnahme läuft auf dem eingefrorenen Baum, kein Schreiber
  während eines Reviews.

Code-Review Runde 2 — `✅ Ship it`, keine Befunde; zwei Nits als Follow-up
notiert und **nicht** umgesetzt (kein Entscheidungswert):

- **S1** (`tabs.scriptCalls[0].tabId` scheitert bei fehlender Injektion als
  `TypeError` statt als lesbarer Satz) — nicht umgesetzt; gehört zum nächsten
  Mal, wenn die Datei ohnehin angefasst wird.
- **S2** (der `withoutATab`-Fall pinnt keine Injektionszahl) — nicht umgesetzt,
  aus demselben Grund; der `tab`-Fall daneben pinnt sie.

Code-Review Runde 3 (Nacharbeit aus der Live-Abnahme) — Gate mit `✅ Ship it`:

- **K6** (Kriterium 6 live rot: die Bridge ersetzte die Seitenmeldung durch den
  statischen Satz) — übernommen: `EVAL_FAILED_WITH_MESSAGE` und `evalFailedText`
  in `bridge/mcp.mjs`, zwei Tabellenzeilen in `test/mcp.test.js` (mit und ohne
  Meldung), Kriterium 6 nennt jetzt beide Hälften des Belegs.
- **K8** (der wörtliche `data-probe`-Beleg traf die Logzeile von `inspect`) —
  übernommen: Kriterium 8 verlangt eine `eval`-eigene Marke; die Messung mit
  `evalmarker-ergebnis-4711` ergab 0 Treffer im Journal.
- **T3/T4/T5** (Block-Kommentar zählte „five sentences", „in one line" hielt keine
  Newline aus, die 500 stand als Zahl statt als `EVAL_MESSAGE_LIMIT`) —
  übernommen, drei Kommentarzeilen.
- **T6** (die `includes`-Assertion war tautologisch neben dem `deepEqual`) —
  übernommen, entfernt; der `deepEqual` pinnt die Meldung im Satz ohnehin.
- **T8** (Kriterium 6 nannte nur den Extension-Fall) — übernommen, siehe K6.
- **T1** (`throw undefined` wird zum Wort „undefined") — **nicht** in diesem
  Inkrement: der Fix sitzt in `messageOf` der Extension; Follow-up.
- **T2** (`nonEmptyString` trimmt nicht) — nicht umgesetzt, kosmetisch.
- **T4b** (kein Log-Hygiene-Test für den Fehlerpfad) — nicht umgesetzt;
  `#logDebugResult` hängt strukturell nur am Erfolgspfad.
- **T7** (die Bridge kann Seitenmeldung und Extension-Meldung nicht
  unterscheiden) — nicht umgesetzt, wäre ein eigener Spec-Schnitt.

- **2026-11-15 — sichtbare Labels sind englisch.** Der Betreiber hat die
  Optionsseite übersetzen lassen (das Projekt ist öffentlich, die Doku ist
  englisch). Die Zitate oben beschreiben den Stand ihrer Zeit; im Code heißt
  der Schalter jetzt **“Allow code evaluation”**. Einzelnachweis: `extension/options.html`,
  `test/manifest.test.js`.
