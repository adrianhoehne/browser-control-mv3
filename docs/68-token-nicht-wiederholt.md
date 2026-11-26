---
description: Das Installationsskript druckt das Token nur, wenn es in diesem Lauf entstanden ist; liegt schon eines, nennt Schritt 5 den Weg --print-token mit absolutem Pfad statt der Zeichenfolge.
status: active
---

# Das Token erscheint einmal, nicht bei jedem Lauf

## Anlass

`scripts/install.sh` trägt im Kopf den Satz „The token is printed exactly once, on
stdout, and never handed to another program as an argument" (Zeile 21 f.). Der Code
hält das nicht ein. `cmd_install` liest in Schritt 5 den Wert und druckt ihn, ohne zu
fragen, ob er in diesem Lauf entstanden ist:

```bash
  step "5/5 Token und Endpunkt für Firefox"
  value=$(read_token_value)
  say "Endpunkt: ws://127.0.0.1:$EXTENSION_PORT"
  say "Token (erscheint hier genau einmal, jetzt einfügen): $value"
```

`ensure_token` meldet in Schritt 2 „Token bleibt unverändert: <pfad>", lässt die
Datei stehen und kehrt zurück; Schritt 5 druckt die Zeichenfolge trotzdem.

Gemessen am 2026-11-26 auf dieser Maschine (`$HOME` des Betreibers, Aufruf
`bash scripts/install.sh` aus dem Repo, Token lag vorher vor):

| Lauf | Schritt 2 | Schritt 5 |
|---|---|---|
| erster Lauf, vorhandenes Token | `Token bleibt unverändert` | Token im Klartext auf stdout |
| zweiter Lauf über dasselbe Token (nach dem Neuinstallieren des Binaries) | `Token bleibt unverändert` | Token im Klartext auf stdout |

Beide Läufe sind Reparaturläufe: das Token war älter als der Lauf.

Folgen:

1. **Ein Betreiber-Log wird zum Geheimnis.** Wer die Ausgabe in eine Datei, in ein
   Ticket oder in ein Sitzungsprotokoll schreibt, hat den Token dort.
2. **Der Agent sieht ihn.** Ein Agent, der `scripts/install.sh` aufruft, liest den
   Token und muss ihn aus seinem Verlauf löschen lassen; gedruckt ist gedruckt.
3. **Die Zusage im Kopf der Datei ist falsch.** Ein Kommentar, der lügt, ist
   schlimmer als keiner.

Die Anleitung `INSTALL.md` und `docs/35` beschreiben dasselbe falsche Verhalten. Sie
ziehen in `docs/69-doku-token-einmal.md` nach; diese Spec ändert nur den Code.

## Ziel

1. **Das Token erscheint nur, wenn es in diesem Lauf entstanden ist.** Ein Lauf,
   der ein vorhandenes Token vorfindet, druckt den Wert nicht.
2. **Der Weg zum Token bleibt offen und benannt.** Schritt 5 nennt
   `$REPO_ROOT/scripts/install.sh --print-token`, mit absolutem Pfad wie im
   Firefox-Block darunter bei `manifest.json`.
3. **Der Kopfkommentar sagt die Wahrheit:** einmal beim Anlegen, danach nur mit
   `--print-token`.
4. **`--print-token` bleibt unverändert.** Es ist die ausdrückliche Frage und gibt
   den Wert weiter aus.
5. **Ein Test hält es fest.** Ein Fall mit vorhandenem Token prüft, dass die
   Zeichenfolge **nicht** in stdout steht. Dass der Satz den absoluten Pfad trägt,
   prüft Kriterium 6 direkt am Quelltext: die Tests rufen das Skript immer mit
   absolutem Pfad auf, ein Testfall könnte `$REPO_ROOT` von `$SCRIPT_PATH` also
   nicht unterscheiden.

## Der Vertrag

