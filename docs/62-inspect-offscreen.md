---
description: Jedes Element aus browser_inspect trägt offscreen — true, wenn sein rect den sichtbaren Bereich nicht schneidet, in beiden Quellen der Antwort; Teil b der Teilung vom 2026-11-23.
status: active
---

# `inspect` sagt, wo der Treffer liegt — Teil b

**Geteilt am 2026-11-23** von der Vorgänger-Spec (Runde 4 des Gates, vierter
Block). **Teil a** (`docs/57`) regelt, *welche* Treffer `inspect` liefert. Diese
Spec regelt, ob die Antwort sagt, **wo** ein Treffer liegt.

## Anlass

Eine Messung vom 2026-11-23 aus dem 9B-Lauf 16:33
(`2026-11-23_conversations.zip`).

`browser_inspect({selector:"button, a", text:"Einkaufswagen"})` lieferte
`a#nav-assist-cart` mit `visible: true` und
`rect: {"x": -9966, "y": 202, "width": 353, "height": 41}`. Der Treffer liegt weit
außerhalb der Seite, und nichts in der Antwort sagte das. Das Modell klickte ihn
(der Vorgang steht in `docs/56`).

**Ursache.** `isVisible` (`extension/page-agent.js:55-62`) prüft Fläche, `display`
und `visibility` — die Lage nicht. `described` liefert `rect`, aber keine Deutung.

## Ziel

1. Jedes Element der Antwort bekommt **`offscreen`**: `true`, wenn sein `rect` den
   sichtbaren Bereich nicht schneidet, sonst `false`.
2. Ein Element außerhalb des Sichtfelds bleibt `visible: true` — das ist die
   Wahrheit über `display`. `offscreen` ist die Wahrheit über die Lage.
3. **Ein Element ohne Fläche hat `offscreen: false`.** „Außerhalb" behauptet eine
   Lage, und ein Element ohne Fläche hat keine. `visible: false` sagt bereits
   alles.
4. Das Feld steht in **beiden** Quellen: `inspectPageSource` (`:730`) und
   `inspectShadowPageSource` (`:964-1167`). Sonst liefert ein Schatten-Treffer eine
   andere Feldmenge als ein Dokument-Treffer — und
   `inspect_withAShadowHit_shouldDeliverTheSameFieldSetAsADocumentHit` (`:10921`)
   prüft genau das.

## Der Vertrag

| Feld | Regel |
|---|---|
| `elements[].offscreen` | **neu**, `true`/`false`, immer gesetzt, in beiden Quellen; `false` bei Fläche 0 |
| alles andere | unverändert |

## Non-goals

- **Keine Engste-Regel.** Das ist `docs/57`.
- **Kein `offscreen` in `read`.** `read` liefert Text, keine Elemente.
- **Keine Sortierung nach Lage.** Dokumentreihenfolge bleibt die Ordnung.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `inspect_withAnElementOutsideTheViewport_shouldSetOffscreenTrue` | `x = -9966` ⇒ `true`, Element im Bild ⇒ `false` |
| `test/extension.test.js` | `inspect_withAnElementWithoutArea_shouldSetOffscreenFalse` | Fläche 0 ⇒ `false`, `visible: false` bleibt |
| `test/extension.test.js` | `inspect_withASelectorOnTheLink_shouldAnswerEveryFieldOfTheContract` (bestehend, `:10199`) | der Feldvertrag **mit** `offscreen`, von elf auf zwölf Felder |
| `test/extension.test.js` | `inspect_withAShadowHit_shouldDeliverTheSameFieldSetAsADocumentHit` (bestehend, `:10921`) | beide Quellen liefern dasselbe Feldset, `length` 11 → 12 (`:10940`) |
| `bridge-rs/tests/mcp.rs` | `help_forInspect_shouldNameEveryElementField` | die Anleitung nennt das Feld (Dateikonvention `help_…`) |

## Acceptance criteria

1. **`offscreen` gesetzt.** Jedes Element trägt das Feld; für `x = -9966` ist es
   `true`, für ein Element im Sichtfeld `false`. Beleg: `npm test` ⇒ 0,
   `^# fail 0`, `^# cancelled 0`.
