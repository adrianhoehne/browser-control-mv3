---
description: docs/35 und INSTALL.md sagen nach docs/68 dasselbe wie der Code — das Token erscheint beim Anlegen einmal, ein Reparaturlauf nennt nur --print-token; sieben grep-Prüfungen decken beide Richtungen ab.
status: proposed
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
| `docs/35` | Kriterium 6 | derselbe Wortlaut wie Zeile 43 f.: „beim Anlegen genau einmal", ebenfalls in einer Zeile |
| `docs/35` | Zeile 44 f. | der Folgesatz bleibt: „Nicht in einer Datei außer der Tokendatei … nicht in einer Logzeile des Skripts." |
| `docs/35` | Zeile 39 | „… — beim Anlegen mit Endpunkt und Token, sonst mit Endpunkt und dem Hinweis auf `--print-token`." |
| `docs/35` | Zeile 26 | der datierte Satz vom 2026-11-17 bleibt; darunter ein neuer datierter Satz: „**Stand 2026-11-26, nachgezogen aus `docs/68`:** **24 `install_`-Fälle**, zusammen **33**" |
| `docs/35` | `## Testing` | Liste mit `install_withAnExistingToken_doesNotPrintIt`, mit `install_isIdempotent` samt der Klausel „der zweite Lauf druckt das Token nicht" und mit `install_withAStoppedService_startsItInsteadOfRestarting` — der steht heute nur im Log vom 2026-11-22, nicht in der Testing-Liste |
| `INSTALL.md` | Zeilen 108–112 | „It writes the token only if there is none. A run that finds one prints no token, but always the endpoint; `scripts/install.sh --print-token` prints the token." — der gepinnte Satz steht in einer Zeile |
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
`## Acceptance criteria`. Sie decken beide Richtungen ab: der neue Satz steht da,
der alte nicht.

| Prüfung (Datei `docs/35` = `docs/35-installationsskript.md`) | Was sie beweist |
|---|---|
| `grep -cF 'beim Anlegen genau einmal' docs/35-installationsskript.md` ⇒ `2` | der neue Satz steht an beiden Stellen (Zeile 43 f. und Kriterium 6), je in einer Zeile |
| `grep -cF 'Das Token erscheint genau einmal' docs/35-installationsskript.md` ⇒ `0` | der alte Satz ist weg, nicht nur ergänzt |
| `grep -cF 'prints the endpoint and the token' INSTALL.md` ⇒ `0` | die englische Lüge ist weg |
| `grep -cF 'A run that finds one prints no token' INSTALL.md` ⇒ `1` | der neue englische Satz steht da |
| `` ``grep -cF '`install_`-Fälle' docs/35-installationsskript.md`` `` ⇒ `2` | alter datierter Satz mit 22 bleibt, neuer mit 24 steht daneben; keiner ist überschrieben |
| `grep -cF 'install_withAnExistingToken_doesNotPrintIt' docs/35-installationsskript.md` ⇒ `1` | der neue Fall steht in der Testing-Liste |
| `sed -n '/^## Testing/,/^## Acceptance criteria/p' docs/35-installationsskript.md \| grep -cF 'install_withAStoppedService_startsItInsteadOfRestarting'` ⇒ `1` | der Fall steht in der Testing-Liste, nicht nur im Log vom 2026-11-22 |

## Acceptance criteria

1. **Der neue Satz in `docs/35` steht an beiden Stellen und in einer Zeile:** der
   Wortlaut steht laut Amendments-Tabelle in Zeile 43 f. **und** in Kriterium 6,
   `grep -c` zählt Zeilen. Der lange Ausschnitt beweist zusätzlich, dass der Satz
   nicht umbrochen ist:

   ```
   grep -cF 'beim Anlegen genau einmal' docs/35-installationsskript.md          # ⇒ 2
   grep -cF 'beim Anlegen genau einmal**; ein Reparaturlauf druckt es nicht' \
     docs/35-installationsskript.md                                             # ⇒ 1
   ```
2. **Der alte Satz ist weg:**
   `grep -cF 'Das Token erscheint genau einmal' docs/35-installationsskript.md` ⇒ `0`.
3. **`INSTALL.md`, beide Richtungen:**
   `grep -cF 'prints the endpoint and the token' INSTALL.md` ⇒ `0` **und**
   `grep -cF 'A run that finds one prints no token, but always the endpoint' INSTALL.md`
   ⇒ `1`.
