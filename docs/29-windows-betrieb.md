---
description: `npm run check` prüft die Syntax mit einem Node-Skript statt mit `find` und `xargs` — die Abnahme läuft damit auch dort, wo keine GNU-Werkzeuge installiert sind.
status: active
---

# Windows-Betrieb, Teil 1a: die Abnahme ohne Shell-Werkzeuge

Der Betreiber will pi, die Bridge und Firefox auf **einem Windows-Rechner**. Vor
jedem Verhalten steht die Abnahme aus `CONTRIBUTING.md`: `npm test`, `npm run check`,
Secret-grep. Die mittlere Zeile ruft heute `find … | xargs …` (`package.json:12`) —
in `cmd.exe` gibt es beides nicht, und `find` ist dort ein anderes Programm
(`FIND.EXE`). Diese Spec macht die Prüfung plattformfest und **sonst nichts**.

**Gebaut und abgenommen am 2026-11-06.** `npm run check` ruft `node
scripts/check.mjs`; der Befehl meldet `checked 28 files` und endet mit 0, die
Abnahme steht bei **658 Tests**, `# fail 0`, `# cancelled 0`, `# skipped 0`. Die
sechs Kriterien sind einzeln geprüft, das Prüfskript läuft in 1,4 s (am 2026-11-23
dreimal gemessen mit `/usr/bin/time -f "%e" npm run check`: 1,40, 1,41, 1,41; die alte
`find`/`xargs`-Kette brauchte 2,8 s). **Die Zahl ist ein Messwert und wandert:** nach
dem Schnitt von `docs/38` (Node-Bridge gelöscht, Stufe 4b, 2026-11-17) meldet
derselbe Befehl `checked 14 files` — 19 der 33 Dateien waren Bridge-Code und
Bridge-Tests.

## Ziel

- **Eine Node-Datei statt einer Shell-Kette.** Neu `scripts/check.mjs`: keine
  Abhängigkeit, kein Prozessstart außer `process.execPath`, kein `find`, kein
  `xargs`.
- **Derselbe Befehl.** `package.json` behält den Namen `check`; getippt wird
  weiterhin `npm run check`, auf jeder Plattform.
- **Dieselbe Abdeckung.** Alle `*.js` und `*.mjs` im Baum, `.git` und
  `node_modules` an jeder Tiefe übersprungen. Symlinks werden nicht verfolgt
  (`Dirent.isFile()` ist für einen Symlink falsch) — dasselbe Verhalten wie
  `find` ohne `-L`, also kein Rückschritt.
- **Zwei Zeilenformen, eine Regel.** Erfolg: `checked 1 file` bzw.
  `checked <n> files`. Fehler: nach jeder kaputten Datei
  `<relpath>: <die stderr-Zeile, die auf SyntaxError paßt>`, am Ende
  `checked 1 file, <m> failed` bzw. `checked <n> files, <m> failed`. Singular nur
  bei genau 1, in beiden Zeilen.
- **Die Ströme sind festgelegt.** Erfolgszeile auf **stdout**; Diagnose und
  Fehlerzusammenfassung auf **stderr**. Ein Aufruf, der `2>/dev/null` schreibt,
  verliert damit keine Erfolgsmeldung.
- **„Nichts gefunden" ist sichtbar, nicht still.** Die Zahl steht in der Ausgabe:
  `checked 0 files` mit Exit 0 ist eine Aussage, die man lesen kann — rot ist sie
  nicht, und das behauptet diese Spec auch nicht.
- **Keine Zeile in `CONTRIBUTING.md` ändert sich.** Der Abnahmeblock bleibt wörtlich; er
  beschreibt weiterhin drei Befehle, deren mittlerer jetzt intern anders arbeitet.

## Non-goals

- **Keine Änderung an `bridge/*` und `extension/*`.** Diese Spec faßt keinen
  Produktivcode an.
- **Kein Ersatz für `npm test`** und keine Änderung an der Testsuite.
- **Kein Linter, kein Formatter, keine neue Abhängigkeit** — weder `dependencies`
  noch `devDependencies`, kein `eslint`, kein `prettier`.
