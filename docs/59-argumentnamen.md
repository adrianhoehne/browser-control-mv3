---
description: Die beiden mehrdeutigen Argumentnamen werden getrennt — browser_inspect und browser_click suchen mit contains_text, browser_type schreibt mit typed_text; der Draht zwischen Bridge und Extension behält text.
status: active
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
| `bridge-rs/tests/mcp.rs` | `help_forInspectAndType_shouldNameTheNewArguments` | die Anleitung (`help.rs`, Ziel 5) nennt `contains_text` und `typed_text` |

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
   10 000** Zeichen (Grenze seit 2026-11-26, `docs/70`).
6. **Die Anleitung nennt die neuen Namen.** Beleg: der Fall
   `help_forInspectAndType_shouldNameTheNewArguments` ⇒ `1 passed` (die Zeile zählt; ein
   Filter ohne Treffer endet mit 0 und `0 passed`).
7. **Alles andere grün.** `npm run check` ⇒ 0, `cargo test` ⇒ `test result: ok`
   mit `0 failed`,
   `bash scripts/parity.sh --impl rust --check` ⇒ 7/7 **nach** Stufe 0.

## Dev plan

Verfasst von einem zweiten Autor (2026-11-23), geprüft gegen den Code.

1. **Stufe 0 — die zwei eingefrorenen Artefakte, datierter Akt (Freigabe liegt vor: 2026-11-23)**
   `scripts/parity/expected/2-tools.txt` Zeile 63 (`browser_type takes only …`) und Zeile 67
   (`browser_inspect takes only …`); `scripts/parity/expected/1-initialize-and-tools-list.txt`
   Zeile 5 (`tools/list`: die zwei Schemata, `required` von `type`). Heute trägt Zeile 5
   **8 062** Zeichen (`awk 'NR==5' … | wc -m`); nach der Umbenennung rund 8 077, Grenze 8 500
   aus `docs/53`. In beiden Artefakten kommt jedes der zwei Werkzeuge genau einmal vor
   (`grep -c 'browser_type'`, `grep -c 'browser_inspect'`), also ändern sich drei Zeilen —
   kein Fall, keine Fallzahl, `# cases=39` bleibt.
   Proof: `bash scripts/parity.sh --impl rust --self-test; echo $?` ⇒ 7/7, 0 (vorher).
   **Stufe 0 und Stufe 1 gehen in einem Auftrag:** dazwischen ist `--check` rot, weil die
   Fixture den neuen Namen schon trägt und der Code ihn noch nicht ausgibt.

2. **Stufe 1 — Argumente, Schemata, Anleitungen (`bridge-rs/src/mcp/`)**
   `tools.rs`: `TYPE_ARGUMENTS` (`:64`) und `INSPECT_ARGUMENTS` (`:66-73`, die Zeile `"text",`
   ist `:68`); das `type`-Schema Property (`:186-188`) und `required` (`:201-204`), das
   `inspect`-Schema Property (`:231-233`). Lesestellen: die Tupel-Prüfung in `type_tool`
   (`:734-739`, `args.get("text")` ist `:736`), `payload.insert("text", …)` (`:758`)
   **bleibt** — `text` ist der Drahtname; die Prüfung „mindestens ein Filter" (`:795`);
   `has_declared_inspect_argument_types` (`:909-929`, die Typzeile `:916`; ihr Aufruf `:787`
   bleibt wörtlich); `declared_keys_of(&args, &INSPECT_ARGUMENTS)` (`:799`) — der Name wandert
   sonst wörtlich auf die Leitung, deshalb hier die Abbildung `contains_text` → `text` **in
   deklarierter Reihenfolge** (die Pins `mcp.rs:2821` und `:2823` prüfen sie). Die zwei Sätze
   in `unexpected_arguments` (`:1236` für `type`, Literal `:1239` für `inspect`).
   `texts.rs`: nur `INSPECT_NEEDS_FILTER` (`:115`). `help.rs`: `TYPE` (`:104-127`, Tabelle
   `:108-115`, Beispiel `:120`) und `INSPECT` (`:148-171`, Tabelle `:153-160`, Beispiel `:165`).
   Mitwandern in `bridge-rs/tests/mcp.rs`: `TYPE_UNEXPECTED_ARGUMENTS_TEXT` (`:723`),
   `INSPECT_NEEDS_FILTER_TEXT` (`:765`), `type_call` (`:477-483`), die Schemata-Pins
   (`:1090-1110`, `:1123-1138`), die Aufrufe `:2391`, `:2426`, `:2446`, `:2469`, `:3333`.
   Proof: `cargo test --manifest-path bridge-rs/Cargo.toml --test mcp
   mcp_toolsCallBrowserInspect_withContainsText_shouldSendTextOnTheWire -- --exact` ⇒
   `test result: ok. 1 passed`; dasselbe für `…BrowserType_withTypedText_shouldSendTextOnTheWire`,
   `…Inspect_withAnUnknownArgument_shouldNameContainsText`,
   `…Type_withAnUnknownArgument_shouldNameTypedText`,
   `…Inspect_withoutAnyFilter_shouldSayContainsText`, `…toolsList_shouldDeclareContainsTextAndTypedText`
   — **die Zeile zählt, nicht der Exit-Code:** ein Filter ohne Treffer endet mit 0 und
   `0 passed`. Dazu unverändert grün: `mcp_toolsCallBrowserInspect_withAFrame_shouldPassTheSubstringInSchemaOrder`
   (`:2794`, beweist die Draht-Reihenfolge) und `cargo test --test texts -- --exact
   texts_shouldContainNoGermanUmlauts` ⇒ `1 passed`. Kriterium 4:
   `grep -cE '^\s{4}"text",$' bridge-rs/src/mcp/tools.rs || true` ⇒ 0 (heute 1, Zeile 68).
   Kriterium 5: `awk 'NR==5' scripts/parity/expected/1-initialize-and-tools-list.txt | wc -m`
   ⇒ ≤ **10 000** Zeichen (Grenze seit 2026-11-26, `docs/70`). Kriterium 6: `bash scripts/parity.sh --impl rust --check; echo $?` ⇒ 7/7, 0 —
   nie gleichzeitig mit einer Testsuite, der Lauf besitzt 18115/18116.

