---
description: Die beiden mehrdeutigen Argumentnamen werden getrennt — browser_inspect und browser_click suchen mit contains_text, browser_type schreibt mit typed_text; der Draht zwischen Bridge und Extension behält text.
status: proposed
---

# Ein Name pro Bedeutung

## Anlass

Am 2026-11-23 fiel beim Entwurf des Textklicks (`docs/58`) auf, dass der Name
`text` zwei Bedeutungen hat:

| Werkzeug | `text` bedeutet heute |
|---|---|
| `browser_inspect` | der **Suchbegriff** — ein Teilstring im sichtbaren Text (`docs/09`) |
| `browser_type` | der Text, der **geschrieben** wird (`docs/07`) |

Der Betreiber hat entschieden: getrennte Namen. Suche heißt `contains_text`,
Schreiben heißt `typed_text`. Beide gelten in allen Werkzeugen, die sie brauchen.

**Die Messung, die die Verwechslung zeigt.** Im 9B-Lauf am 2026-11-23 rief das
Modell `browser_inspect({"selector":"input","text":"input field"})` auf und
erwartete eine Beschreibung des Ziels. Antwort: `count: 0`. Es hatte `text` als
Nebenbemerkung gelesen, nicht als Bedingung. Ein Name, der die Bedeutung trägt,
senkt dieses Risiko; die Regel selbst bleibt, wie `docs/09` sie beschreibt.

## Ziel

1. **`browser_inspect`**: `text` heißt künftig `contains_text`. Bedeutung
   unverändert: Teilstring, Groß/Klein egal, im sichtbaren Text.
2. **`browser_type`**: `text` heißt künftig `typed_text`. Bedeutung unverändert:
   der Text, der ins Feld geht.
3. **`browser_click`** bekommt `contains_text` für den Textklick — das baut
   `docs/58`, mit diesem Namen.
4. **Keine Aliase.** Ein Aufruf mit `text` wird abgelehnt. Die Argumentprüfung tut
   das schon heute für jeden unbekannten Schlüssel; der Satz nennt die neuen
   Namen, damit der Fehlgriff sichtbar wird.
5. Die Anleitungen in `bridge-rs/src/mcp/help.rs` nennen die neuen Namen.
   `help.rs` ist Produktivcode (`const INSPECT`, `const TYPE`), kein Doku-Nachtrag;
   es gehört in dieselbe Stufe wie die Schemata.
6. **Der Draht bleibt bei `text` — und das braucht eine Abbildung.**
   `browser_inspect` baut seinen Payload mit
   `declared_keys_of(&args, &INSPECT_ARGUMENTS)` (`tools.rs:799`, Funktion
   `:1054-1062`): der Argumentname wandert **wörtlich** auf die Leitung. Ohne
   Abbildung liest die Extension `request.text` (`extension/page-agent.js:831`)
   als `null`, dann trifft **jedes** sichtbare Element (`:844` prüft
   `needle !== null`), und die Logzeile `inspect selector=… text=… found=…`
   (`bridge-rs/src/hub.rs:992-999`) sagt `text=-`. Deshalb: nach dem Muster des
   `type`-Pfads (`payload.insert("text", …)`, `tools.rs:758`) wird
   `contains_text` beim Befüllen auf den Draht-Schlüssel `text` abgebildet. Die
   Logzeile und ihre zwei Fälle in `bridge-rs/tests/hub.rs` (`:2179`, `:2307`)
   bleiben unverändert.
7. **Der Satz `browser_inspect needs \`selector\` or \`text\`.`** (`texts.rs:115`,
   `INSPECT_NEEDS_FILTER`) nennt danach `contains_text`.

## Der Vertrag

| Werkzeug | alt | neu | Bedeutung |
|---|---|---|---|
| `browser_inspect` | `text` | `contains_text` | Suchbegriff, Teilstring |
| `browser_type` | `text` | `typed_text` | der Text, der geschrieben wird |
| `browser_click` | — | `contains_text` | neu, aus `docs/58` |

Die Sätze der Argumentprüfung nennen danach:

```
browser_inspect takes only `selector`, `contains_text`, `limit`, `includeHidden`, `frame` and `tab`.
browser_type takes only `selector`, `typed_text`, `submit`, `frame` and `tab`.
```

**Die Zeile für `browser_click` fehlt hier mit Absicht.** Sie gehört `docs/58`,
weil dort das Argument entsteht. Diese Spec fasst `click` nicht an — sonst hinge
Stufe 1 an einer späteren Spec, und genau das verbietet `docs/README.md`.

## Was unverändert bleibt

