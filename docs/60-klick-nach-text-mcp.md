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
     erreichtem Deckel „at least". Wortlaut, gepinnt:

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
| `text_ambiguous` | englischer Satz mit Zahl, Kandidaten und Rat |
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

Entwurf des Spec-Autors. Nach `CONTRIBUTING.md`, Schritt 3, gehört der Dev-Plan zu
einem zweiten Autor.

**Stufe 0 — die zwei eingefrorenen Fixtures amortisieren (Freigabe des Betreibers)**

- `2-tools.txt`, **Zeile 61** (Fall `# case=4` steht dreimal in der Datei): heute
  ``browser_click takes only `selector`, `frame` and `tab`.``
- `1-initialize-and-tools-list.txt`, Zeile 5: `tools/list` trägt das Schema.
  Stand **vor `docs/59`**: 8 062 Zeichen; `docs/59` fasst dieselbe Zeile an.

**Die Freigabe des Betreibers für beide Artefakte liegt vor (2026-11-23).**

**Stufe 0 bis 2 gehen in einem Auftrag:** zwischen Stufe 0 und Stufe 2 ist
`--check` rot, weil die Fixture die neuen Sätze und das neue Schema trägt und der
Code beides noch nicht liefert.

Beweis: `--self-test` vorher 7/7, nach Stufe 2 `--check` 7/7; in beiden Artefakten
ändert sich je eine Zeile (`browser_click` kommt in jedem der zwei genau einmal
vor, in den übrigen fünf null mal).

**Stufe 1 — Argumente, Schema und Beschreibung (`tools.rs`)**

`CLICK_ARGUMENTS` bekommt `contains_text` (der Kommentar über der Liste, `:57`,
zählt dann vier), das Schema verliert `selector` aus `required` und beschreibt die
Kombination, die Typ-Prüfung kommt dazu. Der Payload bildet auf `text` ab (Ziel 2).
Die Argument-Refusal in `unexpected_arguments` (`click` steht neben `:1236`/`:1239`)
nennt vier Namen, und `BROWSER_CLICK_DESCRIPTION` (`:392`) sagt nicht mehr „Clicks
the first element that matches the CSS selector" — das wäre nach dieser Spec
falsch und ist die einzige Stelle, an der der Agent `contains_text` vor dem ersten
Aufruf entdecken kann.

Beweis: Kriterien 1, 2, 6.

**Stufe 2 — Sätze und Abbildung (`failure.rs`, `texts.rs`)**

Zwei neue Sätze, eine zweite `NO_MATCH`-Form, zwei neue Arme im
`BROWSER_CLICK`-Zweig. `no_match` wählt die Form nach dem Aufruf: Selektor oder
Begriff; sind **beide** gesetzt, gewinnt der Begriff (`selector_of` bekommt ein
`match_of`-Gegenstück, dieselbe Regel wie in `docs/58`).

Beweis: Kriterien 3, 4, 5.

**Stufe 3 — Anleitung und Doku**

`help.rs`, `docs/06`, `docs/53`, `docs/54`, `docs/README.md`; der
Amendments-Abschnitt entfällt, die Spec wird `active`. Die Fallzahlen in `docs/54`
Kriterium 4 und `PROJECT-STATE.md`, Abschnitt „Beweise" werden nachgezogen.

Beweis: `npm run check` ⇒ 0, und `grep -n '60-klick' docs/README.md` zeigt
`active`.

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
