---
description: Drei Sätze in den Werkzeugbeschreibungen schließen die Lücken aus dem telefunken-Lauf; das tools-Array wächst von 8 176 auf 8 465 Zeichen, die Grenze steigt als Reserve von 8 500 auf 10 000.
status: active
---

# Die Beschreibung trägt die Lehre, nicht die Skill

## Anlass

Am 2026-11-26 lief in telefunken ein Agent (qwen3.5-9b, Denkstufe hoch) 5 Minuten
31 Sekunden lang mit den Werkzeugen von browser-control. Die Sitzung ist
ausgewertet (`~/.pi/agent/sessions/--home-adrian-rea-projekte-telefunken-b43f545b--/2026-11-26T09-40-46-675Z_…jsonl`):

| Beobachtung | Wert |
|---|---|
| Werkzeugaufrufe | 55 |
| Fehlantworten | 4 (7 %): zwei selbstgebaute Selektoren, zwei `eval_blocked_by_the_page` |
| Aufrufe für den DuckDuckGo-Suchkasten | etwa 6, bevor er auf `?q=` wechselte |
| `browser_read` | 17-mal, jedes Mal `maxChars: 20000` |
| Werkzeugausgabe im Kontext | 113 510 Zeichen |
| Abgeschnittene Antwort | 1 (Harness kappte bei 5 272 Token) |
| `SKILL.md` gelesen | nein — kein Aufruf außer `browser_*` |
| `browser_help` aufgerufen | nein |

Die Skill hat also nichts bewirkt. Sie ist am 2026-11-26 aus `~/.agents/skills/`
entfernt und nach `~/.agents/skills-removed-browser-control-2026-11-26/` verschoben.

Der Text, den ein Modell zuverlässig liest, ist die **Werkzeugbeschreibung**: sie
steht in jedem Turn im Werkzeugset. Dorthin wandern die drei Lehren, die der Lauf
teuer bezahlt hat.

## Ziel

1. **`browser_inspect` sagt, was `contains_text` ist:** sichtbarer Text, kein
   Tag-Name und kein Attribut; für ein Eingabefeld ist `selector` richtig.
2. **`browser_navigate` nennt zwei Suchadressen**, die ohne Suchkasten
   funktionieren: DuckDuckGo und GitHub.
3. **`browser_read` nennt ein Lesefenster** und sagt, dass ein voller Lesevorgang
   Kontext kostet.
4. **Die Grenze wird zur Reserve:** von 8 500 auf **10 000 Zeichen** (`docs/60`,
   Ziel 8), Betreiberentscheidung vom 2026-11-26. Die Erhöhung ist eine
   Obergrenze, keine Quote: dieser Bau schöpft sie nicht aus, es bleiben 1 490
   Zeichen Luft (an Zeile 5 gemessen).
5. **Kein Verhalten ändert sich.** Nur drei Sätze in Beschreibungen.

## Der Vertrag

Die Sätze werden **angehängt**, nicht eingebaut: genau ein führendes Leerzeichen,
kein abschließendes. Wortlaut und Zeichenzahl sind verbindlich; ein Test grept sie.
Der Wortlaut steht hier zeichengenau, damit niemand ihn aus der Tabelle abschreibt:

```
navigate:  Search pages open directly: `https://duckduckgo.com/?q=<term>`, `https://github.com/search?q=<term>`.
read:      Ask for `maxChars: 4000` and page on with `offset`; a full read costs context.
inspect:   `contains_text` matches visible text, not tag names or attributes; for `<input>` use `selector: "input"`.
```

Die Einrückung vor dem Doppelpunkt gehört **nicht** zum Satz. Der dritte Satz
enthält `"input"`; im JSON der Werkzeugliste wird jedes Anführungszeichen zu `\"`,
also kosten die drei Sätze zusammen 287 Zeichen Text und 289 Zeichen in der Liste.
Wer mit 287 rechnet, liegt um zwei Zeichen daneben — genau so viel, dass Kriterium 1
rot wird.

| Werkzeug | Anzuhängender Satz | Zeichen |
|---|---|---|
| `browser_navigate` | `` Search pages open directly: `https://duckduckgo.com/?q=<term>`, `https://github.com/search?q=<term>`. `` | 102 |
| `browser_read` | `` Ask for `maxChars: 4000` and page on with `offset`; a full read costs context. `` | 79 |
| `browser_inspect` | `` `contains_text` matches visible text, not tag names or attributes; for `<input>` use `selector: "input"`. `` | 106 |