- **Kein Windows-Abschnitt in `INSTALL.md`** — der gehört zu Spec 30 und Teil 2.
- **Der Prozess, die Konsole und das geordnete Ende sind nicht hier**, sondern in
  `docs/30-prozess-und-konsole.md`.

## Wo die Änderung sitzt

| Datei | Heute | Danach |
|---|---|---|
| `package.json` | `"check": "find . -name .git -prune -o -name node_modules -prune -o -type f \( -name '*.js' -o -name '*.mjs' \) -print0 \| xargs -0 -r -n 1 node --check"` (`:12`) | `"check": "node scripts/check.mjs"`; alle anderen Skripte unverändert |
| `scripts/check.mjs` | gibt es nicht | neu: `collectFiles(root)` geht den Baum mit `fs.readdirSync(dir, { withFileTypes: true })`, überspringt `.git` und `node_modules`, nimmt nur `entry.isFile()`, sammelt **relative** Pfade und sortiert; je Datei `spawnSync(process.execPath, ["--check", path.join(root, rel)])` — der Pfad wird gegen die Wurzel aufgelöst, nicht gegen `cwd`; Wurzel `path.resolve(import.meta.dirname, "..")`, durch ein Positionsargument überschreibbar (das braucht der Test) |
| `test/check.test.js` | gibt es nicht | neu, sechs Fälle (siehe `## Testing`); die siebte Zeile dort prüft den Abnahmebefehl selbst |

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/check.test.js` | der echte Repo-Baum: Exit 0, die Ausgabe ist **eine** Zeile, die auf `/^checked \d+ files?$/` paßt; die Zahl ist gleich der Zahl eines eigenen `readdir`-Laufs **im Test**; `scripts/check.mjs` und `test/check.test.js` stehen in der geprüften Pfadmenge; die Zeile kommt auf **stdout**, stderr ist leer | das Skript zählt, was es prüft; der eigene Lauf allein würde zwei gleiche Fehler nicht bemerken |
| `test/check.test.js` | `broken.js` mit `const = ;` ⇒ Exit 1, der Bericht nennt `broken.js` **und** eine Zeile mit `SyntaxError`, die Zusammenfassung steht auf **stderr** und lautet `checked 1 file, 1 failed`, auf stdout steht nichts | ein Syntaxfehler wird rot, benannt und in der richtigen Zeilenform zusammengefaßt |
| `test/check.test.js` | sauberer Temp-Baum mit je einem `ok.js` und `ok.mjs` ⇒ Exit 0, `checked 2 files` | beide Endungen werden geprüft |
| `test/check.test.js` | genau eine saubere Datei ⇒ `checked 1 file` (Singular, Erfolgszeile) | die Singularregel ist gepinnt |
| `test/check.test.js` | kaputte Dateien **verschachtelt** unter `a/.git/x.js` und `a/b/node_modules/y.js`, saubere an der Wurzel ⇒ Exit 0, `checked 1 file`; ein **leerer** Temp-Baum ⇒ `checked 0 files`, Exit 0 | die Ausschlüsse greifen an jeder Tiefe, und „nichts gefunden" ist eine sichtbare Aussage, kein stilles Grün im Sinne von Erfolg |
| `test/check.test.js` | `notes.txt` im Baum ändert die Zahl nicht | nur `.js`/`.mjs` zählen |
| `npm run --silent check` | Exit 0, genau eine Zeile, gleiche Zahl wie im Test | der Befehl aus `CONTRIBUTING.md` bleibt derselbe; `--silent` unterdrückt nur den npm-Banner |

Die Temp-Bäume entstehen über `fs.mkdtempSync(path.join(os.tmpdir(), "bc-check-"))`
und werden mit `t.after` entfernt; Stil und `given/when/then`-Kommentare wie in
`test/bridge.test.js`.

## Acceptance criteria

**Ausnahme mit Datum**: keine. Alle Kriterien sind lokal entscheidbar, ohne
Windows-Rechner und ohne Reload.

**Alle Kriterien laufen in Git Bash**, nicht in `cmd.exe`: `find` und `grep` sind
dort GNU-Werkzeuge, und `echo $?` ist POSIX-Shell-Syntax (kein GNU-Programm, aber in
`cmd.exe` genauso wenig zu gebrauchen). Bei einem Fehllauf steht auf **stdout nichts**; alle Zeilen eines Fehllaufs gehen
auf stderr. Das ist der Zustand, den diese Spec behebt —
nur nicht für ihre eigenen Prüfkommandos, die hier abgelesen und nicht auf Windows
getippt werden.

1. **Ein Befehl, eine Zeile** (lokal). `npm run --silent check; echo $?` ⇒ genau eine
   Zeile `checked <n> files` (Singular nur bei 1) und `0`. Ohne `--silent` druckt
   `npm` vorher seinen eigenen Banner; gezählt wird die Zeile des Skripts. Die Zahl
   ist kein Vertrag, sondern ein Messwert: sie ist gleich der Zahl, die
   `find . -name .git -prune -o -name node_modules -prune -o -type f \( -name '*.js' -o -name '*.mjs' \) -print | wc -l`
   im selben Arbeitsbaum liefert — heute **14** (gemessen 2026-11-17, nach dem
   Schnitt von `docs/38`; vorher 33, weil 19 Dateien Bridge-Code und Bridge-Tests
   waren). Bei der Abnahme dieser Spec waren es 26 → 28
   (`scripts/check.mjs`, `test/check.test.js`).
2. **Kein Shell-Werkzeug mehr** (lokal). Weder in `package.json` noch in
   `scripts/check.mjs` kommt die Zeichenfolge `find ` oder `xargs` vor — auch nicht
   im Kommentar, damit die Gegenprobe trägt: `grep -c "find \|xargs" package.json
   scripts/check.mjs` ⇒ je `0` **und Exit 1** (bei `grep -c` kein Fehlschlag,
   sondern null Treffer).
3. **Jeder Prozessstart ist Node selbst** (lokal). Gepinnt wird die **Aufrufstelle**,
   nicht das Wort — die Import-Zeile `import { spawnSync } from "node:child_process"`
   enthält `spawnSync }` und zählt deshalb nicht mit. Der Aufruf steht dabei
   **in einer Zeile**; wer ihn umbricht, muß das Kriterium nachziehen (es prüft
   Text, nicht Grammatik):

   ```bash
   a=$(grep -c 'spawnSync(' scripts/check.mjs)
   b=$(grep -c 'spawnSync(process.execPath' scripts/check.mjs)
   test "$a" = "$b" && test "$b" -gt 0 && echo "ok a=$a b=$b"
   ```

   ⇒ `ok`, mit gleicher Zahl größer als 0. Zusätzlich
   `grep -cE 'execFile|execSync' scripts/check.mjs` ⇒ `0` **und Exit 1**; andere
   Prozessaufrufe gibt es damit nicht.
4. **Ein kaputter Baum wird rot und benannt** (lokal).

   ```bash
   d=$(mktemp -d); printf 'const = ;\n' > "$d/broken.js"
   node scripts/check.mjs "$d"; echo "exit=$?"     # exit=1, "broken.js: SyntaxError…"
   rm "$d/broken.js"; printf 'const a = 1;\n' > "$d/ok.js"
   node scripts/check.mjs "$d"; echo "exit=$?"     # checked 1 file, exit=0
   rm -rf "$d"
   ```

   Die Gegenprobe läßt absichtlich eine **saubere** Datei liegen: ein leerer Baum
   meldet `checked 0 files` mit Exit 0, und dieses stille Grün soll hier nicht als
   Erfolg durchgehen.
5. **Keine neuen Betriebsmittel** (lokal). `grep -c 'ependencies"' package.json`
   ⇒ `0` (Exit 1) — das Muster fängt `dependencies`, `devDependencies`,
   `peerDependencies` und `optionalDependencies`; `ls deploy | wc -l` ⇒ `1`.
6. **Die Abnahme in `CONTRIBUTING.md` ist unverändert** (lokal).
   `git diff HEAD -- CONTRIBUTING.md | grep -E '^[-+][^-+]'` ⇒ keine Ausgabe **und Exit 1**
   (null Treffer). Gegen `HEAD`, nicht gegen den Index — sonst wäre das Kriterium
   blind, sobald jemand `git add` benutzt.

## Dev plan

**Befund vor dem Bau** (in den Dateien gelesen, nicht geschätzt):

- `package.json:12` ist der einzige Ort, an dem `find` und `xargs` **aufgerufen**
  werden. Als Prosa kommen die Wörter auch anderswo vor (`bridge/hub.mjs:33`,
  `extension/background.js:2429`, `test/http-mcp.test.js:13`, diese Spec) — für
  Kriterium 2 zählt nur, dass die beiden Zieldateien sie nicht enthalten.
- `find … | wc -l` liefert heute **26**; nach `scripts/check.mjs` und
  `test/check.test.js` sind es **28**.
- `npm run check` gibt heute **vier** Zeilen auf stdout aus (Leerzeile,
  `> browser-control@0.1.0 check`, `> find . … | xargs -0 … node --check`,
  Leerzeile) und keine auf stderr. Nach dem Umbau steht in der dritten Zeile
  `> node scripts/check.mjs`; die `checked`-Zeile kommt **dazu** — daher `--silent`
  in Kriterium 1 und in der letzten Testing-Zeile.
- `node --check <datei>` ist das, was der Einzeiler je Datei aufruft; `scripts/`
  existiert noch nicht, `test/check.test.js` auch nicht.
- `node_modules` gibt es in diesem Arbeitsbaum nicht — der Ausschluß wird deshalb
  nur von den Temp-Baum-Fällen berührt, nicht vom Repo-Lauf.

**Completed 2026-11-06** — 1. **Das Skript.** `scripts/check.mjs` mit `collectFiles(root)` und dem
   `spawnSync`-Lauf je Datei; `package.json:12` umgestellt; `test/check.test.js`
   mit den sechs Fällen aus `## Testing`. **Umsetzer-Arbeit** (`ranger-1`).
   Proof: `node --test --test-reporter=tap test/check.test.js` ⇒ `# fail 0`;
   `npm run --silent check; echo $?` ⇒ `checked 28 files` und `0`;
   `grep -c "find \|xargs" package.json scripts/check.mjs` ⇒ `0` und `0`, Exit 1;
   das `a`/`b`-Kommando aus Kriterium 3 ⇒ `ok a=1 b=1`.

