---
description: Ein Klick, der auf einer nicht lesbaren Seite landet, heißt not_readable_after_click statt not_readable — die Antwort sagt, dass der Klick durchging und der Weg zurück browser_navigate ist; Teil b der Teilung vom 2026-11-23.
status: proposed
---

# Der Klick sagt die Wahrheit, Teil b — die Seite danach

**Geteilt am 2026-11-23** von der Vorgänger-Spec (Runde 4 des Gates, vierter
Block). **Teil a** (`docs/56`) regelt, wohin der Klick geht. Diese Spec regelt, was
die Antwort bedeutet, wenn die Seite **nach** dem Klick nicht lesbar ist.

## Anlass

Eine Beobachtung vom 2026-11-23 aus dem Fork-Lauf 16:15 (`9B`,
`Qwen3.5-9B-UD-Q4_K_XL.gguf`, Export `2026-11-23_conversations.zip`).

`browser_click({selector:"div.s-result-item a[href*=\"70966\"]"})` führte auf
`https://aax-events-cell02-cf.eu-central.3px.axp.amazon-adsystem.com/…`. Die
Antwort lautete „The extension cannot read this page. Address: …". Der Klick hatte
stattgefunden. Nur die Seite danach ließ sich nicht injizieren. Das Modell las die
Antwort als Fehlschlag und wiederholte denselben Klick.

**Ursache, im Code nachgesehen.** Nach dem Klick liest `clickAgentTab` die Seite
(`extension/bridge.js:2796`). Scheitert das, reicht `clickErrorFor` (`:2752`) den
`ReadError` unverändert durch: aus dem Erfolg wird `not_readable`.

## Ziel

1. Landet der Klick auf einer Seite, die sich nicht injizieren lässt, antwortet
   `click` mit dem neuen Code **`not_readable_after_click`**.
2. Der englische Satz lautet, gepinnt in `extension/bridge.js` und in
   `bridge-rs/src/mcp/texts.rs`:

   ```
   The click went through, but the page it opened cannot be read: <url>. Go back with browser_navigate.
   ```
3. Der Fehlerrahmen trägt `url` (die Adresse nach dem Klick) und die Felder, die
   `not_readable` schon trägt (`kind`, `contentType`), soweit sie vorliegen. **Kein**
   `clicked`: `clickErrorFor` sieht das Element nicht mehr, und ein
   MCP-Werkzeugfehler ist beim Agenten ein Textblock (`tool_error`,
   `tools.rs:1202-1206`).
4. `read` behält `not_readable` unverändert. Der neue Code gilt **nur** im
   Klick-Pfad.

## Der Vertrag

| Feld | Regel |
|---|---|
| Code | `not_readable_after_click`, `isError: true` |
| Satz | der Wortlaut aus Ziel 2, englisch, gepinnte Konstante |
| Belegfelder | `url`; `kind` und `contentType` wie `not_readable` (`bridge.js:1997-2003`) |
| `clicked` | **nicht** im Fehlerrahmen |

`not_readable_after_click` entsteht in `clickErrorFor` **nach** dem Klick und ist
deshalb **kein** Eintrag in `CLICK_OUTCOMES` (`extension/bridge.js:505`) — das ist
die Liste der Ausgänge, die der Klick-Schnipsel in der Seite meldet.

## Non-goals

- **Keine Änderung an `read`.** Es behält `not_readable`.
- **Keine Änderung an der Lageprüfung.** Das ist `docs/56`.
- **Kein Feldfeld `clicked` im Fehler.** Siehe Ziel 3.
- **Kein neues Werkzeug.**

## Amendments to previous spec docs

- **`docs/06-klicken.md`**: der neue Code mit Satz und Belegfeldern.
- **`docs/15-ruhe-fuer-click-und-navigate.md`**: dort steht zweimal, der Klick
  antworte auf einer nicht injizierbaren Seite mit `not_readable` — im Klick-Pfad
  heißt das künftig `not_readable_after_click`.
- **`docs/54-refusals-englisch.md`**: der Satz kommt in die Textliste.
- **`docs/53-browser-help.md`**: die Anleitung von `browser_click` nennt den neuen
  Code und den Rückweg.

Nach der Umsetzung wird dieser Abschnitt entfernt.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `click_whenThePageAfterTheClickIsUnreadable_shouldAnswerNotReadableAfterClick` | der neue Code samt Satz, `url` und `kind` |
| `test/extension.test.js` | `click_whenThePageCannotBeReadAfterTheClick_shouldAnswerNotReadableAfterClick` (bestehend, `:7492`, umbenannt) | der alte Code `not_readable` ist im Klick-Pfad weg |
| `test/extension.test.js` | `click_whenThePageAfterTheClickIsUnreadable_shouldCarryTheAddressAndKind` (bestehend, `:7528`, umbenannt) | die Belegfelder bleiben |
| `test/extension.test.js` | `read_whenTheTabIsCompleteAndTheInjectionIsRefused_shouldAnswerNotReadable` (bestehend, `:4525`) | `read` ist unberührt |
| `bridge-rs/tests/mcp.rs` | `click_withNotReadableAfterClick_shouldNameTheReturnPath` | die Bridge bildet den Code auf den englischen Satz ab |
| `bridge-rs/tests/texts.rs` | `texts_shouldContainNoGermanUmlauts` | der Wächter aus `docs/54` deckt den neuen Satz |

## Acceptance criteria

