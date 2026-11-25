---
description: browser_click trifft künftig auch nach Text — contains_text allein oder zusammen mit selector, engster Treffer, exakter Treffer zuerst, bei Mehrdeutigkeit text_ambiguous mit Kandidaten; Teil a der Teilung vom 2026-11-23, alles in der Erweiterung.
status: active
---

# Klicken nach Text, Teil a — die Erweiterung

**Geteilt am 2026-11-23.** Der Spec-Review hat die Spec nach der dritten Runde als
zu groß bezeichnet: fünf Stufen über `page-agent.js`, `bridge.js`, `tools.rs`,
`failure.rs`, `texts.rs`, `help.rs`, zwei eingefrorene Fixtures, das Testharness und
vier Doku-Dateien. Die Naht ist die Leitung: **Teil a** (diese Spec) endet an der
Extension, **Teil b** (`docs/60`) beginnt an `tools.rs`. Jede Hälfte hat einen
eigenen grünen Beweis.

## Anlass

Drei Beobachtungen vom 2026-11-23. Das Modell (9B, `Qwen3.5-9B-UD-Q4_K_XL.gguf`)
wollte den Knopf „In den Einkaufswagen" treffen und hatte keinen Weg dorthin.

**Beleg 1 — der Selektor, den es nicht gibt** (Lauf 16:33, Export
`2026-11-23_conversations.zip`). Drei Aufrufe mit Selektor-Text-Syntax, darunter
`button:contains("In den Einkaufswagen")` und
`a:contains("AV Acrylicos Vallejo: Farbe Vallejo Model Color 70966 Turquoise (17ml)")`.
Alle drei antworteten „The selector is invalid: …". Die Syntax ist jQuery, nicht
CSS; `querySelector` kann sie nicht lesen.

**Beleg 2 — `eval` als Ersatz** (Lauf 16:00). Sechs Versuche, den Knopf selbst zu
finden, darunter fünf mit `document.querySelectorAll('button, a')` und
`innerText.includes('In den Einkaufswagen')`. Alle gaben `false` zurück; einer
suchte `querySelectorAll('a')` und antwortete `'Kein Button gefunden'`. Der Knopf
liegt nicht in einem `button` oder `a`.

**Beleg 3 — der geratene Selektor trifft das Falsche** (Fork 16:15).
`div.s-result-item a[href*="70966"]` war der nächste Versuch. Der Klick landete auf
einer Werbe-Adresse (`aax-events-cell02-cf.eu-central.3px.axp.amazon-adsystem.com`).
Ein Teiltreffer über `href` ist keine Textsuche; er trifft das erste Glied in
Dokumentreihenfolge, und das war eine Anzeige.

**Was `inspect` stattdessen liefert.** `browser_inspect({text:"In den Einkaufswagen"})`
fand die Elemente über `innerText` — die Suche nach Text funktioniert seit
`docs/09`. Es fehlt nur der letzte Schritt: klicken.

## Ziel

1. `browser_click` nimmt `selector` **und/oder** `contains_text`; mindestens eines
   von beiden. Beides zusammen schränkt ein: Selektor **und** Text, wie in
   `browser_inspect`. Der Name kommt aus `docs/59`.
2. `contains_text` ist ein Teilstring, Groß/Klein egal, gesucht im sichtbaren Text
   (`innerText`) — dieselbe Suche wie `browser_inspect`, samt Engste-Regel aus
   `docs/57` (die nur bei einer Textsuche greift). `click` kennt kein
   `includeHidden`; es filtert Sichtbarkeit immer.
3. **Ein exakter Treffer schlägt einen Teiltreffer** — nur hier, nicht in
   `inspect`. Verglichen wird der Text, den `textOf` liefert (`innerText`, Leerraum
   faltet die Seite bereits, `page-agent.js:840-843`), nach `trim()` und
   `toLowerCase()`; der Suchbegriff wird genauso behandelt. Es entsteht **keine
   dritte** Faltung.
   Beispiel: `contains_text: "Grey"` trifft bei „Grey" und „Grey Blue" nur „Grey".
