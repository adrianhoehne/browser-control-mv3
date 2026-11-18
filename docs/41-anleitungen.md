---
description: Zwei Anleitungen für das portable Paket — Firefox mit der XPI und die MCP-Clients pi, Codex, OpenCode; Englisch nach ASD-STE100, als Schreibregel ohne Prüfskript.
status: active
---

# Die zwei Anleitungen

Das portable Zip (`docs/39`) enthält zwei Texte, die den Nutzer führen sollen,
ohne dass er etwas über das Projekt wissen muss:

- `FIREFOX.md` — von „Firefox starten" bis „die Erweiterung ist geladen".
- `CLIENTS.md` — von „der Server läuft" bis „der Client sieht die Werkzeuge".

Diese Spec ist abgespalten (`CONTRIBUTING.md`, Schritt 4: nach dem dritten Block
wird geteilt). `docs/39` beschreibt das Paket, diese Spec den Text darin.

**Was sie nicht tut:** keinen automatischen Stil-Lint. STE100 ist eine
Schreibregel, kein Prüfschritt (Betreiberentscheid 2026-11-17). Kein
`ste-lint`, keine Schwelle, kein CI-Job.

## Ziel

- **Beide Texte sind Englisch und folgen ASD-STE100:** nummerierte Schritte,
  Befehlsform, höchstens 20 Wörter je Anweisung, ein Name je Sache, Warnung
  **vor** dem Schritt, den sie betrifft.
- **Sie liegen im Repo** unter `docs/portable/` (kein `NN-`-Präfix, kein
  Frontmatter: es sind Nutzertexte, keine Specs) und werden von
  `scripts/bundle.sh` ins Zip kopiert — eine Quelle, keine zweite Fassung.
- **Sie sind vollständig:** wer sie abarbeitet, hat eine offene Seite im
  Browser beziehungsweise eine funktionierende MCP-Verbindung. Nichts bleibt
  „dem Leser überlassen".
- **Sie sagen die Grenzen:** die Erweiterung ist temporär, das Token steht in
  einer Datei, OpenCode legt das Token in seiner Konfiguration ab.

## Non-goals

