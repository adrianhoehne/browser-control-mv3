---
description: Die Zeilenabdeckung der Erweiterung läuft in der CI als eigener Job — npm run test:coverage aus docs/64, mit der Schwelle 90 Prozent und ohne neue Abhängigkeit.
status: active
---

# Coverage in der CI

## Anlass

`docs/64` hat `npm run test:coverage` gebaut: 92,2 % Zeilen über 7 604 von 8 250
Zeilen, Schwelle 90 %, Exit 1 darunter. Der Befehl läuft nur, wenn jemand ihn
aufruft. Ein Rückschritt fällt deshalb erst auf, wenn der Betreiber fragt.

Die CI hatte vor diesem Inkrement fünf Jobs (`docs/40`): `test`, `unit`, `e2e`, `bundle`,
`release`. Keiner misst Abdeckung.

## Ziel

1. **Ein eigener Job `coverage`** in `.github/workflows/test.yml`, der
   `npm run test:coverage` ausführt.
2. **Er hängt an nichts** und blockiert nichts: kein `needs:`, keine Abhängigkeit
   von `unit`. Ein Abdeckungsrückgang macht die Pull-Request rot, ohne den
   Rust-Job zu verlangsamen.
3. **Die Schwelle bleibt 90 %**, wie `docs/64` sie setzt. Der Job ruft den Befehl
   ohne `--min` auf.
4. **Node 22**, wie der `unit`-Job. Kein `npm install`, weil das Projekt keine
   Abhängigkeiten hat.
5. **Zwei Fälle in `test/ci/workflow.test.js`** pinnen den Job: Name, Runner, Befehl,
   Node-Version und das Fehlen von `needs:`. Ohne sie kann jemand den Job entfernen,
   und `npm run test:ci` bleibt grün.

## Der Vertrag

| Feld | Regel |
|---|---|
| Jobname | `coverage` |
| Runner | `ubuntu-latest` |
| Node | 22 über `actions/setup-node@v4` |
| Schritte | `actions/checkout@v4`, `actions/setup-node@v4`, `npm run test:coverage`; der Checkout ist **nicht** gepinnt — ohne ihn fällt der Job mit offensichtlichem Fehler um |
| `needs` | keines |
| Schwelle | die Standard­schwelle aus `docs/64` (90 %); kein `--min` in der YAML |
| Dauer | 8,25 s lokal am 2026-11-23 (`/usr/bin/time -f '%e s' npm run test:coverage`); auf dem Runner mehr, aber unter zwei Minuten |

## Non-goals

- **Keine Rust-Abdeckung.** `cargo-llvm-cov` und `llvm-tools-preview` fehlen und
  brauchen eine Installation aus dem Netz (`docs/64`, `## Bekannte Lücken`).
- **Kein Upload, kein Badge, kein Artefakt.** Die Tabelle steht im Job-Log; mehr
  braucht niemand.
- **Keine Schwelle je Datei**, keine Änderung an `docs/64` selbst.
- **Kein `needs:`** — auch nicht auf `test`, obwohl beide dieselbe Suite fahren:
  zwei unabhängige Jobs sind billiger als eine Kette, die auf den langsameren wartet.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/ci/workflow.test.js` | `workflow_coverageJob_shouldRunTheCoverageCommand` | der Job existiert, läuft auf `ubuntu-latest`, ruft `npm run test:coverage` und nutzt Node 22 |
| `test/ci/workflow.test.js` | `workflow_coverageJob_shouldNotDependOnAnotherJob` | kein `needs:` im Block — der Job bleibt unabhängig |
| `test/ci/workflow.test.js` | `workflow_shouldNotContainAStyleLinter` (bestehend) | bleibt grün; die YAML enthält keinen Linter |

## Acceptance criteria

1. **Der Job läuft den Befehl.** `grep -n 'test:coverage' .github/workflows/test.yml`
   ⇒ 1 Treffer, und er steht im Block `coverage` (Zeile 27-35).
2. **Die Fälle pinnen ihn.** `npm run test:ci; echo $?` ⇒ 0, und
   `npm run test:ci 2>&1 | grep -cE '^ok [0-9]+ - workflow_coverageJob_'` ⇒ 2. Die
   Pipe ist Pflicht: auf einem TTY druckt Node `✔` statt TAP-Zeilen.
3. **Kein `needs:`.** `awk '/^  coverage:/{c=1;next} c&&/^  [a-z0-9-]+:/{exit} c'
   .github/workflows/test.yml | grep -c 'needs:'` ⇒ 0.
4. **Alles andere grün.** `npm test; echo $?` ⇒ 0 mit `^# fail 0` und
   `^# cancelled 0`, `npm run check; echo $?` ⇒ 0.
