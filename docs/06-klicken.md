---
description: Der Agent klickt — browser_click trifft ein Element im Agenten-Tab über einen CSS-Selektor, wartet auf die Folgen und meldet, was danach auf der Seite steht; Tippen bleibt ausdrücklich draußen.
status: active
---

# Klicken: `browser_click`

Der Agent kann navigieren und lesen. Jetzt soll er den ersten Schritt einer
Aufgabe selbst tun können: auf etwas klicken. **Tippen ist nicht dabei** —
`browser_type` ist das nächste Inkrement, und ein Formular halb bedienen zu
können ist schlechter als es gar nicht zu können.

## Ziel

`browser_click` mit einem CSS-Selektor klickt das erste passende Element im
Agenten-Tab, wartet kurz, ob die Seite reagiert, und antwortet mit dem neuen
Zustand: `tabId`, `url`, `title`, `clicked` (eine kurze Beschreibung des
getroffenen Elements), `scrolled` (neu in `docs/56`: `true`, wenn das Ziel erst
herangescrollt werden musste), `text` — der Seitentext **nach** dem Klick —,
`truncated` und `via`, nach denselben Regeln wie `browser_read`.

Der Agent bekommt damit genau die Rückmeldung, die er für den nächsten Schritt
braucht: hat der Klick gewirkt, und was steht jetzt da.

## Non-goals

- **Kein Tippen** (`browser_type`), keine Tastatur, kein Absenden von Formularen.
  Nächstes Inkrement.
- Kein Klicken in einem fremden Tab, kein Klicken per Koordinaten, kein
  Hover/Scroll, keine Drag-and-drop-Geste.
