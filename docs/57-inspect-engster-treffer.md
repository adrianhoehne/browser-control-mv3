---
description: browser_inspect liefert bei einer Textsuche den engsten Treffer statt der Containerseite und zählt ihn in count; selector allein und includeHidden bleiben roh — Teil a der Teilung vom 2026-11-23.
status: active
---

# `inspect` findet den engsten Treffer, Teil a — die Regel

**Geteilt am 2026-11-23.** Der Gate hat die Spec in Runde 4 zum vierten Mal
blockiert; `CONTRIBUTING.md`, Schritt 4, verlangt dann einen Schnitt. **Teil a**
(diese Spec) ändert, *was* `inspect` bei einer Textsuche liefert. **Teil b**
(`docs/62`) fügt das Feld `offscreen` in beiden Quellen hinzu.

## Anlass

Zwei Messungen vom 2026-11-23 aus dem Export `2026-11-23_conversations.zip`.

**Beleg 1 — die Containerseite gewinnt.**
`browser_inspect({text:"In den Einkaufswagen", limit:10})` (Lauf 16:00) antwortete
mit `count: 671`, `truncated: true` und zehn gelieferten Elementen. Die ersten
sieben waren `div#a-page`, `div#search`, `div.s-desktop-width-max…`,
`div.sg-col-4-of-4…`, `div.sg-col-inner`, `span.rush-component` und
`div.s-main-slot`. Der gesuchte Artikel erschien erst ab `index: 7`. Das Modell
zerlegte danach sechs `browser_eval`-Aufrufe darauf, den Knopf per
`innerText`-Vergleich zu finden; alle gaben `false` zurück.

**Beleg 2 — dasselbe mit einem starken Modell.**
`browser_inspect({text:"Andere Verkäufer", limit:20})` in der Sitzung
`2026-11-23T16-45-24` (`deepseek-flash`) lieferte `index 0: div#a-page` bei
`truncated: true`. Das Modell wechselte danach auf `fetch()` plus `DOMParser` in
`browser_eval`.

**Ursache, im Code nachgesehen.** In `inspectPageSource`
(`extension/page-agent.js:730`) sind die Kandidaten `body.querySelectorAll("*")` in
Dokumentreihenfolge, gefiltert über `isVisible` und
`textOf(candidate).toLowerCase().indexOf(needle) === -1` (Schleife `:835-849`,
`indexOf` in `:844`). Ein Vorfahre enthält den Text jedes Nachfahren und steht in
der Dokumentreihenfolge früher. Mit `limit: 10` füllt deshalb der Weg von oben die
Liste, nicht das Ziel.

**Hinweis zu den Namen.** Die Belege zitieren die Aufrufe, wie sie am 2026-11-23
lauteten. Das Argument `text` heißt seit `docs/59` `contains_text`; die Zitate
bleiben unverändert, weil sie Messungen sind.

## Ziel

1. Ein Treffer entfällt, wenn einer seiner Nachfahren ebenfalls trifft. Übrig
   bleibt der engste Treffer. Beispiel: `div#a-page > … > span.a-button-text`
   liefert nur `span.a-button-text`.
2. `count` zählt diese engsten Treffer, nicht mehr alle Elemente, deren Text den
   Suchbegriff enthält.
3. Die Reihenfolge bleibt Dokumentreihenfolge; `elements` trägt weiter `index`.
   `limit` und `truncated` behalten ihre Bedeutung aus `docs/09`. Bei erreichtem
   Kandidatendeckel bleibt `count` eine Untergrenze **der engsten** Treffer.
4. **Die Regel gilt nur bei einer Textsuche** — `contains_text` allein oder
   `selector` plus `contains_text`. Ein Aufruf mit `selector` **allein** bleibt,
   wie `docs/09` ihn beschreibt: alle Treffer, auch die Vorfahren. Der Grund: Wer
   einen Selektor nennt, kennt das Markup und will die Liste sehen; wer Text
   sucht, kennt das Markup nicht und braucht das Ziel.
5. **Zwei Ausnahmen.**
   - Ein leerer Suchbegriff passt weiter auf jedes sichtbare Element (`docs/09`);
     die Regel greift dort nicht.
   - Mit `includeHidden: true` greift die Regel **gar nicht**; die Liste ist roh,
     so wie `docs/09` sie verspricht. Ein versteckter Nachfahre darf keinen
     sichtbaren Vorfahren verdrängen.

**Kosten.** Ein zusätzlicher Durchlauf über die Treffer, je Treffer die Elternkette
nach oben. Kein zweiter `querySelectorAll`, keine Layout-Messung mehr als heute.

