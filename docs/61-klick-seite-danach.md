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
(`extension/bridge.js:2998`, dort wird die Seite nach dem Klick gelesen). Scheitert das, reicht `clickErrorFor` (`:2752`) den
`ReadError` unverändert durch: aus dem Erfolg wird `not_readable`.

## Ziel

1. Landet der Klick auf einer Seite, die sich nicht injizieren lässt, antwortet
   `click` mit dem neuen Code **`not_readable_after_click`**.
   **Die Umbenennung hängt daran, dass geklickt wurde.** Ist der Agenten-Tab schon
   vor dem Klick unlesbar (`about:config`, PDF-Viewer, `view-source:`), scheitert
   die erste Injektion; dann bleibt es bei `not_readable`, denn nichts ging durch
   und keine Seite wurde geöffnet (Code-Review 2026-11-23).
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
| vor dem Klick unlesbar | `not_readable`, kein neuer Code — der Klick wurde nie ausgeführt |

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
| `test/extension.test.js` | `click_whenThePageCannotBeReadAfterTheClick_shouldAnswerNotReadableAfterClick` (bestehend `:7492`, umbenannt und erweitert) | der neue Code, der Satz mit beiden Teilen, `url`; der alte Code `not_readable` ist im Klick-Pfad weg |
| `test/extension.test.js` | `click_whenThePageAfterTheClickIsUnreadable_shouldCarryTheAddressAndKind` (bestehend, `:7528`, umbenannt) | die Belegfelder bleiben |
| `test/extension.test.js` | `click_onATabThatIsUnreadableBeforeTheClick_shouldAnswerNotReadable` (neu) | die Umbenennung hängt am Klick: ohne Klick bleibt `not_readable`, der Satz behauptet nichts über einen Klick |
| `test/extension.test.js` | `click_whenTheClickedPageHasNoAddress_shouldAnswerTheShortSentence` (neu) | die kurze Satzform ohne Adresse ist gepinnt, nicht nur die lange |
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
   `cargo test --manifest-path bridge-rs/Cargo.toml --test mcp
   click_withNotReadableAfterClick_shouldNameTheReturnPath -- --exact` ⇒ die Zeile
   `test result: ok. 1 passed` (die Zeile zählt, nicht der Exit-Code).
6. **Alles andere grün.** `npm run check` ⇒ 0, `cargo test` ⇒ `test result: ok`
   mit `0 failed`, `bash scripts/parity.sh --impl rust --check` ⇒ 7/7.
   `3-extension-failures.txt` bleibt unberührt (`# cases=2`).

## Dev plan

Verfasst von einem zweiten Autor (2026-11-23), geprüft gegen den Code.

**Stufe 1 — der neue Code in der Extension (`extension/bridge.js`, `test/extension.test.js`)**

- Konstanten: `NOT_READABLE_AFTER_CLICK_CODE` neben `NOT_READABLE_CODE` (`:113`);
  keinen festen Satz neben `NOT_READABLE_MESSAGE` (`:278`), sondern einen Bauer —
  der Satz trägt die Adresse: `notReadableAfterClickMessage(url)`, nach dem Muster
  von `not_readable_with_url` in `texts.rs` (`:52-54`). Ohne Adresse der kürzere Satz.
- `clickErrorFor` (`:2752-2760`): der `ReadError`-Arm (`:2758`) wird zweistufig —
  `error.code === NOT_READABLE_CODE` ⇒ `{ code: NOT_READABLE_AFTER_CLICK_CODE,
  message: …, ...error.details }`, sonst unverändert `readErrorFrame(error)`.
  `readErrorFrame` (`:1865`) bleibt unangetastet, weil `read` (`readErrorFor`,
  `:2023`) und `type` (`typeErrorFor`, `:3064`) sie mitbenutzen; dort wird nichts
  geändert.
- Kein Eintrag in `CLICK_OUTCOMES` (`:505`): der Code entsteht **nach** dem Klick,
  nicht als Ausgang des Schnipsels.

