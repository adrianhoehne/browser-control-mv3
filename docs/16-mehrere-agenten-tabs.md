---
description: Mehrere Agenten-Tabs statt einem — browser_open_tab legt einen an, jedes Werkzeug bekommt einen optionalen tab-Parameter, browser_close_tab räumt auf, browser_status markiert alle Agenten-Tabs; der Warte-Slot bleibt global.
status: active
---

# Mehrere Agenten-Tabs

Der Betreiber wollte am 2026-10-23 **drei Produktsuchen in je einem Tab** und danach
den Warenkorb **stehen lassen**. Mit einem einzigen Agenten-Tab geht beides nicht:
jede neue Seite überschreibt die vorige, und ein liegengebliebener Warenkorb ist weg,
sobald die nächste Suche beginnt.

Heute ist der Agenten-Tab **eine** Id in `storage.local` (`agentTabId`). Die
Tab-Auflösung (`readAgentTabId` → `findDefaultContainerTab`) steht in jedem Werkzeug
einzeln, und der Slot für `click`/`type` ist global.

## Ziel

Eine **Liste** von Agenten-Tabs statt einer Id, mit einer festen Obergrenze und
Werkzeugen, die einen Tab adressieren:

| Werkzeug | Neu |
|---|---|
| `browser_open_tab({url})` | legt einen Agenten-Tab an, gibt `{tabId, url, title}` zurück; Obergrenze **5** |
| `browser_close_tab({tab})` | schließt einen Agenten-Tab; der letzte darf geschlossen werden (dann gibt es keinen) |
| alle anderen (`navigate`, `read`, `click`, `type`, `inspect`, `focus`) | optionaler Parameter `tab` (numerische Id); **ohne** `tab` gilt der **zuletzt benutzte** Agenten-Tab |

- **`tab` ist die numerische Id** aus `browser_status`/`browser_open_tab`, keine
  Listenposition. Eine unbekannte Id ⇒ `no_agent_tab`.
- **Zuletzt benutzt** heißt: die Id, die zuletzt erfolgreich adressiert oder
  angelegt wurde; sie wird bei jedem Aufruf fortgeschrieben. Damit bleibt jeder
  bestehende Aufruf ohne `tab` genau so bequem wie heute.
- **Der Warte-Slot bleibt in diesem Inkrement global.** Zwei Klicks in zwei Tabs
  lösen einander also weiterhin ab (`superseded`). Ein Slot je Tab wäre eine eigene
  Nebenläufigkeits-Klasse, die im Sandkasten nicht widerlegbar ist — sie steht in
  `docs/17-slot-je-tab.md`.
- **`navigate` mit `tab`** navigiert den genannten Tab. Ein `navigate` ohne `tab`
  benutzt den zuletzt benutzten — und legt einen an, wenn es keinen gibt (wie
  heute).
- **`browser_status`** markiert **jeden** Agenten-Tab mit `agent: true` (heute ist
  es höchstens einer); Tabs, die nicht mehr existieren oder in einem anderen
  Container liegen, fallen still aus der Liste.
- **Obergrenze 5** ist Vertrag: `browser_open_tab` antwortet beim sechsten Versuch
  `too_many_tabs`, ohne einen Tab anzulegen. Der Grund ist der Betreiber-Browser,
  nicht der Speicher: fünf sind noch zu überblicken, zwanzig nicht.

## Non-goals

- **Kein Tab-Zugriff außerhalb des Default-Containers** — die Regel bleibt.
- **Keine Fenster-Verwaltung** (kein `window`-Parameter, kein Verschieben).
- **Keine Gruppen, keine Pinning-Steuerung, keine Titel-Vergabe.**
- **Kein Zugriff auf Betreiber-Tabs**: nur Ids, die in der Liste stehen, sind
  adressierbar. Eine fremde Id ⇒ `no_agent_tab`, nicht „fremder Tab".
- **Keine Änderung an der Ruhe-Erkennung, am Fehlerpfad (`page_busy`, `kind`) oder
  an den Ergebnisfeldern** außer `agent: true` an mehreren Tabs.
- Keine neue Berechtigung.

## Wire-Protokoll

Neue Methoden `open_tab` und `close_tab` in `PROTOCOL.METHODS`, beide Seiten.

```json
{"method":"open_tab","params":{"url":"https://…"}}      → {"tabId":31,"url":"…","title":"…"}
{"method":"close_tab","params":{"tab":31}}              → {"tabId":31,"closed":true}
```

- `open_tab` ohne `url` ⇒ `invalid_params`. Nur `http(s)`, wie `navigate`.
- `close_tab` ohne `tab` ⇒ schließt den zuletzt benutzten.
- Neue Codes: `too_many_tabs` (nur `open_tab`).
- Alle bestehenden Methoden: zusätzliches optionales `tab` (positive ganze Zahl);
  ein falscher Typ ⇒ `invalid_params`.
