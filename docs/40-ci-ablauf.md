---
description: Der Ablauf in GitHub Actions — Unit-Tests ohne Browser, ein Blackbox-Test auf Windows, der Firefox startet und über MCP eine Seite öffnet, dazu Zip-Bau und Release.
status: active
---

# Der Ablauf in CI

**Befund 2026-11-17:** `.github/workflows/test.yml` läuft `npm run check` und
`npm test` auf Node 22 und 24 — sonst nichts. Kein `cargo`, kein
`scripts/parity.sh`, keine Installation. Seit dem Schnitt (`docs/38`) sagt der
grüne Haken also nichts über die Bridge, die tatsächlich läuft.

Diese Spec teilt die Prüfung in zwei ungleiche Hälften:

- **Unit-Tests** — ohne Browser, bei jedem Push. Sie prüfen den Code.
- **Ein Blackbox-Workflow** — auf Windows, mit echtem Firefox. Er prüft die
  Installation von außen: Firefox starten, die Erweiterung installieren, über MCP
  eine Seite öffnen, und **die Seite selbst** meldet sich beim Testserver.

Dazu kommen Zip-Bau (`docs/39`) und Release-Anhang.

**Was sie nicht tut:** keinen Stil-Lint (STE100 ist Schreibregel, kein
Prüfschritt), keine Windows-Dienst-Prüfung, keinen Cache, keine
Branch-Protection.

## Ziel

- **Job `unit`, browserfrei:** `npm run check`, `npm test`,
  `npm run test:ci`, `cargo test -- --test-threads=1`,
  `cargo clippy --all-targets -- -D warnings` (beide Ziele),
  `scripts/parity.sh --impl rust --check` (7/7) und `--self-test`
  (`7/7 rot wie erwartet`).
- **Job `e2e`, Windows, Blackbox:** die Kette aus `## Der E2E-Ablauf` läuft und
  endet mit dem Beacon-Treffer. Das ist der Beweis „eine Seite wurde in Firefox
  geöffnet".
- **Job `bundle`:** baut die zwei Zips aus `docs/39`, lädt sie als Artefakt.
- **Job `release`:** nur bei Tag `v*`, hängt beide Zips an das GitHub-Release.
- **Lokal nachbaubar:** `scripts/ci-local.sh` fährt `unit` und `bundle`;
  `node scripts/e2e/run.mjs` fährt denselben E2E-Ablauf auf Linux wie CI auf
  Windows.

## Non-goals

- **Kein Stil-Lint.** Kein `ste-lint`, kein `actionlint`-Zwang.
- **Kein Windows-Dienst.** Task Scheduler, Autostart und `GetFileType` bleiben
  Betreiber-Messungen (`docs/38`, Stufe 3).
- **Kein Cache, keine Branch-Protection, kein `act`.**
- **Kein Signieren** der XPI.

## Additional dependencies

| Abhängigkeit | Version | Lizenz | Wo |
|---|---|---|---|
| `web-ext` | **8.9.0** (gepinnt) | MPL-2.0 | nur im `e2e`-Job und in `scripts/e2e/run.mjs`, nicht im Produkt |

`web-ext` startet Firefox und installiert die Erweiterung als **temporäres
Add-on** — derselbe Weg wie „Load Temporary Add-on" in `about:debugging`. Kein
Produktcode hängt daran.

## Der E2E-Ablauf

Der Ablauf ist am 2026-11-17 **lokal gemessen** (Linux, Firefox 152, Bridge auf
18810/18811, Beacon auf 18990):

```
Installed /tmp/e2e/ext as a temporary add-on
extension connected peer=127.0.0.1 protocol=1     (4 s nach dem Start)
open tab=2 url=http://127.0.0.1:18990/page
PING 2026-11-17T15:15:48.205Z                     (die Seite selbst, 4 s später)
```

**Vorbereiten (Schritte 1–2), dann fahren (3–10):**

1. **Binary bereitstellen.** Im `e2e`-Job das Artefakt `bridge-windows` aus dem
   `unit`-Job (`.exe`, `x86_64-pc-windows-gnu`, `--release`), damit geprüft
   wird, was ausgeliefert wird. Pfad: `E2E_BINARY`.
