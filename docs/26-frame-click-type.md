---
description: browser_click und browser_type adressieren einen iframe per URL-Teilstring; die Ruhe-Erkennung nach einem Klick läuft im adressierten Rahmen. Dritter Teil der Frame-Reihe (Spec 24, 25).
status: active
---

# Auch drinnen handeln: `frame` für `click` und `type`

Spec 24 macht Rahmen sichtbar (`browser_frames`) und lesbar (`browser_read`), Spec 25
macht sie abfragbar (`browser_inspect`, `browser_eval`). Was bleibt, ist das
**Handeln**: ein Formular in einem iframe ausfüllen, einen Knopf dort drücken — und
die Ruhe-Erkennung nach einem Klick, die heute im Hauptrahmen wartet, also an der
falschen Stelle.

Dieses Inkrement ist der dritte Teil der Frame-Reihe, abgetrennt von Spec 25 durch
die Teilungsregel aus `CONTRIBUTING.md` (dritter Review-Block). Es setzt Spec 24 voraus.

## Ziel

- **`frame` als optionaler Parameter** für `click` und `type` — Teilstring der
  Rahmen-Adresse, wie bei `read`, `inspect` und `eval`.
- **Der Filter ist die erste Anweisung jedes Schnipsels.** Ein nicht adressierter
  Rahmen antwortet `{outcome: "not_the_frame"}` und **tut nichts**: kein Klick, kein
  Tippen.
- **Die Ruhe-Erkennung nach `click` läuft im adressierten Rahmen.** Die
  Warte-Injektion fährt mit demselben Filter; ein `FrameError` aus ihr wird **nicht**
  zu `NO_SETTLE` geschluckt, sonst öffnet der 300-ms-Rückfall und der Fehler taucht
  später aus dem Seitenzustand auf.
- **Der Seitenzustand kommt aus dem Rahmen.** `click`/`type` antworten mit
  `url`/`title`/`text` **des Rahmens**; der `about:`-Rückfall nimmt `before` (Tab) und
  wird kommentiert, nicht repariert.
- **`type` hat keine Ruhe-Erkennung.** Es wartet mit einer festen Frist im Tab
  (`startFixedWaitWindow`) und injiziert dafür nichts; die Wartezeit bekommt keinen
  Filter. Eine Ruhe für `type` wäre ein eigener Zuschnitt.
- **Die Fehlerwahrheit von Spec 24 gilt** (`frame_not_found` mit `details.frames`,
  `frame_ambiguous` mit `details.candidates`); Injektionsfehler gewinnen, die
  Rahmenfehler gelten nur für Rahmen, die geantwortet haben.

## Non-goals

- **Kein `frame` für `navigate`, `focus`, `open_tab`, `close_tab`, `screenshot`,
  `status`**, kein Screenshot eines Rahmens, kein Index, kein Selektor-Zugang.
- **Keine Ruhe-Erkennung für `type`** (siehe `## Ziel`).
- **Keine Reparatur des `about:`-Rückfalls.**
- **Keine neue Berechtigung**, keine Änderung an `manifest.json`.

## Wire-Protokoll

`click` und `type` tragen `frame?: string`; keine neue Methode, keine neuen Codes
jenseits der beiden aus Spec 24.

## MCP-Werkzeug

`frame: {type: "string", minLength: 1}` in den Schemata von `browser_click` und
`browser_type` (vor `tab`); `CLICK_ARGUMENTS`/`TYPE_ARGUMENTS` bekommen `frame`; die
beiden `UNEXPECTED_ARGUMENTS`-Sätze nennen es; die Typprüfung ist die Inline-Form
(diese Werkzeuge haben keine `hasDeclared…`-Funktion). **Die handgebauten Nutzlasten**
(`{selector}` bzw. `{selector, text, submit}`) müssen `frame` mitkopieren — heute
fiele es dort lautlos raus.

## Extension

- `const want = frameWantedOf(params, ClickError|TypingError);` nach der
  Argumentprüfung des jeweiligen Werkzeugs.
- `clickPageSource(selector, want)`, `typePageSource(request, want)` — Filter als
  erste Anweisung; `injectPageCode(…, { allFrames: want !== null })`.
- `pageStateCode(want)` **ersetzt** die Konstante `PAGE_STATE_CODE`; `typeResult`
  geht auf `pageStateCode(want)`, `clickResult` folgt mit demselben `want`.