| Rechnung | Wert |
|---|---|
| `tools/list` heute (das `tools`-Array, ohne Leerzeichen) | 8 176 Zeichen |
| Zuwachs | 287 Zeichen Text + 2 JSON-Escapes = **289 Zeichen** |
| `tools`-Array danach | **8 465 Zeichen** |
| Zeile 5 des Artefakts heute | 8 221 Zeichen (`wc -m`, mit Zeilenumbruch) |
| Zeile 5 danach | **8 510 Zeichen** |
| Grenze (`docs/60`, Ziel 8) | **10 000 Zeichen** (vorher 8 500) |
| Luft danach (an Zeile 5 gemessen) | 1 490 Zeichen |

Drei Zahlen bezeichnen drei verschiedene Dinge, und die Spec prüft alle drei:

| Messung | heute | danach |
|---|---|---|
| `tools`-Array allein | 8 176 | **8 465** |
| Zeile 5 des Artefakts | 8 221 | **8 510** |
| `json!({"tools": tool_list()})`, was `toolsList_shouldStayUnderTheCharacterBudget` misst | 8 186 | **8 475** |

Die zwei Zahlen 8 465 und 8 510 bezeichnen zwei verschiedene Dinge: das Array ohne
Hülle und die Zeile, die es im Artefakt einnimmt. Wer sie verwechselt, prüft das
Falsche — deshalb misst Kriterium 1 Zeile 5.

Der Betreiber hat drei Sätze beauftragt und die Grenzerhöhung als Reserve
freigegeben. Ein vierter Satz stand hier zwischenzeitlich zur Debatte; er ist
gestrichen, weil die Erhöhung keinen Text bestellt. Die Grenze ist eine Obergrenze,
keine Quote.

Sicherung: das eingefrorene Artefakt
`scripts/parity/expected/1-initialize-and-tools-list.txt`, Zeile 5, trägt die
Beschreibungen. Es wird in Stufe 2 neu geschrieben — ein datierter Akt, für den die
Betreiberfreigabe am 2026-11-26 vorliegt.

## Non-goals

- **Keine Schemaänderung.** Argumente, Pflichtfelder und Typen bleiben.
- **Kein neues Werkzeug, kein neues Argument.**
- **Keine Änderung an `help.rs`.** Die Anleitungen sind schon korrekt; sie werden
  nur nicht gelesen.
- **Keine Erhöhung über 10 000.** Die neue Grenze ist die Obergrenze dieses
  Increments; ein weiterer Zuwachs braucht eine eigene Entscheidung.
- **Keine Wiedereinführung der Skill.**
- **Keine Anleitung in `help.rs`.** Die Sätze stehen in der Beschreibung, nicht im
  Handbuch; das Handbuch bleibt unverändert (siehe `docs/53`).

## Touch boundary

| Erlaubt | Nicht erlaubt |
|---|---|
| `bridge-rs/src/mcp/tools.rs` (die drei Beschreibungen, nichts sonst) | `help.rs`, Schemata, `hub.rs` |
| `scripts/parity/expected/1-initialize-and-tools-list.txt` (Zeile 5, datierter Akt) | die anderen sechs Artefakte unter `scripts/parity/expected/` |
| `bridge-rs/tests/mcp.rs` (drei Beschreibungs-Literale, drei Satz-Konstanten, ein neuer Fall) und `bridge-rs/tests/help_contract.rs` (Konstante, Doc-Kommentar, Fehlermeldung) | `extension/**`, `test/**` (JS) |
| `docs/70-beschreibungen-statt-skill.md` (Status, Review, Log), `CHANGELOG.md` | `docs/53`, `docs/54`, `docs/59`, `docs/60` (gehören zu `docs/71`), `docs/README.md`, `PROJECT-STATE.md`, `ROADMAP.md` |
| — | neue Abhängigkeiten |

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `bridge-rs/tests/mcp.rs` | `mcp_descriptions_shouldCarryTheThreeMeasuredSentences` **neu** | die drei Sätze stehen in genau der Beschreibung, die der Vertrag nennt — je einmal, und in keiner der elf anderen |
| `bridge-rs/tests/help_contract.rs` | `toolsList_shouldStayUnderTheCharacterBudget` **bestehend, Konstante auf 10 000** | die Grenze gilt weiter, unabhängig von den drei Sätzen; Doc-Kommentar und Fehlermeldung nennen dieselbe Zahl |
| `scripts/parity.sh` | Vergleich 1 | die Antwort `initialize`/`tools/list` stimmt Zeile für Zeile mit dem neu geschriebenen Artefakt |

