---
description: browser_click trifft künftig auch nach Text — contains_text allein oder zusammen mit selector, engster Treffer, exakter Treffer zuerst, bei Mehrdeutigkeit text_ambiguous mit Kandidaten; Teil a der Teilung vom 2026-11-23, alles in der Erweiterung.
status: proposed
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
   `matches` (Zahl) und `candidates` (bis fünf Selektoren).
6. **Kein Treffer:** `no_match`. Der Satz nennt den Begriff, wenn nur
   `contains_text` gesetzt war, und den Selektor, wenn `selector` gesetzt war. Sind
   **beide** gesetzt, gewinnt der Begriff. Die bestehende Konstante
   `NO_MATCH_MESSAGE` (`bridge.js:284`) bleibt für den Selektor-Fall unverändert;
   die Begriff-Form kommt dazu.
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

## Amendments to previous spec docs

- **`docs/06-klicken.md`**: `selector` ist nicht mehr Pflicht; `contains_text`
  kommt dazu, auch zusammen mit `selector`; `text_ambiguous` und
  `offscreen_after_scroll` sind neue Fehler; die Antwort trägt `scrolled`.

Nach der Umsetzung wird dieser Abschnitt entfernt.

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
   `div.korb` ⇒ `{"selector":"div.korb *","contains_text":"Kaufen"}` klickt den
   einen. Beleg: der Fall ⇒ `^ok`.
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

Entwurf des Spec-Autors. Nach `CONTRIBUTING.md`, Schritt 3, gehört der Dev-Plan zu
einem zweiten Autor.

**Stufe 1 — das Harness (`test/extension.test.js`)**

Ohne diese Stufe ist **kein** Fall der Tabelle lauffähig. Der Klick-Realm gibt
`document.querySelectorAll` nur bei `page.dom === true` (`:893-902`) und
`createClickPage` setzt das nicht (`:6838-6844`); `bodyOf` liefert für eine
Klick-Seite `createBodyStub` (`:1360`), dessen `querySelectorAll` absichtlich
wirft (`:1373-1375`). `createClickElement` (`:1300-1327`) hat kein `innerText`,
kein `children`, kein `parentNode` und ein konstantes Rect ohne `x`/`y`.

Also: `document.querySelectorAll`/`body.querySelectorAll` im Klick-Realm,
`innerText`, `children` und `parentNode` für `createClickElement`, ein
`createClickPage({ elements })` für den Baum der Fälle.

Beweis: ein `func`-Lauf über den neuen Helfer, der `document.querySelectorAll`
und `parentNode` im Klick-Realm zeigt. Die Fälle der Tabelle werden erst mit dem
Sammel-Auftrag oben grün.

**Stufen 1 bis 3 gehen in einem Auftrag.** Der Fall der Tabelle
(`click_withContainsText_shouldClickTheInnermostMatchingElement`) hängt an der
ganzen Kette: `clickRequestSelector` weist einen Aufruf ohne `selector` ab
(`bridge.js:2767-2772`), `clickPageRequest` schickt kein `text` (`:3028-3030`), und
`text_ambiguous` fehlt ohne Stufe 3 in `CLICK_OUTCOMES` (`:505`). Zwischenbeweis
ohne Bridge: der `func`-Lauf der Seite.

**Stufe 2 — die Suche und der Klick (`extension/page-agent.js`)**

`clickPageSource(selector, containsText, want)`: Sind beide gesetzt, erst den
Selektor anwenden, dann die Textsuche darauf. Dann die Engste-Regel aus `docs/57`
(die nur bei Textsuche greift), **dann** den exakten Vorrang, dann klicken. Mehr
als ein Treffer ⇒ `text_ambiguous` mit Kandidaten; Deckel 5000, feste
`textLimit`/`classLimit` im Schnipsel. Der Eintrag der Op-Tabelle (`:2105`) trägt
das neue Argument.

Beweis: Fälle 1 bis 5 der Tabelle über den `func`-Runner (der `func`-Lauf sieht
den Rückgabewert der Seite, ohne Bridge).

**Stufe 3 — Argumente und Codes (`extension/bridge.js`)**

`clickRequestSelector` wird zu einer Prüfung über beide Argumente. `ClickError`
bekommt `details` wie `ReadError`; `clickErrorFor` reicht sie durch.
`text_ambiguous` wandert in `CLICK_OUTCOMES` und `CLICK_REFUSAL_MESSAGES`
(`:505-510`) — ohne den Eintrag wirft `clickOutcomeOf` (`:2959-2969`)
`click_failed`. Der leere Suchbegriff und „weder noch" bekommen ihren Satz neben
`MISSING_SELECTOR_MESSAGE` (`:281`). `clickPageRequest` (`:3028-3030`) schickt
`text` mit.

Beweis: Fälle 4 bis 6 und die Belegfelder aus Fall 4.

**Stufe 4 — die Doku**

`docs/06`, `docs/README.md`; der Amendments-Abschnitt entfällt, die Spec wird
`active`. Die Fallzahlen in `docs/54` Kriterium 4 und `PROJECT-STATE.md:33-34`
werden nachgezogen.

Beweis: `npm run check` ⇒ 0 und `grep -n '58-klick' docs/README.md` zeigt
`active`.

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

### Runde 5 — steht aus

## Log

- **2026-11-23, angelegt und geteilt.** Belege aus dem Export
  `2026-11-23_conversations.zip`. Geteilt nach dem dritten Gate-Block; die
  MCP-Hälfte ist `docs/60`.

- **2026-11-23, Absprache.** Der Betreiber hat Ziel und Abnahmekriterien dieser
  Spec abgestimmt (`CONTRIBUTING.md`, Schritt 2). Der Bau kann beginnen, sobald
  der Dev-Plan von einem zweiten Autor geprüft ist.