**Completed 2026-11-06** — 2. **Abschluss** (Orchestrator, `CONTRIBUTING.md` Schritt 7). Kriterien 1–6 einzeln am
   Diff prüfen, Prosa beschreibend machen, `status: active` setzen, diese Spec in
   `docs/README.md` auf `active` stellen, die Roadmap-Zeile 29 aus der Tabelle in
   `## Gemacht` umhängen, `docs/PROJECT-STATE.md` fortschreiben, `## Review`/`## Log`
   abschließen.
   Proof: `grep -n '^status:' docs/29-windows-betrieb.md` ⇒ `status: active`;
   `grep -n '29-windows-betrieb' docs/README.md` ⇒ Zeile mit `active`;
   `grep -n '29-windows-betrieb' docs/ROADMAP.md` ⇒ Zeile in `## Gemacht`.

### What could go wrong

- **Die Zahl in Kriterium 1 wandert.** Jede neue `.js`/`.mjs`-Datei ändert sie; das
  ist gewollt (Messwert, kein Vertrag), macht aber eine harte Zusicherung im Test
  kaputt, wenn dort eine Konstante steht. Der Test vergleicht deshalb gegen seinen
  eigenen `readdir`-Lauf **und** gegen zwei namentlich genannte Pfade.
- **Die Kriterien 2 und 3 sind textbasiert.** Kriterium 2 sucht Zeichenfolgen, nicht
  Aufrufe: ein Kommentar mit „find or xargs" macht die Gegenprobe rot, ein Kommentar
  mit „does not use find" **nicht** — das Muster verlangt „find " mit Leerzeichen.
  Beides ist eine Konvention an den Autor, keine Eigenschaft des Codes; sie steht
  deshalb auch in `## Risiken`.
