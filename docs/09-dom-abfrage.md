---
description: browser_inspect listet die Elemente des Agenten-Tabs auf — per CSS-Selektor oder Textsuche, mit Tag, id, class, href, sichtbarem Text, Sichtbarkeit und einem fertigen Selektor zum Weiterverwenden — damit der Agent sieht statt rät.
status: active
---

# Sehen statt raten: `browser_inspect`

Die teuerste Stunde der bisherigen Arbeit war eine, in der der Agent **raten**
musste, was auf der Seite steht. Rund 25 geratene CSS-Selektoren
(`[data-testid*="warenkorb"]`, `input[placeholder*="nachricht"]`, … — hier
stehen erfundene Beispiele), davon einer ein **Fehlklick auf einen
Vertrags-Link**, weil ein Teilstring-Filter auch die Kündigungsseite traf. Und ein Chat-Widget, das sich nicht wieder öffnen
ließ, weil niemand seinen Launcher kannte.

Dieses Inkrement gibt dem Agenten die Augen: **eine Liste der Elemente mit ihren
Attributen und einem fertigen Selektor**, den er direkt an `browser_click` oder
`browser_type` weitergeben kann.

## Ziel

`browser_inspect({selector?, text?, limit?, includeHidden?})` liefert die
passenden Elemente:

```json
{"tabId":18,"url":"https://…","title":"…","count":12,"truncated":false,
 "elements":[{"index":0,"selector":"button[data-testid=\"demo-knopf\"]","tag":"button",
              "id":null,"classes":["knopf","knopf--wichtig"],"text":"Erfundener Knopftext",
              "href":null,"ariaLabel":null,"visible":true,"disabled":false,
              "rect":{"x":640,"y":710,"width":220,"height":48}}]}
```

- **Filter**: `selector` (CSS) **oder** `contains_text` (Teilstring, Groß/Klein egal, gesucht im sichtbaren Text des Elements) — mindestens eines. Beide zusammen: beide Bedingungen, also Selektor **und** Text. Keines: `invalid_params`. Ein **leerer** String zählt als gesetzt: `selector: ""` wirft in der Seite (`invalid_selector`), `contains_text: ""` passt auf alles und wird vom `limit` geschnitten. Der Name `contains_text` gilt seit `docs/59`; er trennt die Suche vom Text, der in `browser_type` geschrieben wird (`typed_text`).
- **`count`** ist die Zahl der Treffer **nach** dem Sichtbarkeitsfilter und **vor**
  dem `limit`-Schnitt. Der **Deckel von 5 000 zählt geprüfte Kandidaten — in
  beiden Pfaden gleich**. Unterhalb des Deckels ist `count` exakt; wird der
  Deckel erreicht, ist `count` eine Untergrenze und `truncated: true` (ein
  Selektor mit 10 000 Treffern liefert also `count: 5000`).
- **`limit`**: 1–200, Default 50. `truncated: true`, wenn `elements` weniger
  Elemente enthält als `count` — oder wenn der Deckel erreicht wurde. Das Feld
  heißt beidesmal „es war mehr da".
- **`includeHidden`**: Default `false` — unsichtbare Elemente (Fläche 0, `display:none`, `visibility:hidden`) werden ausgelassen. Mit `true` kommen sie mit `visible: false`.
- **`selector` je Element** ist der Punkt: eine Zeichenkette, die **denselben** Element über `document.querySelector` wiederfindet. Reihenfolge der Versuche: `tag#id`, `[data-testid="…"]`, `tag[aria-label="…"]`, `tag[name="…"]`, `tag.class1.class2` (nur wenn eindeutig), sonst ein Pfad aus `tag:nth-of-type(n)` bis zur Wurzel. **Eindeutigkeit wird geprüft** (`document.querySelectorAll(candidate).length === 1`), sonst die nächste Stufe.
- **`text`** ist der sichtbare Text des Elements (`innerText`), auf **200 Zeichen** gekürzt, Zeilenumbrüche zu Leerzeichen.
- **`classes`** höchstens 10, `id`/`href`/`ariaLabel` gekürzt wie `text`.
- **`rect`** aus `getBoundingClientRect()`: `Math.round` je Wert, Einheit Pixel,
  Ursprung links oben im **Viewport** (CSS-Pixel, also zoombhängig) — nicht in
  der Seite.

Kein Klick, keine Änderung an der Seite, kein Slot, keine Wartezeit: `inspect`
liest nur.

## Non-goals

- **Kein Auswerten von JavaScript-Ausdrücken** — das ist `browser_eval` (Roadmap
  08f, eigene Spec mit eigener Entscheidung). `browser_inspect` beantwortet eine
  Frage, es führt keinen Code aus.
- Kein Klicken, Tippen, Scrollen — auch nicht „nur zum Ansehen".
- ~~Kein Shadow DOM (Roadmap 16)~~ — **seit Spec 27 über `>>>`** (offene Wurzeln, je Glied
  ein einfacher Selektor): `querySelector` sieht dort nichts, und das bleibt
  so, bis das eigene Inkrement kommt.
- Kein XPath, kein Regex, keine CSS-Pseudoklassen-Unterstützung jenseits dessen,
  was `querySelector` ohnehin kann.
- Keine Bilder, kein Screenshot, keine Barrierefreiheits-Analyse.
- Keine neue Berechtigung: `<all_urls>` deckt die Injektion.

## Wire-Protokoll (neu: `inspect`)

`PROTOCOL.METHODS` bekommt `INSPECT: "inspect"`. Anfrage:

```json
{"type":"request","id":7,"method":"inspect",
 "params":{"text":"Warenkorb","includeHidden":false,"limit":20}}
```

Antwort: `{ok:true, result:{tabId, url, title, count, truncated, elements:[…]}}`
wie oben.

- **`invalid_params`**: weder `selector` noch `contains_text` gesetzt; `limit`
  außerhalb 1–200; `selector`/`contains_text` kein String; `includeHidden` kein
  Boolean.
- **`invalid_selector`**: `querySelector` wirft.
- **Leere Treffermenge ist kein Fehler**: `count: 0`, `elements: []`.
- **`about:`-Adresse** oder Seite ohne Body: `count: 0` — kein Sonderfall, es wird
  nichts gelesen, was es nicht gibt.
