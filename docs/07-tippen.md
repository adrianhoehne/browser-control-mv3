---
description: Der Agent tippt — browser_type schreibt Text in ein Feld des Agenten-Tabs, kann mit Enter absenden und liefert den Seitenzustand danach; Passwortfelder sind standardmäßig gesperrt und nur über eine Option der Erweiterung freizugeben.
status: active
---

# Tippen und absenden: `browser_type`

Mit `browser_click` kann der Agent einen Schritt tun; mit `browser_type` kann er
ein Formular füllen. Das ist der Unterschied zwischen „ich finde den Suchknopf"
und „ich suche etwas".

**Passwortfelder sind standardmäßig gesperrt.** Der Betreiber hat am 2026-10-23
entschieden, dass es dafür einen Schalter gibt statt einer festen Regel: die
Extension bekommt eine Option „Passwortfelder erlauben" (Default: aus). Anmelden
in seinem Namen bleibt damit seine Entscheidung, nicht die Voreinstellung.

**Das ändert eine geschriebene Projektregel, und zwar bewusst:** `CONTRIBUTING.md`,
`## Rules` sagt „Anmeldung, Zwei-Faktor und Passkeys macht der Betreiber selbst,
der Agent wartet darauf", und `docs/PROJECT-STATE.md` führt das als Entscheidung
der Anlage. Mit dieser Option kann der Agent — wenn der Betreiber sie einschaltet
— ein Passwortfeld füllen. Die Regel gilt damit nur noch, solange die Option aus
ist. Der Nachtrag in `CONTRIBUTING.md`, `## Rules` und in `docs/PROJECT-STATE.md`
(Datum, Grund, Betreiberentscheidung) ist Orchestrator-Arbeit und gehört zum
Commit dieses Inkrements.

## Ziel

`browser_type({selector, typed_text, submit})` schreibt `typed_text` in das Feld, das dem
CSS-Selektor entspricht, und antwortet mit dem Zustand der Seite danach
(`tabId`, `url`, `title`, `typed`, `submitted`, `text`, `truncated`, `via`).

Mit `submit: true` wird danach Enter ausgelöst — das ist der **einzige**
Tastendruck, den dieses Inkrement kennt; ein allgemeines Tastatur-Werkzeug gibt
es nicht.

## Non-goals

- **Keine freie Tastatur:** kein einzelnes `keydown`, keine Shortcuts, keine
  Tastenkombinationen, kein Tab-Navigation. `submit` ist die einzige Ausnahme und
  besteht aus genau einem Enter.
- Kein Tippen in einen fremden Tab, keine Koordinaten, kein Scrollen, kein
  Datei-Upload (`input[type=file]`), keine Auswahl in `select`-Elementen und
  keine Checkboxen — das sind eigene Zuschnitte.
- Kein Shadow DOM im Sinne von gekapselten Komponenten; Frames seit Spec 26 über `frame` (URL-Teilstring)
  (Inkremente 15/16), kein Screenshot, kein `focus`.
- Keine Änderung an `read`/`click`/`navigate` außer der gemeinsamen Slot-Regel,
  die schon gilt.
- **Keine neuen Berechtigungen:** `<all_urls>` und `storage` reichen.

## Konfiguration (neu): Passwortfelder

Die Optionsseite der Erweiterung (`extension/options.html`) bekommt eine
Checkbox **„Passwortfelder erlauben"**, gespeichert als
`browser.storage.local.allowPasswordFields: boolean`, **Default `false`**.

- `false`: ein Feld mit `type="password"` wird abgelehnt — `password_not_allowed`,
  **kein** Tippen, kein Fokus, keine Tastenereignisse.
- `true`: Passwortfelder werden wie jedes andere Feld behandelt.
- Der Wert wird **bei jedem Aufruf** aus `storage.local` gelesen (nicht beim
  Start zwischengespeichert), damit ein Umstellen ohne Reload der Extension
  wirkt — anders als `endpoint`/`token`, die erst beim nächsten Verbindungsaufbau
  greifen.
- Die Bridge kennt die Option nicht: sie entscheidet die Extension, weil dort
  der Code läuft, der in die Seite schreibt.

## Wire-Protokoll (neu: `type`)

`PROTOCOL.METHODS` bekommt `TYPE: "type"`. Anfrage:

```json
{"type":"request","id":5,"method":"type",
 "params":{"selector":"input[name=\"q\"]","typed_text":"example","submit":true}}
```

Antwort:

```json
{"type":"response","id":5,"ok":true,
 "result":{"tabId":7,"url":"https://www.qwant.com/?q=example&t=web","title":"example – Qwant Search",
           "typed":"input#q","submitted":true,
           "text":"…","truncated":false,"via":"innerText"}}
```

- **`selector`**: jeder String; fehlend oder kein String ⇒ `invalid_params`.
- **`typed_text`**: muss ein String sein (`""` ist erlaubt und leert das Feld);
  fehlend oder kein String ⇒ `invalid_params`.
- **`submit`**: `true` oder `false`; fehlt es, gilt `false`. Kein anderer Typ.
- **Ziel-Element**: `input` **mit einem typbaren `type`** (`text`, `search`,
  `email`, `url`, `tel`, `password`, `number` oder ganz ohne `type`),
  `textarea` oder ein Element mit `isContentEditable`. Alles andere ⇒
  `not_typeable` — insbesondere `checkbox`, `radio`, `submit`, `button`,
  `range`, `color`, `date`, `file`. Ohne diese Positivliste tippte der Setter in
  eine Checkbox und meldete Erfolg, obwohl die Non-goals das ausschließen.
  Ebenso `disabled`, `readOnly` oder `type="hidden"` ⇒ `not_typeable`.
- **Sichtbarkeit**: dieselbe Prüfung wie bei `click` (`isVisible`: Fläche,
  `visibility`, `display`) und **in derselben Reihenfolge geprüft**; das
  Ergebnis ist `not_typeable`, ein separates „unsichtbar" gibt es nicht — der
  deutsche Satz nennt beides.
- **Schreiben**, in dieser Reihenfolge:
  1. `element.focus()` — ein Feld ohne Fokus verhält sich anders, und manche
     Seiten rendern ihren Wert nur im fokussierten Zustand.
  2. `beforeinput` (cancelable, `inputType: "insertText"`, `data: text`) —
     manche Seiten hören darauf statt auf `input`.
  3. Wert über den **nativen Setter** des Prototyps setzen (ein direktes
     `element.value = …` bemerken React/Vue/Angular nicht).
  4. `input` (`bubbles`, `inputType: "insertText"`, `data: text`) und `change`.
  5. **Erneut prüfen und nachsetzen:** im nächsten Task (`setTimeout(0)`) wird
     `element.value` gelesen; ist er nicht mehr `text` (weil die Seite ihren
     kontrollierten Wert aus eigenem Zustand zurückgeschrieben hat), wird der
     Wert noch einmal gesetzt und `input` erneut ausgelöst. Das ist die
     bekannte Gegenmaßnahme für kontrollierte Eingabefelder — ohne sie steht
     der Text funktional in der Übermittlung, aber das Feld zeigt ihn nicht.
  Bei `contenteditable` gilt dasselbe mit `textContent` und `input`.