- Ergebnisse ändern sich **nicht** in ihrer Form.

## MCP-Werkzeug

| Werkzeug | Eingabe |
|---|---|
| `browser_open_tab` | `{url}` (Pflicht) |
| `browser_close_tab` | `{tab?}` |
| bestehende sechs | zusätzlich `tab?` |

Sätze: `too_many_tabs` ⇒ „Five agent tabs are already open — close one first."
(englisch seit `docs/54`). `no_agent_tab` bleibt der heutige Satz.

## Hub

`open_tab`/`close_tab` bekommen je **eine** Zeile in der Form der bestehenden
(`open tab=… url=…`, `close tab=…`) — **ohne** Titel und ohne Seitentext. Sonst
bleiben die Logzeilen unverändert. Die zwei Zweige sind Pflicht, nicht Kür:
`#reportResult` schreibt für eine unbehandelte Methode **nichts**, ein fehlender
Zweig macht `close_tab` unsichtbar. Der Warte-Slot bleibt **global** (Spec 17 nimmt
sich den Slot je Tab vor); der Hub ist deshalb unverändert.

## Extension

- `storage.local` führt `agentTabIds` (Liste) **statt** `agentTabId`.
  **Migration:** existiert nur der alte Schlüssel, wird sein Wert zur Ein-Element-Liste
  und der alte Schlüssel gelöscht — beim ersten Lesen, ohne eigenen Schritt. Der Wert
  wird dabei **typgeprüft** (`Number.isInteger`), sonst gilt er als nicht vorhanden.
  **Sonderfall:** eine vorhandene **leere** Liste und ein gültiger alter Wert ⇒ der
  alte Wert gewinnt (sonst verlöre der Betreiber seinen Tab an eine abgebrochene
  Migration). Liegt der alte Schlüssel ohne Liste vor, gewinnt immer der alte Wert.
- **Alle Listenänderungen laufen durch dieselbe Warteschlange** wie die
  Tab-Auflösung (`enqueueTabResolution` → `enqueueTabStore`): zwei gleichzeitige
  Aufrufe dürfen einander die Liste nicht überschreiben (Lesen-Ändern-Schreiben).
- `resolveAgentTab(tabIdOrNothing)` an **einer** Stelle ersetzt die heutige
  Auflösung. Sie steht heute **fünfmal** kopiert (`readAgentTabPage`,
  `clickAgentTab`, `typeAgentTab`, `inspectAgentTab`, `focusAgentTab`) plus einmal
  in `navigate` (`resolveAgentTab(url)`); mit zwei neuen Werkzeugen wären es
  **sieben**.
- `agentTabIds` wird bereinigt: Ids, deren Tab verschwunden ist oder in einem
  anderen Container liegt, fallen heraus (beim Lesen, nicht per Ereignis). Auch
  `navigate` ohne `tab` **entfernt** die veraltete Id, wenn es deshalb einen neuen
  Tab anlegt — sonst wächst die Liste bis an die Grenze.
- `open_tab`: prüft die Obergrenze **vor** dem Anlegen — und zwar über die
  **bereinigte** Liste (`pruneAgentTabIds`), sonst blockieren fünf tote Ids das
  Anlegen für immer; öffnet im Default-Container, trägt ein, macht es zum zuletzt
  benutzten. Der ganze Vorgang läuft in der Warteschlange: zwei gleichzeitige
  `open_tab` dürfen die Grenze nicht überschreiten (Prüfen-und-Handeln ist sonst ein
  Rennen, `answerRequest` verarbeitet Anfragen nebenläufig).
