---
description: Ein Klick auf ein Ziel außerhalb des Sichtfelds wird herangescrollt und neu gemessen, die Antwort nennt scrolled, und ein Ziel, das draußen bleibt, heißt offscreen_after_scroll — Teil a der Teilung vom 2026-11-23.
status: active
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
   `scrollIntoView({block:"center", inline:"center", behavior:"instant"})` heran.
   `behavior: "instant"` ist Pflicht, nicht Geschmack: ohne die Angabe gilt die
   berechnete `scroll-behavior` der Seite, und bei `html{scroll-behavior:smooth}`
   liefe der Scroll animiert — die Messung in Schritt 2 läse dann die alte Lage und
   lehnte ein Ziel unter dem Falz ab (Code-Review 2026-11-23).
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

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `click_onAnElementBelowTheFold_shouldScrollAndClickOnce` | Ziel unter dem Falz: `scrolled: true`, genau ein `click()`, ein `scrollIntoView` |
| `test/extension.test.js` | `click_onAnElementOutsideTheViewport_shouldAnswerOffscreenAndNotClick` | Ziel bei `x = -9966`, das auch nach dem Scrollen draußen bleibt: `offscreen_after_scroll`, **kein** `click()` |
| `test/extension.test.js` | `click_onAnElementInTheViewport_shouldNotScroll` | `scrolled: false` **und** `clicked` gesetzt, kein `scrollIntoView` |
| `test/extension.test.js` | `click_shouldDeliverScrolledRightAfterClicked` | die Feldreihenfolge `clicked`, `scrolled`, … bleibt Vertrag |
| `test/extension.test.js` | `click_onAnElementWithoutArea_shouldAnswerNotClickableAndNotClick` (bestehend, `:7014`) | die Sichtbarkeit greift **vor** der Lageprüfung: das Ergebnis ist `not_clickable` |
| `test/extension.test.js` | `click_onAnElementWithDisplayNone_shouldAnswerNotClickableAndNotClick` (bestehend, `:7031`) | dito für `display:none` |
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
   hat heute neun Felder; `scrolled` steht auf Index 4. **Drei** bestehende
   `deepStrictEqual`-Fälle (`:7076-7086`, `:7346-7356`, `:7956` im Frame-Fall)
   **und** ihre zwei `Object.keys`-Pins (`:7087-7097`, `:7357-7367`) wandern mit;
   der dritte Ganzantwort-Pin war in der ersten Fassung dieser Spec nicht gezählt
   (Code-Review 2026-11-23).
4. **Die alten drei Gründe bleiben, und die Lage kommt danach.** Die zwei Fälle
   `:7014` und `:7031` (Element ohne Fläche, `display:none`) bleiben grün, ohne
   Anpassung; ihr Ergebnis `not_clickable` beweist, dass die Sichtbarkeit **vor**
   der Lageprüfung greift. Dass dabei kein `scrollIntoView` läuft, prüft **kein**
   Fall — siehe `## Bekannte Lücken`.
5. **Die Bridge kennt den Code.**
   `cargo test --manifest-path bridge-rs/Cargo.toml --test mcp
   click_withOffscreenAfterScroll_shouldNameTheTarget -- --exact` ⇒ die Zeile
   `test result: ok. 1 passed`. **Die Zeile zählt, nicht der Exit-Code:** ein Filter
   ohne Treffer endet mit 0 und `0 passed`.
6. **Alles andere grün.** `npm run check` ⇒ 0, `cargo test` ⇒ `test result: ok`
   mit `0 failed`, `bash scripts/parity.sh --impl rust --check` ⇒ 7/7.
   `scripts/parity/expected/3-extension-failures.txt` bleibt unberührt: sie pinnt
   `# cases=2` (`no extension`, `timeout`).
7. **Live, Betreiber.** Auf einer Amazon-Suchseite: `browser_click` auf
   `button#nav-assist-add-to-cart` antwortet entweder mit `scrolled: true` oder mit
   `offscreen_after_scroll`. Ein `clicked` ohne `scrolled`-Feld ist der Fehler.

## Dev plan

Verfasst von einem zweiten Autor (2026-11-23), geprüft gegen den Code.

**Stufe 1 — Harness, Seitenregel und Träger in *einem* Auftrag**

`test/extension.test.js`:

- `:943` ist `const window = {}`; `innerWidth`, `innerHeight` und `scrollIntoView`
  kommen heute im ganzen Repo nicht vor (`grep -rn 'innerWidth\|scrollIntoView'
  test/ extension/ bridge-rs/src` ⇒ nichts). Der Realm bekommt `innerWidth = 1024`,
  `innerHeight = 768`, der Kommentar darüber wird mitgezogen.
- `createClickElement` (`:1300-1326`): der Default-Rect `{ width: 120, height: 24 }`
  (`:1305`) bekommt `x: 0, y: 0` — der Stub gibt das Rect unverändert zurück, ohne
  die zwei Werte liest jede Lageprüfung `undefined`. Dazu ein `scrolls`-Zähler und
  ein `scrollIntoView(options)`, das den Rect-Parameter verschiebt (Parameter sind
  veränderliche Bindings) und die Optionen festhält. `clicks`/`onClick` bleiben.

