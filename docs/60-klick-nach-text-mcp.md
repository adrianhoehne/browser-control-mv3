---
description: Die MCP-Naht des Textklicks — contains_text im Schema, die Leitung bleibt text, CLICK_NEEDS_FILTER vor dem Draht, text_ambiguous und no_match als englische Sätze, zwei eingefrorene Fixtures; Teil b der Teilung vom 2026-11-23.
status: proposed
---

# Klicken nach Text, Teil b — die MCP-Naht

**Geteilt am 2026-11-23.** `docs/58` bringt den Textklick in die Erweiterung; diese
Spec bringt ihn durch die Bridge zum Agenten. Die Naht ist die Leitung: hier endet
`extension/**`, hier beginnt `bridge-rs/src/mcp/`.

## Anlass

`docs/58` liefert `text_ambiguous` mit `matches` und `candidates` in `details`, den
`no_match`-Satz mit dem Suchbegriff und die Ablehnung „kein Ziel". Nichts davon
kommt heute beim Agenten an:

- `CLICK_ARGUMENTS` (`bridge-rs/src/mcp/tools.rs:58`) kennt `contains_text` nicht;
  ein Aufruf damit wird als „ungeklärter Schlüssel" abgelehnt.
- Ein MCP-Werkzeugfehler ist **ein** Textblock (`tool_error`, `tools.rs:1202-1206`);
  `failure_text_for` gibt einen `String` zurück (`failure.rs:75-90`). Felder
  müssen also zu Prosa werden — oder der Agent sieht sie nie.
- `texts::no_match(&selector_of(params))` (`failure.rs:129-130`) druckt
  `undefined`, wenn der Aufrufer nur einen Suchbegriff geschickt hat.
- Die Sätze der Argumentprüfung stehen in `unexpected_arguments`
  (`tools.rs:1230-1250`), nicht in `texts.rs` — die Textliste aus `docs/54` zählt
  sie trotzdem mit.

## Ziel

1. **`CLICK_ARGUMENTS` und Schema.** `browser_click` deklariert `selector` und
   `contains_text`; `selector` ist nicht mehr Pflicht, und die Kombination ist
   erlaubt. Der Typ von `contains_text` wird geprüft (Muster:
   `has_declared_inspect_argument_types`, `tools.rs:909-929`).
2. **Die Leitung bleibt `text`.** `click_tool` (`tools.rs:701-706`) bildet
   `contains_text` beim Befüllen auf den Draht-Schlüssel `text` ab, wie
   `payload.insert("text", …)` (`:758`) es für `type` tut. Ein Name auf der
   Leitung, zwei im MCP.
3. **„Kein Ziel" antwortet vor dem Draht.** Weder `selector` noch `contains_text`,
   oder ein leerer Suchbegriff: `tool_error(id, texts::CLICK_NEEDS_FILTER)` — das
   Muster von `INSPECT_NEEDS_FILTER` (`:795-796`).