- `settleWindow(tabId, want = null)`, `settleAgentTab(tabId, halt, want)`,
  `settlePageCode(want)`; im Rennen bleibt die Reihenfolge `SUPERSEDED_SETTLE` →
  `NO_SETTLE` → `frameTargetOf` → `settleOutcomeOf`. Der `catch` in `settleAgentTab`
  lässt `FrameError` durch (`catch (error) { if (error instanceof FrameError) throw
  error; … }`).
- Konsumentenvertrag aus Spec 24: `frameTargetOf` liefert einen **Eintrag**, nicht
  ein Array — `clickOutcomeOf`, `typeOutcomeOf` und `pageResultOf` bekommen ihn.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `click`/`type` mit `frame` wirken im adressierten Rahmen; der Hauptrahmen behält `clicks === 0`, seinen `value` und keine `events` | Filter als erste Anweisung |
| `test/extension.test.js` | Ruhe-Erkennung nach `click` fährt mit `allFrames === true`, `frameId === undefined` und demselben Filter; die Antwort trägt `settled`/`waitedMs` des Rahmen-Eintrags, und **kein** 300-ms-Rückfall wurde armiert (`clock.pendingDelays()` leer) | keine stille Rückkehr in den Hauptrahmen |
| `test/extension.test.js` | alle Rahmen antworten in der Warte-Injektion `not_the_frame` ⇒ `error.code === "frame_not_found"`, nicht `NO_SETTLE`, nicht `click_failed` | `catch` und `clickErrorFor` reichen den Rahmenfehler weiter |
| `test/extension.test.js` | `click`/`type` mit `frame` ⇒ `url`/`title`/`text` der Antwort kommen aus dem **Rahmen** | der Seitenzustand folgt dem Rahmen |
| `test/extension.test.js` | je eine Zusicherung `frameId === 0` — `click`: `[0]` Klick, `[1]` Warte, `[2]` Seitenzustand; `type`: `[0]` Tippen, `[1]` Seitenzustand | ohne `frame` bleibt der Hauptrahmen |
| `test/mcp.test.js` | `frame` wird von `click`/`type` durchgereicht, auch in den handgebauten Nutzlasten | kein stilles Fallenlassen |
| `test/mcp.test.js` | `frame: 1` ⇒ `-32602` für beide; die zwei Frame-Sätze greifen | Typen und Texte |

## Acceptance criteria