- `close_tab`: schließt und entfernt aus der Liste; ist es der zuletzt benutzte,
  rückt der nächste Eintrag nach.

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `test/protocol.test.js` — `METHODS.OPEN_TAB`, `METHODS.CLOSE_TAB` | in beiden Kopien wörtlich |
| `open_tab` mit `url` | legt an, Antwort `tabId`/`url`/`title`, Liste wächst |
| `open_tab` beim sechsten Versuch | `too_many_tabs`, Liste unverändert, **kein** neuer Tab (Zähler) |
| `open_tab` ohne `url` | `invalid_params` |
| `open_tab` mit `ftp:`-Adresse | `invalid_url` (der bestehende Code aus `navigate`) |
| zwei gleichzeitige `open_tab` bei vier Tabs | genau **fünf** Tabs, der zweite antwortet `too_many_tabs` — nicht sechs |
| `click` in Tab A, gleichzeitig `open_tab` | keiner verliert seine Listenänderung — **Regressionswächter, keine Reproduktion**: der Fall wird nicht rot, wenn man `enqueueTabStore` zu einem Passthrough macht, weil der Code die Liste häufig genug neu liest (vom Reviewer bestätigt) |
| `close_tab` mit `tab` | schließt, Liste schrumpft |
| `close_tab` ohne `tab` | schließt den zuletzt benutzten; danach rückt der vorige nach |
| `close_tab` mit fremder Id | `no_agent_tab`, nichts geschlossen |
| `read`/`click`/`type`/`inspect`/`navigate`/`focus` mit `tab` | adressieren **genau** diesen Tab (Beleg: `tabs.executeScript`-Aufruf trägt die Id) |
| ohne `tab` | der zuletzt benutzte; nach `open_tab` ist das der neue |
| `tab: "31"` (String), `tab: 0`, `tab: -1` | `invalid_params` |
| `click` in Tab A, danach `click` in Tab B | der zweite folgt dem **globalen** Slot: der erste antwortet `superseded` (unverändert zu heute) |
| `status` mit drei Agenten-Tabs | drei Tabs mit `agent: true`, **jeder** genau einmal |
| `status`, nachdem einer geschlossen wurde | nur noch die übrigen markiert |
| Migration: nur `agentTabId` gespeichert | wird zur Liste, alter Schlüssel weg, `read` funktioniert |
| Migration: leere Liste **und** gültiger alter Wert | der alte Wert gewinnt (kein Tab verloren) |
| Migration: `agentTabId` mit Nicht-Integer | gilt als nicht vorhanden |

## Acceptance criteria

1. `npm test; echo $?` → `0`, `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. Die 331 bestehenden Fälle laufen bis auf die im Diff
   benannten unverändert (erwartet: `status`-Fälle, die einen markierten Tab prüfen,
   und die vier kopierten Tab-Auflösungen, die durch `resolveAgentTab` ersetzt
   werden) — am Diff geprüft und im Bericht namentlich genannt.
2. `browser_open_tab` legt einen zweiten Tab an; `browser_status` zeigt danach
   **zwei** mit `agent: true`.
3. `browser_read` mit `tab` liest den genannten Tab, `browser_read` ohne `tab` den
   zuletzt benutzten; Beleg ist die jeweilige `tabId` in der Antwort.
4. Zwei `click` in **zwei verschiedenen** Tabs lösen einander weiterhin ab (der
   globale Slot, unverändert zu heute) — der Slot je Tab ist Spec 17.
5. Der sechste `open_tab` antwortet `too_many_tabs` und legt nichts an — auch bei
   zwei **gleichzeitigen** Aufrufen, geprüft über die Warteschlange.
6. **Live-Beleg:** drei Suchen in drei Tabs, danach steht der Warenkorb-Tab noch —
   der Fall, der den Betreiber ursprünglich zu dieser Zeile gebracht hat.

**Kriterien 2–5 sind Testfälle**, keine Live-Messungen (die Stufen nennen sie
namentlich); nur Kriterium 6 braucht den echten Browser.

**Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 6 ist erst
nach Reload und Neustart messbar. Kriterien 1–5 laufen vor dem Commit; rot bei 6
heißt vorwärts korrigieren, und die rote Zeile steht unter `## Bekannte Lücken`. Ist
die **Kernannahme** widerlegt (Tabs lassen sich nicht unabhängig adressieren), geht
das Inkrement zurück in diese Spec.

## Bekannte Lücken

Noch keine — der Live-Beleg zu Kriterium 6 steht aus.

## Dev plan

1. **Protokoll (kein Verhalten).** `bridge/protocol.mjs` und `extension/protocol.js`:
   `METHODS.OPEN_TAB = "open_tab"` und `METHODS.CLOSE_TAB = "close_tab"`, in beiden
   Kopien angehängt und in gleicher Reihenfolge. `TOO_MANY_TABS_CODE = "too_many_tabs"`
   bleibt **lokal** in `extension/background.js` — kein Fehlercode steht heute im
   Protokoll.
   Proof: `node --test --test-reporter=tap test/protocol.test.js` → `# fail 0`, dazu
   zwei neue Fälle, die beide Methodennamen wörtlich prüfen.
   **Completed 2026-10-23** (zusammen mit Stufe 2) — 10 Fälle im Protokoll,
   337 Tests grün.