Tests: die zwei bestehenden Fälle werden umbenannt und ziehen ihre Erwartung nach —
`:7492` → `click_whenThePageCannotBeReadAfterTheClick_shouldAnswerNotReadableAfterClick`
(erwartet den neuen Code, den Satz mit beiden Teilen und `url`), `:7528` →
`click_whenThePageAfterTheClickIsUnreadable_shouldCarryTheAddressAndKind` (neuer Code,
`url`/`kind` bleiben). Ein dritter Klick-Fall entsteht **nicht**; die Satzprüfung
sitzt im ersten (Entscheidung vom 2026-11-23, siehe `## Log`).

Neu ist dagegen der Vorher-Fall:
`click_onATabThatIsUnreadableBeforeTheClick_shouldAnswerNotReadable`. Er zeigt die
Grenze der Umbenennung — ohne Klick bleibt es bei `not_readable`. Dafür trägt
`clickErrorFor` die Auskunft, ob geklickt wurde (z. B. ein zweites Argument
`{ clicked }`), und fällt sonst auf `readErrorFrame` zurück. Der `read`-Fall `:4525`
und der `type`-Fall `:8803` bleiben **ohne** Änderung — sie sind der Beweis, dass der
Code auf den Klick-Pfad beschränkt ist.

Der Fehlerrahmen wird **nicht** ein drittes Mal von Hand gebaut: `readErrorFrame`
trägt die Form (`code, message, url, kind, contentType`), und der neue Code setzt
`code` und `message` darauf (Code-Review 2026-11-23).

Beweis: je Name `grep -cE '^ok [0-9]+ - <name>'` ⇒ 1;
`grep -c 'click_.*shouldPassNotReadableThrough' test/extension.test.js` ⇒ 0;
`npm test; echo $?` ⇒ 0 mit `^# fail 0` und `^# cancelled 0`, darin
`^ok [0-9]+ - read_whenTheTabIsCompleteAndTheInjectionIsRefused_shouldAnswerNotReadable`
und `… - type_whenThePageCannotBeReadAfterTyping_shouldPassNotReadableThrough` je 1.

**Stufe 2 — Bridge und Texte, unabhängig von Stufe 1**

`bridge-rs/src/mcp/failure.rs`: `NOT_READABLE_AFTER_CLICK_CODE` neben
`NOT_READABLE_CODE` (`:28`), dazu im `BROWSER_CLICK`-Zweig (`:125-136`) ein Arm
**vor** `page_failure_text` (`:135`), der `not_readable_after_click_text(details)`
ruft. `page_failure_text` (`:239-250`) und `not_readable_text` (`:270-293`) bleiben
unverändert — sonst bekäme `read` den neuen Satz.
`texts.rs`: `NOT_READABLE_AFTER_CLICK` (kurz, ohne Adresse) und
`not_readable_after_click_with_url(url)`, gebaut wie `NOT_READABLE` /
`not_readable_with_url` (`:38-54`).
`tests/mcp.rs`: `click_withNotReadableAfterClick_shouldNameTheReturnPath` — die
Fake-Extension antwortet `error_frame_with("not_readable_after_click",
json!({"url": …}))`, erwartet wird der gepinnte Satz mit `browser_navigate`.

Beweis: `cargo test --manifest-path bridge-rs/Cargo.toml --test mcp
click_withNotReadableAfterClick_shouldNameTheReturnPath -- --exact` ⇒ `test result:
ok. 1 passed` — die Zeile zählt, nicht der Exit-Code: ein Filter ohne Treffer endet
mit 0 und `0 passed`. Dazu `--test texts` ⇒ `1 passed`.

**Stufe 3 — Anleitung und Doku**

`help.rs`, CLICK-Block `## Pitfalls` (`:98-99`) nennt den neuen Code und den Rückweg
`browser_navigate`; `docs/06`, `docs/15` (die zwei Stellen, die im Klick-Pfad
`not_readable` nennen), `docs/53`, `docs/54` (die Textliste), `docs/README.md`
(Status), `docs/PROJECT-STATE.md`, Abschnitt „Beweise"; der Amendments-Abschnitt entfällt, die Spec
wird `active`.