- **`not_readable`**: Injektion abgelehnt (interne Seite, PDF) — wie bei `read`.
- **`inspect_failed`**: die Injektion lief, lieferte aber eine **unbrauchbare
  Ergebnisform** — erkannt in `inspectResultOf`, genau wie `read_failed`. Ein
  **Wurf im Seiten-Schnipsel** bleibt `not_readable`: `injectPageCode` bildet
  jede Ablehnung von `executeScript` darauf ab, und das ist nicht änderbar, ohne
  `read` mitzuziehen. Kein äußeres `try` — es könnte nie etwas anderes sehen.

## MCP-Werkzeug

| Feld | Wert |
|---|---|
| `name` | `browser_inspect` |
| `description` | Works on the **current** agent tab and takes **no** URL — call `browser_navigate` first. Lists the elements of the agent tab (by CSS selector and/or text search) with tag, id, class, link, visible text, visibility and a ready-made selector to reuse. `my-card >>> button` steps right of the `>>>` into the open shadow tree of `my-card` (several levels allowed); every step is a simple selector — type, `#id`, `.class`, `[attr="value"]` or `:nth-of-type(n)`; closed shadow trees stay out of reach, and without `>>>` nothing changes. Changes nothing on the page. With `tab` exactly that tab, without `tab` the one used last. |
| `inputSchema` | `{"type":"object","properties":{"selector":{"type":"string"},"text":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":200},"includeHidden":{"type":"boolean"},"frame":{"type":"string","minLength":1}},"additionalProperties":false}` |

`tools/call`:

- **Erfolg**: `{"content":[{"type":"text","text":"<JSON, 2 Leerzeichen eingerückt>"}]}`.
- **weder `selector` noch `contains_text`**: `isError`, "browser_inspect needs `selector` or `contains_text`."
- **`limit`/`includeHidden` falscher Typ, fremder Schlüssel**: `-32602` bzw.
  der Tabellensatz je Werkzeug.
- **`invalid_selector`**: `isError`, „The selector is invalid: <selektor>."
- **`not_readable`**: `isError`, derselbe Satz wie bei `browser_read`.
- **`no_agent_tab`**: `TOOL_TEXTS.NO_AGENT_TAB`.
- **`invalid_params`** (etwa `limit: 201` von einem Client, der das Schema nicht
  liest): eigener Satz, „The parameter is invalid." — **ohne Feldnamen**, weil
  der Hub nur den Code weiterreicht und die Bridge die Spanne bewusst nicht
  prüft (die Grenze ist die Regel der Extension). Der Satz lautet also für jeden
  `invalid_params` gleich, statt einen Feldnamen zu erfinden.
- **`inspect_failed`** und **anderer Code**: `CALL_EXTENSION_FAILED(code)`.

## Hub

Keine strukturelle Änderung. Logzeile:
`inspect selector=<selektor|-> text=<text|-> found=<n>` — **kein Elementtext**,
nur der Filter und die Trefferzahl; `<->` steht für „nicht gesetzt". Der Filter
steht **roh** in der Zeile, auch wenn er im Debug-Block redigiert wird: er ist
die **Eingabe des Aufrufers**, nicht gelesener Seiteninhalt. Wird der Selektor
aus einem vorherigen `inspect`-Ergebnis übernommen, kann er Seitentext tragen —
das ist die Grenze dieser Regel und steht hier, damit sie niemand für ein
Versehen hält. Bei
`BC_LOG=debug` der Ergebnisblock mit **redigierten** Werten je Element:
`text`, `href`, `id`, `ariaLabel`, `selector` und die `classes` werden
`"<n chars>"` — `selector` eingeschlossen, weil ein Kandidat wie
`tag[aria-label="…"]` den Seitentext im String trägt. `index`, `tag`, `visible`,
`disabled`, `rect` und `url` bleiben. **`title` erscheint seit Spec 28 als Länge**
(nachgezogen 2026-11-18): ein Seitentitel ist Seiteninhalt, und die Whitelist
entscheidet das, nicht der Zufall einer geschriebenen Zeile. Alles, was
Elementinhalt ist, darf nicht auf stderr.

## Extension

- `answerInspect`/`inspectErrorFor` (Muster: `answerRead`/`readErrorFor`);
  `inspectRequestParams(params)` prüft die vier Parameter **vor** der
  Tab-Auflösung; `inspectAgentTab` nutzt die gemeinsame Tab-Auflösung
  (`no_agent_tab`) und das vorhandene `injectPageCode`.
- `inspectPageSource(request)` per `toString()`, Grenzen als Argument:
  Kandidaten sammeln (`selector` ⇒ `querySelectorAll`, sonst alle Elemente unter
  `body`), Textfilter (`innerText` enthält, case-insensitiv), Sichtbarkeit über
  das geteilte `isVisible`, `limit` schneiden, je Element `selector`, `rect`,
  `classes`, `disabled`. **`describeElement` wird hier nicht benutzt** — der
  gelieferte `selector` *ist* die Beschreibung, ein zweites Feld gibt es nicht.
- **Kandidaten-Deckel: 5 000.** Wer mehr Elemente prüfen müsste, bekommt die
  ersten 5 000 und `truncated: true`. Ohne Deckel wäre eine Textsuche auf einer
  großen Seite ein Rechenauftrag ohne Ende, weil jedes Element `innerText`
  (Layout) kostet.