4. **Genau ein Treffer:** klicken. Der Klick geht auf den engsten Treffer; das
   Sprudeln zum umgebenden Knopf ist die Regel, nicht die Ausnahme.
5. **Mehr als ein Treffer:** `text_ambiguous`, **kein** Klick, mit den Belegen
   `matches` (Zahl) und `candidates` (bis fünf Selektoren). Bei erreichtem
   Kandidatendeckel sagt der Satz „at least N"; der Feldwert bleibt die gezählte
   Zahl, der Satz macht daraus eine Untergrenze.
6. **Kein Treffer:** `no_match`. Der Satz nennt den Begriff, wenn nur
   `contains_text` gesetzt war, und den Selektor, wenn `selector` gesetzt war. Sind
   **beide** gesetzt, gewinnt der Begriff. Die bestehende Konstante
   `NO_MATCH_MESSAGE` (`bridge.js:284`) bleibt für den Selektor-Fall unverändert;
   die Begriff-Form kommt dazu. **Ist der Deckel erreicht, trägt die Antwort
   zusätzlich `truncated: true`**, und der Satz sagt, dass die Suche dort endete:
   Hinter dem Deckel kann ein Treffer liegen.
7. Die Lageprüfung aus `docs/56` gilt unverändert: heranscrollen, neu messen,
   notfalls `offscreen_after_scroll`.
8. Weder `selector` noch `contains_text`: `invalid_params`. Ein **leerer**
   `contains_text` ist derselbe Fall — ein Klickziel ohne Text ist keines.

**Warum bei Mehrdeutigkeit abgelehnt wird.** Ein Klick auf das falsche Element ist
der teuerste Fehler dieses Projekts: In `docs/ROADMAP.md` steht der Fall vom
2026-10-23, in dem `a[href*="termin"]` den Vertrag-kündigen-Link traf. Ein
abgelehnter Klick kostet einen Aufruf. Ein Klick auf das falsche Ziel kostet
Vertrauen.

**Was der Textklick auf Listen-Seiten leistet — und was nicht.** Auf einer
Amazon-Suchseite trägt jeder der 48 Artikel „In den Einkaufswagen" (Beispiel aus
dem Lauf, nicht gemessen); dort hilft nur `selector`. Auf einer Produktseite steht
der Text einmal, und genau dort ist der Textklick der Weg, den das 9B-Modell
gesucht hat. Diese Spec verspricht nicht mehr.

## Der Vertrag

| Feld | Regel |
|---|---|
| `selector` | wie heute; optional, einschränkend, wenn `contains_text` dazu kommt |
| `contains_text` | **neu**, optional, nicht leer; Teilstring, Groß/Klein egal, im sichtbaren Text; exakter Treffer zuerst |
| `frame`, `tab` | unverändert |
| Antwort | wie heute plus `scrolled` aus `docs/56` |
| `no_match` | nichts trifft; der Satz nennt den Suchbegriff **oder** den Selektor |
| `text_ambiguous` | **neu**, `isError: true`, `details` mit `matches` und `candidates` |
| `invalid_params` | weder noch **oder** leerer Suchbegriff; der Satz nennt beide Namen (`MISSING_TARGET_MESSAGE`, neben `MISSING_SELECTOR_MESSAGE` `bridge.js:281`) |

**Die Kandidaten brauchen den Selektorbauer.** `selectorForElement` liest
`textLimit` und `classLimit` aus der Inspect-Anfrage (`extension/page-agent.js:1179`).
Diese Spec legt die zwei Deckel als **feste Werte** in den Klick-Schnipsel — kein
neues Drahtfeld. Wer sie ändern will, ändert eine Konstante im Schnipsel, wie
`TYPEABLE_INPUT_TYPES` (`:515`). Es sind damit zwei Konstanten mit demselben Wert,
bewusst entkoppelt: `bridge.js:260` für `inspect`, eine im Schnipsel für `click`.

