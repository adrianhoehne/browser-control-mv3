---
description: Ein vierzehntes Werkzeug browser_help liefert auf Anforderung die ausführliche Anleitung eines Werkzeugs samt Beispiel — ohne die Werkzeugliste zu vergrößern.
status: active
---

# `browser_help` — die Anleitung auf Abruf

Anlass: ein lokales Modell (pi-Sitzung 2026-11-22) rief `browser_read` mit einer URL
auf. Die Werkzeugliste ist der einzige Text, den ein Modell vorher liest — und sie
muss kurz bleiben. Ausführliche Anleitungen gehören deshalb hinter einen Aufruf,
nicht in die Liste.

## Ziel

- **`browser_help({tool})`** antwortet mit einer Anleitung zu genau einem Werkzeug:
  Zweck, Argumente, Antwortfelder, **ein vollständiges Beispiel**, die typischen
  Fehlgriffe und die verwandten Werkzeuge.
- **Die Werkzeugliste bleibt klein.** Gemessene Grenze, mit Befehl:
  `awk 'NR==5' scripts/parity/expected/1-initialize-and-tools-list.txt | wc -m`
  ⇒ vor dem Bau **7 825** Zeichen, nach dem Bau **≤ 8 500**. `browser_help` selbst
  bekommt eine einzeilige Beschreibung (≈ 150 Zeichen).
- **Unbekannter Name ist ein benannter Fehler**, keine leere Antwort, und nennt die
  gültigen Namen.

## Der Vertrag

| Feld | Regel |
|---|---|
| Name | `browser_help` |
| Argument | `tool` — Pflicht, einer der dreizehn Werkzeugnamen (auch `browser_help` selbst) |
| Antwort | ein Textfeld: Markdown, **englisch** (siehe `## Sprache`) |
| Unbekanntes `tool` | englischer Satz mit `isError: true`, der die gültigen Namen nennt: `` `name` is not a tool of this contract. Valid names: … `` |
| Fehlendes `tool` | eigener englischer Satz: `` browser_help needs `tool` — the name of a tool, for example `browser_read`. `` |
| Schlüssel außer `tool` | eigener englischer Satz: `` browser_help takes only `tool`. `` — `additionalProperties: false` braucht einen Arm |
| `tool` mit falschem Typ | derselbe Satz wie bei fehlendem `tool` |

**Kein Draht-Code.** Refusals der Bridge sind ein englischer Satz ohne Code; Codes
gehören der Extension (`bridge-rs/src/mcp/failure.rs`). `help_unknown_tool` ist der
**Zweigname in der Bridge**, kein Token auf der Leitung. Der Fall pinnt den Satz,
nach dem Muster von `browser_status takes no arguments.` (englisch seit `docs/54`).

**Kein Tab, keine Seite, kein Netz.** `browser_help` antwortet aus der Bridge, ohne
die Erweiterung zu fragen — es ist der einzige Werkzeugaufruf, der auch ohne
verbundene Extension antwortet. Das ist beabsichtigt: wer nicht weiß, wie ein
Werkzeug geht, soll die Anleitung auch dann lesen können, wenn nichts verbunden ist.

## Aufbau jeder Anleitung

Sechs Abschnitte, immer in dieser Reihenfolge — damit ein Modell sich nach dem
ersten Mal orientieren kann:

```
## Purpose
One sentence.

## Arguments
| Name | Required | Meaning |

## Returns
The fields that come back.

## Example
The call and the expected answer, shortened.

## Pitfalls
What goes wrong and why — the part that prevents the missteps.

## Related
The two or three tools used in the same flow.
```

## Sprache

**Alles, was der Agent liest, ist englisch** (Betreiberentscheidung 2026-11-22):
Werkzeugbeschreibungen, Beispiele und die `browser_help`-Anleitungen. Bis heute galt
Deutsch für Agenten-Meldungen; diese Entscheidung ersetzt sie für genau diese Texte.

**Nicht betroffen:** die Logzeilen der Bridge und der Erweiterung — sie liest der
Betreiber auf seiner Konsole, sie bleiben deutsch.

**Nachgezogen in `docs/54` (2026-11-22):** die Refusals der Bridge und die
Meldungen der Extension sind inzwischen ebenfalls englisch. Die vier Stellen, an
denen diese Spec vorher das Gegenteil sagte, sind dort aufgeführt und korrigiert.

## Wo die Texte liegen

`bridge-rs/src/mcp/help.rs`, ein `const` je Werkzeug, dazu eine Tabelle
`name → &str`. Sie sind **kein** Teil von `tools/list`, also kosten sie im
Normalbetrieb nichts.

**Der Text für `browser_read` ist der wichtigste** und enthält den Satz, der den
heutigen Fehlgriff verhindert hätte:

> `browser_read` reads the **current agent tab**. It opens nothing and takes
> **no URL**. Order: `browser_navigate` → `browser_read`.

## Non-goals

- **Keine dynamischen Texte.** Keine Version, kein Datum, keine Zustandsabfrage —
  sonst wäre die Antwort nicht reproduzierbar und nicht testbar.
- **Kein Ersatz für `tools/list`.** Die kurzen Beschreibungen bleiben, wo sie sind.
- **Keine Änderung an den anderen dreizehn Werkzeugen.**

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `bridge-rs/tests/mcp.rs` | `help_forEveryTool_shouldAnswerWithTheSixSections` | alle dreizehn Anleitungen haben die sechs Abschnitte |
| `bridge-rs/tests/mcp.rs` | `help_withAnUnknownTool_shouldNameTheValidOnes` | `help_unknown_tool`, Meldung enthält `browser_read` |
| `bridge-rs/tests/mcp.rs` | `help_forEveryTool_shouldAnswerWithTheSixSections` | antwortet ohne Erweiterung (`Seam::nobody`) |
| `bridge-rs/tests/mcp.rs` | `help_forRead_shouldSayThatItTakesNoUrl` | der Satz, der den Anlassfall verhindert |
| `scripts/parity/expected/…` | Fixture 1 und 2 | die Werkzeugliste und ein `help`-Aufruf |
| `bridge-rs/tests/help_contract.rs` | `every_manual_argument_shouldMatchTheToolSchema` | Argumenttabelle und Schema, in beiden Richtungen, für alle vierzehn Werkzeuge |
| `bridge-rs/tests/help_contract.rs` | `every_pinned_manual_returnLine_shouldNameExactlyTheAnsweredFields` | alle vierzehn Returns-Zeilen gegen gemessene Feldlisten (Stand 2026-11-26, `127.0.0.1:8111`) |
| `bridge-rs/tests/help_contract.rs` | `every_manual_example_shouldOnlyNameKeysOfItsSchemaAndItsReturnLine` | jeder Beispielaufruf gegen das Schema, jede zitierte Antwort gegen die Returns-Zeile |
| `bridge-rs/tests/help_contract.rs` | `the_pinnedTools_shouldBeEveryToolOfTheContract` | die gepinnten Listen decken genau die vierzehn Werkzeuge, keine fehlt, keine doppelt |
| `bridge-rs/tests/help_contract.rs` | `toolsList_shouldStayUnderTheCharacterBudget` | `tools/list` bleibt unter 8 500 Zeichen |

## Acceptance criteria

1. **Vierzehn Werkzeuge.** `tools/list` ⇒ 14 Einträge; `browser_help` ist dabei,
   `tools/list` bleibt **unter 8 500 Zeichen**.
2. **Jede Anleitung vollständig.** Der Test über alle dreizehn Namen ⇒ grün.
3. **Unbekannt nennt die gültigen Namen.**
   `browser_help({"tool":"gibtsnicht"})` ⇒ englischer Satz, `isError: true`, mit den
   dreizehn Namen (kein Draht-Code).
4. **Ohne Extension.** Der Fall antwortet, statt `no_extension` zu liefern.
5. **Der Rest bleibt grün.** Rust-Tests, `clippy -D warnings`, `npm test` und
   `parity.sh --impl rust --check` 7/7.

## Dev plan

**Stufe 1 — der Text und das Werkzeug**

Dateien: `bridge-rs/src/mcp/help.rs` (neu, dreizehn Anleitungen),
`bridge-rs/src/mcp/tools.rs` (Name, Schema, Dispatch), 
`bridge-rs/src/mcp/mod.rs` (Modul), `bridge-rs/tests/mcp.rs` (vier Fälle **und**
der Zähl-Pin `mcp_toolsList_shouldOfferExactlyTheFourteenToolsOfTheContract:995`
samt Namensarray), `bridge-rs/tests/http.rs` (`Some(13)` auf `:1030`).

Die Werkzeugzählung ist an zwei Stellen gepinnt; sie gehört in **eine** Stufe,
sonst ist der Bau nicht abnehmbar.

Beweis: Kriterien 1–4.

**Stufe 0 — die eingefrorene Fixture amortisieren (Freigabe des Betreibers)**

`scripts/parity/expected/1-initialize-and-tools-list.txt` ist ein **eingefrorenes**
Artefakt; `CONTRIBUTING.md:117` verbietet das Handanlegen, und `--record` gibt es
nicht mehr. Ein vierzehntes Werkzeug ändert die `tools/list`-Antwort, also **muss**
das Artefakt amendiert werden — als bewusster, datierter Akt mit Freigabe, nicht
als Nebenwirkung eines Werkzeugbaus.