2. **Token erzeugen** (32 Bytes Zufall, 64 Hex) in eine Datei; `BC_TOKEN_FILE`
   darauf zeigen. `E2E_TOKEN_FILE` benennt sie.
3. **Test-Kopie der Erweiterung bauen** (Verzeichnis, **kein Zip**): `extension/`
   kopieren, dann **drei Ersetzungen** — Endpunkt und Token in
   `<kopie>/bridge.js`, der Schalterzustand in `<kopie>/bridge.js` **und**
   `<kopie>/background.js`. Gepatcht und gezählt wird nur die genannte Datei je
   Anker; `options.js` trägt denselben
   Endpunkt-Anker und würde jede Zählung über den ganzen Ordner zur Lüge
   machen — alle mit gezähltem Anker
   (`grep -Fc` ⇒ genau **1** je Datei, sonst `seam moved` und Exit 1 — `grep -F`,
   weil der zweite Anker `[` und `]` enthält und als BRE nie träfe):

   | Anker (vorher) | Datei | nachher |
   |---|---|---|
   | `const DEFAULT_ENDPOINT = "ws://127.0.0.1:8110";` | `bridge.js` | `const DEFAULT_ENDPOINT = "ws://127.0.0.1:18810";` |
   | `      token: asText(stored[TOKEN_KEY]),` | `bridge.js` | `      token: asText(stored[TOKEN_KEY]) \|\| "<token>",` |
   | `const DEFAULT_BRIDGE_ENABLED = false;` | `bridge.js`, `background.js` | `const DEFAULT_BRIDGE_ENABLED = true;` |

   Die zweite Zeile steht in `readSettings`; sie ist eine Ersetzung, keine
   Einfügung — deshalb funktioniert `grep -c` für alle drei. Die ausgelieferte
   Erweiterung bleibt unverändert.

   **Warum `bridge.js` und nicht `background.js`:** seit `docs/42` hält der
   Brücken-Tab den Socket und liest die Einstellungen; `background.js` ist der
   Koordinator, der diesen Tab anlegt und hält, und kennt weder Endpunkt noch
   Token. Ein Anker, der weiter in `background.js` gesucht wird, wäre kein
   Seam-Treffer, sondern ein `seam moved`.

   **Warum der Schalter-Anker zwei Dateien hat:** seit `docs/44` ist die
   Erweiterung von Haus aus **aus**. Beide Seiten brauchen denselben Vorgabewert —
   der Koordinator entscheidet über den Tab, *bevor* es eine Seite gibt, und die
   Seite entscheidet über den Socket. Eine Kopie, in der nur eine der beiden Zeilen
   gepatcht ist, lädt fehlerfrei und bleibt aus; der E2E-Lauf würde eine Minute
   später an `no extension connected` scheitern statt am Seam. Der Zähler verlangt
   deshalb **je Datei genau 1**.
4. **Bridge starten:** `BC_BIND=127.0.0.1:18810 BC_HTTP_PORT=18811
   <binary> --http`, Ausgabe in eine Logdatei, **stdin auf `ignore`** (unter
   POSIX `< /dev/null`). Sonst beendet ein Pipe-EOF die Bridge mit 0
   (`docs/38`, Stufe 2f) und der Test sucht einen Fehler, den es nicht gibt.
5. **Beacon-Server starten** (Node, Port 18990): liefert `/page` mit einem
   eingebetteten `fetch("/ping")` und merkt sich den Treffer.
6. **Firefox starten** mit der Test-Kopie: `npx web-ext@8.9.0 run --source-dir
   <temp> --firefox <pfad> --arg=-headless --no-reload --no-input`. Den Pfad
   bestimmt `E2E_FIREFOX`; ohne ihn `%ProgramFiles%\Mozilla Firefox\firefox.exe`;
   findet sich keins, bricht der Lauf mit `no firefox` ab.
7. **Auf `extension connected`** in der Bridge-Logdatei warten. Deckel 60 s
   (Messwert 4 s, also 15-fach).