Der neue Fall in `tests/mcp.rs` liest die Beschreibungen aus `tools::tool_list()`,
nicht aus dem Quelltext: damit prüft er, was der Dienst wirklich ausliefert.
`mcp_toolsListIsByteIdentical` und Vergleich 1 sind zwischen Stufe 2 und 3 rot —
das ist unvermeidlich und steht im Dev plan.

## Acceptance criteria

1. **Der Zuwachs ist gemessen, nicht geschätzt:**
   `LC_ALL=C.UTF-8 awk 'NR==5' scripts/parity/expected/1-initialize-and-tools-list.txt | LC_ALL=C.UTF-8 wc -m`
   ⇒ `8510` (Zeile 5 mit Zeilenumbruch), also höchstens 10 000. Die Locale gehört in
   den Befehl: ohne sie zählt `wc` Bytes, und die Geviertstriche der Beschreibungen
   kosten 28 Bytes mehr (heute 8 249 statt 8 221).
2. **Konstante und Prosa sind gesetzt:**
   `grep -c '10_000' bridge-rs/tests/help_contract.rs` ⇒ `1` (nur die Konstante) **und**
   `grep -c '8 500' bridge-rs/tests/help_contract.rs` ⇒ `0` (Kommentar und Meldung
   tragen die alte Zahl nicht mehr), und
   `cargo test --manifest-path bridge-rs/Cargo.toml --test help_contract -- --test-threads=1`
   ⇒ `toolsList_shouldStayUnderTheCharacterBudget` grün (die Konstante steht dort).
3. **Jeder Satz steht einmal in seiner Beschreibung:**
   `cargo test --manifest-path bridge-rs/Cargo.toml --test mcp mcp_descriptions_shouldCarryTheThreeMeasuredSentences -- --test-threads=1`
   ⇒ **`1 passed`** (heute `0 passed, 136 filtered out`; Exit 0 allein ist leer-grün und
   zählt nicht). Die Beschreibungen
   sind in `tests/mcp.rs` als Literale gepinnt; in `help_contract.rs` lebt nur die
   Größenprüfung.
4. **Nichts anderes an der Werkzeugliste hat sich bewegt** (nur vor dem Commit
   prüfbar, danach ist der Diff leer):
   `diff <(git show HEAD:scripts/parity/expected/1-initialize-and-tools-list.txt) scripts/parity/expected/1-initialize-and-tools-list.txt`
   ⇒ genau eine geänderte Zeile (Zeile 5).
5. **Parity grün:** `bash scripts/parity.sh --impl rust --check` ⇒ `7/7 wie erwartet`.
6. **Gesamtlauf grün:**
   `cargo test --manifest-path bridge-rs/Cargo.toml -- --test-threads=1` ⇒ jeder Block
   `ok`, kein `FAILED` (`mcp.rs` wächst von 136 auf 137 Fälle); `cargo clippy --manifest-path bridge-rs/Cargo.toml
   --all-targets -- -D warnings` ⇒ Exit 0; `npm test` ⇒ `# pass 584`, `# fail 0`;
   `npm run check` ⇒ Exit 0.
7. **Kein Verhalten** (nach dem Stagen, weil diese Spec noch untracked ist):
   `git diff --cached --stat` nennt genau diese fünf Dateien, dazu die sechs aus
   `docs/71-grenze-nachziehen.md` und `CHANGELOG.md` — und keine weitere:

   ```
   bridge-rs/src/mcp/tools.rs
   bridge-rs/tests/mcp.rs
   bridge-rs/tests/help_contract.rs
   scripts/parity/expected/1-initialize-and-tools-list.txt
   docs/70-beschreibungen-statt-skill.md     # Status, Review, Log
   CHANGELOG.md
   # dazu die sechs Dateien aus docs/71
   ```

   `docs/README.md` und `docs/PROJECT-STATE.md` führt der Orchestrator; sie zählen
   nicht mit (CONTRIBUTING, Schritt 7).

## Dev plan

Die drei Beschreibungen sind in `bridge-rs/tests/mcp.rs` als Literale gepinnt
(`NAVIGATE_TOOL_DESCRIPTION` `:704`, `READ_TOOL_DESCRIPTION` `:705`,
`INSPECT_TOOL_DESCRIPTION` `:709`) und werden in
`mcp_toolsList_shouldOfferExactlyTheFourteenToolsOfTheContract` (`:1025`) Zeile für Zeile
behauptet. Eine Stufe „nur `tools.rs`" gibt es deshalb nicht; Stufe 2 ändert beide
Kopien.