- **`node --check` und die Dateimenge.** `.git` und `node_modules` müssen an jeder
  Tiefe übersprungen werden (dafür gibt es den verschachtelten Testfall). Ein
  `scripts/`-Unterverzeichnis mit eigenen Dateien zählt mit — sonst prüft der Befehl
  weniger, als `find` täte.
- **Exit-Code-Verwirrung bei `grep -c`.** `grep -c` endet bei null Treffern mit 1;
  in einer `&&`-Kette sieht das wie ein Fehlschlag aus. Kriterien 2, 5 und 6 sagen
  es dazu.
- **Die stderr-Diagnose von `node --check` beginnt mit dem Pfad.** `const = ;` in
  `/tmp/x/broken.js` schreibt zuerst `/tmp/x/broken.js:1`, erst danach
  `SyntaxError: …`. Wer die *erste* Zeile übernimmt, druckt den Pfad dorthin, wo der
  Grund stehen soll — der Bericht muß die `SyntaxError`-Zeile nehmen.
- **Singularregel in zwei Zeilen.** Erfolg und Fehlerzusammenfassung benutzen
  dieselbe Regel (`checked 1 file` / `checked 1 file, 1 failed`); wer nur eine der
  beiden umbaut, macht Testzeile 2 oder 4 rot. Das ist Absicht.

