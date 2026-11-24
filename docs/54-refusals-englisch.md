---
description: Alle Meldungen, die der Agent liest, sind englisch — Refusals der Bridge, Fehlertexte der Extension und die Werkzeugbeschreibungen.
status: active
---

# Refusals auf Englisch

Betreiberentscheidung 2026-11-22: **alles, was der Agent liest, ist englisch.** Die
`browser_help`-Anleitungen sind es seit `c15f8b9`. Die Werkzeugbeschreibungen
und die Meldungen sind seit diesem Schritt englisch.

## Umfang (Messung 2026-11-22, nach dem Bau korrigiert)

| Ort | Umfang | Befehl / Anmerkung |
|---|---|---|
| `bridge-rs/src/mcp/texts.rs` | 51 Texte | `git show HEAD:bridge-rs/src/mcp/texts.rs \| grep -cE '^pub (const\|fn)'` — die drei `help_*`-Sätze eingeschlossen |
| `bridge-rs/src/mcp/tools.rs` | 13 + 14 | die Argument-Refusals in `unexpected_arguments` und die 14 Beschreibungen (`grep -cE '^const BROWSER_.*_DESCRIPTION'` ⇒ 14) — **beide fehlten in der ersten Messung** |
| `bridge-rs/src/mcp/failure.rs` | 1 | die eine Unit-Assertion (`BRIDGE_FAILED`) |
| `extension/bridge.js` | 43 `const`-Zeilen + die Sätze in Funktionen | `git diff -U0 HEAD~1 -- extension/bridge.js \| grep '^-' \| grep 'const ' \| wc -l` ⇒ 43; der ganze Diff umfasst 77 geänderte Zeilen |
| `bridge-rs/tests/mcp.rs` | 40+ gepinnte Sätze | 41 Umlaut-Zeilen vor dem Diff (darunter Beschreibungen); die Zahlen sind eine Schätzung, die Pins selbst sind vollständig umgestellt |
| `bridge-rs/tests/hub.rs` | 0 agentengelesene Meldungen | die eine Umlaut-Zeile dort ist ein Kommentar (`hub.rs:615`); `hub.rs:2506` trägt einen deutschen Beispiel-Satz in einem Test-Double, geprüft wird nur der Code |
| `test/extension.test.js` | 30 Zeilen | `git diff -U0 HEAD~1 -- test/extension.test.js \| grep '^-' \| grep -vc '^--- a/'` ⇒ 30; die erste Messung übersah die Sätze ohne Umlaut und die `.includes`-Prüfungen |
| `scripts/parity/expected/1-initialize-and-tools-list.txt` | 1 Zeile | `tools/list` trägt die Beschreibungen |
| `scripts/parity/expected/2-tools.txt` | 39 Fälle | Antworttexte, eingefroren |
| `scripts/parity/expected/3-extension-failures.txt` | 2 Fälle | dito |

**Die erste Messung war zu klein.** Der `grep` zählte Umlaute, keine Sätze: die
Argument-Refusals in `tools.rs`, die Werkzeugbeschreibungen und die Meldungen ohne
Umlaut in `bridge.js` und `test/extension.test.js` fielen durch. Die Spec sagte
außerdem, die Werkzeugbeschreibungen seien „seit `c15f8b9`" englisch — sie waren es
nicht; `docs/53` hatte es beschlossen, gebaut wurden nur die `browser_help`-Anleitungen.

## Ziel

- **Jede Meldung, die als Werkzeugantwort beim Agenten ankommt, ist englisch** —
  die Refusals der Bridge, die Meldungen der Extension und die Werkzeugbeschreibungen,
  die der Agent vor dem ersten Aufruf liest. Fehlercodes bleiben, wie sie sind
  (`eval_not_allowed`, `page_not_readable`, …) — sie sind die Sprache der Leitung,
  nicht des Lesers.
- **Deutsch bleibt:** die Logzeilen der Bridge und der Extension, die Kommentare
  im Code und die Dokumentation. Die Optionsseite ist englisch (Betreibertext) und bleibt
  unberührt.
- **Kein Verhalten ändert sich.** Dieselben Codes, dieselben Fälle, nur der Satz.

## Der Ton der neuen Texte

