---
description: browser_inspect durchdringt offene Schattenbäume mit einem Piercing-Selektor (`my-card >>> button`); links und rechts steht je ein einfacher Selektor. Die übrigen Werkzeuge und geschlossene Bäume bleiben unberührt.
status: active
---

# In Komponenten hineinsehen: `>>>` in `browser_inspect`

Moderne Seiten kapseln ihre Inhalte in Schattenbäumen. `document.querySelector`
sieht dort nichts — der Agent bekommt „kein Element" für eine Seite, die sichtbar
voll davon ist. Roadmap 16 schließt diese Lücke, und zwar **nur für das Abfragen**:
wer ein Element sieht, kann es noch nicht bedienen; das ist ein eigener Schritt.

## Ziel

- **`browser_inspect` versteht einen Piercing-Selektor.** `my-card >>> button`
  sucht `my-card` im Dokument, steigt in dessen **offenen** Schattenbaum und sucht
  dort `button`. Mehrere Stufen sind erlaubt: `a >>> b >>> c`.
- **Ohne `>>>` ändert sich nichts.** Jeder heutige Selektor trifft dieselben
  Elemente in derselben Reihenfolge; die bestehenden Fälle bleiben unverändert grün.
- **Links und rechts steht je ein einfacher Selektor** (Typ, `#id`, `.class`,
  Attribute, `:nth-of-type(n)`), keine Nachfahren-Kombinatoren, keine Gruppen.
  Attributwerte nur **zitiert** (`[type="text"]`), wie der Parser es umsetzt
  (präzisiert 2026-10-29 nach dem Code-Review A1). Ein
  Verbund auf **beiden** Seiten ist ein `invalid_selector`, keine stille Teilmenge.
  Volle CSS-Selektoren wie in den DevTools sind bewusst nicht dabei (Betreiber,
  2026-10-29): sie brauchen einen zweiten Parser und sind eine eigene Roadmap-Zeile.
- **Geschlossene Schattenbäume bleiben unerreichbar.** `mode: "closed"` lässt kein
  Skript hinein — auch kein Inhalts-Skript mit `<all_urls>`. Ein Element dort ist
  **kein Treffer**, und das ist die ehrliche Antwort, keine Fehlermeldung.
- **Wiederverwendbar ist der Selektor nur, solange jedes Glied der Kette ein einfacher
  Selektor ist.** Fällt ein Glied (der Treffer **oder** ein Host) auf den `>`-Pfad
  zurück, lehnt `inspect` den zusammengesetzten Selektor beim Wiederverwenden ab.
- **Die Antwortfelder bleiben dieselben.** `selector` im Ergebnis nennt den Pfad,
  den der Agent wieder verwenden kann (mit `>>>`), sofern das Element einen
  Identitäts-Hook trägt (`#id`, `data-testid`, `aria-label`, `name`), `tag`/`id`/`classes`/`text`
  kommen aus dem gefundenen Element — auch wenn es in einem Schattenbaum liegt.

## Non-goals

- **`click`, `type`, `focus`, `read` durchdringen nichts.** Ein Element im
  Schattenbaum lässt sich nach diesem Inkrement finden, aber nicht bedienen; das
  ist der nächste Zuschnitt (Roadmap-Zeile bleibt offen).
- **Geschlossene Schattenbäume**, `::shadow`, `/deep/`, `:host`-Zauber, Slots als
  eigene Ebene.
- **`>>>` gilt nicht für die Textsuche** (`inspect` ohne `selector` bleibt beim Dokument).
- **`read` liest keine Schatten-Inhalte mit** — eigene Roadmap-Zeile.
- **Volle CSS-Selektoren rechts vom Sprung** (Verbünde, Gruppen, `:not(...)`) — eigene
  Roadmap-Zeile; hier gilt rechts wie links nur ein einfacher Selektor.