- Der Selektor-Bauer läuft **im Seitenkontext** (er braucht
  `querySelectorAll` für die Eindeutigkeitsprüfung) und ist eine eigene
  Funktion, die per `toString()` mitgeschickt wird. **Er schließt über nichts** —
  `toString()` verliert den Modul-Scope, deshalb kommen alle Grenzen als
  Argumente herein (Muster: `describeElement`, dessen Kommentar das schon sagt).

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `test/protocol.test.js` — `METHODS.INSPECT` | Steht wörtlich in beiden Kopien |
| `test/extension.test.js` — weder `selector` noch `contains_text` | `invalid_params`, keine Injektion |
| dito — `limit: 0`, `limit: 201`, `includeHidden: "ja"` | `invalid_params`, keine Injektion |
| dito — unparsbarer Selektor | `invalid_selector` |
| dito — Selektor ohne Treffer / Text ohne Treffer | `count: 0`, `elements: []`, **kein** Fehler |
| dito — Selektor auf Knopf | Treffer mit `tag`, `id`, `classes`, `text`, `href`, `visible`, `disabled`, `rect` |
| dito — Textsuche (Groß/Klein egal) | findet dasselbe Element über `contains_text` statt `selector` |
| dito — `includeHidden: false` (Default) | unsichtbares Element fehlt; mit `true` erscheint es mit `visible: false` |
| dito — `limit: 1` bei 3 Treffern | `elements.length === 1`, `count: 3`, `truncated: true` |
| dito — **der gelieferte Selektor trifft wieder** | für jedes Element: `querySelector(element.selector)` liefert **genau** dieses Element (Rundlauf im Stub) |
| dito — **Gegenprobe: ein falscher Kandidat trifft nicht** | zwei Kandidaten in **unterstützter** Form liefern im Stub **keinen** Treffer: `a#andere-id` (richtige Grammatik, falsches Element) und `p:nth-of-type(1)` gegen das zweite Absatz-Element. Ein nicht unterstützter Kandidat (`a[href*="x"]`) beweist nur, dass der Matcher wirft, nicht dass er unterscheidet |
| dito — **zwei gleiche Geschwister** (`div.knopf` ×2) | `tag.c1.c2` ist nicht eindeutig, der Bauer fällt auf den Pfad durch und der Pfad trifft das richtige der beiden |
| dito — Element ohne `id`/`class`/`data-testid` | Pfad-Selektor (`tag:nth-of-type(n)`), der wieder trifft |
| dito — Text über 200 Zeichen | `text` gekürzt, `\\n` zu Leerzeichen |
| dito — kein Agenten-Tab | `no_agent_tab` |
| dito — `selector: ""` / `contains_text: ""` | leerer Selektor ⇒ `invalid_selector`; leerer Suchbegriff ⇒ Treffer, vom `limit` geschnitten |
| dito — unsichtbares Element bei `includeHidden: false` | `count` zählt es **nicht** (Zählung nach dem Sichtbarkeitsfilter) |
| dito — Ergebnisform unbrauchbar (Stub liefert etwas, das nicht zur Form passt) | `inspect_failed` |
| dito — Schnipsel wirft | `not_readable` (so bildet `injectPageCode` es ab) |
| dito — Seite nicht injizierbar | `not_readable` |
| `test/extension.test.js` — erzeugter Code für `click`/`type` | die Zeichenkette ist **exakt** dieselbe wie vor dem dritten Parameter von `pageSnippetCode` (Vergleich gegen den Wortlaut im Test), sonst ist „byte-identisch" nur eine Behauptung |
| `test/hub.test.js` — `request("inspect", …)` | Logzeile `inspect selector=a#cart-link text=- found=1`, **kein** Elementtext darin |
| dito — `BC_LOG=debug` | Debug-Block mit `text: "<n chars>"` je Element, Elementtexte nicht in den Logzeilen |
| `test/mcp.test.js` — `tools/list` | Dreizehn Werkzeuge (sieben bis Spec 09, zwölf ab Spec 24, dreizehn ab Spec 32), `browser_inspect` mit den vier Eigenschaften plus `frame` und `additionalProperties:false` |
| dito — Erfolg, weder Selektor noch Text, `invalid_selector`, `no_agent_tab` | je der Satz aus `## MCP-Werkzeug`; abgelehnte Aufrufe erreichen die Extension nicht (Fixture-Zähler) |
| dito — `invalid_params` von der Extension (`limit: 201` durchgereicht) | eigener Satz, **nicht** `CALL_EXTENSION_FAILED` |

## Acceptance criteria

1. `npm test; echo $?` → `0`, Ausgabe enthält `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. Von den 243 bisherigen Fällen laufen **242
   unverändert**; **einer muss sich ändern**: der Werkzeugzahl-Fall in
   `test/mcp.test.js` (`…SixTools…` → `…SevenTools…`).
2. `tools/list` liefert dreizehn Werkzeuge (sieben bis Spec 09, zwölf ab Spec 24, dreizehn ab Spec 32); `browser_inspect` hat `selector`,
   `text`, `limit`, `includeHidden`, `additionalProperties: false`.
3. Mit Fake-Extension liefert `browser_inspect` JSON mit `tabId`, `url`, `title`,
   `count`, `truncated`, `elements`; jedes Element hat `index`, `selector`, `tag`,
   `id`, `classes`, `text`, `href`, `ariaLabel`, `visible`, `disabled`, `rect`.
4. **Der Rundlauf ist der Kern**: für jedes gelieferte Element liefert
   `document.querySelector(element.selector)` genau dieses Element — auch bei
   einem Element ohne `id`, `class` und `data-testid` (Beleg: Testfall im
   Seitenstub).
5. Weder die Logzeile noch der Debug-Block enthalten Elementtexte — nur
   Trefferzahl und `<n chars>`. Beleg: `test/hub.test.js`.
6. **Die Handgriffe des Betreibers**: Extension in `about:debugging` neu laden,
   pi neu starten. Danach ruft der Orchestrator `browser_inspect` auf der
   **Douglas-Warenkorb-Seite** auf und wählt einen Link, dessen `id` im Ergebnis
   **nicht `null`** ist (im Fixture ist das `a#cart-link`; ohne `id` liefert
   `describeElement` `tag.class`, und der Präfix-Vergleich wäre nicht anwendbar).
   Ihren `selector` klickt er mit `browser_click`. Beleg: `inspect` liefert das Element,
   `click` antwortet `ok:true`, und `clicked` **beginnt mit** `<tag>#<id>` des
   inspizierten Elements — `click` gibt `describeElement` zurück, nicht den
   Selektor, deshalb der Präfix-Vergleich.

   **Die Gegenprobe zu Kriterium 4 ist Kriterium 6**, nicht der Stub: der Stub
   kennt nur die Grammatik, die der Selektor-Bauer erzeugt. Dass der Selektor im
   **echten** Browser wieder trifft, zeigt erst dieser Lauf.

   **Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 6
   ist erst nach den Handgriffen messbar, und der Betreiber lädt die Erweiterung
   aus seinem eigenen Klon — also nach dem `git pull`. Kriterien 1–5 laufen vor
   dem Commit, Kriterium 6 danach; fällt es rot aus, wird vorwärts korrigiert und
   die rote Zeile steht mit Datum unter `## Bekannte Lücken`. Ist die
   **Kernannahme** widerlegt (der gelieferte Selektor trifft im echten Browser
   nicht wieder), geht das Inkrement zurück in diese Spec.

