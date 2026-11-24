---
description: Ein Klick auf ein Ziel außerhalb des Sichtfelds wird herangescrollt und neu gemessen, die Antwort nennt scrolled, und ein Ziel, das draußen bleibt, heißt offscreen_after_scroll — Teil a der Teilung vom 2026-11-23.
status: proposed
---

# Der Klick sagt die Wahrheit, Teil a — die Lage

**Geteilt am 2026-11-23.** Der Gate hat diese Spec in Runde 4 zum vierten Mal
blockiert; `CONTRIBUTING.md`, Schritt 4, verlangt dann einen Schnitt. Die Naht ist
die Frage, die der Klick beantwortet: **Teil a** (diese Spec) sagt, *wohin* der
Klick geht und ob er das Ziel überhaupt erreicht. **Teil b** (`docs/61`) sagt, was
die Antwort bedeutet, wenn die Seite nach dem Klick nicht lesbar ist.

## Anlass

Eine Beobachtung vom 2026-11-23 aus einem echten Lauf mit dem 9B-Modell
(`Qwen3.5-9B-UD-Q4_K_XL.gguf`, Export `2026-11-23_conversations.zip`, Lauf 16:33).

`browser_inspect({selector:"button, a", text:"In den Einkaufswagen"})` lieferte
genau einen Treffer: `button#nav-assist-add-to-cart`, `visible: true`,
`rect: {"x": -9966, "y": 385, "width": 351, "height": 41}`. Amazon führt dort das
Tastenkürzel-Menü, weit links außerhalb der Seite.
`browser_click({selector:"button#nav-assist-add-to-cart"})` antwortete mit
`clicked: "button#nav-assist-add-to-cart"` und dem Seitentext. Kein Feld sagte,
dass das Ziel außerhalb des Sichtfelds lag.

