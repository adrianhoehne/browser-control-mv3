---
description: docs/35 und INSTALL.md sagen nach docs/68 dasselbe wie der Code — das Token erscheint beim Anlegen einmal, ein Reparaturlauf nennt nur --print-token; sieben grep-Prüfungen decken beide Richtungen ab.
status: active
---

# Die Anleitung sagt, was das Skript tut

## Anlass

`docs/68-token-nicht-wiederholt.md` ändert das Verhalten des Installationsskripts:
ein Lauf, der ein vorhandenes Token vorfindet, druckt es nicht mehr. Zwei Dokumente
behaupten danach das Gegenteil:

| Dokument | Stelle | Satz heute |
|---|---|---|
| `docs/35-installationsskript.md` | Zeile 43 f. | „**Das Token erscheint genau einmal**, auf stdout, mit der Aufforderung, es jetzt einzufügen." |
| `docs/35-installationsskript.md` | Kriterium 6 | „Es steht auf `stdout` genau einmal …" |
| `docs/35-installationsskript.md` | Zeile 39 | „… mit Endpunkt und Token zum Einfügen." |
| `docs/35-installationsskript.md` | Zeile 26 | „**22 `install_`-Fälle** … zusammen **31**" (schon vorher um eins daneben) |
| `INSTALL.md` | Zeilen 108–112 | „At the end it prints the endpoint and the token — **once**, on stdout" |

Ein Betreiber, der nach der Anleitung prüft, sieht einen Widerspruch: die Anleitung
verspricht einen Token, die Ausgabe zeigt keinen. Der Kopf von `scripts/install.sh`
sagt selbst, dass `INSTALL.md` nicht die Wahrheit ersetzt — dann muss die Wahrheit
dort stehen.

## Ziel

1. **`docs/35` beschreibt das neue Verhalten** an allen vier Stellen und nennt den
   neuen Fall in der Testing-Liste.
2. **`INSTALL.md` beschreibt es ebenfalls**, im Abschnitt „One command", und nennt
   `--print-token` als den Weg zum Wert.
3. **Die Zähler stimmen:** 24 `install_`-Fälle, 24 + 9 = 33 zusammen (heute 23 und
   32; `docs/35` ist schon jetzt um eins daneben).
4. **Der alte Satz ist weg** — nicht nur ergänzt. Beide Richtungen werden geprüft.
5. **Der CHANGELOG nennt den Bau** unter `[0.8.0]`, mit Datum und den Testnamen.

## Amendments to previous spec docs

`docs/35` bleibt `active`; die Nachträge tragen das Datum des Baus. Jede Zeile nennt
den Wortlaut, den die Kriterien grepen, damit Umsetzer und Prüfung nicht
auseinanderlaufen.

| Dokument | Stelle | Was dort danach steht |
|---|---|---|
| `docs/35` | Zeile 43 f. | „Das Token erscheint **beim Anlegen genau einmal**; ein Reparaturlauf druckt es nicht und nennt `--print-token`." — der Wortlaut steht in einer Zeile, `--print-token` am Satzende |
| `docs/35` | Kriterium 6 | „beim Anlegen genau einmal" — **ohne Fettdruck und ohne den Folgesatz**, in einer Zeile; so trifft der lange Ausschnitt aus Kriterium 1 genau einmal |
| `docs/35` | Zeile 44 f. | der Folgesatz bleibt: „Nicht in einer Datei außer der Tokendatei … nicht in einer Logzeile des Skripts." |
| `docs/35` | Zeile 39 | „… — beim Anlegen mit Endpunkt und Token, sonst mit Endpunkt und dem Hinweis auf `--print-token`." |
| `docs/35` | Zeile 26 | der datierte Satz vom 2026-11-17 bleibt; darunter ein neuer datierter Satz: „**Stand 2026-11-26, nachgezogen aus `docs/68`:** **24 `install_`-Fälle**, zusammen **33**" |
| `docs/35` | `## Testing` | Liste mit `install_withAnExistingToken_doesNotPrintIt`, mit `install_isIdempotent` samt der Klausel „der zweite Lauf druckt das Token nicht" und mit `install_withAStoppedService_startsItInsteadOfRestarting` — der steht heute nur im Log vom 2026-11-22, nicht in der Testing-Liste |
| `INSTALL.md` | Zeilen 108–113 | „It writes the token only if there is none. A run that finds one prints no token, but always the endpoint; `scripts/install.sh --print-token` prints the token." — der gepinnte Satz steht in einer Zeile |
| `INSTALL.md` | Zeile 115 f. | die Schreiborte nennen drei: `~/.config/browser-control/`, `~/.config/systemd/user/` **und** `~/.local/bin/` (`docs/35`, Kriterium 9) |
| `INSTALL.md` | Zeilen 108–112 | die Nachbarsätze bleiben: `installs the user unit`, `reloads systemd` und die vier Firefox-Schritte |