## Dev plan

**Die sechs Entscheidungen, vorab:**

1. **Selektor-Bauer:** `selectorForElement(element)` ist eine Modul-Funktion in
   `extension/background.js` (wie `describeElement`/`isVisible`), wird aber
   **nicht** in `PAGE_HELPERS_CODE` gelegt — sonst trüge jeder Klick/jede
   Tipp-Injektion 40 tote Zeilen. `pageSnippetCode(source, args, extraHelpers =
   "")` bekommt einen dritten Parameter; mit dem Default ist die Ausgabe für
   `click`/`type` **byte-identisch**. Eindeutig heißt: `querySelectorAll(candidate)`
   liefert **genau ein** Element **und** das ist das Ziel (`list[0] === element`).
   Nur `length === 1` zu prüfen wäre laut Spec zulässig, würde aber den Rundlauf
   (Kriterium 4) nicht garantieren. Jeder Kandidat steht in einem eigenen `try`;
   ein werfender Kandidat (z. B. `#1abc`) zählt als „nicht eindeutig".
2. **Kandidaten und Deckel:** `selector` ⇒ `document.querySelectorAll(selector)`;
   nur `text` ⇒ `document.body.querySelectorAll("*")` (`body === null` ⇒
   `count: 0`). **Deckel: 5 000 geprüfte Kandidaten**, danach Abbruch. Vorfilter
   ist nur „`textContent` ist leer ⇒ überspringen" (beweisbar eine Obermenge von
   `innerText`); **kein** Teilstring-Vorfilter auf `textContent`, weil `innerText`
   Leerraum faltet und Unsichtbares überspringt — ein solcher Filter würde Treffer
   still verlieren. `innerText` läuft nur für Kandidaten mit Text und wird
   **autoritativ** verglichen (`toLowerCase()`, nicht `toLocaleLowerCase`). Der
   teure Selektor-Bauer läuft nur für die **gelieferten** Elemente (≤ `limit`).
3. **`index`** ist ausschließlich die Position im gelieferten Array (0…n−1, nach
   dem `limit`-Schnitt). Es gibt **keinen** zweiten Nachschlageweg: `click`/`type`
   nehmen Selektoren. Der wiederverwendbare Griff ist `element.selector`; das
   steht als Kommentar am Feld und in der Werkzeugbeschreibung.
4. **Bestandsfälle:** Kriterium 1 stimmt. Am Code geprüft: nur
   `mcp_toolsList_shouldOfferExactlyTheSixToolsOfTheContract` zählt Werkzeuge;
   kein Fall prüft `Object.keys(PROTOCOL.METHODS)` oder `tools.length`.
   `test/protocol.test.js` bekommt einen **neuen** Fall (Addition, keine
   Änderung). Alle anderen Neufälle sind additiv.
5. **`no_agent_tab`/`not_readable`:** `readAgentTabId()` +
   `findDefaultContainerTab()` + `injectPageCode()` **unverändert**
   wiederverwendet. `not_readable` = `executeScript` hat abgelehnt ⇒ nichts lief;
   leeres Ergebnis = Injektion lief, nichts passte ⇒ `ok:true`, `count: 0`.
   Dazu ein eigener Code für ein **unbrauchbares** Injektionsergebnis:
   `inspect_failed`.