### What the next increment inherits

- **Spec 30** (`docs/30-prozess-und-konsole.md`) setzt diese Spec voraus: ohne
  `npm run check` gibt es auf Windows keine Abnahme; dort geht es um Konsole,
  Signale und die Amendments an `docs/18`.
- **Lokal überall prüfbar**, ohne Windows-Rechner — das ist der Zweck dieses
  Zuschnitts. Der Windows-Lauf gehört zu Spec 30.

## Open questions

**(keine)** — entschieden am 2026-11-06: ein Node-Skript (`scripts/check.mjs`), keine
PowerShell-Zeile in `CONTRIBUTING.md`. Grund: eine zweite Befehlsliste wäre eine zweite
Wahrheit, und `CONTRIBUTING.md` soll auf beiden Plattformen denselben Text tragen.

## Risiken

- **Die Textsuche ist eine Konvention.** „Kein `find` und kein `xargs` im Kommentar"
  ist keine Eigenschaft, die der Code erzwingt; ein späterer Bearbeiter kann sie
  brechen, ohne etwas kaputtzumachen. Das Kriterium bleibt trotzdem scharf, weil es
  das Einzige ist, was sich maschinell prüfen läßt.
- **Auf Windows ist das Skript ungemessen.** Es benutzt nur `node:fs`, `node:path`
  und `node:child_process` — portabel per Konstruktion, aber der erste echte Lauf
  findet auf dem Betreiber-Rechner statt. Er hakt das mit **Kriterium 2 in
  `docs/30-prozess-und-konsole.md`** ab (dort verlangt die Abnahme `npm run check`
  ⇒ 0 auf beiden Plattformen).
- **`spawnSync` je Datei ist langsamer als `xargs -n 1`** — bei 28 Dateien
  irrelevant, bei einigen hundert spürbar. Dann wäre ein Sammelaufruf zu bauen; das
  ist eine eigene Entscheidung.
- **Der Test vergleicht gegen eine Nachbildung.** Zwei Traversierungen, die denselben
  Fehler machen, stimmen überein. Deshalb prüft Testzeile 1 zusätzlich zwei
  namentliche Pfade; ein dritter Fehler bliebe trotzdem möglich.

## Touch boundary

- `package.json` (nur die Zeile `check`), `scripts/check.mjs` (neu),
  `test/check.test.js` (neu), diese Spec, `docs/README.md`, `docs/ROADMAP.md`,
  `docs/PROJECT-STATE.md`, `docs/30-prozess-und-konsole.md` (die Folgespec der
  Teilung, 2026-11-23 nachgetragen).
- **Nicht anfassen:** `CONTRIBUTING.md`, `INSTALL.md`, `bridge/*`, `extension/*`,
  `deploy/*`, `docs/18-dienst-und-http-mcp.md` (alles Spec 30 oder Teil 2).
- Keine neue Abhängigkeit, kein Token, kein Geheimnis.

## Bekannte Lücken