- **Absenden** (`submit: true`): `keydown`, `keypress`, `keyup` mit
  `key: "Enter"` auf dem Element. Ist das Element in einem `<form>` und wurde
  das `keydown` **nicht** abgebrochen, ruft die Extension zusätzlich
  `form.requestSubmit()` — ein synthetisches Enter löst die implizite
  Formularübermittlung nicht selbst aus, und wenn die Seite das Enter nicht
  behandelt hat, ist `requestSubmit` genau das, was der Mensch ausgelöst hätte.
  Die Antwort meldet `submitted: true`, sobald Enter ausgelöst wurde — **nicht**,
  ob die Seite darauf reagiert hat. Ohne Formular (der Normalfall beim Suchfeld)
  bleibt es bei den Enter-Ereignissen; `requestSubmit` gibt es dort nicht.
- **`typed` ist die Elementbeschreibung**, genau wie `clicked` bei `click`
  (`tag#id`, sonst `tag.klasse`, sonst `tag[href="…"]`/`tag[aria-label="…"]`,
  sonst nur der Tag, ≤ 120 Zeichen) — **nie der getippte Text**. Wer es anders
  läse, schöbe den Text in die Antwort und damit in den Debug-Block.
- **`about:`** nach dem Tippen: dieselbe Regel wie bei `click` (Vorher-Stand,
  leerer Text, `via: "innerText"`).
- **Codes**: `invalid_params`, `invalid_selector` (der Selektor ist kein
  gültiger CSS-Selektor), `no_match`, `not_typeable`, `password_not_allowed`,
  `no_agent_tab`, `superseded`, `not_readable`/`read_failed` (aus dem Lesen nach
  dem Tippen, unverändert durchgereicht), `type_failed` (eigener Fehler).
- **`input[type=file]`** ist kein beschreibbares Feld in diesem Sinn: es wird
  wie ein unbeschreibbares behandelt (`not_typeable`), nicht über den Setter
  beschrieben.

## MCP-Werkzeug

| Feld | Wert |
|---|---|
| `name` | `browser_type` |
| `description` | Works on the **current** agent tab and takes **no** URL — call `browser_navigate` first. Writes text into the field that matches the CSS selector, optionally sends Enter and returns the page text afterwards (cut to 20 000 characters). With `tab` exactly that tab, without `tab` the one used last. |
| `inputSchema` | `{"type":"object","properties":{"selector":{"type":"string"},"text":{"type":"string"},"submit":{"type":"boolean"},"frame":{"type":"string","minLength":1}},"required":["selector","text"],"additionalProperties":false}` |

`tools/call`:

- **Erfolg**: `{"content":[{"type":"text","text":"<JSON, 2 Leerzeichen eingerückt>"}]}`.
- **`selector` oder `text` fehlt / falscher Typ**: `{code:-32602, message:"invalid params"}`.
- **`submit` ist kein Boolean** (etwa `"true"`): ebenfalls `-32602` — sonst
  käme der Modellfehler als „die Extension konnte die Anfrage nicht ausführen"
  zurück, was die falsche Erklärung ist.
- **unbekanntes Argument**: `isError`, „browser_type takes only `selector`,
  `text`, `submit`, `frame` and `tab`." (englisch seit `docs/54`)
- **`invalid_selector`**: `isError`, „The selector is invalid: <selektor>."
- **`no_match`**: `isError`, „No element matches: <selektor>."
- **`not_typeable`**: `isError`, „The element is not a writable field or is
  disabled: <selektor>."
- **`password_not_allowed`**: `isError`, „Password fields are locked. Unlock
  them in the extension options."
- **`no_agent_tab`**: `TOOL_TEXTS.NO_AGENT_TAB` (wörtlich wie bei `read`).
- **`not_readable`/`read_failed`**: unverändert durchgereicht (wie bei `click`).
- **`superseded`/`type_failed`/Zeitüberschreitung**: `CALL_EXTENSION_FAILED(code)`.

## Hub

Keine strukturelle Änderung. Logzeile:
`type selector=… chars=<n> submit=<true|false> tab=… url=…` — **der Text selbst
steht nie in einer Logzeile** (er kann ein Passwort sein), nur seine Länge; bei
`BC_LOG=debug` der Ergebnisblock mit **zwei** Redaktionen: `text: "<n chars>"`
**und** `typed: "<n chars>"` (die Elementbeschreibung kann ein `href` oder
`aria-label` tragen, wie bei `click`). Der Selektor wird wie bei `click` von Zeilenumbrüchen befreit.

## Extension

- `answerType`/`typeErrorFor` (Muster: `answerClick`/`clickErrorFor`),
  `typeRequestParams(params)`, `typeAgentTab`.
- Injektion 1 `typePageSource(params)` per `toString()`, Argumente als
  JSON-quotiertes Objekt: Selektor, Text, `submit`, `allowPasswordFields`.
  Reihenfolge: `querySelector` (try/catch ⇒ `invalid_selector`), `null` ⇒
  `no_match`, Typ/Sichtbarkeit/`disabled`/`readOnly`/`hidden` ⇒ `not_typeable`,
  Passwort und gesperrt ⇒ `password_not_allowed`, **dann** Wert setzen und
  Ereignisse auslösen, dann ggf. Enter/`requestSubmit`, Ergebnis
  `{outcome:"typed", typed, submitted}` — `typed` wird **vor** dem Schreiben aus
  `describeElement(element)` gebaut (ein `input`-Handler darf `id`/`class`
  wegrerendern), `submitted` ist immer ein Boolean.
- Danach dasselbe 300-ms-Fenster und dieselbe zweite Injektion wie bei `click`
  (`READ_PAGE_CODE`), dieselbe Slot-Regel (`navigate`, `click`, `type` lösen
  sich gegenseitig ab), dieselbe Eigentümerschaftsprüfung nach dem Warten und
  vor der zweiten Injektion.