8. **Über MCP eine Seite öffnen** — mit Kopfzeile und JSON-RPC-Hülle:

   ```
   POST http://127.0.0.1:18811/mcp
   Authorization: Bearer <token aus Schritt 2>
   {"jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"browser_open_tab","arguments":{"url":"http://127.0.0.1:18990/page"}}}
   ```

9. **Auf den Beacon warten.** Deckel 30 s (Messwert 4 s, also 7-fach). **Das ist
   der Beweis:** die Bridge könnte lügen, die geladene Seite nicht.
10. **Aufräumen per PID** — Bridge, Beacon, `web-ext` **und** das von `web-ext`
    gestartete Firefox, auch im Fehlerfall.

    **Auf Windows** genügt `taskkill /T /PID <web-ext-pid>`: `/T` nimmt den
    ganzen Baum mit, also auch das von `web-ext` gestartete Firefox. **Auf
    POSIX** gibt `web-ext` die Firefox-PID nicht heraus — dort bekommt Firefox
    einen Wrapper: `--firefox <wrapper>` mit einem Zwei-Zeiler, der seine PID in
    eine Datei schreibt und dann `exec` macht (`echo $$ > <pidfile>; exec
    <firefox> "$@"`), und diese PID wird beendet. **Niemals
    `pkill -f`/`taskkill /IM`** — der Betreiber-Dienst hat dieselbe
    Kommandozeile, und genau das hat am 17.11. den Dienst zweimal beendet.

**Warum der Patch und kein Klick:** die Erweiterung liest Endpunkt und Token nur
aus `storage.local`; `about:debugging` lässt sich nicht per Skript bedienen.
`web-ext` installiert die Erweiterung temporär — genau das, was der Knopf tut —
und der Patch ersetzt die zwei Werte, die sonst jemand eintippen müsste.
Gemessen: ohne den Endpunkt-Patch verbindet sie sich nach `ws://127.0.0.1:8110`
und der Lauf scheitert mit `auth failed` am Betreiber-Dienst.

**Ports:** 18810/18811/18990 liegen **außerhalb** der beiden reservierten
Bereiche — 8110/8111 gehören dem laufenden Dienst, 18110–18119 den Test-Suiten
(`bridge-rs/tests/common/mod.rs`).

| Frist | Wert | Herkunft |
|---|---|---|
| Verbinden | 60 s | gewählt, 15 × Messwert (4 s) |
| Beacon | 30 s | gewählt, 7 × Messwert (4 s) |
| bis `extension connected` | 4 s | gemessen (nicht die Startzeit von `web-ext`) |

## Die Jobs

| Job | Läuft auf | Schritte |
|---|---|---|
| `test` | `ubuntu-latest`, Matrix 22/24 | **unverändert**: checkout, setup-node, `npm run check`, `npm test` — ohne Rust |
| `coverage` | `ubuntu-latest`, unabhängig | checkout, Node 22, `npm run test:coverage`; kein `needs:`, kein `npm install` (seit `docs/65`) |
| `unit` | `ubuntu-latest` | checkout, Node (für `parity.sh`), rustup (stable, Ziele `x86_64-unknown-linux-musl` + `x86_64-pc-windows-gnu`, Teil `clippy`), `gcc-mingw-w64-x86-64`; `npm run check`, `npm test`, `npm run test:ci`; `cargo build --release` (beide Ziele), `cargo test -- --test-threads=1`, `clippy -D warnings --all-targets` (beide Ziele), `parity.sh --impl rust --check`, `parity.sh --self-test`; `upload-artifact` `bridge-linux` und `bridge-windows` |
| `e2e` | `windows-latest`, braucht `unit` | checkout, Node, `download-artifact` `bridge-windows` **nach** `bridge-rs/target/x86_64-pc-windows-gnu/release/`, `env: E2E_BINARY: bridge-rs/target/x86_64-pc-windows-gnu/release/browser-control-bridge.exe`, `node scripts/e2e/run.mjs` |
| `bundle` | `ubuntu-latest`, braucht `unit` | checkout, Node, `download-artifact` **beide** (`bridge-linux` → `bridge-rs/target/x86_64-unknown-linux-musl/release/`, `bridge-windows` → `bridge-rs/target/x86_64-pc-windows-gnu/release/`), `scripts/bundle.sh`, `npm run test:bundle`, `upload-artifact` `portable-zips` (beide Zips) |
| `release` | **in `test.yml`**, nur Tag `v*`, braucht `bundle` | `download-artifact` `portable-zips` mit `path: dist`, `merge-multiple: true`; `permissions: contents: write`; `GH_TOKEN: ${{ github.token }}`; `gh release create "$GITHUB_REF_NAME" dist/*.zip --generate-notes --verify-tag
   || gh release upload "$GITHUB_REF_NAME" dist/*.zip --clobber` (`--clobber`
   gehört zu `upload`; der erste Tag-Lauf am 2026-11-17 ist an genau diesem Flag
   gescheitert) |