- **Der Windows-Lauf steht aus**: das Skript ist portabel geschrieben, aber nicht auf
  Windows ausgeführt; das ist Kriterium 2 in `docs/30-prozess-und-konsole.md`.
- **Ein leerer Baum bleibt grün.** `checked 0 files` ist sichtbar, aber Exit 0; wer
  will, dass weniger Dateien als erwartet scheitern, braucht eine Untergrenze — das
  wäre eine eigene Entscheidung und steht hier nicht.
- **Kein Schutz gegen versehentliche Dateivermehrung**: wächst der Baum stark, wird
  der Lauf langsam, ohne dass jemand es merkt. Bewusst offen.

## Review

### Runde 1, 2026-11-06 — `🔧 Fix these`, Blocker: P1–P4

Der Reviewer hat die Zahlen am echten Baum nachgemessen: 26 Dateien heute, 28
danach; `scripts/` und `test/check.test.js` gibt es nicht; `deploy` hat eine Datei;
`dependencies` gibt es nicht. Der Zuschnitt hielt — er hat keinen Pfad gefunden, den
der Plan bräuchte und die Touch boundary verbietet.

Blockierend waren vier Stellen: die Vorgeschichte in `## Review`/`## Log` war falsch
(dieser Text enthält Befunde aus den früheren Runden, nicht einen unbeanstandeten
Rest — und der Satz, der Reviewer werde „nicht erneut gefragt", war eine
selbst erteilte Gate-Befreiung, die `CONTRIBUTING.md` nur nach einer Eskalation an den
Betreiber vorsieht); die Erfolgszeile hatte drei Schreibweisen, so daß Kriterium 1
wörtlich unerfüllbar war; das Kriterium zu den Betriebsmitteln prüfte
`dependencies` nicht gegen `devDependencies` und zählte zwei verschiedene Dinge in
einem Muster; und Stufe 2 gab `ranger-1` Arbeit, die `CONTRIBUTING.md` ihm verbietet.
Neun weitere Befunde (P5–P13) betrafen Reihenfolge, Fehlerzeile, Zeilenform,
Wortlaut und Verweise; sie stehen einzeln im `## Log`.

### Runde 2, 2026-11-06 — `🔧 Fix these`, Blocker: Q1–Q3

Der Reviewer hat die Prüfkommandos ausgeführt statt sie zu lesen. Drei Blocker, alle
dieselbe Sorte Erbe — die Reparatur der ersten Runde hatte eine Zeile zu früh
haltgemacht:

- **Q1:** Kriterium 3 zählte das **Wort** `spawnSync`, und die idiomatische
  Import-Zeile `import { spawnSync } from "node:child_process"` trägt es. Eine
  korrekte Umsetzung wäre rot geworden (gemessen: 2 gegen 1).
- **Q2:** „eine Zeile" war wieder wörtlich unerfüllbar — `npm run check` druckt vier
  Zeilen Banner. `npm run --silent check` ist die Lösung (gemessen: 0 Zeilen Banner).
- **Q3:** Kriterium 5 hatte einen dritten Halbsatz ohne Kommando; ein Bericht ist
  kein Beweis.

Acht weitere Befunde (Q4–Q11) waren nicht blockierend: ein falsches Beispiel zur
Textsuche, die fehlende Singularregel in der Fehlerzeile, ein Widerspruch zwischen
`## Ziel` und Kriterium 4 beim leeren Baum, `git diff` gegen den Index statt gegen
`HEAD`, die fehlende Festlegung von stdout/stderr, ein zu flacher Ausschlußtest,
`echo $?` als „GNU-Werkzeug" bezeichnet und fehlende Entscheidungsworte bei den
geerbten Log-Zeilen. Alle übernommen.

### Runde 3, 2026-11-06 — `✅ Ship it`, keine Blocker

Der Reviewer hat diesmal ein Prototypskript in `/tmp` gebaut und die Kriterien daran
ausgeführt statt sie zu lesen: 26 → 28 Dateien bestätigt, `npm run --silent check`
gibt **eine** Zeile aus (3,9 s), Kriterium 3 liefert `a=1 b=1`, Kriterium 4 liefert
`broken.js: SyntaxError: …` und `checked 1 file, 1 failed`, und `git diff HEAD`
gegen `CONTRIBUTING.md` ist leer. Sein Urteil: alle sechs Kriterien und alle Testing-Zeilen
sind mit einer natürlichen Umsetzung erfüllbar.

