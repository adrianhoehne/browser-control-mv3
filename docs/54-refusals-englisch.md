---
description: Alle Meldungen, die der Agent liest, werden englisch — Refusals der Bridge, Fehlertexte der Extension und die Zuordnung der Fehlercodes.
status: proposed
---

# Refusals auf Englisch

Betreiberentscheid 2026-11-22: **alles, was der Agent liest, ist englisch.** Die
Werkzeugbeschreibungen und die `browser_help`-Anleitungen sind es seit `c15f8b9`;
dieser Schritt nimmt die Meldungen dazu.

## Umfang, gemessen am 2026-11-22

| Ort | deutsche Texte | Anmerkung |
|---|---|---|
| `bridge-rs/src/mcp/texts.rs` | **34** | Argument-Refusals, `unknown_tool`, Hinweise |
| `bridge-rs/src/mcp/failure.rs` | **1** + Zuordnung | Fehlercode → Satz der Extension |
| `extension/bridge.js` | **38** | Meldungen, die als Werkzeugantwort ankommen |
| `bridge-rs/tests/mcp.rs` | **14** Assertions | pinnen deutsche Sätze |
| `bridge-rs/tests/hub.rs` | **1** Assertion | dito |
| `scripts/parity/expected/2-tools.txt` | 39 Fälle | Antworttexte, eingefroren |
| `scripts/parity/expected/3-extension-failures.txt` | 4 Fälle | dito |

**Die Node-Tests pinnen keine dieser Texte** (`grep -c` über `test/*.js` ⇒ 0). Das
ist der Grund, warum dieser Schritt kleiner ist, als er aussieht.

## Ziel

- **Jede Meldung, die als Werkzeugantwort beim Agenten ankommt, ist englisch.**
  Fehlercodes bleiben, wie sie sind (`eval_not_allowed`, `page_not_readable`, …) —
  sie sind die Sprache der Leitung, nicht des Lesers.
- **Deutsch bleibt:** die Logzeilen der Bridge, die Kommentare im Code, die
  Dokumentation, die Optionsseite (der Betreiber liest sie, nicht der Agent).
- **Kein Verhalten ändert sich.** Dieselben Codes, dieselben Fälle, nur der Satz.

## Der Ton der neuen Texte

Kurz, aktiv, ohne Höflichkeitsfloskel — und jeder Satz nennt den nächsten Schritt,
wenn es einen gibt:

| heute | neu |
|---|---|
| „browser_read erwartet nur `offset`, `maxChars`, `mode`, `frame` und `tab`." | "browser_read takes only `offset`, `maxChars`, `mode`, `frame` and `tab`." |
| „Der Code im Agenten-Tab ist gescheitert: …" | "The code in the agent tab failed: …" |
| „Diese Seite kann die Extension nicht lesen." | "This page cannot be read by the extension." |
| „Die Seite verbietet eigenes Skript (CSP) — Werte lassen sich mit `read` oder `inspect` holen." | "The page forbids its own script (CSP) — read the values with `read` or `inspect` instead." |

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `bridge-rs/tests/texts.rs` (**neu**) | `texts_shouldContainNoGermanUmlauts` | kein `ä ö ü ß` in den Antworttexten — ein maschineller Wächter statt 34 Einzelprüfungen |
| `bridge-rs/tests/mcp.rs` | die 14 gepinnten Assertions | auf die englischen Sätze umgestellt |
| `bridge-rs/tests/hub.rs` | die eine Assertion | dito |
| `test/extension.test.js` | ein Fall | eine Meldung der Extension ist englisch |

**Der Umlaut-Wächter ist der eigentliche Beweis:** er fängt jede vergessene Zeile,
auch die, die niemand pinnt.

## Acceptance criteria

1. **Keine Umlaute in Antworttexten.**
   `grep -cE '[äöüß]' bridge-rs/src/mcp/texts.rs extension/bridge.js` ⇒ **0** für
   die Textkonstanten (Kommentare ausgenommen, dafür der Rust-Test).
2. **Die Werkzeugliste bleibt englisch.** `tools/list` unverändert 14 Werkzeuge.
3. **Parity 7/7** nach der Fixture-Amendierung (Freigabe liegt vor, `docs/PROJECT-STATE.md`).
4. **Alles andere grün.** 117+ Rust-Fälle, `clippy -D warnings`, 546 Node-Tests,
   `npm run check` 0.

## Dev plan

**Stufe 1 — die Bridge**

Dateien: `bridge-rs/src/mcp/texts.rs`, `bridge-rs/src/mcp/failure.rs`,
`bridge-rs/tests/mcp.rs` (14 Assertions), `bridge-rs/tests/hub.rs` (1).

Beweis: Kriterien 1, 2.

**Stufe 2 — die Extension**

Dateien: `extension/bridge.js` (38 Meldungen), `test/extension.test.js`.

Beweis: Kriterium 1.

**Stufe 3 — die Fixtures (Freigabe liegt vor)**

Dateien: `scripts/parity/expected/2-tools.txt`, `…/3-extension-failures.txt`.

Beweis: Kriterium 3, 4.

## Touch boundary

| erlaubt | nicht |
|---|---|
| `bridge-rs/src/mcp/{texts,failure}.rs`, `bridge-rs/tests/{mcp,hub,texts}.rs` | `docs/**` außer diesem Dokument und der Registry |
| `extension/bridge.js`, `test/extension.test.js` | `extension/page-agent.js` — dort steht kein Agententext |
| `scripts/parity/expected/2-tools.txt`, `3-extension-failures.txt` | die Logzeilen der Bridge (deutsch, der Betreiber liest sie) |

## Bekannte Lücken

- **Die Optionsseite bleibt englisch** — sie war es schon, sie ist Betreibertext.
- **Logzeilen bleiben deutsch.** Wer sie englisch will, sagt es; sie sind nicht
  Teil dieses Schritts.
- **Der Umlaut-Wächter prüft nur Umlaute.** Ein deutscher Satz ohne Umlaute
  („Der Code ist gescheitert.") rutscht durch — dagegen helfen nur die gepinnten
  Assertions.

## Open questions

**Keine.**

## Review

### Runde 1 — steht aus

## Log

- **2026-11-22, Umfang gemessen:** 34 Texte in `texts.rs`, 1 in `failure.rs`,
  38 in `bridge.js`, 15 gepinnte Assertions, zwei Fixtures. Die Node-Tests pinnen
  keine deutschen Meldungen.