1. **Nullmessung, ohne Schreibzugriff.** Vorbedingung: das musl-Release-Binary muss
   existieren, sonst bricht `parity.sh` mit `rust binary missing:` ab. Es entsteht erst
   in Stufe 3, also vorher einmal bauen (`target/` ist ignoriert, der Baum bleibt
   sauber):

   ```bash
   cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl
   ```

   Die Zahlen dieser Stufe sind der Maßstab für alles Weitere:

   ```bash
   awk 'NR==5' scripts/parity/expected/1-initialize-and-tools-list.txt | LC_ALL=C.UTF-8 wc -m   # 8221
   bash scripts/parity.sh --impl rust --check;     echo $?   # 7/7 wie erwartet, 0
   bash scripts/parity.sh --impl rust --self-test; echo $?   # 7/7 rot wie erwartet, 0
   ```

   Der Selbsttest belegt, dass das eingefrorene Artefakt nicht schon vorher vom Binary
   abweicht. Beide Läufe brauchen das musl-Release-Binary; `scripts/parity.sh` baut nichts
   und bricht mit `rust binary missing:` ab.

2. **Die drei Sätze in beiden Kopien, das Budget und der neue Fall.**
   `bridge-rs/src/mcp/tools.rs`: an `BROWSER_NAVIGATE_DESCRIPTION` (`:407`),
   `BROWSER_READ_DESCRIPTION` (`:410`) und `BROWSER_INSPECT_DESCRIPTION` (`:422`) den
   Wortlaut aus dem Vertrag anhängen; jeder String bleibt sonst zeichengleich,
   `tool_list()` (`:109`) und alle Schemata unberührt. `BROWSER_EVAL_DESCRIPTION`
   (`:431`) bleibt unangetastet.
   `bridge-rs/tests/mcp.rs`: dieselben **drei** Literale nachziehen, drei Konstanten mit nur
   dem Satz anlegen, und den neuen Fall **hinter** `mcp_toolsListIsByteIdentical` (`:1351`)
   einsetzen: je Werkzeug `description.matches(SENTENCE).count() == 1` **und** der Satz kommt
   in keiner der **elf** anderen Beschreibungen vor.
   `bridge-rs/tests/help_contract.rs`: die Konstante `8_500` → `10_000` (Zeile 667),
   dazu der Doc-Kommentar (Zeile 659) und die Fehlermeldung (Zeile 668) auf „10 000"
   mit Leerzeichen und Verweis auf `docs/60`, Ziel 8.

   **Warum `tests/mcp.rs` und nicht `help_contract.rs`:** `help_contract.rs` prüft die
   Anleitungen — `manual_for`/`known_names` gegen Schemas und Returns-Zeilen (Kopfkommentar
   `:1-30`); sein einziger Bezug zu `tools/list` ist die Größe
   (`toolsList_shouldStayUnderTheCharacterBudget`, `:662`). Die Beschreibungen dagegen
   besitzt `mcp.rs`: dort stehen die Literale, dort der Byte-Vergleich gegen das Artefakt,
   und dort muss ohnehin editiert werden. Der Preis ist der geänderte Befehl in Kriterium 3.

   Beweis, ohne Stufe 3:

   ```bash
   cargo test --manifest-path bridge-rs/Cargo.toml --test help_contract \
     toolsList_shouldStayUnderTheCharacterBudget -- --test-threads=1     # ⇒ 1 passed
   cargo test --manifest-path bridge-rs/Cargo.toml --test mcp \
     mcp_toolsList_shouldOfferExactlyTheFourteenToolsOfTheContract -- --test-threads=1  # ⇒ 1 passed
   ```

   `mcp_toolsListIsByteIdentical` ist in dieser Stufe ausdrücklich **rot** und bleibt
   aus dem Beweis heraus: es vergleicht gegen das Artefakt, das erst Stufe 3 schreibt.

   Danach sind `mcp_toolsListIsByteIdentical` und Vergleich 1 rot. Das ist erwartet und wird
   nicht committet.