- **Die Node-Tests.** `test/extension.test.js` spricht den Draht, nicht MCP:
  `sendInspect(socket, 2, { text: … })` (`:10322`) und die `type`-Fälle schicken
  weiterhin `text`. Die 68 Treffer von `grep -o 'text: "' …` bleiben stehen; rund
  zehn davon sind ohnehin Ergebnisfelder.
- **Ergebnisfelder.** `read` liefert weiter `text`, `inspect` je Element weiter
  `text`. Das sind keine Argumente.

## Non-goals

- **Keine Änderung der Bedeutungen.** Nur die Namen wandern.
- **Kein Alias und keine Übergangsfrist.** Zwei Namen für eine Sache wären der
  Fehler, den diese Spec behebt.
- **Keine Umbenennung anderer Argumente.** `selector`, `frame`, `tab`, `limit`,
  `includeHidden`, `submit`, `offset`, `maxChars` und `mode` bleiben.
- **Kein Absenken der neuen Namen auf den Draht.** Siehe Ziel 6.

## Amendments to previous spec docs

- **`docs/09-dom-abfrage.md`**: `text` → `contains_text` in Filter, Beispielen,
  der Sonderregel für den leeren Suchbegriff und im zitierten Satz
  `INSPECT_NEEDS_FILTER`.
- **`docs/07-tippen.md`**: `text` → `typed_text`.
- **`docs/54-refusals-englisch.md`**: die zwei Argument-Sätze und der Satz
  `INSPECT_NEEDS_FILTER`.
- **`docs/53-browser-help.md`**: die Anleitungen von `inspect` und `type` nennen
  die neuen Namen.
- **`docs/57-inspect-engster-treffer.md`** und **`docs/58-klick-nach-text.md`**:
  sie werden mit den neuen Namen gebaut. Die historischen Zitate der Aufrufe vom
  2026-11-23 bleiben, wie sie waren — sie sind Messungen.

Nach der Umsetzung wird dieser Abschnitt entfernt.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `bridge-rs/tests/mcp.rs` | `mcp_toolsCallBrowserInspect_withContainsText_shouldSendTextOnTheWire` | der neue Name wird auf der Leitung zu `text` — der Fall, ohne den die Umbenennung die Suche bricht |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsCallBrowserType_withTypedText_shouldSendTextOnTheWire` | dito für `type` |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsCallBrowserInspect_withAnUnknownArgument_shouldNameContainsText` | ein alter Aufruf wird abgelehnt, der Satz nennt `contains_text` |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsCallBrowserType_withAnUnknownArgument_shouldNameTypedText` | dito für `typed_text` |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsCallBrowserInspect_withoutAnyFilter_shouldSayContainsText` | `INSPECT_NEEDS_FILTER` nennt den neuen Namen |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsList_shouldDeclareContainsTextAndTypedText` | die Schemata tragen die neuen Namen, nicht die alten |
| `bridge-rs/tests/texts.rs` | `texts_shouldContainNoGermanUmlauts` | der Wächter aus `docs/54` deckt die geänderten Sätze |
| `scripts/parity/expected/2-tools.txt` | Zeilen 63 und 67 | die Sätze nennen die neuen Namen (Stufe 0, mit Freigabe) |
| `scripts/parity/expected/1-initialize-and-tools-list.txt` | Zeile 5 | `tools/list` trägt die neuen Schemata (Stufe 0, mit Freigabe) |
| `scripts/parity/expected/2-tools.txt` | Zeilen 63 und 67 | die Sätze nennen die neuen Namen (Stufe 0, mit Freigabe) |
| `scripts/parity/expected/1-initialize-and-tools-list.txt` | Zeile 5 | `tools/list` trägt die neuen Schemata (Stufe 0, mit Freigabe) |

## Acceptance criteria

1. **Suche mit dem neuen Namen, und der Draht bleibt `text`.**
   `browser_inspect({"contains_text":"Login"})` antwortet mit Treffern wie
   heute, und die Anfrage auf der Leitung trägt `"text"`. Beleg:
   `cargo test --test mcp mcp_toolsCallBrowserInspect_withContainsText_shouldSendTextOnTheWire`
   ⇒ grün; dazu `npm test` ⇒ 0, `^# fail 0`, `^# cancelled 0`.
2. **Schreiben mit dem neuen Namen.**
   `browser_type({"selector":"input","typed_text":"x"})` schreibt. Beleg:
   `cargo test --test mcp mcp_toolsCallBrowserType_withTypedText_shouldSendTextOnTheWire`
   ⇒ grün; der Satz in `2-tools.txt` Zeile 63 nennt `typed_text`.