**Derselbe Kandidatendeckel wie `inspect`.** Der Textklick läuft über
`body.querySelectorAll('*')`, genau wie die Suche; jeder Kandidat kostet einen
`innerText`-Lesevorgang. Deshalb gilt `INSPECT_CANDIDATE_LIMIT = 5000`
(`bridge.js:260`) auch hier. Ist der Deckel erreicht, antwortet der Klick
`text_ambiguous` mit `matches` als **Untergrenze**; der Satz sagt „at least N".

**Die Belege brauchen einen Träger.** `ClickError` (`bridge.js:2728-2734`) hat kein
`details`, anders als `ReadError` (`:1848-1855`); `clickErrorFor` gibt heute nur
`{code, message}` zurück (`:2752-2754`). Ohne diesen Umbau erreichen `matches` und
`candidates` die Bridge nie. Beim Agenten bleiben sie Prosa: ein MCP-Werkzeugfehler
ist **ein** Textblock (`tool_error`, `tools.rs:1205`), den Satz baut `docs/60`.

**Der Textklick braucht einen Weg in die Seite, und der Drahtname ist `text`.**
Vier Stellen: die Op-Tabelle
`click: (args) => clickPageSource(args.selector, args.want ?? null)`
(`page-agent.js:2105`), `clickPageRequest` (`bridge.js:3028-3030`), der Payload in
`click_tool` (`bridge-rs/src/mcp/tools.rs:701-706`) — der gehört `docs/60` — und
die Argumentprüfung der Bridge. Auf der Leitung heißt das Feld **`text`**: ein Name
auf der Leitung, zwei im MCP (`selector`, `contains_text`), wie `docs/59` es für
`inspect` festlegt.

## Abhängigkeit

Baut auf `docs/59` (Name), `docs/57` (Engste-Regel) und `docs/56` (Lageprüfung) auf
und wird nach ihnen gebaut. `docs/60` baut auf dieser Spec auf: es bildet die Codes
und Felder auf die MCP-Seite ab.

## Non-goals

- **Kein neues Werkzeug.** Kein `browser_click_text`. Ein Argument, kein Aufruf.
- **Kein `contains_text` für `type`.** Dort heißt das Argument `typed_text`
  (`docs/59`).
- **Kein Index.** „Der zweite von drei Treffern" ist nicht ausdrückbar.
- **Kein regulärer Ausdruck.** Die Suche bleibt ein Teilstring.
- **Kein exakter Vorrang in `inspect`.** Dort bleibt der Teilstring die einzige
  Regel (`docs/57`).
- **Keine Wirkungsprüfung.** Was nach dem Klick geprüft wird, steht in `docs/56`.
- **Keine MCP-Arbeit.** Argumentliste, Schema, Sätze, Fixtures und Anleitung
  gehören `docs/60`.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `click_withContainsText_shouldClickTheInnermostMatchingElement` | der Textklick trifft den engsten Treffer, genau ein `click()` |
