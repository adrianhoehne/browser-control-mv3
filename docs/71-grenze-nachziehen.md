---
description: Vier fremde Specs nennen nach docs/70 noch die alte Grenze 8 500; diese Spec pinnt je Stelle einen Wortlaut und prüft ihn mit einem grep, das heute 0 und nach dem Bau den Sollwert liefert.
status: active
---

# Die neue Grenze nachziehen

## Anlass

`docs/70` erhöht die Grenze für `tools/list` von 8 500 auf 10 000 Zeichen; die
Werkzeugliste wächst auf 8 510 Zeichen (Zeile 5 des Artefakts, `LC_ALL=C.UTF-8 wc -m`).
Danach nennen vier aktive Specs weiter 8 500 — teils als Kriterium, nicht als
Geschichte:

| Dokument | Stelle | Was dort steht | Nach `docs/70` |
|---|---|---|---|
| `docs/60-klick-nach-text-mcp.md` | Zeile 66 | „höchstens 8 500 Zeichen" | falsch |
| `docs/60-klick-nach-text-mcp.md` | Zeilen 123, 124 | `awk 'NR==5' … \| wc -m` ohne Locale | zählt Bytes |
| `docs/60-klick-nach-text-mcp.md` | Zeile 125 | „8 500 (heute, vor `docs/59`: 8 062)" | falsch |
| `docs/60-klick-nach-text-mcp.md` | Zeile 178 | „⇒ ≤ 8 500 — die Beschreibungsänderung zählt gegen dasselbe Budget" | falsch |
| `docs/53-browser-help.md` | Zeilen 117, 122 | „`tools/list` bleibt unter 8 500 Zeichen" | falsch |
| `docs/54-refusals-englisch.md` | Zeile 83 | „also unter der Grenze von 8 500 aus `docs/53`" | falsch |
| `docs/59-argumentnamen.md` | Zeile 128 (Kriterium) | `… \| wc -m` ⇒ höchstens 8 500 | falsch |
| `docs/59-argumentnamen.md` | Zeile 180 | Wiederholung des Kriteriums, nicht als Messung erkennbar | falsch |

Messungen und Historie bleiben: `docs/60:313` (schreibt `8500` ohne Leerzeichen),
`docs/53:20`, `:204`, `:211`, `docs/59:144`, ältere CHANGELOG-Einträge.

## Amendments to previous spec docs

Jede Zeile nennt den Wortlaut, den die Kriterien grepen. Er ist verbindlich; wer ihn
ändert, ändert Kriterium und Tabelle im selben Zug.

| Dokument | Stelle | Danach steht dort |
|---|---|---|
| `docs/60` | Zeile 66 (Ziel 8) | „`tools/list` höchstens **10 000** Zeichen (vorher 8 500; Betreiberentscheidung vom 2026-11-26 zu `docs/70`)" |
| `docs/60` | Zeilen 123, 124 | `LC_ALL=C.UTF-8` vor `awk` und vor `wc` |
| `docs/60` | Zeilen 176, 177 | `LC_ALL=C.UTF-8` vor `awk` und vor `wc` (zweiter Befehl derselben Datei) |
| `docs/60` | Zeile 125 | „**10 000** (Stand 2026-11-26, nach `docs/70`: 8 510 Zeichen in Zeile 5; vor `docs/59`: 8 062)" |
| `docs/60` | Zeile 178 | „⇒ ≤ **10 000** (Grenze seit 2026-11-26, `docs/70`)" |
| `docs/53` | Zeile 117 | „`tools/list` bleibt unter **10 000** Zeichen — Grenze seit 2026-11-26, `docs/70`" |
| `docs/53` | Zeile 122 | derselbe Satz, gleicher Wortlaut: „Grenze seit 2026-11-26, `docs/70`" |
| `docs/54-refusals-englisch.md` | Zeile 83 | „also unter der Grenze von **10 000** Zeichen aus `docs/60`" |
| `docs/59` | Zeile 128 | „⇒ höchstens **10 000** Zeichen (Grenze seit 2026-11-26, `docs/70`)" |
| `docs/59` | Zeile 180 | derselbe Wortlaut wie Zeile 128 |