2. **Speicher: Liste, Migration, Prune.** `AGENT_TAB_IDS_KEY = "agentTabIds"`; neu
   `readAgentTabIds()`, `storeAgentTabIds(ids)`, `markAgentTabLastUsed(tabId)`,
   `pruneAgentTabIds(ids)`; `readAgentTabId()`/`storeAgentTabId(tabId)` bleiben
   vorerst als dünne Wrapper, damit in dieser Stufe kein Aufrufer wandert. **Neu ist
   hier auch `enqueueTabStore(fn)`** (Umbenennung von `enqueueTabResolution`): jede
   Änderung an `agentTabIds` läuft hindurch, damit zwei gleichzeitige Aufrufe einander
   nicht überschreiben. Testseite:
   `storage.local` bekommt `remove(keys)`.
   - **„Zuletzt benutzt" lebt in der Listenreihenfolge** (letztes Element). Ein
     Schlüssel statt eines zweiten Wahrheitsstands; `markAgentTabLastUsed` schreibt
     nur, wenn die Id nicht schon die letzte ist. `storage.local` statt
     Modulzustand, weil ein ausgesetzter Hintergrund sonst bei jedem `navigate`
     ohne `tab` einen zweiten Tab anlegte.
   - **Migrationstrigger ist `readAgentTabIds()`**: `get(["agentTabIds","agentTabId"])`;
     ein **nicht-leeres** Array gewinnt; ein **leeres** nur, wenn der alte Wert fehlt
     oder ungültig ist. Sonst wird `[agentTabId]` geschrieben und der alte Schlüssel
     entfernt. **Beide Schlüssel vorhanden ⇒ die Liste gewinnt (wenn nicht leer), der
     alte Schlüssel wird trotzdem entfernt.** `set`/`remove` in
     `try/catch` mit fester `bc:`-Zeile; die Migration ist idempotent.
   - **Prune nur auf dem Werkzeugpfad**, nicht in `collectStatus` (Stufe 6).
   Proof: `node --test --test-reporter=tap test/extension.test.js` → `# fail 0`,
   `# cancelled 0`; im Diff nur die vier Zusicherungen `get(["agentTabId"])` →
   `get(["agentTabIds"])`, alle `settings: {agentTabId: 500}` laufen durch die
   Migration. Neuer Fall
   `status_withOnlyTheOldAgentTabIdKey_shouldMigrateToTheListAndDropTheOldKey`.
   **Completed 2026-10-23** — vier Migrationsfälle, 337 Tests grün.
   **Hinweis für Stufe 3:** die vier genannten Navigationsfälle pinnen die Liste
   vorläufig als `[500, 501]`, weil die veraltete Id erst ab Stufe 3 bereinigt wird;
   Stufe 3 muss sie erneut anfassen.
3. **Eine Tab-Auflösung, `tab` an sechs Werkzeugen.** `resolveAgentTab(tabIdOrNothing)`
   an einer Stelle; der heutige `navigate`-eigene `resolveAgentTab(url)` wird zu
   **`resolveNavigationTarget(url, tabIdOrNothing)`** — die Namenskollision ist der
   Punkt, an dem diese Stufe sonst still kaputtgeht. Neu `requestTabId(params)`
   (positive ganze Zahl, sonst `invalid_params` im Fehlertyp des Werkzeugs);
   `focusRequestParams` erlaubt genau `{tab?}`.
   - `navigate` **mit** `tab` legt keinen Tab an: scheitert `tabs.update`, antwortet
     es `no_agent_tab`; der Fallback `createAgentTab` gilt nur ohne `tab`.
   - `navigate` **ohne** `tab` bei leerer Liste legt an und trägt ein (wie heute).
   - `focus` ohne `tab` heißt weiter „zuletzt benutzt"; mit `tab` genau diesen.
   Proof: `read_withTab_shouldReadThatTab`, `click_withTab_shouldClickInThatTab`,
   `type_withTab_shouldTypeIntoThatTab`, `inspect_withTab_shouldInspectThatTab`,
   `focus_withTab_shouldFocusThatTab`, `navigate_withTab_shouldUpdateThatTab`,
   `read_withoutTab_shouldReadTheLastUsedTab` (Beleg je Fall:
   `tabs.scriptCalls[0].tabId`), `read_withATabThatIsNotInTheList_shouldAnswerNoAgentTab`,
   `read_withTabAsAString_shouldAnswerInvalidParams` (ebenso `0`, `-1`).
   **Completed 2026-10-23** (zusammen mit Stufe 5) — 23 Fälle im Muster,
   351 Tests grün. Drei Navigationsfälle pinnen jetzt die bereinigte Liste.
   Unverändert grün bleiben `focus_withAnUnexpectedParameter_shouldAnswerInvalidParams…`
   und ihr Zwilling — sie schicken `{tabId: 101}`, und `tabId` ist **nicht** der
   Wire-Name; sie bleiben als Stolperdraht stehen.