**`release` steht in derselben Datei wie `bundle`.** `needs:` und
`actions/download-artifact` gelten nur innerhalb einer Workflow-Datei; ein Job in
einer zweiten Datei sieht die Artefakte des ersten nicht. Deshalb: eine Datei,
sechs Jobs, `release` mit `if: startsWith(github.ref, 'refs/tags/v')`.

**`coverage` hängt an nichts** (seit `docs/65`): ein eigener Job, der
`npm run test:coverage` fährt. Ein Abdeckungsrückgang macht die Pull-Request rot,
ohne auf den Rust-Job zu warten; die Schwelle (90 %) steht in `docs/64`.

**Vier Zeilen, die man sonst vergisst — und wo sie gepinnt sind:**

1. **`--release`** überall, wo ein Binary entsteht (`parity.sh` sucht
   `…/release/…`) — gepinnt in `workflow_unitJob_shouldBuildBothTargetsInRelease`.
2. **Artefakt-Upload/-Download** zwischen `unit` → `e2e` und `unit` → `bundle`,
   mit dem Pfad, den `parity.sh` und `bundle.sh` erwarten — gepinnt in
   `workflow_e2eJob_shouldDownloadTheBinary` und
   `workflow_bundleJob_shouldUploadTheZips`.
3. **`--test-threads=1`** beim Rust-Test (echte Bridges binden Ports) — gepinnt
   in `workflow_unitJob_shouldRunTheRustTestsSerially`.
4. **`permissions: contents: write`** im `release`-Job (der Default-Token ist
   `read`, `gh release create` scheitert mit 403) — gepinnt in
   `workflow_releaseJob_shouldAskForWritePermissions`.

## Lokal nachbauen

`scripts/ci-local.sh` fährt `unit` und `bundle`:

```
cargo build --release --target x86_64-unknown-linux-musl / -windows-gnu
npm run check && npm test && npm run test:ci
cargo test -- --test-threads=1
cargo clippy --all-targets -- -D warnings            (beide Ziele)
bash scripts/parity.sh --impl rust --check
bash scripts/parity.sh --self-test
bash scripts/bundle.sh            # vor den Bundle-Tests: sie prüfen die Zips
npm run test:bundle
→ "ci-local: alle Schritte grün"
```

`node scripts/e2e/run.mjs` fährt den Blackbox-Ablauf. Umgebung:

| Variable | Bedeutung |
|---|---|
| `E2E_FIREFOX` | Pfad zu `firefox`; ohne sie sucht das Skript den Windows-Standardpfad |
| `E2E_BINARY` | Pfad zum Bridge-Binary |
| `E2E_TOKEN_FILE` | Pfad der Tokendatei (wird erzeugt, wenn sie fehlt) |
| `E2E_BEACON_MODE` | `ok` (Vorgabe) oder `broken` — `broken` lässt `/ping` mit **500** antworten (Kriterium 2) |

Flags: `--keep` lässt die Prozesse stehen, `--windows` setzt die
Windows-Pfade, `--self-check --source <dir>` prüft nur die drei Anker.