## Der Vertrag

| Feld | Regel |
|---|---|
| `count` | Zahl der **engsten** Treffer nach Sichtbarkeitsfilter und vor `limit`; bei `selector` allein und bei `includeHidden` unverändert die Zahl aller Treffer |
| `elements[]` | wie heute, mit `index`: `index`, `selector`, `tag`, `id`, `classes`, `text`, `href`, `ariaLabel`, `visible`, `disabled`, `rect` |
| `truncated` | unverändert: `count > elements.length` oder Kandidatendeckel erreicht |
| leerer Suchbegriff | unverändert: passt auf jedes sichtbare Element, ohne Engste-Regel |
| `includeHidden: true` | unverändert: rohe Liste, ohne Engste-Regel |

## Non-goals

- **Kein `owner`-Feld.** Der Betreiber hat am 2026-11-23 den Weg A gewählt: kein
  Feld, stattdessen `browser_click({contains_text})` in `docs/58`.
- **Keine Rangfolge nach Relevanz.** Dokumentreihenfolge bleibt die Ordnung.
- **Kein zweiter Durchlauf über den Kandidatendeckel hinaus.** 5 000 geprüfte
  Kandidaten bleiben der Deckel.
- **Keine Änderung an `click`.** Der Textklick steht in `docs/58`.
- **Kein `offscreen`.** Das Feld gehört `docs/62`.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `inspect_withANeedleInNestedContainers_shouldAnswerOnlyTheInnermost` | drei verschachtelte Treffer, einer übrig, `count: 1`, `elements[0]` ist der innerste |
| `test/extension.test.js` | `inspect_withSiblingsThatBothMatch_shouldKeepBothInDocumentOrder` | Geschwister bleiben beide, Reihenfolge und `index` unverändert |
| `test/extension.test.js` | `inspect_withASelectorOnly_shouldKeepTheAncestors` | die Regel greift bei `selector` allein **nicht** |
| `test/extension.test.js` | `inspect_withAnEmptyText_shouldStillMatchEveryVisibleElement` | die erste Ausnahme aus Ziel 5 hält; **umbenannt** von `inspect_withAnEmptyText_shouldMatchEveryElementAndBeCutByTheLimit` (`:10943`) |
| `test/extension.test.js` | `inspect_withIncludeHidden_shouldKeepTheRawList` | die zweite Ausnahme hält: versteckter Nachfahre verdrängt keinen Vorfahren |
| `test/extension.test.js` | `inspect_withSelectorAndText_shouldApplyTheRuleToTheSelectorMatches` | die Regel gilt für die Kombination |
| `test/extension.test.js` | `inspect_withAPiercingSelectorAndANeedle_shouldAnswerOnlyTheInnermost` | die Regel gilt auch in der Schatten-Quelle; kein bestehender Fall verbindet `>>>` mit einem Suchbegriff |
| `test/extension.test.js` | `inspect_withMoreCandidatesThanTheCap_shouldStopAtTheCapAndSetTruncated` (bestehend, `:10356`) | der Deckel greift vor der Engste-Regel |
| `bridge-rs/tests/mcp.rs` | `help_forInspect_shouldNameTheInnermostRule` | die Anleitung nennt die Regel und die Ausnahmen (Dateikonvention `help_…`, wie die drei bestehenden Fälle) |

## Acceptance criteria

