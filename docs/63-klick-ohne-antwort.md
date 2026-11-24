---
description: Ein Klick, dessen Anfrage keine Antwort bekommt, soll den eigenen Code click_outcome_unknown tragen statt not_readable — die Antwort sagt dann, dass der Klick durchgegangen sein kann, und der Agent prüft die Seite, bevor er erneut klickt.
status: proposed
---

# Ein Klick ohne Antwort sagt das

## Anlass

Zwei Stellen im heutigen Code lassen den Agenten den Klick wiederholen, obwohl er
schon gelaufen sein kann.

**Stelle 1 — die Anfrage bekommt keine Antwort.** `clickAgentTab` schickt den
Klick-Schnipsel und wartet. Bleibt die Antwort aus (Zeitüberschreitung, Kanal
gestört, Erweiterung neu gestartet), wirft der Aufruf einen Fehler ohne Auskunft
über den Klick. `clickErrorFor` fällt dann auf `readErrorFrame` zurück oder auf
`click_failed`. Der Agent liest „die Seite ist nicht lesbar" und klickt erneut.

**Stelle 2 — der Vorher-Fall ist benachbart.** Ist der Tab schon vor dem Klick
unlesbar (`about:config`, PDF, `view-source:`), bleibt es seit `docs/61` bei
`not_readable`. Dort ist die Aussage richtig: Es wurde nicht geklickt.

Die zwei Fälle sehen für den Agenten gleich aus, obwohl sie es nicht sind. Ein
zweiter Klick auf einen Kauf- oder Senden-Knopf ist teurer als eine ungenaue
Antwort — das ist der Grund, den `docs/ROADMAP.md` schon einmal festgehalten hat
(magicline, 2026-10-23).

## Ziel

1. Eine Klick-Anfrage **ohne Antwort** antwortet mit dem neuen Code
   **`click_outcome_unknown`**.
2. Der englische Satz lautet, gepinnt in `extension/bridge.js` und in
   `bridge-rs/src/mcp/texts.rs`:

   ```
   The click was sent, but the page gave no answer: it may have gone through.
   Check the page before you click again.
   ```

3. Der Fehler trägt `url` (die Adresse, unter der geklickt wurde) und **kein**
   `clicked` — die Beschreibung des Elements lag in der Antwort, die verloren ging.
4. `not_readable` bleibt für den Vorher-Fall (`docs/61`), `read_failed` bleibt für
   eine unbrauchbare Antwort. Der neue Code ersetzt keinen der beiden.
5. **Kein Wiederholen im Werkzeug.** Die Extension versucht den Klick nicht erneut;
   sie sagt, was sie weiß, und lässt die Entscheidung beim Agenten.

## Der Vertrag

| Feld | Regel |
|---|---|
| Code | `click_outcome_unknown`, `isError: true` |
| Satz | der Wortlaut aus Ziel 2, englisch, gepinnte Konstante |
| Belegfelder | `url`; **kein** `clicked` |
| Abgrenzung | `not_readable` = nicht geklickt (Vorher-Fall), `not_readable_after_click` = geklickt, Seite danach unlesbar (`docs/61`), `read_failed` = Antwort unbrauchbar |
| `CLICK_OUTCOMES` | **kein** Eintrag: der Code entsteht nach dem Klick, nicht als Ausgang des Schnipsels |

**Woher die Extension weiß, dass sie nichts weiß.** `clickAgentTab` kennt den
Fehler der Klick-Anfrage: Eine Zeitüberschreitung oder ein Kanalabbruch ist etwas
anderes als ein `not_readable` der Seite. Der neue Code gilt genau für die erste
Klasse. Ein Fall im Harness hält die Grenze fest: derselbe Tab, einmal mit
abgelehnter Injektion (bleibt `not_readable`), einmal mit einer Anfrage, die nie
antwortet (`click_outcome_unknown`).

## Non-goals