**Ausnahme mit Datum** (2026-10-28, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 4 ist live
und nach dem Commit zu messen; **Kernannahme** ist Kriterium 4.

1. **Ohne `frame` unverändert** (lokal). `click` und `type` injizieren weiter in
   `frameId: 0`; alle bestehenden Fälle sind grün.
2. **Handeln im Rahmen** (lokal). Klick und Tippen wirken im adressierten Rahmen, der
   Hauptrahmen bleibt unverändert, und die Antwort trägt `url`/`title`/`text` des
   Rahmens.
3. **Die Ruhe-Erkennung bleibt im Rahmen und schluckt keinen Rahmenfehler** (lokal).
   Sie fährt mit demselben Filter; ein `frame_not_found` aus ihr kommt als
   `frame_not_found` an, nicht als `NO_SETTLE`.
4. **Ein echtes Formular im iframe** (live). Auf einer Seite mit einem Formular in
   einem iframe füllt `browser_type` mit `frame` das Feld im Rahmen, der Hauptrahmen
   bleibt unverändert, und `browser_read` mit demselben `frame` bestätigt den Wert.
   Die Zahlen stehen unter `## Messlauf`.
5. **Die Abnahme ist grün** (lokal). `npm test; echo $?` → `0` mit `# fail 0` **und**
   `# cancelled 0`; `npm run check; echo $?` → `0`;
   `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → keine Ausgabe, Exit 1;
   `git diff --exit-code extension/manifest.json` → 0.

## Dev plan

**Completed 2026-10-29** (Stufen 1 und 2; Stufe 3 ist der Abschluss des Orchestrators).

1. **`type`: Seitenzustand aus dem Rahmen, Wartezeit tab-weit.** `const want =
   frameWantedOf(params, TypingError);` nach `typeRequestParams(params)`;
   `typePageSource(request, want)` mit Filter als erster Anweisung, `typePageCode(request,
   want)`, `injectPageCode(…, { allFrames: want !== null })`; `typeResult(tabId, typed,
   before, want)` mit `pageStateCode(want)` und `pageResultOf(tabId,
   frameTargetOf(results, want))`; `typeOutcomeOf` bekommt den Eintrag; `typeErrorFor`
   mit `FrameError`-Zweig. Kommentar: der `about:`-Rückfall gilt `before` = Tab.
   Bridge: Schema `tools[4]`, `TYPE_ARGUMENTS`, Inline-Typprüfung für `frame`,
   Nutzlast um `frame` erweitern, `TYPE_UNEXPECTED_ARGUMENTS_TEXT`, Seam-Beweis,
   `frame: 1` ⇒ `-32602`, zwei Sätze.
   Proof: `--test-name-pattern "type_"` bzw. `"BrowserType"`.

2. **`click`: die Ruhe-Erkennung im adressierten Rahmen.** `const want =
   frameWantedOf(params, ClickError);`; `clickPageCode(selector, want)`;
   `claimPageSlot(tab.id, () => settleWindow(tab.id, want))`; `settleWindow(tabId, want
   = null)` → `settleAgentTab(tabId, halt, want)`; `settlePageCode(want)` mit Filter als
   erster Anweisung (Marker `/*bc:settle*/` bleibt im Rumpf); Warte-Injektion mit
   `{ head: false, allFrames: want !== null }`. **Der `catch` in `settleAgentTab` lässt
   `FrameError` durch** — sonst öffnet der 300-ms-Rückfall. **`clickErrorFor` bekommt
   den `FrameError`-Zweig** (wie `typeErrorFor`); ohne ihn landet der `frame_not_found`
   der Warte als `click_failed` beim Aufrufer und Kriterium 3 ist nicht erreichbar.
   `clickResult(…, want)` mit `pageStateCode(want)`.
   Bridge: Schema `tools[3]`, `CLICK_ARGUMENTS`, Nutzlast um `frame`, Seam, `frame: 1`,
   zwei Sätze.
   Proof: `--test-name-pattern "click_"` bzw. `"BrowserClick"`.

3. **Abnahme und Nachlauf — Orchestrator, nicht `ranger-1`.** Kriterien 1–3 und 5
   am Diff prüfen; die Amendments in `docs/06`, `docs/07`, `docs/24` nachziehen;
   `docs/README.md`, `docs/PROJECT-STATE.md`, `docs/ROADMAP.md`; die Spec auf
   `status: active`, die Prosa beschreibend, `## Amendments` entfernen.
   Proof: `npm test; echo $?` → 0 mit `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → 0; Secret-grep still, Exit 1;
   `git diff --exit-code extension/manifest.json` → 0.

### What could go wrong

- **Der `catch` ist geteilt.** `settleAgentTab` bedient auch `read` (Spec 24): der
  Rethrow verkürzt dessen Weg um eine Injektion — der `frame_not_found` kommt dann
  aus der Warte statt aus dem Seitenzustand, gleicher Code, ohne die
  `bc: settle wait not carried out`-Warnzeile. Der bestehende `read`-Fall bleibt
  grün, weil beide Injektionen dieselbe Rahmenzahl sehen.

- **Der Konsumentenvertrag bricht an der falschen Stelle.** `clickOutcomeOf`,
  `typeOutcomeOf` und `pageResultOf` lesen einen **Eintrag**; wer ihnen `results` gibt,
  bekommt `undefined` und einen Fehler, der wie ein Seitenfehler aussieht.
- **Die Warte-Injektion schluckt Fehler.** Ohne die `FrameError`-Ausnahme im `catch`
  verschwindet `frame_not_found` und taucht 300 ms später aus `clickResult` auf.
- **Ein Zwei-Paar-Ruhe-Fixture ist nicht baubar:** der nicht adressierte Rahmen
  antwortet `not_the_frame`; zwei echte Paare wären `frame_ambiguous`. Der Test prüft
  deshalb „Paar des Rahmens + kein Rückfall armiert".
- **Ein Klick, der seinen Rahmen entfernt**, endet bei `frame_not_found`, obwohl er
  wirkte — wie heute ein Klick, nach dem die Seite nicht lesbar ist. Kommentar.
- **`about:`-Rückfall mischt Tab und Rahmen** — entschieden, kommentiert.

### Ordering and dependencies

- Voraussetzung: Spec 24 (Stufen 1–5). Spec 25 ist **nicht** Voraussetzung.
- 1 und 2 sind unabhängig; Stufe 2 ist die einzige, die `settleAgentTab` berührt.

### What the next increment inherits

- **`type` bleibt ohne Ruhe-Erkennung.**
- **Kein `frame` für die Tab-Werkzeuge**, kein Screenshot eines Rahmens.
- **Eltern-Kind-Beziehung der Rahmen** fehlt weiter; `about:srcdoc` bleibt mehrdeutig.

## Risiken

- **Der Rückfall nach einem gescheiterten Klick** ist der heikelste Pfad: ohne die
  `FrameError`-Ausnahme antwortet der Aufruf 300 ms später mit einer falschen Ursache.
- **`PAGE_HELPERS_CODE` wächst** (Spec 25 brachte `isAddressedFrame`), der Warte-Schnipsel
  jedes Klicks trägt es mit. `PAGE_HELPERS_PIN` zieht mit.

## Touch boundary

**Der Umsetzer** fasst an: `extension/background.js`, `bridge/mcp.mjs`,
`test/extension.test.js`, `test/mcp.test.js`.

**Der Orchestrator** fasst an: `docs/06-klicken.md`, `docs/07-tippen.md`,
`docs/24-frames.md` (Rest-Aussagen), diese Spec selbst, `docs/README.md`,
`docs/PROJECT-STATE.md`, `docs/ROADMAP.md`.

**Nicht** angefasst: `extension/protocol.js`, `bridge/protocol.mjs`,
`bridge/{hub,websocket,http-transport}.mjs`, `extension/options.*`,
`extension/manifest.json`, `CONTRIBUTING.md`, `INSTALL.md`.

## Bekannte Lücken

Stand 2026-10-29, nach der Umsetzung:

- **`frameFieldsOf` steht viermal** (`readPageSource` mit `urlLimit`, `settlePageSource`,
  `clickPageSource`, `typePageSource`) — ein gemeinsamer Page-Helfer neben
  `isAddressedFrame` wäre die eine Stelle.
- **`String(location.href)` im Warte-Schnipsel ist ungekürzt** (kein `urlLimit`);
  gekappt wird erst in `cappedAddress`.
- **`frame: ""` landet beim Aufrufer als `invalid_params`-Generalsatz** — `read` hat
  dafür einen eigenen Satz, `click`/`type` nicht.
- **Kriterium 4 ist gemessen** (2026-10-29, `## Messlauf`): `type`/`click` im
  iframe, Wert im adressierten Rahmen, Gegenprobe im Hauptrahmen leer.

## Open questions

Keine offenen: Adressierung, Werkzeugliste und Fehlerverhalten sind mit Spec 24
entschieden (2026-10-27); dieses Inkrement ist der abgetrennte dritte Teil.

## Messlauf

**Gemessen am 2026-10-29** im Profil des Betreibers, Tab 7, Extension nach Reload
(Stand `2d909c5`). Seite:
`developer.mozilla.org/en-US/docs/Web/HTML/Element/input/text` — sechs
Live-Beispiele als iframes, jedes mit einem Feld `input#uname`; adressiert wurde
das Präfix `d0b8f3071e`, die Gegenprobe lief auf `6e3a7f0e05`.

| Kriterium | Befund |
|---|---|
| 2 (`type`) | `browser_type` mit `frame`, `selector: "#uname"`, `text: "RAHMEN-TEST"` ⇒ Antwort trägt `url` des **Rahmens** (`…d0b8f3071e….mdnplay.dev/…/runner.html`), kein Fehler |
| 4 (live) | `browser_eval` im adressierten Rahmen ⇒ `"RAHMEN-TEST"`; derselbe Ausdruck im **nicht** adressierten Rahmen ⇒ `""`; `browser_inspect` ohne `frame` auf `#uname` ⇒ `count: 0` (Hauptrahmen unverändert) |
| 2 (`click`) | `browser_click` mit `frame`, `selector: "#uname"` ⇒ `clicked: "input#uname"`, `url` des Rahmens, `settled: true`, `waitedMs: 1006` |
| 3 | `browser_click` mit `frame: "gibtsnicht"` ⇒ „Zu diesem `frame` passt kein Rahmen … (geantwortete Rahmen: 8)" (so die Antwort damals; englisch seit `docs/54`) — `frame_not_found`, nicht `click_failed` |
| 2 (Ruhe im Rahmen) | `browser_read` mit `frame` auf derselben Seite ⇒ `settled: true`, `waitedMs: 1003` |

**Ein Messfehler, der keiner war:** der erste `browser_type`-Versuch mit `frame`
antwortete „Kein Element passt zu: input" (so die Antwort damals; englisch seit `docs/54`), während `browser_eval` im selben Rahmen
ein Feld sah. Ursache war der **Build**: die geladene Extension stammte von vor
diesem Inkrement und ignorierte das unbekannte `frame`-Argument (pi reichte es
durch, die Extension warf es weg). Nach Extension-Reload und pi-Neustart lief
derselbe Aufruf. Kein Code-Fehler — aber ein Beleg dafür, dass ein Kriterium ohne
Reload still falsch aussehen kann.

**Nicht gemessen:** zwei gleich adressierbare Rahmen mit verschiedenem Ruhe-Paar
(im Code gepinnt, live nicht herstellbar).

## Review

### Runde 1, 2026-10-28 — `🔧 Fix these`, Blocker: ja (U1)

Neu geprüft, weil die Spec erst nach der Teilung eine eigene Runde bekommt. Die
tragenden Behauptungen am Code (`ee4c37b`): `startFixedWaitWindow(TYPE_WAIT_MS)`
und zwei Injektionen in `typeAgentTab` — „keine Ruhe für `type`" stimmt;
`PAGE_STATE_CODE:2459` mit den Verbrauchern `clickResult:2996`/`typeResult:3191` —
die Umstellung trifft genau die zwei; `frame` fällt in `clickTool:994` und
`typeTool:1038` wirklich raus; `[0]` Klick, `[1]` Warte, `[2]` Seitenzustand stimmt
für `click`, für `type` gibt es keine Warte-Injektion.

Blockierend war U1: der `catch` in `settleAgentTab:2011` ist bindungslos, und
`clickErrorFor:2770` hat keinen `FrameError`-Zweig — der `frame_not_found` der
Warte wäre als `click_failed` angekommen, Kriterium 3 unerreichbar. Dazu: der
Rethrow betrifft auch `read` (U2), der Amendments-Zeiger `docs/24:89` war die
falsche Zeile und `:75-76` fehlte (U3), die Testing-Zeile erfand `clicks === []`
und `value === null` (U4), und die Abschlussstufe des Orchestrators fehlte (U5).
Alle fünf übernommen.

Kriterium 4 bleibt zu Recht beim Betreiber; kein Test pinnt „der Klick entfernt
seinen eigenen Rahmen" fälschlich als Fehler.

Teilung aus Spec 25 (dritter Block, `CONTRIBUTING.md` Schritt 4): die Stufen 3–4 von
Spec 25 sind hierher gewandert, unverändert bis auf die Kriteriumsnummern.

## Log

Runde 1 des Code-Reviews: `🔧 Fix these` mit V1 (`click`/`type` verloren die
`frame_ambiguous`-Kandidaten, `candidates: [null, null]`) und V2 (ein Kommentar, der
genau diese Fehlerklasse verdeckte). Beide nachgearbeitet und per Mutation belegt —
ohne den `href` gehen `click_withAFrameThatMatchesTwoFrames…` und
`type_withAFrameThatMatchesTwoFrames…` rot. Mit diesen zwei Änderungen hat der
Reviewer die Freigabe zugesagt (`🔧 Fix these and I'll sign off`); die Abnahme
danach: 621 Fälle, `# fail 0`, `# cancelled 0`.

Nebenbefund aus dem Review, in `CONTRIBUTING.md` nachgezogen: `test/mcp.test.js` lief bei
60 s Grenze in die Streuung (ein korrekter Lauf endete `# cancelled 1` bei exakt
60005 ms). Budget auf 90 s gehoben (1,5 × 59 s), datiert vermerkt; die Aufteilung
der Datei nach Werkzeugfamilien steht als nächster Schritt.

## Log

Runde 1 des Spec-Reviews — alle fünf Befunde übernommen: U1 (`clickErrorFor` mit
`FrameError`-Zweig, Plus im Test der Code statt nur „nicht `NO_SETTLE`"), U2 (der
geteilte `catch` verkürzt auch `read`s Weg), U3 (Amendments-Zeiger auf
`docs/24:84-85` plus das Non-goal `:75-76`), U4 (`clicks === 0`, echter `value`,
Injektionsindizes je Werkzeug), U5 (Abschlussstufe 3 gehört dem Orchestrator, die
Touch boundary trennt die zwei Schreiber).