Kurz, aktiv, ohne Höflichkeitsfloskeln — und jeder Satz nennt den nächsten Schritt,
wenn es einen gibt:

| heute | neu |
|---|---|
| „browser_read erwartet nur `offset`, `maxChars`, `mode`, `frame` und `tab`." | "browser_read takes only `offset`, `maxChars`, `mode`, `frame` and `tab`." |
| „Der Code im Agenten-Tab ist gescheitert: …" | "The code in the agent tab failed: …" |
| „Diese Seite kann die Extension nicht lesen (interne Seite oder Sonderformat)." | "The extension cannot read this page (internal page or special format)." |
| „Die Seite verbietet eigenes Skript (CSP) — Werte lassen sich mit `read` oder `inspect` holen." | "The page forbids its own script (CSP) — read the values with `read` or `inspect` instead." |

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `bridge-rs/tests/texts.rs` (**neu**) | `texts_shouldContainNoGermanUmlauts` | kein `ä ö ü ß Ä Ö Ü` in den Antworttexten von `texts.rs`, `tools.rs` und `help.rs` — Kommentarzeilen ausgenommen, also ein maschineller Wächter statt Dutzender Einzelprüfungen |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsListIsByteIdentical` und die gepinnten Satz-Konstanten (u. a. `mcp_toolsCall_withAnUnknownToolName_shouldReturnAnUnknownToolToolError`, `mcp_toolsCallBrowserRead_whenTwoFramesMatch_shouldReturnASentenceNamingTheCandidates`) | die englischen Beschreibungen und Sätze, byteweise gegen die Fixture |
| `test/extension.test.js` | `focus_withAnUnexpectedParameter_shouldAnswerInvalidParamsAndUpdateNothing` | eine Meldung der Extension ist englisch und umlautfrei |
| `test/extension.test.js` | `transcript_captionRow_noCandidate_shouldAnswerAnEmptyListAsNone` | die leere Kandidatenliste heißt `none`, nicht `keine` — der eine deutsche Satzteil, der die Umlaut-Prüfung passieren konnte |

**Der Umlaut-Wächter ist der eigentliche Beweis:** er fängt jede vergessene Zeile
**mit Umlaut**, auch die, die niemand pinnt. Einen deutschen Satz ohne Umlaut fängt
er nicht — dafür sind die gepinnten Assertions da.

## Acceptance criteria

1. **Keine Umlaute in Antworttexten.**
   `grep -cE '[äöüßÄÖÜ]' bridge-rs/src/mcp/texts.rs bridge-rs/src/mcp/tools.rs` ⇒ **0**;
   `cargo test --manifest-path bridge-rs/Cargo.toml --test texts` ⇒ grün (er prüft
   `texts.rs`, `tools.rs` und `help.rs`). In
   `extension/bridge.js` bleiben genau sechs Zeilen mit Umlaut — zwei Kommentare
   (`:173`, `:1831`) und die vier Logzeilen `bc: …` (`:380`, `:480`, `:537`, `:543`):
   `grep -cE '[äöüßÄÖÜ]' extension/bridge.js` ⇒ **6**.
2. **Die Werkzeugliste ist englisch und bleibt vollständig.**
   `grep -o '"name":"[a-z_]*"' scripts/parity/expected/1-initialize-and-tools-list.txt | sort -u | wc -l` ⇒ **14**;
   die Zeile misst **8 062** Zeichen
   (`awk 'NR==5' scripts/parity/expected/1-initialize-and-tools-list.txt | wc -m`),
   also unter der Grenze von 8 500 aus `docs/53`.
3. **Parity 7/7** nach der Fixture-Amendierung:
   `bash scripts/parity.sh --impl rust --check` ⇒ 7/7, `--self-test` ⇒ 7/7. Die
   Freigabe für alle drei Fixtures steht in `docs/PROJECT-STATE.md`,
   `### Freigaben 2026-11-22`.