- **Kein Seiten-Marker.** Ein `globalThis`-Zähler im Schnipsel könnte später sagen,
  ob `element.click()` wirklich lief. Das wäre ein zweiter Weg in die Seite und ein
  eigener Anlass; diese Spec begnügt sich mit „kann durchgegangen sein".
- **Kein automatisches Wiederholen** und kein Rückzug des Klicks.
- **Keine Änderung an `read`, `type`, `inspect`.** Sie behalten ihre Codes.
- **Keine Änderung an `docs/61`.** Der Vorher-Fall bleibt, wie er ist.

## Amendments to previous spec docs

- **`docs/61-klick-seite-danach.md`**: die Abgrenzung kommt in die Vertragstabelle —
  `not_readable` gilt nur, wenn die Injektion abgelehnt wurde, nicht wenn die
  Anfrage ausblieb.
- **`docs/54-refusals-englisch.md`**: der neue Satz in der Textliste.

Nach der Umsetzung wird dieser Abschnitt entfernt.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `click_whenTheClickRequestNeverAnswers_shouldAnswerClickOutcomeUnknown` | der neue Code samt Satz und `url`; kein `clicked` |
| `test/extension.test.js` | `click_whenTheInjectionIsRefusedBeforeTheClick_shouldStillAnswerNotReadable` (bestehend) | die Grenze: abgelehnte Injektion bleibt `not_readable` |
| `test/extension.test.js` | `click_whenThePageAfterTheClickIsUnreadable_shouldAnswerNotReadableAfterClick` (bestehend) | `docs/61` bleibt unberührt |
| `bridge-rs/tests/mcp.rs` | `click_withClickOutcomeUnknown_shouldNameTheUncertainty` | die Bridge bildet den Code auf den englischen Satz ab |
| `bridge-rs/tests/texts.rs` | `texts_shouldContainNoGermanUmlauts` | der Wächter aus `docs/54` deckt den neuen Satz |

## Acceptance criteria

1. **Die Anfrage ohne Antwort.** Der Fall
   `click_whenTheClickRequestNeverAnswers_shouldAnswerClickOutcomeUnknown` ⇒
   `click_outcome_unknown`, Satz mit „may have gone through", `url` gesetzt, kein
   `clicked`. Beleg: `npm test` ⇒ 0, `^# fail 0`, `^# cancelled 0`.
2. **Die Grenze hält.** Die zwei bestehenden Fälle antworten weiter mit
   `not_readable` bzw. `not_readable_after_click`. Beleg: je Name
   `grep -cE '^ok [0-9]+ - <name>'` ⇒ 1.
3. **Die Bridge kennt den Code.**
   `cargo test --manifest-path bridge-rs/Cargo.toml --test mcp
   click_withClickOutcomeUnknown_shouldNameTheUncertainty -- --exact` ⇒ die Zeile
   `test result: ok. 1 passed` (die Zeile zählt, nicht der Exit-Code).
4. **`CLICK_OUTCOMES` bleibt unverändert.** `grep -c 'click_outcome_unknown'
   extension/bridge.js` ⇒ 2 (Konstante und Bauer), keine Zeile in der Liste.
5. **Alles andere grün.** `npm run check` ⇒ 0, `cargo test` ⇒ `test result: ok` mit
   `0 failed`, `bash scripts/parity.sh --impl rust --check` ⇒ 7/7.
6. **Live, Betreiber.** Auf einer Seite mit einem Formular: den Kanal stören
   (Erweiterung neu laden, während die Anfrage läuft) und `browser_click` aufrufen.
   Die Antwort nennt `click_outcome_unknown`, nicht `not_readable`.

## Dev plan

Entwurf des Spec-Autors. Nach `CONTRIBUTING.md`, Schritt 3, gehört der Dev-Plan zu
einem zweiten Autor.

**Stufe 1 — der Code in der Extension (`extension/bridge.js`)**