- `describeElement` und der Sichtbarkeitscheck werden aus `clickPageSource`
  **herausgezogen** und von beiden Snippets geteilt (je eine Funktion, die per
  `toString()` mitgeschickt wird) — sonst stünde dieselbe Regel zweimal in der
  Seite.

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `test/protocol.test.js` — `METHODS.TYPE` | Steht wörtlich in beiden Kopien |
| `test/extension.test.js` — kein Agenten-Tab | `no_agent_tab`, keine Injektion |
| dito — fehlender Selektor / fehlender Text / `submit` als String | `invalid_params`, keine Injektion |
| dito — Selektor ohne Treffer | `no_match` |
| dito — unparsbarer Selektor | `invalid_selector`, keine Injektion |
| dito — der eingespritzte Code liefert kein brauchbares Objekt | `type_failed` |
| dito — Seite nach dem Tippen nicht lesbar | `not_readable` unverändert durchgereicht |
| dito — `div`, `disabled`, `readOnly`, `type="hidden"`, `type="file"`, `type="checkbox"`, `type="radio"`, `type="range"` | `not_typeable`, **kein** Wert gesetzt |
| dito — unsichtbares Feld (`display:none`) | `not_typeable` |
| dito — `type="password"` bei `allowPasswordFields: false` | `password_not_allowed`, **kein** `input`-Ereignis, kein Wert |
| dito — `type="password"` bei `allowPasswordFields: true` | Wert gesetzt, `typed` beschreibt das Feld |
| dito — `input`-Feld | Wert über den nativen Setter gesetzt, `input` **und** `change` ausgelöst (der Stub zählt die Ereignisse) |
| dito — `textarea` und `contenteditable` | beide Wege setzen den Wert und lösen `input` aus |
| dito — Feld wird vor dem Schreiben fokussiert | `focus()` ist vor dem ersten `beforeinput` aufgerufen |
| dito — Seite ist ein kontrolliertes Feld und schreibt den Wert im `input`-Handler zurück (`""`) | Nach dem Aufruf steht `text` im Feld (nachgesetzt im nächsten Task), `input` wurde **zweimal** ausgelöst |
| dito — Seite akzeptiert den Wert | nur **ein** `input`, kein unnötiges Nachsetzen |
| dito — `submit: false` | kein Tastenereignis, `submitted: false` |
| dito — `submit: true` im Formular | Enter-Ereignisse ausgelöst, `form.requestSubmit()` genau einmal, `submitted: true` |
| dito — `submit: true` **ohne** Formular (Suchfeld) | Enter-Ereignisse ausgelöst, **kein** `requestSubmit`, `submitted: true` |
| dito — Lesen von `storage.local` wirft | Feld gilt als gesperrt (`password_not_allowed`), `console.warn` |
| dito — der Prototyp hat keinen `value`-Accessor | `type_failed`, **kein** stiller Fallback auf `element.value = …`, keine Ereignisse |
| dito — `text` mit `"` und Zeilenumbruch | Wert kommt unverändert an (JSON-quotierte Injektion) |
| dito — `submit: true`, Seite bricht das `keydown` ab | **kein** `requestSubmit()` (sonst doppeltes Absenden) |
| dito — zwei `type` überlappen, und `click` während `type` | der Ältere antwortet `superseded`, keine zweite Injektion, kein Timer |
| `test/extension.test.js` — `onMessage_withUnknownMethod_…` | Nutzt `no_such_method` als Beispiel, nicht `focus` (das kommt in Inkrement 08 und würde den Fall erneut brechen) |
| dito — Feld leeren mit `text: ""` | Wert ist leer, `typed` gesetzt |
| `test/hub.test.js` — `request("type", …)` | Logzeile `type selector=… chars=<n> submit=…` **ohne** Text; Debug-Block mit `text: "<n chars>"` |
| `test/manifest.test.js` — `options.html` und `options.js` | Die Checkbox `id="allowPasswordFields"` existiert, ist `type="checkbox"`, und `options.js` benutzt dasselbe Schlüssel-Literal (Verdrahtungsprüfung gegen den Tippfehler) |
| `test/mcp.test.js` — `tools/list` | Fünf Werkzeuge, `browser_type` mit `required:["selector","text"]` |
| dito — `submit` als String (`"true"`) | `-32602`, keine Anfrage an die Extension |
| dito — Erfolg, fehlender Text, unbekanntes Argument, `no_match`, `not_typeable`, `password_not_allowed`, `superseded` | je der Satz aus `## MCP-Werkzeug`; abgelehnte Aufrufe erreichen die Extension **nicht** (Fixture-Zähler) |

## Acceptance criteria

1. `npm test; echo $?` → `0`, Ausgabe enthält `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. Von den 171 bisherigen Fällen laufen **169
   unverändert**; **zwei müssen sich ändern**, weil das Inkrement ihre
   Voraussetzung aufhebt: der Werkzeugzahl-Fall in `test/mcp.test.js`
   (`…ExactlyTheFourTools…`) und
   `onMessage_withUnknownMethod_shouldReplyUnsupportedMethod` in
   `test/extension.test.js`, das seit Inkrement 06 `type` als Beispiel für
   „nicht implementiert" benutzt — es wandert auf `no_such_method` (nicht auf
   `focus`: der kommt in Inkrement 08 und würde den Fall erneut brechen). Beide
   stehen mit Begründung im Bericht.
2. `tools/list` liefert fünf Werkzeuge; `browser_type` hat
   `required: ["selector","text"]` und `additionalProperties: false`.
3. Mit Fake-Extension liefert `browser_type` Text, der sich als JSON parsen lässt
   und `tabId`, `url`, `title`, `typed`, `submitted`, `text`, `truncated`, `via`
   enthält.
4. `not_typeable` und `password_not_allowed` kommen als `isError` mit den
   englischen Sätzen an (seit `docs/54`); in beiden Fällen wurde **kein** Wert gesetzt und kein
   Ereignis ausgelöst. Beim erfolgreichen Tippen in ein Feld mit eigenem
   `value` (React-Schatten) gilt: `nativeSets === 1` **und** der Schatten steht
   danach unverändert (Beleg: die Seiten-Attrappe zählt Werte und Ereignisse).
5. Weder die Logzeile noch der Debug-Block enthalten den getippten Text;
   `chars` in der Logzeile ist die **Länge des getippten Textes**, nicht die des
   Seitentextes. Beleg: `test/hub.test.js` mit `text: "geheim-testwert"` erwartet
   `chars=15`, und `logLines.join("\n")` enthält den Wert nicht.
6. **Die Handgriffe des Betreibers**: Extension in `about:debugging` neu laden,
   pi neu starten (die Optionsseite zeigt die neue Checkbox
   „Passwortfelder erlauben", Default aus). Danach tippt der Orchestrator auf der
   Qwant-Seite `example` in das Suchfeld und sendet ab; Beleg ist die Antwort mit
   einer `url` auf `?q=example` und Text > 0 mit Treffern.

   **Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 6
   ist erst nach den Handgriffen messbar; Kriterien 1–5 laufen vor dem Commit.
   Fällt 6 rot aus, wird vorwärts korrigiert und die rote Zeile mit Datum unter
   `## Bekannte Lücken` eingetragen; ist die **Kernannahme** widerlegt (das
   Tippen kommt auf der Seite nicht an), geht das Inkrement zurück in die Spec.