| `test/extension.test.js` | `click_withAnExactMatchAndASubstringMatch_shouldClickTheExactOne` | exakter Treffer schlägt Teiltreffer |
| `test/extension.test.js` | `click_withSelectorAndContainsText_shouldClickOnlyWhatBothMatch` | die Kombination schränkt ein |
| `test/extension.test.js` | `click_withTwoMatchesAndNoExactOne_shouldAnswerTextAmbiguousAndNotClick` | `text_ambiguous`, `matches`, Kandidaten, **kein** `click()` |
| `test/extension.test.js` | `click_withContainsTextThatMatchesNothing_shouldAnswerNoMatchWithTheTerm` | `no_match` nennt den Suchbegriff, nicht `undefined` |
| `test/extension.test.js` | `click_withAnEmptyContainsText_shouldAnswerInvalidParamsAndNotClick` | leerer Suchbegriff ist kein Ziel |
| `test/extension.test.js` | `click_withoutContainsTextAndWithoutSelector_shouldAnswerInvalidParams` | weder noch ⇒ `invalid_params` |
| `test/extension.test.js` | `click_withContainsTextOnAnElementOutsideTheViewport_shouldStillRefuseOffscreenAfterScroll` | Textklick und Lageprüfung greifen zusammen |
| `test/extension.test.js` | `click_withContainsTextInAFrame_shouldRespectTheFrameFilter` | `frame` gilt auch für den Textklick |
| `test/extension.test.js` | `click_withMoreCandidatesThanTheCap_shouldAnswerTextAmbiguousAndNotClick` | am Deckel wird nicht geklickt, auch bei genau einem Treffer: `text_ambiguous`, `matches: 1`, `truncated: true`, Satz „at least" |
| `test/extension.test.js` | `click_withMoreCandidatesThanTheCapAndNoMatch_shouldAnswerNoMatchWithTruncated` | kein Treffer vor dem Deckel: `no_match` mit `truncated: true` und dem Satz über das Deckel-Ende |
| `test/extension.test.js` | `click_withABlankSelectorAndAContainsText_shouldClickByTheTermAlone` | ein leerer Selektor neben einem Begriff zählt als „nicht gesetzt" |
| `test/extension.test.js` | `click_andType_travelAsOpsAndCarryNoCode` (bestehend, `:11174-11179`) | die Klick-Nachricht trägt jetzt ein drittes Feld `text`; bei einem Selektor-Klick ist es `null` |

## Acceptance criteria