Konstante `CLICK_OUTCOME_UNKNOWN_CODE`, Bauer `clickOutcomeUnknownMessage(url)`,
und im Klick-Pfad die Unterscheidung: Ein Fehler der Klick-Anfrage, der **keine
Antwort** ist (Zeitüberschreitung, Kanalabbruch), ergibt den neuen Code; ein
`ReadError` der Seite ergibt weiter `not_readable`.

Beweis: Kriterien 1, 2.

**Stufe 2 — Bridge und Texte**

`bridge-rs/src/mcp/failure.rs` (Konstante und Arm im `BROWSER_CLICK`-Zweig, vor
`page_failure_text`), `texts.rs` (der Satz), `bridge-rs/tests/mcp.rs`,
`bridge-rs/tests/texts.rs`.

Beweis: Kriterien 3, 4, 5.

**Stufe 3 — Anleitung und Doku**

`bridge-rs/src/mcp/help.rs` (`## Pitfalls` der CLICK-Anleitung nennt den Code und
den Rat), `docs/06`, `docs/54`, `docs/61` (Vertragstabelle), `docs/README.md`,
`docs/PROJECT-STATE.md`; der Amendments-Abschnitt entfällt, die Spec wird `active`.

Beweis: `npm run check` ⇒ 0, `grep -n '63-klick' docs/README.md` zeigt `active`.

## Touch boundary

| erlaubt | nicht |
|---|---|
| `extension/bridge.js` (Klick-Pfad, Konstanten) | `extension/page-agent.js` — kein Seiten-Marker |
| `test/extension.test.js` (der neue Fall und die zwei Grenzfälle) | `docs/56`, `docs/60` — sie bleiben, wie sie sind |
| `bridge-rs/src/mcp/failure.rs`, `texts.rs`, `help.rs`, `bridge-rs/tests/mcp.rs`, `texts.rs` | `bridge-rs/src/hub.rs`, `protocol.rs`, `scripts/parity/**` |
| `docs/06`, `docs/54`, `docs/61`, `docs/README.md`, `docs/PROJECT-STATE.md` | `docs/09`, `docs/57`, `docs/58`, `docs/62` |

## Bekannte Lücken

- **Die Antwort bleibt eine Vermutung.** Ohne Seiten-Marker kann die Extension nicht
  sagen, ob `element.click()` lief; sie sagt „kann durchgegangen sein". Das ist die
  ehrliche Form, aber sie kostet den Agenten einen Prüfschritt (2026-11-23).
- **Der Satz nennt keinen nächsten Werkzeugaufruf.** „Check the page" ist Absicht:
  `browser_read` ist der übliche Weg, aber nicht der einzige (2026-11-23).
- **Ein Kanalabbruch mitten in der Antwort** ist von einer Zeitüberschreitung nicht
  zu unterscheiden. Beide bekommen denselben Code (2026-11-23).

## Open questions

1. **Soll der Seiten-Marker doch kommen?** Ein Zähler in `globalThis`, den der
   Schnipsel vor `element.click()` setzt, würde aus „kann" ein „ist" machen. Preis:
   ein zweiter Weg in die Seite und eine neue Op. Der Betreiber entscheidet.
2. **Soll der Satz `browser_read` ausdrücklich nennen** statt „check the page"? Der
   Rat wäre konkreter, aber er setzt voraus, dass die Seite lesbar ist — und das
   weiß die Extension gerade nicht.

## Review

### Runde 1 — steht aus

Nach `CONTRIBUTING.md`, Schritt 4, öffnet erst ein `✅ Ship it` die Umsetzung.

## Log

- **2026-11-23, angelegt.** Aus dem Befund des Code-Reviews zu `docs/61`: „Lief der
  Klick, ging aber seine Antwort verloren, bleibt es bei `not_readable` — das ist
  die eine verbleibende Stelle, an der ein Agent den Klick wiederholt." Der
  Betreiber hat den eigenen Code dafür gewählt.