2. **Fläche 0.** Der Fall `inspect_withAnElementWithoutArea_shouldSetOffscreenFalse`
   ⇒ `offscreen: false`, `visible: false`.
3. **Beide Quellen.** Der Schatten-Fall prüft `Object.keys`-Gleichheit und
   `length === 12`. Beleg: der Fall ⇒ `^ok`.
4. **Feldvertrag.** Der Elf-Felder-Fall prüft zwölf Felder in fester Reihenfolge.
5. **Alles andere grün.** `npm run check` ⇒ 0, `cargo test` ⇒ `test result: ok`
   mit `0 failed`, `bash scripts/parity.sh --impl rust --check` ⇒ 7/7. Die Fixture
   `2-tools.txt:14-15` (`# case=7`) trägt eine elf-Felder-`inspect`-Antwort und
   bleibt grün, weil sie die **Fake**-Extension beschreibt (`inspectResultOf`
   reicht `entry.elements` durch, `extension/bridge.js:3335-3354`).
6. **Live, Betreiber.** Auf einer Amazon-Suchseite trägt der Treffer
   `button#nav-assist-add-to-cart` in `browser_inspect` das Feld
   `"offscreen": true`.

## Dev plan

Verfasst von einem zweiten Autor (2026-11-23), geprüft gegen den Code.

**Stufe 1 — Harness und das Feld in beiden Quellen**

`test/extension.test.js:943` ist `const window = {}`; `innerWidth`/`innerHeight`
kommen heute im ganzen Repo nicht vor. Die zwei Zahlen kommen dort hinein
(`1024` × `768`) — falls `docs/56` sie schon eingeführt hat, entfällt der Teilschritt;
er ist idempotent. `createInspectElement` braucht nichts: sein Rect-Default ist
`{ x: 0, y: 0, width: 100, height: 20 }` (`:9237`), also immer gesetzt.

`extension/page-agent.js`, `described` in beiden Quellen (`:788`, `:1040`):
`const rect = rectOf(candidate)` **einmal**, dann `rect` und `offscreen` aus derselben
Messung — keine zweite `getBoundingClientRect`. Prädikat: Fläche 0 ⇒ `false`;
sonst `true`, wenn `rect.x + rect.width <= 0 || rect.y + rect.height <= 0 ||
rect.x >= window.innerWidth || rect.y >= window.innerHeight`. Position im Objekt:
hinter `visible`, vor `disabled`, in beiden Kopien gleich — sonst kippt `:10921`.
Die zwei Kommentare „the eleven documented fields, and nothing else“ (`:787`,
`:1034`) werden auf zwölf gezogen.

Das Prädikat ist dieselbe Regel wie die Lageprüfung aus `docs/56`: es lebt auf der
IIFE-Ebene (`:19`) und wird geteilt, nicht kopiert. Baut 62 zuerst, führt diese Spec
es ein und `docs/56` benutzt es; baut 56 zuerst, umgekehrt. Eine Definition, zwei
Aufrufer.

Tests: zwei neue Fälle der Tabelle; der Elf-Felder-Fall `:10199` (vollständiges
`deepStrictEqual`) bekommt `offscreen: false` ins Literal, `:10921` ändert `length`
11 → 12 (`:10940`). **Achtung beim Fläche-0-Fall:** `createInspectElement` liefert
auch bei `display: "none"` ein Rect (`100 × 20`); der Fall setzt
`rect: { x: 0, y: 0, width: 0, height: 0 }` ausdrücklich, sonst prüft er nichts.

Beweis: `inspect_withAnElementOutsideTheViewport_shouldSetOffscreenTrue` (`x = -9966`
⇒ `true`, Element im Bild ⇒ `false`), `inspect_withAnElementWithoutArea_shouldSetOffscreenFalse`
(⇒ `false`, `visible: false`), `inspect_withAShadowHit_shouldDeliverTheSameFieldSetAsADocumentHit`
(⇒ `^ok`, zwölf Schlüssel). Je Name `grep -cE '^ok [0-9]+ - <name>'` ⇒ 1;
`npm test; echo $?` ⇒ 0 mit `^# fail 0` und `^# cancelled 0`.