3. **Zeile 5 des eingefrorenen Artefakts, von Hand aus den Bytes des Parity-Laufs.** Ein
   `--record` gibt es nicht mehr (`scripts/parity.sh:144`), und kein Skript schreibt mehr in
   den Baum. Die neue Zeile entsteht so:

   ```bash
   cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl
   bash scripts/parity.sh --impl rust --check --only 1 --keep   # rot, dazu: run directory kept: /tmp/bc-parity.XXXXXX
   ```

   `record_probe` (`:395`) schreibt den Kandidaten nach `<run>/probe-1.txt`, in derselben Form
   wie das Artefakt (`# cases=2`, `# case=1`, Zeile 3, `# case=2`, Zeile 5). Aus dieser Datei
   Zeile 5 **von Hand** in `scripts/parity/expected/1-initialize-and-tools-list.txt`
   einsetzen; Zeilen 1–4 bleiben unangetastet, danach `rm -rf <run>` (der Lauf legt dort ein
   Zufallstoken ab). Kein `cp`, kein `>`: das Artefakt ist ein eingefrorener Beleg, kein
   Bauergebnis, und der Diff soll den datierten Akt zeigen. Den vollen Text aus
   `probe-1.txt` nehmen, nicht aus der Konsolenausgabe — `show_difference` (`:414-415`) kürzt
   jede Zeile auf 220 Zeichen.

   Beweis:

   ```bash
   bash scripts/parity.sh --impl rust --check; echo $?   # ok 1 … ok 7, 7/7 wie erwartet, 0
   git diff -- scripts/parity/expected/1-initialize-and-tools-list.txt   # genau eine Zeile
   ```

   `--check` muss danach für alle sieben Vergleiche `ok <n> <name>` drucken, mit `7/7 wie
   erwartet` und `0` enden — keine `diff`-Zeile, kein `-…`-Ausschnitt; `--self-test` wieder
   `7/7 rot wie erwartet`.

   **Stufe 2 und 3 gehen in einem Auftrag** (wie `docs/60`, Dev plan Stufe 0): dazwischen ist
   Vergleich 1 rot, und zwar unvermeidlich (siehe unten).

4. **Abschluss — Orchestrator-Arbeit** (`CONTRIBUTING.md`, Schritt 7; der Implementer
   darf die Spec nicht ändern). Die Sätze für `docs/60`, `docs/53`, `docs/54` und
   `docs/59` stehen in `docs/71-grenze-nachziehen.md`; hier bleiben nur `CHANGELOG.md`
   unter `[0.8.0]`, `status: active` in dieser Spec und die Statuszeile in
   `docs/README.md`. Beweis: Kriterium 6 und 7.

### What could go wrong

- **Die Zahlen der Spec gehen nicht auf; also nicht abschreiben.** Gemessen: `tools`-Array
  heute 8 176 Zeichen, **Zeile 5 heute 8 221 Zeichen** (`LC_ALL=C.UTF-8 wc -m`, mit
  Zeilenumbruch). Die drei Sätze sind 102 + 79 + 106 = 287 Zeichen, jeweils mit
  führendem Leerzeichen. Erwartung nach Stufe 3: `tools`-Array **8 465**, Zeile 5
  **8 510**. Die Spec nennt beide Zahlen getrennt, und Kriterium 1 misst Zeile 5.
- **`wc -m` zählt ohne UTF-8-Locale Bytes.** Zeile 5 trägt 14 Geviertstriche, die in Bytes 28
  mehr kosten; `LC_ALL=C` druckt 8 538 statt 8 510. Locale im Befehl und in `docs/60` nennen.
- **Ein veraltetes Binary misst den alten Text.** `scripts/parity.sh` prüft nur, ob das Binary
  fehlt. Wer `tools.rs` nach dem Bau noch anfasst, pastet die alte Zeile: der Diff ist leer,
  `--check` sieht grün aus, `mcp_toolsListIsByteIdentical` bleibt rot. Nach jeder
  Textänderung neu bauen.
- **`browser_eval` bleibt ohne Satz.** Zwei der vier Fehlantworten des Laufs waren
  `eval_blocked_by_the_page`. Ein Satz dagegen wäre in der Reserve von 1 490 Zeichen
  untergebracht; er ist nicht beauftragt und steht deshalb nicht hier.
- **Nur die eigene Naht wird hier aufgeräumt.** Diese Spec setzt die Konstante, den
  Doc-Kommentar und die Meldung in `help_contract.rs`; alle Spec-Texte (fünf Stellen in
  `docs/53`, je eine in `docs/54` und `docs/60`, zwei in `docs/59`) zieht
  `docs/71-grenze-nachziehen.md` nach.
- **Der Handgriff am Artefakt ist eine Ausnahme.** `CONTRIBUTING.md` verbietet Handarbeit an
  erzeugten Artefakten; diese sieben sind eingefrorene Belege, die kein Bau mehr erzeugt
  (`scripts/parity.sh:34-36`). Prüfbar hält den Eingriff Kriterium 4: genau eine geänderte
  Zeile im Diff.

### Ordering and dependencies