**Alles, was das Skript anlegt, liegt unter `os.tmpdir()`** — Test-Kopie,
Tokendatei und `--keep`-Reste gehören nicht in den Baum, sonst schlägt der
Secret-Grep der Abnahme auf einem echten Token an.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/ci/workflow.test.js` | `workflow_unitJob_shouldBuildBothTargetsInRelease` | `--release` und beide Ziele, gefunden über `run:`-Zeilen |
| `test/ci/workflow.test.js` | `workflow_unitJob_shouldRunTheRustTestsSerially` | `--test-threads=1` steht im `unit`-Job |
| `test/ci/workflow.test.js` | `workflow_e2eJob_shouldRunOnWindowsAndUseTheScript` | `runs-on: windows-latest` und ein `run:` mit `scripts/e2e/run.mjs` |
| `test/ci/workflow.test.js` | `workflow_e2eJob_shouldDownloadTheBinary` | `download-artifact` mit dem Pfad, den der E2E erwartet |
| `test/ci/workflow.test.js` | `workflow_bundleJob_shouldUploadTheZips` | `npm run test:bundle` und `upload-artifact` `portable-zips` |
| `test/ci/workflow.test.js` | `workflow_releaseJob_shouldAskForWritePermissions` | `contents: write`, `merge-multiple`, `gh release create` |
| `test/ci/workflow.test.js` | `workflow_shouldNotContainAStyleLinter` | kein `ste-lint`, kein `actionlint` |
| `test/ci/e2e.test.js` | `e2e_seamPatch_shouldFindBothLines` | der Patch findet in einer Kopie die Endpunkt- und die Token-Zeile und den Schalterzustand in **beiden** Dateien; nach einer Umbenennung meldet er `seam moved` |

Der E2E-Lauf selbst ist **kein** Unit-Fall: er startet Firefox und steht als
Kriterium 1–2 bei den Betreiber-Kriterien. Kriterium 3 (`--self-check`) startet
keinen Browser und ist als `e2e_seamPatch_shouldFindBothLines` gepinnt.

## Acceptance criteria

1. **Der E2E läuft und beweist die Seite.** *(Betreiber, echter Browser;
   `E2E_BINARY` nötig. `E2E_FIREFOX` optional: ohne sie nimmt das Skript unter
   Windows den Standardpfad, unter POSIX `command -v firefox`; findet es keins,
   bricht es mit `no firefox` ab.)* `node scripts/e2e/run.mjs` ⇒
   Exit **0**; im Bridge-Log steht `extension connected` **und** `open tab=`;
   auf stdout steht die Beacon-Zeile `PING <ISO-8601>`. Ohne Beacon-Treffer
   Exit 1.
2. **Der Beacon ist unabhängig.** Ein Lauf mit einem Beacon, der `/ping` mit
   **500** beantwortet (`E2E_BEACON_MODE=broken`), ⇒ Exit 1 und **kein**
   `PING` — obwohl die Bridge `open tab=` meldet. Die Bridge kann den Test also
   nicht bestehen, indem sie nur „ok" antwortet.
3. **Der Seam ist gepinnt.** `node scripts/e2e/run.mjs --self-check --source
   extension` ⇒ Exit 0 und `endpoint=1 token=1 state=1`; auf einer **Kopie** mit `sed -i
   's/DEFAULT_ENDPOINT/ENDPOINT/g' <kopie>/bridge.js` ⇒ Exit 1 mit
   `seam moved`. Die getrackte Datei bleibt unangetastet: `git status --porcelain
   extension/` liefert vor und nach dem Build **dieselbe** Ausgabe.
   *(Amendment 2026-11-18:* `test -z "$(git status --porcelain extension/)"` war
   am Abnahmetag grün, prüft aber auch, dass der Baum *committet* ist — und ein
   Inkrement wird geprüft, solange seine Dateien noch nicht committet sind. Die
   Eigenschaft, um die es geht, ist „der Build schreibt nichts in den Baum".)*
4. **Unit und E2E sind getrennt.** `grep -c 'scripts/e2e/run.mjs'
   .github/workflows/test.yml` ⇒ **1**; `grep -c 'runs-on: windows-latest'` ⇒
   **1**; `awk '/^  unit:/{u=1;next} u&&/^  [a-z0-9]+:/{exit} u'
   .github/workflows/test.yml | grep -c 'firefox'` ⇒ **0** (der Bereich endet
   nicht auf seiner eigenen Startzeile).
5. **Kein Stil-Lint in der CI.** `grep -rlE 'ste-lint|actionlint'
   .github/workflows/; echo $?` ⇒ **1** (keine Datei).
6. **Der Unit-Job prüft den Code** — entschieden über die Testfälle, nicht über
   `grep`-Zählung: `npm run test:ci` ⇒ `# fail 0`, und darin sind
   `workflow_unitJob_shouldBuildBothTargetsInRelease` und
   `workflow_bundleJob_shouldUploadTheZips` grün.
