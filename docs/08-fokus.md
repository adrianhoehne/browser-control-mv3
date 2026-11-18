---
description: browser_focus holt den Agenten-Tab nach vorn und sein Fenster in den Vordergrund — damit der Betreiber sieht, wovon der Agent spricht, ohne dass etwas an der Seite verändert wird.
status: active
---

# Zeigen: `browser_focus`

Der Agent kann navigieren, lesen, klicken und tippen — aber wenn er sagt „schau
dir Tab 15 an", muss der Betreiber ihn selbst suchen. Dieses Inkrement gibt ihm
den Griff, den ein Mensch hat: den Tab nach vorn holen.

Es ist das kleinste Inkrement bisher: **eine** Handlung, kein Seitentext, keine
Wartezeit, kein Slot.

## Ziel

`browser_focus` holt den Agenten-Tab in den Vordergrund (`active: true`) und
sein Fenster nach vorn (`focused: true`) und antwortet mit `tabId`, `windowId`,
`url`, `title`, `active`, `focused`. Der Betreiber sieht die Seite, die der
Agent gerade im Blick hat.

Die Handlung verändert nichts an der Seite: kein Scrollen, kein Klick, kein
Fokus in ein Feld — nur die Auswahl von Tab und Fenster.

## Non-goals

- Kein Fokussieren fremder Tabs (nur der Agenten-Tab; es gibt keinen Parameter
  dafür), kein Öffnen, Schließen, Verschieben oder Anheften von Tabs.
- Kein Fenster-Management (kein `windows.create`, kein Minimieren, kein
  Vollbild).
- Kein `element.focus()` in ein Feld — das ist eine Seitenänderung und gehört zu
  `browser_type` (`focus()` vor dem Schreiben), nicht hierher.
- Kein Warten, kein Slot, keine zweite Injektion, kein Seitentext in der
  Antwort: `focus` liest die Seite nicht.
- Keine Änderung an den anderen Werkzeugen (`browser_status`,
  `browser_navigate`, `browser_read`, `browser_click`, `browser_type`).
- Keine neuen Berechtigungen (`tabs` und `storage` reichen; `windows.update`
  braucht keine eigene).

## Wire-Protokoll (neu: `focus`)

`PROTOCOL.METHODS` bekommt `FOCUS: "focus"`. Anfrage ohne Parameter:

```json
{"type":"request","id":6,"method":"focus","params":{}}
```

Antwort:

```json
{"type":"response","id":6,"ok":true,
 "result":{"tabId":15,"windowId":103,"url":"https://www.qwant.com/",
           "title":"Qwant - The search engine that values you as a user, not as a product",
           "active":true,"focused":true}}
```

- **Kein Agenten-Tab** (nichts gespeichert, Tab weg, nicht mehr im
  Default-Container): `ok:false, code:"no_agent_tab"` — derselbe Code wie bei
  `read`/`type`, ohne Ersatzgriff.
- **Reihenfolge**: erst `tabs.update(tabId, {active: true})`, dann
  `windows.update(windowId, {focused: true})` — ein aktiver Tab in einem
  Hintergrundfenster ist nicht sichtbar, und ein fokussiertes Fenster mit einem
  anderen aktiven Tab zeigt das Falsche.
- **`active`/`focused`** in der Antwort sind das Ergebnis der beiden Aufrufe
  (`tab.active`, `window.focused`), nicht die Absicht.
- **Fehler beim Fenster** (etwa weil es zwischenzeitlich geschlossen wurde):
  solange der Tab aktiv wurde, ist die Antwort `ok:true` mit
  `focused: false` — der halbe Erfolg ist ein Erfolg und wird als solcher
  gemeldet. Erst wenn `tabs.update` **wirft**: `ok:false, code:"focus_failed"`.
  Löst `tabs.update` auf, ohne den Tab zu aktivieren, bleibt es bei `ok:true`
  mit `active: false` — gemeldet, nicht erfunden.
- **`about:`-Adressen** sind hier kein Sonderfall: es wird nichts gelesen.

## MCP-Werkzeug