## Ziel

1. **Jede Kriteriumsstelle nennt 10 000** mit demselben Wortlaut wie die Tabelle.
2. **Jede Messstelle bleibt unangetastet.**
3. **Der Befehl in `docs/60` zählt Zeichen, nicht Bytes.**
4. **Kein Text wird umgeschrieben.** Jede Änderung ist ein datierter Zusatz oder eine
   Zahl.
5. **Jede Stelle hat einen eigenen `grep`.** Keine Sammelzahl, die zwei Stellen
   gegeneinander aufrechnet.

## Der Vertrag

| Feld | Regel |
|---|---|
| Form | Zusatz in der betroffenen Zeile, Datum `2026-11-26`, Grund `docs/70` |
| Wortlaut | aus der Amendments-Tabelle, zeichengleich |
| Alter Wert | bleibt sichtbar, wo er die Geschichte erklärt („vorher 8 500") |
| Sprache | wie die jeweilige Datei: `docs/53`, `docs/54`, `docs/59`, `docs/60` deutsch |
| Reihenfolge | nach `docs/70`, weil die Zahl 10 000 von dort kommt |
| Umfang | nur die neun Zeilen der Tabelle, keine weiteren Stellen |

## Non-goals

- **Kein Code.** `help_contract.rs` gehört vollständig zu `docs/70` (Konstante,
  Doc-Kommentar, Meldung); diese Spec fasst sie nicht an.
- **Keine Umschreibung fremder Specs.** Alte Messungen bleiben stehen.
- **Keine neue Grenze.** 10 000 ist die Zahl aus `docs/70`.
- **Kein Testverhalten.**

## Touch boundary

| Erlaubt | Nicht erlaubt |
|---|---|
| `docs/53-browser-help.md`, `docs/54-refusals-englisch.md`, `docs/59-argumentnamen.md`, `docs/60-klick-nach-text-mcp.md` (nur die Zeilen der Amendments-Tabelle) | alle anderen Specs, `docs/70-beschreibungen-statt-skill.md` |
| `CHANGELOG.md` (unter `[Unreleased]`), `docs/71-grenze-nachziehen.md` (Status, Review, Log) | `docs/README.md`, `PROJECT-STATE.md`, `ROADMAP.md` (Orchestrator) |
| — | `bridge-rs/**`, `extension/**`, `scripts/**`, neue Abhängigkeiten |

## Testing

Es gibt keinen Test; die Prüfung sind die `grep`-Paare unten. Weil eine Sammelzahl
zwei Stellen gegeneinander aufrechnen kann, hat jede Zeile der Amendments-Tabelle
ihren eigenen Befehl.

| Prüfung | Was sie beweist |
|---|---|
| `sed -n '66p;125p;178p' docs/60-klick-nach-text-mcp.md \| grep -cF '10 000'` ⇒ `3` | die drei Kriteriumszeilen tragen die neue Zahl |
| `sed -n '123,124p;176,177p' docs/60-klick-nach-text-mcp.md \| grep -c 'LC_ALL=C.UTF-8'` ⇒ `4` | beide Befehle, beide Pipe-Seiten |
| `grep -c 'Grenze seit 2026-11-26, `docs/70`' docs/53-browser-help.md` ⇒ `2` | beide Zeilen (117, 122) tragen denselben Wortlaut |
| `grep -c '10 000' docs/54-refusals-englisch.md` ⇒ `1` | Zeile 83 ist nachgezogen |
| `grep -c '10 000' docs/59-argumentnamen.md` ⇒ `2` | Zeilen 128 und 180 tragen die neue Zahl |
| `sed -n '117p;122p' docs/53-browser-help.md \| grep -cF '8 500'` ⇒ `0` | beide Kriteriumszeilen verlieren den alten Wert; die Historie in 20, 204, 211 bleibt |

## Acceptance criteria

1. **`docs/60`, zeilengenau:**
   `sed -n '66p;125p;178p' docs/60-klick-nach-text-mcp.md | grep -cF '10 000'` ⇒ `3`, und
   `sed -n '178p' docs/60-klick-nach-text-mcp.md | grep -c 'Grenze seit 2026-11-26'`
   ⇒ `1`.
2. **`docs/60`, Locale an beiden Befehlen:**
   `sed -n '123,124p;176,177p' docs/60-klick-nach-text-mcp.md | grep -c 'LC_ALL=C.UTF-8'` ⇒ `4`.
3. **`docs/53`, beide Zeilen:**

   ```
   sed -n '117p;122p' docs/53-browser-help.md | grep -cF 'Grenze seit 2026-11-26'
   # => 2
   ```
4. **`docs/54`, zeilengenau:**
   `sed -n '83p' docs/54-refusals-englisch.md | grep -cF '10 000'` ⇒ `1`.
5. **`docs/59`, beide Zeilen:**
   `sed -n '128p;180p' docs/59-argumentnamen.md | grep -cF '10 000'` ⇒ `2`.
6. **Nichts veraltetes bleibt als Kriterium:**
   `sed -n '117p;122p' docs/53-browser-help.md | grep -cF '8 500'` ⇒ `0`, und
   `sed -n '66p;125p;178p' docs/60-klick-nach-text-mcp.md | grep -cF '10 000'` ⇒ `3`.
   Die verbleibenden `8 500` in `docs/53` (Zeilen 20, 204, 211) und `docs/60`
   (Zeile 313, ohne Leerzeichen) sind Historie und bleiben.
7. **Kein Test gebrochen:**
   `cargo test --manifest-path bridge-rs/Cargo.toml --test help_contract -- --test-threads=1`
   ⇒ `5 passed`.
8. **Nichts anderes bewegt** (nach dem Stagen, weil diese Spec untracked ist):
   `git diff --cached --stat` nennt genau diese sechs Dateien:
   `docs/53-browser-help.md`, `docs/54-refusals-englisch.md`,
   `docs/59-argumentnamen.md`, `docs/60-klick-nach-text-mcp.md`, `CHANGELOG.md`,
   `docs/71-grenze-nachziehen.md`. `docs/README.md` und `PROJECT-STATE.md` führt der
   Orchestrator und zählen nicht mit.

## Dev plan

1. **`docs/60` an vier Stellen.** Zeile 66, 125 und 178 mit dem Wortlaut der Tabelle,
   Zeilen 123 und 124 mit `LC_ALL=C.UTF-8`. Beweis: Kriterium 1 und 2.
2. **`docs/53` an zwei Stellen.** Zeilen 117 und 122, derselbe Satz. Beweis:
   Kriterium 3 und 6.
3. **`docs/54` und `docs/59`.** Je eine Zahl, in `docs/59` an beiden Stellen.
   Beweis: Kriterium 4 und 5.
4. **Abschluss.** `CHANGELOG.md` unter `[Unreleased]`, `status: active`, Review-Zeile, Log;
   die `docs/README.md`-Statuszeile führt der Orchestrator. Beweis: Kriterium 7 und 8.

Stufe 1 bis 3 sind unabhängig voneinander; keine hängt von einer späteren ab.
`docs/70` muss gebaut sein, bevor Zeile 125 ihre gemessene Zahl 8 510 bekommt.

## Bekannte Lücken

- **`docs/59:180` ist keine Messung, sondern eine Kriteriums-Wiederholung.** Diese Spec
  gibt ihr denselben Wortlaut wie Zeile 128; sauberer wäre, sie zu streichen. Das ist
  eine Entscheidung über eine fremde Spec und bleibt offen.
- **`docs/60:313` schreibt `8500` ohne Leerzeichen** und entgeht damit jedem
  `grep '8 500'`. Es ist Historie und soll so bleiben.
- **Diese Spec ist Textarbeit.** Kein Test hält sie; nur die `grep`-Paare.
- **Sie läuft im selben Commit wie `docs/70`.** `CONTRIBUTING.md` sagt „one spec, one
  increment"; die Ausnahme ist nötig, weil `docs/53` nach `docs/70` sonst vorübergehend
  eine falsche Grenze behauptet. Beide Commits zusammen, `docs/70` zuerst.

## Open questions

**Keine.** Die Erhöhung auf 10 000 hat der Betreiber am 2026-11-26 entschieden; die
Wortlaute stehen in der Amendments-Tabelle.

## Review

| Runde | Datum | Urteil | Kernpunkte |
|---|---|---|---|
| 1 | 2026-11-26 | `nicht bestanden` | Kriterium 7 nutzte `git diff --stat` (untracked Datei erscheint dort nie); die `grep`-Zähler ließen genau die Zeile stehen, die sie fangen sollten; ein Kriterium pinnte einen Wortlaut, den die Spec nicht definierte; der `## Amendments`-Abschnitt fehlte; die Begründung zu `docs/60:313` war falsch |
| 2 | 2026-11-26 | `nicht bestanden` | Kriterium 6 verlangte `8 500` ⇒ `1`, erreichbar nur durch Löschen der Historie (`:204`, `:211` tragen den Wert mit Leerzeichen); Kriterium 6 zweite Hälfte verlangte drei Zeilen mit `10 000`, die Amendments schreiben dort nur 10 000; der locale-lose Befehl in `docs/60:177` fehlte; Kriterien 1, 4 und 5 waren dateiweit und trafen keine Zeile; der Log belegte eine Änderung, die es nicht gab |
| 3 | 2026-11-26 | `bestanden` | Gate offen nach dem Bau: neun Stellen nachgezogen, jedes Kriterium mit Ist-Wert belegt |

## Log

- **2026-11-26, angelegt.** Herausgetrennt aus `docs/70`, nachdem dessen Review in
  Runde 3 die Nachträge an fremden Specs als eigene Gruppe zeigte.
- **2026-11-26, Runde 1 eingearbeitet.** `## Amendments to previous spec docs` mit neun
  verbindlichen Wortlauten; Kriterium 8 prüft `git diff --cached` und nennt sechs
  Dateien; jedes Kriterium hat einen eigenen `grep` statt einer Sammelzahl, die zwei
  Stellen gegeneinander aufrechnet; die falsche Begründung zu `docs/60:313` ist weg;
  `docs/54` steht mit vollem Dateinamen statt als Glob; `docs/60:66` heißt jetzt
  „Ziel 8"; die Locale-Prüfung deckt beide Befehle ab (Zeilen 123, 124, 176, 177).

- **2026-11-26, Runde 2 eingearbeitet.** Jedes Kriterium prüft jetzt zeilengenau
  (`sed -n '<zeile>p' | grep -cF`), nicht dateiweit: `docs/60` Zeilen 66/125/178 ⇒ 3,
  Zeilen 123/124/176/177 mit Locale ⇒ 4, `docs/53` Zeilen 117/122 ohne `8 500` ⇒ 0,
  `docs/54` Zeile 83 ⇒ 1, `docs/59` Zeilen 128/180 ⇒ 2. Die Historie (`docs/53:20`,
  `:204`, `:211`, `docs/60:313`) bleibt ausdrücklich stehen. `docs/60:66` heißt „Ziel
  8", nicht „Kriterium 8". Der zweite locale-lose Befehl (`docs/60:177`) steht in der
  Tabelle. Der Log nennt keine Änderung mehr, die es hier nicht gibt.

- **2026-11-26, gebaut und abgenommen.** Neun Zeilen in vier Specs datiert: `docs/60`
  (66, 123–125, 176–178), `docs/53` (117, 122), `docs/54` (83), `docs/59` (128, 180).
  Die Historie bleibt (`docs/53:20`, `:204`, `:211`, `docs/60:313`). Abnahme:
  `npm run check` 0, `npm test` 584/0, `cargo test` 15 Blöcke, `help_contract`
  5 Fälle, `parity --check` 7/7. Spec auf `active` gesetzt.

- **2026-11-26, Nachtrag.** Der CHANGELOG-Abschnitt heißt `[Unreleased]` statt `[0.8.0]`:
  ein Datum im Abschnitt behauptet eine Veröffentlichung, die es nicht gibt. Kriterium 9
  von `docs/69` grept den neuen Bereich.