- **Kein Baum-Inventar** („zeig mir alle Schattenwurzeln"), kein eigenes Werkzeug.
- **Keine neue Berechtigung**, keine Änderung an `manifest.json`.

## MCP-Werkzeug

Nur die Beschreibung von `browser_inspect` wächst: ein Satz, der `>>>` nennt und
sagt, dass die rechte Seite im Schattenbaum gesucht wird. **Das Schema bleibt
unverändert** — `selector` ist weiter ein String, `>>>` ist Syntax darin, kein
eigenes Feld. Kein neues Werkzeug, keine neue Zahl in `tools/list`.

## Extension

- `inspectRequestParams` bleibt; die Zerlegung passiert im Schnipsel, nicht in der
  Bridge: nur die Seite weiß, ob ein `>>>`-Sprung einen Schattenbaum trifft.
- `splitPiercingSelector(selector)` im Schnipsel: teilt an `>>>` **außerhalb** von
  Attributwerten und Anführungszeichen (`[title="a>>>b"]` bleibt ein Selektor).
  Ein leeres Segment (`a >>> `, `>>> b`, `a >>> >>> b`) ⇒ `invalid_selector`.
- Jedes Segment, links **und** rechts: `isSimpleSelector(segment)` — erlaubt sind Typ, `#id`,
  `.class`, `[attr]`, `[attr="wert"]`, `[attr='wert']`, `:nth-of-type(n)`; alles andere (Leerzeichen,
  `>`, `+`, `~`, `,`, `:not(...)`, Pseudo-Elemente) ⇒ `invalid_selector`.
- Die Suche: das erste Segment läuft über `document.querySelectorAll` (wie heute),
  jedes weitere über `element.shadowRoot.querySelectorAll`. **Ein Element ohne
  offenen Schattenbaum endet den Pfad** — es liefert keine Treffer, kein Fehler.
  Mehrere Treffer je Stufe werden alle weiterverfolgt (Ergebnis ist die Menge der
  Endpunkte in dieser Expansionsreihenfolge, je Wurzel in ihrer eigenen Reihenfolge).
- **Zwei Schnipsel statt eines zweiten Zweigs:** `inspectShadowPageSource` (neu) trägt die
  Kettensuche, `inspectPageSource` bleibt **zeichengleich** — ein zweiter Zweig *in* ihm
  würde seinen `toString()`-Text und damit jede heutige `inspect`-Nutzlast ändern. Welcher
  Schnipsel reist, entscheidet `inspectPageCode` am Vorkommen von `>>>` im Selektor; das
  ist eine Nutzlast-Wahl, keine Zerlegung. (Präzisiert 2026-10-29 nach dem Dev-Plan.)
- `limit`/`truncated`/`includeHidden` gelten unverändert auf der Ergebnismenge.
- **Der Deckel von 5000 gilt für Endpunkte *und* jede Zwischenstufe.** Ein erreichter
  Deckel setzt `truncated: true`; `count` ist dann eine Untergrenze, wie heute.
- Der zurückgegebene `selector` je Treffer wird **mit `>>>`** beschrieben, damit
  ein Agent ihn wieder verwenden kann; fehlt ein Identitäts-Hook **und** ein eindeutiger Typ, bleibt der
  volle Pfad — der ist **nicht** wiederverwendbar (siehe `## Bekannte Lücken`).

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `inspect` mit `my-card >>> button` liefert den Knopf aus dem offenen Schattenbaum | die Kette steigt in `shadowRoot` |
| `test/extension.test.js` | `inspect` ohne `>>>` auf derselben Fixture liefert **nichts** aus dem Schattenbaum | ohne Syntax bleibt alles wie heute |
| `test/extension.test.js` | drei Stufen (`a >>> b >>> c`) liefern den Endpunkt der dritten | mehrere Sprünge |
| `test/extension.test.js` | `[title="a>>>b"]` wird **nicht** geteilt, sondern als ein Selektor gesucht | die Zerlegung kennt Anführungszeichen |
| `test/extension.test.js` | `>>> b`, `a >>> `, `a >>> >>> b` ⇒ `invalid_selector`, keine Trefferliste | leere Segmente werden abgelehnt |
| `test/extension.test.js` | `div span >>> b`, `a, b >>> c`, `my-card >>> div span` ⇒ `invalid_selector` | **beide** Seiten sind begrenzt |
| `test/extension.test.js` | geschlossener Schattenbaum ⇒ `count: 0`, kein Fehler | die Grenze ist ehrlich |
| `test/extension.test.js` | Element ohne Schattenbaum in der Mitte (`a >>> b`, `a` hat keinen) ⇒ `count: 0` | der Pfad endet still |
| `test/extension.test.js` | zwei Karten mit je einem Knopf ⇒ zwei Treffer in Expansionsreihenfolge, `limit` greift | Menge statt Einzelstück |
| `test/extension.test.js` | ein Fächer über den Deckel (`candidateLimit` überschritten) ⇒ `truncated: true` | der Deckel greift auch zwischen den Stufen |
| `test/extension.test.js` | zwei gleichnamige Geschwister in einer Wurzel ⇒ der Rückfall-`selector` des zweiten nennt `:nth-of-type(2)` und trifft dasselbe Element | die Positionszählung kennt die Wurzel |
| `test/extension.test.js` | `>>>` zusammen mit `frame`: der adressierte Rahmen antwortet, der andere sagt `not_the_frame` | der Frame-Gate steht im neuen Schnipsel |
| `test/mcp.test.js` | `>>>` reist unverändert durch die Bridge (kein Parsen, kein Escaping) | die Bridge bleibt dumm |
| `test/mcp.test.js` | die Beschreibung von `browser_inspect` nennt `>>>`; Schema und `tools.length` unverändert | kein neues Feld, keine neue Zahl |

## Acceptance criteria

**Ausnahme mit Datum** (2026-10-29, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 6 ist live
und nach dem Commit zu messen; **Kernannahme** ist Kriterium 6.

1. **Ohne `>>>` unverändert** (lokal). Alle bestehenden `inspect`-Fälle sind grün; die
   Nutzlast eines `inspect` ohne `>>>` trägt weiterhin genau `PAGE_HELPERS_PIN` und
   `selectorForElement` und **keinen** der neuen Helfer (`splitPiercingSelector`,
   `isSimpleSelector`, `shadowSelectorForElement`); `inspectPageSource` ist unverändert (gepinnt über `INSPECT_PAGE_SOURCE_PIN`);
   das Schema trägt kein neues Feld. (Byte-Gleichheit gegen „vorher" ist nicht prüfbar —
   es gab keinen Pin; präzisiert 2026-10-29 nach der Review-Runde 1, W3.)
2. **Offene Bäume werden durchdrungen** (lokal). `my-card >>> button` findet den
   Knopf, den `document.querySelector` nicht sieht; drei Stufen gehen.
3. **Die Zerlegung ist robust** (lokal). `>>>` in Attributwerten bleibt stehen;
   leere Segmente und Verbünde auf **beiden** Seiten ergeben `invalid_selector`
   ohne Trefferliste.
4. **Geschlossene Bäume und Enden ohne Schattenwurzel** (lokal). Beides ergibt
   `count: 0`, keinen Fehler und keine erfundene Meldung.
5. **Die Abnahme ist grün** (lokal). `npm test; echo $?` → `0` mit `# fail 0` **und**
   `# cancelled 0`; `npm run check; echo $?` → `0`;
   `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → keine Ausgabe, Exit 1;
   `git diff --exit-code extension/manifest.json` → 0.
6. **Eine echte Komponente auf einer echten Seite** (live). `browser_inspect` mit
   `>>>` findet auf einer Seite mit Web-Components ein Element, das ohne `>>>` nicht
   auffindbar ist — mit `tag`, `text` und einem wiederverwendbaren `selector`. Das
   gemessene Element **und jeder Host der Kette** tragen einen Identitäts-Hook, damit
   jedes Glied die Kurzform bekommt; sonst ist der Selektor nicht wiederverwendbar
   (`## Bekannte Lücken`, entschieden 2026-10-29). Die
   Zahlen stehen unter `## Messlauf

**Gemessen am 2026-10-29** im Profil des Betreibers, Tab 7, Extension nach Reload
(Stand `c15468a`), Seite `https://lit.dev/`.

| Kriterium | Befund |
|---|---|
| 6 (live) | `browser_inspect` mit `lazy-svg#headerLogo >>> svg` ⇒ `count: 1`, `selector: lazy-svg#headerLogo >>> svg[aria-label="Lit Home"]` — **beide** Glieder sind einfache Selektoren mit Hook |
| 1 (Gegenprobe) | derselbe Treffer **ohne** `>>>` gesucht (`svg[aria-label="Lit Home"]`) ⇒ `count: 0`: das Element ist im Dokument nicht auffindbar, nur im Schattenbaum |
| 6 (Rundlauf) | der zurückgegebene `selector` ein zweites Mal durch `browser_inspect` ⇒ `count: 1`, derselbe `svg` — wiederverwendbar |
| 3 | `theme-switcher >>> div span` ⇒ „The selector is invalid: …" (Verbund rechts), keine Trefferliste |
| 4 | auf `chromestatus.com/features` (160 Schattenwirte): `sl-icon-button` ohne `>>>` ⇒ `count: 0`; `chromedash-app >>> chromedash-header` ⇒ `count: 1`. Der zurückgegebene Selektor lautete dort `html > body > chromedash-app:nth-of-type(1) >>> chromedash-header:nth-of-type(1)` — **nicht** wiederverwendbar, genau der dokumentierte Rückfall, weil der Host keinen Hook trägt |

**Befund, der als Lücke bleibt:** auf einer Seite, deren Schattenwirt keinen
Identitäts-Hook trägt (chromestatus), ist der zurückgegebene Selektor über den
`>`-Pfad nicht wiederverwendbar. Die Messung auf `lit.dev` zeigt den Gegenfall
(`lazy-svg#headerLogo`). Beides ist ehrlich; der Unterschied liegt an der Seite, nicht
am Werkzeug.

**Nicht gemessen:** ein geschlossener Schattenbaum auf einer echten Seite (keine
gefunden, die einen hätte), und ein Sprung über drei Stufen live.## Dev plan

**Completed 2026-10-29** (alle vier Stufen; die Messung von Kriterium 6 ist offen).

**Stand im Code (gelesen, nicht erinnert).** `extension/background.js:2694` `describeElement`, `:2716` `isVisible`, `:2737` `isAddressedFrame`, `:2743` `PAGE_HELPERS_CODE` (genau diese drei), `:2761` `pageSnippetCode(source, args, extraHelpers = "")` — jeder Helfer reist per `toString()`, jede Argumentliste per `JSON.stringify`, alles in einer IIFE. `:3609` `inspectAgentTab` baut `pageRequest` (`candidateLimit` 5000, `textLimit` 200, `classLimit` 10) und injiziert einmal; `:3691` `inspectPageSource` beantwortet zuerst `isAddressedFrame(want)` mit `not_the_frame`, sucht dann `document.querySelectorAll(request.selector)` bzw. `body.querySelectorAll("*")` (`:3776`–`:3785`, `catch` ⇒ `{ outcome: "invalid_selector" }`), filtert `includeHidden`/`text`-Nadel im Loop (`:3790`–`:3803`) und liefert `count`/`truncated`/`elements`; `:3840` `selectorForElement` prüft Kandidaten mit `document.querySelectorAll`, `:3899` `pathOf` klettert über `parentElement`; `:3953` `inspectPageCode` hängt `selectorForElement.toString()` als einzigen Extra-Helfer an. `test/extension.test.js:8378` `createInspectElement`, `:8429` `createInspectBody`, `:8449` `createInspectPage`, `:8627` `matchesSelector` (+ `elementSet`-Wächter), `:8636` `querySelectorAllInPage`, `:9106` `createInspectTabs`, `:9642` `PAGE_HELPERS_PIN`. `bridge/mcp.mjs:175`–`:177` ist die einzige Stelle mit der `browser_inspect`-Beschreibung, `:389` `INSPECT_ARGUMENTS`, `:1094` `inspectTool` prüft nur Typen und die Filterregel — der Selektor geht unverändert auf den Draht. `test/mcp.test.js:103` pinnt die Beschreibung wörtlich, `:1084` prüft `tools[6]`.

1. **Schattenbäume ins Testdoppel** — nur `test/extension.test.js`: `nthOfTypeOf` (`:8529`) zählt am Wurzelrand heute falsch (`parentElement === null` ⇒ `[element]`) und wird auf `parentNode` gezogen, sobald die Wurzel `children` trägt; `createInspectElement` bekommt `shadowRoot` (Default `null`), `parentNode` und eine Wurzel (`root`) je Element; jeder Wurzelknoten ist ein Objekt mit `querySelectorAll(segment)` und `children` (filtert die geordnete Elementliste *dieser* Wurzel über `matchesSelector`) und einem `queries`-Protokoll; `host` als Rückverweis, `parentElement` bleibt am ersten Knoten einer Schattenwurzel `null` (so verhält sich das echte DOM). `createInspectPage` legt `page.elements` (Dokumentumfang, unverändert) und `page.elementSet` (alle Elemente, auch die in Schattenwurzeln, sonst wirft der `matchesSelector`-Wächter bei einem Fixture-Fehler statt zu antworten). `querySelectorAllInPage` und `createInspectBody` protokollieren zusätzlich in `page.queries`; die Seite entsteht in `pageContextOf`. Produziert: eine Fixture, die „im Dokument unsichtbar, in `shadowRoot` sichtbar" überhaupt darstellen kann.
   Proof: neue Harness-Fälle `createInspectPage_withAShadowRoot_shouldKeepItsElementsOutOfTheDocumentQuery` und `…_shouldAnswerPerRootInOrder` (`node --test --test-name-pattern='createInspectPage_withAShadowRoot' test/extension.test.js; echo $?` → 0), plus `npm test; echo $?` → 0 mit unverändertem `# fail 0`/`# cancelled 0`: kein Produktivcode angefasst, alle heutigen Fälle müssen grün bleiben.

2. **Zerlegung, Whitelist und das Payload-Gate** — `extension/background.js`: neue Modulfunktionen `splitPiercingSelector(selector)` und `isSimpleSelector(segment)` (beide ohne DOM, per `toString()` versendbar, keine Closure nach außen — dieselbe Regel wie `describeElement`). `splitPiercingSelector` scannt zeichenweise, führt `inQuote` (`'`/`"`, ein `\` innerhalb der Anführungszeichen überspringt das nächste Zeichen) und teilt an `>>>` nur außerhalb; leere Segmente (auch nach `trim`) sind ein Fehler. `isSimpleSelector` ist jedes Segment wird nach dem Split einmal `trim()`t, dann prüft eine verankerte Token-Schleife (Typ `[A-Za-z][\w-]*`, `#id`, `.class`, `[attr]`, `[attr="wert"]`, `[attr='wert']`, `:nth-of-type(n)`), die das Segment vollständig verbrauchen muss; alles Übrige (Leerraum, `>`, `+`, `~`, `,`, `:not(…)`, `::`, `*`) ⇒ falsch. Neu: `inspectShadowPageSource(request, want)` als eigener Schnipsel; `shadowSelectorForElement` reist als **fünfter Extra-Helfer** an `inspectShadowPageSource`; `inspectPageCode` wählt ihn genau dann, wenn `typeof request.selector === "string" && request.selector.indexOf(">>>") !== -1`, und hängt ihm `inspectPageSource`, `selectorForElement`, `splitPiercingSelector`, `isSimpleSelector` als Extra-Helfer an. Der Schnipsel beantwortet zuerst `isAddressedFrame(want)` (sonst sieht `frameTargetOf` keinen Kandidaten) und dann: ein Segment ⇒ `inspectPageSource(request, want)` mit dem ganzen Selektor (der `[title="a>>>b"]`-Fall läuft damit durch den heutigen Code, nicht durch eine Kopie); ≥ 2 Segmente ⇒ jedes Segment durch `isSimpleSelector`, ein Verstoß ⇒ `{ outcome: "invalid_selector" }`; bis hierhin noch keine Suche, also `count: 0` für eine gültige Kette. Der Gate ist keine Zerlegung: er wählt nur die Nutzlast, entschieden wird alles im Schnipsel.
   Proof: `inspect_withAPiercingSelectorInAnAttributeValue_shouldNotSplit` (assert: `page.queries` ist exakt `['[title="a>>>b"]']`, also ein einziger Dokumentaufruf mit dem ganzen String), `inspect_withACombinatorRightOfTheJump_shouldAnswerInvalidSelector`, `inspect_withAPiercingSelectorAndAFrame_shouldAnswerNotTheFrame`, `inspect_withAChainOfEmptySegments_shouldAnswerInvalidSelector` (`>>> b`, `a >>> `, `a >>> >>> b` ⇒ `answer.error.code === "invalid_selector"`, `page.queries` bleibt leer), `inspect_withACombinatorLeftOfTheJump_shouldAnswerInvalidSelector` (`div span >>> b`, `a, b >>> c`), `inspectPageCode_forAPlainInspect_shouldShipTheSamePayloadAsToday` (neuer `INSPECT_PAGE_SOURCE_PIN` neben `PAGE_HELPERS_PIN`; die Nutzlast für `{selector: "a#warenkorb-link"}` enthält `PAGE_HELPERS_PIN` + `selectorForElement`-Quelltext und weder `">>>"` noch `shadowRoot` noch `splitPiercingSelector`; die Nutzlast des `eval`-Schnipsels ebenso unverändert, `test/extension.test.js:10948` bleibt grün). `npm test; echo $?` → 0.

3. **Kettensuche und der `>>>`-Pfad als `selector`** — `extension/background.js`: `inspectShadowPageSource` expandiert die Segmente 2…n. Jeder Endpunkt trägt `{ element, root, prefix }`; Stufe 1 ist `document.querySelectorAll(segment 1)` (Prefix `""`), jede weitere `element.shadowRoot.querySelectorAll(segment)` — `shadowRoot === null` (geschlossen **oder** noch nicht upgegradet) beendet diesen Pfad ohne Treffer und ohne Fehler. Neue Modulfunktion `shadowSelectorForElement(element, root, valueLimit, classLimit)`: derselbe Vorzug, aber die Position zählt über `parentNode` (`element.parentNode === root` am Wurzelrand) — `positionOf` des Bestands fragt `parentElement`, das am Wurzelknoten `null` ist, und gäbe jedem gleichnamigen Geschwister `:nth-of-type(1)` (id → `data-testid` → `aria-label` → `name` → `tag:nth-of-type(n)` → `tag.k1.k2` → Pfad; jeder Kandidat wird gegen `root` geprüft), `isTheOnlyMatch` fragt `root.querySelectorAll` und der Pfad klettert bis `parentElement === null`; pro Endpunkt entsteht `prefix === "" ? documentSelector : prefix + " >>> " + local`, wobei der Dokumentfall **exakt** `selectorForElement` bleibt (kein zweiter Builder für den Dokumentbaum) und `prefix` für den Host rekursiv aus derselben Regel kommt (bei einer Karte `my-card` → `… >>> my-card:nth-of-type(1) >>> button`). `element.getRootNode()` wird nicht gebraucht — die Wurzel kennt der Walk. Der Zustellschwanz (`cappedString`/`textOf`/`classesOf`/`rectOf`/`identityOf`/`described`) steht im zweiten Schnipsel als **bewusste Kopie** ("the plain payload is byte-pinned; a shared tail would change every inspect byte"), mit genau den elf Feldern. `limit`, `includeHidden`, die `text`-Nadel und `truncated` gelten unverändert auf der Endpunktmenge; zusätzlich deckelt `candidateLimit` (5000) die Endpunkte *und* jede Zwischenstufe, und ein erreichter Deckel setzt `truncated: true` von Anfang an (`count` ist dann untere Schranke — dieselbe Bedeutung wie heute).
   Proof: `inspect_withAPiercingSelector_shouldReachTheButtonInsideTheOpenShadowRoot`, `…_withoutAPiercingSelector_shouldNotSeeIt` (derselbe Fixture, `count: 0`), `inspect_withThreeJumps_shouldAnswerTheEndpointOfTheThird`, `inspect_withAClosedShadowRoot_shouldAnswerCountZero`, `inspect_withAnElementWithoutAShadowRootInTheMiddle_shouldAnswerCountZero`, `inspect_withTwoCards_shouldAnswerBothButtonsInExpansionOrder` (assert die Reihenfolge `[Karte1-Knopf, Karte2-Knopf]`, und in einer zweiten Zusicherung `[A-1, A-2, B-1]` bei zwei Treffern in der ersten Wurzel; `limit: 1` ⇒ `count: 2`, `elements.length === 1`, `truncated: true`), `inspect_withTwoEqualSiblingsInOneRoot_shouldAnswerNthOfTypeTwo`, `inspect_withAFanOutPastTheCap_shouldAnswerTruncated`, `inspect_withTheSelectorOfAShadowHit_shouldFindTheSameElementAgain` (der zurückgegebene `selector` geht ein zweites Mal durch `inspect` und trifft dasselbe Element — der Beleg für Kriterium 6, lokal), `inspect_withAShadowHit_shouldDeliverTheSameFieldSetAsADocumentHit` (`Object.keys`-Gleichheit gegen einen Dokumenttreffer, gegen Drift der Kopie). `npm test; echo $?` → 0 mit `# fail 0` und `# cancelled 0`.

4. **Die Bridge nennt die Syntax** — `bridge/mcp.mjs:177`: ein Satz in der Beschreibung von `browser_inspect` („`my-card >>> button` sucht rechts vom Sprung im offenen Schattenbaum; ohne `>>>` ändert sich nichts"), Schema, `INSPECT_ARGUMENTS` (`:389`) und `inspectTool` (`:1094`) bleiben unangetastet. `test/mcp.test.js:103` `INSPECT_TOOL_DESCRIPTION` wird auf den neuen Wortlaut gezogen, `:1084` bleibt inhaltlich gleich (`tools.length` 12, `tools[6].inputSchema` unverändert, `required` weiter `undefined`); neuer Fall `mcp_toolsCallBrowserInspect_withAPiercingSelector_shouldPassItThroughUnchanged`: `browserInspectCall(id, { selector: "my-card >>> button" })` ⇒ `requests[0].params` ist `{ selector: "my-card >>> button" }`, keine Umschreibung, kein Escape, keine zusätzlichen Schlüssel.
   Proof: `node --test --test-name-pattern='mcp_toolsCallBrowserInspect_withAPiercingSelector' test/mcp.test.js; echo $?` → 0 und `node --test --test-name-pattern='mcp_toolsList' test/mcp.test.js; echo $?` → 0; danach die ganze Abnahme aus `CONTRIBUTING.md` `## Acceptance`: `npm test; echo $?` → 0 (`# fail 0` **und** `# cancelled 0`), `npm run check; echo $?` → 0, `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → Exit 1, `git diff --exit-code extension/manifest.json` → 0.

Die letzte Stufe aus `spec-doc-implementation` (Spec auf `status: active`, Prosa beschreibend, `## Amendments` entfernen, `docs/README.md`/`docs/PROJECT-STATE.md` pflegen) macht der Orchestrator, nicht der Umsetzer — `## Touch boundary` der Spec nennt diese Dateien ausdrücklich bei ihm. Kriterium 6 ist laut Spec-Ausnahme live und nach dem Commit zu messen; die Zahlen gehören in `## Messlauf`, der Umsetzer kann sie nicht liefern.

### What could go wrong

- **Kriterium 1 („die Injektion ohne `>>>` ist byte-gleich") und die Zeile „`inspectPageSource` bekommt einen zweiten Zweig" vertragen sich nicht.** Ein zweiter Zweig *in* dieser Funktion ändert ihren `toString()`-Text, also jede heutige `inspect`-Nutzlast. Der Plan nimmt deshalb zwei Schnipsel und lässt `inspectPageSource` unberührt; die Entscheidung „Schattenbaum oder Dokument" bleibt trotzdem in der Seite, nur heißen die beiden Zweige jetzt zwei Funktionen. Wenn der Orchestrator die Spec-Zeile wörtlich will, muss Kriterium 1 auf „verhält sich gleich" umformuliert werden — das ist eine Spec-Änderung, keine Umsetzerentscheidung.
- **Kriterium 6 („wiederverwendbarer `selector`") und Kriterium 3 („Verbünde links ⇒ `invalid_selector`") stoßen im Rückfall zusammen.** `selectorForElement` liefert bei fehlender Kurzform einen Pfad mit `>` (`html > body > …`). Für einen Treffer tief in einer Karte heißt der zurückgegebene Selektor dann `html > body:nth-of-type(1) > my-card:nth-of-type(1) >>> button` — und den lehnt `inspect` beim Wiederverwenden selbst ab, weil links ein Verbund steht. Der Plan pinnt den Rückfall deshalb *nicht* als wiederverwendbar: der Wiederverwendungstest nimmt einen Treffer mit Hook, und die Pfadform gehört nach `## Bekannte Lücken`. Entschieden am 2026-10-29 (Orchestrator, mit dem Betreiber): den Rückfall dokumentieren, nicht `isSimpleSelector` weiten.
- **Zwei Code-Gründe, warum der heutige Builder für ein Element im Schattenbaum keinen brauchbaren Selektor liefert** (geprüft, nicht vermutet): `isTheOnlyMatch` (`background.js:3862`) fragt `document.querySelectorAll`, das nie in eine Schattenwurzel steigt — jeder Identitätskandidat wird also verworfen; `pathOf` (`:3902`) klettert über `parentElement`, das am ersten Knoten einer Schattenwurzel `null` ist — das Ergebnis ist ein Pfadstück, das vom Dokument aus nichts findet. Beides ohne Fehler, also ein `selector`, der still daneben liegt. Deshalb der eigene Builder; `describeElement` spielt keine Rolle (es wird von `inspect` gar nicht benutzt und ist nie ein Pfad).
- **Reihenfolge über Schattenbäume: die flache Dokumentreihenfolge ist keine haltbare Zusage, die zusammengesetzte ist es.** `document.querySelectorAll` und `ShadowRoot.querySelectorAll` liefern je Baum Dokumentreihenfolge; über mehrere Karten hinweg entsteht die Reihenfolge daraus, dass die Endpunkte der Vorstufe in ihrer Reihenfolge expandiert werden. Das ist deterministisch und testbar. Es ist *nicht* die Reihenfolge des shadow-including tree, sobald `slot`-Inhalte im Spiel sind (leichte Knoten bleiben im Lichtbaum, stehen optisch aber woanders). Gepinnt wird deshalb ausdrücklich „Expansionsreihenfolge der Vorstufe, je Wurzel in ihrer eigenen Reihenfolge"; der Testname sagt es, und `## Bekannte Lücken` hält die `slot`-Abweichung fest.
- **Fächerung.** 5000 Hosts × 5000 Treffer je Wurzel ist keine theoretische Zahl. Der Deckel muss auf den Endpunkten *und* den Zwischenstufen liegen, sonst hängt `inspect` an einer Seite mit vielen Komponenten; `truncated` muss das melden, weil `count` dann untere Schranke ist. Die Spec sagt dazu nichts — das ist die einzige Zahl, die dieser Plan selbst festlegt, und sie ist die vorhandene (`INSPECT_CANDIDATE_LIMIT = 5000`), keine neue.
- **`>>>` in einem Attributwert ohne Anführungszeichen** (`[title=a>>>b]`) wird geteilt, das zweite Segment fällt durch die Whitelist ⇒ `invalid_selector`, obwohl der Browser den Selektor versteht. Das ist genau das Risiko, das die Spec benennt; ein Testfall mehr macht es sichtbar, statt es zu entdecken.
- **Geschlossene Wurzel und noch nicht geladene Custom-Element-Definition sind ununterscheidbar** (`shadowRoot === null` in beiden Fällen). Beide antworten `count: 0`, wie Kriterium 4 verlangt; der Grund ist nicht berichtbar und darf nicht erfunden werden.
- **Zwei Wahrheiten für denselben Treffer.** Die Kopie des Zustellschwanzes im zweiten Schnipsel kann auseinanderlaufen; der `Object.keys`-Vergleich ist die Bremse. Wer ihn für überflüssig hält, hat die Begründung im Kommentar an der Kopie zu überschreiben.
- **`eval` darf nichts merken.** `evalPageSource` (`background.js:4429`) versendet `selectorForElement` ebenfalls; deshalb bekommt der Builder keine Parameterweiterung, sondern einen zweiten Namen, und `selectorForElement` bleibt Zeichen für Zeichen, wie er ist.

### Ordering and dependencies

- Stufe 1 vor allem anderen: ohne Schattenbäume im Doppel ist jede der drei Produktivstufen nicht prüfbar (das Muster ist im Repo schon gesetzt — `sendInspect` stand „unused until stage 2b" da).
- Stufe 2 vor 3: die Zerlegung ist die Vorbedingung der Suche, und `invalid_selector` muss fallen, **bevor** irgendetwas gefragt wird — sonst widersprechen sich Harness und echter Browser (der `matchesSelector` des Doppels wirft für Formen außerhalb seiner Grammatik; eine Suche vor der Whitelist wäre im Test rot und auf der Seite grün).
- Stufe 3 ist die große: Walk, Builder und Deckel hängen an derselben Endpunktliste; getrennt wäre Stufe 3a ein `selector`, der still daneben liegt. Blockt der Review sie als zu groß, ist der Schnitt *innerhalb* von 3: 3a Walk + Endpunkte mit `selector` weiter aus `selectorForElement` **und** einem Test, der das Feld nicht prüft, 3b Builder + Rückweg-Test.
- Stufe 4 ist von 1–3 unabhängig und könnte zuerst laufen; sie steht zuletzt, weil `CONTRIBUTING.md` (`docs/README.md`, „Reihenfolge") verlangt, dass keine Beschreibung Verhalten ankündigt, das es noch nicht gibt.
- Reihenfolge und Grenzen des Schnipsels: Zerlegung, Whitelist und Suche laufen **im Schnipsel**; die Bridge parst nichts, escapet nichts und reicht den String in `INSPECT_ARGUMENTS`-Reihenfolge weiter (`bridge/mcp.mjs:389`, `:1094`), die Extension-Seite prüft weiter nur Typen (`inspectRequestParams`, `background.js:3576`). Die einzige Entscheidung außerhalb der Seite ist der Gate in `inspectPageCode`, und der ist eine Nutzlast-Wahl, keine Zerlegung. `>>>` kreuzt nie einen Frame: `frame` (Spec 25) adressiert den Rahmen, der Sprung bleibt im selben Dokument.
- `frame` bleibt unberührt: beide Schnipsel beantworten zuerst `isAddressedFrame` und geben `not_the_frame` mit `href` zurück.

### What the next increment inherits

- **`click`, `type`, `focus`, `read` durchdringen nichts.** Ein gefundenes Schatten-Element ist nach diesem Inkrement sichtbar und mit `>>>` wiederauffindbar, aber nicht bedienbar. Die Roadmap-Zeile 16 (`docs/ROADMAP.md:62`) bleibt offen; ein eigenes Inkrement muss dort ansetzen und `selectorForElement`s Kette in `resolveElement` der drei Werkzeuge nachziehen.
- **Geschlossene Bäume bleiben unerreichbar**, ebenso `::shadow`, `/deep/`, `:host` und Slots als eigene Ebene.
- **`text`-Suche bleibt im Dokument** (Spec, `## Non-goals`).

## Open questions

**Keine offenen.** Entschieden:

1. **Rechts vom Sprung ein einfacher Selektor** (Betreiber, 2026-10-29): `my-card >>> button`,
   `#karte >>> .knopf`. Volle CSS-Selektoren wie in den DevTools sind bewusst nicht dabei —
   sie brauchen einen zweiten Parser im Schnipsel und wandern als eigene Roadmap-Zeile.
   Folge: `div span >>> b` ist `invalid_selector`, und das steht in `## Non-goals`.
2. **`>>>` gilt nicht für die Textsuche** (Orchestrator, 2026-10-29) — siehe `## Non-goals`.
3. **`read` liest keine Schatten-Inhalte** (Orchestrator, 2026-10-29) — eigene Roadmap-Zeile.

## Risiken

- **Ein zweiter Selektor-Parser im Schnipsel.** Klein gehalten (Split an `>>>`
  außerhalb von Anführungszeichen, dann eine Whitelist je Segment), aber es ist
  Neuland: jeder Fehler dort liefert `invalid_selector` für einen Selektor, den der
  Browser selbst versteht.
- **Die Reihenfolge über Schattenbäume ist nicht trivial.** `querySelectorAll` liefert sie je
  Baum; über mehrere Karten hinweg entsteht sie aus der Reihenfolge der linken Treffer.
  Gepinnt wird die **Expansionsreihenfolge der Vorstufe, je Wurzel in ihrer eigenen
  Reihenfolge** — nicht die des shadow-including tree (siehe `## Bekannte Lücken`).
- **Ein Sprung in einen Baum mit `slotted`-Inhalten** liefert die leichten Knoten
  nicht dort, wo sie optisch stehen. Die Spec sagt dazu nichts; der Test pinnt nur
  den einfachen Fall, und `## Bekannte Lücken` hält es fest.

## Touch boundary

**Der Umsetzer** fasst an: `extension/background.js`, `bridge/mcp.mjs` (nur die
Werkzeugbeschreibung), `test/extension.test.js`, `test/mcp.test.js`.

**Der Orchestrator** fasst an: diese Spec, `docs/09-dom-abfrage.md`, `docs/25-frame-handeln.md` (`:147`),
`docs/README.md`, `docs/PROJECT-STATE.md`, `docs/ROADMAP.md`.

**Nicht angefasst:** `extension/protocol.js`, `bridge/protocol.mjs`,
`bridge/{hub,websocket,http-transport}.mjs`, `extension/options.*`,
`extension/manifest.json`, `CONTRIBUTING.md`, `INSTALL.md`.

## Bekannte Lücken

Stand 2026-10-29, nach der Umsetzung:

- **Der Rückfall-`selector` ist nicht garantierbar wiederverwendbar** — sobald ein Glied der
  Kette keinen Hook und keinen eindeutigen Typ trägt, entsteht ein `>`-Pfad, den `inspect`
  beim Wiederverwenden ablehnt. Bewusst dokumentiert, nicht repariert.
- **Ein Fall pinnt den `>`-Rückfall selbst nicht** (er wird erzeugt, aber nicht geprüft).
- **`click`/`type`/`focus`/`read` durchdringen weiterhin nichts** — ein gefundenes Element
  ist sichtbar, aber nicht bedienbar.
- **Das Materialisieren der Treffer je Zwischenstufe ist ungedeckelt** (`Array.from` vor dem
  5000er-Deckel) — wie im einfachen Pfad, keine Regression, aber der Deckel begrenzt nur,
  was behalten wird.
- **Kriterium 6 ist gemessen** (2026-10-29, `## Messlauf`): Fund, Gegenprobe ohne `>>>`
  und Rundlauf auf `lit.dev`. Nicht gemessen: ein geschlossener Schattenbaum und ein
  Drei-Stufen-Sprung live.
Stand 2026-10-29, vor der Umsetzung:

- **Der Rückfall-`selector` ist nicht garantierbar wiederverwendbar.** Trägt ein Glied
  der Kette keinen Hook und keinen eindeutigen Typ, liefert der Builder ein `>`-Pfadstück
  (`html > body > …`), und den lehnt `inspect` beim Wiederverwenden ab (Verbund).
  Entschieden am 2026-10-29 (Orchestrator, mit dem Betreiber): dokumentieren statt die
  Whitelist weiten — der Rundlauf-Test nimmt einen Fall mit Hook **auf jedem Glied**.
- **Die Reihenfolge ist die Expansionsreihenfolge, nicht die des shadow-including tree.**
  Bei `slot`-Inhalten bleiben leichte Knoten im Lichtbaum und stehen optisch woanders.


## Messlauf

Noch keine Messung — Kriterium 6 ist live und nach dem Commit zu messen.
Eingetragen werden: die Seite, der Selektor mit `>>>`, die Trefferzahl mit und ohne
`>>>`, das gefundene `tag`/`text` und die Antwortzeit.

## Review

### Runde 1, 2026-10-29 — `🔧 Fix these`, Blocker: W1–W8

Der Plan steht auf gelesenem Code: `PAGE_HELPERS_CODE` trägt genau die drei Helfer,
`inspectPageSource` reist per `toString()` (ein zweiter Zweig *in* ihm hätte jede
heutige Nutzlast geändert — zwei Schnipsel sind die richtige Antwort),
`isTheOnlyMatch`/`pathOf` sind wirklich die zwei Gründe, warum der Bestandsbuilder
für ein Element in einer Schattenwurzel still daneben liegt.

Blockierend: W1 (der kopierte Pfad-Builder zählt `:nth-of-type` am Wurzelrand falsch
— jedes gleichnamige Geschwister bekäme `1`, der Selektor zeigte still auf ein
anderes Element), W2 (`tools.length` ist **12**, nicht 13), W3 (Kriterium 1
„byte-gleich" hat keinen Vergleichswert — jetzt als enthält/enthält-nicht gefasst),
W4 („Dokumentreihenfolge" gegen Expansionsreihenfolge), W5 (der 5000er-Fächerdeckel
war Plan-Erfindung ohne Spec-Satz und ohne Test), W6 (`## Open questions` enthielt
drei selbst beantwortete Punkte und blockierte damit `active`; die eine echte
Betreiberfrage — rechte Seite: einfacher Selektor oder DevTools-Verbund — wird
gestellt), W7 (Kriterium 6 versprach unbedingt einen wiederverwendbaren `selector`),
W8 (Amendments nannten für `docs/09` die falschen Stellen).

Dazu: W9 (fehlendes `trim()` — ohne es wäre `my-card >>> button`, die Schreibweise
der ganzen Spec, abgelehnt worden), W10 (der Frame-Gate im neuen Schnipsel hatte
keinen Fall), W11 (Stufe 1 nannte `pageContextOf`/`querySelectorAllInPage` nicht).
Alle übernommen; K4 (`invalid_selector` sagt nicht, warum) bleibt bewusst offen.

### Runde 2, 2026-10-29 — `🔧 Fix these`, Blocker: Y1–Y5

W1–W11 sind an der genannten Stelle nachprüfbar. Blockierend waren fünf Folgen der
Einarbeitung: Y1 (die Überschrift `## Open questions` war beim Umschreiben verloren
gegangen, ein Halbsatz brach ab, und der Entscheidungsblock hing unter
`### What the next increment inherits`), Y2 (`## Extension` sagte weiter „Je Segment
**links**" gegen die Betreiberentscheidung), Y3 (die Entscheidung „rechts auch nur
ein einfacher Selektor" hatte weder Kriterium noch Test), Y4 (W1s Fixture-Fall hatte
keine Stufe — und der Zwilling im Testdoppel, `nthOfTypeOf:8529`, zählte am
Wurzelrand genauso falsch wie der Bestands-Builder), Y5 (drei `## Testing`-Zeilen
ohne Stufe: Deckel, Geschwister, `frame`).

Klein, im selben Durchgang: Y6 (DevTools-Begründung in `## Ziel` war sachlich falsch),
Y7 (`## Extension` versprach den Rückfall weiter als wiederverwendbar), Y8 (die
Rückfall-Frage stand noch als offen beim Betreiber, obwohl `## Bekannte Lücken` sie
entschieden nennt; die Rolle des Entscheiders fehlte), Y9 (`parentNode` „bzw.
`parentElement ?? root`" — zwei Implementierungen, das Doppel kennt nur
`parentElement`), Y10 (Kriterium 1 ohne Vergleichswert, Proof-Name `…ByteForByte`
passte nicht zur Prüfung), Y11 (`### Runde 4, 2026-10-29 — `🔧 Fix these`, kein inhaltlicher Blocker

Z1–Z7 sind nachprüfbar; Z1 sitzt in allen drei Fassungen (`## Ziel` je Kettenglied,
`## Bekannte Lücken` „nicht garantierbar", Kriterium 6 nennt Treffer **und** jeden
Host). Kriterium 6 ist damit live entscheidbar, ohne bei korrektem Code rot zu werden:
die Hook-Bedingung ist Messvoraussetzung, nicht Code-Zusage; die gewählte Seite und
warum ihre Kette qualifiziert, gehören nach `## Messlauf`.

Ein mechanischer Befund: Commit `d2cb8f7` hatte beim Einfügen die falsche Spanne
ersetzt — Y11 brach mitten im Halbsatz ab, und der Dritte-Block-Absatz stand als
fettgesetzter Absatz **in** Runde 2 statt unter eigener Überschrift, dem die
Schlusszeile „der dritte teilt die Spec" direkt widersprach. Repariert: Y11 wieder
vollständig, Runde 3 hat ihre Überschrift, die Teilungsentscheidung steht dort
datiert.

Klein, Gate offen: K1 (`docs/25-frame-handeln.md` fehlte in der Touch boundary des
Orchestrators), K2 (`## Extension` sagte „fehlt ein Identitäts-Hook, bleibt der volle
Pfad" gegen Stufe 3 und `## Bekannte Lücken`), K3 (Amendments-Zeile `docs/24` „keine
Änderung"), K4 (das `docs/09`-Amendment verschwieg den Rückfall), K5 (vier
Zeilenverweise), K6 (`What could go wrong` Punkt 1 als erledigt markiert). Alle
sechs übernommen.

## Log` sagte „Noch keine Befunde").

Alle elf übernommen. **Das ist der zweite Block**; nach `CONTRIBUTING.md` Schritt 4 teilt
der dritte die Spec.

### Runde 3, 2026-10-29 — `🔧 Fix these`, Blocker: Z1

Y1–Y11 sitzen an der genannten Stelle. Blockierend war Z1: „wiederverwendbar" hing
am Treffer statt an der ganzen Kette — Kriterium 6, die Kernannahme, wäre live rot
geworden, obwohl der Code stimmt. Jetzt gilt: wiederverwendbar nur, solange **jedes**
Glied (Treffer und jeder Host) ein einfacher Selektor ist; Stufe 3 nimmt
`tag:nth-of-type(n)` als Kandidaten auf, damit `my-card:nth-of-type(1)` zulässig ist.
Dazu Z2–Z7 (Builder als fünfter Extra-Helfer, `INSPECT_PAGE_SOURCE_PIN` im Kriterium,
K4-Zeile im `## Log`, veralteter Punkt unter `What could go wrong`, Amendments auf
`docs/25:147`, Zeilenverweise).

**Dritter Block.** `CONTRIBUTING.md` Schritt 4 verlangt hier die Teilung. Sie wurde geprüft
und verworfen: der Reviewer hat festgestellt, dass es kein Zuschnitt-Problem ist
(eine Verhaltensänderung, ein Werkzeug, vier Stufen), sondern ein Satz mit falschem
Geltungsbereich, der beim Umschreiben Löcher gerissen hat. Der einzige Schnitt wäre
Stufe 1–2 (Fixture und Selektor-Parser, ohne sichtbare Wirkung) gegen Stufe 3–4; das
erste Inkrement brächte dem Agenten nichts Neues, und die Kernannahme (Kriterium 6)
läge allein in der zweiten Spec. Die Regel sieht für diesen Fall die Entscheidung des
Orchestrators mit dem Betreiber vor — entschieden am 2026-10-29, nicht geteilt.

## Log

A1 aus dem Code-Review der Stufen 1–2: `[attr=wert]` ohne Anführungszeichen — die
Spec sagt jetzt „nur zitiert", weil der Parser es so umsetzt. A2–A5 sind Kommentar- und
Doppel-Kleinigkeiten, als Follow-up notiert.

K4 nicht übernommen: `invalid_selector` sagt dem Agenten nicht, *warum* (Verbund,
leeres Segment, `[title=a>>>b]` klingen gleich). Kein Kriterium verlangt mehr, und
eine genauere Meldung wäre eine eigene Spec.

Runde 1: elf Befunde (W1–W11), alle übernommen. Runde 2: elf Befunde (Y1–Y11),
alle übernommen — darunter W1s Zwilling im Testdoppel und die Betreiberentscheidung,
dass auch rechts vom Sprung nur ein einfacher Selektor steht.