| Feld | Wert |
|---|---|
| `name` | `browser_focus` |
| `description` | Holt den Agenten-Tab nach vorn und sein Fenster in den Vordergrund; die Seite wird dabei nicht verändert, und `focused` kommt aus einer Abfrage nach dem Fokussieren. |
| `inputSchema` | `{"type":"object","properties":{},"additionalProperties":false}` |

`tools/call`:

- **Erfolg**: `{"content":[{"type":"text","text":"<JSON, 2 Leerzeichen eingerückt>"}]}`.
- **Argument übergeben**: `isError`, „browser_focus erwartet keine Argumente."
  (Tabelle je Werkzeug, wie bei `browser_status`/`browser_read`).
- **`no_agent_tab`**: `TOOL_TEXTS.NO_AGENT_TAB` (wörtlich wie bei `read`).
- **`focus_failed`**, Zeitüberschreitung: `CALL_EXTENSION_FAILED(code)`.

## Hub

Keine strukturelle Änderung. Logzeile `focus tab=<id> window=<id>` — kein
Seitentext, kein `url` (es gibt nichts zu zeigen, was nicht schon in der Antwort
steht). Der Debug-Block ist die Whitelist aus `DEBUG_WHITELIST`
(`bridge-rs/src/hub.rs`, seit Spec 28): `tabId`, `windowId`, `url`, `active` und
`focused` voll, `title` als Länge. „Das ganze Ergebnis" stand hier bis
2026-11-18 und gilt nicht mehr.

## Extension

- `answerFocus`/`focusErrorFor` (Muster: `answerRead`/`readErrorFor`); Zweig in
  `answerRequest`.
- `focusAgentTab(params)`: Parameter müssen leer sein (fremde Schlüssel ⇒
  `invalid_params`), dann Tab-Auflösung wie bei `read`/`type`
  (`agentTabId` + `findDefaultContainerTab`), dann die beiden Aufrufe.
- **Kein Slot, kein Fenster, keine Injektion.** `focus` darf nicht mit
  `navigate`/`click`/`type` kollidieren: es löst keine laufende Aktion ab und
  wird von keiner abgelöst.
- `activeNavigation` bleibt unberührt.

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `test/protocol.test.js` — `METHODS.FOCUS` | Steht wörtlich in beiden Kopien |
| `test/extension.test.js` — kein Agenten-Tab | `no_agent_tab`, **kein** `tabs.update`, **kein** `windows.update` |
| dito — gespeicherter Tab existiert nicht mehr | `no_agent_tab` |
| dito — gespeicherter Tab liegt in einem Container | `no_agent_tab` |
| dito — normaler Fall | `tabs.update(tabId, {active: true})` **einmal**, danach `windows.update(windowId, {focused: true})` **einmal**, in dieser Reihenfolge (der Stub zählt Aufrufe mit Argumenten); die Antwort ist `ok:true` mit `active:true` **und** `focused:true` |
| dito — `windows.update` wirft (Fenster zwischenzeitlich zu) | `ok:true`, `active:true`, `focused:false` |
| dito — `tabs.update` wirft | `ok:false`, `focus_failed` |
| dito — fremder Parameter | `invalid_params`, keine Aktualisierung |
| dito — `focus` während einer laufenden Navigation | Beide laufen durch: der `focus`-Aufruf antwortet `ok:true`, die Navigation danach mit ihrem eigenen Ergebnis (kein `superseded`, keine zweite Injektion) |
| dito — keine Injektion | `browser.tabs.executeScript` wird **nicht** aufgerufen |
| `test/hub.test.js` — `hub.request(PROTOCOL.METHODS.FOCUS, {})` | Logzeile `focus tab=42 window=1`, Debug-Block mit den Whitelist-Feldern (`url` voll, `title` als `<n chars>`) |
| `test/mcp.test.js` — `tools/list` | Sechs Werkzeuge, `browser_focus` ohne Eigenschaften, `additionalProperties:false` |
| dito — Erfolg, Argument übergeben, `no_agent_tab`, `focus_failed` | je der Satz aus `## MCP-Werkzeug`; abgelehnte Aufrufe erreichen die Extension nicht (Fixture-Zähler) |