4. **`open_tab` / `close_tab`.** `answerOpenTab`/`answerCloseTab`,
   `openAgentTab(params)`, `closeAgentTab(params)`, `openRequestUrl(params)` (nur
   `http(s)`), `AGENT_TAB_LIMIT = 5` **vor** `createAgentTab`. Testseite:
   `createTabsStub.remove(tabId)`.
   - **`open_tab` wartet auf `complete`, nicht auf Ruhe** (`waitForTabComplete`,
     eingetragen im Slot des neuen Tabs): auf `open_tab` folgt ein `read`, und das
     darf nicht `page_busy` kosten. Antwort drei Felder, Deckel
     `NAVIGATE_TIMEOUT_MS`, danach `ok:true` mit dem, was der Tab meldet.
   - **`close_tab`**: `tabs.remove` → aus der Liste; war es die
     letzte Id, rückt der vorige Eintrag nach. Fremde Id ⇒ `no_agent_tab`, kein
     `tabs.remove`.
   Proof: `openTab_shouldCreateAnAgentTabAndAnswerTabIdUrlTitle`,
   `openTab_asTheSixthTab_shouldAnswerTooManyTabsAndCreateNothing`,
   `openTab_withoutUrl_shouldAnswerInvalidParams`,
   `openTab_withAnFtpUrl_shouldAnswerInvalidUrl`,
   `closeTab_withTab_shouldCloseAndShrinkTheList`,
   `closeTab_withoutTab_shouldCloseTheLastUsedAndMoveToThePrevious`,
   `closeTab_withAnUnknownTab_shouldAnswerNoAgentTabAndRemoveNothing`, dazu
   `openTab_twiceAtOnceAtFourTabs_shouldCreateExactlyFiveAndAnswerTooManyTabsOnce`
   (genau fünf Tabs, nicht sechs), `openTab_afterTheBrowserRestart_shouldPruneTheDeadIdsAndCreateATab`
   und `read_whenTheLastUsedTabIsGone_shouldPruneItAndReadTheNextLiveOne` — die Lücke,
   die der vorige Lauf gemeldet hatte.
   **Completed 2026-10-23** — 9 Fälle, 364 Tests grün, keine Bestandserwartung
   geändert. Der Fall `clickAndOpenTabAtOnce_shouldNotLoseEitherListChange` ist ein
   **Regressionswächter, keine Reproduktion**: er wird nicht rot, wenn man
   `enqueueTabStore` zu einem Passthrough macht, weil der Code die Liste häufig genug
   neu liest. Steht so im Bericht, damit niemand ihn für einen Beweis hält.
5. **`status` markiert jeden Agenten-Tab.** `readAgentTabIds()` (Migration ja,
   **Prune nein** — die Fensterliste ist die Wahrheit, eine tote Id markiert von
   selbst nichts, `status` bleibt so billig wie heute);
   `toWindowSummary(window, agentTabIds)` und `toTabSummary(tab, agentTabIds)` mit
   `agent: agentTabIds.has(tab.id)`. Die Arrow-Form bleibt — `map` würde den Index
   als Menge übergeben.
   Proof: `status_withThreeAgentTabs_shouldMarkEachExactlyOnce`,
   `status_afterOneWasClosed_shouldMarkOnlyTheRemaining` (geschlossen über
   `createTabsStub.remove(tabId)`, **nicht** über `close_tab` — Stufe 5 hängt nicht
   an Stufe 4); unverändert
   `status_withAStaleAgentId_shouldMarkNoTab`, `…InAContainerTab…`,
   `status_whenTheSettingsReadFails_shouldStillAnswer`.
   **Completed 2026-10-23** — `status` markiert über ein `Set`, ohne zu bereinigen.
6. **Hub: zwei Logzeilen.** `formatOpenTabLine(result)` → `open tab=42 url=https://…`,
   `formatCloseTabLine(result)` → `close tab=42` — Id aus dem **Ergebnis**, weil
   `close_tab` ohne `tab` den zuletzt benutzten schließt. Zwei Zweige mit `return`,
   **kein** `#logDebugResult` (sonst stünde der Titel im Debug-Log).
   `test/fixtures/fake-extension.mjs`: `OPEN_TAB_RESULT`, `CLOSE_TAB_RESULT`, zwei
   Dispatch-Zweige.
   Proof: `node --test --test-reporter=tap test/hub.test.js test/bridge.test.js` →
   `# fail 0`, zwei neue Fälle, die die Zeilen wörtlich vergleichen und belegen, dass
   weder Titel noch Seitentext darin stehen. **Completed 2026-10-23** — die Id kommt
   aus dem Ergebnis, damit `close_tab` ohne `tab` überhaupt sichtbar ist.
