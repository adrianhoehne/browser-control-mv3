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
- **Die Werkzeugliste wächst nicht.** `tools/list` bleibt bei **8 068 Zeichen**;
  `browser_help` selbst bekommt eine einzeilige Beschreibung (≈ 150 Zeichen).
- **Unbekannter Name ist ein benannter Fehler**, keine leere Antwort, und nennt die
  gültigen Namen.

## Der Vertrag

| Feld | Regel |
|---|---|
| Name | `browser_help` |
| Argument | `tool` — Pflicht, einer der dreizehn Werkzeugnamen (auch `browser_help` selbst) |
| Antwort | ein Textfeld: Markdown, deutsch, wie alle Agenten-Meldungen |
| Unbekanntes `tool` | Fehler `help_unknown_tool`, Meldung nennt die gültigen Namen |
| Fehlendes `tool` | Fehler `invalid_params` (dieselbe Form wie bei den anderen Werkzeugen) |

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
3. **Unbekannt ist benannt.** `browser_help({"tool":"gibtsnicht"})` ⇒
   `help_unknown_tool` mit den gültigen Namen in der Meldung.
4. **Ohne Extension.** Der Fall antwortet, statt `no_extension` zu liefern.
5. **Der Rest bleibt grün.** Rust-Tests, `clippy -D warnings`, `npm test` und
   `parity.sh --impl rust --check` 7/7.

## Dev plan

**Stufe 1 — der Text und das Werkzeug**

Dateien: `bridge-rs/src/mcp/help.rs` (neu, dreizehn Anleitungen), 
`bridge-rs/src/mcp/tools.rs` (Name, Schema, Dispatch), 
`bridge-rs/src/mcp/mod.rs` (Modul), `bridge-rs/tests/mcp.rs` (vier Fälle).

Beweis: Kriterien 1–4.

**Stufe 2 — die Fixtures**

Dateien: `scripts/parity/expected/1-initialize-and-tools-list.txt`,
`…/2-tools.txt`.

Beweis: Kriterium 5.

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