## Acceptance criteria

1. `npm test; echo $?` → `0`, Ausgabe enthält `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. Von den 227 bisherigen Fällen laufen **226
   unverändert**; **einer muss sich ändern**: der Werkzeugzahl-Fall in
   `test/mcp.test.js` (`…FiveTools…`). Er steht mit Begründung im Bericht.
2. `tools/list` liefert sechs Werkzeuge; `browser_focus` hat leere `properties`
   und `additionalProperties: false`.
3. Mit Fake-Extension liefert `browser_focus` Text, der sich als JSON parsen
   lässt und `tabId`, `windowId`, `url`, `title`, `active`, `focused` enthält.
4. `no_agent_tab` und `focus_failed` kommen als `isError` mit den deutschen
   Sätzen an (Beleg: `test/mcp.test.js`); in keinem Fall wurde `executeScript`
   aufgerufen (Beleg: `test/extension.test.js`, Zählung `tabs.scriptCalls`).
5. Die Logzeile für `focus` enthält weder Seitentext noch `url`.
6. **Die Handgriffe des Betreibers**: Extension in `about:debugging` neu laden,
   pi neu starten. Danach ruft der Orchestrator `browser_focus` auf, **nachdem**
   der Betreiber in ein anderes Fenster gewechselt hat; Beleg ist die Antwort
   mit `active:true`/`focused:true` und der Betreiber bestätigt, dass der
   Agenten-Tab vorn steht.

   **Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 6
   ist erst nach den Handgriffen messbar, und der Betreiber lädt die Erweiterung
   aus seinem eigenen Klon — also nach dem `git pull`. Kriterien 1–5 laufen vor
   dem Commit, Kriterium 6 danach; fällt es rot aus, wird vorwärts korrigiert und
   die rote Zeile steht mit Datum unter `## Bekannte Lücken`. Ist die
   **Kernannahme** widerlegt (der Tab kommt nicht nach vorn), geht das Inkrement
   zurück in diese Spec — `## Bekannte Lücken` ist dafür kein Ersatz.

## Dev plan

1. **Wire-Konstante `focus` in beiden Kopien.** `bridge/protocol.mjs` und
   `extension/protocol.js`: `METHODS.FOCUS: "focus"` — beide im selben Schnitt
   (`extensionProtocol_comparedToBridgeProtocol_shouldBeIdentical` vergleicht per
   `deepStrictEqual`). Neuer Fall in `test/protocol.test.js` im Muster des
   `TYPE`-Falls.
   Proof: `node --test --test-reporter=tap test/protocol.test.js | grep -E '^# (pass|fail)'`
   → `# pass 7`, `# fail 0` (vorher 6). **Completed 2026-10-23**
2. **Testharness: die zwei Aufrufe beobachtbar machen — nur
   `test/extension.test.js`, kein Produktivcode.** `createTabsStub` bekommt
   `calls = []` und in `update(tabId, details)` zwei Wege:
   `details.url !== undefined` ist der Navigationsweg (unverändert), sonst der
   Aktivierungsweg (`calls.push({kind:"tabs.update", tabId, changes:{...details}})`,
   `active` im Store setzen, Kopie zurückgeben). `updateThrowsFor` gilt für
   beide Wege.
   `createBrowserStub` bekommt `windows.update(windowId, details)` mit derselben
   `calls`-Liste, Rückgabe `{id: windowId, focused: details.focused === true}`
   (kein Fenster-Lookup: der Stub soll das Ergebnis spiegeln, nicht die Absicht —
   er gibt zurück, was er bekommt, und lügt damit nicht), plus
   `windowUpdateThrowsFor`; `createSandbox`,
   `connectedBackground` **und** `startBackground` reichen `calls` und
   `windowUpdateThrowsFor` durch (Default `[]`). Ein Fall, der zählen will, gibt
   **dasselbe** Array an `createTabsStub` und `startBackground`. `updated.push`
   bleibt im Navigationsweg — sonst sammelt jeder `focus`-Fall Müll in
   `tabs.updated`, und drei Bestandsfälle vergleichen das per
   `deepStrictEqual`.
   Proof: `npm test; echo $?` → `0`, `# pass 227`, `# fail 0`, `# cancelled 0` —
   die Defaults sind inert, kein Bestandsfall ändert sich. **Completed 2026-10-23**