1. **Der engste Treffer.** Fixture mit `div#a-page > div.search > span.title`
   (alle drei enthalten „Kaufen") ⇒ `elements[0]` ist `span.title`, `count` ist 1.
   Beleg: `npm test` ⇒ 0, `^# fail 0`, `^# cancelled 0`.
2. **Kein Vorfahre bei einer Textsuche.** Der Fall
   `inspect_withANeedleInNestedContainers_shouldAnswerOnlyTheInnermost` liefert den
   innersten Treffer; `div#a-page` steht in der Antwort nicht. Beleg: der Fall ⇒
   `^ok`.
3. **`selector` allein bleibt.** Der Fall `inspect_withASelectorOnly_shouldKeepTheAncestors`
   zeigt, dass ein Vorfahre neben seinem Nachfahren stehen bleibt. Beleg: der Fall
   ⇒ `^ok`.
4. **Die zwei Ausnahmen.** `inspect_withAnEmptyText_shouldStillMatchEveryVisibleElement`
   und `inspect_withIncludeHidden_shouldKeepTheRawList` liefern die rohe Liste.
   Beleg: beide Fälle ⇒ `^ok`, je Name über
   `grep -cE '^ok [0-9]+ - <name>'` ⇒ 1.
5. **Alles andere grün.** `npm run check` ⇒ 0, `cargo test` ⇒ `test result: ok`
   mit `0 failed`, `bash scripts/parity.sh --impl rust --check` ⇒ 7/7.
6. **Live, Betreiber.** Auf `https://www.amazon.de/s?k=Vallejo+70966+Turquoise`:
   `browser_inspect({"contains_text":"In den Einkaufswagen", "limit":5})` nennt in
   den ersten fünf Treffern kein `div#a-page`.

## Dev plan

Verfasst von einem zweiten Autor (2026-11-23), geprüft gegen den Code.

**Stufe 1 — Helfer, beide Quellen, Harness (`extension/page-agent.js`, `test/extension.test.js`)**

`dropAncestorsOfMatches(hits)` auf der IIFE-Ebene (`:19`) — dort liegen
`describeElement` (`:33`) und beide Quellen; `:2105` ist nur der Eintrag der
Op-Tabelle. Der Helfer bekommt die Treffer des geprüften Fensters (höchstens
`request.candidateLimit`, also `INSPECT_CANDIDATE_LIMIT` = 5000 aus `bridge.js:260`),
bildet eine Menge daraus und gibt die Treffer zurück, die keinen Treffer unter sich
haben.

**Der Weg nach oben ist nicht nur `parentElement`.** An einer Schattengrenze ist
`parentElement` `null` und `parentNode` die Wurzel, deren `host` weiterführt — genau
so setzt es das Harness (`createShadowRoot`); ein Helfer, der nur `parentElement`
liest, verliert jeden Vorfahren oberhalb des Hosts.

- `inspectPageSource` (`:730`): die Schleife `:835-848` sammelt erst alle Treffer,
  dann läuft die Regel, dann `count` und die Lieferung bis `request.limit`. Der
  Regel-Zweig hängt an `needle !== null && needle !== "" && request.includeHidden
  !== true`: der leere Suchbegriff ist gesetzt und passt auf alles, dort gilt die
  Regel nicht; `includeHidden` schaltet sie ganz ab.
- `inspectShadowPageSource` (`:964-1167`, Liefer-Schleife `:1139-1153`): dieselbe
  Reihenfolge, `selectorOf(endpoint)` als Selektor. Der Eingang `:972`
  (`segments.length === 1` → `inspectPageSource`) bleibt unverändert.
- Kein zweiter `querySelectorAll`, keine zusätzliche Layout-Messung: `isVisible` und
  `innerText` laufen wie heute einmal je geprüftem Kandidaten.

Harness: die Vorfahren der neuen Fälle tragen ihren Text im `innerText`, weil
`createInspectElement` `:9255` `innerText: innerText ?? textContent` setzt und Kinder
nicht faltet; ein Vorfahre ohne eigenes `innerText` trifft den Suchbegriff nicht.
`createInspectFixture` (`:9398`) hat mit `listBox > nestedEntry` bereits eine
Schachtelung — der Fall mit leerem Suchbegriff (`:10943`) hängt daran.

Fünf bestehende Fälle haben keine verschachtelten Treffer und bleiben grün:
`:10314` (`count: 1`), `:10335` (drei Geschwister, `count: 3`), `:10356` (Deckel,
Geschwister), `:10943` (leerer Suchbegriff, `count: 8`), `:10962` (`count` 1 und 2).
Kein bestehender Fall verbindet `>>>` mit einem Suchbegriff — die Regel im
Schatten-Zweig braucht deshalb einen eigenen Fall
(`inspect_withAPiercingSelectorAndANeedle_shouldAnswerOnlyTheInnermost`), sonst ist
sie unbelegt.

Beweis: die sechs Fälle der Tabelle; `:10943` wird dabei **nur umbenannt** und behält
seine drei Assertions (`count: 8`, zwei geliefert, `truncated: true`) — es belegt
dann beides, den leeren Suchbegriff und den Deckel. Je Name
`grep -cE '^ok [0-9]+ - <name>'` ⇒ 1; `npm test; echo $?` ⇒ 0 mit `^# fail 0` und
`^# cancelled 0`.

**Stufe 2 — Anleitung (`bridge-rs/src/mcp/help.rs`, `bridge-rs/tests/mcp.rs`)**

Der INSPECT-Block (`:148-171`): `## Pitfalls` (`:167-168`) nennt die Engste-Regel und
die zwei Ausnahmen (`selector` allein, `includeHidden`). Neuer Fall
`help_forInspect_shouldNameTheInnermostRule` — die Datei-Konvention ist `help_…`
(drei Fälle bestehen so); `## Testing` nennt ihn `mcp_toolsCallBrowserHelp_…`.

Beweis: `cargo test --manifest-path bridge-rs/Cargo.toml --test mcp
help_forInspect_shouldNameTheInnermostRule -- --exact` ⇒ `test result: ok. 1 passed`
(die Zeile zählt; ein Filter ohne Treffer endet mit 0 und `0 passed`), dazu
`help_forEveryTool_shouldAnswerWithTheSixSections` grün — der prüft nur die sechs
Überschriften und lässt falschen Text durch.

**Stufe 3 — Doku**

`docs/09` (`count`-Regel, Sonderfall leerer Suchbegriff, `selector` allein,
`includeHidden`), `docs/53`, `docs/README.md` (Status), `docs/PROJECT-STATE.md`, Abschnitt „Beweise";
der Amendments-Abschnitt entfällt, die Spec wird `active`. Die zwei Fallzahlen-Pins
(`docs/54` Kriterium 4: 287 Fälle, 117 in `mcp.rs`, `npm test`) nennen die Zahl, die
der Lauf in der Schlusszeile druckt — abgelesen, nicht gerechnet: `cargo test` zählt
heute 117 in `mcp.rs`, in `test/extension.test.js` stehen 460 `test(`-Blöcke.

Beweis: `npm run check; echo $?` ⇒ 0; `grep -n '57-inspect' docs/README.md` zeigt
`active`; `bash scripts/parity.sh --impl rust --check; echo $?` ⇒ 7/7, 0.

**Eingefrorene Artefakte: keiner.** Vergleich 2 antwortet aus der Fake-Extension
(`inspectResultOf` reicht `count` und `elements` durch, `bridge.js:3335-3354`); die
Regel läuft ausschließlich in der Seite, `2-tools.txt` (`# cases=39`) bleibt Zeile
für Zeile gleich.

**Was schiefgehen kann.** Der Helfer läuft über alle Treffer, also über höchstens
5000 Elternketten — bei tiefer Verschachtelung ist das die teuerste Stelle dieser
Spec (`## Bekannte Lücken`). Zweitens: ein Treffer oberhalb des Deckels bleibt in der
Liste, weil sein Nachfahre nie geprüft wurde; `truncated: true` ist dann die einzige
Warnung. Drittens: `help.rs` ist derselbe Block, den `docs/59` (Argumentnamen,
`text` → `contains_text`) umschreibt — nacheinander im selben Baum, nie parallel.

**Reihenfolge.** Stufe 1 → Stufe 2 → Stufe 3; Stufe 1 ist Voraussetzung für
`docs/58` (Textklick) und teilt sich den Helfer mit ihm.

**Was der nächste Inkrement erbt.** `docs/62` fügt `offscreen` in dieselben zwei
`described`-Funktionen (`:788`, `:1040`) — es fasst damit dieselben Dateien an und
folgt dieser Spec. `docs/58` benutzt `dropAncestorsOfMatches` für den Textklick.
Ein hilfreicherer Satz bei 0 Treffern (`## Bekannte Lücken`, `contains_text` als
Filter) bleibt offen.
## Touch boundary

| erlaubt | nicht |
|---|---|
| `extension/page-agent.js` (`inspectPageSource`, `inspectShadowPageSource`, neuer Helfer) | `extension/bridge.js` — die Antwort wird durchgereicht |
| `test/extension.test.js` | `extension/page-agent.js`-Lesepfad, `readPageSource` |
| `bridge-rs/src/mcp/help.rs`, `bridge-rs/tests/mcp.rs` | `scripts/parity/**` — kein neuer Fixture-Fall nötig |
| `docs/09`, `docs/53`, `docs/54` (Fallzahlen), `docs/README.md`, `docs/PROJECT-STATE.md` | `docs/56`, `docs/58`, `docs/62` |

## Bekannte Lücken

- **Die Regel kostet einen zweiten Durchlauf.** Bei 5 000 Kandidaten sind das
  5 000 zusätzliche Elternketten-Läufe. Nicht gemessen; Kriterium 6 zeigt, ob die
  Antwort spürbar langsamer wird (2026-11-23).
- **Ein Treffer ganz ohne Text bleibt draußen.** Ein Element, das nur über
  `aria-label` trifft, war schon vorher nicht in der Textsuche (2026-11-23).
- **Der Deckel kann einen Vorfahren behalten, dessen engster Nachfahre jenseits des
  Deckels liegt.** Der Deckel zählt geprüfte Kandidaten; wer dahinter liegt, wird
  nicht gesehen. `truncated: true` sagt das (2026-11-23).
- **Der `node.host`-Zweig im Helfer ist heute unerreichbar.** Die Dokumentabfrage
  betritt keine Schattenbäume, und `inspectShadowPageSource` liefert nur Endpunkte
  des letzten Roots — ein Vorfahre oberhalb des Hosts kann also nie Treffer sein.
  Ein Helfer mit `parentElement` allein bestünde alle sieben Fälle. Der Zweig bleibt
  als Versicherung, bis `docs/58` ihn braucht (Code-Review 2026-11-23).
- **Ein Container mit zwei treffenden Blättern ist nicht belegt.** Der verschachtelte
  Fall hat ein innerstes Blatt (`count: 1`), der Geschwisterfall keinen Container;
  die reale Messung (`count: 671`) war die Kombination. Ein Fall
  `inspect_withTwoInnermostMatchesInOneContainer_shouldKeepBothAndDropTheContainer`
  wäre der Nachzug (Code-Review 2026-11-23).
- **Der dreiteilige Wächter steht zweimal** (`page-agent.js`, Dokument- und
  Schatten-Zweig), und `docs/58` kopiert ihn ein drittes Mal. Ein lokales Prädikat
  hielte die drei Kopien zusammen (Code-Review 2026-11-23).
- **`contains_text` ist ein Filter, keine Beschreibung.** Zwei Aufrufe des
  9B-Laufs gaben `{"selector":"input","text":"input field"}` und bekamen
  `count: 0`, weil beide Bedingungen gelten. Dokumentiert in `docs/09`; ein
  hilfreicherer Satz bei 0 Treffern ist ein eigener Anlass (2026-11-23).

## Open questions

**Keine.** Entschieden am 2026-11-23: Engste-Regel nur bei Textsuche,
`includeHidden` schaltet sie ab, `count` zählt nach der Regel.

## Review

### Runden 1 bis 3 der Vorgänger-Spec

- **Runde 1** (`🔧`): `count: 6` war `671`; die zweite Quelle
  `inspectShadowPageSource` fehlte; der Elf-Felder-Fall stand nicht in der Tabelle;
  „Fixtures pinnen keine `inspect`-Antwort" war falsch.
- **Runde 2** (`🔧`): Kriterium 4 zeigte auf die falschen Fälle; Kriterium 3 hing an
  einem Fall mit genau einem Element; der Filterbereich war falsch.
- **Runde 3** (`🔧`): Der Schatten-Feldset-Fall bleibt nicht grün (11 → 12 Felder);
  der Fixture-Bauer faltet Kinder nicht.

### Runde 4 — `🔧 Fix these`, dann geteilt

Der Gate nannte vier Major: vier von sieben Kriterien ohne Kommando, Stufe 4 ohne
Beweis, der Widerspruch zwischen Ziel 6 und Vertrag bei flächenlosen Elementen, und
die fehlenden Fallzahlen in `docs/54`/`PROJECT-STATE`. Kriterien und Beweise sind
nachgezogen; der Punkt `offscreen` ist nach `docs/62` gewandert.

### Runde 1 nach der Teilung — steht aus

## Log

- **2026-11-23, angelegt, viermal überarbeitet, geteilt.** Belege aus
  `2026-11-23_conversations.zip` und der Sitzung `2026-11-23T16-45-24`.

- **2026-11-23, Absprache.** Der Betreiber hat Ziel und Abnahmekriterien dieser
  Spec abgestimmt (`CONTRIBUTING.md`, Schritt 2). Der Bau kann beginnen, sobald
  der Dev-Plan von einem zweiten Autor geprüft ist.

- **2026-11-23, Entscheidung vor dem Bau (Orchestrator).** Der Fall
  `inspect_withAPiercingSelectorAndANeedle_shouldAnswerOnlyTheInnermost` steht in
  `## Testing`, obwohl ihn erst der Dev-Plan verlangte: kein bestehender Fall
  verbindet `>>>` mit einem Suchbegriff, die Regel im Schatten-Zweig wäre sonst
  unbelegt.

- **2026-11-23, Stufe 3 nachgezogen, Spec `active`.** `docs/09` trägt die
  Engste-Regel, ihre drei Ausnahmen und die neue Bedeutung von `count`;
  `docs/54` hält fest, dass kein neuer Satz entstanden ist, sondern nur die
  Anleitung in `help.rs` (`## Pitfalls`). `docs/53` braucht keine Änderung: es
  beschreibt das Verfahren der Anleitung, nicht ihren Inhalt. Fallzahlen
  abgelesen: `cargo test` 295 (125 in `mcp.rs`), `npm test` 561.