Neun Nachzieher (R1–R9), alle nicht blockierend, sind vor Stufe 1 eingetragen: die
Banner-Zeile im Befund-Absatz lautete falsch (R1), „sieben Fälle" gegen sechs Fälle
plus Abnahmebefehl (R2), ein Satz ohne Kommando in Kriterium 3 (R3), Nummern in
`## Review` gegen `## Log` (R4), die zeilenbasierte Aufrufstelle braucht den Hinweis
„in einer Zeile" (R5), bei Fehllauf ist stdout leer (R6), der leere Baum ist jetzt
geprüft statt nur behauptet (R7), `mktemp` wird aufgeräumt (R8), und der zweite
Baumlauf dürfte den ersten wiederverwenden (R9, bewußt nicht umgesetzt: zwei
getrennte Läufe prüfen mehr als einer).

## Log

Jeder Befund mit einer Entscheidung; nach `CONTRIBUTING.md`, Schritt 4, gehört je Befund
eine Zeile hierher.

- **Geerbt aus den Runden 1–3 der Vorgängerfassung: L3, L7 und L11 — alle
  übernommen.** Sie betrafen Text, der mit der Teilung hierher gewandert ist: die
  Git-Bash-Regel (L3), die Zahl als Messwert statt Konstante (L7) und die Soll-Zeile
  für den Prozessstart (L11). Die übrigen Befunde jener Runden betrafen Konsole,
  Signale, Port-Zeile, Amendments und die Windows-Messung; sie stehen in
  `docs/30-prozess-und-konsole.md`.
- **P1: übernommen.** `## Review`/`## Log` nennen die geerbten Befunde als eigene und
  verzichten auf die selbst erteilte Gate-Befreiung.
- **P2: übernommen.** Eine Schreibweise: `checked 1 file`, sonst
  `checked <n> files` — in `## Ziel`, `## Testing`, Kriterium 1 und Stufe 1.
- **P3: übernommen.** Kriterium 5 prüft `grep -c 'ependencies"'` (fängt alle vier
  Abhängigkeitsfelder) und Kriterium 3 vergleicht Prozeßaufrufe gegen
  `process.execPath`-Nennungen statt zwei Dinge in einem Muster zu zählen.
- **P4: übernommen.** Stufe 1 ist Umsetzer-Arbeit, Stufe 2 ist „Abschluss
  (Orchestrator, `CONTRIBUTING.md` Schritt 7)" ohne widersprüchlichen Klammerzusatz.
- **P5: übernommen.** `spawnSync(…, ["--check", path.join(root, rel)])` — der Pfad
  wird gegen die Wurzel aufgelöst, nicht gegen `cwd`.
- **P6: übernommen.** Kriterium 4 ist ein ausgeschriebenes Kommando mit `mktemp`,
  und die Gegenprobe läßt eine saubere Datei liegen.
- **P7: übernommen.** Kriterium 3 hängt nicht mehr an der Zeilenform des Aufrufs,
  sondern vergleicht zwei Trefferzahlen.
- **P8: übernommen.** Der Bericht nimmt die `SyntaxError`-Zeile, nicht die erste
  stderr-Zeile (die ist der Pfad).
- **P9: übernommen.** „der einzige Ort, an dem sie **aufgerufen** werden" — samt
  den Stellen, an denen die Wörter nur als Prosa vorkommen.
- **P10: übernommen.** Testzeile 1 prüft zusätzlich zwei namentliche Pfade.
- **P11: übernommen.** Stufe 2 sagt, was in der Roadmap passiert: die Zeile wandert
  von der Tabelle nach `## Gemacht`.
- **P12: übernommen.** Verweis auf „Kriterium 2 in `docs/30`"; `node:os` steht nur
  noch beim Test, nicht in der Skriptliste.
- **P13: übernommen.** „Lokal überall prüfbar" und „der Windows-Lauf gehört zu
  Spec 30" sagen jetzt dasselbe.