3. **`focus` in der Extension.** `extension/background.js`:
   `FOCUS_FAILED_CODE`, `FOCUS_FAILED_MESSAGE` („Das Aktualisieren von Tab oder
   Fenster ist fehlgeschlagen."), `FOCUS_PARAMS_MESSAGE` („focus nimmt keine
   Parameter."),
   `class FocusError`, Zweig in `answerRequest`, `answerFocus`/`focusErrorFor`,
   dann:
   - `focusRequestParams(params)`: fehlendes `params` oder leer ⇒ in Ordnung,
     sonst `invalid_params` — **vor** jeder Tab-Auflösung.
   - `focusAgentTab(params)`: Auflösung wörtlich wie `readAgentTabPage`
     (`readAgentTabId()` + `findDefaultContainerTab()`, `null` ⇒
     `no_agent_tab`). Diese eine Zeile deckt alle drei Sorten; eine vierte gibt
     es nicht — ein Tab überlebt sein Fenster nicht, und das Rennen „Fenster zu
     zwischen Auflösung und `windows.update`" **ist** der Fall `ok:true,
     focused:false`.
   - Reihenfolge mit **zwei getrennten `try`**, nicht aus Stil:
     `const activeTab = await browser.tabs.update(tab.id, {active:true})` ohne
     eigenes `try` (ein Wurf ⇒ `focus_failed`), danach
     `let window = null; try { window = await
     browser.windows.update(tab.windowId, {focused:true}); } catch {}` — die
     Bindung ist nötig, sonst steht `window` im Sandkasten nirgends.
   - Antwort aus den Rückgabewerten; `focused` liest seit Spec 12 (2026-10-23)
     zusätzlich `browser.windows.get(tab.windowId)` nach dem Update und nimmt
     dessen Wert, wenn er kommt:
     `{tabId, windowId: tab.windowId, url: asText(tab.url), title:
     asText(tab.title), active: activeTab?.active === true, focused:
     (focusedAfter?.focused ?? window?.focused) === true}` — `asText` (wie in
     `knownTabState`), damit ein Tab ohne Adresse `""` liefert statt eines
     fehlenden Feldes.
   - **Kein** `supersedeActiveNavigation`, keine Zuweisung an
     `activeNavigation`, kein `enqueueTabResolution`, kein Timer, keine Injektion.
   Die Fälle der `## Testing`-Tabelle; der Navigations-Fall nach dem Muster von
   `navigate_withAnInvalidUrlWhileAnotherIsRunning_shouldNotEndTheRunningOne`:
   Navigation auf Tab 500 (`status: "loading"`) starten, `focus` senden, **erst
   danach** `tabs.emitUpdated(500, {active:true})` (das Ereignis, das ein echtes
   `active:true` auslöst) und dann `tabs.emitUpdated(500, {status:"complete"})` —
   beide antworten, die Navigation mit ihrem eigenen Ergebnis. Damit ist die
   Zeile bewiesen, die `waitForTabComplete` auf `status` filtert.
   Der Reihenfolge-Fall prüft `calls` per `deepStrictEqual` gegen die vollen
   Objekte `[{kind:"tabs.update", tabId:500, changes:{active:true}},
   {kind:"windows.update", windowId:1, changes:{focused:true}}]`.
   Proof: `node --test --test-reporter=tap test/extension.test.js | grep -E '^# (pass|fail|cancelled)'`
   → `# pass 124`, `# fail 0`, `# cancelled 0`. **Completed 2026-10-23**
4. **Hub-Logzeile.** `bridge/hub.mjs`: `formatFocusLine(result)` neben
   `formatNavigateLine` (`Number.isInteger` sonst `NO_FIELD`; genau
   `focus tab=<id> window=<id>`, **kein** `url`), `#reportFocus(result)` =
   `#log(formatFocusLine(result))` + `#logDebugResult(result)`, kein `#onStatus`;
   Zweig in `#reportResult`. Neuer Fall in `test/hub.test.js` nach dem Muster von
   `hub_requestWithReadMethod_shouldResolveAndLogOneLineWithoutAnyPageText` mit
   `BC_LOG=debug`: genau eine Zeile beginnt mit `focus ` und lautet
   `focus tab=42 window=1`, dazu der JSON-Block mit `"focused": true`.
   Kriterium 5 **nicht** über `logLines.join("\n")` prüfen — der Debug-Block
   trägt `url` und `title` absichtlich.
   Proof: `node --test --test-reporter=tap test/hub.test.js | grep -E '^# (pass|fail)'`
   → `# pass 33`, `# fail 0`. **Completed 2026-10-23**
5. **MCP-Werkzeug und Fixture.** `test/fixtures/fake-extension.mjs`: `FOCUS_RESULT`
   (sechs Felder), `focusResponse(id)`, `case "focus"` in `responseFor`
   (Fehlerweg ohne `via`), `answers.focus = answerModeFromEnv("BC_TEST_FOCUS_ANSWER")`,
   Doku-Kopf. `bridge/mcp.mjs`: `BROWSER_FOCUS`, sechster `TOOLS`-Eintrag **ans
   Ende angehängt** (Beschreibung wörtlich, `properties: {}`,
   `additionalProperties: false`), `UNEXPECTED_ARGUMENTS[BROWSER_FOCUS]`,
   `case BROWSER_FOCUS`, `focusTool(…)` über `argumentFreeTool` mit
   `hub.request(PROTOCOL.METHODS.FOCUS, {})`, und ein `BROWSER_FOCUS`-Zweig in
   `extensionFailureText` (`no_agent_tab` ⇒ `TOOL_TEXTS.NO_AGENT_TAB`, sonst
   `CALL_EXTENSION_FAILED(code)` — das trägt `focus_failed`). `test/mcp.test.js`:
   `mcp_toolsList_shouldOfferExactlyTheFiveToolsOfTheContract` → `…SixTools…` und
   `tools[5]` prüfen; `FOCUS_TOOL_DESCRIPTION`, `FOCUS_UNEXPECTED_ARGUMENTS_TEXT`,
   `FOCUS_REQUEST_LINE`, `focusRequestCount(…)`; vier Neufälle (Erfolg,
   `arguments:{x:1}` ⇒ `isError` und Zähler 0, `no_agent_tab`, `focus_failed`).
   Proof: `node --test --test-reporter=tap test/mcp.test.js | grep -E '^# (pass|fail|cancelled)'`
   → `# pass 54`, `# fail 0`, `# cancelled 0` (50 heute + 4 neue). **Completed 2026-10-23**

**Hand-over, kein Schritt:** Kriterium 6 sind die Handgriffe des Betreibers —
Extension in `about:debugging` neu laden, pi neu starten, in ein anderes Fenster
wechseln; danach ruft der Orchestrator `browser_focus`. `extension/manifest.json`
und `extension/options.*` bleiben unberührt.

### What could go wrong

- **Die Harness-Änderung ist die einzige Stelle, die Bestandsfälle brechen
  kann.** `update` darf allein an `details.url === undefined` verzweigen, und
  `requireTab`/`updateThrowsFor` müssen vor dem Zweig bleiben — sonst werden
  `updateKeepsStatusCompleteFor`/`updateReportsAboutBlankFor` still zu No-Ops.
- **Zwei `try` sind Vertrag, nicht Geschmack** — aber die Wirkung ist eine
  andere als zunächst notiert (vom Reviewer korrigiert): ein gemeinsames `try`
  ohne eigenes Werfen im Fenster-Zweig wird auf dem **Tab-Wurf-Fall** rot
  (`activeTab` bleibt `undefined`, die Antwort wäre `ok:true` mit
  `active:false` statt `focus_failed`). Den **Halb-Erfolgs-Fall** dreht erst ein
  `throw` im Fenster-`catch` um — dann wäre ein geschlossenes Fenster ein harter
  Fehler statt `ok:true, focused:false`. Beide Invarianten sind durch je einen
  Fall gepinnt; nur die Ursache-Wirkung stand vorher falsch da.
- **Kriterium 5 gegen den Debug-Block.** Eine Zusicherung über den ganzen
  Logtext wäre rot, weil die Spec das ganze Ergebnis im Debug-Block will;
  geprüft wird die `focus `-Zeile.
- **`active`/`focused` aus dem Rückgabewert wirkt nur mit einem ehrlichen Stub.**
  Antwortet der Stub `{active:true}`, weil danach gefragt wurde, ist der Test grün
  ohne Beweis — der Aktivierungsweg muss den Store zurückspiegeln, `focused`
  kommt aus dem zurückgegebenen Fensterobjekt.
- **Kriterium 1 stimmt, am Code geprüft:** nur
  `mcp_toolsList_shouldOfferExactlyTheFiveToolsOfTheContract` zählt die
  Werkzeuge; kein Fall zählt `Object.keys(METHODS)` oder `tools.length`. Also
  **226 unverändert, 1 geändert**; die Harness-Änderung aus Stufe 2 ist kein
  „geänderter Fall". Ein neues Werkzeug **in der Mitte** von `TOOLS` würde
  dagegen vier Assertions auf `tools[0..4]` verschieben — deshalb ans Ende.
- **Im echten Browser feuert `active:true` ein `tabs.onUpdated` ohne `status`.**
  `waitForTabComplete` ignoriert genau das (`changeInfo?.status !==
  TAB_STATUS_COMPLETE`) — bestehendes Verhalten, nicht anfassen; ohne diese Zeile
  würde ein `focus` während einer Navigation sie vorzeitig beenden.
- **Kein `clock`-Einsatz im `focus`-Fall:** die Kette ist reines `await`; ein
  `clock.runNext()` in einem `focus`-Test wäre ein Zeichen dafür, dass jemand
  einen Timer eingebaut hat, den die Spec verbietet.

### Ordering and dependencies

1 → 3, 4, 5. 2 vor 3 (Stufe 3 braucht den Zähler). 3 und 4 sind unabhängig (der
Hub-Test schickt eigene Antwortframes). 5 braucht 1 und 4 (der MCP-Test spawnt die
echte Bridge mit echtem Hub), nicht 3 — die Fixture antwortet selbst. Nach jeder
Stufe `npm test` grün; nur Stufe 5 ändert einen Bestandsfall.

### What the next increment inherits

Inkremente 09/10 (Ruhe-Erkennung für `read`/`click`), 11/12 (Screenshot), 13
(Ausschnitte), 14 (Artikel), 15/16 (Frames, Shadow DOM) und 18 (Log-Hygiene)
stehen unverändert in `docs/ROADMAP.md`. Aus Spec 06 offen bleibt „ein Slot für
**alle** Aktionen": `focus` hat bewusst keinen und ist die Ausnahme, nicht der
Präzedenzfall — wer eine Aktion mit Seitenwirkung hinzufügt, muss die Slot-Frage
neu stellen. Nicht dabei: „fokussiere den vorher aktiven Tab", Fenster-Management,
`element.focus()`, `about:`-Sonderfälle. Der Testharness trägt jetzt
`windows.update` samt `calls`/`windowUpdateThrowsFor` — wer Fenster-Management
baut, erbt beides. Kriterium 8 aus Spec 01 steht weiter aus.

## Risiken

- **`focus` nimmt dem Betreiber den Blick.** Genau das ist der Zweck, aber es
  ist die einzige Handlung, die seine aktuelle Arbeit unterbricht — ohne
  Rückfrage. Missbrauch wäre ein Agent, der bei jedem Schritt fokussiert; die
  Werkzeug-Beschreibung sagt deshalb genau, was passiert („Holt den Agenten-Tab
  nach vorn und sein Fenster in den Vordergrund; die Seite wird dabei nicht
  verändert.") und nichts darüber hinaus.
- **Ein Hintergrund-Tab kann gedrosselt sein.** `focus` macht ihn sichtbar und
  weckt ihn damit — das ist erwünscht, kann aber eine halb gerenderte Seite
  zeigen, wenn direkt davor navigiert wurde.
- **Fenster-Zustand ist nicht garantiert:** ein Minimieren durch den Betreiber
  oder ein Vollbild einer anderen Anwendung kann `windows.update` anders wirken
  lassen, als die Antwort behauptet. Deshalb meldet sie `focused` aus dem
  Ergebnis und nicht aus der Absicht.
- **Kein Zurück:** es gibt kein „fokussiere den Tab, der vorher aktiv war". Wer
  das braucht, muss den Tab selbst wiederwählen.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine Tokens und keine Seitentexte im
  Repo.
- `extension/manifest.json` bleibt unverändert (keine neue Berechtigung),
  `extension/options.*`, `bridge/websocket.mjs` und `bridge/config.mjs` ebenso.
- `docs/PROJECT-STATE.md`, `docs/README.md`, `docs/ROADMAP.md` und `INSTALL.md`
  pflegt der Orchestrator.
- Kein Produktivcode für Inkrement 09 oder später (Ruhe-Erkennung, Screenshot,
  Frames, Shadow DOM).

## Bekannte Lücken

Stand 2026-10-23, vor der Umsetzung:

- **Kriterium 6 ist erst nach dem Commit messbar** (Extension-Reload,
  pi-Neustart, Fensterwechsel); die begründete Ausnahme steht dort und in
  `CONTRIBUTING.md`, `## Acceptance`.
- **Kein „zurück zum vorher aktiven Tab".** Wer den Fokus holt, gibt ihn nicht
  wieder ab — das steht unter `## Risiken` und braucht ein eigenes Inkrement,
  wenn es stört.
- ~~Der erste `focus`-Aufruf meldet `focused: false`, obwohl das Fenster danach
  fokussiert ist.~~ **Behoben am 2026-10-23 durch Spec 12**: `focused` kommt jetzt
  aus einem `windows.get` nach dem Update. Der historische Eintrag bleibt als
  Historie stehen — gemessen worden war er zweimal, und die Ursache war, dass
  `windows.update` den Zustand **vor** der Änderung zurückgibt.
- **Fenster-Zustand wird nur gemeldet, nicht erzwungen:** `focused: false` heißt
  „das Fenster ließ sich nicht fokussieren" (minimiert, Vollbild einer anderen
  Anwendung), nicht „der Aufruf ist gescheitert".

## Open questions

Keine. Der Betreiber hat am 2026-10-23 mit „zeige mir den Tab" den Bedarf
benannt; die Entscheidung, dass `focus` der Agenten-Tab ist und kein fremder,
folgt aus `docs/PROJECT-STATE.md`, Entscheidung 3.

## Review

| Runde | Datum | Verdict | Blocker |
|---|---|---|---|
| 1 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (Commit-Ausnahme fehlte, Proof-Zahl unmöglich) |
| 2 | 2026-10-23 | ✅ Ship it | nein (vier Doku-Nits) |

## Log

Runde 1 des Spec-Reviews — zwei Blocker und neun weitere Punkte (`m1`–`m10`,
`m3`/`m4` in einem), alle übernommen:

- **M1** (Kriterium 6 verlangte den Reload im Betreiber-Profil, ohne die datierte
  Ausnahme aus `CONTRIBUTING.md` anzusagen — jede andere Spec trägt sie) —
  **übernommen**: derselbe Absatz wie in Spec 07 (dort nachgeschärft, hier mit
  der Klon-Begründung), `## Bekannte Lücken` angelegt.
- **M2** (der Proof in Stufe 5 versprach `# pass 48`; `test/mcp.test.js` hat
  heute 50, mit vier neuen also 54) — **übernommen**.
- **m1** (`window` wurde im Schnipsel nie zugewiesen; der Normalfall prüfte die
  Antwort nicht) — **übernommen**: `let window = null; try { window = … }`, und
  die Testzeile verlangt jetzt `ok:true`, `active:true`, `focused:true`.
- **m2** (`url`/`title` ohne Quelle) — **übernommen**: `asText(...)`, damit ein
  Tab ohne Adresse `""` liefert statt eines fehlenden Feldes.
- **m3/m4** (zwei verschiedene Zahlen im selben Fall; `## Ziel` zählte fünf
  Felder statt sechs) — **übernommen**.
- **m5** (die Risiken behaupteten einen Satz in der Werkzeug-Beschreibung, der
  dort nicht steht) — **übernommen**: an den echten Vertragsstring angepasst.
- **m6** (Harness zu dünn: Fenster-Lookup, fehlende Durchreiche,
  `updated.push` im falschen Zweig) — **übernommen**.
- **m7** (der Nicht-Kollisions-Fall bewies nicht, dass ein echtes
  `active:true`-Ereignis die Navigation nicht beendet) — **übernommen**: das
  Ereignis wird jetzt emittiert.
- **m8** (`ok:true` mit `active:false` war undefiniert) — **übernommen**:
  `activeTab?.active === true`, plus der Satz „gemeldet, nicht erfunden".
- **m9** (zwei Ablehnungssätze ohne Inhalt) — **übernommen**.
- **m10** (Kriterium 4 mischte MCP- und Extension-Ebene) — **übernommen**.
- **Sprache** — **übernommen**: die „anderen vier Werkzeuge" heißen jetzt mit
  Namen, das Schnipsel ist syntaktisch heil, „Ordnungsfall" heißt
  Reihenfolge-Fall, und `deepStrictEqual` steht mit den vollen Objekten da.

Runde 2 des Spec-Reviews — Verdict `✅ Ship it`: die beiden Blocker sind erledigt,
alle neun weiteren Punkte nachgezogen, die Zahlen gegen den echten Baum geprüft
(protocol 7, extension 124, hub 33, mcp 54). Vier Doku-Nits übernommen: „Noch
keine Befunde." entfernt, die Zählung der Befunde korrigiert, die
Harness-Begründung auf „der Stub spiegelt das Ergebnis, nicht die Absicht"
umgestellt, und der Hub-Fall mit seinem echten Namen genannt.

Code-Review Runde 1 (Schritt 6, 2026-10-23) — Verdict `✅ Ship it` ohne Blocker.
Vier Folgepunkte, alle erledigt:

- **Falsche Ursache in Kommentar und Test-Vorbedingung** (`focus_failed` sei ein
  geschlossenes Fenster; es ist ein werfendes `tabs.update`) — **übernommen**.
- **Fehlendes `return;`** im FOCUS-Zweig von `#reportResult` — **übernommen**,
  damit der nächste angehängte Zweig nicht durchfällt.
- **Testlücke:** die Reihenfolge „`invalid_params` vor der Tab-Auflösung" war
  nicht gepinnt — **übernommen**: neuer Fall ohne gespeicherten Tab, Gegenprobe
  rot.
- **Doku:** die Begründung „zwei `try` sind Vertrag" nannte den falschen roten
  Fall — **übernommen**, oben korrigiert.

Messlauf (2026-10-23, Kriterium 6) — erfüllt:

- **Erster Aufruf:** `focus` → `{"tabId":15,"windowId":1,"url":"https://www.qwant.com/",
  "title":"Qwant - The search engine …","active":true,"focused":true}` — der Tab
  kam nach vorn, der Betreiber hat es am Bildschirm bestätigt („qwant wurde
  geöffnet … das tab wurde mir angezeigt").
- **Zweiter Lauf** (anderer Tab, Fenster 38): erster Aufruf `active:true,
  focused:false`, zweiter Aufruf `focused:true` — und `browser_status` zeigte
  Fenster 38 als `*fokussiert*`. Der Befund steht unter `## Bekannte Lücken`
  (Rückgabewert zu pessimistisch, Roadmap 08e).
- **Gegenprobe ohne Betreiberblick:** `browser_status` listet den Agenten-Tab
  als aktiven Tab in einem fokussierten Fenster — die Wirkung ist also auch
  maschinell belegbar, nicht nur durch Hinsehen.