3. **Stufe 2 — Doku**
   `docs/07`, `docs/09`, `docs/53`, `docs/54`, `docs/README.md` (Status), `docs/PROJECT-STATE.md`
   (Abschnitt „Beweise"); der Amendments-Abschnitt entfällt, die Spec wird `active`. Die
   Textzahl in `docs/54` Kriterium 4 wird abgelesen, nicht gerechnet. `extension/**` bleibt
   unangetastet: der Draht spricht weiter `text`, `sendInspect(socket, 2, { text: … })`
   (`test/extension.test.js:10322`) bleibt stehen.
   Proof: `npm test; echo $?` ⇒ 0 mit `^# fail 0` und `^# cancelled 0`; `npm run check; echo $?`
   ⇒ 0; `grep -n '59-argumentnamen' docs/README.md` zeigt `active`.

**Was schiefgehen kann**

- **Die Abbildung fehlt.** Ohne Stufe 1, letzter Punkt, liest die Extension `request.text` als
  `null` (`page-agent.js:831`), dann trifft **jedes** sichtbare Element (`:844`), und
  `hub.rs:996` druckt `text=-`; die zwei Hub-Fälle (`tests/hub.rs:2179`, `:2307`) werden rot.
- **Die Typ-Prüfung wird vergessen.** `:916` ist die einzige Stelle, die `{"contains_text":5}`
  abfängt; ohne sie geht die Zahl in die Seite. `:787` bleibt unverändert, weil die Funktion
  ihren eigenen Namen behält.
- **`MISSING_SELECTOR_MESSAGE` wird mit umbenannt.** `bridge.js:3084` benutzt dieselbe Konstante
  für `type`; sie steht in `extension/**`, also außerhalb der Touch boundary und außerhalb
  dieses Inkrements. `help.rs` führt in der `TYPE`-Tabelle außerdem `enter`, während das
  Argument `submit` heißt (`help.rs:110`, `tools.rs:189`) — eine bestehende Abweichung, die
  diese Spec nicht entscheidet; wer sie behebt, tut es sichtbar und nicht als Nebenwirkung.
- **Für `help.rs` gibt es kein Kriterium und keinen Fall** in `## Testing` — die Anleitung ist
  nur durch `grep` belegt. Der Plan erfindet keinen Fall; fehlt einer, gehört er in die Spec.

**Reihenfolge und Abhängigkeiten**

Stufe 0 hängt an Stufe 1 (ein Auftrag). Stufe 1 ist Voraussetzung für `docs/58` Stufe 2
(Name `contains_text`) und für `docs/60` Stufe 1 (Argumentliste von `click`). `help.rs` ist
derselbe `INSPECT`/`TYPE`-Block, den `docs/57` Stufe 2 anfasst: nacheinander im selben Baum,
nie parallel. Stufe 2 ist reine Doku und hängt an nichts Späterem.

**Was der nächste Inkrement erbt**

`docs/58` baut den Textklick mit diesem Namen, `docs/60` die vierte Zeile der
`browser_click`-Refusal; beide fassen Zeile 5 derselben Fixture an und brauchen je einen
eigenen datierten Akt. Der Drahtname `text` bleibt dauerhaft doppeldeutig
(`## Bekannte Lücken`) und wird in keinem der beiden Folge-Inkremente angefasst.
## Touch boundary

| erlaubt | nicht |
|---|---|
| `bridge-rs/src/mcp/tools.rs` (Argumentlisten, Schemata, alle vier Lesestellen, `unexpected_arguments`, `help.rs`) | `bridge-rs/src/hub.rs`, `protocol.rs` — kein Protokollschritt; die Logzeile bleibt bei `text` |
| `bridge-rs/tests/mcp.rs`, `bridge-rs/tests/texts.rs` | `extension/**`, `test/extension.test.js` — der Draht bleibt `text` |
| `scripts/parity/expected/2-tools.txt`, `1-initialize-and-tools-list.txt`, `scripts/parity/requests/2-call.jsonl`, `2-refusal.jsonl` — **nur** Stufe 0, mit Freigabe | `docs/56`, `docs/58` — eigener Zuschnitt |
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
- **Der `type`-Pfad prüft unbekannte Schlüssel vor den Typen, `inspect` umgekehrt.**
  Folge: `{"selector":"x","typed_text":7,"text":"y"}` bekommt den Argument-Satz,
  `{"selector":"x","contains_text":7,"text":"y"}` dagegen `-32602`. Beides ist
  harmlos, aber uneinheitlich; ein gemeinsamer Helfer wäre der Nachzug
  (Code-Review 2026-11-23).
- **Kein Test für einen falschen Typ des neuen Namens** (`{"contains_text": 5}`).
  Die Prüfung steht (`tools.rs:933`), der Fall fehlt — sie ist damit nur am Code
  belegt (Code-Review 2026-11-23).
- **`inspect_wire_arguments` kopiert `declared_keys_of`** (`tools.rs:1095-1107`):
  zwei Schleifen, die bei einem weiteren `inspect`-Argument auseinanderlaufen
  können. Sauberer wäre eine Umbenennungs-Map am Helfer (Code-Review 2026-11-23).
- **Zwei Kommentare im `type_tool` sind schief:** die Begründung der Prüf-Reihenfolge
  beruft sich auf `inspect_tool`, das es umgekehrt macht, und „Four checks" zählt
  fünf auf. Kein Verhalten, nur Text (Code-Review 2026-11-23).
- **Das `TYPE`-Beispiel in `help.rs` schickt `enter`**, das Argument heißt `submit`
  — bestehende Abweichung, die diese Spec nicht entscheidet, sondern an `docs/53`
  weiterreicht (Code-Review 2026-11-23).

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

### Runde 3 — `✅ Ship it` (2026-11-23)

Alle Runde-2-Blocker geschlossen: der `inspect`-Draht wandert über
`declared_keys_of` und braucht die Abbildung, die Sätze stehen in
`unexpected_arguments`, die vierte Lesestelle `:916` war ergänzt, und ein Test
pinnt die Leitung. Die Buchhaltung hier fehlte bis zum 2026-11-23.

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

- **2026-11-23, Touch boundary erweitert (Befund des Code-Reviews).** Die zwei
  Dateien `scripts/parity/requests/2-call.jsonl` und `2-refusal.jsonl` schickten
  `"text"` an `browser_type`; ohne sie wäre `--check` nach der Umbenennung rot,
  weil der Aufruf ein abgeschafftes Argument nennt. Sie gehören zu Stufe 0 und
  stehen jetzt in der erlaubten Spalte. Der Implementer hat es gemeldet, statt es
  zu verstecken.

- **2026-11-23, Stufe 2 nachgezogen, Spec `active`.** `docs/07` nennt das Argument
  `typed_text` (Signatur, Beispiel, Regel), `docs/09` nennt `contains_text` (Filter,
  `invalid_params`, der Satz ohne Filter, drei Testzeilen). `docs/53` brauchte keine
  Änderung: es beschreibt das Verfahren der Anleitung, nicht die Argumentnamen — die
  Anleitungen selbst stehen in `help.rs` und waren Teil von Stufe 1. `docs/54` trägt
  die zwei geänderten Sätze und den Filter-Satz, mit Datum. Die Fallzahlen sind
  abgelesen: `cargo test` 292 (122 in `mcp.rs`), `npm test` 548; sie stehen in
  `docs/PROJECT-STATE.md` (Abschnitt „Beweise") und in `docs/54` Kriterium 4.