| Feld | Regel |
|---|---|
| Datei | `scripts/install.sh`: `ensure_token` und `cmd_install` |
| Zustand | `TOKEN_CREATED=0` am Anfang von `cmd_install`; `ensure_token` setzt `1`, wenn es das Token in diesem Lauf anlegt |
| Lesen in Schritt 5 | bei `TOKEN_CREATED=0` ruft Schritt 5 `read_token_value` nicht auf. `ensure_token` liest und prüft das vorhandene Token weiterhin |
| Ausgabe bei neuem Token | der Wert einmal, mit dem Satz `Token neu angelegt, jetzt einfügen (später nur mit --print-token): $value` |
| Ausgabe in Schritt 2 | unverändert: `Token bleibt unverändert: $TOKEN_FILE` — an dieser Zeile hängt `install_withAnExistingToken_doesNotTouchIt` |
| Ausgabe in Schritt 5 bei vorhandenem Token | kein Wert, stattdessen `Token unverändert (nicht gedruckt). Zum Einfügen: $REPO_ROOT/scripts/install.sh --print-token` |
| Pfad im Satz | `$REPO_ROOT/scripts/install.sh`, weil `REPO_ROOT` absolut ist (Zeile 33); **nicht** `$SCRIPT_PATH`, das nur `BASH_SOURCE[0]` spiegelt und relativ bleibt |
| Kopfkommentar | eine Zeile, ungebrochen: `printed once, when it is created; otherwise only with --print-token` |
| Fehlerfall | Token unlesbar oder zu kurz: `die 2` mit dem vorhandenen Text, kein Wert auf stdout. Zu offene Rechte (nicht 600): unverändert nur ein Hinweis auf stderr, Exit 0 (`docs/35`, Kriterium 14) |
| `--print-token` | unverändert: genau der Dateiinhalt, nichts weiter (`docs/35`, Kriterium 6) |
| `--uninstall` | unverändert: druckt kein Token, lässt es stehen |
| `--dry-run` | unverändert: läuft nicht durch `cmd_install`, druckt nie einen Wert; `--dry-run --print-token` bleibt der Sonderfall aus `docs/35`, Kriterium 3 |

Die Schritt-Überschrift bleibt `5/5 Token und Endpunkt für Firefox`; sie nennt
beides, auch wenn der Wert nicht erscheint.

## Non-goals

- **Keine Rotation.** Das Skript legt weiterhin kein neues Token an, wenn eines
  liegt, und dreht keines (`docs/35`; Rotation ist Handarbeit nach `INSTALL.md`).
- **Kein neuer Modus.** `--print-token` genügt; kein `--token`-Flag, keine
  Umgebungsvariable.
- **Keine Änderung an `--print-token`s Ausgabe.** Sie ist die Antwort auf eine
  ausdrückliche Frage.
- **Kein Maskieren.** Ein neu angelegtes Token wird vollständig gedruckt; der
  Betreiber muss es eintragen können.
- **Keine Doku in diesem Increment.** `docs/35`, `INSTALL.md` und der CHANGELOG-
  Absatz gehören zu `docs/69`; hier zählt nur das Binary-Verhalten.
- **Keine Änderung an Unit, Binary, Ports oder an der Reihenfolge der fünf
  Schritte.**

## Touch boundary