- **Q1: übernommen.** Kriterium 3 pinnt die Aufrufstelle
  (`spawnSync(process.execPath`) gegen alle `spawnSync(`-Stellen, nicht das Wort.
- **Q2: übernommen.** Kriterium 1, die letzte Testing-Zeile und der Proof in Stufe 1
  benutzen `npm run --silent check`; der Befund-Absatz nennt die vier Banner-Zeilen.
- **Q3: übernommen.** Der dritte Halbsatz aus Kriterium 5 ist gestrichen.
- **Q4: übernommen.** Das Beispiel heißt jetzt „find or xargs"; die Aussage, welches
  Kommentar die Gegenprobe **nicht** rot macht, steht richtig da.
- **Q5: übernommen.** Die Singularregel gilt für beide Zeilen und ist in `## Ziel`
  und in Testzeile 2/4 gepinnt.
- **Q6: übernommen.** `## Ziel` sagt jetzt „sichtbar, nicht still" statt „kann nicht
  mehr grün heißen"; `## Bekannte Lücken` nennt den leeren Baum ausdrücklich.
- **Q7: übernommen.** Kriterium 6 prüft gegen `HEAD` und nennt den Exit-Code.
- **Q8: übernommen.** Erfolg auf stdout, Diagnose und Fehlerzusammenfassung auf
  stderr — in `## Ziel` festgelegt und in Testzeile 1/2 geprüft.
- **Q9: übernommen.** Der Ausschlußtest ist verschachtelt; die Symlink-Zusage steht
  jetzt mit ihrer Begründung (`Dirent.isFile()`) in `## Ziel`, ohne eigenen Testfall,
  weil sie das Verhalten von `find` ohne `-L` nicht verändert.
- **Q10: übernommen.** `echo $?` heißt „POSIX-Shell-Syntax", nicht GNU-Werkzeug.
- **Q11: übernommen.** Die drei geerbten Log-Zeilen sagen jetzt „alle übernommen".
- **R1: übernommen.** Die dritte Banner-Zeile heißt richtig `> find … | xargs …`.
- **R2: übernommen.** Sechs Fälle in der Datei, die siebte Testing-Zeile ist der
  Abnahmebefehl.
- **R3: übernommen.** Kriterium 3 bekommt ein Kommando gegen `execFile`/`execSync`
  statt eines Satzes ohne Prüfung.
- **R4: übernommen.** Die Nummern in `## Review` passen zum `## Log`, und Runde 1
  nennt die neun Zeilen P5–P13 ausdrücklich.
- **R5: übernommen.** Kriterium 3 sagt, daß der gepinnte Aufruf in einer Zeile
  steht — es prüft Text, nicht Grammatik.
- **R6: übernommen.** Bei Fehllauf bleibt stdout leer; in `## Ziel` festgelegt und
  in Testzeile 2 geprüft.
- **R7: übernommen.** Der leere Baum ist jetzt ein geprüfter Fall in der
  Ausschlußzeile, statt nur im `## Ziel` behauptet zu werden.
- **R8: übernommen.** Das `mktemp`-Kommando räumt auf.
- **R9: nicht umgesetzt (bewußt).** Der zweite Baumlauf darf nicht denselben Lauf
  wiederverwenden: zwei getrennte Läufe prüfen mehr als einer, und 4 s in einer
  90-Sekunden-Abnahme sind kein Problem.
- **Nicht übernommen: nichts.**

- **2026-11-23, drei Nachzieher aus dem Code-Review.** (a) Die Laufzeit ist neu
  gemessen: **1,4 s** statt 3,0–3,2 s (drei Läufe mit `/usr/bin/time`, s. oben);
  `docs/PROJECT-STATE.md` ist mitgezogen. (b) `docs/30-prozess-und-konsole.md` steht
  jetzt in der Touch boundary — es ist die Folgespec der Teilung. (c) Die Befunde
  **B1, C9 und C10** bekommen keine Zeile im Log: der Review-Text liegt nicht im
  Repo, und aus dem Code sind sie nicht mehr zuzuordnen. Der Punkt wird damit
  geschlossen, weil er nicht mehr prüfbar ist — wer die Befunde kennt, trägt sie nach.