## Dev plan

1. **Wire-Konstante `type` auf beiden Seiten.** `bridge/protocol.mjs` und
   `extension/protocol.js`: `TYPE: "type"` in `METHODS` (beide Kopien im selben
   Schritt — `extensionProtocol_comparedToBridgeProtocol_shouldBeIdentical`
   vergleicht per `deepStrictEqual`). Neuer Fall in `test/protocol.test.js`:
   `extensionAndBridgeProtocols_methodsType_shouldBothSpellItOutLiterally`,
   gebaut wie der `click`-Fall.
   Proof: `node --test --test-reporter=tap test/protocol.test.js | grep -E '^# (pass|fail)'`
   → `# fail 0`, `# pass 6` (vorher 5). **Completed 2026-10-23**
2. **`describeElement` und der Sichtbarkeitscheck wandern aus `clickPageSource`
   heraus.** `extension/background.js`: zwei Modulfunktionen
   `describeElement(element)` und `isVisible(element)` (Rect-Fläche,
   `visibility !== "hidden"`, `display !== "none"`) — beide **nur** mit
   Argumenten und Seiten-Globals, damit `toString()` sie vollständig trägt;
   `clickPageSource` behält `querySelector`/`no_match` und prüft
   `!isVisible(element) || element.disabled === true` ⇒ `not_clickable`.
   Neu `PAGE_HELPERS_CODE` (die beiden Helfer per `toString()` aneinander) und
   ein Baukasten `pageSnippetCode(source, args)`:
   `(() => {\n${PAGE_HELPERS_CODE}\nreturn (${source.toString()})(${args.map(JSON.stringify).join(", ")});\n})()`.
   **Warum die IIFE:** ein nacktes `function describeElement(…)` am Skriptanfang
   landete auf dem `window` der Betreiberseite — ein Schreibzugriff auf ihre
   Globals; in der IIFE sind die Helfer lokal und trotzdem echt (eine Funktion im
   Code, `node --check` prüft sie, der Harness führt sie aus). Abgelehnt: ein
   Helfer als Template-String (nicht syntaxgeprüft, nicht ausführbar).
   Proof: `node --test --test-reporter=tap test/extension.test.js | grep -E 'click_|^# (pass|fail)'`
   → `# pass` unverändert, `# fail 0`; Beweisfälle:
   `click_onAnElementWithoutArea…`, `…WithDisplayNone…`, `…WithVisibilityHidden…`,
   `click_onADisabledElement…` und die fünf Beschreibungsfälle.
   **Completed 2026-10-23**
3. **`type` in der Extension: zwei Injektionen, 300-ms-Fenster, Slot,
   Passwort-Option.** `extension/background.js`: `TYPE_FAILED_CODE`,
   `NOT_TYPEABLE_CODE`, `PASSWORD_NOT_ALLOWED_CODE`,
   `ALLOW_PASSWORD_FIELDS_KEY = "allowPasswordFields"`, die Sätze,
   `TYPED_OUTCOMES`, `TYPE_REFUSAL_MESSAGES`; `class TypingError` — nicht
   `TypeError`, weil ein Klassenname, der ein eingebautes Fehlerobjekt nachahmt,
   jeden Leser in die falsche Richtung schickt (mit der Injektion hat der Name
   nichts zu tun, `TypeError` lebt im Modul-Scope); Zweig in
   `answerRequest`; `answerType`/`typeErrorFor` (Muster
   `answerClick`/`clickErrorFor`) — **`ReadError` und `ClickError` werden
   unverändert durchgereicht**: der Slot wirft `ClickError(SUPERSEDED_CODE)`, und
   ohne diesen Zweig antwortete eine überholte Anfrage `type_failed` statt
   `superseded`;
   `typeRequestParams(params)` ⇒ `{selector, text, submit}`: `selector`/`text`
   kein String ⇒ `invalid_params` (`""` ist erlaubt), `submit` fehlt ⇒ `false`,
   sonst nur `true`/`false`; `passwordFieldsAllowed()` ⇒
   `browser.storage.local.get([ALLOW_PASSWORD_FIELDS_KEY])` (Arrayform wie
   `readSettings`), Rückgabe `stored?.[…] === true`, `catch` ⇒ `console.warn` +
   `false`; Aufruf **in `typeAgentTab`** nach `typeRequestParams` und **vor** der
   Tab-Auflösung — nichts wird injiziert, bevor die Option feststeht.
   `typeAgentTab(params)`: `pageStateBeforeClick(tab)`, `supersedeActiveNavigation()`,
   `claimClickSlot()` **und `activeNavigation = slot`** (ohne diese Zuweisung
   wirft die erste Eigentümerschaftsprüfung sofort `superseded`),
   `injectPageCode(tab.id, typePageCode(params))` mit
   `typePageCode(request) = pageSnippetCode(typePageSource, [request])`,
   `typeOutcomeOf(...)`, zweimal `requireClickOwnership`, `arm()`,
   `typeResult(...)`; `finally` wie bei `click`. Die Fenster-Helfer
   (`claimClickSlot`/`startClickWindow`/`requireClickOwnership`) werden
   **nicht umbenannt** mitbenutzt (Präzedenz `activeNavigation`), mit einem Kommentar,
   dass sie jetzt `click` und `type` dienen.
   `typePageSource(request)` (ein JSON-quotiertes Objekt
   `{selector, text, submit, allowPasswordFields}`): genestet `isTypeable`
   (`input` mit typbarem `type`/`textarea`/`isContentEditable`, sonst
   `not_typeable`; ebenso `disabled`, `readOnly`, `type === "hidden"`,
   **`type === "file"`**; die Positivliste steht in `## Wire-Protokoll`),
   `setNativeValue`, `pressEnter`. Reihenfolge: `querySelector` try/catch ⇒
   `invalid_selector`; `null` ⇒ `no_match`; `isTypeable` (enthält
   `isVisible`) ⇒ `not_typeable`;
   `type === "password" && allowPasswordFields !== true` ⇒
   `password_not_allowed`; **dann erst** `const typed = describeElement(element)`
   (vor dem Schreiben — ein `input`-Handler darf `id`/`class` wegrerendern),
   dann schreiben, dann `{outcome:"typed", typed, submitted}`.
   `setNativeValue`: `element.isContentEditable === true` ⇒ `textContent` +
   `new Event("input", {bubbles:true})`; sonst
   `Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ?
   HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")` und
   `.set.call(element, text)`, danach `input` **und** `change`; fehlt der
   Descriptor oder sein `set` ⇒ `{outcome:"type_failed"}` — **kein** stiller
   Fallback auf `element.value = …`, sonst wäre jeder Tippfall auch ohne
   Setter-Stub grün.
   `pressEnter`: `keydown`/`keypress`/`keyup` mit `key:"Enter"`, `bubbles`,
   `cancelable`; **das `keydown`-Ergebnis ist die Abbruch-Info**
   (`dispatchEvent` liefert `false`, wenn ein Handler `preventDefault` rief).
   `submitted = request.submit === true` **als Boolean** („Enter wurde
   ausgelöst", nicht „die Seite hat reagiert"); `form.requestSubmit()` nur bei
   `submitted && keydownNichtAbgebrochen && element.form && typeof
   form.requestSubmit === "function"`. `typeOutcomeOf` liefert
   `{typed, submitted}`, sonst `TypingError` mit dem Code; `typeResult` ist
   `clickResult` mit `typed`/`submitted` statt `clicked`, inklusive `about:`-Regel.
   `test/extension.test.js`: `runPageCode`-Kontext um `HTMLInputElement`/
   `HTMLTextAreaElement` (Prototyp mit `value`-Accessor, der `this._value` setzt
   und `this.nativeSets` zählt) und `Event`/`KeyboardEvent` erweitern; neu
   `createTypeElement` mit einem **eigenen** `value` (der React-Schatten: genau
   deshalb braucht es den Prototyp-Setter — eine schlichte Zuweisung trifft den
   Schatten, nicht den Setter), während der Prototyp den zählenden Accessor
   trägt; im Übrigen wie `createClickElement` (`tagName`, `id`, `className`,
   `getAttribute`, `getBoundingClientRect`) plus `type`, `readOnly`,
   `isContentEditable`, `textContent`, `events`, `nativeSets`, `dispatchEvent`
   (zählt `event.type`, gibt `page.cancelKeydown !== true` zurück), `form` mit
   `requestSubmit`-Zähler;
   `createTypePage`, `createTypeTabs`, `sendType`, `answerForTypedField`; die
   Fälle aus `## Testing`.
   Proof: `node --test --test-reporter=tap test/extension.test.js | grep -E 'type_|^# (pass|fail)'`
   → jeder neue Name `ok`, `# fail 0`; im Erfolgsfall `clock.pendingDelays()` =
   `[300]`, im gesperrten Passwortfall `nativeSets === 0` **und** `events` leer,
   im `input`-Fall `nativeSets === 1` **und** `element.value` (der
   React-Schatten) unverändert, im Abbruchfall `form.submitCalls === 0` bei drei
   Tastenereignissen. **Completed 2026-10-23**