**Stufe 2 — Anleitung (`bridge-rs/src/mcp/help.rs`, `bridge-rs/tests/mcp.rs`)**

INSPECT-Block `:148-171`: die `## Returns`-Zeile (`:161-162`) bekommt `offscreen` in
die Feldaufzählung. Sie listet heute nur acht der elf Felder (`index`, `ariaLabel`,
`disabled` fehlen) — nachgezogen wird **nur** `offscreen`; die drei anderen bleiben
eine Lücke und stehen unten. Neuer Fall `help_forInspect_shouldNameEveryElementField` (die
Datei-Konvention ist `help_…`; `## Testing` nennt ihn `mcp_toolsCallBrowserHelp_…`).

Beweis: `cargo test --manifest-path bridge-rs/Cargo.toml --test mcp
help_forInspect_shouldNameOffscreen -- --exact` ⇒ `test result: ok. 1 passed` — die
Zeile zählt, ein Filter ohne Treffer endet mit 0 und `0 passed`.

**Stufe 3 — Doku**

`docs/09`: das Beispiel `:28`, der Feldkatalog `:36-45` und die Zeile
„`rect` sagt, wo es ist — der Agent muss selbst schließen, ob es im Bild ist“
(`:450`, `## Bekannte Lücken`) — sie ist ab jetzt falsch und wird ersetzt. Dazu
`docs/53`, `docs/README.md` (Status), `docs/PROJECT-STATE.md`, Abschnitt „Beweise"; der
Amendments-Abschnitt entfällt, die Spec wird `active`. Die zwei Fallzahlen-Pins
(`docs/54` Kriterium 4) nennen die Zahl aus der Schlusszeile des Laufs.

Beweis: `npm run check; echo $?` ⇒ 0; `grep -n '62-inspect' docs/README.md` zeigt
`active`; `bash scripts/parity.sh --impl rust --check; echo $?` ⇒ 7/7, 0.

**Eingefrorene Artefakte: keiner.** `2-tools.txt:14-15` (Fall 7, elf Felder ohne
`offscreen`) bleibt grün, weil die Antwort aus der **Fake**-Extension kommt:
`inspectResultOf` (`bridge.js:3335-3354`) reicht `entry.elements` unverändert durch
und prüft nur `outcome`/`url`/`title`/`count`/`elements` (`isUsableInspectResult`,
`:3357-3369`). `# cases=39`, `1-initialize-and-tools-list.txt` und
`3-extension-failures.txt` bleiben unberührt.

**Was schiefgehen kann.** Der Debug-Block prüft Elementfelder gegen eine Whitelist:
`ELEMENT_FIELDS` (`hub.rs:1282-1302`) kennt `offscreen` nicht, das Feld erscheint im
Debug-Log als `<unlisted field>` (`hub.rs:1352`). `hub.rs` steht in der Touch
boundary auf *nicht* — es bleibt dabei; wer den Wert dort sehen will, braucht eine
Zeile in der Tabelle und eine geöffnete Grenze. Zweitens ist `innerWidth` die
Fensterbreite, nicht der sichtbare Ausschnitt (`## Bekannte Lücken`); jeder Realm hat
sein eigenes `window`, also auch jeder iframe seine eigenen Zahlen.

**Reihenfolge.** Stufe 1 → 2 → 3. `docs/57` (Teil a) ändert `count` und die
Trefferliste, nicht die Feldmenge; die Feldset-Zusicherung `:10921` bleibt unter
beiden Specs gültig, die Reihenfolge `57` → `62` ist trotzdem die einfachere. Dieselbe
Datei faßt `docs/56` an (IIFE-Helfer, `window` im Realm) — nacheinander, nicht
parallel.

**Was der nächste Inkrement erbt.** Die `## Returns`-Zeile der `inspect`-Anleitung
fehlen weiterhin `index`, `ariaLabel` und `disabled` (eigener, kleiner Anlass, `docs/53`
prüft nur die sechs Überschriften). Das Feld sagt nichts über Verdeckung
(`## Bekannte Lücken`) — ein eigenes Inkrement, wenn der Betreiber es will.
## Touch boundary

