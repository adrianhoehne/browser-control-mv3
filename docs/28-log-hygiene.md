---
description: Der Debug-Block auf stderr bekommt eine Whitelist je Werkzeug statt sieben verstreuter Feld-Redaktionen — ein neues Ergebnisfeld landet damit nicht mehr ungefiltert im Log.
status: active
---

# Was auf stderr darf: Log-Hygiene mit Whitelist

**Stand 2026-11-18: gebaut und abgenommen, im Rust-Port.** Die Whitelist ist
`DEBUG_WHITELIST` in `bridge-rs/src/hub.rs`, die Projektion `project` und
`debug_block_of`; die Node-Fassung `bridge/hub.mjs`, gegen die diese Spec
geschrieben wurde, ist mit `docs/38` gelöscht. Der Abschnitt unten beschreibt den
Zustand **vor** dem Inkrement (Vergangenheitsform) und die Entscheidung, die
daraus wurde.

Vor diesem Inkrement redigierten **vier** der sieben `#report…`-Zweige in `bridge/hub.mjs` selbst ({...result,
text: "<n chars>"}); die anderen drei hatten gar keine Sperrliste, sie hatten nur Glück. (Nachgezählt am 2026-10-29: **sieben** Zweige schrieben einen
Debug-Block, **vier** waren bewusst stumm — `open_tab`, `close_tab`, `eval`,
`screenshot`; `frames` hatte gar keinen Zweig.) Das war eine **Sperrliste** — sie zählte, was ersetzt wird.
Kam ein Ergebnisfeld hinzu (so wie in den letzten acht Inkrementen ständig),
erschien es automatisch ungefiltert auf stderr: Seiteninhalt, `href` mit
Sitzungsschlüssel, was auch immer. Roadmap 18 hat die Richtung umgedreht.

## Ziel

- **Eine Whitelist je Methode** an **einer** Stelle: für jedes Werkzeug steht dort,
  welche Ergebnisfelder im Debug-Block vollständig gedruckt werden dürfen (Zahlen,
  Kennungen, Formen) und welche nicht.
- **Alles, was nicht auf der Liste steht, wird nicht gedruckt.** Ein Feld, das
  niemand eingetragen hat, erscheint als Marker (Vorschlag: `"<unlisted field>"`),
  nicht mit Inhalt und nicht mit Länge — die Länge selbst kann in einem kurzen Feld
  den Inhalt verraten.
- **Seiteninhalt bleibt Länge.** `text`, `href`, `id`, `ariaLabel`,
  `selector`, `classes`, `clicked`, `typed` — was heute schon als `<n chars>`
  erscheint, bleibt so; die Whitelist entscheidet das, nicht mehr der Zufall, dass
  jemand die Zeile geschrieben hat. **`title` wird neu zur Länge** (in sechs Blöcken;
  in `status` bleibt er voll, siehe `## Risiken`) — heute erscheint er dort vollständig.
- **Die bekannten Logzeilen ändern sich nicht.** Die Zeilen `read tab=… chars=…`,
  `click …`, `inspect …` usw. sind ein eigenes, gepinntes Format und bleiben
  unangetastet; dieses Inkrement betrifft **nur** den Debug-Block
  (`logLevel: "debug"`).
- **Ein Test beweist die Richtung.** Ein künstliches Ergebnisfeld, das kein Mensch
  eingetragen hat, darf im Debug-Block nicht auftauchen — heute täte es das.

## Non-goals

- **Kein eigener Debug-Block für `open_tab`, `close_tab`, `eval`, `screenshot`** — die
  bleiben stumm, wie seit Spec 19/20/21 entschieden (ein Block für `eval` bräuchte
  zuerst eine Form-Regel für beliebiges Seiten-JSON).
- **Keine Änderung an den Logzeilen** (Format, Felder, Reihenfolge).
- **Keine Änderung an `BC_LOG_LEVEL`** oder daran, wann der Debug-Block läuft.
- **Kein Log-Rotations-/Datei-Thema** — stderr bleibt stderr.
- **Keine neue Abhängigkeit**, keine Änderung an `manifest.json`.

## Wo die Änderung sitzt

**Heute:** `bridge-rs/src/hub.rs` — `DEBUG_WHITELIST` (sieben Methodeneinträge,
Schlüssel sind die Protokollnamen) und `debug_block_of`, das über `project` und
`apply_rule` die vier Regeln `Full`, `Length`, `LengthEach`, `Shape` anwendet
und für eine Methode ohne Eintrag `None` liefert.

**Damals, gegen diesen Text gebaut:** `bridge/hub.mjs`. Sieben `#report…`-Zweige mit Debug-Block, jeder mit eigener Sperrliste und
teils eigenem `#logDebugResult`. Danach: **eine** Funktion `debugBlockOf(method, result)` und **eine** Tabelle `DEBUG_WHITELIST` (je Werkzeug: Feld → `full` |
`length` | `lengthEach` | `shape`; auf `drop` wird verzichtet, es hätte heute keinen
Nutzer). Die sieben `#report…`-Zweige riefen nur noch diese Funktion; die
Redaktionshelfer (`redactedPageString`, `inspectDebugResult`,
`REDACTED_INSPECT_ELEMENT_FIELDS`) gingen in der Tabelle auf.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/hub.test.js` | jeder der **sieben** Blöcke enthält genau die **vorhandenen** Whitelist-Felder in Tabellenreihenfolge (gelistete, aber fehlende Felder erscheinen nicht); die **vier** stillen Pfade (`open_tab`, `close_tab`, `eval`, `screenshot`) schreiben keinen Block | die Tabelle ist die einzige Wahrheit |
| `test/hub.test.js` | ein erfundenes Ergebnisfeld (`"surpriseField": "geheim"`) ⇒ erscheint als `"<unlisted field>"`, weder Inhalt noch Länge | Richtungsumkehr: unbekannt heißt weg |
| `test/hub.test.js` | `read` mit Seitentext ⇒ Debug-Block trägt `<n chars>`, der Text nicht | Seiteninhalt bleibt draußen |
| `test/hub.test.js` | `inspect`-Treffer mit `href`/`ariaLabel`/`classes` ⇒ Längen, nicht Werte | die alte Regel überlebt in der Tabelle |
| `test/hub.test.js` | die bestehenden Zusicherungen zu den Logzeilen (`read`, `click`, `type`, `focus`, `navigate`, `status`, `screenshot`, `eval`) bleiben **unverändert grün**; der Diff-Beweis in Stufe 4 zeigt zusätzlich, dass kein `format…Line`-Rumpf angefasst wurde | dieses Inkrement fasst sie nicht an |
| `test/hub.test.js` | `logLevel: "info"` ⇒ gar kein Debug-Block | der Schalter bleibt der Schalter |

## Acceptance criteria

**Ausnahme mit Datum** (2026-10-29, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 5 ist live
und nach dem Commit zu messen; **Kernannahme** ist Kriterium 2. Gemessen wurde es
am 2026-11-18 **ohne Browser** (`## Messlauf`): die Whitelist hält über den
echten Transport, der Haken für `browser_read` **und `browser_inspect` an einer
echten Seite** bleibt beim Betreiber.