1. **Der Textklick trifft.** Fixture `div#page > button.buy > span.label` (nur
   `span.label` trägt „Kaufen") ⇒ `browser_click({"contains_text":"kaufen"})`
   klickt genau einmal, auf `span.label`. Beleg: `npm test` ⇒ 0, `^# fail 0`,
   `^# cancelled 0`.
2. **Exakt vor Teilstring.** Fixture mit „Grey" und „Grey Blue" ⇒
   `{"contains_text":"Grey"}` klickt „Grey", ohne `text_ambiguous`. Beleg: der
   Fall `click_withAnExactMatchAndASubstringMatch_shouldClickTheExactOne` ⇒ `^ok`.
3. **Die Kombination schränkt ein.** Fixture mit zwei Knöpfen „Kaufen", einer in
   `div.korb` ⇒ `{"selector":"div.korb > button","contains_text":"Kaufen"}` klickt den
   einen (der Harness-Matcher trennt nur an `>`, siehe Dev-Plan). Beleg: der Fall ⇒ `^ok`.
4. **Mehrdeutig heißt kein Klick.** Zwei Geschwister mit demselben Text ⇒
   `text_ambiguous` mit `matches: 2`, zwei Kandidaten, kein `click()`. Beleg: der
   Fall ⇒ `^ok`.
5. **`no_match` nennt den Begriff.** `{"contains_text":"gibtsnicht"}` ⇒ `no_match`
   mit `gibtsnicht` im Satz, **nicht** `undefined`. Beleg: der Fall ⇒ `^ok`.
6. **Argumentprüfung.** Weder noch **oder** leerer Suchbegriff ⇒ `invalid_params`,
   kein Klick. Beleg: die zwei Fälle 6 und 7 ⇒ `^ok`.
7. **Alles andere grün.** `npm test` ⇒ 0 mit `^# fail 0` und `^# cancelled 0` —
   diese Suite ist die einzige, die diese Spec betrifft; dazu `npm run check` ⇒ 0
   und `cargo test` ⇒ `test result: ok` mit `0 failed` (kein Rust geändert).
8. **Live, Betreiber.** Auf einer Amazon-Produktseite:
   `browser_click({"contains_text":"In den Einkaufswagen"})` antwortet entweder mit
   einem Erfolg oder mit `text_ambiguous` und Kandidaten — nie mit einem Klick auf
   eine Anzeige.

## Dev plan

Verfasst von einem zweiten Autor (2026-11-23), geprüft gegen den Code.

1. **Stufe 1 — Testinfrastruktur (`test/extension.test.js`)**
   Kein zweiter Baum neben `createInspectElement`: der Inspect-Realm hat schon alles, was die
   Textsuche braucht — `children`, `parentNode`, `innerText`, ein Rect mit `x`/`y`, `disabled`,
   `getAttribute` (`:9228-9278`), `document.querySelectorAll`/`documentElement`
   (`:893-902`), `body.querySelectorAll` (`:9293-9303`) und `selectorForElement`-taugliche
   Selektoren über `matchesSelector`. Der Klick-Realm hat davon nichts: `createClickElement`
   (`:1300-1327`) kennt kein `innerText`, keine `children`, kein `parentNode`, `bodyOf`
   liefert `createBodyStub` (`:1360-1381`), dessen `querySelectorAll` absichtlich wirft
   (`:1373-1375`). Ein zweiter Baum wäre eine zweite Antwort auf eine Frage, die `docs/57`
   gerade erst beantwortet hat.
   Zu bauen: `click()` mit `clicks`-Zähler und `scrollIntoView`/`scrolls` auf
   `createInspectElement` (dieselben zwei Zusätze, die `docs/56` Stufe 1 an
   `createClickElement` macht); `createInspectBody` bekommt den Text der Seite
   (`page.bodyText`), weil der dritte Schritt eines Klicks liest: `textOf`
   (`page-agent.js:138-144`) fällt auf `withoutNonTextElements(body)`
   (`:123-127`) zurück, das ruft `cloneNode(true)` — der Stub hat keins, und der Klick
   endet als `read_failed`; ein Helfer `createTextClickPage({ children })` über
   `createInspectPage` (`:9375-9387`) mit `url`/`title` aus `DEFAULT_CLICK_PAGE` (`:6824-6828`).
   Unangetastet: `createClickElement`, `createBodyStub`, `bodyOf` (`:1392-1398`),
   `createClickPage` (`:6838-6844`).
   Proof: `npm test; echo $?` ⇒ 0 mit `^# fail 0`; die bestehenden `inspect_…`- und
   `click_…`-Fälle und die `page.queries`-Zähler bleiben grün, weil die Änderung additiv ist.
   Einen eigenen `^ok` hat diese Stufe nicht — der erste Fall, der sie benutzt, steht in
   Stufe 3. Sie bleibt trotzdem getrennt, damit der Reviewer die Harness-Änderung ohne
   Produktcode-Diff sieht.

2. **Stufe 2 — die Suche und der Klick (`extension/page-agent.js`)**
   `clickPageSource(selector, containsText, want)` (`:455-486`): `isAddressedFrame` bleibt die
   erste Anweisung (`:459-461`); der Selektor-Pfad (`:463-481`) läuft nur, wenn ein Selektor
   gesetzt ist; die Kandidaten sind `document.querySelectorAll(selector)` bei beiden Angaben,
   sonst `body.querySelectorAll("*")` — dieselbe Menge und Reihenfolge wie in
   `inspectPageSource` (`:817-822`), Deckel `CLICK_CANDIDATE_LIMIT = 5000` als eigene Konstante
   im Schnipsel (Wert wie `bridge.js:260`, `## Bekannte Lücken`); Sichtbarkeit immer
   (`isVisible`, kein `includeHidden`); dann `dropAncestorsOfMatches` aus `docs/57` Stufe 1
   **nur** bei gesetztem, nicht leerem Begriff; dann der exakte Vorrang (`trim().toLowerCase()`
   auf beiden Seiten, keine dritte Faltung); genau ein Treffer ⇒ `click()`, mehrere ⇒
   `{ outcome: "text_ambiguous", matches, candidates, truncated }` mit bis zu fünf Selektoren
   aus `selectorForElement(el, 200, 10)` — die zwei Zahlen sind Argumente an der Aufrufstelle,
   kein Drahtfeld. Eintrag der Op-Tabelle (`:2105`):
   `click: (args) => clickPageSource(args.selector, args.text ?? null, args.want ?? null)`.
   Proof: dieselben Fälle wie Stufe 3, aber über `callPageAgentOp` (`:6515-6532`) — der helle
   Weg ohne Bridge; er zeigt den Rückgabewert des Ops (`outcome`, `clicked`, `matches`,
   `candidates`). `docs/56` Stufe 1 hat diesen Weg für `scrolled` verworfen, weil dort das Feld
   die Bridge passieren muss; hier ist der Rückgabewert selbst die Behauptung.

3. **Stufe 3 — Argumente, Codes, Träger (`extension/bridge.js`)**
   `clickRequestSelector` (`:2767-2773`) wird eine Prüfung über beide Argumente und gibt
   `{ selector, text }` zurück; `MISSING_SELECTOR_MESSAGE` (`:281`) **bleibt**, `type` benutzt
   sie (`:3084`), daneben kommt `MISSING_TARGET_MESSAGE`; `click_withASelectorThatIsNotAString…`
   (`:7414`) bleibt grün, `click_withoutASelector…` (`:7399`) wird der „weder noch"-Fall.
   `ClickError` (`:2728-2734`) bekommt `details` wie `ReadError` (`:1848-1855`), `clickErrorFor`
   (`:2752-2760`) reicht sie durch — sonst erreichen `matches` und `candidates` die Bridge nie.
   `clickOutcomeOf` (`:2959-2969`) hängt die drei Felder an den `ClickError`, das Paar aus
   `docs/56` Stufe 1 bleibt. `text_ambiguous` in `CLICK_OUTCOMES` und `CLICK_REFUSAL_MESSAGES`
   (`:505-510`) — ohne den Eintrag wirft `clickOutcomeOf` `click_failed`. `clickPageRequest`
   (`:3028-3030`) schickt `text`.
   Proof: die Fälle 1 bis 10 der Tabelle, je Name
   `npm test | grep -cE '^ok [0-9]+ - <name>'` ⇒ 1; dazu der geänderte Pin
   `click_andType_travelAsOpsAndCarryNoCode` (`:11150`, Zusicherung `:11176-11180`) mit
   `args: { selector, text: null, want: null }`; `npm test; echo $?` ⇒ 0 mit `^# fail 0` und
   `^# cancelled 0`.
   **Stufe 1 bis 3 gehen in einem Auftrag:** `clickRequestSelector` weist einen Aufruf ohne
   `selector` ab (`:2767-2772`), `clickPageRequest` schickt kein `text`, und `text_ambiguous`
   fehlt in `CLICK_OUTCOMES` — jeder der zehn Fälle hängt an allen drei Stufen.

4. **Stufe 4 — Doku**
   `docs/06`, `docs/README.md` (Status), `docs/PROJECT-STATE.md` (Abschnitt „Beweise"), die
   zwei Fallzahlen in `docs/54` Kriterium 4; der Amendments-Abschnitt entfällt, die Spec wird
   `active`.
   Proof: `npm run check; echo $?` ⇒ 0; `grep -n '58-klick' docs/README.md` zeigt `active`.
   Kriterium 7: `cargo test --manifest-path bridge-rs/Cargo.toml -- --test-threads=1` ⇒
   `test result: ok` mit `0 failed` (kein Rust geändert).

**Was schiefgehen kann**

- **Kriterium 3 ist mit dem genannten Selektor nicht prüfbar.** `div.korb *` scheitert am
  Matcher des Harness: `matchesSelector` trennt nur an `>` (`:9562`), und
  `parseCompoundSelector` wirft bei einem Leerzeichen-Teil (`:9497-9513`) — die Seite antwortet
  `invalid_selector`, nicht „ein Klick". Entweder schickt der Fall `div.korb > button` (dann
  ist das Kriterium wörtlich nicht erfüllt) oder der Fall läuft im Klick-Realm mit dem
  exakten Schlüssel in `page.elements` (`:1255-1259`). Das ist eine Entscheidung des
  Betreibers, keine des Umsetzers.
- **Der dritte Schritt liest.** Auf einem `dom: true`-Realm liefert `createInspectBody` heute
  `innerText: ""` und `textContent: ""`; `withoutNonTextElements` (`:123-127`) ruft
  `cloneNode` und der Klick endet als `read_failed`. Das ist der Grund für `page.bodyText` in
  Stufe 1 und der wahrscheinlichste Stolperstein des Inkrements.
- **`page.dom` schaltet mehr als `querySelectorAll`:** `bodyOf` (`:1393`) und `querySelectorIn`
  (`:1274`) hängen an demselben Schalter. Die bestehenden Klick-Fälle dürfen ihn nicht
  setzen, sonst verlieren sie ihren `page.elements`-Schlüssel.
- **`matches` ist am Deckel eine Untergrenze,** und `docs/60` braucht „at least". Der Träger
  dafür ist in keiner der beiden Specs benannt; der Plan nimmt `truncated` — dasselbe Wort,
  das `inspect` schon für „count ist eine Untergrenze" führt (`page-agent.js:827-829`,
  `:1158-1160`).