7. **MCP: neun Werkzeuge.** `BROWSER_OPEN_TAB`/`BROWSER_CLOSE_TAB` **angehängt, nie
   eingefügt** (die Positionen 0–6 sind gepinnt); `TAB_PROPERTY = Object.freeze({type:"integer", minimum:1})`
   **einmal** per Referenz in sieben `inputSchema.properties`; `TAB_ARGUMENTS`,
   `hasDeclaredTabArgument`, `tab` in `TYPE_ARGUMENTS` und `INSPECT_ARGUMENTS`,
   `hasNoArguments` für `read`/`focus` → „nur `tab` erlaubt", neue
   `UNEXPECTED_ARGUMENTS`-Sätze, `TOOL_TEXTS.TOO_MANY_TABS`, zwei Zweige in
   `extensionFailureText`.
   Proof: `node --test --test-reporter=tap test/mcp.test.js` → `# fail 0` mit
   `tools.length === 9`, der neuen Namensliste und je einem Fall für `open_tab`
   (Erfolg, `too_many_tabs`) und `close_tab`. **Completed 2026-10-23** — 76 Fälle im MCP-Test,
   Gesamt 371 grün. **Grenze:** die Fake-Extension protokolliert keine Request-Params,
   der `{tab}`-Fall beweist also nur „wird nicht abgelehnt und geht raus", nicht die
   Weiterleitung selbst.

### What could go wrong

- **Die Umbenennung aus Stufe 3 ist Pflicht, nicht Kosmetik.** Bliebe
  `resolveAgentTab(url)` stehen und die neue Auflösung hieße genauso, überschriebe
  die letzte Definition die erste — und `navigate` legte bei jedem Aufruf einen Tab
  an. Stufe 3 ist erst fertig, wenn
  `navigate_withAStoredLiveTab_shouldUpdateThatTabInsteadOfCreatingANewOne`
  unverändert grün ist.
- **Die Migration ist unumkehrbar.** Eine zurückgerollte Extension findet ihre Id
  nicht wieder; sichtbar als „der Agenten-Tab ist weg". Wirft `set`, bleibt der alte
  Schlüssel liegen und die Migration wiederholt sich — deshalb gewinnt die Liste.
- **Persistenz rettet keinen Browser-Neustart.** Firefox vergibt Tab-Ids neu; die
  Liste wird beim ersten Lesen leer geprunt und `read` ohne `tab` antwortet
  `no_agent_tab` — wie heute. Was `storage.local` rettet, sind das Neuladen der
  Extension und das Aussetzen des Hintergrunds.
- **Zwei Kopien der `too_many_tabs`-Meldung** (Extension und Bridge) werden von beiden
  Suiten gepinnt, damit sie nicht still auseinanderlaufen — sie sind von Hand
  gleichgehalten, nicht aus einer Quelle erzeugt.
- **Testzahl:** `npm test` meldet 331; die Zählung per `grep -c '^test('` findet 319,
  weil zwölf Fälle tabellengeneriert sind. Maßgeblich ist der Runner. Kriterium 1 ist
  deshalb über `# fail 0`/`# cancelled 0` **und** die namentliche Liste der
  geänderten Fälle zu prüfen, nicht über eine absoluten Zahl.
- **Kriterium 6 ist kein Testfall.** Drei Suchen in drei Tabs und ein stehender
  Warenkorb sind nur im echten Profil entscheidbar.

### Ordering and dependencies

1 → 6, 1 → 7; **2 → 3 → 6 → 4 → 7**; 2 → 5. Stufe 6 (Hub) läuft vor Stufe 4, damit
die zwei neuen Zeilen stehen, bevor die Methoden benutzbar sind. Nach jeder Stufe
`npm test` grün. Stufe 2 tauscht nur den Speicher und hält alles am Laufen, 3
sammelt die Auflösung ein, 4 legt die neuen Methoden darauf, 5 ist von 3 unabhängig
(liest nur). Kein Fall muss umgeschrieben werden außer den vier
namentlich genannten Zusicherungen in Stufe 2 und `tools.length` in
`test/mcp.test.js`.

### What the next increment inherits

- Obergrenze 5 ist eine Konstante; `too_many_tabs` ist der einzige neue Code und
  steht in `extension/background.js`, nicht im Protokoll.
- `type` behält seine 300 ms, `focus`/`inspect` warten nicht; `open_tab` wartet auf
  `complete`, nie auf Ruhe.
- `status` pruned nicht. Nur Ids aus `agentTabIds` sind adressierbar; ein fremder
  Betreiber-Tab bleibt `no_agent_tab`, und `navigate` mit explizitem `tab` legt nie
  einen Ersatz an.
- Kein Fenster-Parameter, keine Container außer `firefox-default`, keine neue
  Berechtigung.

## Risiken