1. **Ein Ort** (lokal). Die sieben `#report…`-Zweige enthalten keine eigene
   Feld-Redaktion mehr; `DEBUG_WHITELIST` ist die einzige Stelle, die entscheidet.
2. **Unbekannte Felder erscheinen nicht** (lokal). Ein Ergebnisfeld, das nicht in
   der Tabelle steht, wird als `"<unlisted field>"` gedruckt — nicht mit Inhalt,
   nicht mit Länge.
3. **Bekanntes Verhalten bleibt** (lokal). Alle bestehenden `test/hub.test.js`-Fälle
   zu Debug-Blöcken sind grün, angepasst nur dort, wo ein Feld neu als `length`
   statt `full` geführt wird; die Logzeilen sind zeichengleich.
4. **Die Abnahme ist grün** (lokal). `npm test` (mit `# fail 0` **und**
   `# cancelled 0`), `npm run check`, Secret-grep, `manifest.json` unverändert.
5. **Ein echter Lauf mit `debug`** (live). Der Dienst mit `BC_LOG_LEVEL=debug`, ein
   `browser_read` und ein `browser_inspect` auf einer echten Seite; im stderr steht
   kein Seiteninhalt — nur Längen, Kennungen und der Marker für Unbekanntes.

## Dev plan

**Completed 2026-10-30** (alle vier Stufen; E1, die Doku-Verweise auf die
gelöschten Helfer, die Amendments und die Live-Messung folgten in der
Schlussstufe am 2026-11-18 — siehe `## Log`).

**Befund vor dem Bau** (in `bridge/hub.mjs` gelesen, nicht geschätzt): `PROTOCOL.METHODS` kennt **zwölf** Methoden, `#reportResult` (`:638`) hat **elf** Zweige — `frames` hat gar keinen. Von den elf schreiben **sieben** einen Debug-Block: `status` (`:698`), `navigate` (`:705`), `focus` (`:779`) über `#logDebugResult` (`:845`), und `read` (`:716`), `click` (`:728`), `type` (`:754`), `inspect` (`:790`) mit eigener Kopie. **Vier** schreiben bewusst keinen: `open_tab` (`:804`), `close_tab` (`:816`), `eval` (`:828`), `screenshot` (`:841`). Die Spec-Zeile „sechs `#report…`-Zweige" zählt also die alten Sperrlisten, nicht die Zweige — die vier stillen Zweige bleiben stumm (§ `#reportEval`-Kommentar, Spec 19/20). `logLevel` wird heute an **fünf** Stellen mit `this.#config.logLevel === "debug"` geprüft (`:715`, `:730`, `:756`, `:792`, `:846`); `#log(message)` ist der injizierte Schreiber, ein Block ist **eine** Message mit Zeilenumbrüchen.

Die Tabelle ist eine, die Funktion ist eine — für **alle** sieben Blöcke. Nur zwei Ergebnisse sind nicht flach (`status`: `windows[].tabs[]`, `inspect`: `elements[]`), und beide sind „Objekt oder Liste von Objekten mit diesen Feldern"; das ist **eine** Regel `shape` in der Tabelle, kein Sonderfall pro Werkzeug. Ein Sonderfall bräuchte nur `eval` (sein `result` ist beliebiges JSON, kein String), und genau deshalb bleibt `eval` blocklos — die Funktion muss das nicht können.

