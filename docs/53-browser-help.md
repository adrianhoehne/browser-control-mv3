---
description: Ein vierzehntes Werkzeug browser_help liefert auf Anforderung die ausführliche Anleitung eines Werkzeugs samt Beispiel — ohne die Werkzeugliste zu vergrößern.
status: proposed
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
  ⇒ heute **7 825** Zeichen, nach dem Bau **≤ 8 500**. `browser_help` selbst
  bekommt eine einzeilige Beschreibung (≈ 150 Zeichen).
- **Unbekannter Name ist ein benannter Fehler**, keine leere Antwort, und nennt die
  gültigen Namen.

## Der Vertrag

| Feld | Regel |
|---|---|
| Name | `browser_help` |
| Argument | `tool` — Pflicht, einer der dreizehn Werkzeugnamen (auch `browser_help` selbst) |
| Antwort | ein Textfeld: Markdown, **englisch** (siehe `## Sprache`) |
| Unbekanntes `tool` | deutscher Satz mit `isError: true`, der die gültigen Namen nennt |
| Fehlendes `tool` | derselbe deutsche Satz (die Bridge prüft Argumente selbst, nicht die Extension) |
| Schlüssel außer `tool` | derselbe deutsche Satz — `additionalProperties: false` braucht einen Arm |
| `tool` mit falschem Typ | derselbe deutsche Satz |

**Kein Draht-Code.** Refusals der Bridge sind ein deutscher Satz ohne Code; Codes
gehören der Extension (`bridge-rs/src/mcp/failure.rs`). `help_unknown_tool` ist der
**Zweigname in der Bridge**, kein Token auf der Leitung. Der Fall pinnt den Satz,
nach dem Muster von `browser_status erwartet keine Argumente.`

**Kein Tab, keine Seite, kein Netz.** `browser_help` antwortet aus der Bridge, ohne
die Erweiterung zu fragen — es ist der einzige Werkzeugaufruf, der auch ohne
verbundene Extension antwortet. Das ist beabsichtigt: wer nicht weiß, wie ein
Werkzeug geht, soll die Anleitung auch dann lesen können, wenn nichts verbunden ist.

## Aufbau jeder Anleitung

Sechs Abschnitte, immer in dieser Reihenfolge — damit ein Modell sich nach dem
ersten Mal orientieren kann:

```
## Zweck
Ein Satz.

## Argumente
| Name | Pflicht | Bedeutung |

## Antwort
Die Felder, die zurückkommen.

## Beispiel
Aufruf und die erwartete Antwort (gekürzt).

## Fallstricke
Was schiefgeht und warum — der Teil, der die Fehlgriffe verhindert.

## Verwandt
Die zwei, drei Werkzeuge, die im selben Ablauf gebraucht werden.
```

## Sprache

**Alles, was der Agent liest, ist englisch** (Betreiberentscheid 2026-11-22):
Werkzeugbeschreibungen, Beispiele und die `browser_help`-Anleitungen. Bis heute galt
Deutsch für Agenten-Meldungen; dieser Entscheid ersetzt es für genau diese Texte.

**Nicht betroffen:** die Refusals der Bridge (deutsche Sätze wie
„browser_read erwartet nur …") und die Logzeilen. Sie werden in einem eigenen
Increment umgestellt, weil sie in Tests und Parity-Fixtures gepinnt sind.

> **OFFENE FRAGE:** soll die Umstellung auf Englisch auch die Refusals erfassen?
> Dann sind `texts.rs`, `failure.rs`, mehrere Node-Tests und zwei Fixtures
> betroffen — ein eigener Schnitt mit eigener Spec.

## Wo die Texte liegen

`bridge-rs/src/mcp/help.rs`, ein `const` je Werkzeug, dazu eine Tabelle
`name → &str`. Sie sind **kein** Teil von `tools/list`, also kosten sie im
Normalbetrieb nichts.

**Der Text für `browser_read` ist der wichtigste** und enthält den Satz, der den
heutigen Fehlgriff verhindert hätte:

> `browser_read` liest den **aktuellen Agenten-Tab**. Es öffnet nichts und nimmt
> **keine** URL. Reihenfolge: `browser_navigate` → `browser_read`.

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
| `bridge-rs/tests/mcp.rs` | `help_shouldAnswerWithoutAConnectedExtension` | antwortet ohne Erweiterung |
| `bridge-rs/tests/mcp.rs` | `help_forRead_shouldSayThatItTakesNoUrl` | der Satz, der den Anlassfall verhindert |
| `scripts/parity/expected/…` | Fixture 1 und 2 | die Werkzeugliste und ein `help`-Aufruf |

## Acceptance criteria

1. **Vierzehn Werkzeuge.** `tools/list` ⇒ 14 Einträge; `browser_help` ist dabei,
   `tools/list` bleibt **unter 8 500 Zeichen**.
2. **Jede Anleitung vollständig.** Der Test über alle dreizehn Namen ⇒ grün.
3. **Unbekannt nennt die gültigen Namen.**
   `browser_help({"tool":"gibtsnicht"})` ⇒ deutscher Satz, `isError: true`, mit den
   dreizehn Namen (kein Draht-Code).
4. **Ohne Extension.** Der Fall antwortet, statt `no_extension` zu liefern.
5. **Der Rest bleibt grün.** Rust-Tests, `clippy -D warnings`, `npm test` und
   `parity.sh --impl rust --check` 7/7.

## Dev plan

**Stufe 1 — der Text und das Werkzeug**

Dateien: `bridge-rs/src/mcp/help.rs` (neu, dreizehn Anleitungen),
`bridge-rs/src/mcp/tools.rs` (Name, Schema, Dispatch), 
`bridge-rs/src/mcp/mod.rs` (Modul), `bridge-rs/tests/mcp.rs` (vier Fälle **und**
der Zähl-Pin `mcp_toolsList_shouldOfferExactlyTheThirteenToolsOfTheContract:992`
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

- **Die Texte sind handgeschrieben.** Sie können von der Wirklichkeit abweichen —
  dagegen hilft nur, dass die Beispiele gegen den laufenden Dienst geprüft werden,
  und das ist Betreiberarbeit.
- **`browser_help` erklärt sich selbst**, aber nicht die MCP-Schicht darüber
  (`codemode` braucht `return`). Das bleibt beim Client.

## Open questions

**Keine.**

## Review

### Runde 1 — steht aus

## Log

- **2026-11-22, Anlass:** lokales Modell ruft `browser_read` mit `url` auf; die
  Bridge antwortet freundlich, aber die Client-Schicht verschluckt die Antwort.
  Die Beschreibungen tragen seit `f38dcc1` einen Satz dagegen; die ausführliche
  Anleitung kommt mit diesem Werkzeug dazu.