## Der Vertrag

| Feld | Regel |
|---|---|
| Dateien | `docs/35-installationsskript.md`, `INSTALL.md`, `CHANGELOG.md` |
| Wortlaut | die Amendments-Tabelle ist verbindlich; jedes Dokument benutzt den Wortlaut seiner Tabellenzeile (`docs/35` deutsch, `INSTALL.md` englisch) |
| CHANGELOG | nur unter `[0.8.0]`; ältere Einträge bleiben, auch wo sie den alten Satz zitieren |
| Sprache | `INSTALL.md` englisch, `docs/35` deutsch — wie die Dateien heute sind |
| Zahlen | 24 und 33; `test/deploy.test.js` bleibt bei neun Fällen |

## Non-goals

- **Kein Code.** Diese Spec fasst `scripts/install.sh` und `test/**` nicht an; sie
  beschreibt, was `docs/68` gebaut hat.
- **Keine Rotation, kein neues Flag.** Es ändert sich nur der Text.
- **Keine Umschreibung der Geschichte.** Der `[0.2.0]`-Eintrag im CHANGELOG zitiert
  den alten Satz; er bleibt, wie er ist.
- **Keine Berührung von `docs/README.md` und `PROJECT-STATE.md`** — die gehören dem
  Orchestrator (CONTRIBUTING, Schritt 7).

## Touch boundary

| Erlaubt | Nicht erlaubt |
|---|---|
| `docs/35-installationsskript.md`, `INSTALL.md`, `CHANGELOG.md` | `scripts/**`, `test/**`, `bridge-rs/**`, `extension/**` |
| `docs/69-doku-token-einmal.md`, aber nur Frontmatter-Status, Review-Zeile und Log-Eintrag (Stufe 4) | `docs/README.md` (Orchestrator), `docs/PROJECT-STATE.md`, `docs/ROADMAP.md`, andere Specs |
| — | neue Dateien, neue Abhängigkeiten |

## Testing

Ein Text hat keine Testdatei; die Prüfung sind die `grep`-Paare in
`## Acceptance criteria`.

| Prüfung | Was sie beweist |
|---|---|
| Kriterium 1 und 2 | der neue Satz steht an beiden Stellen, der alte ist weg |
| Kriterium 3 | `INSTALL.md` sagt den neuen Satz, nennt drei Schreiborte |
| Kriterium 4 | der Weg `--print-token` bleibt in beiden Dokumenten genannt |
| Kriterium 5 | die Nachbarsätze überleben die Ersetzung |
| Kriterium 6, 7, 8 | Zähler, Summe und Testing-Liste stimmen |
| Kriterium 9 und 10 | CHANGELOG und der Draft-Umfang |

## Acceptance criteria

Alle Zählungen auf `docs/35` laufen über einen Abschnitt, nie über die ganze Datei:
`docs/35` zitiert in seinem `## Log` die geänderten Sätze, und ein Log-Eintrag würde
jede dateiweite Zahl still verschieben.