| Erlaubt | Nicht erlaubt |
|---|---|
| `scripts/install.sh` (`ensure_token`, `cmd_install`, Kopfkommentar) | `bridge-rs/**`, `extension/**`, `scripts/parity/**` |
| `test/install.test.js` (ein neuer Fall, je eine Zusicherung in `install_isIdempotent` und `install_printsTheTokenOnce`) | `test/deploy.test.js` |
| `docs/68-token-nicht-wiederholt.md`, aber nur Frontmatter-Status, Review-Zeile und Log-Eintrag (Stufe 3) | andere Dateien unter `docs/**` und `INSTALL.md` (gehören zu `docs/69`), `docs/README.md` (Orchestrator) |
| — | `CHANGELOG.md` (schreibt `docs/69`, Stufe 3; hier bleibt er liegen) |
| — | neue Abhängigkeiten, neue Flags, Änderungen an der Unit |

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/install.test.js` | `install_withAnExistingToken_doesNotPrintIt` **neu** | bei vorhandenem Token steht die Zeichenfolge nicht in stdout, und die Zeile nennt `--print-token` |
| `test/install.test.js` | `install_isIdempotent` **bestehend, eine Zusicherung ergänzt** | der zweite Lauf über dasselbe Token druckt den Wert ebenfalls nicht |
| `test/install.test.js` | `install_withAnExistingToken_doesNotTouchIt` **bestehend, bleibt grün** | Datei byte-gleich, Rechte und mtime unverändert |
| `test/install.test.js` | `install_printsTheTokenOnce` **bestehend, eine Zusicherung ergänzt** | beim Anlegen erscheint der Wert genau einmal und an keiner zweiten Stelle; die Zeile trägt den Zusatz `später nur mit --print-token` |
| `test/install.test.js` | `install_printTokenPrintsOnlyTheToken` **bestehend, bleibt grün** | `--print-token` gibt weiter genau den Dateiinhalt aus |
| `test/install.test.js` | `install_dryRunWritesNothing` **bestehend, bleibt grün** | der Trockenlauf druckt keinen Wert |
| `test/install.test.js` | `install_withLooseTokenPermissions_reportsWithoutFixing` **bestehend, bleibt grün** | zu offene Rechte bleiben ein Hinweis, kein Abbruch |
| `test/install.test.js` | `install_withTooShortToken_exitsTwo` **bestehend, bleibt grün** | Exit 2 mit Pfad in stderr, Tokendatei byte-gleich |

Ein Fall, der die Zeichenfolge nur in `stderr` sucht, genügt nicht: `say` schreibt
auf stdout, und der Fehler war genau dort.

## Acceptance criteria

1. **Der Befund wird ein Fall:**
   `npm test 2>&1 | grep -cE '^ok [0-9]+ - install_withAnExistingToken_doesNotPrintIt'`
   ⇒ `1`.
2. **Der zweite Lauf ist gedeckt:**
   `sed -n '/install_isIdempotent/,/^});/p' test/install.test.js | grep -cF 'countOccurrences(second.stdout, token), 0'`
   ⇒ `1`, und der Fall ist grün.
3. **Das Anlegen bleibt laut:**
   `npm test 2>&1 | grep -cE '^ok [0-9]+ - install_printsTheTokenOnce'` ⇒ `1`.
4. **`--print-token` bleibt:**
   `npm test 2>&1 | grep -cE '^ok [0-9]+ - install_printTokenPrintsOnlyTheToken'`
   ⇒ `1`.
5. **Die Fehlerpfade bleiben:**
   `npm test 2>&1 | grep -cE '^ok [0-9]+ - install_(withTooShortToken_exitsTwo|withAShortButUsableToken_keepsGoing|withLooseTokenPermissions_reportsWithoutFixing)'`
   ⇒ `3`.
6. **Der Kommentar stimmt, in einer Zeile, und der Satz trägt den absoluten Pfad:**
   `grep -cF 'printed once, when it is created; otherwise only with --print-token' scripts/install.sh`
   ⇒ `1` (ein Grep über den ganzen Satz beweist auch, dass er nicht umbrochen ist);
   `grep -cF 'printed exactly once, on stdout' scripts/install.sh` ⇒ `0`;
   `grep -cF 'never handed to another' scripts/install.sh` ⇒ `1` (die zweite Hälfte
   der alten Zusage bleibt; sie darf nicht mit der ersten verschwinden);
   `grep -cF 'Zum Einfügen: $REPO_ROOT/scripts/install.sh --print-token' scripts/install.sh`
   ⇒ `1` (pinnt die Shell-Expansion, nicht nur „irgendein absoluter Pfad").
7. **Gesamtlauf grün:** `npm test` ⇒ `# pass 585`, `# fail 0`, `# cancelled 0`
   (am 2026-11-26 auf dieser Maschine gemessen: 584; der neue Fall zählt eins
   dazu. Auf einem Host, der Testfälle überspringt, gilt `# pass` plus `# skipped`
   = 585). `npm run check` ⇒ Exit 0.