- **Fünf Tabs sind viel für einen Betreiber-Browser.** Die Obergrenze ist der
  Kompromiss; sie ist Vertrag, nicht Konfiguration.
- **`storage.local` ist die einzige Wahrheit über die Liste.** Ein Tab, der von Hand
  geschlossen wird, fällt erst beim nächsten Lesen heraus — bis dahin schlägt ein
  Aufruf darauf mit `no_agent_tab` fehl, was die richtige Auskunft ist.
- **Nebenläufigkeit entsteht trotzdem**, nur an anderer Stelle: zwei gleichzeitige
  `open_tab` (oder `open_tab` neben einem `click`) teilen sich `agentTabIds`. Deshalb
  läuft jede Listenänderung durch dieselbe Warteschlange; ohne sie wäre die Grenze
  von 5 eine Empfehlung und die Liste verlöre Einträge.
- **`agentTabIds` wächst nicht von selbst zurück.** Wer Tabs öffnet und nie schließt,
  läuft in `too_many_tabs`; das ist die gewollte Bremse.
- **Migration ist unumkehrbar.** Nach dem ersten Lesen gibt es nur noch die Liste.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine neue Berechtigung, kein Seitentext in
  Logs, Tests, Fixtures oder Doku.
- `bridge/websocket.mjs`, `bridge/config.mjs`, `extension/manifest.json`,
  `extension/options.*` bleiben unverändert; `bridge/hub.mjs` nur, wenn die zwei
  Logzeilen es verlangen.
- `docs/PROJECT-STATE.md`, `docs/README.md`, `docs/ROADMAP.md` und `INSTALL.md`
  pflegt der Orchestrator.

## Open questions