4. **Optionsseite: die Checkbox.** `extension/options.html`: Checkbox
   `id="allowPasswordFields"` mit Label „Passwortfelder erlauben" und einem
   Hinweissatz (Default aus); `extension/options.js`: Konstante
   `ALLOW_PASSWORD_FIELDS = "allowPasswordFields"`, Laden in `loadSettings`
   (`checkbox.checked = stored[ALLOW_PASSWORD_FIELDS] === true`), Mitschreiben in
   `handleSubmit` über **`.checked`**, nicht `.value` (die bestehende
   Feld-Schleife dort liest `.value`; eine Checkbox hat keins). `manifest.json` unverändert.
   Proof: neuer Fall
   `type_withAllowPasswordFieldsSwitchedBetweenTwoCalls_shouldReadTheOptionEveryTime`
   — erst ohne Schlüssel ⇒ `password_not_allowed`, dann
   `browser.storage.local.set({allowPasswordFields: true})` und derselbe Aufruf
   ⇒ Wert gesetzt, ohne Neustart; dazu die drei Formen fehlend/`false`/`"true"`
   ⇒ gesperrt. Ohne Browser: ein Fall in `test/manifest.test.js`, der
   `options.html` liest (`id="allowPasswordFields"` **und** `type="checkbox"`)
   und `options.js` auf dasselbe Key-Literal prüft — eine
   Verdrahtungsprüfung gegen den Tippfehler, den sonst erst Kriterium 6 zeigt.
   `npm run check; echo $?` → `0`. **Completed 2026-10-23**
5. **Hub: Logzeile und roter Debug-Block.** `bridge/hub.mjs`: `#reportResult`
   bekommt den `TYPE`-Zweig, `#reportType(params, result)`; neu
   `formatTypeLine(params, result)` =
   `type selector=… chars=… submit=… tab=… url=…` — `chars` ist die Länge des
   **getippten** Textes (`params.text`, `NO_FIELD` wenn kein String), `submit`
   die Absicht aus `params` (`params?.submit === true`), `tab`/`url` aus dem
   Ergebnis wie bei `click`; Debug-Kopie wie `#reportClick` mit **zwei**
   Redaktionen: `{...result, text: "<n chars>", typed: "<n chars>"}`.
   Proof: `node --test --test-reporter=tap test/hub.test.js | grep -E 'type selector=|^# fail'`
   → `hub_requestWithTypeMethod_shouldLogSelectorCharsAndSubmitWithoutTheTypedText`
   mit `text: "geheim-testwert"` erwartet
   `type selector=input[name="q"] chars=15 submit=true tab=42 url=…`, `# fail 0`,
   und `logLines.join("\n")` enthält `"geheim-testwert"` nicht; der Debug-Fall
   prüft `"text": "<… chars>"` und `"typed": "<… chars>"`. **Completed 2026-10-23**
6. **MCP-Werkzeug `browser_type` samt Fixture.** `bridge/mcp.mjs`: `BROWSER_TYPE`;
   fünfter `TOOLS`-Eintrag (Beschreibung wörtlich, `required:
   ["selector","text"]`, `additionalProperties: false`);
   `UNEXPECTED_ARGUMENTS[BROWSER_TYPE]`; `TOOL_TEXTS.NOT_TYPEABLE(selector)`,
   `TOOL_TEXTS.PASSWORD_NOT_ALLOWED`, `TOOL_TEXTS.INVALID_SELECTOR(selector)`;
   `typeTool` (Muster `clickTool`); `callTool` bekommt `case BROWSER_TYPE`;
   `extensionFailureText` einen `BROWSER_TYPE`-Zweig: `invalid_selector`,
   `no_match`, `not_typeable`, `password_not_allowed`, `no_agent_tab`,
   `not_readable` wie in `## MCP-Werkzeug`, alles andere (auch `type_failed`,
   `superseded`) ⇒ `CALL_EXTENSION_FAILED(code)`.
   `test/fixtures/fake-extension.mjs`: `TYPE_RESULT` (die `read`-Felder plus
   `typed: "input#q"`, `submitted: true`, `text: READ_RESULT.text` — **kein**
   getippter Text im Repo), `typeResponse`, `case "type"`,
   `BC_TEST_TYPE_ANSWER`; die Fehlerantwort trägt kein `via` (wie `click`).
   `test/mcp.test.js`: Konstanten, `browserTypeCall`, `TYPE_REQUEST_LINE`,
   `typeRequestCount`; `mcp_toolsList_shouldOfferExactlyTheFourTools…` →
   `…FiveTools…` mit fünfter Schema-Prüfung; die Fälle aus `## Testing`.
   Proof: `node --test --test-reporter=tap test/mcp.test.js | grep -E '^# (pass|fail)'`
   → `# fail 0`; `typeRequestCount` ist 0 für jeden abgelehnten Aufruf und 1 für
   den Erfolg. **Completed 2026-10-23**