**Reihenfolge und Abhängigkeiten**

Voraussetzungen, die im Baum liegen müssen, bevor Stufe 1 beginnt — alle drei sind heute
nicht gebaut (`grep -rn 'offscreen_after_scroll\|scrolled\|dropAncestorsOfMatches' extension/
test/` ⇒ nichts am 2026-11-23): `docs/59` Stufe 1 (Name `contains_text`), `docs/57` Stufe 1
(`dropAncestorsOfMatches`), `docs/56` Stufe 1 (`scrolled`, `offscreen_after_scroll` und
`innerWidth`/`innerHeight` im Realm — ohne die zwei Fensterzahlen liest die Lageprüfung
`undefined`, Fall 8). Diese Spec baut keines der drei. Stufe 1 → 2 → 3 (ein Auftrag),
Stufe 4 zuletzt.

**Was der nächste Inkrement erbt**

`docs/60` bildet `text_ambiguous`, `no_match` mit Begriff und `ClickError.details` auf die
MCP-Seite ab; ohne diese Spec gibt es dort nichts abzubilden. `docs/61` hängt am selben
`clickErrorFor` (`:2752-2760`). Das Live-Kriterium 8 bleibt Betreiber-Messung; die
Listen-Seiten-Grenze (`## Bekannte Lücken`) ist kein Arbeitsauftrag.
## Touch boundary