4. **Der Ausweg bleibt genannt, in beiden Dokumenten:**

   ```
   sed -n '/^## Testing/,/^## Acceptance criteria/p' docs/35-installationsskript.md \
     | grep -cF 'druckt das Token nicht'                          # ⇒ 1
   grep -cF 'und nennt `--print-token`' docs/35-installationsskript.md   # ⇒ 1
   grep -cF 'scripts/install.sh --print-token` prints the token' INSTALL.md  # ⇒ 1
   ```

5. **Die Nachbarsätze bleiben, sonst wäre die Ersetzung eine Löschung:**

   ```
   grep -cF 'installs the user unit' INSTALL.md                    # ⇒ 1
   grep -cF 'einer Logzeile des Skripts' docs/35-installationsskript.md  # ⇒ 1
   ```

6. **Der Zähler:**

   ```
   grep -cF '24 `install_`-Fälle' docs/35-installationsskript.md   # ⇒ 1
   npm test 2>&1 | grep -cE '^ok [0-9]+ - install_'                 # ⇒ 24
   ```

   Der alte datierte Satz mit „22 `install_`-Fälle" bleibt stehen. Beide Zähler
   zusammen prüft:

   ```
   grep -cF '`install_`-Fälle' docs/35-installationsskript.md   # ⇒ 2 (heute 1)
   grep -cF 'Stand 2026-11-26, nachgezogen aus' docs/35-installationsskript.md  # ⇒ 1
   ```

7. **Die Summe und die Fremdzahl:**

   ```
   grep -cF 'zusammen **33**' docs/35-installationsskript.md    # ⇒ 1
   grep -cE '^test\(' test/deploy.test.js                        # ⇒ 9
   ```

8. **Beide Fälle und beide Zusagen stehen in der Testing-Liste:**
   `grep -cF 'install_withAnExistingToken_doesNotPrintIt' docs/35-installationsskript.md`
   ⇒ `1`; `sed -n '/^## Testing/,/^## Acceptance criteria/p' docs/35-installationsskript.md | grep -cF 'install_withAStoppedService_startsItInsteadOfRestarting'`
   ⇒ `1` (der Name steht heute nur im Log vom 2026-11-22); dazu
   `sed -n '/^## Testing/,/^## Acceptance criteria/p' docs/35-installationsskript.md | grep -cF 'install_isIdempotent'`
   ⇒ mindestens `1` und
   `grep -cF 'sonst mit Endpunkt und dem Hinweis auf' docs/35-installationsskript.md`
   ⇒ `1` (Zeile 39, heute `0`).
9. **Der CHANGELOG nennt den neuen Fall und das Datum:**
   `awk '/^## \[0.8.0\]/,/^## \[0.7.0\]/' CHANGELOG.md | grep -cF 'install_withAnExistingToken_doesNotPrintIt'`
   ⇒ `1` **und** derselbe Bereich mit `grep -cF '2026-11-26'` ⇒ mindestens `1`.
10. **Nichts anderes bewegt** (gilt für die Stufen 1–3, vor dem Abschluss):
   `git status --short | grep -cE '(docs/35-installationsskript\.md|INSTALL\.md|CHANGELOG\.md)$'`
   ⇒ `3`, und nichts außerhalb der Whitelist:
   `git status --short | grep -vE '(docs/35-installationsskript\.md|INSTALL\.md|CHANGELOG\.md|docs/6[89]-[a-z-]+\.md|docs/README\.md|scripts/install\.sh|test/install\.test\.js)$'`
   ⇒ keine Ausgabe. `scripts/install.sh` und `test/install.test.js` stehen in der
   Whitelist, weil sie zu `docs/68` gehören und in dessen Bau-Fenster noch nicht
   committet sind. Dazu `npm run check` ⇒ Exit 0 und `npm test` ⇒ `# fail 0`.

## Dev plan

1. **`docs/35` nach der Amendments-Tabelle umschreiben** — Zeile 43 f. und Kriterium
   6 mit demselben Wortlaut, Zeile 39, ein neuer datierter Zähler unter Zeile 26, die
   Testing-Liste. Beweis: Kriterien 1, 2, 4 und 5.
2. **`INSTALL.md` umschreiben** — Abschnitt „One command", Zeilen 108–112. Beweis:
   Kriterium 3.
3. **CHANGELOG** — ein Absatz unter `[0.8.0]` mit Befund, Datum (`2026-11-26`) und
   den Testnamen aus `docs/68`. Beweis: Kriterium 6 und 7.
4. **Abschluss.** `status: active`, Review-Zeile, Log-Eintrag; `## Amendments to
   previous spec docs` wird entfernt (docs/README, „Änderungen an bestehenden
   Specs"), die verbindlichen Wortlaute wandern in den Log-Eintrag; die
   `docs/README.md`-Statuszeile führt der Orchestrator. Beweis: Kriterien 6, 7, 8, 9
   und `grep -c '^status: active' docs/69-doku-token-einmal.md` ⇒ `1`.

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
| 6 | 2026-11-26 | im Review | Runde-5-Befunde eingearbeitet, siehe Log |

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
- **2026-11-26, Hinweis zur Beweiskraft.** Kein Kriterium dieser Spec ist heute grün;
  alle sind vor dem Bau rot. Zwei **Wächter** sind es doch: die neun `deploy`-Fälle
  und `install_isIdempotent` im Testabschnitt — sie halten Bestehendes, sie beweisen
  den neuen Zustand nicht.
- **2026-11-26, angelegt.** Herausgetrennt aus `docs/68-token-nicht-wiederholt.md`,
  Runde 3: die dortige Kriterium-8-Zeile prüfte `INSTALL.md` nur in eine Richtung und
  `docs/35` gegen einen Wortlaut, den die Amendments-Tabelle nicht vorschrieb. Hier
  sind beide Richtungen je Datei gepinnt, und die Tabelle nennt den Wortlaut, den die
  Kriterien grepen.