- **Kein Signieren, kein AMO.** Die XPI bleibt unsigniert; die Anleitung sagt
  das nicht als Entschuldigung, sondern als Schritt („Load Temporary Add-on").
- **Kein mitgeliefertes Firefox.**
- **Keine Screenshots.** Text, der in einem Terminal funktioniert, ist länger
  haltbar als ein Bild von einer Menüleiste.
- **Kein automatischer Lint** (siehe oben).

## `FIREFOX.md`

Die Schritte, in dieser Reihenfolge:

1. Firefox starten.
2. In die Adresszeile `about:debugging#/runtime/this-firefox` eintippen und
   Enter drücken.
3. „Load Temporary Add-on…” wählen.
4. Im Dateidialog **die XPI-Datei** aus dem entpackten Ordner auswählen
   (`browser-control-<version>.xpi`).
5. **`about:addons`** in einem neuen Tab öffnen, **Browser Control** wählen,
   dann **Preferences**. `about:debugging` hat für ein temporäres Add-on keinen
   Einstellungs-Link — das ist der Punkt, an dem ein neuer Nutzer sonst hängt.
6. Als Endpunkt `ws://127.0.0.1:8110` eintragen.
7. Das **Browser-Control-Symbol** in der Symbolleiste anklicken. Die Erweiterung
   ist nach der Installation **aus**, und es passiert nichts, bis der Schalter
   an ist: kein Tab, kein Socket.
8. Das Token aus der Zeile `token: …` des Startfensters eintragen.
9. Speichern.
10. Die Erweiterung in `about:debugging` einmal neu laden (**Reload** neben
    Browser Control).

**Warum der Icon-Schritt vor dem Token steht:** die Spec (`docs/44`, Kriterium 9)
verlangt ihn dort, und die Reihenfolge ist auch inhaltlich die richtige — der
Schalter ist die eine Handlung, ohne die die Erweiterung bewusst stumm bleibt.
Die drei Symbole werden im Schritt benannt (überkreuzt = aus, Brücke =
verbunden, gelber Blitz = an ohne Verbindung), damit der Leser den Zustand
später ohne diese Anleitung wiedererkennt.

**Die Warnung steht als Kasten zwischen Schritt 1 und 2**, direkt vor dem
Laden — „The extension is temporary. After a Firefox restart it is gone. Repeat
steps 2 to 4. Firefox keeps the endpoint and the token in the profile; if the
connection fails after a reload, check them." Sie ist **kein** numerierter
Schritt: sonst verschöben sich alle Nummern und der Verweis auf die Schritte
zeigte auf die falschen.

**Warum Schritt 5 über `about:addons` geht:** `about:debugging` zeigt für ein
temporäres Add-on nur **Reload** und **Remove**, keinen Einstellungs-Link
(Betreiber-Fund vom 2026-11-17). Die Optionsseite hängt an der Add-on-Verwaltung.

Ein Schlusssatz: dass im Startfenster `endpoint:` und `http:` stehen und welche
Adresse wofür gilt (Extension bekommt `ws://…:8110`, der MCP-Client
`http://…:8111/mcp`).

## `CLIENTS.md`

Die Schritte, in dieser Reihenfolge:

1. Den Server starten (`start.sh` beziehungsweise `start.cmd`).
2. Aus dem Startfenster die Zeile `http: …` und die Zeile `token: …` nehmen.
3. **pi** — Eintrag in `~/.pi/agent/mcp.json`, **mit** der Hülle:

   ```json
   { "mcpServers": { "browser-control": {
       "url": "http://127.0.0.1:8111/mcp",
       "headers": { "Authorization": "!echo Bearer $(cat <pfad>/data/token)" } } } }
   ```

   Der `!`-Wert liest das Token beim Start, statt es in die Datei zu schreiben.

4. **Codex** — `codex mcp add browser-control --url http://127.0.0.1:8111/mcp
   --bearer-token-env-var BC_TOKEN`, dazu die Zeile, die `BC_TOKEN` in der Shell
   setzt (`export BC_TOKEN=$(cat <pfad>/data/token)`).
5. **OpenCode** — `opencode mcp add browser-control --url
   http://127.0.0.1:8111/mcp --header "Authorization=Bearer <token>"`, mit dem
   Hinweis, dass dieser Client das Token in seiner Konfiguration ablegt.
6. **Generisches Muster** — ein JSON- und ein TOML-Ausschnitt für Clients, die
   hier nicht genannt sind: Server-URL, Kopfzeile `Authorization: Bearer …`.
7. Prüfen: der Client listet **dreizehn** Werkzeuge. `browser_status` aufrufen,
   mit `browser_open_tab` eine Seite öffnen, mit `browser_read` ihren Text
   lesen. Die Namen erscheinen je Client unterschiedlich (pi stellt
   `mcp__browser-control__` voran, Codex und OpenCode zeigen sie
   unverändert) — die Anleitung nennt beide Schreibweisen.
8. Schlusssatz: dasselbe Token gilt für Firefox **und** den Client.

Die Befehle in Schritt 4 und 5 sind am 2026-11-17 gegen die installierten CLIs
geprüft (`codex` 0.154.0, `opencode` 2.2.6).

## Dependency changes

**Keine.**

## Testing

Es gibt keinen Testfall für Prosa. Geprüft wird die **Struktur**, damit ein
fehlender Schritt auffällt:

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/bundle/bundle.test.js` | `guides_shouldBeNumberedFromOne` | beide Dateien beginnen mit `1.` und haben je Datei die in Kriterium 1 geforderte Mindestzahl numerierter Schritte |
| `test/bundle/bundle.test.js` | `guides_shouldNameThePrintedLines` | gepaart: `FIREFOX.md` trägt `127.0.0.1:8110`, `CLIENTS.md` trägt `127.0.0.1:8111` — je Datei das, was sie braucht, nicht beide in beiden |

## Acceptance criteria

1. **Beide Dateien existieren und sind gegliedert.** `grep -c '^1\. '
   docs/portable/FIREFOX.md docs/portable/CLIENTS.md` ⇒ je **1**;
   `grep -cE '^[0-9]+\. ' docs/portable/FIREFOX.md` ⇒ **≥ 9**,
   `grep -cE '^[0-9]+\. ' docs/portable/CLIENTS.md` ⇒ **≥ 7**.
2. **Sie nennen die richtigen Adressen.** `grep -c 'ws://127.0.0.1:8110'
   docs/portable/FIREFOX.md` ⇒ **≥ 1**; `grep -c
   'http://127.0.0.1:8111/mcp' docs/portable/CLIENTS.md` ⇒ **≥ 3** (pi, Codex,
   OpenCode).
3. **Sie warnen vor der Temporär-Eigenschaft, bevor sie beißt.**
   `grep -ci 'temporary' docs/portable/FIREFOX.md` ⇒ **≥ 1**, und die erste
   Fundstelle steht **vor** dem letzten numerierten Schritt:
   `test "$(grep -ni 'temporary' docs/portable/FIREFOX.md | head -1 | cut -d: -f1)"
   -lt "$(grep -nE '^[0-9]+\. ' docs/portable/FIREFOX.md | tail -1 | cut -d: -f1)"`
   ⇒ Exit **0**.
4. **Kein Werkzeugname ist erfunden.** Die drei Namen in `CLIENTS.md`
   (`browser_open_tab`, `browser_status`, `browser_read`) kommen in
   `docs/portable/CLIENTS.md` **und** in `scripts/parity/expected/1-initialize-and-tools-list.txt`
   vor: `grep -c` je Name in beiden Dateien ⇒ je ≥ 1.
5. **Das Zip enthält sie.** `unzip -Z1
   dist/browser-control-<version>-linux-x86_64.zip | grep -cE
   '/(FIREFOX|CLIENTS)\.md$'` ⇒ **2**.
6. **Kein Stil-Lint im Baum.** `grep -rl 'ste-lint' package.json scripts
   .github 2>/dev/null; echo $?` ⇒ **1**. `test/` ist bewusst **nicht** in der
   Liste: `test/ci/workflow.test.js` muss das Wort als Suchmuster tragen
   (`docs/40`), und `docs/` nennt es, weil die Specs die Entscheidung
   dokumentieren.

## Dev plan

**Stufe 1 — `FIREFOX.md`**

Dateien: `docs/portable/FIREFOX.md`.

Inhalt nach dem Abschnitt oben, Englisch, STE100 als Schreibregel.

Beweis: Kriterien 1, 2, 3.

**Stufe 2 — `CLIENTS.md`**

Dateien: `docs/portable/CLIENTS.md`.

Beweis: Kriterien 1, 2, 4.

**Stufe 3 — Struktur-Tests und Zip**

Setzt `docs/39`, Stufe 1 voraus (`scripts/bundle.sh`) und **legt
`test/bundle/bundle.test.js` mit den zwei Fällen an**; `docs/39` Stufe 2 ergänzt
die sieben Zip-Fälle.

Dateien: `test/bundle/bundle.test.js` (die zwei Fälle aus `## Testing`),
`scripts/bundle.sh` (kopiert `docs/portable/*.md` ins Zip).

Beweis: Kriterium 5; `npm run test:bundle` ⇒ `# fail 0`.

## Bekannte Lücken

- **Niemand prüft den Stil.** Die Regeln sind aufgeschrieben, ihre Einhaltung
  nicht. Ein neuer Satz mit 40 Wörtern fällt keinem Test auf.
- **Die Befehle der Clients können sich ändern.** Geprüft am 2026-11-17 gegen
  `codex 0.154.0` und `opencode 2.2.6`; eine neue Version kann andere Flags
  haben.
- **Der Nutzer liest Englisch.** Wer kein Englisch kann, ist auf die
  Firefox-Oberfläche angewiesen — bewusste Entscheidung (`## Open questions`
  von `docs/39`).

## Open questions

**Keine.**

## Review

### Runde 1 — 2026-11-17, `grizzled-senior-dev`: 🔧, Blocker dabei

Vier Blocker: Kriterium 6 war unlösbar (`test/` in der Suchliste, obwohl der
Workflow-Test das Wort als Muster tragen muss); die Warnung war als numerierter
Schritt beschrieben, was alle Nummern verschoben hätte; der Fall
`guides_shouldNameThePrintedLines` prüfte Etiketten statt Werte; der Fallname
`guides_shouldStartAtStepOne` versprach weniger, als er prüft.

### Runde 2 — steht aus

## Log

- **2026-11-17, Abspaltung:** Diese Spec war der Abschnitt „Die zwei
  Anleitungen" in `docs/39`. Der dritte Block im Spec-Review von `docs/39` hat
  die Teilung erzwungen (`CONTRIBUTING.md`, Schritt 4).
- **2026-11-17, Betreiberentscheid:** Englisch nach STE100, **ohne**
  automatischen Lint.
- **2026-11-17, Betreiberentscheid:** MCP-Hauptweg ist der HTTP-Endpunkt;
  Clients pi, Codex, OpenCode plus ein generisches Muster.
- **Runde 1 — übernommen:** Kriterium 6 ohne `test/` (mit Begründung);
  Warnung als Kasten zwischen Schritt 1 und 2, kein numerierter Schritt; der
  Werkzeug-Fall prüft die zwei Literale statt der Etiketten; der Fall heißt
  `guides_shouldBeNumberedFromOne`.