Eine Kette erzwingt die Reihenfolge: `tools.rs` erzeugt `tools/list`; `tests/mcp.rs`
(`mcp_toolsListIsByteIdentical`) und Vergleich 1 lesen dieses Ergebnis gegen das Artefakt.
Das Artefakt kann die neue Zeile erst tragen, wenn das neue Binary existiert, das Binary erst
nach der Textänderung. **Ein kurzes rotes Fenster ist deshalb unvermeidlich**; es liegt
nicht zwischen den Stufen, sondern in Stufe 2/3. Gegenmittel: beides in einem Arbeitsgang
und erst danach committen.

- Stufe 1 zuerst und grün, damit jeder spätere rote Lauf zuordenbar ist.
- Stufe 2 vor Stufe 3 (das Binary trägt den neuen Text).
- Stufe 3 vor dem Commit; `cargo test --test mcp` und `--check` werden gemeinsam grün.
- Stufe 4 zuletzt, weil ihr Wortlaut eine Zahl aus Stufe 3 trägt. Kein Test liest `docs/60`;
  sie dürfte früher laufen, nur den Wert noch nicht nennen.

### What the next increment inherits

- **Die Grenze 10 000 mit Luft.** Nach der Messung bleiben 1 490 Zeichen; jeder weitere
  Satz braucht eine eigene Betreiberentscheidung.
- **Beschreibungen leben an drei Orten:** `tools.rs`, die Literale in `tests/mcp.rs`, Zeile 5
  des Artefakts. Jede künftige Textänderung wiederholt den Handgriff aus Stufe 3.
- **`help.rs` bleibt unberührt.** Handbuch und Beschreibung können weiter auseinanderlaufen.
- **`docs/53` trägt nach dem Bau einen datierten Nachtrag, nicht überall die neue Zahl.**
- **Der vierte Satz bleibt gestrichen.** Die Reserve von 1 490 Zeichen ist für eine
  künftige, dann gemessene Lücke gedacht.
- **Eine Beschreibung ist kein Guard.** `contains_text: "input"` antwortet weiter mit
  `count: 0` statt mit einem Hinweis.

## Bekannte Lücken

- **Der Satz über Suchseiten nennt zwei Beispiele, nicht alle.** Andere Suchseiten
  mit `?q=` funktionieren genauso, stehen aber nicht da.
- **Die Grenzerhöhung bestellt keinen Text.** Die Reserve von 1 490 Zeichen bleibt
  unangetastet; wer sie nutzen will, braucht dafür eine eigene Spec mit gemessener Lücke.
- **Der Nutzen ist eine Annahme, kein Beweis.** 287 Zeichen in jedem Turn gegen
  etwa 6 gesparte Aufrufe im beobachteten Lauf — gemessen ist nur der eine Lauf,
  und die 10 000er-Grenze senkt den Druck, sparsam zu formulieren.
- **Eine Beschreibung ist kein Ersatz für einen Guard.** Ein Modell, das
  `contains_text: "input"` schreibt, bekommt weiter `count: 0` statt eines Hinweises.
- **`docs/53` zieht `docs/71` nach, nicht diese Spec.** Was dort stehen bleibt, sagt
  `docs/71`, `## Bekannte Lücken`.

## Open questions

**Keine.** Betreiberentscheidung vom 2026-11-26: die Skill entfällt, die Lehren
wandern in die Beschreibungen, die Grenze aus `docs/60` steigt auf 10 000 Zeichen,
und die Freigabe für das neu geschriebene Artefakt liegt vor. Der vierte Satz gegen
`browser_eval` ist gestrichen; `help_contract.rs` zieht diese Spec nach, die Spec-Texte
`docs/71`.

## Review