## Dev plan

1. **Zustand und Ausgabe in einem Zug.** `cmd_install` setzt `TOKEN_CREATED=0`,
   `ensure_token` setzt `1` beim Anlegen, Schritt 5 druckt nur dann den Wert und
   ruft `read_token_value` sonst nicht auf; der Satz bei vorhandenem Token nennt
   `$REPO_ROOT/scripts/install.sh --print-token`; Kopfkommentar als eine Zeile auf
   den neuen Wortlaut. Beweis: `install_withAnExistingToken_doesNotPrintIt` (neu)
   und `install_printsTheTokenOnce` (bleibt grün), dazu Kriterium 6.
2. **Den zweiten Lauf decken.** In `install_isIdempotent` das Token aus der Datei
   lesen und im zweiten stdout zählen:

   ```js
   const token = fs.readFileSync(tokenPath, "utf8").trim();
   assert.equal(countOccurrences(second.stdout, token), 0, second.stdout);
   ```

   Beweis: der Fall ist grün, Kriterium 2 und 7.
3. **Abschluss.** `status: active` im Frontmatter, die Review-Zeile auf das Urteil
   der letzten Runde, der Log-Eintrag mit Datum (CONTRIBUTING, Schritt 7); die
   `docs/README.md`-Statuszeile führt der Orchestrator. Beweis:
   `grep -c '^status: active' docs/68-token-nicht-wiederholt.md` ⇒ `1`.

Stufe 1 ist ohne Stufe 2 prüfbar (der neue Fall braucht die Zusicherung aus Stufe 2
nicht); Stufe 3 schließt ab. Keine Stufe greift einer späteren vor.

## Bekannte Lücken

- **Bis `docs/69` gebaut ist, sagen `docs/35` und `INSTALL.md` noch das alte
  Verhalten.** Das ist bewusst: der Code wird zuerst ehrlich, die Anleitung folgt im
  nächsten Increment. `docs/69` ist Pflicht-Folge und gehört in dieselbe Sitzung;
  wer die zwei Dokumente früher anfasst, nimmt es vorweg.
- **Der Mensch bleibt in der Kette.** Wer den Token braucht, holt ihn mit
  `--print-token`; das Skript kann nicht wissen, ob jemand zusieht.
- **Ein Agent, der `--print-token` aufruft, sieht ihn weiterhin.** Absicht: der
  Aufruf ist eine ausdrückliche Frage. Wer das verhindern will, braucht eine Regel
  im Harness, nicht im Skript.
- **Bricht ein Lauf nach dem Anlegen ab** (etwa in Schritt 3 oder 4), hat der
  Betreiber ein Token, das er nie gesehen hat. Das ist heute schon so und bleibt so:
  ein zweiter Lauf findet es vor und druckt es nicht mehr. Der Weg heraus ist
  `--print-token`.
- **Die Rotation bleibt Handarbeit.** Ein Skript, das Token dreht, gibt es nicht
  und soll es nicht geben (`docs/35`).

## Open questions

**Keine.** Ziel, Vertrag und Kriterien hat der Betreiber am 2026-11-26 abgesprochen;
die Ablage der Doku in `docs/69` ist Teil dieser Absprache.

## Review

Die ersten drei Runden gehören zur ungeteilten Spec; ab `4` zählt die geteilte
Fassung neu, die Klammer nennt die Runde dieser Fassung.