3. **Der alte Name fällt auf.** `browser_inspect({"text":"Login"})` und
   `browser_type({"selector":"input","text":"x"})` werden abgelehnt. Beleg:
   `cargo test --test mcp` ⇒ die zwei Fälle aus der Tabelle grün; die Sätze nennen
   `contains_text` bzw. `typed_text`.
4. **Kein Rest in der Argumentliste.** `grep -cE '^\s{4}"text",$'
   bridge-rs/src/mcp/tools.rs` ⇒ **0** (heute 1, Zeile 68); als Befehl mit
   `|| true`, weil `grep -c` bei 0 Treffern mit Exit 1 endet.
5. **Die Liste bleibt klein.** `awk 'NR==5'
   scripts/parity/expected/1-initialize-and-tools-list.txt | wc -m` ⇒ **höchstens
   8 500** (heute 8 062, Grenze aus `docs/53`).
6. **Alles andere grün.** `npm run check` ⇒ 0, `cargo test` ⇒ `test result: ok`
   mit `0 failed`,
   `bash scripts/parity.sh --impl rust --check` ⇒ 7/7 **nach** Stufe 0.

## Dev plan

Entwurf des Spec-Autors. Nach `CONTRIBUTING.md`, Schritt 3, gehört der Dev-Plan zu
einem zweiten Autor; die Stufen hier sind Vorschlag, nicht Abnahme.

**Stufe 0 — die zwei eingefrorenen Fixtures amortisieren (Freigabe des Betreibers)**

Zwei Artefakte ändern sich, beide `scripts/parity/expected/`:

- `2-tools.txt` Zeile 63 (`browser_type takes only …`) und Zeile 67
  (`browser_inspect takes only …`).
- `1-initialize-and-tools-list.txt` Zeile 5: die `tools/list`-Antwort trägt die
  Schemata, also die Argumentnamen. Heute 8 062 Zeichen. Ohne diese Amendierung
  ist Kriterium 5 nicht erreichbar und `--check` rot.