### What could go wrong

- **Zwei Bestandsfälle müssen sich ändern**, nicht einer:
  `mcp_toolsList_shouldOfferExactlyTheFourTools…` **und**
  `onMessage_withUnknownMethod_shouldReplyUnsupportedMethod` in
  `test/extension.test.js`, das seit Inkrement 06 `type` als Beispiel für „nicht
  implementiert" benutzt. Es muss auf `no_such_method` wandern (nicht auf
  `focus` — der kommt in Inkrement 08 und bräche den Fall erneut). Kriterium 1
  nennt beide.
- **`input[type=file]` gehört in die Typ-Prüfung**, sonst liefe der Setter
  hinein und Firefox würde werfen — die Antwort wäre `not_readable` statt
  `not_typeable`.
- **`chars` in der Hub-Zeile ist die Länge des getippten Textes**, nicht des
  Seitentextes; Kriterium 5 sagt das jetzt ausdrücklich.
- **Die 300 ms und der Slot:** `type` erbt das Fenster **nach** dem Schreiben.
  Ein Feld, das auf `input` hin wegrennt, ist danach weg — kein Nachfassen in
  diesem Inkrement.
- **`requestSubmit` bleibt eine Beobachtung:** abgebrochenes `keydown` ⇒ kein
  `requestSubmit` (gepinnt); ein Seitenhandler, der selbst absendet und
  `preventDefault` vergisst, sendet doppelt — das ist `## Risiken`, nicht
  Testgegenstand. Der Stub darf keinen eigenen absendenden Handler haben, sonst
  prüft der Fall nur die Attrappe.
- **`storage.local.get`:** die Sandbox-Attrappe spiegelt nur Array- und
  Objektform; deshalb Arrayform wie in `readSettings`, sonst wäre jeder
  Passwortfall „korrekt gesperrt" aus dem falschen Grund.
- **Namensschuld:** `claimClickSlot`, `startClickWindow`,
  `requireClickOwnership`, `pageStateBeforeClick` und `CLICK_WAIT_MS` bedienen
  ab jetzt zwei Methoden; umbenannt wird bewusst nicht (Präzedenz
  `activeNavigation`), 08 oder 09/10 entscheiden das mit dem dritten Aufrufer.

### Ordering and dependencies

1 → 2 → 3 → 4; 1 → 5; 1 → 6. Stufe 5 und 6 sind voneinander und von 2–4
unabhängig (der Hub-Test schickt eigene Antwortframes, der MCP-Test spawnt die
Fixture) — parallel nur in getrennten Worktrees. Nach jeder Stufe grün; die
Abnahmebefehle aus `CONTRIBUTING.md` und die Kriterien 1–5 laufen vor dem Commit.
Kriterium 6 (Extension in `about:debugging` neu laden, pi neu starten, auf der
Qwant-Seite `example` tippen und absenden) ist Hand-over-Text für den Betreiber,
keine Stufe.

### What the next increment inherits

- **Namensschuld** (siehe oben) — der dritte Aufrufer entscheidet.
- **Snippet-Baukasten:** jeder weitere Seitencode (Screenshot, Frames, Shadow
  DOM) geht durch `pageSnippetCode` und bekommt `describeElement`/`isVisible`
  mit; 15/16 müssen entscheiden, ob derselbe Helferblock pro Frame injiziert
  wird.
- **Das 300-ms-Fenster** ist jetzt an drei Stellen derselbe geratene Wert;
  09/10 ersetzen es durch Ruhe-Erkennung.
- **Die Passwort-Option** lebt nur in der Extension; die Bridge kennt sie nicht
  (so entschieden). Eine Sperrliste oder Rückfrage vor dem Absenden bleibt offen.
- **Nicht dabei:** allgemeine Tastatur (einzelne Tasten, Shortcuts,
  Tab-Navigation), `select`, Checkboxen, `focus`, Datei-Upload, Koordinaten,
  Scrollen, Frames, Shadow DOM, `isTrusted`-Tasten, Warten auf die Übernahme des
  Werts durch ein Framework, Tippen in einen fremden Tab, und der getippte Text
  in irgendeiner Logzeile.

7. **Nachtrag vom 2026-10-23 — das Feld muss den Text auch zeigen (entstanden nach
   dem ersten echten Tippen).** `extension/background.js`, im injizierten Code:
   `focus()` vor dem Schreiben, `beforeinput` vor dem Wert, `input` mit
   `inputType`/`data`, und im nächsten Task nachsetzen, wenn die Seite den Wert
   zurückgeschrieben hat. Tests: Fokus vor dem ersten Ereignis; kontrolliertes
   Feld, das zurückschreibt ⇒ Wert steht danach, `input` zweimal; akzeptierendes
   Feld ⇒ `input` einmal.
   Proof: `node --test --test-reporter=tap test/extension.test.js` → `# fail 0`;
   Gegenprobe: das Nachsetzen entfernen ⇒ der kontrollierte Fall wird rot.
   **Completed 2026-10-23**

## Risiken

- **Frameworks bemerken nur den nativen Setter.** Seiten mit React/Vue/Angular
  ignorieren `element.value = …`; deshalb der Umweg über den Prototyp-Setter und
  `input`/`change`. Seiten, die eigene Handler an `keydown` hängen, sehen
  trotzdem keine einzelne Taste — sie sehen den Wert als Ganzes.
- **`submit: true` kann etwas auslösen.** Der Betreiber hat es so entschieden
  (tippen **und** absenden), aber es heißt: eine Suche, ein Formular, im
  schlimmsten Fall eine Bestellung. Es gibt keine Rückfrage und keinen
  Trockenlauf.