| Runde | Datum | Urteil | Kernpunkte |
|---|---|---|---|
| 1 | 2026-11-26 | `nicht bestanden` | zwei erfundene Testnamen, fehlende Amendments, `INSTALL.md` fehlte, keine Touch boundary, Stufe 1 ohne eigenen Beweis, drei Kriterien ohne Kommando |
| 2 | 2026-11-26 | `nicht bestanden` | `$SCRIPT_PATH` ist relativ, „zu offene Rechte ⇒ `die 2`" bricht `docs/35`, kein Kriterium für die Doku, Kriterium 6 prüfte ein Zeilenfenster |
| 3 | 2026-11-26 | `nicht bestanden` | Kriterium 8 prüfte `INSTALL.md` nur in eine Richtung; zwei Blöcke zu viel für eine Spec ⇒ **geteilt**: Verhalten hier, Doku in `docs/69-doku-token-einmal.md` |
| 4 (1) | 2026-11-26 | `nicht bestanden` | Touch boundary verbot die eigene Abschlussstufe unter `docs/**`; Kriterien 3–5 nannten keinen `grep`; Kriterium 6 bewies die „eine Zeile" nicht; die Testing-Zeile zum kurzen Token versprach eine Prüfung, die der Fall nicht hat |
| 5 (2) | 2026-11-26 | `nicht bestanden` | der Halbsatz „Aufruf wie in `INSTALL.md`" stand in Ziel 5 wieder, und `$REPO_ROOT` war von `$SCRIPT_PATH` durch keinen Test zu unterscheiden; Kriterium 2 grün ohne die Zusicherung; CHANGELOG-Rolle widersprüchlich; Kriterium 6 ließ die zweite Hälfte der alten Zusage verschwinden; der neue Anlege-Satz war ungeprüft |
| 6 (3) | 2026-11-26 | `nicht bestanden` | B1 Zähler-Grep ohne Kommando, B2 Fall stand schon vorher im Log, B3 Halbsatz in Ziel 5 wieder da, M4 CHANGELOG-Rolle, M5 Kriterium 2 zu schwach, M7 „in einer Zeile" ungedeckt |
| 7 (4) | 2026-11-26 | `bestanden` | Gate offen; M1 bis M4 als Nachlauf eingearbeitet, siehe Log |

## Log

- **2026-11-26, Runde 1 eingearbeitet.** Testnamen richtiggestellt, Amendments-Abschnitt
  ergänzt, `INSTALL.md` in den Änderungssatz, Touch boundary, Stufen getrennt,
  Kriterien mit Kommando.
- **2026-11-26, Runde 2 eingearbeitet.** `$REPO_ROOT/scripts/install.sh` statt
  `$SCRIPT_PATH`; zu offene Rechte bleiben ein Hinweis mit Exit 0; Kriterium 6 in
  beide Richtungen und ohne Zeilenfenster; Kriterium 2 auf die Richtung gepinnt; das
  Zitat lautet „another program as an argument"; Abschlussstufe für
  `status: active`; Review-Zeile ohne behauptetes Ergebnis.
- **2026-11-26, Runde 3: geteilt.** Nach dem dritten Block verlangt
  `CONTRIBUTING.md` (Schritt 4) die Teilung, nicht das Durchwinken. Die Doku-Seite
  (Kriterium 8 der alten Fassung, `docs/35`, `INSTALL.md`, CHANGELOG) steht jetzt in
  `docs/69-doku-token-einmal.md`. Diese Spec behält Code, Test und sieben Kriterien
  und nennt die zwei Punkte, die Runde 3 sonst noch fand: die Zusicherung in
  `install_isIdempotent` steht jetzt ausgeschrieben im Dev plan, und der Kommentar
  muss in einer Zeile stehen.

- **2026-11-26, Hinweis zur Beweiskraft.** Die Kriterien 3, 4, 5 und der Sub-Grep
  `never handed to another` aus 6 sind heute schon grün: sie sind Regressionswächter,
  kein Beleg für den neuen Zustand. Rot sind heute 1, 2, 6a, 6b, 6d und 7.