Beweis: `scripts/parity.sh --self-test` vorher 7/7, nach der Amendierung `--check`
7/7; die Fixture-Zeile wächst um genau den neuen Werkzeugeintrag.

**Stufe 2 — die Fixture** entfällt. `2-tools.txt` bleibt unberührt: ihre 39 Fälle
sind `tools/call`-Antworten, und kein Kriterium braucht dort einen `help`-Fall.

## Touch boundary

| erlaubt | nicht |
|---|---|
| `bridge-rs/src/mcp/help.rs` (neu), `bridge-rs/src/mcp/tools.rs`, `bridge-rs/src/mcp/mod.rs` | `scripts/parity/**` — **nur** in Stufe 0, mit Freigabe |
| `bridge-rs/tests/mcp.rs`, `bridge-rs/tests/http.rs` | `extension/**` — keine Zeile ändert sich |
| `docs/README.md`, `docs/PROJECT-STATE.md` | `bridge-rs/src/hub.rs`, `protocol.rs` — kein Protokollschritt nötig |

## Bekannte Lücken

- **Die Texte sind handgeschrieben.** Sie können von der Wirklichkeit abweichen.
  Seit 2026-11-26 hält `bridge-rs/tests/help_contract.rs` Argumenttabellen,
  Returns-Zeilen und Beispiele gegen das Schema und gegen gemessene Feldlisten
  (fünf Fälle, siehe `## Testing`). Was der Test **nicht** kann: entscheiden, ob die
  Erweiterung diese Felder noch liefert — diese Messung gegen den laufenden Dienst
  bleibt Betreiberarbeit, und die gepinnten Listen müssen ihr folgen.
- **`browser_help` erklärt sich selbst**, aber nicht die MCP-Schicht darüber
  (`codemode` braucht `return`). Das bleibt beim Client.

## Open questions

**Keine.**

## Review

### Runde 1 — steht aus

Diese Spec war beim Bau bereits `active`; ihre Review-Runde ist nie nachgeholt
worden. Der Nachtrag in `docs/54` (Stufe 3) hat die Sprache korrigiert, nicht die
fehlende Runde ersetzt.

## Log

- **2026-11-26, Handbuch korrigiert und bewacht.** Drei Anleitungen sagten die
  Unwahrheit (`f67b45c`): `browser_type` zeigte `"enter": true` statt `submit`,
  `browser_transcript` nannte ein Argument `request`, `browser_click` verschwieg
  `truncated` und `via`. Der neue Wächter `bridge-rs/tests/help_contract.rs` fand
  beim ersten Lauf zwei weitere Drifts — `waitMs` in der Argumenttabelle von
  `browser_navigate`, `active` in der von `browser_open_tab`, beide kennt das
  Schema nicht —, die zwei Zeilen sind gestrichen. `7bf5153` hat vier weitere
  Returns-Zeilen nachgemessen (focus, inspect, frames, screenshot) und die Zeile
  von `status` um das Fensterfeld `type` ergänzt. Der Wächter hat fünf Fälle:
  Argumenttabellen in beiden Richtungen gegen `tools::tool_list()`, alle vierzehn
  Returns-Zeilen gegen gemessene Listen, Beispiele gegen Schema und Returns,
  `tools/list` unter 8 500 Zeichen; die Messung lief am 2026-11-26 gegen
  `127.0.0.1:8111`. Abnahme: `npm run check` Exit 0, sonst nichts geändert.

- **2026-11-22, gebaut und gemessen.** `browser_help` ist das vierzehnte Werkzeug;
  die dreizehn Anleitungen liegen in `bridge-rs/src/mcp/help.rs` und sind **nicht**
  Teil von `tools/list`. Gemessen: `awk 'NR==5'
  scripts/parity/expected/1-initialize-and-tools-list.txt | wc -m` ⇒ **8 238**
  Zeichen (Stand `c15f8b9`; vorher 7 825, Grenze 8 500; seit `docs/54` englische
  Beschreibungen, aktuell **8 062** Zeichen).
  Stufe 0 (Fixture-Amendierung) mit der Freigabe des Betreibers ausgeführt.
  Abnahme: 117 Rust-Fälle grün, `clippy -D warnings` sauber, `parity --check` 7/7,
  546 Node-Tests, `npm run check` 0.
  **Sprache:** Anleitungen und Beschreibungen englisch; die Refusals wurden
  nachträglich in `docs/54` ebenfalls englisch.

- **2026-11-22, Anlass:** lokales Modell ruft `browser_read` mit `url` auf; die
  Bridge antwortet freundlich, aber die Client-Schicht verschluckt die Antwort.
  Die Beschreibungen tragen seit `f38dcc1` einen Satz dagegen; die ausführliche
  Anleitung kommt mit diesem Werkzeug dazu.