**Was der Beleg nicht zeigt.** Der Warenkorb war 12 Minuten später leer
(„Cart is empty", Sitzung `2026-11-23T16-45-24`). Ob der Klick wirkungslos war
oder der Artikel entfernt wurde, ist offen. Belegt ist nur, dass die Antwort das
Einzige verschwieg, was der Aufrufer wissen musste: das Ziel lag außerhalb des
Sichtfelds.

**Ursache, im Code nachgesehen.** `isVisible`
(`extension/page-agent.js:55-62`) prüft Fläche, `display` und `visibility` — die
Lage nicht. Ein Element bei `x = -9966` gilt als sichtbar. `clickPageSource`
(`:455`) prüft genau diese Sichtbarkeit und `disabled`, ruft dann `element.click()`
und meldet `clicked`.

## Ziel

1. `click` scrollt ein Ziel, das den sichtbaren Bereich nicht schneidet, mit
   `scrollIntoView({block:"center", inline:"center"})` heran.
2. Danach misst `click` das Rechteck neu. Schneidet es den sichtbaren Bereich
   immer noch nicht, antwortet `click` mit dem neuen Code
   **`offscreen_after_scroll`** und führt **keinen** `click()` aus.
3. Die Erfolgsantwort nennt `scrolled: true`, wenn Schritt 1 lief, sonst `false`.
   Das Feld steht **direkt hinter `clicked`** — die Schlüsselreihenfolge dieser
   Antwort ist Teil des Drahtvertrags (`extension/bridge.js:3014-3016`).
4. Die Reihenfolge der Prüfungen bleibt: erst `isVisible` und `disabled` (die drei
   alten Gründe, `not_clickable`), **dann** die Lage. Ein Element ohne Fläche
   bleibt `not_clickable`, es wird nicht gescrollt.
5. **Der sichtbare Bereich ist der des Rahmens**, in dem der Klick läuft: In einem
   iframe misst die Regel gegen das Fenster des iframes, nicht gegen den Hauptrahmen.

**Warum scrollen und nicht sofort ablehnen.** Ein Ziel unterhalb des Falzes ist
ein Normalfall. Ein `not_clickable` dafür wäre eine Verschlechterung. Der
Amazon-Fall ist anders gelagert: dort bleibt das Ziel auch nach dem Scrollen
außerhalb. Die zweite Messung trennt beide Fälle, ohne einen Schalter.

**Dazu kommt ein zweiter Grund: das Werkzeugset hat kein Scrollen.** Kein
`navigate`, kein `click`, kein `inspect` kann die Seite rollen. Wer ein Ziel unter
dem Falz ablehnt, lässt dem Agenten keinen Weg dorthin — außer `browser_eval`.
Der Betreiber hat am 2026-11-23 deshalb „scrollen, dann messen" entschieden.

## Warum ein eigener Code statt eines Grund-Feldes

Die Ablehnung braucht einen Grund im Satz. Ein zusätzliches Feld `reason` auf dem
Draht wäre der bequeme Weg — aber `docs/54` hält es für Refusals anders: **der
Code trägt den Grund**, der Satz wird in der Bridge daraus gebaut
(`bridge-rs/src/mcp/failure.rs:118-136`, `texts.rs`).

Deshalb behält `not_clickable` seine drei Gründe und seinen Satz. Der vierte Grund
bekommt einen eigenen Code, `offscreen_after_scroll`, mit eigenem Satz:

```
The element stays outside the viewport after scrolling: <selector>.
```

## Der Vertrag

| Feld | Regel |
|---|---|
| `clicked` | wie heute: **ein String** ≤ 120 Zeichen aus `describeElement` — `tag#id`, `tag.class`, `tag[href="…"]`, `tag[aria-label="…"]` oder `tag` (`extension/page-agent.js:33-44`, gepinnt in `docs/06:57`, `test/extension.test.js:7225-7233` und `2-tools.txt:9`) |
| `scrolled` | **neu**, `true`, wenn Schritt 1 lief; `false` in jedem anderen Erfolgsfall; **direkt hinter `clicked`** |
| `settled`, `waitedMs`, `text`, `url`, `title`, `tabId` | unverändert |
| `not_clickable` | unverändert: Fläche 0, `display`/`visibility`, `disabled` |
| `offscreen_after_scroll` | **neu**, `isError: true`, Satz nennt das Ziel; **kein** `click()`; `scrolled` gibt es im Fehlerfall nicht |

`offscreen_after_scroll` ist ein **Ausgang der Seite** und wandert deshalb in
`CLICK_OUTCOMES` und `CLICK_REFUSAL_MESSAGES` (`extension/bridge.js:505-510`), wie
jeder andere Ablehnungsgrund des Klick-Schnipsels. Ohne diesen Eintrag wirft
`clickOutcomeOf` (`:2959-2969`) `click_failed` plus `console.warn`, und der Agent
liest eine ganz andere Meldung.

**Der Träger für `scrolled`.** `clickOutcomeOf` (`:2959-2967`) gibt heute
ausschließlich `entry.clicked` zurück, und `clickResult` (`:2998-3019`) baut die
Antwort aus einer festen Feldliste. Beide Funktionen gehören in den Dev-Plan; ohne
sie erreicht `scrolled` die Antwort nie. Ein Stub, der `scrolled` nicht liefert,
wird als `false` gelesen — „in jedem anderen Fall" deckt das.

## Non-goals

- **Keine Wirkungsprüfung.** „Hat sich die Seite geändert?" ist eine eigene Frage.
- **Kein neues Werkzeug.**
- **Keine Änderung an `type`.** Wer tippt, sieht das Feld; die Lageprüfung dort
  wäre ein eigener Anlass.
- **Keine Änderung an `inspect`.** Das Feld `offscreen` gehört `docs/62`.
- **Kein `reason`-Feld auf dem Draht.** Der Code trägt den Grund.
- **Keine Aussage über die Seite nach dem Klick.** Das ist `docs/61`.

## Amendments to previous spec docs

- **`docs/06-klicken.md`**: die Erfolgsantwort bekommt `scrolled` (Reihenfolge:
  hinter `clicked`); der neue Code `offscreen_after_scroll`; `not_clickable`
  behält seine drei Gründe.
- **`docs/53-browser-help.md`**: die Anleitung von `browser_click` in
  `bridge-rs/src/mcp/help.rs:82-102` nennt `scrolled` und den vierten
  Ablehnungsgrund.
- **`docs/15-ruhe-fuer-click-und-navigate.md`, Beispiel**: dort steht `clicked`
  **vor** `url`. Die Feldreihenfolge ist Vertrag (`extension/bridge.js:3014-3016`);
  das Beispiel wird auf die heutige Reihenfolge gezogen.

Nach der Umsetzung wird dieser Abschnitt entfernt.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `click_onAnElementBelowTheFold_shouldScrollAndClickOnce` | Ziel unter dem Falz: `scrolled: true`, genau ein `click()`, ein `scrollIntoView` |
| `test/extension.test.js` | `click_onAnElementOutsideTheViewport_shouldAnswerOffscreenAndNotClick` | Ziel bei `x = -9966`, das auch nach dem Scrollen draußen bleibt: `offscreen_after_scroll`, **kein** `click()` |
| `test/extension.test.js` | `click_onAnElementInTheViewport_shouldNotScroll` | `scrolled: false` **und** `clicked` gesetzt, kein `scrollIntoView` |
| `test/extension.test.js` | `click_shouldDeliverScrolledRightAfterClicked` | die Feldreihenfolge `clicked`, `scrolled`, … bleibt Vertrag |
| `test/extension.test.js` | `click_onAnElementWithoutArea_shouldAnswerNotClickableAndNotClick` (bestehend, `:6989`) | die Lageprüfung läuft **nach** der Sichtbarkeit: ein Element ohne Fläche wird nicht gescrollt |
| `test/extension.test.js` | `click_onAnElementWithDisplayNone_shouldAnswerNotClickableAndNotClick` (bestehend, `:7007`) | dito für `display:none` |
| `bridge-rs/tests/mcp.rs` | `click_withOffscreenAfterScroll_shouldNameTheTarget` | die Bridge bildet den neuen Code auf den englischen Satz ab |
| `bridge-rs/tests/texts.rs` | `texts_shouldContainNoGermanUmlauts` | der Wächter aus `docs/54` deckt den neuen Satz |

## Acceptance criteria

1. **Scrollen vor dem Klick.** Ein Ziel unterhalb des Falzes wird geklickt, die
   Antwort nennt `scrolled: true`, der Stub zählt genau einen `click()` und einen
   `scrollIntoView`-Aufruf. Beleg: `npm test` ⇒ 0, `^# fail 0`,
   `^# cancelled 0`.
2. **Ablehnung ohne Klick.** Das Fixture-Element bei `x = -9966` ergibt
   `offscreen_after_scroll`, und der Stub zählt **null** `click()`.
3. **Feldreihenfolge.** Der Fall `click_shouldDeliverScrolledRightAfterClicked`
   prüft `keys.indexOf("scrolled") === keys.indexOf("clicked") + 1`. Die Antwort
   hat heute neun Felder; `scrolled` steht auf Index 4. Die zwei bestehenden
   `deepStrictEqual`-Fälle (`:7076-7086`, `:7346-7356`) **und** ihre zwei
   `Object.keys`-Pins (`:7087-7097`, `:7357-7367`) wandern mit.
4. **Die alten drei Gründe bleiben.** Die zwei Fälle `:6989` und `:7007` bleiben
   grün, ohne Anpassung.
5. **Die Bridge kennt den Code.**
   `cargo test --test mcp click_withOffscreenAfterScroll_shouldNameTheTarget` ⇒
   grün, und der Satz enthält `outside the viewport`.
6. **Alles andere grün.** `npm run check` ⇒ 0, `cargo test` ⇒ `test result: ok`
   mit `0 failed`, `bash scripts/parity.sh --impl rust --check` ⇒ 7/7.
   `scripts/parity/expected/3-extension-failures.txt` bleibt unberührt: sie pinnt
   `# cases=2` (`no extension`, `timeout`).
7. **Live, Betreiber.** Auf einer Amazon-Suchseite: `browser_click` auf
   `button#nav-assist-add-to-cart` antwortet entweder mit `scrolled: true` oder mit
   `offscreen_after_scroll`. Ein `clicked` ohne `scrolled`-Feld ist der Fehler.

## Dev plan

Entwurf des Spec-Autors. Nach `CONTRIBUTING.md`, Schritt 3, gehört der Dev-Plan zu
einem zweiten Autor.

**Stufe 1 — die Lage im Klick (`extension/page-agent.js`) und das Harness**

`clickPageSource` bekommt drei Schritte: messen, scrollen, neu messen.
`scrollIntoView` läuft nur, wenn das Rechteck den sichtbaren Bereich nicht
schneidet. Neue Helfer im Modulscope: `intersectsViewport(rect)` und
`scrollIntoViewIfNeeded(element)`. Der Rückgabewert trägt `scrolled`.

Dazu das Harness, ohne das kein Fall läuft: `test/extension.test.js:943` ist
`const window = {}` — `window.innerWidth` und `window.innerHeight` fehlen im ganzen
Repo. `createClickElement` (`:1300-1327`) hat kein `scrollIntoView` und ein
konstantes `getBoundingClientRect`; sein Default-Rect ist `{ width: 120, height: 24 }`
**ohne `x`/`y`** (`:1305`) — ohne `x: 0, y: 0` liest jede Lageprüfung `undefined`.
Die Fensterzahlen sind fest (1024 × 768); der Frame-Fall prüft sie gegen
`window.top`-Unabhängigkeit.

**Stufe 1 und Stufe 2 gehen in einem Auftrag.** Die Beweise der Stufe 1 sind die
Antworten der Bridge (`scrolled`, `offscreen_after_scroll`) — und die baut erst
Stufe 2. Zwischenbeweis ohne Bridge: der `func`-Lauf der Seite (Rückgabewert plus
`scrollIntoView`-Zähler), wie `docs/47` ihn trägt.

Beweis: Testfälle 1, 2, 3, 5.

**Stufe 2 — `scrolled` und der Code (`extension/bridge.js`)**

`clickOutcomeOf` reicht `scrolled` durch, `clickResult` baut es direkt hinter
`clicked` in die Antwort. `offscreen_after_scroll` wandert in `CLICK_OUTCOMES` und
`CLICK_REFUSAL_MESSAGES` (`:505-510`).

Beweis: Testfälle 3, 4.

**Stufe 3 — Bridge und Texte**

`bridge-rs/src/mcp/failure.rs` (Konstante und Arm), `texts.rs` (der englische
Satz), `bridge-rs/tests/mcp.rs`, `bridge-rs/tests/texts.rs`.

Beweis: Kriterien 4, 5.

**Stufe 4 — Anleitung und Doku**

`bridge-rs/src/mcp/help.rs`, `docs/06`, `docs/15`, `docs/53`, `docs/README.md`;
der Amendments-Abschnitt entfällt, die Spec wird `active`. Die Fallzahlen in
`docs/54` Kriterium 4 und `PROJECT-STATE.md:33-34` werden nachgezogen.

Beweis: Kriterium 6 (Betreiber) und `npm run check`.

## Touch boundary

| erlaubt | nicht |
|---|---|
| `extension/page-agent.js` (Klick-Quelle), `extension/bridge.js` (`clickOutcomeOf`, `clickResult`, Konstanten) | `extension/bridge.js` außerhalb des Klick-Pfads |
| `test/extension.test.js` (Harness und Fälle) | `extension/page-agent.js`-Lesepfad, `readPageSource` |
| `bridge-rs/src/mcp/failure.rs`, `texts.rs`, `help.rs`, `bridge-rs/tests/mcp.rs`, `bridge-rs/tests/texts.rs` | `bridge-rs/src/hub.rs`, `protocol.rs` |
| `docs/06`, `docs/15`, `docs/53`, `docs/54`, `docs/README.md`, `docs/PROJECT-STATE.md` | `docs/09`, `docs/57`, `docs/58`, `docs/61`, `docs/62` |

## Bekannte Lücken

- **Der Beleg für „der Klick tat nichts" fehlt.** Belegt ist nur das leere
  Warenkorb-Feld 12 Minuten später (2026-11-23).
- **Das Scrollen ist nicht live gemessen.** Der Fixture-Fall zählt
  `scrollIntoView`-Aufrufe und ändert das Rechteck; ob Amazon bei waagerechtem
  Überlauf seitwärts springt, zeigt erst Kriterium 7 (2026-11-23).
- **`type` hat dieselbe Blindstelle** für Felder außerhalb des Sichtfelds. Bewusst
  nicht mitgebaut (2026-11-23).
- **Der Frame-Fall unterscheidet nur, ob die Seite `window.top` liest.** Das
  Harness gibt allen Realms dieselben Fensterzahlen (2026-11-23).

## Open questions

**Keine.** Der Betreiber hat am 2026-11-23 „scrollen, dann messen" entschieden,
und der Grund wird ein eigener Code, kein Feld `reason`.

## Review

### Runden 1 bis 3 der Vorgänger-Spec

Kürzeststand, damit die Historie beim Schnitt nicht verloren geht:

- **Runde 1** (`🔧`): `clicked` war als Objekt beschrieben (es ist ein String);
  `scrolled` erreichte die Antwort nicht; die Feldreihenfolge war nicht
  festgelegt; `not_readable` trägt kein `frame`; `help.rs` fehlte; der Widerspruch
  „Satz nennt den Grund" gegen „kein Feld `reason`".
- **Runde 2** (`🔧`): `offscreen_after_scroll` fehlte in `CLICK_OUTCOMES`;
  Kriterium 3 sagte „Position 2" (richtig: Index 4); das Harness kannte
  `innerWidth`/`innerHeight` nicht; `createClickElement` hatte kein
  `scrollIntoView`.
- **Runde 3** (`🔧`): `clicked` im Fehlerrahmen ohne Träger; Kriterium 6
  widersprach sich bei `CLICK_RESULT`; Stufe 1 brauchte den Beweis aus Stufe 2.

### Runde 4 — `🔧 Fix these`, dann geteilt

Der Gate nannte drei Blocker für die alte Fassung: zwei bestehende Fälle
(`:7492`, `:7528`) hingen an `not_readable` — sie stehen jetzt in `docs/61`; die
Tabellenzeile trug `clicked` im Fehlerrahmen — gestrichen; Kriterium 6
widersprach sich bei der Fake-Extension — entschieden. Weil das der vierte Block
war, ist die Spec an der Frage geteilt: die Lage bleibt hier, die Seite nach dem
Klick steht in `docs/61`.

### Runde 1 nach der Teilung — steht aus

## Log

- **2026-11-23, angelegt, dreimal überarbeitet, geteilt.** Beleg aus dem Export
  `2026-11-23_conversations.zip` (Lauf 16:33). Geteilt nach dem vierten
  Gate-Block; der zweite Code `not_readable_after_click` steht in `docs/61`.

- **2026-11-23, Absprache.** Der Betreiber hat Ziel und Abnahmekriterien dieser
  Spec abgestimmt (`CONTRIBUTING.md`, Schritt 2). Der Bau kann beginnen, sobald
  der Dev-Plan von einem zweiten Autor geprüft ist.