`extension/page-agent.js`:

- Zwei Helfer auf der IIFE-Ebene (`:19`, derselbe Scope wie `describeElement` `:33`
  und `isVisible` `:55-62`): `intersectsViewport(rect)` und
  `scrollIntoViewIfNeeded(element)`. `:2105` ist nur der Eintrag der Op-Tabelle.
- `clickPageSource` (`:455-485`) prüft in dieser Reihenfolge: `isVisible`/`disabled`
  (`not_clickable`, unverändert) → Lage → `scrollIntoView({block: "center", inline:
  "center", behavior: "instant"})` → neu messen → `offscreen_after_scroll` **ohne**
  `click()`. Der
  Erfolgsfall antwortet `{ outcome: "clicked", clicked, scrolled, ...frameFieldsOf() }`.

`extension/bridge.js`:

- `clickOutcomeOf` (`:2959-2968`) gibt statt des Strings ein Paar zurück:
  `{ clicked, scrolled: entry.scrolled === true }` — eine Extension ohne das Feld
  liest damit `false`.
- `clickAgentTab` (`:2817`, `:2843`): die Variable heißt `reported`, nicht `click` —
  `click` ist dort schon der Slot (`:2812`).
- `clickResult(tabId, reported, before, settle, want)` (`:2998`) setzt `clicked`
  **und** `scrolled` in das Antwortliteral (`:3006-3020`), `scrolled` direkt hinter
  `clicked`, also auf Index 4.
- `offscreen_after_scroll` kommt in `CLICK_OUTCOMES` **und**
  `CLICK_REFUSAL_MESSAGES` (`:505-510`); ohne den Eintrag wirft `clickOutcomeOf`
  `click_failed`.

**Warum ein Auftrag.** Kriterium 2 (die Ablehnung erreicht den Aufrufer als
`offscreen_after_scroll`) und Kriterium 3 (Feldreihenfolge) sind nur über
`clickOutcomeOf`/`clickResult` entscheidbar; die Seitenregel allein erzeugt einen
Ausgang, den die Bridge als `click_failed` abweist. **Korrektur zur Fassung des
Spec-Autors:** ein „`func`-Lauf der Seite“ ist als Zwischenbeweis nicht möglich —
ein `func` läuft in der Seitenwelt (`world: "MAIN"`, gepinnt `:517`), der Page-Agent
in der isolierten Welt (`realmOf`, `:408`). Wer den Auftrag doch teilt, nimmt
`callPageAgentOp` (`:6515`, heute nur von `callSettleOp` benutzt): es injiziert
`page-agent.js` und liefert die Antwort des Ops ohne Bridge.

Beweis: `click_onAnElementBelowTheFold_shouldScrollAndClickOnce` ⇒ `^ok`, genau ein
`click()`, ein `scrollIntoView` mit `{block:"center", inline:"center",
behavior:"instant"}`, `scrolled: true`; `click_onAnElementOutsideTheViewport_shouldAnswerOffscreenAndNotClick` ⇒
`offscreen_after_scroll`, `clicks === 0`; `click_onAnElementInTheViewport_shouldNotScroll`
⇒ `scrolled: false`, kein `scrollIntoView`; `click_shouldDeliverScrolledRightAfterClicked`
⇒ Index 4. Je Name `grep -cE '^ok [0-9]+ - <name>'` ⇒ 1; `npm test; echo $?` ⇒ 0 mit
`^# fail 0` und `^# cancelled 0`. Mitwandern: die **drei** `deepStrictEqual`-Pins (`:7076-7086`, `:7346-7356`,
`:7951-7962`) und ihre zwei `Object.keys`-Pins (`:7087-7097`, `:7357-7367`)
bekommen `scrolled` an Position 4. Die zwei Fälle ohne Fläche (`:7014`, `:7031`)
bleiben unangetastet.

**Stufe 2 — Bridge und Texte, unabhängig von Stufe 1**

`bridge-rs/src/mcp/failure.rs`: Konstante `OFFSCREEN_AFTER_SCROLL_CODE` neben
`NOT_CLICKABLE_CODE` (`:38`) und ein Arm im `BROWSER_CLICK`-Zweig (`:125-136`)
**vor** `page_failure_text` (`:135`): `texts::offscreen_after_scroll(&selector_of(params))`
— der Satz nennt das Ziel wie die drei alten und braucht kein `details`.
`texts.rs`: `pub fn offscreen_after_scroll(selector: &str)`. `bridge-rs/tests/mcp.rs`:
der Fall aus `## Testing` **und** `CLICK_REFUSAL_CASES` (`:2179-2183`) auf vier
Zeilen, weil dessen Kommentar sonst „the three codes“ behauptet.

Beweis: `cargo test --manifest-path bridge-rs/Cargo.toml --test mcp
click_withOffscreenAfterScroll_shouldNameTheTarget -- --exact` ⇒ `test result: ok.
1 passed`. Die Zeile zählt, nicht der Exit-Code: ein Filter ohne Treffer endet mit 0
und `0 passed`. Dazu `--test texts` ⇒ `1 passed` (der Umlaut-Wächter deckt den neuen
Satz ohne eigenen Fall).