1. **Der neue Code.** Eine Seite, die nach dem Klick `not_readable` liefert, ergibt
   `not_readable_after_click`; der Satz enthält `The click went through` und
   `browser_navigate`. Beleg: `npm test` ⇒ 0, `^# fail 0`, `^# cancelled 0`.
2. **Der alte Code ist im Klick-Pfad weg.** Beleg je Fall:
   `grep -cE '^ok [0-9]+ - click_whenThePageCannotBeReadAfterTheClick_shouldAnswerNotReadableAfterClick'`
   ⇒ 1; dazu `grep -c 'click_.*shouldPassNotReadableThrough' test/extension.test.js` ⇒ 0 — das
   Muster ist auf den Klick-Pfad eingeschränkt, `type_whenThePageCannotBeReadAfterTyping_shouldPassNotReadableThrough`
   (`:8803`) bleibt und zählt nicht mit.
3. **Die Belegfelder bleiben.** Der Fall `…shouldCarryTheAddressAndKind` prüft
   `url` und `kind`.
4. **`read` bleibt.** Der bestehende `read`-Fall bleibt grün, ohne Anpassung.
5. **Die Bridge kennt den Code.**
   `cargo test --test mcp click_withNotReadableAfterClick_shouldNameTheReturnPath`
   ⇒ grün.
6. **Alles andere grün.** `npm run check` ⇒ 0, `cargo test` ⇒ `test result: ok`
   mit `0 failed`, `bash scripts/parity.sh --impl rust --check` ⇒ 7/7.
   `3-extension-failures.txt` bleibt unberührt (`# cases=2`).

## Dev plan

Entwurf des Spec-Autors. Nach `CONTRIBUTING.md`, Schritt 3, gehört der Dev-Plan zu
einem zweiten Autor.

**Stufe 1 — der Code in der Extension (`extension/bridge.js`)**

`clickErrorFor` fängt den `ReadError` mit `code === "not_readable"` nur im
Klick-Pfad ab und ersetzt ihn durch `not_readable_after_click` samt Belegfeldern;
die zwei bestehenden Node-Fälle wandern mit.

Beweis: Kriterien 1, 2, 3 und 4.

**Stufe 2 — Bridge und Texte**

`bridge-rs/src/mcp/failure.rs` (Konstante und Arm), `texts.rs` (der Satz),
`bridge-rs/tests/mcp.rs`, `bridge-rs/tests/texts.rs`.

Beweis: Kriterium 5 (der Satz) und die Abbildung in der Bridge.

**Stufe 3 — Anleitung und Doku**

`bridge-rs/src/mcp/help.rs` (Anleitung `browser_click`), `docs/06`, `docs/15`,
`docs/53`, `docs/54`, `docs/README.md`; der Amendments-Abschnitt entfällt, die
Spec wird `active`. Die Fallzahlen in `docs/54` Kriterium 4 und
`PROJECT-STATE.md:33-34` werden nachgezogen.

Beweis: `npm run check` ⇒ 0, `grep -n '61-klick' docs/README.md` zeigt `active`.

## Touch boundary

| erlaubt | nicht |
|---|---|
| `extension/bridge.js` (`clickErrorFor`, Konstanten) | `extension/page-agent.js` — die Lage ist `docs/56` |
| `test/extension.test.js` (die zwei umbenannten Fälle und der bestehende `read`-Fall) | `extension/bridge.js` außerhalb des Klick-Pfads |
| `bridge-rs/src/mcp/failure.rs`, `texts.rs`, `help.rs`, `bridge-rs/tests/mcp.rs`, `texts.rs` | `bridge-rs/src/hub.rs`, `protocol.rs` |
| `docs/06`, `docs/15`, `docs/53`, `docs/54`, `docs/README.md`, `docs/PROJECT-STATE.md` | `docs/09`, `docs/56`, `docs/57`, `docs/58` |

## Bekannte Lücken

- **Ob der Klick „Erfolg" hatte, bleibt eine Deutung.** Die Seite danach ist nicht
  lesbar; mehr als die Adresse weiß die Extension nicht (2026-11-23).
- **`kind` und `contentType` fehlen bei manchen Zielen.** Sie kommen aus der
  HEAD-Anfrage aus `docs/11` und sind `null`, wenn sie nicht antwortet
  (2026-11-23).
- **Ein Klick, der eine Datei herunterlädt, landet hier.** Der Rückweg ist
  `browser_navigate`; ob ein Download eigene Behandlung braucht, ist offen
  (2026-11-23).

## Open questions

**Keine.** Der Satz und der Rückweg sind durch den Betreiberentscheid „die Antwort
sagt die Wahrheit" (2026-11-23) festgelegt.

## Review

### Runde 1 nach der Teilung — steht aus

Die Vorgänger-Spec hatte vier Runden; die Befunde, die dieses Thema betreffen,
stehen dort (Runde 1: `not_readable` trägt kein `frame`; Runde 2/3: der Träger für
`clicked`; Runde 4: die zwei bestehenden Fälle `:7492`, `:7528`). Alle sind hier
eingearbeitet.

## Log

- **2026-11-23, abgespalten.** Aus `docs/56` nach dem vierten Gate-Block. Beleg aus
  dem Fork 16:15 im Export `2026-11-23_conversations.zip`.

- **2026-11-23, Absprache.** Der Betreiber hat Ziel und Abnahmekriterien dieser
  Spec abgestimmt (`CONTRIBUTING.md`, Schritt 2). Der Bau kann beginnen, sobald
  der Dev-Plan von einem zweiten Autor geprüft ist.
