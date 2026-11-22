---
description: browser_read bekommt offset und maxChars, damit ein langer Text in Abschnitten lesbar wird; die Antwort nennt die angewandte Stelle, die Länge des Ausschnitts und die Gesamtlänge.
status: active
---

# Blättern statt Wand: `offset` und `maxChars` für `browser_read`

Heute endet `browser_read` bei **20 000 Zeichen** — hart, ohne Hinweis, wie es
weitergeht. `truncated: true` sagt „es war mehr da", aber es gibt keinen Weg
dorthin. Der Betreiber hat das am 2026-10-23 als Wand notiert; seit Spec 20/21
liegt die Socket-Grenze bei 5 MiB, ein größerer Ausschnitt wäre also möglich,
ohne das Protokoll anzufassen.

Dieses Inkrement macht aus der Wand eine Seite: `offset` sagt, wo gelesen wird,
`maxChars` wie viel, und die Antwort nennt beide Zahlen plus die Gesamtlänge —
damit kann der Agent weiterblättern, statt den Text zu verlieren.

## Ziel

`browser_read({tab?, offset?, maxChars?})` liefert den Text des Agenten-Tabs ab
Zeichen `offset`, höchstens `maxChars` Zeichen:

```json
{"tabId":4,"url":"https://de.wikipedia.org/wiki/Firefox","title":"Firefox – Wikipedia",
 "text":"…","offset":20000,"chars":20000,"totalChars":87314,"truncated":true,
 "via":"innerText","settled":true,"waitedMs":241}
```

- **`offset`** ist die Zahl der **übersprungenen Zeichen** des normalisierten
  Textes (0-basiert), Default `0`. Ganze Zahl, `≥ 0`.
- **`maxChars`** ist die Höchstzahl **gelieferter** Zeichen, Default `20000`
  (unverändert der bisherige Deckel), Grenzen `1 … 100000`. Ganze Zahl.
- **`chars`** ist die Länge von `text` in dieser Antwort; **`totalChars`** ist die
  Länge des **ganzen** normalisierten Textes. Beide kommen aus der Seite, nicht
  aus einer Schätzung der Extension.
- **`truncated: true`** heißt: es gibt nach diesem Ausschnitt noch Text, also
  `offset + chars < totalChars`. Der bisherige Name und seine Bedeutung bleiben;
  neu ist, dass der Agent mit `offset + chars` genau weiß, wo er weiterliest.
- **`offset` hinter dem Textende ist ein Fehler** (Betreiberentscheidung
  2026-10-27): liegt `offset > totalChars`, antwortet die Extension mit dem neuen
  Code `offset_out_of_range` und nennt `totalChars` in der Meldung — der Agent
  erfährt also die echte Länge und kann sich korrigieren. Genau **auf** dem Ende
  (`offset === totalChars`) ist dagegen gültig: `text: ""`, `chars: 0`,
  `truncated: false`; das ist der natürliche Haltepunkt beim Blättern.
- **Die Entscheidung fällt in der Seite**, nicht in der Extension: `totalChars`
  entsteht erst dort, also prüft der Schnipsel `offset > text.length` und meldet
  diesen Fall als eigenes `outcome`; die Extension übersetzt ihn in
  `offset_out_of_range` und hängt die Zahl an.
- **Geschnitten wird in der Seite.** Der Schnipsel bekommt `offset` und
  `maxChars` als Argumente und zählt `totalChars` dort, wo der ganze Text ohnehin
  existiert. Nur den Ausschnitt über den Draht zu schicken ist der Punkt; die
  Extension schickt nie 87 000 Zeichen, um 20 000 zu liefern.
- **Normalisierung bleibt, wie sie ist**: `innerText` (bzw. `textContent` als
  Rückfall), Zeilenumbrüche vereinheitlicht, Leerraum zusammengezogen. `offset`
  zählt **nach** dieser Normalisierung — sonst wäre eine Fortsetzung nicht
  anschlussfähig.
- **`via`, `settled`, `waitedMs`, `url`, `title`** bleiben unverändert; `read`
  wartet weiter auf DOM-Ruhe (Spec 14).
- **Ohne Parameter verhält sich `read` wie bisher** (offset 0, 20 000 Zeichen).
  Alle bestehenden Aufrufer bleiben gültig.

## Non-goals

- **Kein Blättern nach Zeilen, Absätzen oder Überschriften.** Das wäre Artikel-
  Extraktion (Roadmap 14), ein eigener Zuschnitt.
- **Kein `offset`/`maxChars` für `click` und `type`.** Sie liefern den
  Seitenzustand als Beigabe; wer Abschnitte will, nimmt `read`.
- **Kein Streaming und keine Chunk-Übertragung.** Eine Antwort, ein Ausschnitt.
- **Keine Änderung an der Zeit- oder Längen-Grenze für `url`/`title`.**
- **Keine Reparatur abgeschnittener Surrogatpaare.** Liegt die Grenze mitten in
  einem Emoji, enthält der Ausschnitt ein halbes Paar; die Fortsetzung beginnt
  beim nächsten Zeichen. Ein „reparierendes" Verschieben der Grenze würde die
  Anschlussfähigkeit (`offset + chars`) brechen — das ist der schlechtere Tausch.
- **Keine neue Berechtigung**, keine neue Methode im Protokoll.

## Wire-Protokoll (Parameter erweitert)

`read` bekommt zwei **optionale** Parameter; beide Kopien des Protokolls bleiben
unverändert, es gibt keine neue Konstante:

```json
{"type":"request","id":7,"method":"read","params":{"tab":4,"offset":20000,"maxChars":20000}}
```

Antwort wie bisher, mit drei zusätzlichen Feldern (`offset`, `chars`,
`totalChars`). Zwei Fehlerfälle:

| Code | Wann |
|---|---|
| `invalid_params` | falscher Typ, negatives `offset`, `maxChars` außerhalb `1 … 100000`, nicht-ganzzahlige Werte — **vor** jeder Injektion |
| `offset_out_of_range` | `offset > totalChars` — **nach** dem Lesen, mit `totalChars` in der Meldung („The text has 87314 characters; offset 999999 is past its end.") |

## MCP-Werkzeug

`browser_read` bekommt zwei optionale Eigenschaften im `inputSchema`:
`offset` (`integer`, `minimum: 0`) und `maxChars` (`integer`, `minimum: 1`,
`maximum: 100000`) — die Grenzen stehen im Schema, weil sie Vertrag sind, und die
Extension prüft sie noch einmal (zweite Meinung an der Stelle, die den Fehler
erzeugt). Die Beschreibung nennt beide Parameter und den Rückweg:
„`offset`/`maxChars` blättern durch den Text; `chars` und `totalChars` sagen, wo
man steht." Ein eigener Satz für `offset_out_of_range` nennt die Gesamtlänge —
er fällt nicht auf den allgemeinen zurück.

## Hub

Unverändert. Die Logzeile für `read` bleibt, wie sie ist: **kein Textinhalt**,
aber `chars=` steht dort schon heute (`result.text.length`) — das ist ab jetzt die
Ausschnittslänge, die Zeile selbst bewegt sich nicht. `CALL_TIMEOUT_MS` bleibt 20 s; ein
100 000-Zeichen-Ausschnitt ist kein neuer Zeitfall.

## Extension

- `readPageSource` bekommt statt `(textLimit, urlLimit, titleLimit)` vier
  Argumente: `(offset, maxChars, urlLimit, titleLimit)` und liefert zusätzlich
  `totalChars` und den **angewandten** `offset`.
- **Der Schnipsel wird pro Aufruf gebaut**, nicht mehr als Konstante
  `READ_PAGE_CODE`: die Werte stehen als Argumente im Aufruf
  (`(${readPageSource})(${offset}, ${maxChars}, ${URL_LIMIT}, ${TITLE_LIMIT})`),
  so wie `inspectPageCode` es mit seinem Request-Objekt macht. Die Konstante
  entfällt; ein Test pinnt, dass zwei Aufrufe mit verschiedenen Werten zwei
  verschiedene Schnipsel ergeben (sonst wäre der zweite Aufruf der erste).
- `readRequestParams(params)` prüft `offset`/`maxChars` (Typ, Ganzzahligkeit,
  Bereich) **vor** der Tab-Auflösung und der Injektion; Defaults und Grenzen als
  benannte Konstanten (`READ_MAX_CHARS_LIMIT = 100000`).
- Der Schnipsel liefert bei `offset > text.length` ein eigenes `outcome`
  (`offset_out_of_range` mit `totalChars`); `pageResultOf` übersetzt es in
  `ReadError("offset_out_of_range", …)` mit der Zahl in der Meldung. Sonst reicht
  es `offset`, `chars`, `totalChars` durch — nichts wird nachgerechnet (die Seite
  ist die Quelle).

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | Aufruf ohne `offset`/`maxChars` liefert denselben Text wie heute, `offset: 0`, `chars` = Textlänge, `totalChars` = Textlänge | Rückwärtskompatibilität |
| `test/extension.test.js` | `offset: 5, maxChars: 10` liefert genau `text.slice(5, 15)` und `truncated: true` | Fenster und Anschluss |
| `test/extension.test.js` | zwei Aufrufe (`offset: 0` und `offset: chars`) ergeben aneinandergehängt den Volltext | Blättern ohne Lücke und ohne Doppelung |
| `test/extension.test.js` | `offset: totalChars` ⇒ `text: ""`, `chars: 0`, `truncated: false` | das Ende ist kein Fehler |
| `test/extension.test.js` | `offset: 999999` (Text kürzer) ⇒ `offset_out_of_range`, Meldung enthält `totalChars`, kein Text | Ablehnung statt stiller Kappung |
| `test/extension.test.js` | `maxChars: 1` ⇒ ein Zeichen, `chars: 1` | die Untergrenze |
| `test/extension.test.js` | `maxChars: 100001`, `maxChars: 0`, `offset: -1`, `offset: 1.5` ⇒ `invalid_params`, **keine** Injektion (`tabs.scriptCalls` bleibt leer) | Grenzen und Reihenfolge |
| `test/extension.test.js` | `maxChars: 100000` auf einem Text mit 150 000 Zeichen ⇒ `chars: 100000`, `truncated: true` | der neue Deckel trägt |
| `test/extension.test.js` | `totalChars` stimmt in beiden Pfaden (`innerText` und `textContent`) | die Zahl kommt aus derselben Quelle wie dem Text |
| `test/extension.test.js` | Seitenantwort mit absichtlich falschem `totalChars` (7 statt 3) ⇒ die Antwort trägt `7` | die Extension rechnet nicht nach (Kriterium 7) |
| `test/extension.test.js` | `offset: "5"` ⇒ `invalid_params` **aus der Extension** (kein Brücken-Typfehler), `tabs.scriptCalls` leer | die Typ-Prüfung existiert auch hinter der Bridge (Kriterium 5) |
| `test/extension.test.js` | zwei `read`-Aufrufe mit verschiedenen `offset` bauen zwei verschiedene Schnipsel (`executeScript`-Argumente unterscheiden sich) | der Schnipsel ist nicht mehr konstant |
| `test/mcp.test.js` | `browser_read` mit `offset`/`maxChars` reicht beide durch; ohne sie sind sie abwesend (nicht `null`) | das Werkzeug erfindet keine Defaults doppelt |
| `test/mcp.test.js` | `offset: "5"` und `offset: 1.5` ⇒ `-32602`, **keine** Anfrage an die Extension | Typprüfung im Werkzeug |
| `test/mcp.test.js` | `offset: -1`, `maxChars: 0`, `maxChars: 100001` gehen **durch** die Bridge (sie prüft nur Typen, wie bei `inspect`s `limit`) — die Extension lehnt sie ab | die Bereichsprüfung sitzt an einer Stelle, und das ist bewusst die Extension |
| `test/mcp.test.js` | Fixture antwortet `error:offset_out_of_range` mit `{"totalChars":87314,…}` ⇒ der Werkzeugtext nennt `87314` und fällt **nicht** auf `CALL_EXTENSION_FAILED` zurück | der eigene Satz aus `## MCP-Werkzeug` |
| `test/mcp.test.js` | die Beschreibung nennt `offset`/`maxChars`/`chars`/`totalChars` | der Agent findet den Rückweg ohne Spec |

Fünf Objektvergleiche der bestehenden `read`-Fälle ziehen die drei Felder nach
(Reihenfolge `text, offset, chars, totalChars, truncated, via`); die übrigen
`read`-Fälle prüfen Einzelfelder und bleiben grün. Ein neuer Feldordnungs-Pin für
`read` hält die Reihenfolge fest (heute gibt es keinen).

## Acceptance criteria

**Ausnahme mit Datum** (2026-10-27, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 9 ist
live und nach dem Commit zu messen (Reload der Erweiterung, ein langer Artikel im
Agenten-Tab); fällt es rot aus, wird vorwärts korrigiert und die rote Zeile steht
unter `## Bekannte Lücken`.

1. **Ohne Parameter wie bisher** (lokal). Ein Aufruf ohne `offset`/`maxChars`
   liefert denselben `text` wie der Stand vor diesem Inkrement, dazu
   `offset: 0`, `chars === text.length`, `totalChars >= chars`.
2. **Das Fenster stimmt** (lokal). `offset: 5, maxChars: 10` liefert genau
   `text.slice(5, 15)` des Volltextes, `chars: 10`, `truncated: true` (bei längerem
   Text).
3. **Blättern ist lückenlos** (lokal). Zwei Aufrufe mit `offset: 0` und
   `offset: <chars des ersten>` ergeben aneinandergehängt den Volltext —
   `totalChars` stimmt mit der Länge der Summe überein.
4. **Das Ende ist ein Haltepunkt, dahinter ein Fehler** (lokal).
   `offset === totalChars` ⇒ leerer `text`, `chars: 0`, `truncated: false`;
   `offset > totalChars` ⇒ `offset_out_of_range` mit `totalChars` in der Meldung.
5. **Die Grenzen gelten, und zwar an der richtigen Stelle** (lokal).
   `maxChars: 1` und `100000` laufen. `maxChars: 0`, `100001`, `offset: -1`,
   `1.5`, `"5"` ⇒ `invalid_params` **aus der Extension**, ohne Injektion
   (`tabs.scriptCalls === []`). In der Bridge sind nur die **Typen** geprüft:
   `offset: "5"` und `offset: 1.5` ⇒ `-32602` ohne Anfrage an die Extension;
   `offset: -1` und `maxChars: 100001` gehen durch die Bridge hindurch.
6. **Der Schnipsel ist nicht mehr konstant** (lokal). Zwei Aufrufe mit
   verschiedenen `offset` rufen `executeScript` mit verschiedenen Codes auf.
7. **Nichts wird nachgerechnet** (lokal). `offset`, `chars`, `totalChars` sind die
   Felder der Seite; ein Test mit absichtlich falschem `totalChars` in der
   Seitenantwort zeigt, dass die Extension es durchreicht statt zu korrigieren.
8. **Die Abnahme ist grün** (lokal). `npm test; echo $?` → `0` mit `# fail 0`
   **und** `# cancelled 0`; `npm run check; echo $?` → `0`;
   `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → keine Ausgabe, Exit 1;
   `git diff --exit-code extension/manifest.json` → 0.
9. **Ein echter Artikel lässt sich lückenlos blättern** (live). In einem langen
   Artikel (etwa `https://de.wikipedia.org/wiki/Firefox`) liefert `browser_read`
   mit `maxChars: 20000` ein `totalChars` über 20 000. Die Aufrufe werden mit
   `offset += chars` wiederholt, **bis `truncated: false`**; dann gilt: die Summe
   der `chars` ist genau `totalChars`, und aneinandergehängt ergeben die
   Ausschnitte den Text ohne Lücke und ohne Doppelung. Danach **ein** weiterer
   Aufruf mit `offset = totalChars` ⇒ `text: ""`, `chars: 0`,
   `truncated: false` (der Haltepunkt am Ende, lokal schon durch Kriterium 4
   gepinnt). Die Zahlen (Anzahl der Aufrufe, `totalChars`, Summe der `chars`,
   Verhalten am Haltepunkt) stehen unter `## Messlauf`.

## Dev plan

Reihenfolge: Prüfung → Fenster → Fehlerfall aus der Seite → MCP → Abschluss.
Nummern in Klammern sind die Kriterien aus `## Acceptance criteria`, die die
Stufe entscheidet.

1. **Parameter prüfen, bevor irgendetwas injiziert wird** (5, Extension-Hälfte) —
   `extension/background.js`, Block der Text-Konstanten um `TEXT_LIMIT` (~132):
   `READ_MAX_CHARS_MIN = 1`, `READ_MAX_CHARS_LIMIT = 100000`,
   `READ_MAX_CHARS_DEFAULT = TEXT_LIMIT`, `READ_OFFSET_DEFAULT = 0`; zwei
   Meldungen im Stil von `INSPECT_LIMIT_MESSAGE` (~195). Neue Funktion
   `readRequestParams(params)` direkt über `readAgentTabPage` (~1753), die
   `offset`/`maxChars` prüft (`Number.isInteger`, `≥ 0` bzw.
   `1 … READ_MAX_CHARS_LIMIT`, `undefined` ⇒ Default) und `{offset, maxChars}`
   zurückgibt; `readAgentTabPage` ruft sie als **erste** Zeile, vor
   `addressedAgentTab`. Geworfen wird `new ReadError(INVALID_PARAMS_CODE, …)` —
   `readErrorFor`/`readErrorFrame` bleiben unangetastet. In
   `test/extension.test.js` neue Fälle mit dem vorhandenen
   `sendRead(socket, 2, params)` (1807) gegen `createReadTabs()`: `maxChars: 0`,
   `maxChars: 100001`, `offset: -1`, `offset: 1.5`, `offset: "5"`,
   `maxChars: "10000"` ⇒ `error.code === "invalid_params"` und
   `assert.deepStrictEqual(tabs.scriptCalls, [])`. Kein Fall, der ein *gültiges*
   Fenster behauptet — das kommt in Stufe 2.
   Proof: `node --test --test-timeout=60000 test/extension.test.js` grün; die
   neuen Fälle scheitern vor der Stufe an `ok:true` und danach nicht mehr;
   `npm test` unverändert grün (`# fail 0`, `# cancelled 0`).

   **Completed 2026-10-27**

2. **Das Fenster, in der Seite geschnitten** (1, 2, 3, 6, 7; 5-Obergrenze; halbe
   4) — `extension/background.js`: `readPageSource` (~1909) bekommt
   `(offset, maxChars, urlLimit, titleLimit)`; im Rumpf nach der Normalisierung
   `const totalChars = text.length`, `const from = offset`, `const slice =
   text.slice(from, from + maxChars)` und die Antwort `{url, title, text: slice,
   offset: from, chars: slice.length, totalChars, truncated: from + slice.length <
   totalChars, via}`. `truncated` wird damit *nicht* mehr aus
   `totalChars > maxChars` gebildet — sonst meldet ein Fenster in der Mitte
   fälschlich „mehr da", obwohl es das Textende erreicht. `const READ_PAGE_CODE =
   …` (~1962) entfällt; daneben `function readPageCode(offset, maxChars)` =
   `` `(${readPageSource.toString()})(${offset}, ${maxChars}, ${URL_LIMIT},
   ${TITLE_LIMIT})` `` (bewusst ohne `pageSnippetCode`: dessen
   `PAGE_HELPERS_CODE` aus `describeElement`/`isVisible` würde bei jedem `read`
   ~1 kB toten Code mitschicken, und `readPageSource` deklariert seine Helfer
   selbst). Die drei anderen Aufrufer des alten `READ_PAGE_CODE` — `clickResult`
   (~2403) und `typeResult` (~2596) — bekommen `const PAGE_STATE_CODE =
   readPageCode(0, TEXT_LIMIT)`; ihre Antwortobjekte bleiben unverändert, weil
   beide ihre Felder einzeln aus `page` ziehen. `pageResultOf` (~2058) gibt
   `{tabId, url, title, text, offset, chars, totalChars, truncated, via}` in
   dieser Reihenfolge zurück (`settled`/`waitedMs` hängt `readAgentTabPage` mit
   `{...page, ...settle}` dahinter); `isUsablePageResult` (~2075) verlangt
   zusätzlich drei ganze Zahlen für `offset`/`chars`/`totalChars`, sonst
   `read_failed` mit der bestehenden Warnzeile. `readAgentTabPage` reicht das Paar
   aus `readRequestParams` an `readPageCode` weiter.
   In `test/extension.test.js`: neue Fälle ohne neue Fixture — `DEFAULT_READ_PAGE`
   (53) plus `createReadTabs({ page })` und `sendRead(socket, id, params)` tragen
   alle: Default-Rückwärtskompatibilität (`offset: 0`, `chars === text.length`,
   `totalChars === text.length`), `offset: 5, maxChars: 10` gegen
   `text.slice(5, 15)`, zwei Aufrufe `offset: 0` und `offset: <chars>`
   aneinandergehängt = Volltext, `offset === totalChars` ⇒ `""`/`0`/`false` (in
   dieser Stufe schon gültig, weil `slice(n, n)` leer ist), `maxChars: 1`,
   `maxChars: 100000` auf `"a".repeat(150000)` (erzeugt, kein Literal im Repo),
   `totalChars` im `textContent`-Pfad über die vorhandene `parts`-Fixture.
   Kriterium 6 in **einem** Fall: eine Socket, zwei `read` mit `offset: 0` und
   `offset: 5`, dann
   `const codes = tabs.scriptCalls.filter((c) => !isSettleCode(c.details.code)).map((c) => c.details.code)`
   — `assert.notEqual(codes[0], codes[1])` und ein Präfix-Vergleich, der „derselbe
   Rumpf, andere Zahlen" pinnt. Kriterium 7 in einem Fall mit `executeScript`, das
   `{url, title, text: "abc", offset: 0, chars: 3, totalChars: 7, truncated:
   false, via: "innerText"}` liefert ⇒ `totalChars === 7` in der Antwort.
   Fünf bestehende `deepStrictEqual(answer.result, …)` der `read`-Fälle brechen und
   werden um `offset: 0, chars: …, totalChars: …` **zwischen `text` und
   `truncated`** ergänzt: Zeilen ~3915, ~4038, ~4087, ~4120, ~4154. Ein
   Feldordnungs-Pin fehlt für `read` heute — **einer wird neu hinzugefügt**
   (`assert.deepStrictEqual(Object.keys(answer.result),
   ["tabId","url","title","text","offset","chars","totalChars","truncated","via","settled","waitedMs"])`
   im Normalfall). Die zwei handgeschriebenen Seitenantworten der beiden `click`-`about:`-Fälle
   (~5018, ~5071; es gibt keinen `type`-`about:`-Fall) bekommen `offset: 0,
   chars: 0, totalChars: 0`, weil `isUsablePageResult` jetzt drei Zahlen verlangt; die
   `deepStrictEqual`- und `Object.keys`-Pins von `click`/`type` (~4771/4776,
   ~6503/6506) bleiben **unverändert** und sind der Beweis, dass deren Antwortform
   sich nicht bewegt hat. Kommentar an `TEXT_LIMIT`: die 20 000 sind jetzt der
   Default und die Kürzung von `click`/`type`, der Deckel steht in
   `READ_MAX_CHARS_LIMIT`.
   **In dieser Stufe wird `docs/05-seiteninhalt-lesen.md` mit nachgezogen**
   (`:110-112`, `:134`, `:186`), weil hier die Antwortform entsteht —
   `docs/README.md` verlangt das Nachziehen in der Stufe, die das Verhalten
   umsetzt.
   Proof: `npm test` grün; `git diff test/extension.test.js` zeigt in den
   `click`/`type`-Pins keine Zeile; `node --test --test-timeout=60000
   test/extension.test.js` meldet für die neuen Fälle keinen `not ok`.

   **Completed 2026-10-27**

3. **`offset` hinter dem Ende ist ein Fehler** (4, Fehlerhälfte) —
   `extension/background.js`: in `readPageSource` **vor** dem `slice`
   `if (offset > totalChars) return { outcome: "offset_out_of_range", offset, totalChars };`;
   in `pageResultOf` **vor** `isUsablePageResult` ein Zweig wie in
   `inspectResultOf`: `first?.outcome === "offset_out_of_range"` ⇒
   `throw new ReadError(OFFSET_OUT_OF_RANGE_CODE, …)`. Die Meldung nennt beide
   Zahlen („The text has 87314 characters; offset 999999 is past its end."); sind sie
   keine ganzen Zahlen, ist das unsere eigene Panne und es bleibt bei
   `READ_FAILED_CODE` mit der vorhandenen Warnzeile.
   `OFFSET_OUT_OF_RANGE_CODE = "offset_out_of_range"` als Konstante neben
   `READ_FAILED_CODE` (~84); `readErrorFrame` bleibt unverändert, weil die Zahl in
   der Meldung steht und nicht in `details`. `click`/`type` sind unberührt, ihre
   Snippets rufen nie mit `offset > totalChars`.
   Proof: `test/extension.test.js` neuer Fall `offset: 999999` auf
   `DEFAULT_READ_PAGE` ⇒ `answer.ok === false`,
   `answer.error.code === "offset_out_of_range"`, `answer.error.message` enthält
   `String(totalChars)`; `npm test` grün.

   **Completed 2026-10-27**

4. **Die Bridge reicht durch und übersetzt den Code** (5 am MCP-Rand) —
   `bridge/mcp.mjs`: **auch** der Kommentar `:84-86` („An offset parameter is a
   later increment.") wird durch die Wahrheit ersetzt, sonst ist er ab Stufe 4
   eine Lüge. Dann: `const READ_ARGUMENTS = Object.freeze(["offset", "maxChars",
   TAB_ARGUMENT]);` neben `TAB_ARGUMENTS` (~305); Schema von `BROWSER_READ` (~88)
   um `offset: {type: "integer", minimum: 0}` und `maxChars: {type: "integer",
   minimum: 1, maximum: 100000}` erweitern (Reihenfolge `offset`, `maxChars`,
   `tab`), Beschreibung neu mit beiden Parametern und dem Rückweg;
   `UNEXPECTED_ARGUMENTS[BROWSER_READ]` (~335) ⇒ „browser_read erwartet nur
   `offset`, `maxChars` und `tab`." `readTool` (~629) verlässt
   `optionalArgumentsTool` und wird wie `inspectTool` (~931) gebaut:
   `hasDeclaredReadArgumentTypes(args)` (nur **Typen**: ganze Zahlen für
   `offset`/`maxChars`, `hasDeclaredTabArgument`), `hasUndeclaredArgument(args,
   READ_ARGUMENTS)` ⇒ Werkzeugsatz, dann nur die gesetzten Schlüssel in
   Schema-Reihenfolge in `requestParams` kopieren (kein Default, kein `null`) und
   `hub.request(PROTOCOL.METHODS.READ, requestParams)`; `TAB_ARGUMENTS` und
   `optionalArgumentsTool` bleiben für `status`, `focus`, `close_tab`,
   `screenshot` unverändert. Die Bereiche werden **nicht** in der Bridge geprüft —
   `inspect`s `limit` macht es genauso, und die Extension prüft in Stufe 1 noch
   einmal. **Hier** werden auch `docs/05-seiteninhalt-lesen.md` `:135`
   (`inputSchema`), `:140-141` („erwartet keine Argumente"), `:185` und `:187`
   nachgezogen — das ist die Eingangsseite, die erst mit dem Schema entsteht. `TOOL_TEXTS`: `OFFSET_OUT_OF_RANGE` statisch und
   `OFFSET_OUT_OF_RANGE_WITH_MESSAGE(message)` nach dem Muster von
   `EVAL_FAILED_WITH_MESSAGE`; in `extensionFailureText` ein Zweig `if (code ===
   OFFSET_OUT_OF_RANGE_CODE) return offsetOutOfRangeText(details)` mit
   `nonEmptyString(details?.message)`.
   `test/mcp.test.js`: `READ_TOOL_DESCRIPTION` (~83) und der Schema-`deepEqual`
   samt `Object.keys(tools[2].inputSchema.properties)` (~918) nachziehen;
   `READ_UNEXPECTED_ARGUMENTS_TEXT` (~119) neu. Der Kopfkommentar der Datei
   (`:1-17`, „In-process module tests would prove the framing code, not the
   contract") wird **ergänzt**: der Durchreich-Beweis über `handleMessageText` ist
   die benannte Ausnahme, weil die Fixture nur `tab` auf stderr trägt und eine
   Erweiterung ihren `TAB_SUFFIX`-Regex bräche. Keine neue Testdatei — die stünde
   sonst in der Touch-Boundary, die sie nicht kennt. Durchreichen **ohne**
   Fixture-Änderung: `handleMessageText` aus `../bridge/mcp.mjs` direkt importieren
   (exportiert bei ~523) und mit einem aufzeichnenden Stub-Hub aufrufen — ein
   `tools/call` mit `{offset: 20000, maxChars: 100}` ⇒ `recorded[0].params` ist
   `{offset: 20000, maxChars: 100}`; eines ohne sie ⇒ `{}` (Schlüssel
   **abwesend**, nicht `null`); `{offset: "5"}` ⇒ `-32602` und `recorded` bleibt
   leer. Der Fehlersatz end-to-end über die Fixture:
   `BC_TEST_READ_ANSWER: "error:offset_out_of_range"` plus
   `BC_TEST_ERROR_DETAILS: '{"totalChars":87314,"message":"The text has 87314
   characters; offset 999999 is past its end."}'` ⇒ der Werkzeugtext nennt `87314` und
   fällt nicht auf `CALL_EXTENSION_FAILED` zurück. Ein Fall, der die Beschreibung
   auf `offset`/`maxChars`/`chars`/`totalChars` prüft, ist mit
   `READ_TOOL_DESCRIPTION` schon da.
   Proof: `npm test` grün (`# fail 0`, `# cancelled 0`); gezielt
   `node --test --test-timeout=60000 test/mcp.test.js`; `git diff
   test/fixtures/fake-extension.mjs` leer.

   **Completed 2026-10-27**

5. **Abschluss der Spec** — `docs/22-read-ausschnitte.md`: `status: active`,
   Prosa beschreibend, der beantwortete `## Open questions`-Block bleibt als
   Feststellung des Betreibers stehen. Registerspalten in `docs/README.md`,
   `docs/PROJECT-STATE.md` und die Zeile zu Roadmap 13 in `docs/ROADMAP.md` pflegt
   der Orchestrator bei der Abnahme. Die vier Abnahmebefehle aus `CONTRIBUTING.md`,
   `## Acceptance` plus `git diff --exit-code extension/manifest.json` laufen hier zum
   ersten Mal über den ganzen Satz. Kriterium 9 ist **nicht** Sache des Umsetzers:
   es wird nach dem Commit im echten Profil gemessen (datierte Ausnahme,
   `## Messlauf`).
   Proof: `npm test; echo $?` → `0` mit `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; Secret-grep → keine Ausgabe, Exit 1;
   `git diff --exit-code extension/manifest.json` → 0.

   **Completed 2026-10-27** (Abnahme und Register beim Orchestrator)

### What could go wrong

- **`READ_PAGE_CODE` hat drei Aufrufer, nicht einen.** `clickResult` (~2403) und
  `typeResult` (~2596) lesen den Seitenzustand mit demselben Schnipsel. Wer die
  Konstante ersatzlos streicht, bricht zwei aktive Specs (06/07) an ihren
  `Object.keys`-Pins. Deshalb `PAGE_STATE_CODE = readPageCode(0, TEXT_LIMIT)` für
  die beiden, und deren Antwortobjekte bleiben feldweise zusammengesetzt — ein
  `{...page}` dort würde `offset`/`chars`/`totalChars` durchlassen und die Pins rot
  machen.
- **`pageResultOf` ist gemeinsam.** Eine strenge `isUsablePageResult` (drei ganze
  Zahlen) ist gewollt — sonst antwortet `read` bei einer kaputten Seitenantwort mit
  `undefined`-Feldern — kostet aber die zwei handgeschriebenen `about:`-Antworten
  in den `click`/`type`-Fällen.
- **Fünf `deepStrictEqual`-Vergleiche der `read`-Fälle** (~3915, ~4038, ~4087,
  ~4120, ~4154) sind die einzigen, die durch die drei Felder brechen; alle anderen
  `read`-Fälle prüfen Einzelfelder und bleiben grün. Es gibt heute **keinen**
  Feldordnungs-Pin für `read` — ohne den neuen `Object.keys`-Pin wandert die
  Reihenfolge später unbemerkt.
- **`truncated` ist nicht „mehr als `maxChars` da".** Es ist `offset + chars <
  totalChars`. Die naheliegende Formel `totalChars > maxChars` meldet für ein
  Fenster am Textende fälschlich `true` und macht Kriterium 3 kaputt.
- **`totalChars` gehört zum *gewählten* Text**, also zu `visible || content`, nicht
  zu `content` allein.
- **Kriterium 5 am MCP-Rand ist enger als die Testzeile behauptet.** `maxChars: 0`,
  `100001` und `offset: -1` sind für die Bridge *typrichtig*; nach dem
  `inspect`-Vorbild reicht sie sie durch, und die Extension lehnt ab
  (`invalid_params`, ohne Injektion). „Ohne die Extension zu erreichen" gilt nur
  für `offset: "5"` (`-32602`). Der Beweis für die Bereiche ist
  `tabs.scriptCalls === []` in `test/extension.test.js`.
- **Die Fixture trägt nur `tab` in ihre stderr-Zeile** (`requestLine`, ~498;
  `requestedTabs` hängt an ` tab=(\d+)$`). Der Durchreich-Beweis läuft deshalb über
  den exportierten `handleMessageText`-Seam mit Stub-Hub; die Fixture um
  `offset=`/`maxChars=` zu erweitern würde den `TAB_SUFFIX`-Regex brechen.
- **Der Hub bleibt unangetastet.** `formatReadLine` zählt `result.text.length`; das
  ist ab jetzt die Ausschnittslänge und zufällig gleich `chars`. Ein Griff nach
  `totalChars` würde `test/hub.test.js` rot machen.
- **Die Reihenfolge in Stufe 1 ist die halbe Miete.** Ruft `readRequestParams` erst
  nach `addressedAgentTab`, antwortet ein Aufruf mit `maxChars: 0` und ohne
  Agenten-Tab `no_agent_tab` statt `invalid_params`.
- **Kein Reparaturversuch an Surrogatpaaren** (Non-Goal). `slice` schneidet in
  UTF-16-Einheiten; ein Emoji an der Grenze kommt halb an.

### Ordering and dependencies

- Stufe 1 hängt an nichts und macht Kriterium 5 ohne jede Injektion grün.
- Stufe 2 setzt Stufe 1 voraus und ist die einzige Stufe, die bestehende
  `read`-Zusicherungen anfassen darf. Kriterium 7 ist erst hier prüfbar.
- Stufe 3 setzt Stufe 2 voraus: `totalChars` muss im `outcome` stehen, bevor
  `pageResultOf` es übersetzen kann. Die gültige Hälfte von Kriterium 4
  (`offset === totalChars`) wird schon in Stufe 2 gepinnt.
- Stufe 4 ist von 2 und 3 unabhängig, steht hier aber, weil sie den Fehlercode aus
  Stufe 3 übersetzt.
- Stufe 5 hängt an allen vorigen; die Registerspalten bleiben beim Orchestrator.

### What the next increment inherits

- **Blättern nach Zeilen/Absätzen/Überschriften** (Roadmap 14, Artikel-Extraktion)
  — eigener Zuschnitt; `offset` zählt weiterhin Zeichen nach der Normalisierung.
- **`offset`/`maxChars` für `click` und `type`** — ausdrücklich Non-Goal;
  `PAGE_STATE_CODE` ist der Ort, an dem ein späteres Inkrement sie öffnen würde.
- **Reparatur zerteilter Surrogatpaare** — Non-Goal; `offset + chars` ist der
  Fortsetzungspunkt.
- **Ein gemeinsamer Bauplatz für alle Seiten-Schnipsel.** `read` baut seinen Code
  jetzt selbst (`readPageCode`), `click`/`type`/`inspect`/`eval` gehen über
  `pageSnippetCode`. Wer `read` dort anschließt, zahlt die `PAGE_HELPERS_CODE`-
  Hilfen bei jedem `read` mit — eigene Entscheidung mit eigenem Messwert.
- **Die Hub-Logzeile** trägt weiterhin nur `chars`. Ob `offset`/`totalChars` dort
  hingehören, ist eine Frage an die Log-Hygiene.
- **`TEXT_LIMIT` hat ab jetzt zwei Rollen** (Default für `read` und Kürzung von
  `click`/`type`); `READ_MAX_CHARS_DEFAULT` ist der Name, unter dem das später
  getrennt werden kann.


## Risiken

- **Ein 100 000-Zeichen-Ausschnitt ist kein „bisschen mehr".** Als JSON mit
  Escapes sind das einige hundert Kilobyte — weit unter der 5-MiB-Grenze, aber es
  ist die größte Textantwort dieses Systems. Der Deckel steht deshalb im Schema
  *und* in der Extension.
- **Surrogatpaare können an der Grenze zerteilt werden.** `slice` arbeitet in
  UTF-16-Einheiten. Ein Emoji an der Grenze kommt halb an und wird beim nächsten
  Aufruf vervollständigt. Das ist bewusst (Anschlussfähigkeit vor Schönheit) und
  steht als Non-Goal.
- **`offset` gilt nach der Normalisierung.** Wer den Text mit einer anderen
  Normalisierung vor Augen hat, blättert an der falschen Stelle — deshalb steht
  der Satz in `## Ziel` und nicht nur im Code.
- **`totalChars` kostet einen Durchlauf.** Der Text existiert in der Seite
  ohnehin; gezählt wird ohne Kopie (`text.length`), bevor geschnitten wird.

## Touch boundary

Angefasst: `extension/background.js`, `bridge/mcp.mjs`, `test/extension.test.js`,
`test/mcp.test.js`, `docs/05-seiteninhalt-lesen.md` (die Amendments: Default statt
Wand, Antwortfelder, Beschreibung), `docs/22-read-ausschnitte.md` selbst (Stufe 5
stellt sie auf `active`), `docs/README.md`, `docs/PROJECT-STATE.md`,
`docs/ROADMAP.md` (beim Orchestrator).

**Nicht** angefasst: `extension/manifest.json`, `bridge/{protocol,websocket,
http-transport,hub}.mjs`, `extension/{protocol,options.html,options.js}`, die
Fixture, `CONTRIBUTING.md`, `INSTALL.md`, andere Specs.

## Bekannte Lücken

Stand 2026-10-27, nach den Stufen 1–5 und beiden Code-Review-Runden:

- **Blättern ist auf bewegten Seiten best effort** (2026-10-27, Messlauf): eine
  lebende Seite (Wikipedia) änderte ihre Länge zwischen zwei Aufrufen
  (77 104 → 78 958 Zeichen). `totalChars` gilt für den einen Aufruf; liegt der
  Zuwachs vor der Leseposition, kann die Naht doppelt oder lückenhaft sein. Ein
  Schnappschuss über mehrere Aufrufe wäre ein eigenes Inkrement (Text in der
  Extension halten) und ist ausdrücklich nicht gebaut.
- **`docs/14-ruhe-statt-300ms.md:29-31`** zeigt das `read`-Antwortbeispiel noch
  ohne `offset`/`chars`/`totalChars` (2026-10-27, Code-Review 2). Kein Widerspruch
  zur Absicht, aber ein Beispiel von gestern; die Boundary dieses Inkrements
  verbietet den Griff dorthin.
- **Die Dev-Pläne von `docs/05`, `06` und `07` nennen `READ_PAGE_CODE`**, das es
  nicht mehr gibt (2026-10-27). Historie, kein Widerspruch — `CONTRIBUTING.md` verlangt
  englische Namen, nicht die Ewigkeit von Stufenplänen.

## Open questions

Keine offenen. Beantwortet vom Betreiber am 2026-10-27:

1. **Deckel `maxChars` = 100 000**, Default 20 000 (wie bisher).
2. **`offset`, `chars`, `totalChars`** in der Antwort.
3. **`offset` hinter dem Ende wird abgelehnt**, nicht gekappt — mit eigenem Code
   `offset_out_of_range`, der `totalChars` nennt. Genau auf dem Ende
   (`offset === totalChars`) ist gültig und liefert einen leeren Ausschnitt.

## Messlauf (2026-10-27, Betreiber-Profil)

Gemessen über den Dienst (`systemctl --user restart`, neue Erweiterung geladen),
`browser_read` per MCP-Aufruf:

- **Kriterium 9 grün, mit Naht-Probe.** `https://www.rfc-editor.org/rfc/rfc9110.html`
  (statische Seite): `totalChars = 447007`, stabil über alle Aufrufe. Neun
  Aufrufe mit `maxChars: 50000` (achtmal 50 000, zuletzt 47 007) bis
  `truncated: false`; **Summe der `chars` = 447 007 = `totalChars`**. Die
  Ausschnitte sind **lückenlos und ohne Doppelung**: Seite 1 ist zeichengleich mit
  den ersten 50 000 Zeichen eines Einzelaufrufs, und ein Fenster über die Naht
  (`offset: 45000, maxChars: 10000`) entspricht exakt dem Ende von Seite 1 plus
  dem Anfang von Seite 2.
- **Haltepunkt.** `offset = totalChars` (447 007) ⇒ `text: ""`, `chars: 0`,
  `truncated: false`.
- **Fehlerfall.** `offset: 999999` ⇒ `offset_out_of_range` mit der echten Zahl:
  „`offset` is past the end of the text: The text has 78958 characters;
  offset 999999 is past its end." (gemessen auf der Wikipedia-Seite, daher die
  andere Gesamtzahl).
- **Befund: eine lebende Seite wächst zwischen den Aufrufen.** Auf
  `https://de.wikipedia.org/wiki/Firefox` meldeten die vier Aufrufe
  `totalChars` 77 104 → 77 104 → 77 199 → 78 958. Die Summe der `chars` traf
  zufällig die letzte Zahl, weil der Zuwachs hinten lag — bei einer Einfügung
  **vor** der Leseposition wäre die Naht doppelt oder lückenhaft, ohne dass eine
  Längenprobe das zeigt. `totalChars` ist also eine **Momentaufnahme je Aufruf**,
  kein Schnappschuss über die Blätter-Sitzung; auf bewegten Seiten bleibt Blättern
  best effort. Das steht unter `## Bekannte Lücken`.

## Review

### Runde 1, 2026-10-27 — `🔧 Fix these` (Blocker dabei)

Geprüft gegen `spec-doc-review`, `docs/README.md` und `CONTRIBUTING.md`; die
Behauptungen des Dev-Plans wurden am Code gegengeprüft und halten fast alle:
drei `READ_PAGE_CODE`-Aufrufer (1756, 2403, 2596), fünf brechende
`deepStrictEqual` exakt an 3915/4038/4087/4120/4154, kein Feldordnungs-Pin für
`read`, die `click`/`type`-Pins ziehen Felder einzeln, `handleMessageText` liegt
exportiert bei 523 und `details` ist der ganze Fehlerrahmen (`hub.mjs:626`), die
Fixture trägt wirklich nur `tab` und `requestedTabs` hängt an ` tab=(\d+)$`,
`formatReadLine` zählt `result.text.length`, und beide Protokollkopien führen
keine Fehlercodeliste — `offset_out_of_range` braucht dort nichts.

Blockierend: `## Testing` behauptete, die bestehenden `read`-Fälle blieben grün,
während die drei Felder zwischen `text` und `truncated` fünf Objektvergleiche
brechen (B1); die Spec änderte das dokumentierte Verhalten von `docs/05`
(Antwortform, 20 000er-Wand, Werkzeugbeschreibung) ohne `## Amendments to
previous spec docs`, und die Touch-Boundary erklärte „andere Specs" für unberührt
(B2); die MCP-Testzeile versprach `-32602` für `offset: -1` und
`maxChars: 100001`, die die Bridge nach `inspect`-Vorbild nur typgeprüft
durchreicht (B3); Kriterium 9 war arithmetisch falsch (drei Aufrufe à 20 000
erreichen bei 87 314 Zeichen das Ende nicht) und verwies auf ein `## Messlauf`,
das diese Spec nicht hatte (B4). Dazu fehlte die Testzeile für den
`offset_out_of_range`-Satz am MCP-Rand (B5).

Minors: „keine Längen" in der Hub-Logzeile war falsch, `chars=` steht dort (B6);
doppelte Testzeile und `click`/`type`-`about:` statt zweier `click`-Fälle (B7);
der Kommentar „An offset parameter is a later increment." in `bridge/mcp.mjs:83`
fehlte in der Editierliste (B8); der Durchreich-Beweis über `handleMessageText`
widersprach dem Kopf von `test/mcp.test.js` (B9).

### Runde 2, 2026-10-27 — `🔧 Fix these` (Blocker dabei)

Sieben der neun Befunde aus Runde 1 sind an der Stelle geprüft und sitzen: die
fünf nachziehenden Objektvergleiche samt neuem Feldordnungs-Pin (B1) — es gibt für
`read` wirklich keinen, die vier vorhandenen Pins gehören `navigate`, zweimal
`click` und `type` —, die geteilte MCP-Testzeile samt antwortender Seite je
Eingabe (B3), die Testzeile für den `offset_out_of_range`-Satz (B5), `chars=` in
der Hub-Zeile über `pageTextCharCount` (B6), die entdoppelte Testzeile und die
zwei `click`-`about:`-Fälle an 5018/5071 (B7), der Kommentar
`bridge/mcp.mjs:84-86` in Stufe 4 (B8) und der `handleMessageText`-Kopf (B9, beide
Wege zulässig). `## Messlauf` existiert.

Blockierend blieb: Kriterium 9 widersprach sich selbst („bis `truncated: false`"
endet bei 87 314 Zeichen auf `offset = 80000`, nicht auf `offset === totalChars`
mit leerem `text`; C1). Die Amendments zu `docs/05` nannten mit `:100-107` die
falsche Stelle (die Wand steht auf `:110-112`) und ließen die ganze Eingangsseite
aus — `:135` (`inputSchema` mit leerem `properties`), `:140-141`, `:185`, `:187`
hätten nach Stufe 4 weiterhin ein argumentloses `browser_read` behauptet; außerdem
besaß keine Stufe die Datei (C2).

Minors: Kriterium 7 und `offset: "5"` (Extension-Hälfte) fehlten in `## Testing`
(C3); das Beispiel in `## Ziel` stellte `via` vor `text` und widersprach damit dem
neuen Feldordnungs-Pin (C4).

### Runde 3, 2026-10-27 — `✅ Ship it` (kein Blocker)

An der Stelle geprüft: Kriterium 9 endet jetzt bei `truncated: false` mit Summe der
`chars` = `totalChars`, und der Haltepunkt (`offset = totalChars` ⇒ leerer `text`)
ist ein eigener Satz — bei 87 314 Zeichen fünf Aufrufe plus Haltepunkt, die
Arithmetik geht auf (C1). Die Amendments nennen `docs/05` mit `:110-112`, `:134`,
`:186` und der Eingangsseite `:135`, `:140-141`, `:185`, `:187`; alle acht Stellen
tragen im Dokument diesen Inhalt, und Stufe 2 zieht die Datei ausdrücklich nach
(C2). Beide fehlenden Testing-Zeilen sind da (C3), das Beispiel in `## Ziel` stellt
`via` hinter `truncated` (C4). Keine neuen Widersprüche: Kriterien 1–9 gegen
`## Testing` und `## Messlauf`, Feldreihenfolge in Beispiel/Stufe 2/Pin/Notiz,
Amendments gegen Boundary; Stufen 1–5 hängen nur an ihren Vorgängern.

Vier Kleinigkeiten ohne Entscheidungswert (D1–D4, siehe `## Log`): die
`docs/05`-Stellen sind auf Stufe 2 und 4 aufgeteilt, `## Messlauf` nimmt den
Haltepunkt in die Eintragsliste, der Kommentar steht auf `:84-86`, und der
Durchreich-Beweis bleibt im Dateikopf statt in einer neuen Datei.


### Code-Review 2, 2026-10-27 — `🔧 Fix these` (ein Blocker)

Geprüft gegen `7d9cfd7`, Abnahme selbst gefahren: `# tests 542`, `# pass 542`,
`# fail 0`, `# cancelled 0`, Exit 0; `npm run check` 0; Secret-Grep Exit 1;
`git diff --exit-code extension/manifest.json` 0; fünf geänderte Dateien. R1–R5
sitzen an der Stelle. Nachgemessen statt geglaubt: `read` fällt bei
`invalid_params` **immer** auf den eigenen Satz (der `-32602`-Pfad erreicht
`extensionFailureText` nie); `offset_out_of_range` bleibt unberührt
(`{code, message}`, `Object.keys`-Pin); die zwei negativen Fälle sind scharf — in
einer Wegwerfkopie machte ein entferntes `Number.isInteger` den Fensterzahlen-Fall
rot und ein entferntes `isUsableOffsetOutOfRange` den `outcome`-Fall, jeweils ohne
den anderen mitzunehmen.

Blocker: `docs/05` behauptete weiter, „anderer Code" falle auf `(code=<code>)` —
für `invalid_params` gilt seit R3 der eigene Satz. Dazu zwei Notizen ohne
Gatewert: die Beschreibungszeile nannte die Fensterparameter nicht, und das
`read`-Beispiel in `docs/14` trägt die drei Felder nicht (Boundary).

## Log

Noch keine Befunde.

Runde 1 des Spec-Reviews — alle neun Befunde übernommen:

- **B1** („bestehende `read`-Fälle bleiben grün" widersprach den drei neuen
  Feldern, die fünf Objektvergleiche brechen) — übernommen: die Testsektion sagt,
  welche fünf Vergleiche nachziehen, und ein neuer Feldordnungs-Pin hält die
  Reihenfolge fest.
- **B2** (Änderung an `docs/05` ohne Amendments-Abschnitt) — übernommen:
  `## Amendments to previous spec docs` nennt `docs/05` mit Stellen und neuer
  Bedeutung, `docs/05` steht in der Touch-Boundary.
- **B3** (`-32602` für `offset: -1`/`maxChars: 100001` war mit unangetasteter
  Fixture nicht baubar) — übernommen: die Testzeile ist geteilt in Typprüfung
  (Bridge, `-32602`) und Bereichsprüfung (Extension, `invalid_params`, keine
  Injektion); Kriterium 5 nennt je Eingabe die antwortende Seite.
- **B4** (Kriterium 9 war arithmetisch falsch und verwies auf ein fehlendes
  `## Messlauf`) — übernommen: geblättert wird bis `truncated: false`, die Summe
  der `chars` muss `totalChars` ergeben; `## Messlauf` existiert.
- **B5** (kein Test für den `offset_out_of_range`-Satz am MCP-Rand) —
  übernommen: eigene Zeile mit `totalChars` im Werkzeugtext.
- **B6** („keine Längen" in der Hub-Logzeile war falsch) — übernommen: `chars=`
  steht dort schon heute und ist ab jetzt die Ausschnittslänge.
- **B7** (doppelte Testzeile; zwei `click`-`about:`-Fälle statt `click`/`type`) —
  übernommen.
- **B8** (der Kommentar `bridge/mcp.mjs:83-85` fehlte in der Editierliste) —
  übernommen, er wird in Stufe 4 mit ersetzt.
- **B9** (der Durchreich-Beweis über `handleMessageText` widerspricht dem
  Dateikopf von `test/mcp.test.js`) — übernommen: der Kopf wird ergänzt, oder der
  Beweis zieht in eine eigene Datei; eins von beidem.

Runde 2 des Spec-Reviews — alle vier Befunde übernommen:

- **C1** (Kriterium 9 verlangte zwei Dinge, die sich ausschließen) — übernommen:
  die Schleife endet bei `truncated: false` mit Summe `chars = totalChars`; der
  Haltepunkt (`offset = totalChars` ⇒ leerer Text) ist ein **eigener Satz** und
  wird zusätzlich in `## Messlauf` eingetragen.
- **C2** (Amendments nannten `:100-107` statt `:110-112` und ließen die
  Eingangsseite von `docs/05` aus; keine Stufe besaß die Datei) — übernommen: die
  Tabelle nennt beide Stellenbereiche samt `inputSchema`/„keine Argumente", und
  **Stufe 2** zieht `docs/05` ausdrücklich mit nach.
- **C3** (kein Testfall für Kriterium 7; `offset: "5"` fehlte in der
  Extension-Zeile) — übernommen, zwei Zeilen ergänzt.
- **C4** (das Beispiel in `## Ziel` stellte `via` vor `text`) — übernommen,
  Reihenfolge wie im Feldordnungs-Pin.

Runde 3 des Spec-Reviews — Gate mit `✅ Ship it` geöffnet; die vier Notizen als
Zeilen übernommen (D1–D4):

- **D1** (die `docs/05`-Stellen waren nicht auf die Stufen verteilt) — übernommen:
  Stufe 2 nimmt `:110-112`, `:134`, `:186` (Antwortform), Stufe 4 `:135`,
  `:140-141`, `:185`, `:187` (Eingangsseite/Schema).
- **D2** (`## Messlauf` zählte den Haltepunkt nicht auf) — übernommen.
- **D3** (Kommentar steht auf `:84-86`, nicht `:83-85`) — übernommen.
- **D4** (Stufe 4 ließ „Kopfkommentar oder eigene Datei" offen) — übernommen: die
  **Kopfkommentar-Variante** ist festgeschrieben, keine neue Testdatei (die fehlte
  sonst in der Touch-Boundary).

Code-Review Runde 1 — `🔧 Fix these`, zwei Blocker und fünf Zeilen:

- **R1** (die Testing-Zeile in `docs/05` behauptete neun Antwortfelder im
  Fixture-Fall, die Fixture trägt sechs) — übernommen: sechs Felder, und für
  `offset`/`chars`/`totalChars` zwei benannte `test/extension.test.js`-Fälle.
- **R2** (`docs/05` sagte „anderer Code → generisch" und „`chars` nur in der
  Logzeile") — übernommen: `offset_out_of_range` hat einen eigenen Punkt, die
  `chars`-Klammer ist korrigiert.
- **R3** (`read`s `invalid_params` fiel in der Bridge auf den generischen Satz) —
  übernommen: `TOOL_TEXTS.INVALID_READ_PARAMS` (+ `_WITH_MESSAGE`),
  `invalidReadParamsText`, eigener Zweig, eigener Fall.
- **R4** (der `answerRead`-Docstring zählte vier Ausgänge, es sind sechs) —
  übernommen.
- **R5** (die neue Strenge von `isUsablePageResult` und der
  `offset_out_of_range`-Rückfall hatten keinen negativen Fall) — übernommen, zwei
  Fälle, mutationsgeprüft.
- **R6/R7** (die Dev-Pläne nennen `READ_PAGE_CODE`; der Bericht nannte als
  Baseline 534 statt 522) — als Historie unter `## Bekannte Lücken` vermerkt bzw.
  korrigiert.

Code-Review Runde 2 — `🔧 Fix these` mit einem Blocker (S1) und zwei Notizen:

- **S1** (`docs/05` behauptete weiter, `invalid_params` falle auf den
  Catch-all) — übernommen: eigener Punkt in der `tools/call`-Liste.
- **S2** (die Beschreibungszeile in `docs/05` nannte die Fensterparameter nicht) —
  übernommen, eine Zeile.
- **S3** (das `read`-Beispiel in `docs/14` trägt die drei Felder nicht) — **nicht**
  umgesetzt, die Boundary verbietet den Griff; steht unter `## Bekannte Lücken`.