| erlaubt | nicht |
|---|---|
| `extension/page-agent.js` (`clickPageSource`, Op-Tabelle), `extension/bridge.js` (Argumente, `ClickError`, Codes, `clickPageRequest`) | `extension/page-agent.js`-Lesepfad; `inspectPageSource` nur über den Helfer aus `docs/57` |
| `test/extension.test.js` (Harness und Fälle) | `bridge-rs/**` — das ist `docs/60` |
| `docs/06`, `docs/README.md`, `docs/PROJECT-STATE.md`, `docs/54` (Fallzahlen) | `docs/56`, `docs/57`, `docs/59`, `docs/60` |

## Bekannte Lücken

- **Auf Listen-Seiten ist der Textklick unbrauchbar.** Der Rat im Satz führt über
  `selector` und `inspect` weiter. Nicht gemessen (2026-11-23).
- **Das Amazon-Markup für den Knopf ist nicht verifiziert.** Belegt ist nur, dass
  `querySelectorAll('button, a')` ihn nicht fand. Kriterium 8 zeigt es
  (2026-11-23).
- **Der exakte Vorrang ist eine zweite Regel**, nur in `click`. Ein Aufrufer, der
  in `inspect` sucht, sieht sie nicht. Gewollt (Betreiberentscheid 2026-11-23).
- **Zwei Konstanten für denselben Deckel.** `bridge.js:260` und der Schnipsel
  tragen je eine 5000; wer eine ändert, muss die andere finden (2026-11-23).

## Open questions

**Keine.** Entschieden am 2026-11-23: `contains_text` (`docs/59`), ablehnen mit
Rat, exakter Vorrang nur in `click`, Kombination mit `selector` erlaubt.