- **`requestSubmit` nach nicht abgebrochenem Enter** kann doppelt absenden, wenn
  eine Seite das Enter nur halb behandelt (eigenen Handler ohne
  `preventDefault`). Der Test pinnt den Fall „abgebrochen ⇒ kein
  `requestSubmit`"; die Gegenrichtung bleibt eine Beobachtung, keine Garantie.
- **Passwortfelder sind nur so sicher wie die Option.** Wer sie freischaltet,
  erlaubt dem Agenten, sich in seinem Namen anzumelden — inklusive
  Zwei-Faktor-Seiten, soweit sie nur ein Feld brauchen. Default aus, und der Satz
  im Werkzeug-Text sagt, wo man es umstellt.
- **Das Feld kann während des Tippens verschwinden** (Rerender): dann steht der
  Wert in einem Element, das nicht mehr da ist, und der Seitentext zeigt es
  nicht. Kein Nachfassen in diesem Inkrement.
- **300 ms bleiben geraten** — dieselbe Grenze wie bei `click`, dieselbe Lösung
  in Inkrement 09/10.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine Tokens im Repo, **kein echter
  getippter Text in Logs, Tests, Fixtures oder Doku** — die Tests verwenden
  erfundene Werte (`"geheim-testwert"`).
- `extension/manifest.json` bleibt unverändert (keine neue Berechtigung),
  `bridge/websocket.mjs` und `bridge/config.mjs` ebenso.
- `CONTRIBUTING.md` (`## Rules`, Nachtrag zur Passwort-Option), `docs/PROJECT-STATE.md`,
  `docs/README.md`, `docs/ROADMAP.md` und `INSTALL.md` pflegt der Orchestrator.
- Kein Produktivcode für Inkrement 08 oder später (`focus`, Ruhe-Erkennung,
  Screenshot, Frames, `select`/Checkboxen).

## Bekannte Lücken

Stand 2026-10-23, vor der Messung:

- **Die `url` in der Logzeile und der `title` im Debug-Block können den getippten
  Text tragen** (2026-10-23, Code-Review): auf einer Suchseite steht der
  Suchbegriff in der Adresse (`…?q=example`). Die Zeile selbst führt nur
  `chars`, aber `url=` darf sie nicht verschweigen — die Antwort muss die
  Adresse zeigen. Wer wirklich nichts preisgeben will, tippt nicht in
  Suchfelder; ein Filter für Query-Parameter wäre eine eigene Entscheidung.
  **Der `title`-Teil ist seit 2026-11-18 geschlossen** (Spec 28): der Debug-Block
  zeigt `title` als `<n chars>` (`DEBUG_WHITELIST` in `bridge-rs/src/hub.rs`), der
  Seitentitel des Suchergebnisses steht also nicht mehr im Log. Die `url` bleibt
  voll — das ist die bewusste Grenze dieser Zeile.
- **`submit: null` gilt als „kein Boolean"** ⇒ `invalid_params`; nur fehlend
  oder `undefined` heißt `false`.
- **`requestSubmit` bleibt eine Beobachtung:** ein Seitenhandler, der selbst
  absendet und `preventDefault` vergisst, sendet doppelt. Gepinnt ist nur der
  abgebrochene Fall.
- **Das Nachsetzen unterscheidet nicht zwischen „zurückgeschrieben" und
  „normalisiert"** (2026-10-23, Review): eine Seite, die den Wert trimmt oder
  maskiert (`input[type=number]` mit `"12,5"`), bekommt ein zweites `input` mit
  dem rohen `data`, obwohl sie nichts verworfen hat. Sauber wäre, den Wert
  **vor** dem Schreiben zu merken und nur nachzusetzen, wenn die Seite genau
  diesen Vorher-Wert wiederhergestellt hat — damit wäre auch das
  Supersede-Restrisiko (der Nachsetzer des überholten Aufrufs schreibt in das
  Feld des Nachfolgers) erledigt.
- **Enter geht vor dem Nachsetzen raus** (2026-10-23, Review): bei einem
  kontrollierten Feld sieht ein `Enter`-Handler der Seite den Wert erst nach dem
  Nachsetzen, also unter Umständen gar nicht. Absicht (das Absenden ist der
  Sinn des Aufrufs), aber es steht hier, damit es niemand für einen Fehler hält.
- **`typed`/`clicked` stehen in der Antwort, nicht in der Logzeile** — die
  Antwort geht an das Modell, die Logzeile an den Betreiber; das ist die
  Trennlinie, die dieses Inkrement zieht.

## Open questions

Keine. Entschieden vom Betreiber am 2026-10-23: tippen **und** absenden sind
erlaubt; Passwortfelder sind standardmäßig gesperrt und über eine Option der
Erweiterung freizugeben.

## Review

| Runde | Datum | Verdict | Blocker |
|---|---|---|---|
| 1 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (Setter-Beweisfall wertlos, `ClickError` fiel in den Fallback, Regeländerung unausgesprochen, Checkboxen tippbar) |
| 2 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (drei Einzeiler: Schatten-Prüfung, Checkbox-Zeile, `no_such_method`) |
| 3 | 2026-10-23 | ✅ Ship it | nein (Nachträge) |
| 4 | 2026-10-23 | 🔧 (nach Stage 7, vor dem `active`) | ja (echter getippter Text in der Doku) |
| 5 | 2026-10-23 | ✅ Ship it | nein (Code der Stufe 7) |

## Log

Befunde beim Schreiben des Dev-Plans (2026-10-23), vom Architekten:

- **Kriterium 1 war um einen Fall zu optimistisch**: auch
  `onMessage_withUnknownMethod_shouldReplyUnsupportedMethod` benutzt `type` als
  Beispiel für „nicht implementiert" — **übernommen**: 169 unverändert, zwei
  geändert, beide benannt (der zweite wandert auf `focus`).
- **`invalid_selector` fehlte** in der Code-Liste und in den MCP-Sätzen —
  **übernommen**: eigener Satz wie bei `click`.
- **`chars` in der Logzeile war zweideutig** (getippter Text oder Seitentext) —
  **übernommen**: Kriterium 5 sagt jetzt „Länge des getippten Textes".
- **`input[type=file]`** war Non-goal, aber nicht in der Typ-Prüfung — ohne die
  Bedingung liefe der Setter hinein und die Antwort wäre `not_readable` statt
  `not_typeable`. **Übernommen**, mit Testzeile.

Runde 1 des Spec-Reviews — vier Major und dreizehn Minor, alle übernommen:

- **M1** (der native-Setter-Fall war für beide Implementierungen grün: eine
  schlichte Zuweisung *durchläuft* den Prototyp-Setter, solange das Element kein
  eigenes `value` hat — die reale Welt ist der React-Schatten) — **übernommen**:
  die Attrappe bekommt ein eigenes `value`, gepinnt wird `nativeSets === 1` und
  der unveränderte Schatten, plus ein Fall `type_failed` bei fehlendem
  Descriptor.