| Runde | Datum | Urteil | Kernpunkte |
|---|---|---|---|
| 1 | 2026-11-26 | `nicht bestanden` | Dev-Plan-Stufe 2 baute noch vier Sätze (B1); Kriterium 7 ließ `tests/mcp.rs` und diese Spec aus (B2); `docs/53` und `help_contract.rs` behielten nach dem Bau eine falsche 8 500 (B3); „Open questions: Keine" widersprach zwei offenen Fragen (B4); die drei Sätze waren nicht wortgetreu gepinnt (B5); dazu M1–M8 und N1–N6 |
| 2 | 2026-11-26 | `nicht bestanden` | die drei „danach"-Zahlen waren um 2 zu klein (JSON-Escapes in `selector: "input"`); Kriterium 7 nannte weiter fünf Dateien; Stufe 4 baute `docs/53` und `help_contract.rs` nicht nach und überschritt die Rolle des Implementers; Kriterium 6 ohne `--manifest-path`; `docs/59:128` ist ein Kriterium, keine Messung |
| 3 | 2026-11-26 | `nicht bestanden` | Kriterium 3 war leer-grün (`0 passed`, Exit 0), Kriterium 7 nach dem Bau unerfüllbar (untracked Spec, `git diff --stat`), `docs/59` fehlte in Boundary und Kriterium 7, drei Stellen in fremden Specs behielten die falsche 8 500. **Damit drei Blöcke: geteilt** — die Doku-Nachträge an `docs/53`, `docs/54`, `docs/59`, `docs/60` stehen jetzt in `docs/71-grenze-nachziehen.md` |
| 4 (Fassung 1) | 2026-11-26 | `nicht bestanden` | Kriterium 3 pinnte `1 passed` an ein Kommando ohne Namensfilter (heute `136 passed`, nie `0`); Kriterium 7 nannte nach der Teilung zwei verbotene Dateien; Kriterium 2 prüfte `docs/60` statt der eigenen Konstante; Teilung in `docs/70` nicht zu Ende geführt; der Amendments-Abschnitt war ein Trümmerfeld mit einer Testdatei |
| 5 (Fassung 2) | 2026-11-26 | `nicht bestanden` | Kriterium 7 war rot, sobald der Plan erfüllt ist (`CHANGELOG.md` und `docs/71` fehlten); `## Open questions` schickte `docs/53` in eine verbotene Datei; Konstante, Doc-Kommentar und Meldung hatten keinen gemeinsamen Auftrag; „Zweiter Satz" statt „dritter" vor den JSON-Escapes; die Aufzählung der Rest-8 500 war halb |
| 6 (Fassung 3) | 2026-11-26 | `bestanden` | Gate offen nach dem Bau: Kriterien 1–6 mit Ist-Werten belegt, Kriterium 7 nach dem Stagen geprüft; `docs/71` im selben Commit |

## Log

- **2026-11-26, angelegt.** Anlass ist die ausgewertete telefunken-Sitzung; die
  Skill wurde entfernt, die drei Sätze sind aus ihren drei vergeblichen Versuchen
  abgeleitet (Suchkasten, `contains_text`-Missverständnis, Lesefenster).