7. **Der Release hängt die Zips an** — in **derselben** Workflow-Datei wie
   `bundle` (sonst sieht er die Artefakte nicht): `grep -c 'gh release create'
   .github/workflows/test.yml` ⇒ **1**; `grep -c 'gh release upload'
   .github/workflows/test.yml` ⇒ **1**; `grep -c 'contents: write'` ⇒ **1**;
   `grep -c 'merge-multiple: true'` ⇒ **1**; `test -f
   .github/workflows/release.yml` ⇒ **nicht vorhanden** (Exit 1).
8. **Der lokale Nachbau ist grün.** `bash scripts/ci-local.sh; echo $?` ⇒ Exit
   **0**, letzte Zeile `ci-local: alle Schritte grün`.
9. **Beide Paritätsläufe stehen.** `bash scripts/parity.sh --impl rust --check`
   ⇒ `7/7 wie erwartet`; `--self-test` ⇒ `7/7 rot wie erwartet`.
10. **Der Rest bleibt grün.** `npm run check` ⇒ 0; Secret-Grep beidseitig Exit 1.

## Dev plan

**Stufe 1 — `scripts/e2e/run.mjs` und der lokale Beweis**

Dateien: `scripts/e2e/run.mjs`, `scripts/e2e/beacon.mjs`,
`scripts/e2e/build-test-extension.mjs` (Kopie + zwei gezählte Patches),
`test/ci/e2e.test.js`.

Das Skript fährt die zehn Schritte, endet mit der Beacon-Zeile oder einem
benannten Fehler, räumt per PID auf (`taskkill /T` auf Windows).

Beweis: Kriterien 1–3, auf Linux gemessen (der Ablauf oben ist der Messwert).

**Stufe 2 — Job `unit`, `scripts/ci-local.sh`, `test:ci`**

Dateien: `.github/workflows/test.yml` (Job `unit`), `scripts/ci-local.sh`,
`package.json` (`"test:ci": "node --test test/ci/*.test.js"`),
`test/ci/workflow.test.js` (die Fälle zum `unit`-Job: `--release`,
`--test-threads=1`, kein Stil-Lint), `CONTRIBUTING.md` (Abnahme um
`npm run test:bundle`, `npm run test:ci`, `cargo test` ergänzt).

Beweis: Kriterien 5, 6, 8, 9.

**Stufe 3 — Job `e2e`**

Dateien: `.github/workflows/test.yml` (Job `e2e`), `test/ci/workflow.test.js`
(die E2E-Fälle: `runs-on: windows-latest`, `run: node scripts/e2e/run.mjs`,
Artefakt-Download).

Beweis: Kriterium 4; `npm run test:ci` ⇒ `# fail 0`.

**Stufe 4 — `bundle` und `release`**

Dateien: `.github/workflows/test.yml` (Jobs `bundle` und `release`; **keine**
zweite Workflow-Datei), `test/ci/workflow.test.js`
(`workflow_bundleJob_shouldUploadTheZips`).

Beweis: Kriterium 7; der erste Push zeigt den `e2e`-Lauf auf Windows.

## Bekannte Lücken

- **Der Windows-E2E ist hier nicht gelaufen** — gemessen ist der identische
  Ablauf auf Linux (Firefox 152). Der erste `windows-latest`-Lauf ist der
  Beweis; deshalb hat das Skript `--windows` und benannte Fehler.
- **Der Seam ist ein Textpatch** auf zwei Zeilen in einer Kopie. Er ist gezählt
  und bricht laut, aber er ist kein Vertrag: ändert jemand die Zeile, muss der
  Patch nach.