Beweis: `npm run check; echo $?` ⇒ 0; `grep -n '61-klick' docs/README.md` zeigt
`active`; `help_forEveryTool_shouldAnswerWithTheSixSections` bleibt grün.

**Eingefrorene Artefakte: keiner.** Vergleich 2 hat keinen Klick-Fall mit
`not_readable` (`ERROR_FIXTURE_ARGS` in `scripts/parity.sh:259-273` nennt für `click`
nur `error:no_match`), `tools/list` ändert sich nicht (kein neues Argument), und
`3-extension-failures.txt` bleibt bei `# cases=2`. Eine Fixture-Amendierung mit
Betreiberfreigabe ist nicht nötig.

**Was schiefgehen kann.** Der Satz steht zweimal: als Extension-Meldung und in
`texts.rs`. Beide sind gepinnt, ein Wortlaut-Drift macht genau einen der zwei Fälle
rot — ein gemeinsamer Text ist nicht möglich, weil `extension/bridge.js` nicht aus
Rust importiert werden kann (`docs/54` sagt dasselbe für die anderen Sätze). Zweitens
trägt der Fehlerrahmen die Felder in der Reihenfolge `code, message, url, kind,
contentType`; der Spread muss **hinter** `message` stehen, sonst überschreibt
`details` den Code nicht, sondern nur die Meldung.

**Reihenfolge.** Stufe 2 ist von Stufe 1 unabhängig (Fake-Antwort), Stufe 3 setzt
beide voraus. Innerhalb von Stufe 1: Konstanten → `clickErrorFor` → Fälle. `docs/56`
fasst dieselbe Datei an (`clickOutcomeOf`, `CLICK_OUTCOMES`, `clickErrorFor`) — die
beiden Specs laufen nacheinander im selben Baum, nie parallel.

**Was der nächste Inkrement erbt.** `docs/56` (Lage und `scrolled`) teilt sich
`clickErrorFor`; ein Klick, der eine Datei herunterlädt, landet weiterhin hier
(`## Bekannte Lücken`) und braucht eine eigene Spec, wenn er eigene Behandlung
bekommen soll. `page_busy` und `no_agent_tab` bleiben im Klick-Pfad, wie sie sind.
## Touch boundary

| erlaubt | nicht |
|---|---|
| `extension/bridge.js` (`clickErrorFor`, Konstanten) | `extension/page-agent.js` — die Lage ist `docs/56` |
| `test/extension.test.js` (die zwei umbenannten Fälle, die zwei neuen Fälle und der bestehende `read`-Fall) | `extension/bridge.js` außerhalb des Klick-Pfads |
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
- **Lief der Klick, ging aber seine Antwort verloren**, bleibt es bei `not_readable`
  — die Extension weiß dann nicht, ob geklickt wurde, und behauptet es auch nicht.
  Das ist die eine verbleibende Stelle, an der ein Agent den Klick wiederholt
  (Code-Review 2026-11-23).
- **Zwei Kommentare in `extension/bridge.js` sind noch nicht nachgezogen:** der Satz
  „passes through untouched" über `answerClick` widerruft sich zwei Zeilen später
  selbst, und `clicked = { done: false }` als Default-Parameter würde bei einem
  zweiten Aufrufer lautlos `not_readable` liefern. Ein Pflichtparameter wäre besser
  (Code-Review 2026-11-23).

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

- **2026-11-23, Entscheidungen vor dem Bau und während des Baus (Orchestrator).**
  Die Satzprüfung sitzt im umbenannten `:7492`-Fall; ein zusätzlicher Fall für
  denselben Code wäre doppeltes Gewicht. Neu sind zwei andere Fälle: der Vorher-Fall
  `click_onATabThatIsUnreadableBeforeTheClick_shouldAnswerNotReadable` (der Code-Review
  zeigte, dass die Umbenennung sonst auch einen Klick umbenennt, der nie stattfand)
  und `click_whenTheClickedPageHasNoAddress_shouldAnswerTheShortSentence` (die kurze
  Satzform war nirgends gepinnt). Beide verschieben die Fallzahl; `docs/PROJECT-STATE.md`
  wird in Stufe 3 nachgezogen.