- **2026-11-26, Runde 6 eingearbeitet (Runde 4 der Fassung): bestanden.** Nachlauf
  eingearbeitet: Schritt 2 behält seine Meldung `Token bleibt unverändert: <pfad>`
  (der Vertrag nennt sie jetzt ausdrücklich, damit niemand die zwei Meldungen
  vereinheitlicht und dabei einen geschützten Fall rot macht); Log und Review
  tragen die Urteile der letzten Runden; der Log unterscheidet Wächter von Beleg.
- **2026-11-26, Runde 5 eingearbeitet (Runde 2 der geteilten Fassung).** Der Halbsatz
  „Aufruf wie in `INSTALL.md`" ist aus Ziel 5 gestrichen; der absolute Pfad wird jetzt
  direkt am Quelltext geprüft (`$REPO_ROOT/scripts/install.sh --print-token`), weil
  die Tests immer absolut aufrufen. Kriterium 2 grept die volle Zusicherung.
  Kriterium 6 prüft zusätzlich, dass die zweite Hälfte der alten Zusage bleibt, und
  `install_printsTheTokenOnce` trägt die Zusicherung `später nur mit --print-token`.
  CHANGELOG gehört `docs/69`; die Zählung der geteilten Fassung steht in der
  Review-Tabelle; „drei Zeilen weiter unten" heißt jetzt „im Firefox-Block darunter".
  `docs/69` ist in den Bekannten Lücken als Pflicht-Folge derselben Sitzung benannt.
- **2026-11-26, Runde 4 eingearbeitet.** (Erste Runde nach der Teilung; die Zählung
  beginnt für diese Fassung neu.) Touch boundary erlaubt die eigene Spec für Status,
  Review-Zeile und Log; `docs/README.md` ausdrücklich als Orchestrator; Kriterien
  3–5 mit `grep -cE` und gepinnter Zahl; Kriterium 6 grept den ganzen Satz in einem
  Stück; die Testing-Zeile zum zu kurzen Token behauptet keine `stdout`-Prüfung mehr;
  der Halbsatz „auch wenn der Installer mit `./scripts/install.sh` aufgerufen wird"
  ist gestrichen, weil `runInstall()` immer einen absoluten Pfad übergibt;
  `docs/README.md` steht in Stufe 3 als Orchestrator-Aufgabe; CHANGELOG-Rolle in der
  Touch boundary aufgelöst.

- **2026-11-26, gebaut (Stufen 1 und 2).** `cmd_install` setzt `TOKEN_CREATED=0`,
  `ensure_token` setzt `1` beim Anlegen; Schritt 5 ruft `read_token_value` nur dann
  auf, zeigt den Wert mit `später nur mit --print-token` und nennt sonst
  `$REPO_ROOT/scripts/install.sh --print-token`. Der Kopfkommentar steht in einer
  Zeile und behält die zweite Hälfte der alten Zusage. Fälle:
  `install_withAnExistingToken_doesNotPrintIt` neu; je eine Zusicherung in
  `install_isIdempotent` und `install_printsTheTokenOnce`. Gemessen: `npm test`
  584 → 585 `pass`, `# fail 0`, `# cancelled 0`; `node --test test/install.test.js`
  24 `pass`; `npm run check`, `cargo test` und `scripts/parity.sh --impl rust
  --check` mit Exit 0. `status: active` setzt der Orchestrator (Stufe 3).

- **2026-11-26, gebaut und abgenommen.** `TOKEN_CREATED` eingezogen, Schritt 5 druckt den
  Wert nur beim Anlegen und nennt sonst `$REPO_ROOT/scripts/install.sh --print-token`;
  Kopfkommentar in einer Zeile. Neuer Fall `install_withAnExistingToken_doesNotPrintIt`,
  Zusicherungen in `install_isIdempotent` und `install_printsTheTokenOnce`. `npm test`
  584 → **585** (24 `install_`-Fälle), `cargo test` 15 Blöcke, `parity --check` 7/7,
  `npm run check` 0. Spec auf `active` gesetzt.