## Review

### Runden 1 bis 3 der Vorgänger-Spec

Die Spec geht auf die Vorgängerfassung vom 2026-11-23 zurück; die hatte drei
Runden. Kürzeststand, damit nichts verloren geht:

- **Runde 1** (2026-11-23, `🔧`): vier Blocker — `matches`/`candidates` erreichten
  die Bridge nicht, Stufe 0 nannte eine Fixture zu wenig, `no_match` hätte
  `undefined` gesagt, woher die Kandidaten kommen fehlte.
- **Runde 2** (2026-11-23, `🔧`): zwei Blocker — `text_ambiguous` fehlte in
  `CLICK_OUTCOMES`, der „weder noch"-Satz hatte keinen Träger. Dazu `contains_text`
  ohne Weg in die Seite, Drahtname offen, Felder als Prosa, Kandidatendeckel.
- **Runde 3** (2026-11-23, `🔧 geteilt`): vier Mängel und der Beschluss, die Spec
  an der Leitung zu teilen — hier Teil a, `docs/60` ist Teil b.

### Runde 4 — `🔧 Fix these` für die geteilte Spec

Der Gate hat die Spec nach der dritten Runde als zu groß bezeichnet (fünf Stufen,
sieben Produktivdateien, zwei eingefrorene Fixtures, Harness). Die Teilung ist
vollzogen: diese Spec endet an der Extension, `docs/60` trägt die MCP-Naht. Die
Befunde der Runden 1 bis 3 sind eingearbeitet; die Runde-Protokolle stehen in
`docs/60`, soweit sie die MCP-Seite betreffen.

### Runde 5 und 6 — `🔧 Fix these` (2026-11-23)

Runde 5: der Stufe-1-Beweis hing an Stufe 2/3, und die Einheit von 1 bis 3 fehlte.
Runde 6: ein Satz in `docs/58` blieb widersprüchlich. Beide eingearbeitet. Ein
abschließendes Gate-`✅` gibt es für diese Spec **nicht** — die letzten zwei Zeilen
hat der Orchestrator von Hand eingearbeitet und mit `grep` geprüft; der Code-Review
für dieselbe Spec gab `✅`.

## Log

- **2026-11-23, angelegt und geteilt.** Belege aus dem Export
  `2026-11-23_conversations.zip`. Geteilt nach dem dritten Gate-Block; die
  MCP-Hälfte ist `docs/60`.

- **2026-11-23, Absprache.** Der Betreiber hat Ziel und Abnahmekriterien dieser
  Spec abgestimmt (`CONTRIBUTING.md`, Schritt 2). Der Bau kann beginnen, sobald
  der Dev-Plan von einem zweiten Autor geprüft ist.

- **2026-11-23, Deckelpfad präzisiert (Code-Review).** Zwei Regeln, die der Text
  vorher nicht trug: Bei erreichtem Deckel sagt der Satz „at least N", weil der
  Feldwert die gezählte Zahl bleibt. Und ein `no_match` am Deckel trägt
  `truncated: true` samt Satz, dass die Suche dort endete — sonst behauptet die
  Antwort „nichts gefunden", obwohl Kandidaten nie gelesen wurden.

- **2026-11-23, Stufe 4 nachgezogen, Spec `active`.** `docs/06` nennt `selector`
  oder `contains_text`, den neuen Fehler `text_ambiguous` mit seinen Belegen und die
  Begriff-Form von `no_match` samt Deckel. `docs/54` trägt die drei neuen Sätze mit
  Datum und sagt, dass der Umlaut-Wächter sie nicht deckt (sie stehen in
  `extension/bridge.js`) — die Node-Fälle pinnen sie. `docs/53` braucht keine
  Änderung: es beschreibt das Verfahren der Anleitung, nicht ihren Inhalt.
  Fallzahlen abgelesen: `cargo test` 296 (126 in `mcp.rs`), `npm test` 574.