1. **Tabelle + Funktion + Einheitstests, noch keine Verdrahtung.** In `bridge/hub.mjs` neu: `FULL`/`LENGTH`/`LENGTH_EACH`/`UNLISTED`, `shapeOf(fields)`, `const DEBUG_WHITELIST` und `export function debugBlockOf(method, result)` (liefert den fertigen Text aus `JSON.stringify(projectShape(result, table), null, 2)`, oder `null`, wenn die Methode keinen Eintrag hat). Schlüssel sind die **Methoden**namen (`[PROTOCOL.METHODS.READ]`), nicht `browser_read`: `hub.mjs` sieht den MCP-Namen nie. Signatur ohne `params` — kein Block druckt heute ein Anforderungsfeld. Regeln: `full` = Wert wie angekommen; `length` = String wird `<n chars>`, `null` bleibt `null`, alles andere wird `UNLISTED`; `lengthEach` = Liste von Strings, Eintrag für Eintrag; `shape` = Objekt mit diesen Feldern bzw. Liste davon, Feld für Feld. Reihenfolge ist die Tabellenreihenfolge, nicht gelistete Felder des Ergebnisses hängen **hinten** an, mit ihrem Schlüssel und dem Wert `"<unlisted field>"` (der Schlüssel bleibt, nur der Wert wird ersetzt — zwei Unbekannte kollidieren nicht); gelistete, aber fehlende Felder erscheinen nicht (kein `null` erfinden). Ergebnis, das kein Objekt ist, wird als JSON gedruckt (`null` bleibt `null`).

   ```js
   const DEBUG_WHITELIST = Object.freeze({
     // Byte-gleich mit Absicht: test/bridge.test.js (`INDENTED_RESULT_LINES`) und
     // test/mcp.test.js (`:4193`) pinnen genau diesen Block gegen die Fixture.
     [PROTOCOL.METHODS.STATUS]: {
       extension: shapeOf({ version: FULL, connectedAt: FULL }),
       windows: shapeOf({
         id: FULL, focused: FULL, type: FULL,
         tabs: shapeOf({ id: FULL, active: FULL, pinned: FULL, agent: FULL, url: FULL, title: FULL }),
       }),
     },
     [PROTOCOL.METHODS.NAVIGATE]: { tabId: FULL, windowId: FULL, url: FULL, title: LENGTH, complete: FULL, settled: FULL, waitedMs: FULL },
     [PROTOCOL.METHODS.READ]: { tabId: FULL, url: FULL, title: LENGTH, text: LENGTH, offset: FULL, chars: FULL, totalChars: FULL, truncated: FULL, via: FULL, mode: FULL, root: FULL, fellBack: FULL, settled: FULL, waitedMs: FULL },
     [PROTOCOL.METHODS.CLICK]: { tabId: FULL, url: FULL, title: LENGTH, clicked: LENGTH, text: LENGTH, truncated: FULL, via: FULL, settled: FULL, waitedMs: FULL },
     [PROTOCOL.METHODS.TYPE]: { tabId: FULL, url: FULL, title: LENGTH, typed: LENGTH, submitted: FULL, text: LENGTH, truncated: FULL, via: FULL },
     [PROTOCOL.METHODS.FOCUS]: { tabId: FULL, windowId: FULL, url: FULL, title: LENGTH, active: FULL, focused: FULL },
     [PROTOCOL.METHODS.INSPECT]: {
       tabId: FULL, url: FULL, title: LENGTH, count: FULL, truncated: FULL,
       elements: shapeOf({ index: FULL, selector: LENGTH, tag: FULL, id: LENGTH, classes: LENGTH_EACH, text: LENGTH, href: LENGTH, ariaLabel: LENGTH, visible: FULL, disabled: FULL, rect: shapeOf({ x: FULL, y: FULL, width: FULL, height: FULL }) }),
     },
     // Ohne Eintrag und damit blocklos: eval (Ergebnis ist beliebiges Seiten-JSON, Spec 19),
     // screenshot (base64 ist das Bild, Spec 20/21), open_tab/close_tab (die Zeile ist der
     // ganze Bericht), frames (hat gar keinen Zweig).
   });
   ```

   Die Feldinhalte stammen aus `extension/background.js` (die Fixture ist hinterher: `READ_RESULT` fehlt `offset`/`chars`/`totalChars`/`mode`/`root`/`fellBack`, `STATUS_RESULT`s Tabs fehlen `agent`) — `pageResultOf` (`:2595`) und `readAgentTabPage` (`:1942`, `{...page, ...settle}` — daher `settled`/`waitedMs` am Ende des `READ`-Eintrags), `inspectResultOf` (`:3647`), `toTabSummary` (`:773`), `navigationResult` (`:965`), `clickResult` (`:3040`), `typeResult` (`:3269`), `evalResultOf` (`:4670`), `SCREENSHOT_RESULT`. Neue Fälle in `test/hub.test.js` (Import `debugBlockOf` ergänzen): `debugBlockOf_withAKnownMethod_shouldPrintExactlyTheWhitelistedFieldsInTableOrder`, `debugBlockOf_withAnUnlistedField_shouldPrintTheMarkerInsteadOfValueAndLength`, `debugBlockOf_withAnUnlistedFieldInsideAnElement_shouldPrintTheMarkerThere`, `debugBlockOf_withAMethodWithoutATableEntry_shouldReturnNull` (für `eval`, `screenshot`, `open_tab`, `close_tab`, `frames` und eine erfundene Methode), `debugBlockOf_withALengthFieldCarryingANonString_shouldPrintTheMarkerAndKeepNull`.
   Proof: `node --test --test-name-pattern=debugBlockOf test/hub.test.js` endet mit `# fail 0`; `npm test` bleibt unverändert grün (die Funktion ist noch unbenutzt).

2. **`read` als Muster verdrahten.** Neuer privater Helfer `#logDebugBlock(method, result)`: einzige Stelle mit `logLevel`-Prüfung, ruft `debugBlockOf` und schreibt nur, wenn das Ergebnis nicht `null` ist. `#reportRead` (`:713`) verliert sein `JSON.stringify({...result, text: …})` und ruft `this.#logDebugBlock(PROTOCOL.METHODS.READ, result)`; `pageTextCharCount` bleibt (die Zeile `formatReadLine` braucht sie), die Zeile selbst bleibt zeichengleich.
   Tests: `hub_requestWithReadMethod_shouldResolveAndLogOneLineWithoutAnyPageText` (`:421`) verschärfen — `Object.keys(JSON.parse(debugEntry))` gegen die Tabellenreihenfolge, `title` als `<n chars>`; neu `hub_requestWithReadMethodAndAForeignFieldUnderDebugLogging_shouldPrintTheMarkerAndNotTheValue` (Ergebnis mit `surpriseField: "geheim"` ⇒ Block trägt `"<unlisted field>"`, der Block trägt `"surpriseField": "<unlisted field>"`, und das Log enthält `geheim` nicht); neu `hub_requestWithReadMethodUnderInfoLogging_shouldWriteNoDebugBlock` (ohne `BC_LOG`, jede `logLines`-Message beginnt nicht mit `{`).
   Proof: `node --test --test-name-pattern="ReadMethod" test/hub.test.js` ⇒ `# fail 0`.

