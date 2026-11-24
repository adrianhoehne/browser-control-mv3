---
description: browser_inspect liefert bei einer Textsuche den engsten Treffer statt der Containerseite und zählt ihn in count; selector allein und includeHidden bleiben roh — Teil a der Teilung vom 2026-11-23.
status: proposed
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

## Amendments to previous spec docs

- **`docs/09-dom-abfrage.md`**: `count` zählt die engsten Treffer **bei einer
  Textsuche**; `selector` allein und `includeHidden: true` bleiben unverändert; die
  Sonderregel für einen leeren Suchbegriff wird ausdrücklich genannt. Das Argument
  heißt `contains_text` (die Umbenennung steht in `docs/59`).
- **`docs/53-browser-help.md`**: die Anleitung von `browser_inspect` nennt die
  Engste-Regel und die zwei Ausnahmen.

Nach der Umsetzung wird dieser Abschnitt entfernt.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `inspect_withANeedleInNestedContainers_shouldAnswerOnlyTheInnermost` | drei verschachtelte Treffer, einer übrig, `count: 1`, `elements[0]` ist der innerste |
| `test/extension.test.js` | `inspect_withSiblingsThatBothMatch_shouldKeepBothInDocumentOrder` | Geschwister bleiben beide, Reihenfolge und `index` unverändert |
| `test/extension.test.js` | `inspect_withASelectorOnly_shouldKeepTheAncestors` | die Regel greift bei `selector` allein **nicht** |
| `test/extension.test.js` | `inspect_withAnEmptyText_shouldStillMatchEveryVisibleElement` | die erste Ausnahme aus Ziel 5 hält; **umbenannt** von `inspect_withAnEmptyText_shouldMatchEveryElementAndBeCutByTheLimit` (`:10943`) |
| `test/extension.test.js` | `inspect_withIncludeHidden_shouldKeepTheRawList` | die zweite Ausnahme hält: versteckter Nachfahre verdrängt keinen Vorfahren |
| `test/extension.test.js` | `inspect_withSelectorAndText_shouldApplyTheRuleToTheSelectorMatches` | die Regel gilt für die Kombination |
| `test/extension.test.js` | `inspect_withMoreCandidatesThanTheCap_shouldStopAtTheCapAndSetTruncated` (bestehend, `:10356`) | der Deckel greift vor der Engste-Regel |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsCallBrowserHelp_forInspect_shouldNameTheInnermostRule` | die Anleitung nennt die Regel und die Ausnahmen |

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

Entwurf des Spec-Autors. Nach `CONTRIBUTING.md`, Schritt 3, gehört der Dev-Plan zu
einem zweiten Autor.

**Stufe 1 — die Engste-Regel (`extension/page-agent.js`)**

`dropAncestorsOfMatches(elements)` liegt **auf Modulebene**, nicht in
`inspectPageSource`: `docs/58` benutzt denselben Helfer für den Textklick. Der
gemeinsame Scope ist die Fabrik, in der `describeElement` (`:33`) und
`inspectPageSource` (`:730`) beide liegen; `:2105` ist nur der Eintrag der
Op-Tabelle und wird oft falsch zitiert.

In `inspectPageSource` zwei Durchläufe statt einem: erst sammeln, dann Vorfahren
markieren und verwerfen. Die Regel läuft nur, wenn ein Suchbegriff gesetzt und
`includeHidden` falsch ist. Dieselbe Regel in `inspectShadowPageSource`
(`:964-1060`), die ihre eigene Kopie von `textOf` und `described` hat.

**Der Fixture-Bauer faltet Kinder nicht.** `createInspectElement` setzt `:9255`
`innerText: innerText ?? textContent` mit `textContent = ""` (`:9233`) und reicht
`children` nur weiter, ohne den Text zu vererben. Deshalb hat kein bestehender
Textfall je einen Vorfahren getroffen; die Vorfahren im neuen Fall tragen ihren
Text ausdrücklich im `innerText`.

Beweis: Kriterien 1 bis 3, Fälle 1 bis 6 der Tabelle.

**Stufe 2 — die Anleitung (`bridge-rs/src/mcp/help.rs`)**

Der Text von `browser_inspect` nennt die Regel und die zwei Ausnahmen.

Beweis: der neue Fall
`mcp_toolsCallBrowserHelp_forInspect_shouldNameTheInnermostRule`. Der bestehende
Abschnitts-Test aus `docs/53` prüft nur die sechs Überschriften und lässt falschen
Text durch.

**Stufe 3 — die Doku**

`docs/09` nachziehen, `docs/README.md` (Status), dieser Amendments-Abschnitt
entfällt, die Spec wird `active`. Der neue `help`-Fall schiebt die Fallzahlen in
`docs/54` Kriterium 4 (287 Fälle, 117 in `mcp.rs`) und `PROJECT-STATE.md:33-34`;
beide werden hier nachgezogen.

Beweis: `npm run check` ⇒ 0, `grep -n '57-inspect' docs/README.md` zeigt `active`.

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