| erlaubt | nicht |
|---|---|
| `extension/page-agent.js` (`described` in beiden Zweigen) | `extension/bridge.js` — das Feld wird durchgereicht |
| `test/extension.test.js` | `inspectPageSource`-Filterlogik — das ist `docs/57` |
| `bridge-rs/src/mcp/help.rs`, `bridge-rs/tests/mcp.rs` | `scripts/parity/**` |
| `docs/09`, `docs/27`, `docs/53`, `docs/54` (Fallzahlen), `docs/README.md`, `docs/PROJECT-STATE.md`, einmalig `bridge-rs/src/hub.rs` (Whitelist, 2026-11-23) | `docs/56`, `docs/57`, `docs/58` |

## Bekannte Lücken

- **`hub.rs` ist am 2026-11-23 für `offscreen` geöffnet worden** (Nachtrag): das Feld
  steht in `ELEMENT_FIELDS`, der Debug-Log zeigt den Wert statt `<unlisted field>`.
  Die Touch boundary dieser Spec bleibt sonst geschlossen — jedes weitere Feld
  braucht wieder eine eigene Entscheidung.
- **Die absolute Schlüsselreihenfolge pinnt kein Fall.** `deepStrictEqual` auf einem
  Objektliteral ist ordnungsblind, und der Schatten-Fall vergleicht nur die zwei
  Kopien gegeneinander. Die Spec sagt „hinter `visible`, vor `disabled`"; ein
  `Object.keys`-Pin wäre der Nachzug (Code-Review 2026-11-23).
- **Das Feld sagt nichts über Verdeckung.** Ein Element kann im Bild liegen und von
  einem Overlay überdeckt sein; `offscreen` bleibt `false` (2026-11-23).
- **`innerWidth` ist die Breite des Fensters, nicht des sichtbaren Ausschnitts.**
  Bei einem horizontal scrollbaren Dokument ist das ein Unterschied; nicht
  gemessen (2026-11-23).
- **Ein iframe hat sein eigenes Fenster.** Das Feld beschreibt den Rahmen, in dem
  die Suche lief, nicht den Hauptrahmen (2026-11-23).

## Open questions

**Keine.** Der Betreiber hat am 2026-11-23 entschieden: Feld ja, `owner` nein,
`includeHidden` schaltet die Engste-Regel ab (Teil a).

## Review

### Runde 1 nach der Teilung — `🔧 Fix these` (2026-11-23)

Geprüft in den Gate-Runden 5 und 6 der Vorgänger-Spec: Der Durchgang nannte die
Fallzahlen, den Schatten-Feldset-Fall (`length` 11 → 12) und die fehlende
Text-Faltung im Fixture-Bauer. Alles eingearbeitet; der Code-Review gab danach `✅`.
Die Buchhaltung hier fehlte bis zum 2026-11-23.

## Log

- **2026-11-23, abgespalten.** Aus `docs/57` nach dem vierten Gate-Block. Beleg aus
  dem 9B-Lauf 16:33 im Export `2026-11-23_conversations.zip`.

- **2026-11-23, Absprache.** Der Betreiber hat Ziel und Abnahmekriterien dieser
  Spec abgestimmt (`CONTRIBUTING.md`, Schritt 2). Der Bau kann beginnen, sobald
  der Dev-Plan von einem zweiten Autor geprüft ist.

- **2026-11-23, Stufe 3 nachgezogen, Spec `active`.** `docs/09` trägt das Feld im
  Katalog, in der Testzeile, im Kriterium 3 und an der Stelle, die vorher sagte, der
  Agent müsse die Lage selbst schließen. `docs/27` sagt zwölf Felder statt elf.
  `docs/53` braucht keine Änderung: es beschreibt das Verfahren der Anleitung, die
  Anleitung selbst war Stufe 2. Fallzahlen abgelesen: `cargo test` 296 (126 in
  `mcp.rs`), `npm test` 563.