4. **Alles andere grün.**
   `cargo test --manifest-path bridge-rs/Cargo.toml -- --test-threads=1` ⇒ 292 Fälle
   (122 davon in `mcp.rs`); `cargo clippy --manifest-path bridge-rs/Cargo.toml
   --all-targets --target x86_64-unknown-linux-musl -- -D warnings` und dasselbe mit
   `--target x86_64-pc-windows-gnu` ⇒ 0; `npm test` ⇒ 548 Fälle; `npm run check` ⇒ 0.
   **Nachgezogen am 2026-11-23** nach `docs/59`: dieselben zwei Sätze nennen jetzt
   `typed_text` und `contains_text`. Dazu kommt der Satz, den `browser_inspect`
   ohne jeden Filter antwortet; er nennt beide Namen. Der Wortlaut bleibt englisch,
   umlautfrei und gepinnt.
   **Nachgezogen nach `docs/56`:** ein neuer Ablehnungsgrund im Klick-Pfad,
   `The element stays outside the viewport after scrolling: <selector>.` Er steht
   in `texts.rs` und ist ebenso englisch und umlautfrei; der Umlaut-Wächter deckt
   ihn ohne eigenen Fall.
   **Nachgezogen nach `docs/61`:** ein zweiter Satz im Klick-Pfad, „The click went
   through, but the page it opened cannot be read: <url>. Go back with
   browser_navigate." Er steht zweimal, in `extension/bridge.js` und in `texts.rs`,
   und ist an beiden Stellen gepinnt.
   **Nachgezogen nach `docs/57`:** kein neuer Satz — die Anleitung von
   `browser_inspect` in `help.rs` nennt die Engste-Regel und ihre drei Ausnahmen.
   **Nachgezogen nach `docs/58`:** drei Sätze im Klick-Pfad — „weder noch" bzw.
   leerer Begriff, `text_ambiguous` (mit „at least" am Deckel), und die Begriff-Form
   von `no_match` samt Deckel-Zeile. Sie stehen in `extension/bridge.js`; der
   Umlaut-Wächter deckt sie nicht (er prüft `texts.rs`, `tools.rs`, `help.rs`), die
   Node-Fälle pinnen sie.
   **Nachgezogen nach `docs/63`:** ein Satz im Klick-Pfad, „The page gave no answer to the
   click request: it may have gone through. Check the page before you click again." Er
   steht zweimal, in `extension/bridge.js` und in `texts.rs`, einzeilig und wortgleich.
   Der Umlaut-Wächter deckt die Rust-Seite; die Node-Fälle pinnen die Extension-Seite.
   Textzahl in `texts.rs` nach diesem Inkrement: 58
   (`grep -cE '^pub (const|fn)' bridge-rs/src/mcp/texts.rs`, Stand 2026-11-23).
   **Nachgezogen nach `docs/60`:** dieselben drei Fälle noch einmal auf der
   MCP-Seite — `CLICK_NEEDS_FILTER`, `click_ambiguous(term, matches, candidates,
   truncated)` mit „at least" am Deckel, und die Begriff-Form von `no_match`. Sie
   stehen in `texts.rs`, sind umlautfrei und gepinnt; der Wächter deckt sie.

## Dev plan

**Stufe 1 — die Bridge und die Fixtures**

Dateien: `bridge-rs/src/mcp/texts.rs`, `bridge-rs/src/mcp/tools.rs` (die 13
Argument-Refusals **und** die 14 Beschreibungen), `bridge-rs/src/mcp/mod.rs`
(nur Kommentare), `bridge-rs/src/mcp/failure.rs`, `bridge-rs/tests/mcp.rs`,
`bridge-rs/tests/texts.rs` (neu), dazu `scripts/parity/expected/1-…`,
`2-tools.txt` und `3-extension-failures.txt`.

Die drei Fixtures tragen ausschließlich Bridge-Texte; `tests/mcp.rs` vergleicht
`tools/list` byteweise gegen Fixture 1. Ohne sie ist diese Stufe nicht grün, und
keine Stufe darf von einer späteren abhängen.

Beweis: Kriterium 2 und 3 sowie der Rust-Teil von Kriterium 4; Kriterium 1 für
`texts.rs`, `tools.rs` und `help.rs`. Die sechs Umlaut-Zeilen in `extension/bridge.js` und die
547 Node-Fälle entstehen erst in Stufe 2. **Abgeschlossen 2026-11-22**

**Stufe 2 — die Extension**

Dateien: `extension/bridge.js`, `test/extension.test.js`.

Beweis: Kriterium 1 (die sechs erlaubten Umlaut-Zeilen), `npm test`. **Abgeschlossen 2026-11-22**

**Stufe 3 — die aktive Spec und die Projektregel nachziehen**

Dateien: `docs/53-browser-help.md`, `docs/05-seiteninhalt-lesen.md` (Kriterium 4),
`docs/45-injection-naht.md` (Kriterium 7), `docs/03-mcp-browser-status.md`
(`## MCP` und Kriterium 4), `docs/38-rust-port.md`, `CONTRIBUTING.md`
(`## Language`), `docs/PROJECT-STATE.md`, `docs/README.md`.

`docs/53` ist `active` und sagte an fünf Stellen das Gegenteil des gebauten
Zustands (Vertragstabelle, „Kein Draht-Code", `## Sprache`, Kriterium 3/Log,
`browser_read`-Zitat). `docs/03` und `docs/05` zitieren die gebauten Sätze in
ihren Vertragsblöcken, `docs/45` in Kriterium 7.
`CONTRIBUTING.md`, `## Language` nannte Werkzeugfehler deutsch. Beides wird in
**dieser** Stufe nachgezogen, weil sie das Verhalten umsetzt (`docs/README.md`,
`## Änderungen an bestehenden Specs`).

Beweis: `grep -n "deutsch\|deutscher" docs/53-browser-help.md` ⇒ nur noch `:79`
(die Logzeilen-Zeile); `grep -n "tool errors" CONTRIBUTING.md` ⇒ kein Treffer. Der
Amendments-Abschnitt dieser Spec ist nach der Umsetzung entfernt
(`docs/README.md`, `## Änderungen an bestehenden Specs`). Die letzte Stufe stellt
die Spec auf `active`; das geschieht mit dem Ship dieser Runde
(`CONTRIBUTING.md` Schritt 7). **Abgeschlossen 2026-11-22**

## Touch boundary

| erlaubt | nicht |
|---|---|
| `bridge-rs/src/mcp/{texts,tools,mod,failure}.rs`, `bridge-rs/tests/{mcp,texts}.rs` | `extension/page-agent.js` — dort steht kein Agententext |
| `extension/bridge.js`, `test/extension.test.js` | die Logzeilen der Bridge (deutsch, der Betreiber liest sie) |
| `scripts/parity/expected/1-initialize-and-tools-list.txt`, `2-tools.txt`, `3-extension-failures.txt` | Produktivlogik — nur Sätze, kein Verhalten |
| `docs/53-browser-help.md`, `docs/38-rust-port.md`, `docs/05`, `docs/45`, `docs/03` (je nur die Sprachstelle, `docs/03` und `docs/05` einschließlich der zitierten Vertragsblöcke), `docs/README.md`, `CONTRIBUTING.md` (`## Language`), `docs/PROJECT-STATE.md` — die Nachträge aus Stufe 3 | alle übrigen Zitate: eigene Spec `docs/55-alte-zitate-in-specs.md` |

## Bekannte Lücken

- **Die Optionsseite bleibt englisch** — sie war es schon, sie ist Betreibertext.
- **Logzeilen bleiben deutsch.** Wer sie englisch will, sagt es; sie sind nicht
  Teil dieses Schritts.
- **Der Umlaut-Wächter prüft nur Umlaute.** Ein deutscher Satz ohne Umlaute
  („Der Code ist gescheitert.") rutscht durch — dagegen helfen nur die gepinnten
  Assertions. Er deckt `texts.rs`, `tools.rs` und `help.rs` ab, nicht `extension/bridge.js`:
  dort stehen die deutschen Logzeilen zwischen den Meldungen, und ein Filter über
  Zeilenanfänge kann sie nicht trennen.
- **Die Meldung des Browsers bleibt in ihrer Sprache.** Die `*_WITH_MESSAGE`-Funktionen
  hängen `details.message` an, und das ist bei `describeError` die **lokalisierte**
  Meldung von Firefox. Mit deutschem Firefox endet eine Werkzeugantwort weiterhin
  deutsch („The code in the agent tab failed: Fehler: …"). Das ist mit einer
  Umlaut-Prüfung nicht zu fassen und ist bewusst nicht Teil dieses Schritts.
- **Eine Verzweigung ist ungepinnt.** `transcriptMenuCandidatesOf` antwortet auch
  dann `none`, wenn `candidates` fehlt oder kein Array ist
  (`extension/bridge.js:5187`). Der neue Fall deckt nur die leere Liste
  (`:5189`); ein Rückfall auf `keine` an der ersten Stelle bliebe grün.

## Open questions

**Keine.** Die drei Fragen aus Review-Runde 1 sind entschieden: `docs/53` und
`CONTRIBUTING.md` werden in Stufe 3 nachgezogen, und die Freigabe für die Fixtures
steht in `docs/PROJECT-STATE.md`, `### Freigaben 2026-11-22`. Die Zitatfrage aus
Runde 3 hat der Betreiber entschieden: eigene Spec `docs/55`.

## Review

### Abschluss — 2026-11-22

Der Betreiber hat die Spec nach Runde 5 auf `active` gestellt. Der Prozessbefund
(„Bau vor Gate") bleibt als Befund stehen.

### Runde 1 — 2026-11-22 — `🔧 Fix these and I'll sign off` (mit Blockern)

- **M1 [Blocker]:** `docs/53` ist `active` und sagte an vier Stellen das Gegenteil
  (Vertragstabelle, „Kein Draht-Code", `## Sprache` samt `OFFENE FRAGE`,
  Kriterium 3/Log). Die Spec nannte sie nirgends und verbot sich selbst den Zugriff.
- **M2 [Blocker]:** Stufe 1 enthielt `tests/mcp.rs`, das byteweise gegen Fixture 1
  prüft; die Fixture stand erst in Stufe 3. Die Stufe war so nicht grün zu bekommen.
- **M3 [Blocker, Code]:** `extension/bridge.js:5187/5189` gaben `"keine"` zurück;
  das landete in englischen Sätzen (`(entries: keine)`). Keine Assertion fing es.
- **M4 [Blocker]:** `CONTRIBUTING.md`, `## Language` sagt weiter „tool errors …
  stays German".
- **m1–m18 [Minor]:** Manifest-Pfad im Testkommando fehlte; die Grep-Klasse war
  schwächer als der Wächter; Kriterium 1 widersprach dem Kommentar-Ausschluss;
  Kriterium 2 und 4 hatten kein Kommando; die Umfang-Tabelle mischte Einheiten;
  die `hub.rs`-Zeile war irreführend; ein Ton-Beispiel war nicht der gebaute Satz;
  die Touch boundary deckte `mod.rs` und `PROJECT-STATE.md` nicht; zwei
  Testing-Zeilen nannten keinen Fall; die Frontmatter-`description` versprach
  „Zuordnung der Fehlercodes"; die zitierte Freigabe deckte nur Fixture 1;
  „Kein Code geändert" war falsch; die lokalisierte Browser-Meldung fehlte als
  Lücke; der neue Node-Fall war ein Klon und zerschnitt einen Kommentar;
  „thirteen" stand noch in drei Kommentaren; der Wächter-Satz war überzeichnet;
  der alte Log-Eintrag „Node-Tests pinnen keine deutschen Meldungen" war falsch.
- **Prozess:** die Implementierung lief vor diesem Gate (`CONTRIBUTING.md`
  Schritt 4→5). Das wird hier festgehalten, nicht repariert.

### Runde 2 — 2026-11-22 — `🔧 Fix these and I'll sign off` (mit Blockern)

- **M1 [Blocker]:** die Log-Überschrift fehlte und der Verweis darauf brach mitten
  im Satz ab (ein Ersetzungslauf hatte `## Log` im Fließtext getroffen). Repariert.
- **M2 [Blocker]:** der Beweis von Stufe 1 nannte weiter Kriterium 1 mit den sechs
  `bridge.js`-Zeilen und die 547 Node-Fälle — beides entsteht erst in Stufe 2.
  Stufe 1 nennt jetzt nur Kriterium 2, den Rust-Teil von 4 und den
  `texts.rs`/`tools.rs`-Teil von 1.
- **M3 [Blocker]:** `docs/53` zitierte den `browser_read`-Text auf Deutsch, zwei
  Absätze unter „alles ist englisch" — die fünfte Stelle. Das Zitat ist jetzt der
  gebaute englische Satz.
- **m1:** `docs/53` nennt für „antwortet ohne Extension" den Fall
  `help_forEveryTool_shouldAnswerWithTheSixSections` (der zitierte Name existierte
  nicht).
- **m2:** die Optionsseite stand gleichzeitig unter „Deutsch bleibt" und
  „bleibt englisch" — jetzt nur noch als englischer Betreibertext.
- **m3:** die ungepinnte `!Array.isArray(candidates)`-Verzweigung steht als Lücke
  unter `## Bekannte Lücken`.
- **m4:** das Beispiel der lokalisierten Browser-Meldung war ein Satz, den der
  Catch-all nicht bauen kann — jetzt `The code in the agent tab failed: Fehler: …`.
- **m5:** `bridge-rs/src/mcp/help.rs` steht jetzt im `SOURCES`-Array des Wächters.
- **m6:** der Amendments-Abschnitt ist entfernt; die Nachträge stehen im Log.
- **m7:** `docs/38-rust-port.md` trägt einen datierten Nachtrag.
- **m8:** die Zahl der gepinnten Assertions ist aus der Spec und aus
  `PROJECT-STATE.md` entfernt; sie war an beiden Stellen verschieden und an keiner
  belegt.
- **m9:** der Kommentar über der `type`-Assertion sagt „the sentence", nicht mehr
  „the German sentence".
- **m10:** `docs/PROJECT-STATE.md:397` trägt den Überholt-Vermerk.

### Runde 3 — 2026-11-22 — `🔧 Fix these and I'll sign off` (mit Blockern)

- **M1 [Blocker]:** die Touch boundary und die Dateiliste von Stufe 3 nannten
  `docs/38-rust-port.md` nicht, obwohl der Nachtrag dort steht. Nachgetragen.
- **M2 [Blocker, geteilt]:** 27 aktive Specs zitieren die alten deutschen Sätze
  wörtlich (die belegte Trefferliste steht in `docs/55`; die frühere Zahl „29
  Dateien, 95 Zeilen" war eine Schätzung ohne Kommando). Die drei operativen Stellen (`docs/05`, Kriterium 4;
  `docs/45`, Kriterium 7; `docs/03`, „der Werkzeug-Text bleibt deutsch") sind in
  Stufe 3 nachgezogen. **Die übrigen Zitate hat der Betreiber nach der dritten
  Blockade in `docs/55-alte-zitate-in-specs.md` ausgegliedert** — die Regel aus
  `CONTRIBUTING.md` Schritt 4 („teilen, nicht durchwinken").
- **m1–m14 [Minor]:** alle übernommen — siehe `## Log`.
- **Rechtschreibung:** „Betreiberentscheid" → „Betreiberentscheidung".

### Runde 4 — 2026-11-22 — `🔧 Fix these and I'll sign off` (mit Blockern)

- **M1 [Blocker]:** `docs/38-rust-port.md` war geändert, stand aber nicht in der
  Dateiliste von Stufe 3 und nicht in der Touch boundary. Nachgetragen.
- **M2 [Blocker]:** der Betreiber hat die Zitatfrage geteilt (`CONTRIBUTING.md`
  Schritt 4). Die drei operativen Stellen zieht diese Spec nach, alles Weitere
  `docs/55-alte-zitate-in-specs.md`.
- **m1–m14:** übernommen — Zähl-Kommandos, `hub.rs`-Zeile, Wächter/Texte,
  `docs/53`-Zahlen und -Fallname, Help-Sätze, Beweis von Stufe 1, „Bridge und
  Extension", CONTRIBUTING-Ausnahme, `active`-Schritt, `operator's browser`,
  Modulkommentar, `docs/53`-Review-Hinweis.

### Runde 5 — 2026-11-22 — `🔧 Fix these and I'll sign off` (mit Blockern)

- **M1 [Blocker]:** Stufe 3 galt als abgeschlossen, obwohl die zitierten
  `description`-Zellen in `docs/03` und `docs/05` weiter deutsch waren. Beide
  Zellen tragen jetzt die gebaute englische Beschreibung.
- **M2 [Blocker]:** Review und Log endeten bei Runde 3. Runde 4 und 5 stehen jetzt
  hier, samt Log-Zeilen; der „Bauer"-Rest ist korrigiert.
- **Minor:** die Diff-Kommandos zeigen auf `HEAD~1`; der Stufe-3-Beweis nennt
  beide `docs/53`-Zeilen; `docs/03:69` heißt „fehlerhaft"; die Log-Reihenfolge ist
  2, 3, 4, 5; „übrigen" steht einmal; `docs/53` sagt „Betreiberentscheidung".

Alle Befunde sind in Stufe 1–3 eingearbeitet; siehe `## Log`.

## Log

- **2026-11-22, Umfang gemessen:** 34 Texte in `texts.rs`, 1 in `failure.rs`,
  38 in `bridge.js`, zwei Fixtures; die Zahl der gepinnten Assertions war an
  dieser Stelle geschätzt und ist gestrichen. Die Zeile „Die
  Node-Tests pinnen keine deutschen Meldungen" war **falsch** — sie pinnten
  zwölf; die Messung zählte Umlaute. Siehe `## Umfang`.
- **2026-11-22, gebaut (alle drei Stufen):** die Messung war zu klein — siehe
  `## Umfang`. Übersetzt sind 51 Texte in `texts.rs`, 13 Argument-Refusals und
  14 Beschreibungen in `tools.rs`, die Meldungen in `bridge.js`, die Pins in
  `mcp.rs` und `test/extension.test.js`; dazu `tests/texts.rs` als Wächter und
  drei Fixtures. Nur Sätze, kein Verhalten. Beweise: `cargo test` 287 Fälle grün,
  `clippy -D warnings` auf `x86_64-unknown-linux-musl` und
  `x86_64-pc-windows-gnu`, `npm test` 547 Fälle, `npm run check` 0,
  `parity.sh --check` 7/7, `--self-test` 7/7.
- **2026-11-22, Nachträge an aktiven Specs:** `docs/53` an fünf Stellen
  (Vertragstabelle, „Kein Draht-Code", `## Sprache`, Kriterium 3/Log, das
  `browser_read`-Zitat), `CONTRIBUTING.md` (`## Language`), `docs/38-rust-port.md`
  (datierter Nachtrag) und `docs/PROJECT-STATE.md`.
- **2026-11-22, Review Runde 1 — alle Befunde übernommen:**
  - **M1:** `## Amendments to previous spec docs` ergänzt, `docs/53` an den vier
    Stellen geändert (Stufe 3).
  - **M2:** die drei Fixtures in Stufe 1 gezogen; Stufe 1 ist damit grün.
  - **M3:** `"keine"` ⇒ `"none"` in `bridge.js`; neuer Fall
    `transcript_captionRow_noCandidate_shouldAnswerAnEmptyListAsNone` pinnt den
    vollen Satz.
  - **M4:** `CONTRIBUTING.md`, `## Language` in Stufe 3 nachgezogen.
  - **m1:** `--manifest-path bridge-rs/Cargo.toml` im Testkommando.
  - **m2:** Grep-Klasse auf `[äöüßÄÖÜ]` erweitert, wie der Wächter.
  - **m3:** Kriterium 1 sagt jetzt ausdrücklich „Antworttexte", Kommentarzeilen
    ausgenommen.
  - **m4, m5:** Kriterien 2 und 4 nennen ihre Kommandos und die beiden Ziele.
  - **m6:** je Zeile ein Befehl oder das Wort „Schätzung".
  - **m7:** `hub.rs`-Zeile sagt „0 Meldungen; die eine Umlaut-Zeile ist ein
    Kommentar".
  - **m8:** das dritte Ton-Beispiel ist jetzt der gebaute, aktive Satz.
  - **m9:** Touch boundary nennt `mod.rs` (nur Kommentare) und
    `PROJECT-STATE.md`.
  - **m10:** die Testing-Zeilen nennen Fälle statt „gepinnte Sätze".
  - **m11:** die Frontmatter-`description` verspricht keine „Zuordnung der
    Fehlercodes" mehr.
  - **m12:** die Freigabe für alle drei Fixtures steht in `PROJECT-STATE.md`,
    `### Freigaben 2026-11-22`.
  - **m13:** „Nur Sätze, kein Verhalten" statt „Kein Code geändert".
  - **m14:** die lokalisierte Browser-Meldung steht als Lücke unter
    `## Bekannte Lücken`.
  - **m15:** der Klon-Fall ist entfallen; die Assertions stehen im bestehenden
    `focus_withAnUnexpectedParameter_shouldAnswerInvalidParamsAndUpdateNothing`,
    der Kommentar sitzt wieder über seinem Fall.
  - **m16:** „thirteen" ⇒ „fourteen" in `mod.rs`, `tools.rs` und `tests/mcp.rs`.
  - **m17:** der Wächter-Satz sagt „mit Umlaut".
  - **m18:** der falsche Log-Eintrag ist als falsch markiert.
  - **Prozess:** die Reihenfolge Gate → Bau ist nicht nachholbar; sie steht als
    Befund in `## Review` und wird nicht beschönigt.
- **2026-11-22, Review Runde 2 — alle Befunde übernommen:** Log-Überschrift und
  Verweis repariert; Stufe-1-Beweis ohne Stufe-2-Anteile; fünfte `docs/53`-Stelle
  (das deutsche `browser_read`-Zitat) ersetzt; Testfallname in `docs/53`
  korrigiert; Optionsseite nur noch englisch; die ungepinnte Array-Verzweigung als
  Lücke benannt; echtes Beispiel für die Browser-Meldung; `help.rs` im Wächter;
  Amendments-Abschnitt entfernt; Nachtrag in `docs/38`; Assertion-Zahl gestrichen;
  Kommentar in `test/extension.test.js` korrigiert; Überholt-Vermerk in
  `PROJECT-STATE.md`.
- **2026-11-22, Review Runde 3 — alle Befunde außer M2 übernommen:** M1 (docs/38
  in Stufe 3 und Touch boundary); m1/m2 (die beiden Zähl-Kommandos zählen den
  Diff-Kopf mit, jetzt `grep '^-' | grep -vc '^--- a/'` ⇒ 30 bzw. 77);
  m3 (hub.rs-Zeile nennt den deutschen Beispiel-Satz im Test-Double); m4
  (`PROJECT-STATE.md` nennt `help.rs` im Wächter); m5/m6/m7 (docs/53: „vor dem
  Bau", Stand `c15f8b9`, aktueller Wert, Fallname
  `…FourteenToolsOfTheContract:995`, die drei Help-Sätze ausgeschrieben);
  m8 (Stufe 1 nennt Kriterium 3); m9 („Logzeilen der Bridge und der Extension");
  m10 (CONTRIBUTING nennt die lokalisierte Browser-Meldung als Ausnahme);
  m11 (Stufe 3 stellt die Spec auf `active`); m12 („the operator's browser" in
  `tools.rs`, `tests/mcp.rs`, Fixture 1 — `tools/list` jetzt 8 062 Zeichen);
  m13 (der Modulkommentar sagt „the contract the agent reads"); m14 (docs/53
  sagt, warum die Review-Runde dort offen bleibt); Rechtschreibung.
  **M2 ist geteilt:** die drei operativen Stellen sind nachgezogen, die übrigen
  übrigen Zitatstellen stehen in `docs/55-alte-zitate-in-specs.md`
  (Betreiberentscheidung 2026-11-22).
- **2026-11-22, Review Runde 4 — alle Befunde übernommen:** `docs/38` in Stufe 3
  und Touch boundary; Zitatfrage geteilt (Betreiberentscheidung, Spec `docs/55`);
  die vierzehn Kleinigkeiten aus Runde 4 eingearbeitet.
- **2026-11-22, Review Runde 5 — alle Befunde übernommen:** die beiden
  `description`-Zellen in `docs/03`/`docs/05` auf Englisch; Runde 4 und 5 im
  Review und im Log; `HEAD~1` in beiden Diff-Kommandos; Stufe-3-Beweis mit beiden
  erwarteten Zeilen; `docs/03:69` „fehlerhaft"; Log-Reihenfolge; doppeltes
  „übrigen" entfernt; `docs/53` „Betreiberentscheidung"/„Entscheidung".
  **Offen bleibt nur der Prozessbefund** (Bau vor Gate) — er ist nicht reparierbar
  und steht in `## Review`.