6. **Fixture:** ein `INSPECT_RESULT` mit **einem** Element, dessen `text` die
   erste Zeile von `READ_RESULT.text` ist („Zeile eins") — ein erfundenes
   Seitenstück, nicht zwei; `selector: "a#cart-link"`, `href:
   "https://example.org/"` (dieselbe erfundene Adresse wie `READ_RESULT`). Dazu
   `BC_TEST_INSPECT_ANSWER`, `inspectResponse(id)`, `case "inspect"` in
   `responseFor`, Doku-Kopf.

**Stufen:**

1. **Wire-Konstante `inspect` in beiden Kopien.** `bridge/protocol.mjs` und
   `extension/protocol.js`: `METHODS.INSPECT: "inspect"`, beide im selben
   Schnitt. Neuer Fall in `test/protocol.test.js` nach dem Muster des
   `FOCUS`-Falls — der Ganzvergleich der Kopien ist blind gegen einen Schlüssel,
   der in beiden fehlt.
   Proof: `node --test --test-reporter=tap test/protocol.test.js | grep -E '^# (pass|fail)'`
   → `# pass 8`, `# fail 0` (heute 7). **Completed 2026-10-23** — 244 Tests grün,
   `# fail 0`, `# cancelled 0`.
2a. **Testharness für DOM und Selektoren — zuerst, damit der Rest prüfbar ist.**
   `test/extension.test.js` bekommt `sendInspect`, `createInspectPage`/
   `createInspectElement` (mit `html`/`body`-Wurzel, `parentElement`,
   `innerText`, `textContent`, `disabled`, `rect`, `display`/`visibility`),
   `createInspectBody(page)` und `matchesSelector(page, element, selector)`.
   Der Matcher wird **aus der CSS-Grammatik** geschrieben, nicht aus der Ausgabe
   des Selektor-Bauers: `*`, `tag`, `#id`, `.c1.c2`, `[attr="v"]`,
   `:nth-of-type(n)`, `>`-Kette — alles andere wirft `SyntaxError`. `runPageCode`
   routet **sowohl** `document.querySelector` **als auch**
   `document.querySelectorAll` durch ihn, sobald `page.dom` gesetzt ist; der
   bestehende werfende `body.querySelectorAll` der Read-Fixture bleibt.
   **Die Gegenprobe gehört hierher:** ein syntaktisch gültiger, falscher
   Kandidat muss im Matcher **nichts** treffen, und zwei gleiche Geschwister
   (`div.knopf` ×2) müssen mehrdeutig sein — sonst benotet der Matcher sich
   selbst.
   Mit gesetztem `page.dom` nimmt `runPageCode` **`createInspectBody(page)`** als
   `document.body` — sonst stößt der bestehende Read-Body an seinen werfenden
   `querySelectorAll`.
   Proof: `node --test --test-reporter=tap --test-name-pattern='matchesSelector|createInspect' test/extension.test.js`
   → `# pass <n>` mit `n` = Zahl der neuen Matcher-Fälle (im Test festgeschrieben,
   nicht geschätzt) und `# skipped 0`. Ein `--test-name-pattern`, das auf nichts
   passt, meldet `# pass 1` und beweist deshalb nichts — die Zahl ist der Beweis. **Completed 2026-10-23** — `# pass 12`,
   `# skipped 0`; Gesamt 256 Tests grün.
2b. **`inspect` in der Extension samt Selektor-Bauer.** `extension/background.js`:
   `INSPECT_FAILED_CODE`, `INSPECT_LIMIT_{MIN,MAX,DEFAULT}` (1/200/50),
   `INSPECT_CANDIDATE_LIMIT = 5000`, `INSPECT_TEXT_LIMIT = 200`,
   `INSPECT_CLASS_LIMIT = 10`, Meldungen, `class InspectError`, Zweig in
   `answerRequest` **mit `return`** (Lehre aus Spec 08), `answerInspect`/
   `inspectErrorFor`, `inspectRequestParams(params)` (beide Filter, `limit`
   ganzzahlig 1–200, `includeHidden` Boolean; fehlt beides ⇒ `invalid_params` —
   **vor** der Tab-Auflösung), `inspectAgentTab(params)`,
   `inspectPageSource(request)` (synchron; `try` um `querySelectorAll` ⇒
   `{outcome:"invalid_selector"}`; sonst `{outcome:"ok", url, title, count,
   truncated, elements}`), `selectorForElement(element)` (Stufen `tag#id` →
   `[data-testid="…"]` → `tag[aria-label="…"]` → `tag[name="…"]` →
   `tag.c1.c2` → `html > body > … > tag:nth-of-type(n)`; Attributwerte für den
   String gequotet, `\n` zu Leerzeichen; die Pfadkette ist als letzte Stufe per
   Konstruktion eindeutig), `inspectPageCode(request)`,
   `inspectResultOf(tabId, results)` (Form wie `pageResultOf`; `invalid_selector`
   ⇒ `InspectError`, unbekannte Form ⇒ `inspect_failed` +
   `UNUSABLE_INSPECT_RESULT_LOG_LINE`, ohne Inhalt). **Genau eine** Injektion,
   kein `supersedeActiveNavigation`, kein Slot, kein Timer. `classes` über
   `getAttribute("class")` (nicht `className`: SVG liefert dort ein Objekt),
   `rect` gerundet aus `getBoundingClientRect()`, `visible` über `isVisible`,
   `disabled === true`; `text`/`id`/`href`/`ariaLabel` auf 200 Zeichen, `text`
   mit Zeilenumbrüchen als Leerzeichen. `count` = Treffer **vor** dem Schnitt,
   `truncated` = `count > elements.length` **oder** Deckel erreicht.
   Proof: `node --test --test-reporter=tap test/extension.test.js | grep -E '^# (pass|fail|cancelled)'`
   → `# fail 0`, `# cancelled 0`; die Neufälle der `## Testing`-Tabelle, u. a.
   `inspect_withoutSelectorAndText_shouldAnswerInvalidParamsAndInjectNothing`,
   `inspect_deliveredSelectors_shouldEachRoundTripToTheirOwnElement` (auch für
   das Element ohne `id`/`class`/`data-testid`),
   `inspect_withTextSearch_shouldFindTheSameElementCaseInsensitively`,
   `inspect_withALimit_shouldCutCountAndSetTruncated`,
   `inspect_withMoreCandidatesThanTheCap_shouldStopAtTheCapAndSetTruncated`,
   `inspect_withTextOver200Chars_shouldCutAndFlattenNewlines`; dazu je ein Fall
   für `scriptCalls.length === 1` und `clock.pendingDelays() === []`.
   **Completed 2026-10-23** — 17 Neufälle, `# pass 154` in der Extension, Gesamt
   273 Tests grün, `# fail 0`, `# cancelled 0`.

3. **Hub-Logzeile und redigierter Debug-Block.** `bridge/hub.mjs`:
   `formatInspectLine(params, result)` (genau `inspect selector=<…|-> text=<…|-> found=<n>`;
   Filter aus **params**, mehrzeilig → Leerzeichen wie `singleLineSelector`,
   `found` aus `result.count`, sonst `NO_FIELD`), `inspectDebugResult(result)`
   (Kopie mit `text`, `href`, `id`, `ariaLabel`, `selector` als `<n chars>`;
   `index`, `tag`, `visible`, `disabled`, `rect`, `url` bleiben),
   `#reportInspect(params, result)` = Logzeile + Debug-Block, **kein**
   `#logDebugResult`, Zweig mit `return` in `#reportResult`.
   *(Nachgezogen 2026-11-18 mit Spec 28: die Redaktion ist `DEBUG_WHITELIST` in
   `bridge-rs/src/hub.rs`, `inspectDebugResult` gibt es nicht mehr — und `title`
   ist dort eine Länge, nicht mehr voll.)*
   Proof: `node --test --test-reporter=tap test/hub.test.js | grep -E '^# (pass|fail)'`
   → `# fail 0` (heute 33); Neufälle
   `hub_requestWithInspectMethod_shouldLogOneLineWithoutElementText` (Zeile exakt
   `inspect selector=a#cart-link text=- found=1`, Elementtext in **keiner** Zeile)
   und `hub_requestWithInspectMethodWithDebugLog_shouldRedactEveryPageString`.
   **Completed 2026-10-23** — 35 Fälle im Hub, Gesamt 275 grün.

4. **MCP-Werkzeug und Fixture.** `test/fixtures/fake-extension.mjs`:
   `INSPECT_RESULT`, `inspectResponse`, `case "inspect"`, `answers.inspect`,
   Doku-Kopf. `bridge/mcp.mjs`: `BROWSER_INSPECT`, siebter `TOOLS`-Eintrag **ans
   Ende angehängt** (Beschreibung wörtlich, vier Properties,
   `additionalProperties: false`), `INSPECT_ARGUMENTS`,
   `UNEXPECTED_ARGUMENTS[BROWSER_INSPECT]`, `TOOL_TEXTS.INSPECT_NEEDS_FILTER`,
   `case BROWSER_INSPECT`, `inspectTool(…)` (Typen ⇒ `-32602`; fremder Schlüssel
   ⇒ Tabellensatz; weder `selector` noch `text` ⇒ `isError`; sonst
   `hub.request(PROTOCOL.METHODS.INSPECT, nur die gesetzten Schlüssel)`) und
   `inspectFailureTextFor` (`invalid_params` mit eigenem Satz, `invalid_selector`
   mit dem Selektor, `no_agent_tab`, `not_readable`, `inspect_failed`, sonst
   `CALL_EXTENSION_FAILED`). **Die `limit`-Spanne prüft die
   Bridge nicht** — sie ist die Regel der Extension (wie `TEXT_LIMIT`); die
   Schema-Grenze bleibt die Deklaration. `test/mcp.test.js`: `…SixTools…` →
   `…SevenTools…` und `tools[6]` prüfen (der eine geänderte Bestandsfall),
   `INSPECT_TOOL_DESCRIPTION`, `INSPECT_REQUEST_LINE`, `inspectRequestCount(…)`,
   vier Neufälle: Erfolg mit allen sechs Ergebnisfeldern und allen elf
   Elementfeldern, weder Filter (Satz, Zähler 0), `invalid_selector`,
   `no_agent_tab`.
   Proof: `node --test --test-reporter=tap test/mcp.test.js | grep -E '^# (pass|fail|cancelled)'`
   → `# fail 0`, `# cancelled 0`; `npm test; echo $?` → `0` mit `# fail 0` und
   `# cancelled 0`. **Completed 2026-10-23** — sechs Fälle (fünf neu, einer
   umbenannt), `# pass 59` im MCP-Test, Gesamt 280 Tests grün.

**Hand-over, kein Schritt:** Kriterium 6 sind die Handgriffe des Betreibers
(Extension neu laden, pi neu starten) und der Aufruf auf der
Douglas-Warenkorb-Seite; der Umsetzer kann das nicht fahren.
`extension/manifest.json` und `extension/options.*` bleiben unberührt, ebenso
`~/.pi/agent/mcp.json`, `INSTALL.md` und `docs/*`.

### What could go wrong

- **Der Matcher im Harness ist der neue Einfallspunkt.** Er wird aus der
  CSS-Grammatik geschrieben, nicht aus der Ausgabe des Bauers, und braucht die
  Gegenprobe; matcht er zu viel, ist der Rundlauf grün ohne Beweis, matcht er zu
  wenig, wird ein *richtiger* Selektor rot. Beide, `document.querySelector` und `querySelectorAll`, müssen
  durch ihn laufen — Kriterium 4 sagt wörtlich `querySelector`.
- **Ein Wurf im Schnipsel wird `not_readable`.** `injectPageCode` bildet jede
  Ablehnung darauf ab; deshalb sind das `try` um `querySelectorAll` und die
  `try`s je Kandidat Vertrag, nicht Stil.
- **`truncated` bekommt eine zweite Bedeutung** (mehr Treffer als `limit` **oder**
  Deckel erreicht). Ein Fall pinnt jede der beiden; der Kommentar am Feld sagt
  beide.
- **Der dritte Parameter von `pageSnippetCode`** darf die Klick-/Tipp-Ausgabe
  nicht verändern; mit dem Default `""` sind die Bestandsfälle unverändert grün.
- **`describeElement` wird in `inspect` nicht aufgerufen** — der gelieferte
  `selector` ist die Beschreibung.
- **Zwei Stellen brauchen `return`** im `answerRequest`- und im
  `#reportResult`-Zweig; Spec 08 hat genau das einmal gekostet.

### Ordering and dependencies

1 → 2a → 2b → 3, 4 (die Methode muss in beiden Kopien stehen, bevor jemand sie
nutzt; 2a liefert den Harness, ohne den 2b nicht prüfbar ist).
3 ist von 2 unabhängig (der Hub-Test schickt eigene Antwortframes). 4 braucht 1
und die Fixture, **nicht** 3. Nach jeder Stufe `npm test` grün; nur Stufe 4
ändert einen Bestandsfall.

### What the next increment inherits

Unverändert offen: 08a (mehrere Agenten-Tabs — `inspect` liefert schon `tabId`,
bekommt dann `tab` als Parameter), 08c, 08e, 09/10 (Ruhe-Erkennung — `inspect`
wartet bewusst nicht), 11/12, 13, 14, 15, 16 (Shadow DOM: `querySelector` sieht
dort nichts, Deckel und Matcher ändern das nicht), 18 und 08f (`browser_eval`).
Aus diesem Inkrement erbt der Nächste: den Kandidaten-Deckel als Zahl mit einer
Bedeutung für `truncated`, `pageSnippetCode` mit dem dritten Parameter für
weitere Seiten-Schnipsel, den Selektor-Bauer als *einen* Ort (wer ihn ändert,
ändert das Versprechen „der Selektor trifft wieder"), den Matcher samt
Inspect-Fixture, und die Regel, dass `index` kein Griff ist. Nicht dabei: ein
Index-Parameter für `click`/`type`, Bilder, ein zweiter Tab, Container, Rechte.

## Risiken

- **Die Antwort ist groß.** 50 Elemente mit Text, Klassen, Pfad-Selektor: das
  sind schnell 10–20 kB. Deshalb `limit`, `count` und die Kürzung auf 200
  Zeichen. Wer mehr braucht, fragt zweimal mit engerem Filter.
- **Pfad-Selektoren sind fragil.** `div:nth-of-type(3) > p:nth-of-type(2)` trifft
  nach einem Rerender etwas anderes. Die Reihenfolge der Versuche ist so
  gewählt, dass stabile Merkmale (`id`, `data-testid`, `name`, `aria-label`)
  Vorrang haben — aber bei einem Element ohne alles bleibt nur der Pfad, und das
  ist eine Momentaufnahme.
- **`innerText` kostet Layout.** Bei 50 Elementen à `innerText` kann das auf
  einer großen Seite spürbar werden; `limit` begrenzt die Ausgabe, nicht die
  Arbeit. Ein Deckel auf die Kandidatenmenge (etwa 5 000) ist Teil der
  Umsetzung.
- **Klassen sind oft generiert** (`css-1x2y3z`) und ändern sich beim nächsten
  Deploy. Sie sind Information, kein Vertrag — der gelieferte `selector`
  bevorzugt sie nur, wenn er eindeutig ist.
- **Sichtbarkeit ist relativ**: ein Element in einem gescrollten Bereich hat eine
  Fläche und gilt als sichtbar, auch wenn es außerhalb des Viewports liegt.
  `rect` sagt, wo es ist — der Agent muss selbst schließen, ob es im Bild ist.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, kein Seitentext in Logs, Tests, Fixtures
  oder Doku (die Tests erfinden ihren HTML-Inhalt).
- `extension/manifest.json`, `extension/options.*`, `bridge/websocket.mjs`,
  `bridge/config.mjs` bleiben unverändert.
- `docs/PROJECT-STATE.md`, `docs/README.md`, `docs/ROADMAP.md` und `INSTALL.md`
  pflegt der Orchestrator.
- Kein Produktivcode für 08f (`browser_eval`), 09/10 (Ruhe), 16 (Shadow DOM).

## Messlauf (Kriterium 6, 2026-10-23)

Erfüllt, im echten Browser, mit der neu geladenen Extension und dem neu
gestarteten pi:

- **`browser_inspect` ist da** — der Neustart war nötig, weil die Bridge ein
  Kindprozess ist und die Werkzeugliste beim Sitzungsstart liest.
- **Douglas war eine Bot-Wand** („Powered and protected by", 0 Links). Deshalb
  lief der Messlauf auf einer anderen Seite: `https://de.wikipedia.org/wiki/Fahrrad`.
- **`a[id]` → 596 Treffer**, `count` exakt, kein Deckel. Geliefert unter anderem
  `a#mwBw` mit `id: "mwBw"`, `href: …/Diamantrahmen`, `visible: true`.
- **Klick mit dem gelieferten Selektor:** `browser_click({selector:"a#mwBw"})` →
  `ok: true`, `clicked: "a#mwBw"` — der Präfix-Vergleich aus Kriterium 6 stimmt.
  Der Klick hat wirklich navigiert: Tab 23 steht danach auf
  `…/wiki/Diamantrahmen`, Titel „Diamantrahmen – Wikipedia".
- **Der Review-Fix ist live belegt:** Links ohne `id`-Attribut liefern
  `id: null`, nicht `""` (`a[href*="probetraining"]` auf der clever-fit-Seite).
- **Ohne Merkmal kommt ein Pfad:** `html > body > div:nth-of-type(2) > … >
  a:nth-of-type(1)` — der Rundlauf funktioniert also auch dort, wo es keine `id`,
  keine Klasse und kein `data-testid` gibt.

**Neuer Befund, nicht Teil dieses Inkrements:** Der **erste** `click` direkt nach
einem `navigate` antwortete `not_readable` („Diese Seite kann die Extension nicht
lesen (interne Seite oder Sonderformat)"), obwohl die Seite gewöhnlich war und
`inspect` im selben Moment funktionierte; der zweite Versuch ging durch. Der Code
sagt also die Unwahrheit über die Ursache. Steht als Roadmap-Zeile 08g.

## Bekannte Lücken

Noch keine — der Messlauf zu Kriterium 6 steht aus. Fällt dort eine Zeile rot
aus, steht sie hier mit Datum. Ist dagegen die **Kernannahme** widerlegt (der
gelieferte Selektor trifft im echten Browser nicht wieder), geht das Inkrement
zurück in diese Spec — `## Bekannte Lücken` ist dafür kein Ersatz.

## Open questions

Keine. Entschieden mit dem Betreiber am 2026-10-23 (Roadmap-Auswahl): eine
DOM-Abfrage als eigenes Werkzeug, **read-only**, getrennt von `browser_eval`
(das eine eigene Spec mit eigener Entscheidung bekommt).

## Review

**Runde 1 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Elf Befunde, alle
übernommen:

1. **Rundlauf-Test benotete sich selbst** — Bauers Eindeutigkeitsprüfung und
   Rundlauf laufen durch denselben Stub. Jetzt: Gegenprobe (falscher Kandidat
   trifft nicht), mehrdeutige Geschwister (`div.knopf` ×2) in der Testing-Tabelle,
   und Kriterium 6 sagt ausdrücklich, dass der Stub die Grammatik kennt, nicht
   die Wahrheit.
2. **Die datierte Ausnahme fehlte** — Kriterium 6 wäre am `git pull` gescheitert.
   Wortlaut aus Spec 08 übernommen.
3. **„Antwort von `click` nennt dasselbe Element" war nicht entscheidbar** —
   `click` liefert `describeElement`, nie den Selektor. Jetzt Präfix-Vergleich
   `clicked.startsWith("<tag>#<id>")`.
4. **`count` als Untergrenze war für den Selektor-Pfad falsch** — jetzt je Pfad
   getrennt: mit Selektor exakt, mit Text Untergrenze.
5. **Drei Regelzeilen ohne Test** — `selector: ""`, `text: ""`, `count` nach
   Sichtbarkeitsfilter: ergänzt, samt Aussage, dass `count` **nach** dem
   Sichtbarkeitsfilter zählt.
6. **`inspect_failed` hatte keinen Produzenten** — jetzt ein äußeres `try` um
   `inspectPageSource`, damit ein Fehler **unseres** Schnipsels nicht als
   `not_readable` erscheint. Testfall ergänzt.
7. **Debug-Block redigierte weniger als Stufe 3** — jetzt auch `id`,
   `ariaLabel`, `selector`, `classes`; Begründung am Feld.
8. **„byte-identisch" war unbelegt** — Testfall pinnt den erzeugten Code für
   `click`/`type`.
9. **Echter Seitentext in der Doku** (`add-to-cart`, Knopftext, Vertragslink) —
   durch erfundene Beispiele ersetzt.
10. **Stufe 2 war drei Inkremente** — geteilt in 2a (Harness, Selektor-Pfad,
    Gegenprobe) und 2b (Textsuche, Deckel, Selektor-Bauer).
11. **`invalid_params` landete in `CALL_EXTENSION_FAILED`** — eigener Satz, damit
    ein Client-Fehler nicht als Extension-Fehler gelesen wird.

**Runde 2 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Acht Befunde, alle
übernommen:

1. **`inspect_failed` hatte einen Produzenten, den es nicht geben kann** — ein
   Wurf im Seitenschnipsel wird von `injectPageCode` immer zu `not_readable`;
   das äußere `try` hätte nie etwas anderes gesehen, und eine Umbenennung hätte
   jede unlesbare Seite zu `inspect_failed` gemacht. Jetzt entsteht der Code
   allein aus einer unbrauchbaren Ergebnisform in `inspectResultOf` (wie
   `read_failed`); das äußere `try` und sein Testfall sind entfallen.
2. **`count` „exakt" widersprach dem unbedingten Deckel** — jetzt: exakt **bis**
   5 000 im Selektor-Pfad, mit Text immer Untergrenze.
3. **`invalid_params` war in Stufe 4 wieder in `CALL_EXTENSION_FAILED`
   zurückgefallen** — eigener Satz in `inspectFailureTextFor`, plus Testzeile.
4. **Der Proof von Stufe 2a war mit null Fällen grün** (`--test-name-pattern`,
   das nicht passt, meldet `# pass 1`) — jetzt wird die Fallzahl gepinnt und
   `# skipped 0`; dazu `createInspectBody` als `document.body` bei gesetztem
   `page.dom`, sonst wirft der Read-Body.
5. **Kriterium 6 setzte eine `id` voraus** — `describeElement` liefert ohne `id`
   `tag.class`, der Präfix-Vergleich wäre nicht anwendbar. Jetzt ausdrücklich ein
   Element mit `id`.
6. **`## Bekannte Lücken` fehlte**, obwohl Kriterium 6 darauf verweist — ergänzt,
   samt dem Satz „ist dafür kein Ersatz".
7. **Die Logzeile widersprach der Redaktionsregel** — begründet: der Filter ist
   die Eingabe des Aufrufers, nicht gelesener Seiteninhalt, deshalb roh; die
   Grenze (übernommener Selektor kann Seitentext tragen) steht dabei.
8. **`rect` war ungenau, die Gegenprobe in nicht unterstützter Form** — jetzt
   `Math.round`, Pixel, Viewport-Ursprung; die Gegenprobe nutzt `a#andere-id` und
   `p:nth-of-type(1)` gegen das zweite Absatz-Element, also gültige Grammatik.

**Runde 3 (2026-10-23, `grizzled-senior-dev`): ✅ Ship it.** Mechanik geprüft
(`read_failed` entsteht wirklich aus `isUsablePageResult`, `injectPageCode`
wirklich aus jeder Ablehnung `not_readable`, `createBodyStub` wirklich werfend).
Drei Notizen, alle übernommen:

1. **`invalid_params` hatte keinen Feldnamen zur Verfügung** — der Hub reicht nur
   den Code weiter. Satz jetzt ohne Platzhalter.
2. **Deckel zählt geprüfte Kandidaten, in beiden Pfaden gleich** — damit ist
   `count` unterhalb exakt und am Deckel eine Untergrenze; das Feld sagt es.
3. **`selectorForElement` schließt über nichts** (Grenzen als Argumente, wie bei
   `describeElement`); die Hub-Testzeile pinnt `found=1` wörtlich.

## Log

Noch keine Befunde.

Befunde beim Schreiben des Dev-Plans (2026-10-23), vom Architekten:

- **`describeElement` gehörte nicht in die Extension-Beschreibung** — der
  gelieferte `selector` ist die Beschreibung, ein zweites Feld gibt es nicht.
  **Übernommen.**
- **Kandidaten-Deckel fehlte** (5 000), obwohl eine Textsuche sonst jedes Element
  mit `innerText` (Layout) prüft. **Übernommen**, samt zweiter Bedeutung von
  `truncated`.
- **Leere Filterstrings** waren nicht geregelt (`selector: ""` ⇒
  `invalid_selector`, `text: ""` ⇒ passt auf alles). **Übernommen.**
- **`inspect_failed`** war in der Code-Liste nicht genannt. **Übernommen.**

Abweichung vom Dev-Plan (2026-10-23, Stufe 2b): Der Vorfilter „`textContent` ist
leer ⇒ überspringen" ist **nicht** gebaut. Er hätte Kandidaten verworfen, die
`text: ""` treffen muss („passt auf alles"). Stattdessen begrenzt der
Kandidaten-Deckel die `innerText`-Kosten. Übernommen, weil die Spec-Zeile zu
`text: ""` sonst falsch wäre.

**Code-Review (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these → ✅ Ship it.** Ein
Blocker: `Element.id` ist **immer** ein String (`""`, nie `null`), der
Typcheck-Zweig war toter Code — damit hätte Kriterium 6 („ein Link, dessen `id`
nicht `null` ist") auf **jedes** Element gepasst. Behoben in `89bf1b1`:
`identityOf` liest leer als abwesend (wie `describeElement`), für `id` **und**
`href`; neuer Fall prüft `plainSpan.id === ""`, dann die Lieferung `id === null`
— auf dem alten Code rot, vom Umsetzer und vom Reviewer unabhängig belegt.

Nachgelagerte Befunde, **nicht** in diesem Inkrement behoben (dokumentiert, damit
sie nicht verloren gehen):

1. **`classes`-Grenze (10) ist unbelegt** — kein Testelement mit elf Klassen.
2. **`limit`-Default 50 ist unbelegt** — kein Fall mit mehr als 50 Treffern.
3. **`body === null ⇒ count: 0`** ist im Harness nicht erreichbar (der
   Inspect-Body existiert immer).
4. **„Parameter vor Tab-Auflösung"** ist nicht gepinnt: der Fall hat einen
   gespeicherten Tab, er zeigt „keine Injektion", nicht die Reihenfolge.
5. **`selector` und `text` gemeinsam** (Spec: „beide Bedingungen") wird nie
   ausgeführt.
6. **`createInspectElement` defaultet `href = null`**, was ein `<a>` ohne `href`
   im DOM nie liefert (`""`) — eine Falle für den nächsten Test.