Keine. Der Betreiber hat die Zeile am 2026-10-23 gewählt („drei Produktsuchen in je
einem Tab, Warenkorb stehen lassen"); Obergrenze 5, `tab` als numerische Id und der
zuletzt benutzte Tab als Vorgabe sind mit ihm als Zuschnitt festgelegt.

## Review

Noch keine Runde.

## Log

Noch keine Befunde.

Befunde beim Schreiben des Dev-Plans (2026-10-23), vom Architekten:

- **Namenskollision in Stufe 3:** der heutige `navigate`-eigene `resolveAgentTab(url)`
  und die neue gemeinsame Auflösung hätten denselben Namen getragen; die letzte
  Definition gewinnt, und `navigate` hätte bei jedem Aufruf einen Tab angelegt.
  Die alte Funktion heißt jetzt `resolveNavigationTarget`. **Übernommen.**
- **„Zuletzt benutzt" gehört in die Listenreihenfolge**, nicht in einen zweiten
  Schlüssel — ein Wahrheitsstand weniger, kein Extra-Schreibvorgang, und das
  Nachrücken beim Schließen fällt gratis heraus. **Übernommen.**
- **Die Testzahl 331 ließ sich per `grep` nicht bestätigen** (319). Der Runner ist
  maßgeblich; zwölf Fälle sind tabellengeneriert. **Kriterium 1 prüft daher
  `# fail 0`/`# cancelled 0` und die namentliche Liste, nicht die Zahl.**

**Runde 1 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Elf Befunde, alle
übernommen — der zweite hat das Inkrement geteilt:

1. **Die Zahl der kopierten Tab-Auflösungen war falsch** („viermal") — es sind fünf
   plus `navigate`, nach diesem Inkrement sieben. **Korrigiert**, auch in Kriterium 1.
2. **Der Slot je Tab war nicht widerlegbar** — ein Fake kann „Firefox trägt zwei
   gleichzeitige Injektionen" nicht falsifizieren, und Kriterium 6 ist sequenziell.
   **Abgetrennt als `docs/17-slot-je-tab.md`**, mit einem Live-Kriterium. Acht Stufen
   werden sieben, der Slot bleibt hier global.
3. **`too_many_tabs` war ein Prüfen-und-Handeln-Rennen** — `answerRequest` arbeitet
   nebenläufig, zwei `open_tab` bei vier Tabs hätten sechs ergeben. Läuft jetzt durch
   dieselbe Warteschlange (`enqueueTabResolution` → `enqueueTabStore`), mit Fall.
4. **Verlorene Listenänderung:** Lesen-Ändern-Schreiben auf `agentTabIds` — jede
   Änderung geht jetzt durch dieselbe Warteschlange, mit Fall.
5. **Kriterien 2–5 waren als Live-Aufrufe formuliert**, obwohl die datierte Ausnahme
   nur 6 deckt — sie sind jetzt Testfälle, nur 6 ist live.
6. **`## Hub` widersprach sich** („keine neue Logzeile" zwei Sätze vor den zwei
   Zeilen) — korrigiert, und Stufe 6 läuft jetzt **vor** Stufe 4, samt der Falle, dass
   `#reportResult` für eine unbehandelte Methode nichts schreibt.
7. **Die Testing-Tabelle sagte bei `ftp:` `invalid_params`**, Stufe 4 und der
   Wire-Abschnitt sagen `invalid_url` — die Tabelle war falsch.
8. **Die Migration konnte den Tab des Betreibers fressen** (leere Liste gewinnt gegen
   einen gültigen alten Wert) — Sonderfall ergänzt, Typprüfung ergänzt.
9. **Die Grenze zählte ungeprüfte Ids** — `open_tab` zählt die bereinigte Liste, und
   `navigate` ohne `tab` entfernt die veraltete Id.
10. **`TAB_PROPERTY` per Referenz** ist sicher, weil die Tabelle tief gefroren ist —
    steht jetzt als Satz dabei.
11. **`close_tab` ohne `tab`** bleibt auf dem Draht optional; im MCP-Schema bleibt es
    ebenfalls optional, damit ein Aufruf ohne `tab` nicht plötzlich ein Fehler ist.

**Runde 2 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Sieben Befunde, alle
übernommen — der erste war der klassische:

1. **Vier Geister des abgetrennten Slots** standen noch im Text (Frontmatter, `## Hub`,
   `## Extension`, `## Risiken`) und **forderten** die Arbeit, die Spec 17 gehört.
   **Entfernt**; der Text sagt jetzt an allen vier Stellen „Slot bleibt global".
2. **Die Reihenfolge widersprach sich** („2 → 3 → 4 → 6 → 7" gegen „Stufe 6 vor
   Stufe 4") — jetzt `2 → 3 → 6 → 4 → 7`.
3. **Zwei deklarierte Testfälle hatten keine Stufe** (die zwei Nebenläufigkeitsfälle)
   und `enqueueTabStore` kam nur im Fließtext vor — beides in Stufe 2 bzw. 4 verankert.
4. **Die Migration widersprach sich**: ein leeres Array *ist* ein Array, also hätte es
   gegen einen gültigen alten Wert gewonnen. Jetzt: ein **nicht-leeres** Array gewinnt.
5. **Stufe 5 hing an Stufe 4** (`status_afterOneWasClosed…`) — der Fall schließt jetzt
   über `createTabsStub.remove(tabId)`.
6. **Spec 17s Aufruferliste** nannte `answerCloseTab` nicht — ergänzt.
7. **`TAB_PROPERTY`** wird in Stufe 7 ausdrücklich mit `Object.freeze` erzeugt.

Dazu ein `## Amendments`-Abschnitt gegen Spec 04, 12 und 15.

## Messlauf (Kriterium 6, 2026-10-23, live)

Nach Reload der Extension und Neustart von pi, im echten Profil:

- **Drei Tabs angelegt** (`browser_open_tab`): Tab 4 (Wikipedia), 5 (Qwant), 6
  (clever-fit). Jede Antwort trug `tabId`/`url`/`title`.
- **`browser_status` markierte vier** Tabs mit `agent: true` (3, 4, 5, 6) — der
  vorherige Agenten-Tab und die drei neuen. Die Markierung ist also **mehrfach**, wie
  zugesagt.
- **Unabhängig adressierbar:** `browser_read` mit `tab: 4` → 20 000 Zeichen
  (Wikipedia), mit `tab: 5` → 959 Zeichen (Qwant), mit `tab: 6` → 9 664 Zeichen
  (clever-fit). Jede Antwort nennt die Id, die adressiert wurde.
- **Schließen lässt die anderen stehen:** `browser_close_tab({tab:5})` →
  `{tabId:5, closed:true}`; danach waren 3, 4 und 6 markiert.
- **Obergrenze greift:** aufgefüllt bis fünf Tabs (3, 4, 6, 7, 8), der sechste
  antwortete „Es sind schon fünf Agenten-Tabs offen — erst einen schließen." (so die Antwort damals; englisch seit `docs/54`)
- **`close_tab` ohne `tab`** schloss den zuletzt benutzten (8).
- Aufgeräumt: drei Tabs bleiben, davon einer markiert.

**Damit ist der Fall gelöst, der den Betreiber zu dieser Zeile gebracht hat:** drei
Suchen nebeneinander, jede in ihrem Tab, und keine überschreibt die andere.

**Nachtrag 2026-10-23 (Spec 17):** Der Warte-Slot ist **nicht mehr global**. Er ist eine
`Map` mit der Tab-Id als Schlüssel, `close_tab` löst den Slot seines Tabs ab, und zwei
Klicks in zwei Tabs lösen einander nicht mehr ab. Damit sind die Stellen in dieser Spec,
die „Slot bleibt global" sagen, überholt.