3. **Die vier flachen Blöcke.** `#reportNavigate` (`:703`), `#reportClick` (`:728`), `#reportType` (`:754`), `#reportFocus` (`:777`) rufen nur noch `#logDebugBlock`; `clickedCharCount` (`:155`), `elementDescriptionCharCount` (`:190`) und der letzte Aufrufer von `#logDebugResult` in diesen Zweigen fallen weg (`#logDebugResult` selbst erst in Stufe 4, `status` ruft es noch). Die `format…Line`-Funktionen werden **nicht angefasst**.
   Tests: `hub_withDebugLogging_shouldLogTheNavigateLineAndTheIndentedResult` (`:375`) und `hub_requestWithFocusMethod_shouldLogOneLineWithoutUrlAndTheWholeDebugResult` (`:840`, umbenennen: „…_shouldLogOneLineAndOnlyTheWhitelistedFields") — das `deepEqual(JSON.parse(debugEntry), result)` wird zum Vergleich gegen das erwartete Blockobjekt mit `title` als Länge; `hub_requestWithClickMethodUnderDebugLogging_…` (`:627`) und `hub_requestWithTypeMethodUnderDebugLogging_…` (`:774`) bekommen die exakte Schlüsselliste.
   Proof: `node --test --test-name-pattern="NavigateMethod|ClickMethod|TypeMethod|FocusMethod" test/hub.test.js` ⇒ `# fail 0`.

4. **Die zwei verschachtelten Blöcke, dann die alten Helfer weg.** `#reportStatus` (`:696`) und `#reportInspect` (`:790`) rufen `#logDebugBlock`; `#logDebugResult` (`:845`), `inspectDebugResult` (`:296`), `redactedInspectElement` (`:309`), `REDACTED_INSPECT_ELEMENT_FIELDS` (`:307`) und `redactedPageString` (`:322`) werden gelöscht. `status` muss **byte-gleich** bleiben (Tabellenreihenfolge = Fixture-Reihenfolge, `title`/`url` dort `FULL`).
   Tests: `hub_withDebugLogging_shouldLogTheStatusLineAndTheIndentedResult` (`:348`) verschärfen auf `assert.equal(jsonLine, JSON.stringify(result, null, 2))`; `hub_requestWithInspectMethodWithDebugLog_shouldRedactEveryPageString` (`:1353`) — `debugBlock.title` wird `<${result.title.length} chars>` (die Zahl aus dem Ergebnis nehmen, nicht hinschreiben), `url` bleibt voll; ein Fall mit `surpriseField` im Element kommt dazu. Unangetastet und damit der Beweis für „kein Eintrag = kein Block": `hub_requestWithOpenTabMethod…` (`:885`), `hub_requestWithCloseTabMethod…` (`:922`), `hub_eval_shouldLogOnlyTabElapsedAndOk` (`:1478`), `hub_screenshot_shouldLogExactlyOneLineAndNoBase64EvenAtTheDebugLevel` (`:1609`).
   Proof: `node --test test/bridge.test.js test/hub.test.js` ⇒ `# fail 0` (bridge pinnt den Status-Block von außen), dann die Abnahme aus `CONTRIBUTING.md`: `npm test; echo $?` mit `# fail 0` **und** `# cancelled 0`, `npm run check; echo $?` = 0, Secret-grep ohne Ausgabe, `git status --porcelain extension/manifest.json` leer. Zusätzlich: `grep -n 'logLevel === "debug"' bridge/hub.mjs` ⇒ genau **eine** Zeile; `git grep -nE 'function (inspectDebugResult|redactedInspectElement|redactedPageString|clickedCharCount|elementDescriptionCharCount)\b|const REDACTED_INSPECT_ELEMENT_FIELDS|^  #logDebugResult' -- bridge/hub.mjs` ⇒ keine Ausgabe, Exit 1 (die Kommentare der stillen Zweige werden im selben Zug umgeschrieben: ‚kein `DEBUG_WHITELIST`-Eintrag‘ ist der ehrlichere Grund); `git diff bridge/hub.mjs | grep -E '^[-+].*(format[A-Za-z]*Line|singleLine|textSource|inspectCount)'` ⇒ keine Ausgabe (Logzeilen samt Rümpfen unberührt).

### Wer die Schlussstufe macht

**Der Orchestrator, nicht `ranger-1`:** Kriterien 1–4 am Diff prüfen, die Amendments
in `docs/05`, `docs/07`, `docs/08`, `docs/09` nachziehen, `docs/README.md`,
`docs/PROJECT-STATE.md`, `docs/ROADMAP.md` pflegen, die Spec auf `status: active`
stellen, die Prosa beschreibend machen und `## Amendments` entfernen. Kriterium 5
hakt der Betreiber ab.

### What could go wrong

- **Der `status`-Block ist außerhalb der Touch-Boundary byte-genau gepinnt.** `test/bridge.test.js:70-71,380,394` (`INDENTED_RESULT_LINES`, Zeile für Zeile) und `test/mcp.test.js:4193,4202` verlangen `JSON.stringify(STATUS_RESULT, null, 2)`. Jede andere Feldmenge, jede andere Reihenfolge und jedes `title` als Länge machen `npm test` rot, und der Umsetzer darf diese zwei Dateien nicht anfassen (Kriterium 4 verlangt trotzdem `# fail 0`). Deshalb ist `status` der einzige Eintrag mit `url` **und** `title` als `full`. Wer das angleichen will, braucht vorher eine breitere Boundary — Entscheidung des Orchestrators, nicht des Umsetzers.
- **`title` ist heute nirgends Länge.** Die Spec sagt „text, title, href … was heute schon als `<n chars>` erscheint, bleibt so" — für `title` stimmt das nicht: `status`, `navigate`, `focus` und `inspect` drucken ihn voll (`inspectDebugResult`-Kommentar `:284`). Dieser Plan macht ihn in den sechs Blöcken zur Länge (Spec-Absicht) und lässt ihn in `status` voll (siehe oben). Kosten: drei bestehende Fälle ändern sich (`:375`, `:840`, `:1419`) — genau die in Kriterium 3 erlaubte Art. Der Nutzen: ein Seitentitel hat keine Logzeile, hinter der er sich verstecken könnte (`formatOpenTabLine`-Kommentar `:225`).
- **`url` bleibt `full`, auch wenn er Query-Parameter trägt.** Sechs der elf Zeilen drucken dieselbe Adresse unmittelbar davor voll (`read tab=42 url=…`); sie im Block zu kürzen wäre Theater und würde dem Betreiber die einzige Stelle nehmen, an der er die Adresse im Block sieht. Restrisiko (Session-Parameter in der Adresse) ist älter als dieses Inkrement und steht in den Zeilen-Formaten von Spec 05/06 — nicht hier umdrehen.
- **Falsch eingetragene Felder schützt kein Test.** Kriterium 2 fängt nur *neue* Felder. Die zwei Stellen, an denen das heute weh täte, sind `eval.result` und `screenshot.base64`; beide haben bewusst keinen Eintrag und keinen Block. Wer ihnen je einen Block gibt, braucht für `result` eine reine Form-Regel (Typ/Länge), die es nicht gibt — dann ist eine neue Spec fällig, keine Zeile in der Tabelle.
- **`length` auf einem Nicht-String.** `redactedPageString` gab bisher alles Nicht-String durch (Fixtures `ariaLabel: null`). Der Plan hält `null` als `null` (die Aussage „kein aria-label" ist wertvoll) und macht aus jedem anderen Nicht-String den Marker. Kein Test in `test/hub.test.js` hängt an der alten Durchreiche; die Fixture-`null` läuft nur auf `info`.
- **Struktur ist nicht fälschbar, Inhalt schon.** Der Block entsteht in einem `JSON.stringify`, ein eingeschmuggeltes `\n` bleibt als `\\n` im String und kann keine zweite Zeile forgen (anders als eine Logzeile, die `singleLine`/`textSource` braucht). Nicht auf String-Verkettung umbauen.
- **Vier stille Zweige sind Absicht, kein Vergessen.** `open_tab`, `close_tab`, `eval`, `screenshot` und `frames` bekommen keinen Tabelleneintrag; `debugBlockOf` liefert dort `null`. Das ist die einzige Stelle, an der „unbekannt" *nichts* druckt statt eines Markers — bei einer unbekannten *Methode* gibt es keinen einzigen als sicher eingetragenen Feldschlüssel, ein Marker-Block wäre also nur Rauschen. Diese Asymmetrie gehört als Kommentar an die Tabelle, sonst liest sie sich wie eine Lücke in der Richtungsumkehr.
- **Testnamen lügen sonst.** `hub_requestWithFocusMethod_shouldLog…TheWholeDebugResult` beschreibt nach Stufe 3 nicht mehr, was der Fall prüft — im selben Diff umbenennen.

### Ordering and dependencies

Stufen 1 → 2 → 3 → 4, jede für sich grün; keine Stufe braucht eine spätere. Stufe 1 ist verhaltensfrei (die Funktion ist noch unbenutzt), deshalb bleibt `npm test` dort grün und der Review kann Tabelle und Projektion isoliert lesen. `read` kommt als Muster zuerst, weil es die kleinste Form ist (flach, kein Zusatzfeld außer `text`) und sein Debug-Fall bereits existiert. Die vier flachen Blöcke danach in **einer** Stufe: ihre Fälle existieren schon und sind der Beleg, eine weitere Teilung ergäbe Stufen ohne eigenen Beweis. `status` und `inspect` zuletzt, weil sie die einzige neue Logik (Verschachtelung) und das einzige Byte-Pin außerhalb der Boundary tragen; `#logDebugResult` und `inspectDebugResult` sterben erst hier, weil `status` sie bis dahin benutzt. Nicht umsortieren: die Helfer vor dem letzten migrierten Zweig zu löschen lässt einen halb roten Testlauf zurück. `#reportResult` (`:638`) bleibt in Zweigen und `return`s unverändert (der fehlende `return` ist der Spec-08-Verlust, Kommentar `:666`) — nur die Rümpfe der sieben Berichtsmethoden ändern sich.

### What the next increment inherits

- **`status` behält `url` und `title` in voller Länge**, bis `test/bridge.test.js` und `test/mcp.test.js` angefasst werden dürfen. Ein Folgeinkrement „einheitliche Titel-Länge" muss diese zwei Dateien mitnehmen und die Boundary ausdrücklich erweitern.
- **`title`/`url`-Entscheidung ist pro Werkzeug, nicht global.** Das ist Absicht (die Tabelle ist je Werkzeug), sieht aber wie eine Inkonsistenz aus; wer sie auflöst, ändert das Byte-Pin.
- **`drop` gibt es nicht.** Die Spec nennt `full` | `length` | `drop`; gebraucht werden `full`, `length`, `lengthEach` und `shape`. `drop` hätte heute keinen einzigen Nutzer (`eval.result` und `screenshot.base64` liegen in blocklosen Methoden), und eine ungenutzte Regel ist toter Code. Wenn der Betreiber `drop` will, ist es eine Zeile in `applyRule`.
- **`eval` und `screenshot` bleiben ohne Debug-Block** (Spec 19/20/21). Ein Block für `eval` braucht zuerst eine Regel für beliebiges JSON — nicht in diesem Inkrement.
- **`frames` hat weiterhin keinen `#report`-Zweig** und damit keine Zeile und keinen Block; ein Tabelleneintrag allein würde nichts drucken.
- **Keine neuen Abhängigkeiten, kein `manifest.json`, keine Änderung an `BC_LOG_LEVEL` oder an den Logzeilen.** Sichtbare Folge für den Betreiber: ab jetzt kann ein neues Ergebnisfeld nicht mehr stillschweigend auf stderr landen — es erscheint als `"<unlisted field>"`, und das Eintragen ist eine bewusste Zeile in `DEBUG_WHITELIST`.

## Open questions

**Keine.** Entschieden vom Betreiber am 2026-10-29:

1. **Unbekannte Felder erscheinen als `"<unlisted field>"`**, nicht weglassen — sonst
   sieht ein neues Feld aus wie „gibt es nicht". Der **Schlüssel bleibt**, ersetzt
   wird nur der Wert.
2. **Eine Tabelle `DEBUG_WHITELIST` je Methode** ist die einzige Entscheidungsstelle.
3. **Der Debug-Block darf seine Form ändern** — er ist Text für den Betreiber, kein
   Vertrag; `title` wird in den sechs redigierenden Blöcken zur Länge, in `status`
   bleibt er voll (Grund unter `## Risiken`).
4. **Kriterium 5 hakt der Betreiber ab** (Live-Messung im eigenen Profil).
## Amendments to previous spec docs

**Alle Zeilen am 2026-11-18 nachgezogen** — die Nummern links sind die alten
Fundstellen; gesucht und geändert wurde im heutigen Text (die Zeilennummern
waren durch spätere Inkremente verschoben, `docs/ROADMAP.md` zum Beispiel von
`:69` auf `:87`). Jede Zelle nennt links die Fundstelle von damals und rechts,
was dort heute steht.

| Datei | Stellen | neu |
|---|---|---|
| `docs/05-seiteninhalt-lesen.md` | `:190`–`:196` (Logzeile, „keine Inhalte", und der Satz „`status`/`navigate`, wo der Debug-Block das Ergebnis zeigt"), `## Bekannte Lücken` (Sperrliste), `:422` (`#logDebugResult` in „What could go wrong") | der Debug-Block ist eine Whitelist; `title` ist dort Länge; die Sperrliste ist als geschlossen markiert |
| `docs/08-fokus.md` | `:93`–`:95` („das ganze Ergebnis"), `:123` (Testing-Zeile) | der Block zeigt die Whitelist, `title` als Länge |
| `docs/09-dom-abfrage.md` | `:129` („`url`, `title` bleiben"), `:345` (Stufe 3 des Dev-Plans) | `title` ist Länge; alles andere bleibt |
| `docs/07-tippen.md` | `:538`–`:541` (Falle: `title` im Debug-Block trägt den getippten Text) | die Falle ist für `title` geschlossen — es erscheint als Länge; die `url` bleibt voll |
| `docs/ROADMAP.md` | `:69` (Zeile 18), `:48` (`Gemacht`-Tabelle) | erledigt |

## Risiken

- **Der `status`-Block ist außerhalb der Umsetzer-Boundary byte-genau gepinnt.**
  `test/bridge.test.js` und `test/mcp.test.js` verlangen `JSON.stringify(STATUS_RESULT,
  null, 2)` Zeile für Zeile. *(Seit dem Rust-Port: `bridge-rs/tests/hub.rs`,
  `hub_withDebugLogging_shouldLogTheStatusLineAndTheIndentedResult`, plus
  Paritätsvergleich 7 — die zwei Node-Dateien sind mit `docs/38` gelöscht.)*
  Deshalb ist `status` der einzige Eintrag, in dem `url`
  **und** `title` vollständig erscheinen — jede andere Wahl macht `npm test` rot, ohne
  dass der Umsetzer die Datei anfassen darf. Ein Folgeinkrement „einheitliche
  Titel-Länge" muss diese zwei Dateien mitnehmen und die Boundary erweitern.
  (Nachgetragen 2026-10-29 nach dem Dev-Plan.)

- **Der Debug-Block wird unleserlicher**, wenn zu viele Felder als Länge erscheinen.
  Die Tabelle muss großzügig `full` vergeben, wo es sicher ist (Zahlen, `tabId`,
  `count`, `truncated`, `settled`, `waitedMs`), sonst verliert der Betreiber sein
  Werkzeug.
- **Sieben Aufrufstellen umzubauen** heißt, sieben Verhalten zu vergleichen; die
  bestehenden Debug-Fälle in `test/hub.test.js` sind dabei der Beleg, nicht die
  Behauptung.
- **Ein Feld, das heute `full` ist und Inhalt trägt, wird als sicher eingetragen.**
  Die Tabelle ist eine Entscheidung, die man begründen muss — der Test mit dem
  erfundenen Feld schützt nur gegen *neue*, nicht gegen *falsch eingetragene*.

## Touch boundary

**Der Umsetzer** fasst an: `bridge/hub.mjs`, `test/hub.test.js`. *(Historisch —
das war der Bau vom 2026-10-30. Im heutigen Baum heißen die zwei Dateien
`bridge-rs/src/hub.rs` und `bridge-rs/tests/hub.rs`; `bridge/hub.mjs` und
`test/hub.test.js` sind mit `docs/38` gelöscht.)*

**Der Orchestrator** fasst an: diese Spec, `docs/05-seiteninhalt-lesen.md`, `docs/07-tippen.md`, `docs/08-fokus.md`, `docs/09-dom-abfrage.md`,
`docs/README.md`, `docs/PROJECT-STATE.md`, `docs/ROADMAP.md`.

**Nicht angefasst:** `bridge/mcp.mjs`, `bridge/{websocket,http-transport}.mjs`,
`extension/**`, `CONTRIBUTING.md` — **und `test/bridge.test.js` sowie `test/mcp.test.js`**,
weil dort der `status`-Block byte-genau gepinnt ist (siehe `## Risiken`).

## Bekannte Lücken

Stand 2026-11-18, gegen den Rust-Port geprüft (`bridge-rs/src/hub.rs`,
`bridge-rs/tests/hub.rs`). Von den fünf Lücken des ersten Baus sind drei mit dem
Port entfallen, zwei gelten weiter.

- **Ein Ergebnis, das kein Objekt ist, druckt `project` unverändert.** *Gilt
  weiter.* `project` gibt für alles außer einer Map den Wert zurück, wie er kam
  (Liste, Skalar, `null`), und `debug_block_of` schreibt ihn als JSON. Das ist
  als Lücke gepinnt, nicht als Zusage:
  `debugBlockOf_withAResultThatIsNoObject_shouldPrintItAsItArrived`
  (`bridge-rs/tests/hub.rs:607`) prüft, dass `["geheim"]` im Block steht. Die
  Ursache ist unverändert: für beliebiges Seiten-JSON gibt es keine Form-Regel,
  und eine zu erfinden wäre eine eigene Spec. Die Richtungsumkehr ist an dieser
  einen Stelle also **nicht** fail-closed — wer sie schließen will, druckt den
  Marker statt des Werts; genau dieser Test ist die Stelle, an der es auffällt.
- ~~**Ein Tabellen-Tippfehler reißt den Dienst**~~ — *gilt nicht mehr.* Die
  Tabelle ist ein `const` mit `enum Rule`: ein falscher Regelname kompiliert
  nicht, statt zur Laufzeit zu werfen. `debug_block_of` liefert
  `Option<String>`, es gibt keinen werfenden `applyRule`; der eine `expect`
  betrifft die Serialisierung eines Werts, den `project` selbst gebaut hat, ist
  also ein Programmierfehler und kein Tabellenfehler.
- ~~**`Object.freeze` ist flach**~~ — *gilt nicht mehr.* Es gibt kein `freeze`:
  `DEBUG_WHITELIST` und die Feldtabellen sind `&'static`-Konstanten, eine
  Laufzeit-Mutation ist weder vorgesehen noch möglich.
- **`title` als Länge ist in `click` und `type` nicht gepinnt.** *Gilt weiter.*
  Beide Debug-Fälle prüfen die Schlüsselliste und die Länge von `clicked` bzw.
  `typed`, aber nicht den Wert von `title`
  (`hub_requestWithClickMethodUnderDebugLogging_shouldRedactTextAndClicked`, `hub_requestWithTypeMethodUnderDebugLogging_shouldRedactThePageTextAndTheElementDescription`);
  `navigate`, `read`, `focus` und `inspect` prüfen ihn. Ein `title: Full` in der
  Tabelle bliebe an diesen zwei Stellen grün. Hier nicht behoben, weil die
  Live-Messung keinen Defekt zeigte und Testcode ohne Befund ein anderer Auftrag
  ist.
- ~~**`__proto__` als Feldname fällt lautlos weg**~~ — *gilt nicht mehr.* In Rust
  ist `__proto__` ein gewöhnlicher Schlüssel einer `serde_json`-Map; es gibt
  keinen Setter zu treffen. Am 2026-11-18 mit einem Wegwerf-Programm außerhalb
  des Repos gegen die Bibliothek gemessen
  (`debug_block_of("read", {"tabId":42, "__proto__":"geheim", "constructor":"auch geheim"})`):
  der Block trägt `"__proto__": "<unlisted field>"` **und**
  `"constructor": "<unlisted field>"`. Die Zusage „der Schlüssel bleibt" gilt
  also für jeden Namen.

## Messlauf

**2026-11-18, Kriterium 5 live gemessen — ohne Browser, gegen den echten Dienst
und gegen einen zweiten eigenen Prozess.**

**1. Der laufende Dienst** (`browser-control.service`, PID 3838770, Ports
8110/8111, `log=info`). `POST /mcp` auf 8111 mit dem Betreiber-Token,
`tools/call browser_status`: HTTP 200, `isError` mit „Keine Extension
verbunden", im Journal **keine neue Zeile** — bei `info` gibt es keinen
Debug-Block, und angetastet wurde nichts (`systemctl` nur lesend). Ohne
Extension gibt es hier allerdings auch kein Ergebnis zu prüfen; der Lauf belegt
den Schalter, nicht den Block.

**2. Ein zweiter Prozess** (eigenes Token aus `openssl rand -hex 32`,
`BC_BIND=127.0.0.1:18810`, `BC_HTTP_PORT=18811`, `BC_LOG=debug`), gegen den eine
nachgebaute Extension aus `/tmp` (nicht im Repo) `hello` schickte und jede
`request` mit einem Ergebnis voller Seiteninhalt beantwortete: `text:
"GEHEIMER-SEITENTEXT"`, `title: "GEHEIMER-TITEL"`, dazu ein erfundenes
`surpriseField: "GEHEIMER-FREMDWERT"`. Aufgerufen über `/mcp`:
`browser_status` und `browser_read`, beide HTTP 200 mit dem vollständigen
Ergebnis (der Block ist stderr, nicht die Antwort).

Im stderr des zweiten Prozesses, ungekürzt:

```
2026-11-18T18:11:12.998Z read tab=1 url=https://example.org/ chars=19 truncated=false via=innerText
2026-11-18T18:11:12.999Z {
  "tabId": 1,
  "url": "https://example.org/",
  "title": "<14 chars>",
  "text": "<19 chars>",
  "offset": 0,
  "chars": 20,
  "totalChars": 20,
  "truncated": false,
  "via": "innerText",
  "mode": "full",
  "root": null,
  "fellBack": false,
  "settled": true,
  "waitedMs": 120,
  "surpriseField": "<unlisted field>"
}
```

Damit sind drei Aussagen belegt: Seiteninhalt erscheint als Länge (`text`,
`title`), ein unbekanntes Feld erscheint als Marker ohne Länge, und die
Logzeile davor ist unverändert. Gegengeprüft per `grep -c` im gesammelten
stderr: `GEHEIMER-SEITENTEXT` ⇒ **0**, `GEHEIMER-FREMDWERT` ⇒ **0**,
`GEHEIMER-TITEL` ⇒ **2**.

Die zwei Treffer sind die **`status`-Blöcke**, in denen `title` absichtlich voll
erscheint (Byte-Pin, `## Risiken`). Der `read`-Block ist sauber; **der
Seitentitel in `status` ist die eine Stelle, an der Seiteninhalt live noch auf
stderr steht** — offen als Folgeinkrement, nicht als Lücke dieses Inkrements.

Gegenprobe `log=info` auf denselben Ports: `browser_read` antwortet, im stderr
stehen `extension connected`, `status windows=1 tabs=1` und die `read`-Zeile,
`grep -c '^{'` ⇒ **0** — kein Block.

Beide eigenen Prozesse wurden per PID beendet (`kill $PID`), die Ports
18810/18811 sind wieder frei; der Dienst auf 8110/8111 blieb unberührt.

**Was dieser Lauf nicht zeigt:** die Seite war nachgebaut, nicht der
Betreiber-Firefox. Ein `browser_inspect` auf einer echten Seite steht damit
weiter aus — der Betreiber-Haken an Kriterium 5 für den echten Browser bleibt
offen, und ohne verbundene Extension (Lauf 1) war auch `browser_read` dort nicht
zu messen.

## Review

### Runde 1, 2026-10-29 — `🔧 Fix these`, Blocker: L1–L7

Der Plan hat den Code ehrlich nachgelesen: elf Zweige, sieben Blöcke, vier stumme,
alle Helfernamen und Zeilennummern stimmen, der `status`-Byte-Pin in
`test/bridge.test.js`/`test/mcp.test.js` ist real, und kein bestehender Fall prüft
heute ein unbekanntes Feld — die Richtungsumkehr ist wirklich neu.

Blockierend: L1 (die `read`-Tabelle vergaß `settled`/`waitedMs`, die die Extension
über `{...page, ...settle}` liefert), L2 (`## Open questions` führte zwei entschiedene
Fragen, die Abnahme stand nirgends), L3 (die Touch boundary nannte die zwei
Byte-Pin-Dateien nicht), L4 (vier Stellen sagten weiter „sechs", eine davon
Kriterium 1), L5 (`## Ziel` behauptete, `title` sei heute schon Länge), L6 (der
Grep-Beweis konnte nicht grün werden, weil die Kommentare der stillen Zweige den
alten Helfer nennen), L7 (der neue Test prüfte auf eine erfundene Länge „11").

Gering: L8 (fünf statt sieben `logLevel`-Prüfstellen), L9 (die `unlisted`-Regel sagte
nicht, dass der Schlüssel bleibt), L10 (zwei Signaturen für `debugBlockOf`), L11 (der
Diff-Beweis griff nur Signaturen), L12 (eine Testing-Zeile war kein Testfall). Alle
zwölf übernommen.

### Runde 2, 2026-10-29 — `🔧 Fix these`, Blocker: M1

L1–L12 sind nachprüfbar, und die sieben Tabelleneinträge treffen die Ergebnisse von
`collectStatus`, `navigationResult`, `pageResultOf`, `clickResult`, `typeResult`,
`inspectResultOf` und `described` **feld- und reihenfolgegenau** — auch `status`
(Byte-Pin hält, weil fehlende Felder nicht erscheinen) und `read` (`settleOutcomeOf`
wirft das `href` aus `frameFieldsOf` weg, also kein Streufeld im iframe-Fall). Zahlen
stimmen: zwölf Methoden, elf Zweige, sieben Blöcke, vier stille, fünf
`logLevel`-Prüfstellen, sechs `title`-Längen.

Blockierend war M1: die `title`-Länge macht fünf Stellen in aktiven Specs falsch
(`docs/05:196`, `docs/08:93-95` + `:123`, `docs/09:129` + `:345`, `docs/07:538-541`),
die `## Amendments`-Tabelle nannte nur `docs/05:190-192` und `ROADMAP:69`, und die
Touch boundary gab dem Orchestrator keine dieser Dateien.

Gering: M2 (`<12 chars>` — „Beispielseite" hat 13), M3 (`inspectionResultOf` heißt
`inspectResultOf`, Extension-Zeilen driften), M4 (Testing-Zeile „genau die Felder"
gegen „fehlende erscheinen nicht"), M5 (das Eingangsbild „jeder Zweig redigiert" gilt
für vier von sieben), M6 (niemand sagte, wer die Schlussstufe macht). Alle sechs
übernommen.

Noch keine Runde.

### Code-Review Stufen 1–2, 2026-10-30 — `✅ Ship it`

Die Tabelle trifft `pageResultOf`/`clickResult`/`typeResult`/`navigationResult`/
`inspectResultOf`/`toTabSummary`/`collectStatus` feld- und reihenfolgegenau; der
`status`-Block bleibt byte-gleich, weil fehlende gelistete Felder nicht erscheinen.
Sechs Befunde, keiner blockierend: D1 (`debugBlockOf` fragte die Prototypenkette —
`"constructor"` lieferte einen Marker-Block statt `null`), D2 (`applyRule` fiel bei
unbekanntem Regelnamen auf `shape` zurück), D3 (zwei Abwehrzweige ungetestet, davon
einer fail-open), D4–D6 Kosmetik. Entscheidend: Kriterium 2 für `read` entschieden,
Kriterium 1 noch nicht. D1, D2 und die zwei Abwehrfälle sind in Stufen 3–4
mitgenommen.

### Code-Review Stufen 3–4, 2026-10-30 — `✅ Ship it`

Sechs Zweige migriert plus `read` = sieben Aufrufe von `#logDebugBlock`,
`logLevel === "debug"` genau eine Stelle, die alten Helfer ohne Aufrufer, die
`format…Line`-Rümpfe nachweislich unberührt, die vier stillen Pfade diff-unberührt.
Kriterien 1–4 entschieden. Fünf Nits, keiner blockierend: E1 (`title` als Länge ist in
`click`/`type` nicht gepinnt), E2 (`__proto__` als Feldname fällt weg statt Marker),
E3 (die Lückenzeile zu D2 beschrieb „Timeout", tatsächlich hängt die Promise und der
Prozess kann sterben — korrigiert), E4/E5 Kommentar- und Zahlenreste.

**Zwei Korrekturen am eigenen Text**, die der Reviewer gefunden hat: `pageTextCharCount`
und `lengthOf` **dürfen nicht** gleich sein (`"12"` gegen `"<12 chars>"`), und die
verbleibenden `logLevel`-Stellen waren vier Stellen mit sechs Zweigen dahinter, nicht
vier Zweige.

## Log

Schlussstufe, 2026-11-18 — Amendments, Lücken, Messung, Abschluss:

- **Amendments nachgezogen**: `docs/05` (Hub-Prosa, `## Bekannte Lücken`,
  `#logDebugResult` unter „What could go wrong"), `docs/08` (Hub-Absatz und
  Testing-Zeile), `docs/09` (Inspect-Block und Stufe 3 des Dev-Plans), `docs/07`
  (`title`-Falle), `docs/ROADMAP.md` (Zeile 18 und `Gemacht`-Tabelle). Die alten
  Zeilennummern stimmten nicht mehr; gesucht wurde im heutigen Text.
- **Fünf Lücken geprüft, zwei bleiben offen**: der Nicht-Objekt-Fall gilt weiter
  (gepinnt), `title` in `click`/`type` ist weiterhin nicht gepinnt. Der
  Tabellen-Tippfehler, das flache `Object.freeze` und `__proto__` sind mit dem
  Rust-Port entfallen — Belege in `## Bekannte Lücken`.
- **Kriterium 5 gemessen** (`## Messlauf`): eine Ergebnisfläche voller
  Seiteninhalt, im stderr nur Längen und der Marker. Die `status`-Titel-Ausnahme
  steht dort als offener Punkt.
- **Abgeschlossen**: `status: active`, `docs/README.md` (Status-Spalte),
  `docs/PROJECT-STATE.md`, `CHANGELOG.md`.

Runde 1: L1–L12, alle übernommen. Runde 2: M1–M6, alle übernommen — darunter der
einzige echte Blocker (die Amendments übersahen drei aktive Specs) und zwei
erfundene Zahlen.

Code-Review Stufen 1–2: D1 (Object.hasOwn) und D2 (unbekannte Regel wirft) in Stufen
3–4 übernommen, die zwei Abwehrfälle als Tests nachgelegt, D4–D6 als Kosmetik offen
gelassen. Code-Review Stufen 3–4: E3 sofort in `## Bekannte Lücken` korrigiert, E4
(Kommentar mit dem gelöschten Helfer) als Kleinigkeit notiert, E1 zurückgestellt —
Testcode gehört zu `ranger-1`.