**Stufe 3 — Anleitung und Doku**

`bridge-rs/src/mcp/help.rs` (CLICK-Block `:82-102`): die `## Returns`-Zeile
(`:92-93`) nennt heute weder `clicked` noch `scrolled`; sie wird `tabId, url, title,
clicked, scrolled, text …, settled, waitedMs`, und `## Pitfalls` (`:98-99`) nennt den
vierten Ablehnungsgrund. `docs/06` (Vertragstabelle), `docs/15` (Beispiel `:25` und
die Signatur `clickResult(tabId, clicked, …)` in `:231`), `docs/53`,
`docs/README.md` (Status), `docs/PROJECT-STATE.md`, Abschnitt „Beweise"; der Amendments-Abschnitt
entfällt, die Spec wird `active`.

Beweis: `npm run check; echo $?` ⇒ 0; `grep -n '56-klick' docs/README.md` zeigt
`active`; `help_forEveryTool_shouldAnswerWithTheSixSections` bleibt grün.

**Eingefrorene Artefakte: keiner wird angefasst.** `2-tools.txt` Fall 4 (Zeile 9)
trägt `clicked`, kommt aber aus der **Fake**-Extension des Parity-Treibers; die
Bridge reicht durch und fügt nichts hinzu, `# cases=39` bleibt.
`3-extension-failures.txt` (`# cases=2`) und `1-initialize-and-tools-list.txt` sind
unberührt — kein neues Argument, kein neues Werkzeug. Ein datierter Akt mit
Betreiberfreigabe ist für dieses Inkrement nicht nötig.

**Was schiefgehen kann.** Der Debug-Block der Bridge prüft gegen eine Whitelist
(`hub.rs`). Er stand in der Touch boundary auf *nicht*; **am 2026-11-23 geöffnet**
für eine Zeile: `scrolled` ist eingetragen, der Debug-Log zeigt den Wert statt
`<unlisted field>`. Jedes weitere Feld braucht wieder eine eigene Entscheidung. Zweitens: `scrolled` ist eine Aussage
über einen Lauf, in dem geklickt wurde; im Fehlerfall gibt es das Feld deshalb nicht,
und niemand darf `false` als „nicht gescrollt“ lesen, wo gar nicht geklickt wurde.

**Reihenfolge.** Stufe 1 und Stufe 2 sind unabhängig: die Rust-Seite antwortet auf
eine Fake-Antwort der Extension. Stufe 3 setzt beide voraus. Innerhalb von Stufe 1
ist die Reihenfolge Harness → Seite → Brücke; ohne die zwei Fensterzahlen im Realm
liest die Seitenregel `undefined`.

**Was der nächste Inkrement erbt.** `docs/61` hängt am selben `clickErrorFor`
(`:2752-2760`) und ist ein eigener Auftrag; `docs/58` baut auf
`clickPageSource(selector, want)` auf, dessen Signatur hier unverändert bleibt;
`type` hat dieselbe Blindstelle und ist bewusst draußen; der Fall
`mcp_toolsCallBrowserClick_withAConnectedExtension_shouldReturnAllNineFields…`
(`bridge-rs/tests/mcp.rs:2186-2212`) pinnt die Felder seiner eigenen Fake-Antwort
(`click_result()`, `:573`) und bleibt grün — sein Kommentar „all nine fields the
contract promises“ ist ab jetzt überholt und wird hier nicht repariert.
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
- **Kein Fall zählt `scrolls === 0`** bei einem Element ohne Fläche. Die
  Reihenfolge ist über das Ergebnis (`not_clickable`) belegt, nicht über den
  Zähler (Code-Review 2026-11-23).
- **`scrollIntoView` ist der erste werfbare Aufruf im Klickpfad**, und er ist
  nicht gefangen. Fehlt die Methode oder wirft sie, antwortet der Op mit einem
  Fehler statt zu klicken. Kein Browser ist bekannt, in dem das heute passiert;
  ein `try/catch` mit Rückfall auf „klicken wie vorher" wäre der Nachzug
  (Code-Review 2026-11-23).
- **`intersectsViewport` liefert für ein `rect` ohne Fläche „schneidet nicht".**
  `docs/62` braucht dort `offscreen: false` und damit einen eigenen Zweig; der
  Doc-Kommentar des Helfers sagt das (Code-Review 2026-11-23).

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

- **2026-11-23, Stufe 4 nachgezogen, Spec `active`.** `docs/06` nennt `scrolled` in
  der Antwort und in der Feldliste, dazu den neuen Code `offscreen_after_scroll`
  samt Reihenfolge (`not_clickable` gilt vor der Lage). `docs/15` zeigt die
  Feldreihenfolge im Beispiel und die neue Signatur `clickResult(tabId, reported,
  before, settle, want)`. `docs/54` trägt den neuen Satz mit Datum. `docs/53` und
  `help.rs` waren Stufe 3. Fallzahlen abgelesen: `cargo test` 293 (123 in
  `mcp.rs`), `npm test` 553.
