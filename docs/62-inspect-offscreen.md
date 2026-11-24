---
description: Jedes Element aus browser_inspect trägt offscreen — true, wenn sein rect den sichtbaren Bereich nicht schneidet, in beiden Quellen der Antwort; Teil b der Teilung vom 2026-11-23.
status: proposed
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
   `inspectShadowPageSource` (`:964-1060`). Sonst liefert ein Schatten-Treffer eine
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

## Amendments to previous spec docs

- **`docs/09-dom-abfrage.md`**: der Feldkatalog bekommt `offscreen` samt der
  Ausnahme für flächenlose Elemente.
- **`docs/53-browser-help.md`**: die Anleitung von `browser_inspect` nennt das Feld.

Nach der Umsetzung wird dieser Abschnitt entfernt.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `inspect_withAnElementOutsideTheViewport_shouldSetOffscreenTrue` | `x = -9966` ⇒ `true`, Element im Bild ⇒ `false` |
| `test/extension.test.js` | `inspect_withAnElementWithoutArea_shouldSetOffscreenFalse` | Fläche 0 ⇒ `false`, `visible: false` bleibt |
| `test/extension.test.js` | `inspect_withASelectorOnTheLink_shouldAnswerEveryFieldOfTheContract` (bestehend, `:10199`) | der Feldvertrag **mit** `offscreen`, von elf auf zwölf Felder |
| `test/extension.test.js` | `inspect_withAShadowHit_shouldDeliverTheSameFieldSetAsADocumentHit` (bestehend, `:10921`) | beide Quellen liefern dasselbe Feldset, `length` 11 → 12 (`:10940`) |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsCallBrowserHelp_forInspect_shouldNameOffscreen` | die Anleitung nennt das Feld |

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

Entwurf des Spec-Autors. Nach `CONTRIBUTING.md`, Schritt 3, gehört der Dev-Plan zu
einem zweiten Autor.

**Stufe 1 — das Feld in beiden Quellen (`extension/page-agent.js`)**

`described()` (`:788`) und seine Kopie im Schatten-Zweig (`:1040`) bekommen das
Feld, berechnet aus dem schon vorhandenen `rect` und `window.innerWidth` /
`window.innerHeight`. Keine zusätzliche Messung. Die zwei Kommentare „the eleven
documented fields, and nothing else" (`:787`, `:1034`) werden auf zwölf gezogen.

**Das Harness braucht die zwei Zahlen.** `test/extension.test.js:943` ist
`const window = {}`; `innerWidth`/`innerHeight` kommen heute im ganzen Repo nicht
vor — sofern `docs/56` sie nicht schon eingeführt hat (dieselbe Stelle, die Kette
ist `56` → `57` → `62`). Die Fixtures setzen `rect.x`/`rect.y`; ohne Werte wäre
`x` `undefined` und `Math.round` lieferte `NaN`.

Beweis: Kriterien 1 bis 4.

**Stufe 2 — die Anleitung (`bridge-rs/src/mcp/help.rs`)**

Ein Satz zu `offscreen` in der Anleitung von `browser_inspect`.

Beweis: der neue Fall `mcp_toolsCallBrowserHelp_forInspect_shouldNameOffscreen`.

**Stufe 3 — die Doku**

`docs/09`, `docs/53`, `docs/README.md`; der Amendments-Abschnitt entfällt, die Spec
wird `active`. Die drei neuen Fälle schieben die Zahlen in `docs/54` Kriterium 4
(287 Fälle, 117 in `mcp.rs`, `npm test` ⇒ 547) und `PROJECT-STATE.md:33-34`; beide
werden hier nachgezogen.

Beweis: `npm run check` ⇒ 0, `grep -n '62-inspect' docs/README.md` zeigt `active`.

## Touch boundary

| erlaubt | nicht |
|---|---|
| `extension/page-agent.js` (`described` in beiden Zweigen) | `extension/bridge.js` — das Feld wird durchgereicht |
| `test/extension.test.js` | `inspectPageSource`-Filterlogik — das ist `docs/57` |
| `bridge-rs/src/mcp/help.rs`, `bridge-rs/tests/mcp.rs` | `scripts/parity/**` |
| `docs/09`, `docs/53`, `docs/54` (Fallzahlen), `docs/README.md`, `docs/PROJECT-STATE.md` | `docs/56`, `docs/57`, `docs/58` |

## Bekannte Lücken

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

### Runde 1 nach der Teilung — steht aus

Die Vorgänger-Spec hatte vier Runden. Dieses Thema war dort Runde 1 (der Treffer
außerhalb des Sichtfelds, `visible: true`) und Runde 2/3 (die zweite Quelle, der
Feldset-Fall, die Harmonie mit `docs/56`). Alle Befunde sind hier eingearbeitet.

## Log

- **2026-11-23, abgespalten.** Aus `docs/57` nach dem vierten Gate-Block. Beleg aus
  dem 9B-Lauf 16:33 im Export `2026-11-23_conversations.zip`.

- **2026-11-23, Absprache.** Der Betreiber hat Ziel und Abnahmekriterien dieser
  Spec abgestimmt (`CONTRIBUTING.md`, Schritt 2). Der Bau kann beginnen, sobald
  der Dev-Plan von einem zweiten Autor geprüft ist.
