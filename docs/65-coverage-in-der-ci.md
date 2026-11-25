---
description: Die Zeilenabdeckung der Erweiterung läuft in der CI als eigener Job — npm run test:coverage aus docs/64, mit der Schwelle 90 Prozent und ohne neue Abhängigkeit.
status: proposed
---

# Coverage in der CI

## Anlass

`docs/64` hat `npm run test:coverage` gebaut: 92,2 % Zeilen über 7 604 von 8 250
Zeilen, Schwelle 90 %, Exit 1 darunter. Der Befehl läuft nur, wenn jemand ihn
aufruft. Ein Rückschritt fällt deshalb erst auf, wenn der Betreiber fragt.

Die CI hat heute fünf Jobs (`docs/40`): `test`, `unit`, `e2e`, `bundle`, `release`.
Keiner misst Abdeckung.

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
5. **Ein Fall in `test/ci/workflow.test.js`** pinnt den Job: Name, Runner, Befehl
   und Node-Version. Ohne ihn kann jemand den Job entfernen, und `npm run test:ci`
   bleibt grün.

## Der Vertrag

| Feld | Regel |
|---|---|
| Jobname | `coverage` |
| Runner | `ubuntu-latest` |
| Node | 22 über `actions/setup-node@v4` |
| Schritte | `actions/checkout@v4`, `actions/setup-node@v4`, `npm run test:coverage` |
| `needs` | keines |
| Schwelle | die Standard­schwelle aus `docs/64` (90 %); kein `--min` in der YAML |
| Dauer | ein Lauf der Suite, gemessen rund 10 s lokal; auf dem Runner mehr, aber unter zwei Minuten |

## Non-goals

- **Keine Rust-Abdeckung.** `cargo-llvm-cov` und `llvm-tools-preview` fehlen und
  brauchen eine Installation aus dem Netz (`docs/64`, `## Bekannte Lücken`).
- **Kein Upload, kein Badge, kein Artefakt.** Die Tabelle steht im Job-Log; mehr
  braucht niemand.
- **Keine Schwelle je Datei**, keine Änderung an `docs/64` selbst.
- **Kein `needs:`** — auch nicht auf `test`, obwohl beide dieselbe Suite fahren:
  zwei unabhängige Jobs sind billiger als eine Kette, die auf den langsameren wartet.

## Amendments to previous spec docs

- **`docs/40-ci-ablauf.md`**: sechs Jobs statt fünf; der neue Job `coverage` mit
  seinem Zweck („ein Rückgang wird rot, bevor jemand fragt") und der Notiz, dass er
  an nichts hängt.

Nach der Umsetzung wird dieser Abschnitt entfernt.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/ci/workflow.test.js` | `workflow_coverageJob_shouldRunTheCoverageCommand` | der Job existiert, läuft auf `ubuntu-latest`, ruft `npm run test:coverage` und nutzt Node 22 |
| `test/ci/workflow.test.js` | `workflow_coverageJob_shouldNotDependOnAnotherJob` | kein `needs:` im Block — der Job bleibt unabhängig |
| `test/ci/workflow.test.js` | `workflow_shouldNotContainAStyleLinter` (bestehend) | bleibt grün; die YAML enthält keinen Linter |

## Acceptance criteria

1. **Der Job läuft den Befehl.** `grep -n 'test:coverage' .github/workflows/test.yml`
   ⇒ 1 Treffer, im Block `coverage`.
2. **Der Fall pinnt ihn.** `npm run test:ci; echo $?` ⇒ 0, und
   `grep -cE '^ok [0-9]+ - workflow_coverageJob_'` ⇒ 2.
3. **Kein `needs:`.** Der Block `coverage` enthält keine Zeile `needs:`
   (Beleg: der Fall aus Kriterium 2).
4. **Alles andere grün.** `npm test; echo $?` ⇒ 0 mit `^# fail 0`,
   `npm run check; echo $?` ⇒ 0.
5. **Live, Betreiber.** Ein Push auf einen Test-Branch lässt den Job `coverage`
   laufen, und sein Log enthält die Tabelle mit 92,2 %.

## Dev plan

Entwurf des Spec-Autors. Nach `CONTRIBUTING.md`, Schritt 3, gehört der Dev-Plan zu
einem zweiten Autor.

**Stufe 1 — der Job (`.github/workflows/test.yml`)**

Ein Block `coverage` zwischen `test` und `unit`, mit den drei Schritten aus dem
Vertrag und einem Kommentar, der den Zweck nennt.

Beweis: Kriterien 1, 3.

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

### Runde 1 — steht aus

Nach `CONTRIBUTING.md`, Schritt 4, öffnet erst ein `✅ Ship it` die Umsetzung.

## Log

- **2026-11-23, angelegt.** Aus der Wahl des Betreibers zwischen Rust-Abdeckung und
  CI-Abhängigkeit („B — Coverage in die CI").