- **M2** (`requireClickOwnership` wirft `ClickError`, `typeErrorFor` reichte nur
  `ReadError` durch ⇒ `superseded` käme als `type_failed` an) — **übernommen**.
- **M3** (die Passwort-Option ändert die Regel „Anmeldung macht der Betreiber"
  aus `CONTRIBUTING.md`, ohne dass es dastand) — **übernommen**: im `## Ziel`
  ausgesprochen, samt Nachtrag in `CONTRIBUTING.md` und `PROJECT-STATE.md` als
  Orchestrator-Arbeit.
- **M4** (`input[type=checkbox]` war laut Non-goals verboten und laut Regel
  tippbar) — **übernommen**: Positivliste der typbaren `type`-Werte, alles
  andere `not_typeable`.
- **Minors** — **übernommen**: Sichtbarkeit in der Reihenfolge, `typed` als
  Elementbeschreibung definiert (nie der Text), zwei Redaktionen im Debug-Block,
  `submit` als Boolean an der MCP-Grenze (`-32602`), vier Codes mit Testzeilen,
  `submit` ohne Formular, fehlschlagendes `storage.local`, Text mit
  Anführungszeichen, `no_such_method` statt `focus`, Verdrahtungsprüfung als
  Testzeile, `.checked` statt `.value`, `activeNavigation = slot`,
  `typePageCode` definiert, `submitted` als Boolean, Stub-Felder wie
  `createClickElement`, korrigierte Begründung für `TypingError`, drei
  Rechtschreibstellen.

Runde 2 des Spec-Reviews — drei Blocker (je ein Einzeiler), übernommen:

- **Der Setter-Beweisfall war immer noch nicht unterscheidend** (das Feld hatte
  ein eigenes `value`, gepinnt war aber „kein eigenes `value`") —
  **übernommen**: `nativeSets === 1` **und** unveränderter React-Schatten, in der
  Tabelle wie in Kriterium 4.
- **Die Checkbox-Prüfzeile fehlte**, obwohl M4 genau davon handelte —
  **übernommen**: `checkbox`, `radio`, `range` in der Ablehnungszeile.
- **`focus` gegen `no_such_method`** stand an zwei Stellen verschieden —
  **übernommen**: überall `no_such_method`.
- **Nachträge** — **übernommen**: Testzeile „kein `value`-Accessor ⇒
  `type_failed`", MCP-Fall für `submit` als String, `CONTRIBUTING.md` in der
  Touch-Boundary, „Shadow DOM" gegen „React-Schatten" auseinandergehalten,
  `## Review` vollständig, „Noch keine Befunde." entfernt.

Runde 3 des Spec-Reviews — Verdict `✅ Ship it`: die drei Stellen sind erledigt,
kein Kriterium ist unentscheidbar, der Zuschnitt trägt.

Code-Review Runde 1 — Blocker und zwei Nachträge, alle übernommen:

- **Blocker** — der `.checked`-Beweis in `test/manifest.test.js` war Theater
  (`/\.checked/` traf auch `loadSettings` und `readChecked`); jetzt ist die
  Speicherstelle gepinnt, Gegenprobe gefahren.
- **Nachtrag** — `form.requestSubmit()` steht in `try/catch`, ein werfendes
  `requestSubmit` ist kein `not_readable` mehr; eigener Testfall.
- **Nachtrag** — `typedTextCharCount`/`typedElementCharCount` heißen jetzt
  `typedInputCharCount`/`elementDescriptionCharCount`.

Befund beim ersten echten Tippen (2026-10-23):

- **Die Suche funktionierte, die Sichtbarkeit war unklar.** Zwei `browser_type`
  mit `submit: true` trugen den Begriff nachweislich in die Übermittlung: die
  Ergebnisadresse enthielt ihn als Query-Parameter, prozentkodiert und mit
  Umlaut — das kann nur aus dem übergebenen `text` stammen, weil der
  Orchestrator diese Adresse nie aufgerufen hat. Ob das Feld den Text **anzeigt**, konnte der Orchestrator nicht prüfen —
  die Werkzeuge lesen keine Eingabewerte, und ein `browser_eval` gibt es nicht.
  **Übernommen**: die Schreibsequenz wird robuster (Fokus, `beforeinput`,
  Nachsetzen im nächsten Task), damit ein kontrolliertes Feld den Wert nicht
  stillschweigend zurückschreibt. Das ist der Stand vor dem `active`.

Runde 4 des Spec-Reviews (Stage 7, Tipp-Sequenz) — ein Blocker, übernommen:

- **Echter getippter Text in der Doku** (eine Zeile im Nachtrag zitierte den
  Query-Ausschnitt) — **übernommen**: durch eine Beschreibung ersetzt; die
  Touch-Boundary derselben Spec verbietet es kategorisch.

Runde 5 — Verdict `✅ Ship it` für den Code der Stufe 7: die vier neuen Fälle
werden rot, wenn man Fokus, `beforeinput`-Abbruch, Nachsetzen oder den
Prototyp-Setter herausnimmt. Zwei Nachträge sind mit Datum unter
`## Bekannte Lücken` festgehalten (Normalisierung beim Nachsetzen,
Enter vor dem Nachsetzen), keiner blockiert.

Messlauf (2026-10-23, Kriterium 6) — erfüllt:

- **Getippt und abgesendet wurde über das Suchfeld**, nicht über eine gebaute
  Adresse: `browser_type` mit `input[name="q"]`, `typed:
  input[aria-label="Enter your search term"]`, `submitted: true`.
- **Die Seite hat reagiert:** die Ergebnisadresse trug den Suchbegriff als
  `q`-Parameter, der Seitentitel war „<Begriff> – Qwant Search", und die
  Trefferliste danach gehörte zu genau dieser Suche (zweimal, mit zwei
  verschiedenen Begriffen).
- **Sichtbarkeit im Feld war nicht prüfbar** (die Werkzeuge lesen keine
  Eingabewerte); deshalb Stage 7 (Fokus, `beforeinput`, Nachsetzen), die vor dem
  `active` gebaut und geprüft wurde.

- **2026-11-15 — sichtbare Labels sind englisch.** Der Betreiber hat die
  Optionsseite übersetzen lassen (das Projekt ist öffentlich, die Doku ist
  englisch). Die Zitate oben beschreiben den Stand ihrer Zeit; im Code heißt
  der Schalter jetzt **“Allow password fields”**. Einzelnachweis: `extension/options.html`,
  `test/manifest.test.js`.