- **Kein Signieren, kein Dienst:** der E2E prüft den Handstart, nicht den
  Autostart.

## Open questions

**Keine.** Entschieden am 2026-11-17: Test-Kopie mit eingebautem Token (kein
Managed Storage, kein Klick auf die Optionsseite), `web-ext` statt
`geckodriver`, kein Stil-Lint, Unit und E2E getrennt.

## Review

### Runde 1 — 2026-11-17, `grizzled-senior-dev`: 🔧, Blocker dabei

Sieben Blocker: fehlender Pflichtabschnitt für `web-ext`; zwei Definitionen des
`unit`-Jobs (Ziel vs. Tabelle); „Job `node` unverändert", obwohl der Job `test`
heißt; das Negativkriterium zum Seam ohne Kommando und auf einer getrackten
Datei; Kriterium 2 prüfte den Token-Pfad statt der Beacon-Unabhängigkeit;
`npm run test:ci` lief nirgends; Jobnamen und Artefaktpfade nicht festgelegt.

### Runde 2 — 2026-11-17, `grizzled-senior-dev`: 🔧, Blocker dabei

Fünf Blocker: `bundle` lud nur ein Binary; `release` stand in einer zweiten
Workflow-Datei, wo `needs`/`download-artifact` nicht greifen; `unit` führte
`test:bundle` vor dem Build; Stufe 2 hing an Stufe 3; der zweite Seam-Anker war
als Einfügung beschrieben.

### Runde 3 — 2026-11-17, `grizzled-senior-dev`: 🔧, keine Blocker mehr

Sieben Einzeiler: `test:bundle` stand noch im `## Ziel` des `unit`-Jobs;
`ci-local.sh` baute die Zips nach den Bundle-Tests; der Anker `stored[TOKEN_KEY]`
braucht `grep -F`; Firefox lässt sich ohne Wrapper-PID nicht aufräumen; die
Rundenzählung im `## Review` fehlte; „getrackte Datei unangetastet" ohne
Kommando; die 4 s waren falsch zugeordnet.

### Runde 4 — steht aus

## Log

- **2026-11-18, dritter Seam-Anker (`docs/44`):** der E2E baut eine Erweiterung,
  die von Haus aus **aus** ist. Der Anker `const DEFAULT_BRIDGE_ENABLED = false;`
  steht deshalb in **zwei** Dateien — `bridge.js` (die Seite, die nicht wählen
  darf) und `background.js` (der Koordinator, der den Tab nicht anlegen darf) —,
  und `checkSeams` verlangt **je Datei genau 1**. Die Ausgabe von `--self-check`
  ist `endpoint=1 token=1 state=1`. Nebenbei: `test/ci/e2e.test.js` vergleicht den
  `git status` vor und nach dem Build statt mit dem leeren String (Amendment in
  Kriterium 3).

- **2026-11-17, umgesetzt (Stufen 1–4):** `scripts/e2e/{run,beacon,build-test-extension}.mjs`,
  `test/ci/{workflow,e2e}.test.js`, `npm run test:ci`, `scripts/ci-local.sh`, die fünf
  Jobs in `.github/workflows/test.yml` (seit `docs/65` sechs), `CONTRIBUTING.md` (Abnahme), `docs/README.md`
  und `docs/PROJECT-STATE.md`. **Lokal gemessen** (Linux, Firefox 152, Release-Binary
  `x86_64-unknown-linux-musl`): `run.mjs` ⇒ Exit 0 mit `extension connected`, `open tab=2`,
  `PING 2026-11-17T16:10:38.636Z`; `E2E_BEACON_MODE=broken` ⇒ Exit 1, keine PING-Zeile,
  im Bridge-Log aber `open tab=2` (Kriterium 2); `--only-bridge` ⇒ Exit 0 ohne Firefox;
  `--self-check` ⇒ Exit 0; `npm run test:ci` ⇒ 11 Fälle, `# fail 0`;
  `bash scripts/ci-local.sh` ⇒ Exit 0. **Der Windows-Lauf bleibt ungemessen** — er ist
  der erste `windows-latest`-Lauf. `test/ci/e2e.test.js` trägt über den Seam-Fall hinaus
  zwei Beacon-Fälle (204 mit Treffer, 500 im `broken`-Modus), weil Kriterium 2 sonst nur
  über den Betreiber-Lauf geprüft wäre.