5. **Live, Betreiber.** Ein Push auf `main`/`master` oder ein Pull Request lässt den
   Job `coverage` laufen — die YAML triggert nur dort. Sein Log enthält die Tabelle je
   Datei, eine Summenzeile **über 90 %** und Exit 0. Keine feste Zahl: die
   V8-Version des Runners kann Zeilen anders zuordnen (siehe `## Bekannte Lücken`).

## Dev plan

Entwurf des Spec-Autors. Nach `CONTRIBUTING.md`, Schritt 3, gehört der Dev-Plan zu
einem zweiten Autor.

**Stufe 1 — der Job (`.github/workflows/test.yml`)**

Ein Block `coverage` zwischen `test` und `unit`, mit den drei Schritten aus dem
Vertrag und einem Kommentar, der den Zweck nennt.

Beweis: Kriterium 1.

**Stufe 2 — der Fall (`test/ci/workflow.test.js`)**

Zwei Fälle in der Form der bestehenden: `jobBlock("coverage")` lesen,
`runCommands` prüfen, `runs-on` und `node-version` als Regex, und ein Fall, der
`/^\s{2,}needs:/m` im Block ausschließt.

Beweis: Kriterium 2.

**Stufe 3 — die Doku**

`docs/40` (die Job-Tabelle und der Abschnitt zum Ablauf), `docs/README.md`
(Status), `docs/PROJECT-STATE.md`; der Amendments-Abschnitt entfällt, die Spec
wird `active`.

Beweis: `npm run check` ⇒ 0 und `grep -c 'coverage' docs/40-ci-ablauf.md` ≥ 1.

## Touch boundary

| erlaubt | nicht |
|---|---|
| `.github/workflows/test.yml` (ein neuer Job), `test/ci/workflow.test.js` (zwei Fälle) | `scripts/coverage.mjs`, `test/coverage.test.js`, `package.json` |
| `docs/40-ci-ablauf.md`, `docs/README.md`, `docs/PROJECT-STATE.md` | `extension/**`, `bridge-rs/**`, `scripts/parity/**` |

## Bekannte Lücken

- **Die Schwelle 90 % ist auf diesem Rechner gemessen.** Auf dem CI-Runner kann die
  V8-Version Zeilen anders zuordnen; der Abstand zur Schwelle beträgt 2,2 Punkte
  (2026-11-23).
- **Ein Abdeckungsrückgang blockiert nur die PR**, nicht den Merge, solange die
  Branch-Regel den Job nicht verlangt. Das ist eine Einstellung im Repo, keine
  Zeile Code (2026-11-23).
- **Der Job läuft die Suite ein zweites Mal.** `test` fährt sie schon; die
  Doppelung ist der Preis für die Unabhängigkeit (2026-11-23).

## Open questions

**Keine.** Der Betreiber hat am 2026-11-23 „Coverage in die CI" gewählt.

## Review

### Runde 1 — `🔧 Fix these` (2026-11-23)

Der Gate hat die Spec **nach** dem Bau geprüft (`CONTRIBUTING.md`, Schritt 4 nach
Schritt 5 — Abweichung, siehe `## Log`). Fünf Blocker: Kriterium 5 verlangte einen
Push auf einen Test-Branch, den die YAML nicht triggert; es verlangte genau 92,2 %,
während die Spec selbst vor der V8-Version des Runners warnt; Stufe 1 bewies sich mit
Kriterium 3, das seinerseits auf Stufe 2 zeigte; der `grep` auf `^ok` las nicht die
Ausgabe des Laufs; und die Dauer „rund 10 s" hatte keine Messung. Alle fünf sind
eingearbeitet, dazu drei Kleinigkeiten (fünf/sechs Jobs, „ein Fall" statt zwei,
`^# cancelled 0`).

## Log

- **2026-11-23, angelegt.** Aus der Wahl des Betreibers zwischen Rust-Abdeckung und
  CI-Abhängigkeit („B — Coverage in die CI").

- **2026-11-23, Stufe 3 nachgezogen, Spec `active`.** `docs/40` nennt sechs Jobs,
  trägt den neuen Job in der Tabelle und sagt, dass er an nichts hängt; die ältere
  Zeile „die fünf Jobs" ist auf „seit `docs/65` sechs" gezogen. `docs/README.md`
  steht auf `active`. Der Reviewer hat die zwei Workflow-Fälle gegen sechs
  Mutationen geprüft (Befehl entfernt, Node 24, `windows-latest`, auskommentiert,
  `needs: unit`, Job gelöscht) — jedes Mal rot.

- **2026-11-23, Stufe 3 und Review nachgezogen.** Zwei Abweichungen vom Ablauf,
  beide bewusst: die **Absprache über Ziel und Kriterien** (Schritt 2) fiel in die
  Auswahl der Variante „B — Coverage in die CI", und die **Spec-Runde** (Schritt 4)
  lief **nach** dem Bau. Beides ist hiermit festgehalten, statt es zu verschweigen.
  Der Gate-Befund (fünf Blocker) steht in `## Review`; alle fünf sind eingearbeitet.