4. **Zwei neue Sätze und eine zweite Form in `texts.rs`**, englisch, gepinnte
   Konstanten (kein „Vorschlag"):
   - `CLICK_NEEDS_FILTER`: ``browser_click needs `selector` or `contains_text`.``
   - `CLICK_AMBIGUOUS`: nennt Suchbegriff, Zahl der Treffer und den Rat, und bei
     erreichtem Deckel „at least". Den erreichten Deckel meldet die Extension als
     `truncated` in `details` — dasselbe Wort, das `inspect` für „count ist eine
     Untergrenze" führt. Wortlaut, gepinnt:

     ```
     `contains_text: "<term>"` matches <n> elements (<candidates>). Narrow it with
     `selector` — `browser_inspect` lists each candidate with its own selector, and
     `browser_help({"tool":"browser_inspect"})` explains the arguments.
     Bei erreichtem Deckel: `<n>` durch `at least <n>` ersetzen.
     ```
   - `NO_MATCH` bekommt eine zweite Form, die den **Suchbegriff** statt des
     Selektors einsetzt; die bestehende Form bleibt.
5. **`failure.rs` bildet die Codes ab:** `text_ambiguous` auf `CLICK_AMBIGUOUS`,
   `no_match` auf die Form, die zum Aufruf passt. Die Belege `matches` und
   `candidates` gehen in den **Satz** — ein Feld kann der Agent nicht lesen.
6. **Die zwei eingefrorenen Fixtures** werden amendiert: `2-tools.txt` Zeile 61
   (`browser_click takes only …`) und `1-initialize-and-tools-list.txt` Zeile 5
   (`tools/list` trägt das Schema).
7. **Die Anleitung** `browser_click` in `help.rs` nennt `contains_text`, den
   exakten Vorrang und den Rat.
8. **Die Werkzeugliste bleibt klein:** `tools/list` höchstens 8 500 Zeichen
   (Grenze aus `docs/53`).

## Der Vertrag (MCP-Seite)

| Feld | Regel |
|---|---|
| `contains_text` | im Schema deklariert, Typ `string`; wird zu `text` auf der Leitung |
| `selector` | nicht mehr in `required`; Kombination mit `contains_text` erlaubt |
| beide | erlaubt, einschränkend — die Extension entscheidet, was passt (`docs/58`) |
| keines / leer | `CLICK_NEEDS_FILTER`, `isError: true`, vor dem Draht |
| `text_ambiguous` | englischer Satz mit Zahl, Kandidaten und Rat; bei `truncated` in `details` sagt er „at least" |
| `no_match` | englischer Satz mit dem Begriff, der zum Aufruf passt |
| Zahlen beim Agenten | die zwei neuen Sätze verschieben die Fallzahlen in `docs/54` Kriterium 4 und `PROJECT-STATE.md`, Abschnitt „Beweise" |

## Non-goals

- **Keine Arbeit an der Extension.** Suche, Engste-Regel, Kandidaten und
  `ClickError.details` stehen in `docs/58`.
- **Keine Felder im Fehlerblock.** Ein Werkzeugfehler bleibt ein Textblock.
- **Kein neues Werkzeug.**
- **Keine Änderung an `inspect`, `type` oder `read`.**

## Amendments to previous spec docs

- **`docs/06-klicken.md`**: die Argument-Refusal nennt vier Namen; `text_ambiguous`
  ist ein Fehler der Bridge; `no_match` nennt den Begriff.
- **`docs/54-refusals-englisch.md`**: drei Sätze kommen hinzu (`CLICK_NEEDS_FILTER`,
  `CLICK_AMBIGUOUS`, die zweite `NO_MATCH`-Form), einer ändert sich (die
  Argumentliste von `browser_click`).
- **`docs/53-browser-help.md`**: die Anleitung von `browser_click` in
  `bridge-rs/src/mcp/help.rs` bekommt `contains_text`, den exakten Vorrang und
  einen Punkt unter „Pitfalls".

Nach der Umsetzung wird dieser Abschnitt entfernt.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `bridge-rs/tests/mcp.rs` | `mcp_toolsCallBrowserClick_withContainsText_shouldSendTextOnTheWire` | der neue Name wird auf der Leitung `text` — der Fall, den Runde 3 verlangt hat |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsCallBrowserClick_withSelectorAndContainsText_shouldSendBoth` | die Kombination geht vollständig über die Leitung |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsCallBrowserClick_withoutAnyTarget_shouldSayClickNeedsFilter` | „kein Ziel" antwortet vor dem Draht, mit beiden Namen im Satz — **übernimmt die `{}`-Hälfte** aus `mcp_toolsCallBrowserClick_withoutAUsableSelector_shouldAnswerInvalidParamsAndNeverReachTheExtension` (`:2214-2226`), die dort auf `{"selector": 7}` reduziert wird und `-32602` behält |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsCallBrowserClick_withAnEmptyContainsText_shouldSayClickNeedsFilter` | der leere Suchbegriff ist kein Ziel |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsCallBrowserClick_withTextAmbiguous_shouldNameCountCandidatesAndAdvice` | der Satz trägt Zahl, Kandidaten und Rat |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsCallBrowserClick_withNoMatchForATerm_shouldNameTheTerm` | `no_match` nennt `gibtsnicht`, nicht `undefined` |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsList_shouldDeclareContainsTextForClick` | das Schema deklariert das Argument |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsList_shouldOfferExactlyTheFourteenToolsOfTheContract` (bestehend, `:1075-1088`) | der Schema-Pin trägt `contains_text` und `required` ohne `selector` |
| `bridge-rs/tests/mcp.rs` | `CLICK_UNEXPECTED_ARGUMENTS_TEXT` (bestehend, `:722`, benutzt in `:2263`) | die Konstante nennt vier Namen — dasselbe Paar wie die Fixture |
| `bridge-rs/tests/texts.rs` | `texts_shouldContainNoGermanUmlauts` | der Wächter aus `docs/54` deckt die drei neuen Sätze |
| `scripts/parity/expected/2-tools.txt` | Zeile 61 | die Argument-Refusal nennt vier Namen (Stufe 0) |
| `scripts/parity/expected/1-initialize-and-tools-list.txt` | Zeile 5 | `tools/list` trägt das neue Schema (Stufe 0) |

Der Musterfall für die Leitung steht schon im Repo: `mcp.rs:2200` prüft
`assert_eq!(request["params"], json!({ "selector": … }))`, `:2365` für `type`,
`:2794` für `inspect`.

## Acceptance criteria

1. **Der Draht.** `mcp_toolsCallBrowserClick_withContainsText_shouldSendTextOnTheWire`
   ⇒ `request["params"]` enthält `text`, nicht `contains_text`. Beleg:
   `cargo test --test mcp` ⇒ `test result: ok` mit `0 failed`.
2. **Die Kombination.** `…withSelectorAndContainsText_shouldSendBoth` ⇒ beide
   Schlüssel auf der Leitung.
3. **Kein Ziel.** Beide Tests aus der Tabelle ⇒ `CLICK_NEEDS_FILTER` mit
   `selector` und `contains_text` im Satz; kein Draht-Aufruf (der Seam zählt ihn
   nicht).
4. **Mehrdeutig mit Rat.** Der Satz enthält die Zahl, zwei Kandidaten und
   `browser_inspect`.
5. **`no_match` nennt den Begriff.** `gibtsnicht` im Satz, `undefined` **nicht**.
6. **Die Liste bleibt klein.** `awk 'NR==5'
   scripts/parity/expected/1-initialize-and-tools-list.txt | wc -m` ⇒ höchstens
   8 500 (heute, vor `docs/59`: 8 062).
7. **Alles andere grün.** `npm run check` ⇒ 0, `bash scripts/parity.sh --impl rust
   --check` ⇒ 7/7 **nach** Stufe 2, und
   `cargo clippy --manifest-path bridge-rs/Cargo.toml --all-targets -- -D warnings`
   ⇒ sauber (aus dem Repo-Wurzelverzeichnis braucht cargo den `--manifest-path`).
8. **Live, Betreiber.** Auf einer Amazon-Produktseite liefert
   `browser_click({"contains_text":"In den Einkaufswagen"})` entweder einen Erfolg
   oder einen Satz, der den Weg über `selector` nennt — keinen
   `call_extension_failed`.

## Dev plan

Verfasst von einem zweiten Autor (2026-11-23), geprüft gegen den Code.

1. **Stufe 0 — die zwei eingefrorenen Artefakte, datierter Akt (Freigabe liegt vor: 2026-11-23)**
   `scripts/parity/expected/2-tools.txt` Zeile 61 — `browser_click` kommt in der Datei genau
   einmal vor (`grep -c 'browser_click'` ⇒ 1), und der Parity-Fall 4 schickt
   `{"selector":"a#video-title-link","bogus":1}`, bleibt also bei der Argument-Refusal; nur der
   Satz wächst auf vier Namen. `scripts/parity/expected/1-initialize-and-tools-list.txt`
   Zeile 5, `"name":"browser_click"` genau einmal — gemessen **gegen den Stand nach
   `docs/59`**, nicht gegen die 8 062 von heute.
   Proof: `--self-test` vorher 7/7; nach Stufe 2 `bash scripts/parity.sh --impl rust --check;
   echo $?` ⇒ 7/7, 0. In beiden Artefakten ändert sich je eine Zeile, `# cases=39` bleibt.
   **Stufe 0, 1 und 2 gehen in einem Auftrag:** dazwischen ist `--check` rot.

2. **Stufe 1 — Argumente, Schema, Beschreibung (`tools.rs`, eine Konstante in `texts.rs`)**
   `CLICK_ARGUMENTS` (`:58`, Kommentar `:57`) bekommt `contains_text`; das Schema (`:153-176`)
   verliert `selector` aus `required` (`:172-174`), bekommt das Property `contains_text`
   (`:157-170`) und beschreibt die Kombination; die Typ-Prüfung kommt als
   `has_declared_click_argument_types` neben `has_declared_inspect_argument_types`
   (`:909-929`) und ersetzt die Einzelprüfung `:678-682`; `texts::CLICK_NEEDS_FILTER` in
   `texts.rs` (nur die Konstante, neben `INSPECT_NEEDS_FILTER` `:115`); die
   Argument-Refusal in `unexpected_arguments` (`:1235`) nennt vier Namen;
   `BROWSER_CLICK_DESCRIPTION` (`:392-393`) sagt nicht mehr „Clicks the first element that
   matches the CSS selector" — die einzige Stelle, an der der Agent `contains_text` vor dem
   ersten Aufruf entdecken kann. `click_tool` (`:675-723`): Payload (`:701-706`) setzt `text`
   **nur**, wenn `contains_text` gesetzt war — sonst brechen zwei bestehende Pins
   (`:2200`, `:2284`), die `json!({ "selector": … })` byteweise vergleichen.
   **Reihenfolge der Prüfungen, wie in `inspect_tool`** (`:787`/`:790`/`:795`): Typen
   (`-32602`) → unbekannte Schlüssel (Refusal-Satz) → „kein Ziel" (`CLICK_NEEDS_FILTER`).
   Nur so bleibt `{"selector":7}` bei `-32602` (`:2224`) und `{"selector":…,"x":1}` beim
   Refusal-Satz (`:2263`), während `{}` den neuen Satz bekommt.
   Proof: `cargo test --manifest-path bridge-rs/Cargo.toml --test mcp
   mcp_toolsCallBrowserClick_withContainsText_shouldSendTextOnTheWire -- --exact` ⇒
   `test result: ok. 1 passed`, dasselbe für `…withSelectorAndContainsText_shouldSendBoth`,
   `…withoutAnyTarget_shouldSayClickNeedsFilter`, `…withAnEmptyContainsText_shouldSayClickNeedsFilter`,
   `…toolsList_shouldDeclareContainsTextForClick` — **die Zeile zählt, nicht der Exit-Code:**
   ein Filter ohne Treffer endet mit 0 und `0 passed`. Der alte Fall
   `mcp_toolsCallBrowserClick_withoutAUsableSelector_…` (`:2214-2226`) wird zur Einzelprüfung
   mit `{"selector": 7}` reduziert und behält `-32602`; der `{}`-Ast wandert in den neuen Fall.
   Unverändert grün bleiben müssen `:2186-2211` (`:2200`), `:2272-2289` (`:2284`),
   `:2244-2269` (`:2263`) und der Schema-Pin `:1075-1088`.
   Kriterium 6: `awk 'NR==5' scripts/parity/expected/1-initialize-and-tools-list.txt | wc -m`
   ⇒ ≤ 8 500 — **die Beschreibungsänderung zählt gegen dasselbe Budget**, nach dem Edit messen.

3. **Stufe 2 — Sätze und Abbildung (`texts.rs`, `failure.rs`)**
   `texts.rs`: `CLICK_AMBIGUOUS` im gepinnten Wortlaut als eine Zeile (der Zeilenumbruch in
   `## Ziel` 4 ist Typografie) plus die Deckel-Form „at least"; die zweite `NO_MATCH`-Form
   neben `no_match` (`:97-99`). `failure.rs`: `CLICK_AMBIGUOUS_CODE` neben `NOT_CLICKABLE_CODE`
   (`:38`); im `BROWSER_CLICK`-Zweig (`:124-137`) ein Arm für `text_ambiguous`
   (`texts::click_ambiguous(term, matches, candidates, truncated)`) und die Wahl der
   `no_match`-Form; `match_of(params)` als Gegenstück zu `selector_of` (`:250-258`) — es liest
   den **Drahtschlüssel** `text`, und die Regel „beide gesetzt ⇒ Begriff gewinnt" steht nur im
   `BROWSER_CLICK`-Zweig, damit `type` (`:144-150`) unberührt bleibt; `click_candidates_of`
   als Zwilling von `frame_candidates_of` (`:377-387`) mit `CLICK_CANDIDATE_LIMIT = 5` neben
   `FRAME_CANDIDATE_LIMIT` (`:66`), verbunden mit `", "` wie `frame_ambiguous_text` (`:368-374`).
   Die Belege kommen als `details` an, weil der Hub das ganze `error`-Objekt durchreicht
   (`hub.rs:618-621`) — dieselbe Form, die `error_frame_with` (`tests/mcp.rs:115-119`) baut.
   Proof: `…withTextAmbiguous_shouldNameCountCandidatesAndAdvice` ⇒ `1 passed`;
   `…withNoMatchForATerm_shouldNameTheTerm` ⇒ `1 passed`; `…withoutAnyTarget…` bleibt grün;
   `cargo test --test texts -- --exact texts_shouldContainNoGermanUmlauts` ⇒ `1 passed`
   (der Wächter deckt die zwei neuen Sätze ohne eigenen Fall). Die Deckel-Form hat keinen
   eigenen Fall — sie wird im `text_ambiguous`-Fall mitgeprüft, ohne den Fall umzubenennen.

4. **Stufe 3 — Anleitung und Doku**
   `help.rs`, `CLICK`-Block (`:82-102`): Argument-Tabelle (`:85-91`) um `contains_text` und
   „beides erlaubt", `## Pitfalls` (`:98-99`) um den exakten Vorrang und den Rat, `## Example`
   (`:96`) mit einem Textklick. `docs/06`, `docs/53`, `docs/54`, `docs/README.md` (Status),
   `docs/PROJECT-STATE.md` (Abschnitt „Beweise"); der Amendments-Abschnitt entfällt, die Spec
   wird `active`. Die Fallzahlen in `docs/54` Kriterium 4 werden aus dem Lauf abgelesen:
   `cargo test --manifest-path bridge-rs/Cargo.toml -- --test-threads=1 | grep -E '^test
   result'` und `npm test | grep -E '^# (tests|pass) '`.
   Proof: `npm run check; echo $?` ⇒ 0; `cargo clippy --manifest-path bridge-rs/Cargo.toml
   --all-targets -- -D warnings` ⇒ sauber, in der CI-Form mit `--target` zweimal
   (`.github/workflows/test.yml:45-46`); `grep -n '60-klick' docs/README.md` zeigt `active`.

**Was schiefgehen kann**

- **Der Draht darf `text` nicht immer tragen.** `click_tool` baut den Payload von Hand
  (`:701-706`); ein bedingungsloses `payload.insert("text", …)` macht zwei bestehende
  Zusicherungen rot (`:2200`, `:2284`), ohne dass ein neuer Fall es merkt — der Fehler zeigt
  sich als roter alter Fall, nicht als roter neuer.
- **Die Reihenfolge der drei Prüfungen ist die halbe Änderung.** „kein Ziel" vor der
  Schlüsselprüfung würde `{"x":1}` in `CLICK_NEEDS_FILTER` verwandeln und `:2263` rot machen;
  „kein Ziel" vor der Typprüfung würde `{"selector":7}` zu einem Werkzeugfehler machen und
  `:2224` brechen.
- **Die zwei Sätze sind gepinnt.** `CLICK_UNEXPECTED_ARGUMENTS_TEXT` (`:722`) und der
  Fixture-Satz (`2-tools.txt:61`) müssen zeichengleich sein; `texts.rs` ist englisch und
  umlautfrei, sonst schlägt der Wächter zu.
- **„at least" braucht einen Träger,** den keine der beiden Specs benennt: der Plan nimmt
  `truncated` (dasselbe Wort wie in `inspect`) und liest es in `failure.rs` aus `details`.
- **`no_match`-Form und `selector_of` teilen sich den Wortlaut.** `selector_of` druckt
  `undefined` (`:250-258`); die Begriff-Form darf das nicht erben, sonst steht das Wort wieder
  im Satz, das Kriterium 5 ausschließt.

**Reihenfolge und Abhängigkeiten**

Stufe 0 an Stufe 1 und 2 gebunden (ein Auftrag); Stufe 1 setzt `docs/59` Stufe 1 voraus (die
Argumentliste und der Name), Stufe 2 setzt `docs/58` Stufen 2 und 3 voraus (Codes, `matches`,
`candidates` als `ClickError.details`). Stufe 3 ist Doku und zuletzt. `--check` nie parallel zu
einer Testsuite: der Lauf besitzt 18115/18116.

**Was der nächste Inkrement erbt**

`docs/61` hängt am selben `BROWSER_CLICK`-Zweig in `failure.rs`. Ein Fehlerblock mit Feldern
für alle Werkzeuge bleibt der in `## Bekannte Lücken` benannte eigene Zuwachs. Das
Live-Kriterium 8 bleibt Betreiber-Messung, und `docs/58` Kriterium 8 misst dieselbe Seite von
der anderen Seite der Naht.
## Touch boundary

| erlaubt | nicht |
|---|---|
| `bridge-rs/src/mcp/tools.rs`, `failure.rs`, `texts.rs`, `help.rs` | `bridge-rs/src/hub.rs`, `protocol.rs` — kein Protokollschritt |
| `bridge-rs/tests/mcp.rs`, `bridge-rs/tests/texts.rs` | `extension/**`, `test/extension.test.js` — das ist `docs/58` |
| `scripts/parity/expected/2-tools.txt`, `1-initialize-and-tools-list.txt` — **nur** Stufe 0, mit Freigabe | `docs/56`, `docs/57`, `docs/58`, `docs/59` |
| `docs/06`, `docs/53`, `docs/54`, `docs/README.md`, `docs/PROJECT-STATE.md` | `docs/09` |

## Bekannte Lücken

- **Der Rat im Satz kennt den `eval`-Schalter nicht.** Ob „Code-Auswertung
  erlauben" an ist, weiß nur die Extension; der Satz nennt deshalb nur
  `browser_inspect` und `browser_help` (2026-11-23).
- **Kandidaten bleiben Prosa.** Wer sie als Felder will, braucht einen anderen
  Fehlerblock für alle Werkzeuge — ein eigenes Inkrement (2026-11-23).
- **Zwei Specs fassen Zeile 5 derselben Fixture an** (`docs/59` und diese). Zwei
  Freigaben, zwei datierte Akte — der Betreiber nickt beide ab (2026-11-23).

## Open questions

**Keine.** Die MCP-Form ist durch `docs/58` und `docs/59` entschieden: Leitung
`text`, Fehler sind ein Textblock, Sätze sind Konstanten.

## Review

### Runde 4 — `🔧 Fix these` (2026-11-23)

Vier Blocker, alle übernommen: drei bestehende Pins hängen an der Änderung
(`mcp.rs:2226` prüft `{}` als `-32602`, `:722` ist die Argument-Refusal als
Konstante, `:1075-1088` pinnt das ganze Klick-Schema) — sie stehen jetzt in der
Tabelle und im Plan; und der Verweis auf einen nicht existierenden Abschnitt in
`docs/58` ist durch den gepinnten Wortlaut ersetzt. Dazu die Beschreibung in
`tools.rs:392`, die dem neuen Schema widersprach, ein Auftrag für die Stufen 0 bis
2 und der lauffähige `clippy`-Befehl.

### Runde 5 — steht aus

Nach `CONTRIBUTING.md`, Schritt 4, öffnet erst ein `✅ Ship it` die Umsetzung.

## Log

- **2026-11-23, angelegt.** Abgespalten von `docs/58` nach dem dritten
  Gate-Block („die Spec ist zu groß: fünf Stufen, sieben Produktivdateien, zwei
  eingefrorene Fixtures, Harness"). Die Naht ist die Leitung; die Befunde der
  Runden 1 bis 3 zur MCP-Seite sind eingearbeitet: Leitungstest für
  `contains_text` → `text`, `CLICK_NEEDS_FILTER` vor dem Draht, `no_match` mit dem
  Begriff, `matches`/`candidates` als Prosa, beide Fixtures in Stufe 0.

- **2026-11-23, Absprache.** Der Betreiber hat Ziel und Abnahmekriterien dieser
  Spec abgestimmt (`CONTRIBUTING.md`, Schritt 2). Der Bau kann beginnen, sobald
  der Dev-Plan von einem zweiten Autor geprüft ist.