- **2026-11-17, Betreiberfrage:** „können wir den Ablauf in git actions auch
  nachbauen und testen?" — ja; der Befund dazu: CI prüft die Bridge heute gar
  nicht.
- **2026-11-17, Betreiberentscheid:** CI soll die **Installation** prüfen —
  Windows, Firefox, Erweiterung installieren, über MCP eine Seite öffnen; Ziel
  ist der Nachweis, dass die Seite in Firefox geöffnet wurde. Der Rest sind
  Unit-Tests und läuft separat.
- **2026-11-17, Betreiberentscheid:** kein automatischer STE100-Lint.
- **2026-11-17, Messung:** der Ablauf ist lokal gelaufen (Linux, Firefox 152):
  `extension connected` nach 4 s, `open tab=2`, Beacon-Treffer 4 s später.
- **2026-11-17, Abspaltung:** dieser Abschnitt war Teil von `docs/39`; der
  Spec-Review hat ihn dort als zweites Inkrement beanstandet (M8).
- **Runde 3 — übernommen:** `test:bundle` aus dem `## Ziel` des `unit`-Jobs
  gestrichen; `ci-local.sh` baut die Zips **vor** den Bundle-Tests; `grep -Fc`
  für beide Anker; Firefox über einen PID-Wrapper aufgeräumt; Runden 2 und 3 im
  `## Review` eingetragen; `git status --porcelain extension/` als Kommando;
  4 s als „bis `extension connected`" benannt.
- **Runde 2 — übernommen:** `bundle` lädt **beide** Binaries (nach
  `bridge-rs/target/<ziel>/release/`); `release` ist ein Job in **derselben**
  Datei (`needs` und `download-artifact` gelten nicht über Dateigrenzen); 
  `npm run test:bundle` nur noch im `bundle`-Job; `test/ci` samt Workflow-Fällen
  nach Stufe 2 gezogen (Stufe 2 hing an Stufe 3); die zwei Seam-Anker namentlich
  benannt (beide sind Ersetzungen, keine Einfügung); Test-Kopie und `--keep`
  unter `os.tmpdir()`; `E2E_BEACON_MODE` in der Umgebungsliste; Kriterium 1
  trennt stdout und Bridge-Log; `stdin` auf `ignore`; Kriterium 4 mit drei
  Kommandos; Kriterium 1–2 als Betreiber-Kriterien (3 ist gepinnt); das
  `bundle`-Kriterium namentlich; `test:ci`-Rumpf hingeschrieben.
- **Runde 1 — übernommen:** `## Additional dependencies` mit `web-ext 8.9.0`
  (MPL-2.0, nur E2E); eine Definition des `unit`-Jobs (Tabelle und Ziel gleich);
  Jobname `test` bleibt (keine Umbenennung, Branch-Protection ist Non-Goal);
  Seam-Negativfall mit Kommando auf einer Kopie; Kriterium 2 prüft jetzt die
  Beacon-Unabhängigkeit (`E2E_BEACON_MODE=broken` ⇒ 500); `npm run test:ci` im
  `unit`-Job, in `ci-local.sh` und in `CONTRIBUTING.md`; Artefaktnamen
  `bridge-linux`/`bridge-windows`/`portable-zips` samt `path:` und
  `merge-multiple: true`; Firefox-Pfad als eigener Schritt; Aufräumen mit
  `taskkill /T /PID` für den Prozessbaum; „Test-XPI" heißt jetzt „Test-Kopie
  (Verzeichnis)"; Schritt 8 mit Kopfzeile und JSON-RPC-Hülle; Fristen mit
  Herkunft; Kriterium für `ci-local.sh` und für den `bundle`-Job; Linter-Check
  über `grep -rl`; `--self-test`-Zeile als eigenes Kriterium gepinnt;
  Portbegründung nennt 18110–18119.