1. **Der neue Satz steht zweimal in `## Ziel`, an einer Stelle unbefettet:**

   ```
   sed -n '/^## Ziel/,/^## Non-goals/p' docs/35-installationsskript.md \
     | grep -cF 'beim Anlegen genau einmal'                       # ⇒ 2
   sed -n '/^## Ziel/,/^## Non-goals/p' docs/35-installationsskript.md \
     | grep -cF 'beim Anlegen genau einmal**; ein Reparaturlauf druckt es nicht'  # ⇒ 1
   ```

   In Kriterium 6 steht der Wortlaut **ohne Fettdruck und ohne den Folgesatz**
   („beim Anlegen genau einmal" allein), damit der lange Ausschnitt genau einmal trifft.
2. **Der alte Satz ist weg:**

   ```
   sed -n '/^## Ziel/,/^## Non-goals/p' docs/35-installationsskript.md \
     | grep -cF 'Das Token erscheint genau einmal'                 # ⇒ 0
   ```
3. **`INSTALL.md`, beide Richtungen und die Schreiborte:**

   ```
   grep -cF 'prints the endpoint and the token' INSTALL.md          # ⇒ 0
   grep -cF 'A run that finds one prints no token, but always the endpoint' INSTALL.md  # ⇒ 1
   grep -cF '~/.local/bin' INSTALL.md                               # ⇒ mindestens 1
   ```

   Die dritte Prüfung zieht den zweiten falschen Satz derselben Zeilen mit: `INSTALL.md`
   nennt nur zwei Schreiborte, `scripts/install.sh` schreibt nach dreien.
4. **Der Ausweg bleibt genannt, in beiden Dokumenten:**

   ```
   sed -n '/^## Testing/,/^## Acceptance criteria/p' docs/35-installationsskript.md \
     | grep -cF 'druckt das Token nicht'                            # ⇒ 1
   sed -n '/^## Ziel/,/^## Non-goals/p' docs/35-installationsskript.md \
     | grep -cF 'und nennt `--print-token`'                          # ⇒ 1
   grep -cF 'scripts/install.sh --print-token` prints the token' INSTALL.md  # ⇒ 1
   ```
5. **Die Nachbarsätze bleiben, sonst wäre die Ersetzung eine Löschung:**

   ```
   grep -cF 'installs the user unit' INSTALL.md                     # ⇒ 1
   sed -n '/^## Ziel/,/^## Non-goals/p' docs/35-installationsskript.md \
     | grep -cF 'einer Logzeile des Skripts'                         # ⇒ 1
   ```
6. **Der Zähler:**

   ```
   sed -n '/^## Ziel/,/^## Non-goals/p' docs/35-installationsskript.md \
     | grep -cF '24 `install_`-Fälle'                                # ⇒ 1
   sed -n '/^## Ziel/,/^## Non-goals/p' docs/35-installationsskript.md \
     | grep -cF '`install_`-Fälle'                                   # ⇒ 2 (alt und neu)
   sed -n '/^## Ziel/,/^## Non-goals/p' docs/35-installationsskript.md \
     | grep -cF 'Stand 2026-11-26, nachgezogen aus'                   # ⇒ 1
   npm test 2>&1 | grep -cE '^ok [0-9]+ - install_withAnExistingToken_doesNotPrintIt'  # ⇒ 1
   npm test 2>&1 | grep -cE '^ok [0-9]+ - install_'                  # ⇒ 24 (Wächter)
   ```
7. **Die Summe und die Fremdzahl:**

   ```
   sed -n '/^## Ziel/,/^## Non-goals/p' docs/35-installationsskript.md \
     | grep -cF 'zusammen **33**'                                     # ⇒ 1
   grep -cE '^test\(' test/deploy.test.js                            # ⇒ 9 (Wächter)
   ```
8. **Beide Fälle und beide Zusagen stehen in der Testing-Liste:**

   ```
   sed -n '/^## Testing/,/^## Acceptance criteria/p' docs/35-installationsskript.md \
     | grep -cF 'install_withAnExistingToken_doesNotPrintIt'          # ⇒ 1
   sed -n '/^## Testing/,/^## Acceptance criteria/p' docs/35-installationsskript.md \
     | grep -cF 'install_withAStoppedService_startsItInsteadOfRestarting'  # ⇒ 1
   sed -n '/^## Testing/,/^## Acceptance criteria/p' docs/35-installationsskript.md \
     | grep -cF 'install_isIdempotent'                               # ⇒ 1 (Wächter)
   sed -n '/^## Ziel/,/^## Non-goals/p' docs/35-installationsskript.md \
     | grep -cF 'sonst mit Endpunkt und dem Hinweis auf'              # ⇒ 1
   ```
9. **Der CHANGELOG nennt den neuen Fall und das Datum** (die Überschriftenzeile zählt
   nicht mit, sonst beweist sie das Datum selbst):

   ```
   awk '/^## \[0.8.0\]/,/^## \[0.7.0\]/' CHANGELOG.md | tail -n +2 \
     | grep -cF 'install_withAnExistingToken_doesNotPrintIt'          # ⇒ 1
   awk '/^## \[0.8.0\]/,/^## \[0.7.0\]/' CHANGELOG.md | tail -n +2 \
     | grep -cF '2026-11-26'                                           # ⇒ 4 (Stand 2026-11-26)

   Der Abschnitt `[0.8.0]` trägt schon drei ältere datierte Messsätze; dieser Bau
   fügt den vierten hinzu.
   ```
10. **Nichts anderes bewegt** (gilt für die Stufen 1–3, vor dem Abschluss):

   ```
   git status --short | grep -cE '(docs/35-installationsskript\.md|INSTALL\.md|CHANGELOG\.md)$'  # ⇒ 3
   git status --short | grep -vE '(docs/35-installationsskript\.md|INSTALL\.md|CHANGELOG\.md|docs/6[89]-[a-z-]+\.md|scripts/install\.sh|test/install\.test\.js)$'  # ⇒ keine Ausgabe
   git diff --stat -- scripts test | wc -l                          # ⇒ 0 (eigener Commit je Increment)
   npm run check                                                    # ⇒ Exit 0
   npm test                                                         # ⇒ # fail 0
   ```

   Die dritte Zeile ist der Zaun für die verbotene Wiese: `scripts/install.sh` und
   `test/install.test.js` stehen in der Whitelist, weil sie zu `docs/68` gehören — sie
   dürfen aber in diesem Increment unverändert bleiben. `docs/README.md` steht **nicht**
   in der Whitelist; sie führt der Orchestrator beim Commit.

## Dev plan

1. **`docs/35` nach der Amendments-Tabelle umschreiben** — Zeile 43 f. und Kriterium
   6 mit demselben Wortlaut, Zeile 39, ein neuer datierter Zähler unter Zeile 26, die
   Testing-Liste. Beweis: Kriterien 1, 2, 4, 5, 6, 7 und 8.
2. **`INSTALL.md` umschreiben** — Abschnitt „One command", Zeilen 108–113, dazu die
   Schreiborte in Zeile 115 f. Beweis: Kriterium 3.
3. **CHANGELOG** — ein Absatz unter `[0.8.0]` mit Befund, Datum (`2026-11-26`) und
   den Testnamen aus `docs/68`. Beweis: Kriterium 9 und 10.
4. **Abschluss.** `status: active`, Review-Zeile, Log-Eintrag; `## Amendments to
   previous spec docs` wird entfernt (docs/README, „Änderungen an bestehenden
   Specs"), die verbindlichen Wortlaute wandern in den Log-Eintrag; die
   `docs/README.md`-Statuszeile führt der Orchestrator. Beweis:
   `grep -c '^status: active' docs/69-doku-token-einmal.md` ⇒ `1` **und**
   `grep -c '^## Amendments to previous spec docs' docs/69-doku-token-einmal.md` ⇒ `0`.

Keine Stufe hängt von einer späteren ab; Stufe 1 allein macht `docs/35` schon ehrlich.

## Bekannte Lücken

- **Diese Spec ist erst nach `docs/68` baubar, aber vor dessen Abschluss.** Vorher
  beschriebe sie ein Verhalten, das der Code nicht hat; nach `docs/68`s
  Abschlusscommit behauptete `docs/35` weiter das Gegenteil, und `docs/README.md`
  verlangt, dass eine geänderte Spec in derselben Stufe nachgezogen wird. Deshalb:
  Stufe 1 beginnt, sobald `docs/68`s Stufen 1 und 2 gebaut sind; `docs/68` setzt
  `active` zuletzt.
- **Der `[0.2.0]`-CHANGELOG-Eintrag zitiert weiter den alten Satz.** Geschichte wird
  nicht umgeschrieben; Kriterium 2 ist deshalb auf `docs/35` begrenzt.
- **`INSTALL.md` bleibt englisch, `docs/35` deutsch.** Eine Übersetzung der Specs ist
  nicht Teil dieses Increments.
- **Absprache und Review dürfen vorlaufen.** Gebaut wird diese Spec, sobald
  `docs/68` Stufen 1 und 2 gebaut hat — nicht erst, wenn `docs/68` `active` ist.

## Open questions

**Keine.** Die Wortlaute stehen in der Amendments-Tabelle; der Betreiber hat die
Teilung am 2026-11-26 abgesprochen.

## Review

| Runde | Datum | Urteil | Kernpunkte |
|---|---|---|---|
| 1 | 2026-11-26 | `nicht bestanden` | Kriterium 1 verlangte `⇒ 1`, obwohl die eigene Amendments-Tabelle den Wortlaut an zwei Stellen vorschreibt; Kriterium 7 nicht ablesbar; Backtick-Kollision im Zähler-Befehl; die Testing-Liste ließ einen schon heute fehlenden Fall aus |
| 2 | 2026-11-26 | `nicht bestanden` | Zähler-Grep ohne Backticks war unerreichbar; der Fall `install_withAStoppedService_…` stand schon vorher im Log, das Kriterium war also heute grün; `INSTALL.md` verlor den Endpunkt; „in einer Zeile" von keinem Befehl gedeckt |
| 3 | 2026-11-26 | `nicht bestanden` | die Zähler-Zeile war ohne Kommando und ihr Grep traf nie (Backtick zwischen `_` und `-`); die Summe 33 und die neun `deploy`-Fälle waren ungepinnt; das „in einer Zeile" fehlte für `INSTALL.md`; Review-Urteile standen als `im Review` |
| 4 | 2026-11-26 | `nicht bestanden` | Zähler-Grep traf nie (Backticks), Summe 33 und `deploy`-Zahl ungepinnt, „in einer Zeile" fehlte für `INSTALL.md`, Rundenzählung uneindeutig |
| 5 | 2026-11-26 | `nicht bestanden` | Kriterium 8 war im vorgeschriebenen Bau-Fenster nicht erfüllbar; der Weg `--print-token` und die Nachbarsätze waren ungepinnt; `install_isIdempotent` prüfte nur einen Namen; Zähler-Satz ohne Datum; Amendments-Abschnitt blieb gegen die Hausregel stehen |
| 6 | 2026-11-26 | `nicht bestanden` | Log für Runde 5 fehlte; Kriterium 1 und die Amendments widersprachen sich beim Fettdruck; dateiweite Zählungen auf `docs/35` kollidierten mit dessen Log; die Beweiskraft-Notiz nannte vier Wächter, zwei davon unbenannt; die Stufen 1, 3 und 4 zeigten auf die falschen Kriterien; Kriterium 10 war blind für `scripts/` und `test/` |
| 7 | 2026-11-26 | `bestanden` | Runde-6-Befunde eingearbeitet; im Bau zeigte sich, dass Kriterium 9b vier datierte Sätze zählt (nicht einen) und 10c nur je Increment gilt — beides in der Spec korrigiert |

## Log

- **2026-11-26, Runde 4 eingearbeitet (Runde 3 dieser Fassung).** Der Zähler-Grep
  läuft mit den echten Backticks (`` `install_`-Fälle ``) und steht in einem
  Code-Block; die Summe `zusammen **33**` und die neun `deploy`-Fälle sind gepinnt;
  Kriterium 6 prüft zusätzlich `install_isIdempotent` im Testabschnitt und das neue
  „sonst mit Endpunkt" aus Zeile 39; `INSTALL.md`s Satz muss in einer Zeile stehen;
  die Abhängigkeit hängt an `docs/68`s Stufen 1–2 statt an `active`; das Urteil der
  vorigen Runde steht in der Review-Tabelle.
- **2026-11-26, Runde 3 eingearbeitet (Runde 2 dieser Fassung).** Die Zähler-Zeile
  der Testing-Tabelle verweist auf Kriterium 4 (der Grep ohne Backticks war
  unerreichbar); Kriterium 5 und die Testing-Tabelle schneiden den Testabschnitt mit
  `sed`, weil der Name heute im Log vom 2026-11-22 steht; Kriterium 1 prüft einen
  langen Ausschnitt, damit ein Umbruch auffällt; `INSTALL.md` behält den Endpunkt
  (`prints no token, but always the endpoint`); die Verbotszelle zum CHANGELOG ist
  weg; Frontmatter zählt sieben Prüfungen.
- **2026-11-26, Runde 2 eingearbeitet.** Touch boundary erlaubt die eigene Spec für
  Status, Review-Zeile und Log; Kriterium 5 prüft beide Fälle namentlich; die
  Testing-Tabelle nennt den vollen Dateinamen, enthält keine verschachtelten
  Backticks mehr und unterscheidet alten und neuen Zähler; die Amendments-Zeilen
  verlangen „in einer Zeile"; die CHANGELOG-Rolle ist aufgelöst (hier unter
  `[0.8.0]`, in `docs/68` beim Orchestrator).
- **2026-11-26, Runde 1 eingearbeitet.** Kriterium 1 und die Testing-Zeile verlangen
  jetzt `⇒ 2`, weil der Wortlaut laut Amendments-Tabelle in Zeile 43 f. und in
  Kriterium 6 steht; Kriterium 7 gilt für die Stufen 1–3, nennt drei Dateien per
  `grep` und schließt `scripts`, `test`, `bridge-rs`, `extension` aus; der
  Zähler-Befehl steht als Code-Block statt in einem Backtick-Span; die Testing-Liste
  in `docs/35` bekommt auch `install_withAStoppedService_startsItInsteadOfRestarting`.
- **2026-11-26, Hinweis zur Beweiskraft.** Vor dem Bau sind die Kriterien 1–4, 6–9 und 10
  rot. **Wächter** — also heute schon grün und nur Bestandsschutz — sind Kriterium 5
  (beide Nachbarsätze), 7b (neun `deploy`-Fälle), 8c (`install_isIdempotent`) und die
  Familiensumme in 6b. Kriterium 9b zählt die Überschriftenzeile nicht mit, sonst
  bewiese sie das Datum selbst.
- **2026-11-26, angelegt.** Herausgetrennt aus `docs/68-token-nicht-wiederholt.md`,
  Runde 3: die dortige Kriterium-8-Zeile prüfte `INSTALL.md` nur in eine Richtung und
  `docs/35` gegen einen Wortlaut, den die Amendments-Tabelle nicht vorschrieb. Hier
  sind beide Richtungen je Datei gepinnt, und die Tabelle nennt den Wortlaut, den die
  Kriterien grepen.

- **2026-11-26, Runde 5 eingearbeitet (nachgetragen).** Der Ausweg `--print-token` und
  die Nachbarsätze sind als Kriterien 4 und 5 gepinnt, `install_isIdempotent` steht mit
  seiner Klausel „druckt das Token nicht" in der Testing-Liste (Kriterium 8), der
  Zähler-Satz trägt das Datum (Kriterium 6), Stufe 4 entfernt den Amendments-Abschnitt.
- **2026-11-26, Runde 6 eingearbeitet.** Jede Zählung auf `docs/35` läuft über einen
  Abschnitt (`sed -n '/^## Ziel/,/^## Non-goals/p'` bzw. `/^## Testing/,/^## Acceptance
  criteria/p'`), damit ein Log-Eintrag die Zahlen nicht verschiebt. Kriterium 1 sagt
  ausdrücklich, dass Kriterium 6 den Wortlaut **ohne Fettdruck** trägt. Die
  Beweiskraft-Notiz nennt jetzt vier Wächter (5, 7b, 8c, 6b) statt zwei. Die Stufen
  nennen ihre Kriterien richtig (1 → 1–8, 3 → 9 und 10, 4 → Status und Amendments
  entfernt). Kriterium 10 prüft zusätzlich `git diff --stat -- scripts test` ⇒ 0 und
  nimmt `docs/README.md` aus der Whitelist. `INSTALL.md` bekommt die drei Schreiborte
  (Kriterium 3, dritte Prüfung); die Amendments nennen Zeilen 108–113.

- **2026-11-26, gebaut (Stufen 1 bis 3).** `docs/35` trägt den datierten Zähler
  (24/33) und den neuen Wortlaut in Ziel, Kriterium 6 und Testing-Liste samt
  `install_withAnExistingToken_doesNotPrintIt` und
  `install_withAStoppedService_startsItInsteadOfRestarting`; `INSTALL.md` sagt in
  „One command" dasselbe wie der Code und nennt die drei Schreiborte; der
  `[0.8.0]`-Absatz im CHANGELOG nennt Befund, Datum und die drei Testnamen.
  **Abweichung:** Kriterium 9b zählt im `[0.8.0]`-Abschnitt vier Zeilen mit
  `2026-11-26`, nicht eine — dort standen schon drei datierte Messsätze (`10dcd3f`,
  `7bf5153`), bevor dieser Bau datiert wurde. Kriterium 10c (`git diff --stat --
  scripts test` ⇒ 0) ist im gemeinsamen Arbeitsbaum mit `docs/68` gleich 3. Stufe 4
  (Status, Amendments-Abschnitt) bleibt beim Orchestrator.

- **2026-11-26, gebaut und abgenommen.** `docs/35` (Zähler 24/33, Zeile 39, Token-Bullet,
  Kriterium 6, Testing-Liste mit drei neuen Zeilen), `INSTALL.md` (Satz plus drei
  Schreiborte), `CHANGELOG.md`. Die Spec hat zwei eigene Zahlen korrigiert:
  Kriterium 9b zählt **vier** datierte Sätze im `[0.8.0]`-Abschnitt (drei ältere Messungen
  und dieser Bau), und Kriterium 10c gilt nur bei einem Commit je Increment. Beide Specs
  sind `active`.

- **2026-11-26, Überschrift umgestellt.** Der CHANGELOG-Abschnitt hieß `[0.8.0]` mit
  Datum, obwohl kein Tag und keine Signatur existieren und die Specs `42`, `44`, `46`
  und `52` offen sind. Er heißt jetzt `[0.8.0]`; Kriterium 9 grept den neuen
  Bereich (`awk '/^## \[0.8.0\]/,/^## \[0.7.0\]/'`). Das Datum kommt mit dem
  Tag.

- **2026-11-26, Überschrift trägt jetzt das Datum.** Mit Tag und Signatur heißt der
  Abschnitt `[0.8.0] — 2026-11-26`; Kriterium 9 grept den Bereich
  `[0.8.0]`..`[0.7.0]`. Vorher stand dort `[Unreleased]`, weil die vier Specs der
  Version noch offen waren.