- **2026-11-26, Runde 1 eingearbeitet.** B1: Stufe 2 nennt nur noch die drei
  Beschreibungen, `BROWSER_EVAL_DESCRIPTION` bleibt unangetastet, „elf andere" statt
  „zehn". B2: Kriterium 7 nennt sieben Dateien plus diese Spec, `CHANGELOG.md` steht in
  der Touch boundary. B3: `docs/53` (Zeilen 117, 122) und die Meldung in
  `help_contract.rs` (659, 668) sind Amendments und Teil von Stufe 4. B4: die zwei
  Fragen sind beantwortet (kein vierter Satz; `docs/53` wird nachgezogen), „Keine"
  stimmt damit. B5: der Wortlaut steht in einem Codeblock mit der Regel „genau ein
  führendes Leerzeichen, kein abschließendes"; 102 + 79 + 106 = 287. M1: drei Messungen
  stehen nebeneinander (8 176/8 465 Array, 8 221/8 510 Zeile 5, 8 186/8 475 die Zahl des
  Größentests). M2: die Beweise nennen Fallnamen, der rote Byte-Vergleich ist
  ausgenommen. M3: die Reste der Vier-Satz-Fassung (8 510/8 466, „110 Zeichen") sind
  gestrichen. M4: der veraltete Vorspann des Dev plans ist weg. M5: Kriterium 6 nennt
  `--manifest-path` und `--test-threads=1`. M6: Stufe 4 setzt `LC_ALL=C.UTF-8` auch in
  den Befehl von `docs/60`. M7: `CHANGELOG.md` und diese Spec stehen in der Boundary.
  M8: das rote Fenster reicht von Stufe 2 bis 4. N1: die Amendments zitieren die echten
  Zeilen 66, 124 und 125. N2: `mcp_toolsListIsByteIdentical` steht bei `:1351`. N3: die
  Aufzählung nennt auch `docs/60:178`, `docs/59:128`/`:180` und `help_contract.rs:668`.
  N4: die Registry-Zeile in `docs/README.md` sagt drei Sätze und 8 465. N6: Kriterium 1
  setzt die Locale auf beide Seiten der Pipe.

- **2026-11-26, Runde 2 eingearbeitet.** B-1: der Zuwachs ist 287 Zeichen Text plus
  2 JSON-Escapes = 289; damit 8 465 (Array), 8 510 (Zeile 5), 8 475 (Hüllenmessung),
  Reserve 1 490, `LC_ALL=C` 8 538. Die Spec erklärt die Escapes jetzt im Vertrag, weil
  `selector: "input"` zwei Anführungszeichen trägt. B-2: Kriterium 7 listet acht Dateien
  im Codeblock. B-3 und B-5: Stufe 4 ist Orchestrator-Arbeit und nennt `docs/53`
  (117, 122), `help_contract.rs` (659, 668) und `docs/59:128`. B-4: Kriterium 6 mit
  `--manifest-path` und `--test-threads=1`. M-1: `docs/59:128` ist ein Kriterium und
  wird datiert oder als „gilt vor `docs/70`" markiert. M-2: eine Geschichte über
  `docs/53` statt zwei. M-3: Kriterium 4 gilt nur vor dem Commit. M-4: die Boundary
  nennt die drei Satz-Konstanten. N-1 bis N-4: Zahl ohne Quelle gestrichen, doppelter
  Absatz entfernt, `mcp.rs` 136 → 137 als Zählung.

- **2026-11-26, geteilt nach dem dritten Block.** `CONTRIBUTING.md` (Schritt 4) verlangt
  nach dem dritten Block die Teilung. Diese Spec behält das Verhalten — drei
  Beschreibungen, der neue Testfall, die Konstante 10 000, das neu geschriebene
  Artefakt. Die Nachträge an `docs/53`, `docs/54`, `docs/59` und `docs/60` sowie die
  Testmeldung stehen in `docs/71-grenze-nachziehen.md` und laufen im selben Commit.
  Eingearbeitet aus Runde 3: Kriterium 3 pinnt `1 passed` (heute `0 passed` ist
  leer-grün); Kriterium 7 prüft `git diff --cached` nach dem Stagen und nimmt
  `docs/README.md`, `PROJECT-STATE.md` und `CHANGELOG.md` aus; Stufe 1 nennt das
  musl-Binary als Vorbedingung; die Leiche aus Runde 1 („Kriterium 7 nennt `mcp.rs`
  nicht") ist gestrichen; Stufe 4 entfernt den Amendments-Abschnitt.

- **2026-11-26, Runde 4 eingearbeitet (Fassung 1 der Teilung).** Kriterium 3 hat den
  Namensfilter im Kommando (`1 passed`, heute `0 passed, 136 filtered out`).
  Kriterium 2 prüft `grep -c '10_000' bridge-rs/tests/help_contract.rs` und den
  Regressionswächter; die `docs/60`-Zeile ist weg. Kriterium 7 nennt fünf Dateien —
  `docs/60` und `docs/53` gehören zu `docs/71`. Der Amendments-Abschnitt ist entfernt
  (er listete eine Testdatei und hatte eine headerlose Tabelle). Stufe 4 ist auf
  `CHANGELOG`, Status und Registry zusammengestrichen. Die Kriterien 6 zählen keine
  „15 Blöcke" mehr, sondern verlangen `ok` ohne `FAILED`.

- **2026-11-26, Runde 5 eingearbeitet (Fassung 2).** Kriterium 7 zählt `CHANGELOG.md`
  und die sechs Dateien aus `docs/71` mit, damit es nicht rot wird, sobald der Plan
  erfüllt ist. `## Open questions` schickt `docs/53` nicht mehr in Stufe 4. Stufe 2
  beauftragt Konstante, Doc-Kommentar und Fehlermeldung zusammen; Kriterium 2 prüft
  `10_000` ⇒ 1 **und** `8 500` ⇒ 0. Der Satz mit den JSON-Escapes heißt „der dritte",
  nicht „der zweite". Der Aufräum-Absatz nennt die Stellen summarisch statt halb.

- **2026-11-26, gebaut und abgenommen.** Der Implementer hat die drei Sätze in
  `tools.rs` und `tests/mcp.rs` gesetzt, die Konstante samt Kommentar und Meldung
  nachgezogen und Zeile 5 des Artefakts aus `probe-1.txt` erneuert. Gemessen:
  `tools`-Array 8 176 → **8 465**, Zeile 5 8 221 → **8 510**, Reserve 1 490.
  Der Orchestrator hat gegengeprüft: `npm run check` 0, `npm test` 584/0, `cargo test`
  15 Blöcke ohne `FAILED` (`mcp` 137 Fälle), `clippy -D warnings` 0, `parity --check`
  7/7. Spec auf `active` gesetzt.