- Kein Warten auf „die Seite ist fertig" über den festen Zeitraum hinaus —
  Inkrement 09 („Warten auf Ruhe") löst das grundsätzlich.
- Keine Screenshots, kein `focus`. Frames seit Spec 26: `frame` adressiert optional einen Rahmen (URL-Teilstring).
- Keine neuen Berechtigungen: `<all_urls>` aus Inkrement 05 deckt die Injektion.
- Kein stilles Nichtstun: ein unsichtbares oder deaktiviertes Element ist eine
  Ablehnung (`not_clickable`), siehe `## Wire-Protokoll`.

## Wire-Protokoll (neu: `click`)

`PROTOCOL.METHODS` bekommt `CLICK: "click"`. Anfrage:

```json
{"type":"request","id":4,"method":"click","params":{"selector":"a[href*=\"/watch\"]"}}
```

Antwort:

```json
{"type":"response","id":4,"ok":true,
 "result":{"tabId":7,"url":"https://www.youtube.com/watch?v=…","title":"… - YouTube",
           "clicked":"a#video-title-link","scrolled":false,"text":"…","truncated":true,"via":"innerText"}}
```

- **Selektor**: jeder String; ein fehlender oder nicht-String-Selektor ist
  `invalid_params`, ein **leerer** String geht in die Seite (dort entscheidet
  `querySelector` und antwortet `invalid_selector`). Sucht im Hauptrahmen, sofern `frame` keinen Rahmen adressiert (Spec 26). Ein
  Selektor, den `querySelector` nicht parst, ist `invalid_selector`; ein
  Selektor ohne Treffer ist `no_match`. Beides **ohne** Klick.
- **`clicked`** ist eine kurze, stabile Beschreibung des Elements, **vor** dem
  Klick gebaut (ein Rerender kann `id`/`class` danach löschen). Format:
  `tag#id`, sonst `tag.ersteKlasse`, sonst `tag[href="…"]` bzw.
  `tag[aria-label="…"]`, sonst nur `tag`; Tag klein, maximal 120 Zeichen. Kein
  `outerHTML` (zu groß, und es enthält den Seitentext).
- **Klick selbst**: `element.click()` nach einem Sichtbarkeitscheck
  (`getBoundingClientRect()` hat Fläche, `visibility !== "hidden"`,
  `display !== "none"`, `disabled !== true`). Ist eines davon nicht erfüllt:
  `not_clickable` und **kein** Klick — ein stilles Nichtstun ist die schlechteste
  Antwort.
- **Warten danach**: 300 ms fest, nicht mehr. Länger wäre Raten; ob die Seite
  „fertig" ist, weiß Inkrement 09 besser. Danach wird der Seitentext gelesen wie
  bei `browser_read`.
- **Navigation durch den Klick**: Ändert der Klick die Seite (SPA-Route oder
  echtes Laden), liefert die Antwort die **neue** `url` und den neuen `title`.
  Wird dabei eine `about:`-Adresse erreicht, gilt dieselbe Regel wie bei
  `navigate` — `about:` ist nie eine geladene Seite. Die Klick-Antwort hat kein
  `complete`; dort tragen deshalb `url` und `title` den **vor** dem Klick
  gemerkten Stand, `text: ""`, `truncated: false`, `via: "innerText"`. Ist
  auch der Vorher-Stand eine `about:`-Adresse, gilt `url: ""` und
  `title: ""` — `about:` wird nie als Seite gemeldet.
- **Kein Agenten-Tab / Tab weg / Container**: `no_agent_tab` wie bei `read`.

## MCP-Werkzeug

| Feld | Wert |
|---|---|
| `name` | `browser_click` |
| `description` | Works on the **current** agent tab and takes **no** URL — call `browser_navigate` first. Clicks the first element that matches the CSS selector in the agent tab, waits until the page has settled (3 s at most) and returns the page text afterwards (cut to 20 000 characters); reports `settled`/`waitedMs`. With `tab` exactly that tab, without `tab` the one used last. |
| `inputSchema` | `{"type":"object","properties":{"selector":{"type":"string"},"frame":{"type":"string","minLength":1}},"required":["selector"],"additionalProperties":false}` |

`tools/call`:

- **Erfolg**: `{"content":[{"type":"text","text":"<JSON, 2 Leerzeichen eingerückt>"}]}`.
- **`selector` fehlt oder ist kein String**: JSON-RPC-Fehler `{code:-32602, message:"invalid params"}`.
- **unbekanntes Argument**: `isError` mit „browser_click takes only `selector`, `frame` and `tab`."
  (Tabelle je Werkzeug, wie bei `browser_navigate`; englisch seit `docs/54`).
- **`invalid_selector`**: `isError`, „The selector is invalid: <selektor>."
- **`no_match`**: `isError`, „No element matches: <selektor>." Bei einem Textklick
  nennt der Satz den Begriff; endete die Suche am Kandidatendeckel, trägt die
  Antwort zusätzlich `truncated: true`.
- **`text_ambiguous`** (neu in `docs/58`): `isError`, mehr als ein Element trifft den
  Begriff. Belege: `matches` (Zahl), `candidates` (bis fünf Selektoren),
  `truncated`; am Deckel sagt der Satz „at least". **Kein** Klick. Die Brücke baut
  daraus den englischen Satz mit Zahl, Kandidaten und Rat (`docs/60`).
- **`invalid_params` ohne Ziel**: weder `selector` noch `contains_text`, oder ein
  leerer Suchbegriff. Der Satz nennt beide Namen."
- **`not_clickable`**: `isError`, „The element is not visible or is disabled: <selektor>."
- **`selector` oder `contains_text`** (seit `docs/58`): mindestens eines, beide
  zusammen schränken ein (Selektor **und** Text). Ein leerer Selektor neben einem
  Begriff zählt als „nicht gesetzt".
- **`offscreen_after_scroll`** (neu in `docs/56`): `isError`, „The element stays outside
  the viewport after scrolling: <selektor>." — **kein** Klick. Die Prüfung läuft
  **nach** `not_clickable`: ein Element ohne Fläche wird nicht gescrollt.
- **`no_agent_tab`**: `TOOL_TEXTS.NO_AGENT_TAB`, wörtlich derselbe Satz wie bei
  `browser_read` („No agent tab — call browser_navigate first.").
- **`not_readable_after_click`** (neu in `docs/61`): `isError`, „The click went
  through, but the page it opened cannot be read: <url>. Go back with
  browser_navigate." — der Klick lief, die Seite danach lässt sich nicht lesen.
- **`not_readable`** gilt im Klick-Pfad nur noch **vor** dem Klick: Ist der Tab
  schon unlesbar (`about:config`, PDF, `view-source:`), wird nicht geklickt, und
  der Code bleibt `not_readable`. **`read_failed`** (der eingespritzte Code
  lieferte kein brauchbares Objekt) geht unverändert durch.
- **`superseded`**, **`click_failed`**, **Zeitüberschreitung**: `isError` mit
  „The extension could not carry out the request (code=<code>)." —
  `CALL_EXTENSION_FAILED(code)`, wie bei den anderen Werkzeugen.

## Hub

Keine strukturelle Änderung: `request(method, params)` trägt die vierte Methode.
Logzeile `click selector=<selektor> tab=<id> url=<url>` — **ohne** Seitentext,
und der Selektor mit ersetzten Zeilenumbrüchen; bei `BC_LOG=debug` der
Ergebnisblock mit `text: "<n chars>"` **und** `clicked: "<n chars>"` (Redaktion
wie bei `read`, hier für zwei Felder). Die Fehlerzeile des Hubs bleibt
`click failed peer=<ip> code=<code>` — ohne Selektor, wie die anderen
Fehlerzeilen; wer wissen will, was nicht passte, liest die Werkzeug-Antwort.

## Extension

- Zweig in `answerRequest`, `answerClick`/`clickErrorFor` (Muster:
  `answerRead`/`readErrorFor`).
- Der Klick läuft **im injizierten Code** (dieselbe Technik wie `read`:
  Funktion per `toString()`, Grenzen als Argumente): Selektor prüfen, Element
  finden, Sichtbarkeit prüfen, `click()`. Danach wartet der **Background** 300 ms,
  und eine **zweite** Injektion liest den Seitentext nach den Regeln aus
  Inkrement 05 (inklusive `via`, Kappung).
  **`click` und `navigate` teilen sich einen Slot** (beide verändern die Seite):
  der neuere Aufruf gewinnt, der ältere antwortet `superseded` (`click`) bzw.
  `complete: false` (`navigate`). Die Ablösung greift, solange der ältere Aufruf
  wartet; **nach dem Warten und vor der zweiten Injektion** prüft er, ob er noch
  der Eigentümer des Slots ist, und antwortet sonst `superseded` — er liest die
  fremde Seite also gar nicht erst.

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `test/protocol.test.js` — `METHODS.CLICK` | Steht wörtlich in beiden Kopien der Konstanten |
| `test/extension.test.js` — kein Agenten-Tab | `no_agent_tab`, **keine** Injektion |
| dito — Selektor, den `querySelector` nicht parst | `invalid_selector`, kein Klick |
| dito — Selektor ohne Treffer | `no_match`, kein Klick |
| dito — Element ohne Fläche / `display:none` / `disabled` | `not_clickable`, **kein** `click()` (der Stub zählt die Aufrufe) |
| dito — sichtbares Element | `click()` genau einmal, `clicked` beschreibt es (Tag + Id/Klasse/Attribut, ≤ 120 Zeichen) |
| dito — Klick ändert `document.title`/`location` im Stub | Antwort trägt die neuen Werte, `text` ist der Text danach |
| dito — zwei Klicks überlappen | Der erste antwortet `superseded`, löst **kein** Lesen mehr aus und hinterlässt keinen Timer (zwei `executeScript`-Aufrufe, nicht drei) |
| dito — `click` während einer laufenden Navigation | Die Navigation antwortet `complete: false`, der Klick `ok: true` (Neuling gewinnt) |
| dito — fehlender/nicht-String-Selektor | `invalid_params`, keine Injektion |
| dito — Seite ist nach dem Klick nicht lesbar | `not_readable` geht unverändert durch (kein Sammelcode) |
| `test/hub.test.js` — `request("click", …)` | Zuordnung über die `id`, Logzeile `click selector=… tab=… url=…` ohne Seitentext |
| dito — Selektor mit Zeilenumbruch (`div\n a`) | In der Logzeile steht ein Leerzeichen, genau eine physische Zeile |
| dito — `BC_LOG=debug` | Debug-Block mit `text: "<n chars>"` und `clicked: "<n chars>"`; weder Text noch `href` in den Logzeilen |
| `test/mcp.test.js` — `tools/list` | Vier Werkzeuge, `browser_click` mit `required:["selector"]` |
| dito — Erfolg, fehlender Selektor, unbekanntes Argument, `invalid_selector`, `no_match`, `not_clickable`, `no_agent_tab`, `superseded` | je der Satz aus `## MCP-Werkzeug`, alles `isError` außer Erfolg und `-32602`; `no_agent_tab` trägt wörtlich den Satz aus `browser_read` |

## Acceptance criteria

1. `npm test; echo $?` → `0`, Ausgabe enthält `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. Von den 135 bisherigen Fällen laufen **133
   unverändert**; **zwei müssen sich ändern**, weil das Inkrement ihre
   Voraussetzung aufhebt: der Werkzeugzahl-Fall in `test/mcp.test.js`
   (`…ExactlyTheThreeTools…`) und
   `onMessage_withUnknownMethod_shouldReplyUnsupportedMethod` in
   `test/extension.test.js`, der `click` heute als Beispiel für „nicht
   implementiert" benutzt. Beide stehen mit Begründung im Bericht.
2. `tools/list` liefert vier Werkzeuge; `browser_click` hat
   `required: ["selector"]` und `additionalProperties: false`.
3. Mit Fake-Extension liefert `browser_click` Text, der sich als JSON parsen
   lässt und `tabId`, `url`, `title`, `clicked`, `scrolled`, `text`, `truncated`, `via`
   enthält.
4. `invalid_selector`, `no_match` und `not_clickable` kommen als `isError` mit
   den englischen Sätzen an (Beleg: `test/mcp.test.js`; englisch seit `docs/54`), und in allen drei Fällen
   wurde **kein** `click()` ausgeführt (Beleg: `test/extension.test.js`, der
   Teststub zählt die Klicks). Überlappung: der abgelöste
   Aufruf antwortet `superseded`, löst **kein** Lesen mehr aus und hinterlässt
   keinen Timer — dass in diesem Fenster trotzdem schon geklickt wurde, ist
   unvermeidlich (der Klick passiert vor den 300 ms) und wird **nicht** als
   Kriterium behauptet.
5. Weder die Logzeile noch der Debug-Block (`BC_LOG=debug`) enthalten
   Seitentext oder den angeklickten `href`: `logLines.join("\n")` enthält weder
   `result.text` noch `result.clicked`. Beleg: `test/hub.test.js`.
6. **Die Handgriffe des Betreibers**: Extension in `about:debugging` neu laden,
   pi neu starten. Danach klickt der Orchestrator auf der YouTube-Startseite ein
   Video an (`a[href*="/watch?v="]`) und belegt mit der Antwort, dass die
   Watch-Seite geladen wurde — `url` mit `/watch?`, `clicked` gesetzt. **Der
   ursprünglich hier genannte Selektor `a#video-title-link` war falsch:** er
   existiert nur im Empfehlungsbereich der Watch-Seite, nicht im Feed der
   Startseite — die Messung antwortete korrekt `no_match`, und das Kriterium
   wurde nach der Messung korrigiert.

   **Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 6
   ist erst nach den Handgriffen messbar; Kriterien 1–5 laufen vor dem Commit.
   Fällt 6 rot aus, wird vorwärts korrigiert und die rote Zeile mit Datum unter
   `## Bekannte Lücken` eingetragen; ist die **Kernannahme** widerlegt (der Klick
   wirkt nicht), geht das Inkrement zurück in die Spec.

## Dev plan

1. **Wire-Konstante `click` auf beiden Seiten.** `bridge/protocol.mjs` und
   `extension/protocol.js`: `CLICK: "click"` in `METHODS` (beide Kopien im selben
   Schritt — `extensionProtocol_comparedToBridgeProtocol_shouldBeIdentical`
   vergleicht sie per `deepStrictEqual`). Neuer Fall in `test/protocol.test.js`:
   `extensionAndBridgeProtocols_methodsClick_shouldBothSpellItOutLiterally`,
   gebaut wie der `read`-Fall (der Objektvergleich bleibt grün, wenn *beide*
   Seiten den Schlüssel nicht haben).
   Proof: `node --test --test-reporter=tap test/protocol.test.js | grep -E '^# (pass|fail)'`
   → `# fail 0`, `# pass 5` (vorher 4). **Completed 2026-10-23**
2. **Klick in der Extension: zwei Injektionen, die 300 ms im Background.**
   `extension/background.js`: `CLICK_WAIT_MS = 300`, `CLICK_FAILED_CODE =
   "click_failed"`, `SUPERSEDED_CODE`, `SUPERSEDED_MESSAGE`,
   `MISSING_SELECTOR_MESSAGE`, Liste der erlaubten Outcomes (Muster:
   `TEXT_SOURCES`); `class ClickError` (Muster: `ReadError`); Zweig in
   `answerRequest`; `answerClick`/`clickErrorFor` (Muster:
   `answerRead`/`readErrorFor`); `clickRequestSelector(params)` (Muster:
   `navigateRequestUrl`: kein String ⇒ `invalid_params`; der leere String geht
   **in die Seite**, dort entscheidet `querySelector`); `clickAgentTab`,
   Tab-Auflösung wie `readAgentTabPage` (`no_agent_tab` **vor** jeder Injektion),
   der Tab-Stand vor dem Klick wird als `{url, title}` festgehalten.

   Injektion 1, `clickPageSource(selector)` per `toString()`, Selektor
   `JSON.stringify`-quotiert als Argument: `try { document.querySelector(selector) }
   catch { return {outcome:"invalid_selector"} }`; `null` ⇒ `no_match`; genestete
   `isClickable` (`getBoundingClientRect()` Fläche, `getComputedStyle(element)`
   `visibility !== "hidden"`, `display !== "none"`, `disabled !== true`) ⇒ sonst
   `not_clickable` **ohne** `click()`. Bei einem klickbaren Element gilt die
   Reihenfolge: **erst** `clicked = describeElement(element)` (Tag klein + `#id`,
   sonst `.ersteKlasse`, sonst `[href="…"]`/`[aria-label="…"]`, sonst nur der
   Tag, `slice(0, 120)`, nie `outerHTML`), **dann** `element.click()`, dann
   `{outcome:"clicked", clicked}` — die Beschreibung entsteht vor dem Klick,
   weil ein Rerender `id`/`class` danach löschen kann. Danach `await waitForClickWindow()` (Muster
   `waitForTabComplete`: `{settled, finish}`, idempotentes `finish` mit
   `clearTimeout`). Injektion 2 ist **derselbe** `READ_PAGE_CODE`: dafür
   `injectPageCode(tabId, code)` aus `readAgentTabPage` herausziehen (try/catch ⇒
   `not_readable`, dann `pageResultOf`); `readAgentTabPage` wird Tab-Auflösung +
   `injectPageCode(tab.id, READ_PAGE_CODE)` und verhält sich unverändert (die
   `read`-Fälle bleiben grün). Antwort = `pageResultOf`-Ergebnis + `clicked`;
   ist die `url` aus dem Seitenergebnis eine `about:`-Adresse, tragen `url` und
   `title` den Vorher-Stand, `text: ""`, `truncated: false`,
   `via: "innerText"` (Spec 04: „`about:` ist nie eine geladene Seite").

   *Warum zwei Snippets:* der Klick-Snippet muss synchron bleiben. Eine
   Injektion müsste Normalisierung, `truncated` und `via` aus `readPageSource`
   ein zweites Mal in die Seite schreiben — eine zweite Kopie der Regel, die
   Spec 06 ausdrücklich „nach denselben Regeln wie `browser_read`" nennt. So ist
   die Antwort strukturell das `read`-Ergebnis plus `clicked`. *Prüfbarkeit:*
   `clock.pendingDelays()` → `[300]`, `clock.runNext()` → `300`; kein echter
   Wartelauf.

   `test/extension.test.js`: `runPageCode`-Kontext um `document.querySelector`
   und `getComputedStyle` erweitern (Seiten-Stub mit `elements`, Default
   `"block"`/`"visible"`), neue Helfer `sendClick`, `createClickTabs`,
   `DEFAULT_CLICK_PAGE`; die Fälle aus `## Testing` (unter anderem kein Tab,
   unparsbarer Selektor, kein Treffer, Fläche/`display`/`disabled`, sichtbares
   Element, `about:`-Fall) — **der Seiten-Stub schreibt `title`/`location` durch**
   (Getter/Setter auf demselben `page`-Objekt, nicht Kopien), sonst sieht die
   zweite Injektion den alten Stand und der Fall „Klick ändert Titel/Adresse"
   wäre grün ohne Beweis; die Fälle aus `## Testing` (kein Tab, unparsbarer
   Selektor, kein Treffer, Fläche/`display`/`disabled`, sichtbares Element mit
   genau einem `click()`, geänderter `document.title`/`location`, `about:`-Fall
   über einen `executeScript`, der für Aufruf 2 ein `about:blank`-Ergebnis
   liefert). **`clickErrorFor` reicht `ReadError` unverändert durch** — die Codes
   `not_readable` und `read_failed` aus der zweiten Injektion bleiben also
   erhalten und fallen nicht in den Sammelcode `click_failed`. Der Selektor geht
   in `formatClickLine` durch `[\r\n]+` → ein Leerzeichen, in den deutschen
   Sätzen bleibt er verbatim; die Debug-Kopie redigiert `text` **und** kürzt
   `clicked`. `onMessage_withUnknownMethod_shouldReplyUnsupportedMethod` wandert
   von `click` auf `type` (die Methode des nächsten Inkrements) — das ist die
   zweite Änderung an einem Bestandsfall, siehe Kriterium 1.
   Proof: `node --test --test-reporter=tap test/extension.test.js | grep -E 'click_|^# (pass|fail)'`
   → die neuen Namen `ok`, `# fail 0`; `browser.tabs.scriptCalls` bleibt in den
   drei Ablehnungsfällen je `[]` bzw. ohne zweiten Eintrag. **Completed 2026-10-23**
3. **Supersede teilt den Slot der Navigation.** `extension/background.js`:
   Kommentar an `activeNavigation` („navigate or click"; der Name bleibt —
   Umbenennen ist Lärm im Diff). `clickAgentTab` ruft nach
   `clickRequestSelector` und der Tab-Auflösung dasselbe
   `supersedeActiveNavigation()` wie `navigate` und legt dann `{finish, answer}`
   in den Slot; `finish` **löst mit einem Abbruch-Marker auf** (nicht rejecten —
   `waitForTabComplete` löst auch auf, und eine unbehandelte Rejection würde die
   Suite flackernd rot machen); `waitForClickWindow` bricht damit ab (Timer weg,
   **keine** zweite Injektion). Nach dem Warten prüft der Aufruf, ob er noch
   Eigentümer des Slots ist, und antwortet sonst `superseded`; `finally` räumt
   nur, wenn der Slot noch dieser Klick ist. Neuling gewinnt:
   `click` während `click` ⇒ der ältere antwortet `superseded`; `navigate`
   während `click` ⇒ `click` antwortet `superseded`; `click` während `navigate`
   ⇒ die Navigation antwortet `complete: false`. Test (Muster
   `navigate_withTwoOverlappingRequests_shouldAnswerTheFirstWithCompleteFalseAndLeaveOneListener`):
   `click_withTwoOverlappingRequests_shouldAnswerTheFirstWithSupersededAndInjectNoRead`.
   Proof: dieser Testname `ok`, und die Zahl der `executeScript`-Aufrufe ist 2
   (Klick 1 + Klick 2), nicht 3 — der abgelöste Klick injiziert kein Lesen mehr.
   **Completed 2026-10-23**
4. **Hub: Logzeile und roter Debug-Block.** `bridge/hub.mjs`: `#ask` legt
   `params` in den Pending-Eintrag (`session.pendingRequests.set(id, { method,
   params, timeout, resolve, reject })`) — der Selektor steht nicht im Ergebnis;
   `#reportResult` bekommt den `CLICK`-Zweig; neu `formatClickLine(params,
   result)` = `click selector=… tab=… url=…` (`NO_FIELD` für alles, was kein
   String/Integer ist, Muster `formatReadLine`); Debug-Kopie wie `#reportRead`,
   aber **zwei** Felder redigiert: `{ ...result, text: "<n chars>", clicked:
   "<n chars>" }` — ein `href` kann ein Session-Token tragen; **kein**
   `#logDebugResult`. Test (Muster
   `hub_requestWithReadMethod_shouldResolveAndLogOneLineWithoutAnyPageText`):
   `hub_requestWithClickMethod_shouldLogSelectorTabAndUrlWithoutAnyPageText`.
   Proof: `node --test --test-reporter=tap test/hub.test.js | grep -E 'click selector=|^# fail'`
   → die Zeile wörtlich, `# fail 0`, und der Seitentext steht in keiner Logzeile. **Completed 2026-10-23**
5. **MCP-Werkzeug `browser_click` samt Fixture.** `bridge/mcp.mjs`:
   `BROWSER_CLICK`; vierter Eintrag in `TOOLS` (Beschreibung wörtlich aus
   `## MCP-Werkzeug`, `required:["selector"]`, `additionalProperties:false`);
   `UNEXPECTED_ARGUMENTS[BROWSER_CLICK] = "browser_click erwartet nur
   \`selector\`."`; drei Texte in `TOOL_TEXTS` (`INVALID_SELECTOR`/`NO_MATCH`/
   `NOT_CLICKABLE` als Funktionen des Selektors); `clickTool` (Muster
   `navigateTool`: fehlender/nicht-String-Selektor ⇒ `-32602`, fremde Schlüssel
   ⇒ Tabellensatz, dann `hub.request(PROTOCOL.METHODS.CLICK, {selector})`);
   `failureTextFor(toolName, error, log, params = {})` und
   `extensionFailureText(toolName, code, params = {})` bekommen den vierten
   Parameter durchgereicht — status/navigate/read übergeben nichts, ihr
   Verhalten ist unverändert. `test/fixtures/fake-extension.mjs`: `CLICK_RESULT`
   (`clicked: "a#video-title-link"`, `text: READ_RESULT.text` — kein neuer
   Seitentext im Repo), `clickResponse`, `case "click"` in `responseFor`,
   `BC_TEST_CLICK_ANSWER` in `main()` und im Kopfkommentar. Die
   **`click`-Fehlerantwort** trägt kein `via` (anders als die
   `read`-Fehlerantwort, die es bewusst führt — die bleibt unverändert). `test/mcp.test.js`: `CLICK_TOOL_DESCRIPTION`,
   `CLICK_UNEXPECTED_ARGUMENTS_TEXT`, `browserClickCall(id, selector)`,
   `CLICK_REQUEST_LINE`; **`callTool` bekommt `case BROWSER_CLICK: return
   clickTool(id, params, {hub, log})`** und **`extensionFailureText` einen
   `BROWSER_CLICK`-Zweig**: `invalid_selector`/`no_match`/`not_clickable` → die
   drei Selektor-Sätze, `no_agent_tab` → `TOOL_TEXTS.NO_AGENT_TAB`,
   `not_readable`/`read_failed` wie bei `BROWSER_READ`, alles andere →
   `CALL_EXTENSION_FAILED(code)`. Ohne diesen Zweig fiele jeder Click-Code auf
   `STATUS_EXTENSION_FAILED`.
   `mcp_toolsList_shouldOfferExactlyTheThreeToolsOfTheContract`
   → `…FourTools…` mit vierter Schema-Prüfung; **acht** `tools/call`-Fälle
   (Erfolg, fehlender Selektor, unbekanntes Argument, `invalid_selector`,
   `no_match`, `not_clickable`, `no_agent_tab`, `superseded`).
   Geändert wird damit genau **ein** gepinnter Fall in dieser Datei.
   Proof: `node --test --test-reporter=tap test/mcp.test.js | grep -E '^# (pass|fail)'`
   → `# fail 0`; `CLICK_REQUEST_LINE`-Zahl ist 0 für die abgelehnten Aufrufe, 1
   für den Erfolg. **Completed 2026-10-23**

### What could go wrong

- **Zwei Bestandsfälle müssen sich ändern**, nicht einer: der Werkzeugzahl-Fall
  in `test/mcp.test.js` **und**
  `onMessage_withUnknownMethod_shouldReplyUnsupportedMethod` in
  `test/extension.test.js`, der `click` heute als Beispiel für „nicht
  implementiert" benutzt. Beide stehen mit Begründung im Bericht; Kriterium 1
  nennt sie.
- **Kriterium 4 wird so geprüft, wie es prüfbar ist.** Die 300 ms kommen erst
  *nach* dem `click()`; im Fake-Timer-Fenster hat der abgelöste Klick längst
  geklickt. Geprüft wird deshalb: der ältere Aufruf antwortet `superseded`,
  injiziert **kein** Lesen mehr, sein Timer ist weg. „Genau ein Klick" gilt für
  den Fall, in dem der zweite Aufruf vor der Injektion eintrifft — den es nur
  mit einem Supersede-Punkt vor dem `executeScript` gäbe; der ist nicht Teil
  dieses Inkrements.
- **`about:` hat in der Klick-Antwort kein `complete`.** Die Regel aus Spec 04
  landet auf `url`/`title` (Vorher-Stand) plus leerem `text` und
  `via: "innerText"`.
- **Der Selektor wird zitiert, wie er kommt** — in den englischen Sätzen und,
  entschärft, in der Logzeile. In `formatClickLine` werden `[\r\n]+` durch ein
  Leerzeichen ersetzt: ein mehrzeiliger CSS-Selektor (`div\n a` ist gültig)
  würde sonst eine Logzeile mit Seiteninhalt vortäuschen — dieselbe Regel, die
  Spec 05 für `via` eingeführt hat. In den Fehlermeldungen bleibt der Selektor
  verbatim (ein Textblock, kein Zeilenformat).
- **`superseded` und `click_failed` haben keinen eigenen Satz** und landen im
  generischen `CALL_EXTENSION_FAILED(code)` — so verlangt es `## MCP-Werkzeug`.
  Auch ein nach dem Klick verschwundener Tab endet dort, nicht in
  `no_agent_tab` (dessen Prüfung greift nur vor der Injektion).
- **`target="_blank"` und `window.open`** lassen den Agenten-Tab stehen; die
  Antwort sieht dann wie ein wirkungsloser Klick aus (`## Risiken`:
  `element.click()` ist kein echter Klick).
- **Der Hub-Eintrag bekommt ein Feld mehr.** `params` in `pendingRequests` darf
  Timeout-, Antwort- und Close-Pfad nicht verschieben — `#takePending` und
  `#handleResponse` lesen weiter nur `method`/`timeout`/`resolve`/`reject`.

### Ordering and dependencies

1 → 2 → 3; 1 → 4; 1 → 5. Stufe 4 und 5 sind voneinander unabhängig (der
Hub-Test schickt eigene Antwortframes, der MCP-Test spawnt die Fixture) —
parallel nur in getrennten Worktrees. Nach jeder Stufe ist `npm test` grün; die
Abnahmebefehle aus `CONTRIBUTING.md` und die Kriterien 1–5 laufen vor dem Commit.
Kriterium 6 (Extension in `about:debugging` neu laden, pi neu starten,
`a#video-title-link` auf YouTube) ist Hand-over-Text für den Betreiber, keine
Stufe. `docs/06-klicken.md` schließt nur der Orchestrator ab.

### What the next increment inherits

- `browser_type` (07): braucht ein Element *und* einen Wert; `isClickable` und
  `describeElement` stecken jetzt im injizierten Snippet und sind von dort nicht
  wiederverwendbar — 07 entscheidet, ob sie in eine gemeinsame, per `toString()`
  verschickte Funktion wandern.
- Warten auf Ruhe (09) ersetzt die 300 ms; der Anschlusspunkt ist
  `waitForClickWindow` mit seinem `{settled, finish}`.
- Ein Slot für **alle** Aktionen: `type`, `screenshot`, `focus` müssen erneut
  entscheiden, ob sie ihn teilen; heute lösen sich `click` und `navigate`
  gegenseitig ab.
- Nicht dabei: Tippen, Tastatur, `focus`, Koordinaten, Hover/Scroll/Drag,
  Screenshots, Frames/Shadow DOM, `target="_blank"` verfolgen,
  `isTrusted`-Klicks, eine Sperrliste oder Rückfrage vor dem Klick, Offsets für
  `text`, und die Tabellenform statt der `if`-Ketten in
  `#reportResult`/`extensionFailureText`.

## Risiken

- **`element.click()` ist nicht dasselbe wie ein echter Klick.** Manche Seiten
  prüfen `isTrusted` oder hängen an `pointerdown`/`mouseup`. Dann passiert
  nichts, obwohl der Aufruf „geklickt" meldet. Belegt wird das durch das
  Ergebnis (`text`/`url` unverändert) — nicht durch eine Garantie.
- **300 ms sind geraten.** Sie reichen für ein SPA-Rerender, nicht für ein
  echtes Laden. Inkrement 09 („Warten auf Ruhe") ersetzt das.
- **Ein Klick kann den Betreiber ausloggen oder etwas auslösen.** Es gibt keine
  Bestätigung, keinen Trockenlauf und keine Sperrliste von Selektoren; der Agent
  klickt, was er für richtig hält, im Profil des Betreibers.
- **`no_match` ist häufig ein Zeichen für falsche Annahmen**, nicht für eine
  kaputte Seite: Selektoren, die vor einem Rerender gültig waren, greifen danach
  nicht mehr.
- **Klicks in einem Hintergrund-Tab** können von Firefox verzögert ausgeführt
  werden (Throttling). Der feste 300-ms-Blick ist dann zu früh.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine Tokens im Repo, **kein Seitentext
  in Logs, Tests, Fixtures oder Doku**.
- `extension/manifest.json` bleibt unverändert (`<all_urls>` ist da),
  `bridge/websocket.mjs` und `bridge/config.mjs` ebenso.
- `docs/PROJECT-STATE.md`, `docs/README.md`, `docs/ROADMAP.md` und `INSTALL.md`
  pflegt der Orchestrator.
- Kein Produktivcode für Inkrement 07 oder später (Tippen, Warten auf Ruhe,
  Screenshot, `focus`).

## Bekannte Lücken

Stand 2026-10-23, vor der Umsetzung:

- **Der Selektor steht verbatim in den Fehlermeldungen** (nicht in der
  Logzeile, dort sind Zeilenumbrüche ersetzt): ein sehr langer Selektor bläht
  die Meldung, ein mehrzeiliger macht sie unleserlich. Bewusst, weil der Agent
  den Selektor wiedererkennen muss.
- **`element.click()` ist kein echter Klick** (`isTrusted`, `pointerdown`): manche
  Seiten reagieren nicht, und die Antwort sieht dann wie ein wirkungsloser Klick
  aus.
- **`not_readable`/`read_failed` als Codes der Klick-Antwort** sind nicht in
  `## Wire-Protokoll` aufgezählt, sondern nur im MCP-Abschnitt; sie kommen aus
  dem Leseteil und behalten ihre Bedeutung.
- **Zwei Bestandsfälle ändern sich** (Werkzeugzahl, „unknown method"), weil das
  Inkrement ihre Voraussetzung aufhebt — siehe Kriterium 1.
- **Supersede während der ersten Injektion ist nicht im Repo gepinnt** (2026-10-23,
  Code-Review): der Reviewer hat es mit einem Wegwerf-Test nachgestellt — der
  Klick antwortet `superseded`, keine zweite Injektion, kein Timer —, aber ein
  `click_whenANavigationArrivesDuringTheFirstInjection_…` fehlt.
- **`const window = startClickWindow()`** verdeckt im Background-Scope das
  globale `window` (2026-10-23, Code-Review). Legal, weil dort niemand `window`
  braucht; bei der nächsten Berührung umbenennen.
- **`## Bekannte Lücken` in `## Wire-Protokoll`**: `not_readable`, `read_failed`,
  `superseded` und `click_failed` stehen nicht in der Code-Liste des
  Wire-Abschnitts, nur im MCP-Abschnitt — siehe die Lücke oben.

## Open questions

Keine. Entschieden vom Betreiber am 2026-10-23: Klicken ja, Tippen noch nicht.

## Review

| Runde | Datum | Verdict | Blocker |
|---|---|---|---|
| 1 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (Testtabelle vs. Kriterium 4, `no_agent_tab`-Satz, leerer Selektor, Selektoren in der Logzeile, `finish`-Reject, tote Verweise) |
| 2 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (Eigentümerschaft doppelt beschrieben, `not_readable` doppeldeutig, MCP-Zweige fehlten) |
| 3 | 2026-10-23 | ✅ Ship it | nein (fünf Ein-Satz-Korrekturen) |

## Log

Befunde beim Schreiben des Dev-Plans (2026-10-23), vom Architekten:

- **Kriterium 1 war um einen Fall zu optimistisch**: auch
  `onMessage_withUnknownMethod_shouldReplyUnsupportedMethod` benutzt `click`
  als Beispiel für „nicht implementiert" — **übernommen**: 133 unverändert,
  zwei geändert, beide benannt.
- **Kriterium 4 war in der zweiten Hälfte nicht prüfbar** („genau ein Klick"):
  im Fake-Timer-Fenster hat der abgelöste Aufruf längst geklickt — **übernommen**:
  geprüft wird `superseded`, kein zweites Lesen, kein Timer; „genau ein Klick"
  wird nicht behauptet.
- **Die `about:`-Regel paßte nicht auf die Klick-Antwort** (die hat kein
  `complete`) — **übernommen**: `url`/`title` aus dem Vorher-Stand, leerer Text.

Runde 1 des Spec-Reviews — elf Befunde, alle übernommen:

- **M1** (Testtabelle behauptete „genau ein Klick", der Plan beweist zwei) —
  **übernommen**: die Zeile sagt, was gilt (zwei `executeScript`-Aufrufe, der
  abgelöste liest nicht mehr).
- **M2** (`no_agent_tab` sollte gleichzeitig den `read`-Satz und den
  Sammelcode tragen) — **übernommen**: eigener Satz, Testzeile ergänzt.
- **M3** (leerer Selektor: Prüfung oder Seite?) — **übernommen**: jeder String
  geht in die Seite, nur fehlend/nicht-String ist `invalid_params`.
- **M4** (`not_readable`/`read_failed` fielen in den Sammelcode) —
  **übernommen**: `clickErrorFor` reicht sie durch, Testzeile.
- **M5** (tote Verweise auf `## Verhalten` und `## Bekannte Lücken`) —
  **übernommen**: Verweis umgebogen, Abschnitt `## Bekannte Lücken` angelegt.
- **M6** (Selektor verbatim in der Logzeile) — **übernommen**: `[\r\n]+` → ein
  Leerzeichen, Testzeile mit `div\n a`; in den Fehlermeldungen bleibt er verbatim.
- **M7** (Supersede griff nur im Timer-Fenster) — **übernommen**: nach dem
  Warten prüft der Aufruf die Slot-Eigentümerschaft.
- **M8** (`finish` mit Reject lud eine unbehandelte Rejection ein) —
  **übernommen**: Abbruch-Marker statt Rejection.
- **M9** (geteilter Slot stand nur im Plan) — **übernommen**: in `## Extension`.
- **Minors** — **übernommen**: `clicked`-Format festgeschrieben (`tag#id`,
  `tag.klasse`, `tag[href="…"]`, sonst Tag) und **vor** dem Klick gebaut;
  `## Ziel` nennt sieben Felder; bei `about:`-Vorher-Stand `url: ""`; Debug-Block
  kürzt auch `clicked`; Kriterium 5 prüft den Debug-Block mit; Seiten-Stub
  schreibt `title`/`location` durch; Testzeile für `invalid_params`.

Runde 2 des Spec-Reviews — fünf Befunde plus Kleinigkeiten, übernommen:

- **R2-1** (Eigentümerschaft stand an zwei Stellen verschieden: „nach dem Lesen"
  gegen „nach dem Warten") — **übernommen**: „nach dem Warten und vor der
  zweiten Injektion".
- **R2-2** (`not_readable` war gleichzeitig „geht unverändert durch" und „landet
  im Sammelcode") — **übernommen**: nur `superseded` und `click_failed` fallen
  in den Sammelcode.
- **R2-3** (Stufe 5 verdrahtete den `callTool`-Zweig und `extensionFailureText`
  nicht — jeder Code wäre auf `STATUS_EXTENSION_FAILED` gefallen) —
  **übernommen**: beide Zweige mit ihrer Zuordnung benannt.
- **R2-4** (`clicked` wurde im Plan nach dem Klick gebaut) — **übernommen**:
  die Reihenfolge steht jetzt ausdrücklich vor dem Klick.
- **R2-5** (Stufe 5 sagte „sechs `tools/call`-Fälle", die Tabelle nennt acht) —
  **übernommen**.
- **Kleinigkeiten** — **übernommen**: `## Hub` nennt die Redaktion von `clicked`,
  die Fixture-Notiz stellt klar, dass `readErrorResponse` unverändert bleibt,
  Kriterium 4 trennt MCP-Beleg und Klick-Zähler, „Noch keine Befunde." entfernt,
  die Hub-Fehlerzeile ohne Selektor begründet.

Runde 3 des Spec-Reviews — Verdict `✅ Ship it`, fünf Ein-Satz-Korrekturen übernommen:

- `## Extension` las sich als eine Injektion; jetzt „Background wartet, zweite
  Injektion liest".
- Die Testtabelle sagte „`clicked` gekürzt", der Rest sagt `clicked: "<n chars>"`
  (redigiert) — angeglichen.
- Das Feld heißt `timeout`, nicht `timer` (`#takePending`).
- Die Fall-Aufzählung in Stufe 2 sagt jetzt „unter anderem" und verschweigt die
  zwei fehlenden Testzeilen nicht mehr.
- Diese `## Review`-Tabelle trug nur Runde 1; Runde 2 und 3 stehen jetzt drin.
- Nicht geändert, nur notiert: `read_failed` hat auf der MCP-Seite keinen
  eigenen Satz — es bleibt bei „wie bei `BROWSER_READ`", dort wird keiner
  erfunden.

Code-Review Runde 1 (`grizzled-senior-dev`, 2026-10-23) — drei Blocker, alle übernommen:

- **B1** (die 300 ms liefen ab dem Request, nicht ab dem Klick) — **übernommen**:
  der Slot wird mit einem Platzhalter belegt, dann Injektion 1, dann die
  Eigentümerschaft, **dann** wird das Fenster scharf gemacht
  (`claimClickSlot().arm()`), dann Injektion 2; gepinnt durch
  `click_withASlowFirstInjection_shouldArmTheWaitOnlyAfterTheClick`.
- **B2** (die `visibility`-Prüfung war ungepinnt) — **übernommen**:
  `click_onAnElementWithVisibilityHidden_shouldAnswerNotClickableAndNotClick`.
- **B3** („`clicked` vor dem Klick" war ungepinnt) — **übernommen**:
  `click_whenTheClickDropsTheElementsIdAndClass_shouldStillDescribeItAsItWasBeforeTheClick`.
- **B4 und Q1** (billig, deshalb mitgenommen) — **übernommen**:
  `click_whenANavigationArrivesDuringTheWait_shouldAnswerSupersededAndLeaveTheNavigationWaiting`
  und eine Feldreihenfolge für beide Antwortzweige (`tabId, url, title,
  clicked, text, truncated, via`), in der Schlüsselreihenfolge gepinnt.

Code-Review Runde 1 (Schritt 6, 2026-10-23) — Verdict `🔧`, drei Blocker:

- **B1** (die 300 ms wurden vor der ersten Injektion scharf gemacht und liefen
  damit ab dem Request, nicht ab dem Klick — auf einer schweren oder
  gedrosselten Seite liest die zweite Injektion sofort) — **übernommen**:
  Reihenfolge Platzhalter-Slot → Injektion 1 → Eigentümerschaft → `arm()` →
  warten → Eigentümerschaft → Injektion 2; Test mit langsamer erster Injektion.
- **B2** (`visibility: hidden` war ungepinnt) — **übernommen**: eigener Fall.
- **B3** („`clicked` vor dem Klick" war ungepinnt) — **übernommen**: Fall, in dem
  der Klick `id`/`className` leert.
- **B4/Q1** (`navigate` während des Klicks, Feldreihenfolge) — **übernommen**,
  beides billig.

Code-Review Runde 2 (2026-10-23) — Verdict `✅ Ship it`: die drei Wächter werden
rot, wenn man die jeweilige Korrektur zurücknimmt; der Supersede-Vertrag hält in
allen drei Fenstern; die zwei erlaubten Bestandsfälle sind die einzigen
Änderungen. Drei Nachträge stehen unter `## Bekannte Lücken`.

Messlauf (2026-10-23, Kriterium 6) — erfüllt:

- **Der Sichtbarkeits- und Trefferpfad meldet ehrlich:** `a#video-title-link`
  auf der Startseite ergab `isError` mit „Kein Element passt zu:
  a#video-title-link." — kein Klick, keine stille Nichtstun. (Der Selektor
  selbst war mein Fehler im Kriterium, siehe dort.)
- **Der Klick wirkt:** `browser_click` mit `a[href*="/watch?v="]` antwortete
  `clicked: "a.ytLockupViewModelContentImage"`, `url:
  https://www.youtube.com/watch?v=<video-1>` — die Watch-Seite.
- **300 ms sind zu früh für eine SPA:** direkt nach dem Klick war der Titel noch
  „YouTube" und der Text 26 Zeichen; drei Sekunden später
  `"(369) This NEW 35B AI Model Runs on Just 3GB of Memory! - YouTube"` mit 941
  Zeichen Text (`via: "innerText"`, erster Textzeilen-Ausschnitt
  „0:00 / 9:09", „Introduction to MiniCPM"). Die Antwort ist also korrekt, aber
  der Seitentext darin ist der Stand von 300 ms — genau die Grenze, die
  Inkrement 09 („Warten auf Ruhe") schließt.