Das ist derselbe bewusste, datierte Akt wie in `docs/53`, Stufe 0 — nicht die
Nebenwirkung eines Argumentbaus. **Die Freigabe des Betreibers liegt vor
(2026-11-23).** **Stufe 0 und Stufe 1 gehen in einem Auftrag:**
zwischen beiden ist `--check` rot, weil die Fixture den neuen Namen schon trägt
und der Code ihn noch nicht ausgibt. Ein einzelner Commit für Stufe 0 ist nach
`CONTRIBUTING.md` („no commit without green acceptance") nicht möglich.

Beweis: `--self-test` vorher 7/7, nach Stufe 1 `--check` 7/7. Geändert haben sich
ganz genau zwei Zeilen in `2-tools.txt` und eine in
`1-initialize-and-tools-list.txt`.

**Stufe 1 — Argumente, Schemata, Anleitungen (`bridge-rs/src/mcp/`)**

`tools.rs`:

- `TYPE_ARGUMENTS` und `INSPECT_ARGUMENTS` (`:58`, `:66-73`) und die zwei
  JSON-Schemata.
- Die vier Lesestellen: `args.get("text")` in `:736` (`type`), die Prüfung
  `:795` (`INSPECT_NEEDS_FILTER`) und `:916`
  (`has_declared_inspect_argument_types`, `:909-929`) — ohne die letzte prüft die
  Bridge den Typ von `contains_text` nicht, und `{"contains_text":5}` geht in die
  Seite.
- `payload.insert("text", …)` in `:758` **bleibt**; die `inspect`-Payload-
  Abbildung kommt neu dazu (Ziel 6).
- Die zwei Sätze in `unexpected_arguments` (`:1230-1250`): `:1236` (`type`) und
  `:1239` (`inspect`). Sie sind String-Literale in `tools.rs`, **nicht** in
  `texts.rs`.
- `help.rs`: die Anleitungen `INSPECT` und `TYPE`.

`texts.rs`: nur `INSPECT_NEEDS_FILTER` (`:115`).

Beweis: Kriterien 1 bis 5.

**Stufe 2 — Doku**

`docs/07`, `docs/09`, `docs/53`, `docs/54`, `docs/README.md`; der
Amendments-Abschnitt entfällt, die Spec wird `active`.

Beweis: Kriterium 5 und `npm run check`.

## Touch boundary

| erlaubt | nicht |
|---|---|
| `bridge-rs/src/mcp/tools.rs` (Argumentlisten, Schemata, alle vier Lesestellen, `unexpected_arguments`, `help.rs`) | `bridge-rs/src/hub.rs`, `protocol.rs` — kein Protokollschritt; die Logzeile bleibt bei `text` |
| `bridge-rs/tests/mcp.rs`, `bridge-rs/tests/texts.rs` | `extension/**`, `test/extension.test.js` — der Draht bleibt `text` |
| `scripts/parity/expected/2-tools.txt`, `1-initialize-and-tools-list.txt` — **nur** Stufe 0, mit Freigabe | `docs/56`, `docs/58` — eigener Zuschnitt |
| `docs/07`, `docs/09`, `docs/53`, `docs/54`, `docs/README.md`, `docs/PROJECT-STATE.md` | `docs/06` — das Argument von `click` kommt mit `docs/58` |

## Bekannte Lücken

- **Ein Client mit dem alten Namen bricht.** Das ist gewollt; die Ablehnung nennt
  den neuen Namen. Eine Übergangsfrist wäre der zweite Name, den diese Spec
  vermeidet (2026-11-23).
- **`README.md` und `INSTALL.md` zitieren keine Argumentnamen**, geprüft am
  2026-11-23; sie bleiben unberührt.
- **Der interne Name `text` bleibt auf der Leitung.** Wer `bridge.js` liest, sieht
  beide Welten. Das ist billiger als ein Protokollschritt und steht als Ziel 6
  ausdrücklich da (2026-11-23).
- **`browser_click` fehlt in dieser Umbenennung**, bis `docs/58` gebaut ist. Bis
  dahin hat `click` kein `text`-Argument, also auch keinen falschen Namen
  (2026-11-23).

## Open questions

**Keine.** Beide Entscheidungen sind am 2026-11-23 gefallen: getrennte Namen, und
`contains_text` gilt auch in `inspect`.

## Review

### Runde 1 — `🔧 Fix these` (2026-11-23)

Sechs Blocker, drei Major, mehrere Minor. Alle übernommen: das Kriterium 4 war nie
grün (`"text"` steht auch in Inhaltsblöcken), Stufe 0 nannte `1-initialize…`
nicht, `INSPECT_NEEDS_FILTER` fehlte überall, der `click`-Satz hing an `docs/58`,
Stufe 2 war überflüssig (der Draht bleibt `text`), und „68 Stellen" hätte
Ergebnisfelder mit umbenannt.

### Runde 2 — `🔧 Fix these` (2026-11-23)

Fünf Blocker, alle übernommen: Der `inspect`-Draht wird **nicht** von Hand gebaut,
sondern über `declared_keys_of(&args, &INSPECT_ARGUMENTS)` (`tools.rs:799`) — der
Argumentname wandert wörtlich auf die Leitung. Ohne Abbildung liest die Extension
`request.text` als `null`, und jedes sichtbare Element trifft. Die zwei
Argument-Sätze stehen in `unexpected_arguments` (`tools.rs:1236`, `:1239`), nicht
in `texts.rs`. Die vierte Lesestelle `has_declared_inspect_argument_types`
(`:916`) fehlte. Kein Test pinnte die Leitung; er heißt jetzt
`mcp_toolsCallBrowserInspect_withContainsText_shouldSendTextOnTheWire`. Stufe 0
allein lässt `--check` rot — Stufe 0 und 1 gehen in einem Auftrag. Dazu `help.rs`
von „Doku" nach Stufe 1 verschoben: es ist Produktivcode.

### Runde 3 — steht aus

## Log

- **2026-11-23, angelegt.** Betreiberentscheid beim Entwurf von `docs/58`:
  `contains_text` für die Suche (in `inspect` und `click`), `typed_text` für das
  Schreiben in `type`.

- **2026-11-23, Review-Runde 1 eingearbeitet.** Stufe 2 (Extension) gestrichen:
  die Node-Tests sprechen den Draht, und der Draht behält `text`
  (`test/extension.test.js:10322`). Kriterium 4 auf die Argumentliste eingegrenzt
  (`^\s{4}"text",$` ⇒ heute 1 Treffer, Zeile 68). Stufe 0 nennt beide Fixtures,
  `1-initialize-and-tools-list.txt` Zeile 5 mit 8 062 Zeichen. Der `click`-Satz
  ist aus dem Vertrag entfernt und steht in `docs/58`.

- **2026-11-23, Absprache.** Der Betreiber hat Ziel und Abnahmekriterien dieser
  Spec abgestimmt (`CONTRIBUTING.md`, Schritt 2). Der Bau kann beginnen, sobald
  der Dev-Plan von einem zweiten Autor geprüft ist.
