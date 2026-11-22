---
description: browser_read adressiert optional einen iframe (per URL-Teilstring) statt nur den Hauptrahmen; browser_frames listet die Rahmen eines Tabs. Die Handlungswerkzeuge folgen in Specn 25 und 26.
status: active
---

# Auch drinnen lesen: `browser_frames` und `frame` für `read`

Jede Injektion dieses Projekts geht heute in den **Hauptrahmen**
(`frameId: 0`). Alles, was in einem iframe sitzt, ist damit unerreichbar:
Anmeldeformulare von Zahlungsanbietern, eingebettete Buchungskalender,
Kommentar-Widgets, Video-Einbettungen. Der Betreiber hat das am 2026-10-23
notiert; an einer echten Seite (Chat-Widget ohne Launcher) war es der Grund, eine
Aufgabe abzubrechen.

Dieses Inkrement öffnet die Rahmen: ein optionaler
Parameter für `read`, und ein kleines Werkzeug, das sagt, welche Rahmen es gibt.

## Ziel

- **`browser_frames({tab?})`** listet die Rahmen eines Agenten-Tabs:

  ```json
  {"tabId":4,"url":"https://example.org/","count":3,"frames":[
    {"href":"https://example.org/","top":true},
    {"href":"https://widget.example.net/kalender","top":false},
    {"href":"about:blank","top":false}]}
  ```

  `href` ist die Adresse des Rahmens, `top` sagt, ob es der Hauptrahmen ist. Die
  Liste ist die Grundlage für den `frame`-Parameter der anderen Werkzeuge.

- **`frame` als optionaler Parameter** für **`read`** (die vier Handlungswerkzeuge
  folgen in Spec 25): ein **Teilstring der Rahmen-Adresse** (`location.href`), Groß- und
  Kleinschreibung egal. Fehlt er, gilt der Hauptrahmen — alle bestehenden Aufrufe
  bleiben unverändert.
- **Genau ein Rahmen darf handeln.** Die Extension injiziert in **alle** Rahmen
  desselben Tabs (`allFrames: true`) und jeder Rahmen entscheidet selbst, ob er
  gemeint ist (Vergleich seiner `location.href` mit dem Teilstring):
  - **kein** Treffer ⇒ `frame_not_found`, mit der Zahl der Rahmen, die geantwortet haben;
  - **mehrere** Treffer ⇒ `frame_ambiguous`, mit den kollidierenden Adressen
    (höchstens fünf, gekürzt) — der Aufrufer soll genauer adressieren, nicht raten;
  - **genau einer** ⇒ das Werkzeug arbeitet dort wie im Hauptrahmen.
- **Warum ein URL-Teilstring und kein Index.** Ein Index (`"0.2"`) ist eine
  Momentaufnahme: eine Seite, die beim Laden Rahmen nachschiebt, verschiebt ihn
  lautlos, und der Agent klickt im falschen Rahmen. Eine Adresse ist stabil und
  prüfbar, und sie steht in `browser_frames` — der Agent sieht, was er anspricht.
- **`about:blank`-Rahmen** sind über `frame: "about:blank"` adressierbar. Damit
  lässt sich ein leerer Rahmen füllen (per `eval`) und danach darin arbeiten.
- **Kinder von Kindern** sind erreichbar, weil `allFrames: true` alle Rahmen
  einsammelt — nicht nur die direkten Kinder des Hauptrahmens.
- **Der Filter ist die erste Anweisung jedes Schnipsels.** Kein Rahmen wirkt,
  bevor er sich als gemeint erkannt hat: ein nicht adressierter Rahmen antwortet
  `{outcome: "not_the_frame"}` und **tut nichts** (kein Klick, kein Tippen, kein
  `eval`).
- **Fehlerwahrheit bleibt, mit klarer Rangfolge**: kommt die Injektion gar nicht
  durch, gewinnen `no_agent_tab`, `page_busy` und `not_readable` wie bisher.
  `frame_not_found` und `frame_ambiguous` gelten nur für Rahmen, die
  **geantwortet** haben.

## Non-goals

- **Kein `frame` für `navigate`, `focus`, `open_tab`, `close_tab`,
  `screenshot`, `status`.** Diese Werkzeuge handeln auf dem Tab; ein Rahmen ist
  dort keine sinnvolle Adresse.
- **Kein Adressieren per CSS-Selektor des `<iframe>`-Elements.** Der Selektor
  beschreibt ein Element im Elternrahmen, nicht einen Rahmen — und bei
  verschachtelten Rahmen wird er mehrdeutig.
- **Keine neue Berechtigung.** `<all_urls>` + `executeScript` mit `allFrames`
  decken das Inkrement; `webNavigation` (das `getAllFrames` böte) wird **nicht**
  gebraucht. Die Option **`matchAboutBlank: true`** an `executeScript` ist dafür
  nötig (ohne sie lässt sich in einen `about:blank`-Rahmen nicht injizieren) —
  das ist eine Option, keine Berechtigung, `manifest.json` bleibt unberührt.
- **Kein Frame-Wechsel per Kommando** (`frame: "top"` als Rückweg): ohne `frame`
  ist man im Hauptrahmen, das ist der Rückweg.
- **Kein `frame` für `click`, `type`, `inspect`, `eval`** (Spec 25/26 haben es nachgeholt) und keine Änderung an deren
  Ruhe-Erkennung — Spec 25.
- **Die Ruhe-Erkennung von `read` läuft im adressierten Rahmen** (dort, wo gelesen
  wird), nicht im Hauptrahmen.

## Wire-Protokoll

- Neue Methode `frames` in beiden Protokollkopien (`FRAMES: "frames"`); Antwort
  `{tabId, url, count, frames: [{href, top}]}`.
- **`read`** bekommt `frame?: string` (optional); die vier Handlungswerkzeuge
  folgen in Spec 25.
- `browser_frames` erbt `no_agent_tab` (kein Agenten-Tab) und die
  Injektionsfehler (`page_busy`, `not_readable`) wie `read`.
- Neue Codes: `frame_not_found` und `frame_ambiguous`. `frame_not_found` trägt
  `details.frames` = **Rahmen, die geantwortet haben**; `frame_ambiguous` trägt
  `details.candidates` (bis zu fünf gekürzte Adressen). Ein Eintrag ohne
  brauchbare `href` (kein String) fällt aus `frames` **und** aus der Zahl — sonst
  tragen `count` und die Fehlerzahl zwei verschiedene Werte unter demselben Wort.

## MCP-Werkzeug

- **Zwölftes Werkzeug `browser_frames`**, angehängt (Position 11), Schema
  `{tab?}`, Beschreibung: „Listet die Rahmen (iframes) des Agenten-Tabs mit ihrer
  Adresse; `frame` bei den anderen Werkzeugen nimmt einen Teilstring davon."
- `frame` als optionale Eigenschaft in `read` (die Handlungswerkzeuge in Spec 25/26)
  (`type: "string"`, `minLength: 1`); `additionalProperties: false` bleibt.
- Fehlertexte: je ein eigener Satz für `frame_not_found` und `frame_ambiguous` —
  keiner fällt auf den allgemeinen zurück. `frame_ambiguous` nennt die Kandidaten.

## Hub

Unverändert: die Logzeilen tragen weiter nur Zahlen (`chars=`, `truncated=`,
`via=`); `frame` wird **nicht** geloggt (eine Rahmen-Adresse kann eine Sitzung
enthalten), `browser_frames` bekommt keine eigene Logzeile — es ist ein
Lesevorgang wie `status`.

## Extension

- `injectPageCode(tabId, code, {allFrames})`: mit `allFrames: true` liefert
  `executeScript` ein Ergebnis **pro Rahmen**; die Reihenfolge ist nicht
  garantiert, also entscheidet der **Inhalt** (jedes Ergebnis trägt `href`).
- Jeder Schnipsel, der `frame` unterstützt, bekommt den Teilstring als Argument
  und antwortet im nicht-gemeinten Fall mit einem Marker
  (`{outcome: "not_the_frame"}`); die Extension sammelt die Antworten und wählt
  den Treffer.
- Ein gemeinsamer Helfer `frameTargetOf(results, want)` liefert `{frame, hit}` bzw.
  wirft `frame_not_found`/`frame_ambiguous` — **eine** Stelle für das Dreieck.
- `framesAgentTab(params)`: injiziert ein Mini-Snippet in alle Rahmen, das
  `{href, top}` zurückgibt, und baut daraus die Antwort.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `read` ohne `frame` injiziert weiter mit `frameId: 0` | Rückwärtskompatibilität |
| `test/extension.test.js` | `read` mit `frame: "widget"` und zwei Rahmen ⇒ Text aus dem Widget-Rahmen | Adressierung |
| `test/extension.test.js` | `frame: "gibtsnicht"` ⇒ `frame_not_found` mit der Zahl der Rahmen, die geantwortet haben | Fehlerfall 1 |
| `test/extension.test.js` | zwei Rahmen mit derselben Adresse, `frame` passt auf beide ⇒ `frame_ambiguous` mit den Kandidaten | Fehlerfall 2 |
| `test/extension.test.js` | `read` adressiert einen Rahmen; die vier Handlungswerkzeuge folgen in Spec 25/26 | Filter als erste Anweisung |
| `test/extension.test.js` | im Zwei-Rahmen-Tab bleibt der **nicht** adressierte Rahmen unverändert (keine `clicked`-Marke, kein `value`, kein `__probe`) | der Filter ist die erste Anweisung — kein Rahmen wirkt ungefragt |
| `test/extension.test.js` | `browser_frames` lässt einen Eintrag ohne brauchbare `href` aus `frames` **und** aus `count` | zwei Zahlen tragen nicht denselben Namen |
| `test/extension.test.js` | `frames` liefert alle Rahmen inklusive `about:blank` und `top: true` für den Hauptrahmen | `browser_frames` |
| `test/extension.test.js` | `frames` ohne Agenten-Tab ⇒ `no_agent_tab`; verweigerte Injektion ⇒ `page_busy`/`not_readable` | `browser_frames` erbt die Fehlerwahrheit |
| `test/extension.test.js` | Ruhe-Erkennung fährt mit demselben `frame`-Filter (`allFrames === true`, `frameId === undefined`, Filter im Code) und die Antwort trägt das Ruhe-Paar des **adressierten** Rahmens | keine stille Rückkehr in den Hauptrahmen |
| `test/mcp.test.js` | `browser_frames` erscheint als zwölftes Werkzeug; `frame` wird bei `browser_read` durchgereicht | Schema |
| `test/mcp.test.js` | `frame: 1` ⇒ `-32602`; `frame_not_found`/`frame_ambiguous` haben eigene Sätze | Typen und Texte |
| `test/http-mcp.test.js` | `TOOL_COUNT` = 13 | auch über den Dienst |

## Acceptance criteria

**Ausnahme mit Datum** (2026-10-27, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 7 ist
live und nach dem Commit zu messen; **Kernannahme** ist Kriterium 6 (live).

1. **Ohne `frame` unverändert** (lokal). `read` injiziert weiter in
   `frameId: 0`, und alle bestehenden Fälle sind grün.
2. **Adressierung funktioniert** (lokal). `read` mit einem Teilstring trifft
   genau einen Rahmen; der Text kommt aus diesem Rahmen.
3. **Kein Treffer ist ein eigener Fehler** (lokal). `frame_not_found` mit der Zahl
   der Rahmen, die geantwortet haben.
4. **Mehrdeutigkeit wird abgelehnt** (lokal). Zwei passende Rahmen ⇒
   `frame_ambiguous` mit den Kandidaten; kein Rahmen liefert Text.
5. **`browser_frames`** (lokal). Zwölftes Werkzeug, listet alle Rahmen mit `href`
   und `top`; `TOOL_COUNT = 13`; erbt `no_agent_tab`/`page_busy`/`not_readable`
   mit den Sätzen von `read` (nicht dem `status`-Satz).
6. **Ein echter Rahmen ist lesbar** (live). Auf einer Seite mit eingebettetem
   iframe nennt `browser_frames` den Rahmen, `read` mit seinem `frame`-Teilstring
   liefert dessen Text, und `read` **ohne** `frame` liefert weiter den
   Hauptrahmen. Die Zahlen stehen unter `## Messlauf

**Gemessen am 2026-10-29** im Profil des Betreibers, Tab 7, Extension 0.1.0
(`git pull` + Reload + pi-Neustart davor).

| Kriterium | Seite | Befund |
|---|---|---|
| 6 (live) | `developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe` | `browser_frames`: `count: 6`, darunter `example.org`, zwei `mdnplay.dev`-Läufe, ein `openstreetmap.org`-Embed, Top `false` für alle Nicht-Hauptrahmen |
| 2 | dieselbe Seite | `browser_read` mit `frame: "example.org"` antwortet `url: "https://example.org/"`, `title: "Example Domain"`, `text` aus dem Rahmen (917 Zeichen), `settled: true`, `waitedMs: 999` |
| 6 (`about:blank`) | `w3schools.com/html/html_youtube.asp` | Die Liste enthält **drei** `about:blank`-Rahmen mit `top: false` — Einträge, die nur entstehen, wenn der Schnipsel **in** ihnen lief. `matchAboutBlank` injiziert also wirklich. |
| 6 (Ruhe im Rahmen) | wie oben | `read` mit `frame` liefert `settled: true` / `waitedMs: 999`, `read` ohne `frame` auf derselben Seite `settled: false` / `waitedMs: 0` — die Ruhe-Erkennung wartet im adressierten Rahmen, nicht im Tab |
| 3 | `w3schools.com/html/tryit.asp?…` | `frame: "nichtvorhanden"` ⇒ „No frame matches this `frame` … (frames that answered: 55)" |
| 4 | dieselbe Seite | `frame: "pubmatic"` und `frame: "tryit.asp?filename=tryhtml_intro"` ⇒ mehrere Kandidaten im Satz (2 bzw. 4), kein Rahmen wird gelesen |

**Befund, der als Lücke bleibt:** auf der Werbe-Seite nennt `frame_not_found`
**55** antwortende Rahmen, während `browser_frames` **9** listet. Beide Zahlen sind
ehrlich, sie zählen Verschiedenes: `details.frames` zählt die Objekt-Einträge der
Injektion (auch Rahmen ohne brauchbare `href`), `count` die gefilterte Liste. Wer
die beiden Zahlen nebeneinander sieht, hält eine für falsch — das gehört in eine
eigene Spec, nicht in eine stille Angleichung.

**Nicht gemessen:** ein adressierbarer `about:blank`-Rahmen (auf den besuchten
Seiten gab es immer mehrere, also `frame_ambiguous`), und `frame` bei `click`/`type`
(Spec 26).
## Dev plan

Die Stufen sind in dieser Reihenfolge baubar; jede ist für sich grün, keine
braucht eine spätere. Prüfbefehle, wo nicht anders genannt: `node --test
--test-timeout=60000 <datei>`; vor jeder Stufe zusätzlich `npm run check`.

1. **Protokoll: `FRAMES` in beiden Kopien.** `extension/protocol.js` und
   `bridge/protocol.mjs` bekommen `FRAMES: "frames"` in `METHODS` (angehängt,
   nach `SCREENSHOT`). `test/protocol.test.js` bekommt den wörtlichen Pin im Stil
   der elf vorhandenen; die Ganz-Objekt-Prüfung
   `extensionProtocol_comparedToBridgeProtocol_shouldBeIdentical` deckt den Rest.
   Proof: `node --test test/protocol.test.js` — 0 Fehler, inklusive des neuen Pins.

2. **Extension: die Methode `frames`.** In `extension/background.js`:
   `injectPageCode(tabId, code, { head = true, allFrames = false } = {})` — ohne
   `allFrames` bleibt der heutige Zweig exakt `{code, runAt: "document_idle",
   frameId: 0}`; mit `allFrames` **`{code, runAt: "document_idle", allFrames: true, matchAboutBlank: true}`** und **kein** `frameId` (die beiden schließen sich in
   `tabs.executeScript` aus; `matchAboutBlank` ist die Option, ohne die ein
   `about:blank`-Rahmen gar nicht injizierbar ist). **Neu: `class FramesError
   extends Error`** (mit `code`) — Stufe 4 bringt `FrameError` für den Filter mit,
   Stufe 2 braucht die Klasse für `addressedAgentTab(params, FramesError)` und
   `frameErrorFor`. Neu: `framesPageSource()` +
   `framesPageCode()`, `framesAgentTab(params)` (Tab über
   `addressedAgentTab(params, FramesError)`, Injektion mit `allFrames: true`,
   Antwort `{tabId, url, count, frames: [{href, top}]}` mit `top` aus
   `window.top === window`), `answerFrames`, `frameErrorFor`, und der Zweig in
   `answerRequest` **vor** dem `unsupported_method`-Fall.
   Harness: `pageContextOf` bekommt `window` (`window.top === window` echt
   entscheidbar); neuer Stub `executeOnFrames(frames)` und `sendFrames`. Der Stub
   muss `details.allFrames === true` und `details.frameId === undefined` prüfen
   und sonst werfen — sonst beweist der Fall nur, dass der Stub antwortet.
   Proof: `node --test test/extension.test.js --test-name-pattern frames`.

3. **Bridge: `browser_frames` als zwölftes Werkzeug.** In `bridge/mcp.mjs`:
   `BROWSER_FRAMES`, `TOOLS`-Eintrag **angehängt** (Position 11, Schema `{tab:
   TAB_PROPERTY}`, `additionalProperties: false`), `framesTool` über
   `optionalArgumentsTool` mit `TAB_ARGUMENTS` und
   `hub.request(PROTOCOL.METHODS.FRAMES, withOptionalTab({}, tab))`, Fall in
   `callTool`. **Und der Fehlerzweig in `extensionFailureText`:** ohne
   `if (toolName === BROWSER_FRAMES)` fiele `no_agent_tab`/`page_busy`/
   `not_readable` auf `TOOL_TEXTS.STATUS_EXTENSION_FAILED` — dieselben Sätze wie
   `read`. `bridge/hub.mjs` bleibt unangetastet — `#reportResult` schreibt für
   eine Methode ohne Zweig nichts, und genau das ist die geforderte „keine eigene
   Logzeile". `test/fixtures/fake-extension.mjs`: `FRAMES_RESULT`,
   `framesResponse`, `BC_TEST_FRAMES_ANSWER`, `answers.frames`, Fall in
   `responseFor`. `test/mcp.test.js`: `tools.length === 12`, Namensarray mit
   `browser_frames` an Position 11, Schema-Pin, ein `tools/call`-Fall, und je ein
   Fall `BC_TEST_FRAMES_ANSWER` = `no_agent_tab`/`page_busy`/`not_readable` ⇒ der
   Satz von `read`; `test/http-mcp.test.js`: `TOOL_COUNT = 13`.
   Proof: `node --test test/mcp.test.js test/http-mcp.test.js` — beide grün.

4. **Extension: das Dreieck und `frame` für `read` (Muster).** In
   `extension/background.js`: `class FrameError` (mit `code` und `details`),
   `frameWantedOf(params, RequestError)` (fehlt → `null`; kein String oder `""` →
   `invalid_params` der Klasse des Werkzeugs; sonst der kleingeschriebene
   Teilstring; Validierung **nach** der Argumentprüfung des Werkzeugs),
   `frameTargetOf(results, want)` als **eine** Stelle: `want === null` ⇒
   `results[0]`; sonst `outcome === "not_the_frame"` verwerfen, 0 Treffer ⇒
   `FrameError("frame_not_found", …, {frames: <Zahl der Objekt-Einträge>})`, ≥2 ⇒
   `FrameError("frame_ambiguous", …, {candidates: <erste fünf href>})`, genau 1 ⇒
   dieser Eintrag. Der Filter reist in den erzeugten Code (`readPageCode(offset,
   maxChars, mode, minChars, want)`): Nicht-Treffer antworten `{outcome:
   "not_the_frame", href}`, Treffer ihre normale Antwort **plus** `href`.
   `readAgentTabPage` ruft `injectPageCode(…, {allFrames: want !== null})` und
   `pageResultOf(tabId, frameTargetOf(results, want))`; `readErrorFor` bekommt den
   `FrameError`-Zweig. **Die Ruhe-Erkennung gehört in diese Stufe:** `settleAgentTab(tab.id, null,
   want)` und `settlePageCode(want)` fahren mit demselben Filter; im Rennen bleibt
   die Reihenfolge `SUPERSEDED_SETTLE` → `NO_SETTLE` (Frist) →
   `settleOutcomeOf(winner[0])`. Ohne diesen Schritt wartet `read` im Rahmen auf
   die Ruhe des Hauptrahmens — und kein Test würde es merken. **Vertrag der Konsumenten: `frameTargetOf` liefert einen
   Eintrag, nicht ein Array.** Anzupassen sind alle, die heute selbst `results[0]`
   lesen: `settleOutcomeOf`, `pageResultOf`, `clickOutcomeOf`, `typeOutcomeOf`,
   `inspectResultOf` und `eval` (`Array.isArray(results)` bleibt dort **vor** der
   Rahmenauswahl, sonst wird ein `eval_timeout` zum `frame_not_found`); dazu die
   zwei Aufrufe des Seitenzustands nach `click`/`type`.
   Tests: `read` ohne `frame` injiziert weiter mit `frameId: 0`; `read` mit
   `frame` liefert den Text des Rahmen-Fixtures; `frame_not_found` mit der Zahl;
   `frame_ambiguous` mit Kandidaten; derselbe Fall mit **umgekehrter**
   Antwortreihenfolge (beweist Auswahl nach Inhalt); `frame: ""`/`frame: 3` ⇒
   `invalid_params` ohne Injektion.
   Proof: `node --test test/extension.test.js --test-name-pattern read`.

5. **Bridge: `frame` für `read`.** In `bridge/mcp.mjs`: `frame: {type: "string",
   minLength: 1}` hinter `mode` vor `tab`; `READ_ARGUMENTS = ["offset",
   "maxChars", "mode", "frame", TAB_ARGUMENT]`; `UNEXPECTED_ARGUMENTS` nennt
   `frame`; `hasDeclaredReadArgumentTypes` prüft `typeof args.frame === "string"`;
   `FRAME_NOT_FOUND_CODE`/`FRAME_AMBIGUOUS_CODE`, `TOOL_TEXTS.FRAME_NOT_FOUND`/
   `FRAME_AMBIGUOUS` mit und ohne Details, Prüfung beider Codes **oben** in
   `extensionFailureText` (nur `read`; die übrigen vier in Spec 25).
   Fixture: `requestLine` hängt bei vorhandenem `frame` **`frame=yes`** an — nicht
   den Wert: die Fixture schreibt bewusst keine Adressen auf stderr, und der Hub
   loggt `frame` ebenfalls nicht.
   Tests: Schema- und Schlüsselordnungs-Pin für `tools[2]`, `frame: 1` ⇒
   `-32602`, beide Sätze über `BC_TEST_*_ANSWER` + `BC_TEST_ERROR_DETAILS`,
   Durchreichen über die `frame=`-Zeile der Fixture.
   Proof: `node --test test/mcp.test.js --test-name-pattern Frame`.

### What could go wrong

- **Kriterium 7 war als `frameId`-Vergleich nicht prüfbar** (MV2s
  `tabs.executeScript` liefert keine Rahmen-Kennung, `webNavigation` ist
  ausgeschlossen). Es ist jetzt auf das Prüfbare umgestellt: derselbe Filter,
  Auswahl nach Inhalt, das Ruhe-Paar des adressierten Rahmens.
- **`frame_not_found` bei `read` kostet die Wartezeit.** Die Ruhe-Wartezeit läuft
  vor der Lese-Injektion; ein falscher `frame` wartet also bis zu 3 s, bevor er
  ablehnt. Alternative wäre eine zweite Entscheidungsstelle — bewusst nicht.
- **Ein Rahmen, der nicht antwortet oder wirft.** `executeScript` mit
  `allFrames` ist eine Promise: scheitert ein Rahmen, fällt der Aufruf in den
  heutigen `catch` und antwortet `page_busy`/`not_readable` statt
  `frame_not_found`. `frameTargetOf` zählt deshalb nur Objekt-Einträge; die Zahl
  heißt in der Meldung „Rahmen, die geantwortet haben".
- **`matchAboutBlank` ist live-only.** Der Harness prüft nur, dass die Option
  mitgeht; ob Firefox damit in einen `about:blank`-Rahmen injiziert, entscheidet
  Kriterium 6. Wenn nicht, geht der `about:blank`-Satz der Spec zurück in die
  Spec.
- **Antwortfelder kommen aus dem Rahmen.** `click`/`type` antworten mit
  `url`/`title` des **Rahmens**, nicht des Tabs — ehrlich, aber eine
  Draht-Eigenschaft, die kein Kriterium entscheidet; Spec 25 hält sie im Kommentar
  fest.
- **Die Reihenfolge der `frames`-Liste ist keine Zusage.** Keine Sortierung
  einbauen, kein Test darf sie gegen den echten Browser pinnen (gegen den Stub
  schon).
- **Stub-Beweise, ehrlich benannt:** bewiesen werden Filter, Auswahl und
  Fehlerfälle gegen ein `location.href`-Fixture. Nicht bewiesen: echte
  Cross-Origin-Rahmen, `srcdoc`, verschachtelte Rahmen, Zeitverhalten bei zwanzig
  Rahmen — das trägt Kriterium 6.

### Ordering and dependencies

- 1 → 2 → 3 (Methode vor Werkzeug), 4 → 5 (Extension vor Bridge je Werkzeug),
  4 → 5.
- 2 und 3 hängen nicht an 4/5; wer nach Stufe 3 abbricht, hat ein zwölftes
  Werkzeug und keine Adressierung — ein sauberer Zwischenstand.
- Bis Stufe 5 läuft die Ruhe-Wartezeit noch im Hauptrahmen (bei `read` und `click`
  in einem Rahmen also an der falschen Stelle). Kein Kriterium der Stufen 1–6,
  aber in Stufe 4/6 als Kommentar benannt.
- `extension/manifest.json`, `bridge/{hub,websocket,http-transport}.mjs`,
  `extension/options.*` bleiben unangetastet; Register und Spec sind
  Orchestrator-Arbeit; Kriterium 6 ist die Betreiber-Messung nach dem Commit.

### What the next increment inherits

- **Eltern-Kind-Beziehung der Rahmen** fehlt: `browser_frames` nennt `href`/`top`,
  nicht wer in wem steckt. Eigene Spec.
- **Kein `frame` für `navigate`, `screenshot`, `focus`, `status`, `open_tab`,
  `close_tab`** (Non-goals). Ein Screenshot eines Rahmens ist eine eigene Frage.
- **Kein Index, kein Rückweg-Kommando, kein Selektor-Zugang** — bewusst.
- **`about:srcdoc` und gleichnamige `about:blank`-Rahmen bleiben mehrdeutig.**
  Wenn das stört, braucht es eine stabilere Kennung, nicht einen Index.
- **Ein einziger `frame`-Teilstring, keine Liste.** Ein `frame`-Array würde die
  Mehrdeutigkeitsregel neu aufmachen.
- **`injectPageCode` kennt jetzt zwei Modi** (`frameId: 0` / `allFrames`). Jede
  spätere Injektion muss den richtigen wählen; ein dritter Modus gehört in eine
  eigene Spec.


## Risiken

- **`frame: true`-Rahmen und `about:blank`.** Ein leerer Rahmen hat keine
  sinnvolle Adresse; mehrere davon sind nicht unterscheidbar und landen bei
  `frame_ambiguous`. Das ist ehrlicher als ein Index, der stillschweigend auf den
  falschen zeigt.
- **Injektion in alle Rahmen kostet.** `allFrames: true` heißt: ein Skript pro
  Rahmen, auch in solchen, die nie gemeint sind. Auf einer Seite mit zwanzig
  Rahmen ist das messbar; die Antwortzeit steht unter `## Messlauf`.
- **Ein Rahmen, der nie lädt** (hängen gebliebene Einbettung), antwortet nicht —
  die Fristen des Aufrufs gelten weiter, ein `frame_not_found` kann dann
  irreführen. Die Meldung nennt deshalb die Zahl der Rahmen, die geantwortet
  haben.
- **Adressen ändern sich.** Eine Single-Page-App kann die Adresse eines Rahmens
  nach dem Laden wechseln; der Teilstring aus `browser_frames` passt dann nicht
  mehr. Der Agent liest die Liste neu, statt zu raten.
- **Kinder von Kindern** werden mitgesammelt, aber `browser_frames` nennt keine
  Eltern-Kind-Beziehung — für die Adressierung ist das gleichgültig, für das
  Verständnis einer Seite nicht.

## Touch boundary

Angefasst: `extension/protocol.js`, `bridge/protocol.mjs` (eine Methode),
**zwei Specs aus `## Amendments to previous spec docs`** (`docs/05`, `20` — nachgezogen beim **Orchestrator**, weil `ranger-1` keine
Spec ändern darf), `docs/24-frames.md` selbst (Stufe 5 stellt sie auf `active`),
`extension/background.js`, `bridge/mcp.mjs`, `test/{protocol,extension,mcp,
http-mcp}.test.js`, `test/fixtures/fake-extension.mjs`, `docs/README.md`,
`docs/PROJECT-STATE.md`, `docs/ROADMAP.md`.

**Nicht** angefasst: `extension/manifest.json` (keine neue Berechtigung),
`bridge/{hub,websocket,http-transport}.mjs`, `extension/options.*`, `CONTRIBUTING.md`,
`INSTALL.md` und die übrigen Specs.

## Bekannte Lücken

Stand 2026-10-28, nach der Umsetzung:

- **`frames_failed` ist ein eigener Code**, den die Spec nicht nennt: er greift,
  wenn `browser_frames` an etwas anderem scheitert als einer Injektionsverweigerung
  (Storage verweigert, `tabs.get` wirft) **oder** wenn die Injektion keine Liste
  liefert. Die Bridge antwortet mit `CALL_EXTENSION_FAILED` und dem Code — sie
  erfindet keine Handlungsanweisung.
- **Zwei Spec-Regeln von `frameTargetOf` haben keinen Test:** „nur Objekt-Einträge
  zählen" und „höchstens fünf Kandidaten" — ein Mutationslauf (beide Deckel
  entfernt) bleibt grün.
- **`frame: ""` meldet den Typfehler** („frame muss ein String sein"), obwohl der
  Typ stimmt; richtig wäre „nicht-leerer String".
- **`url` einer Rahmen-Lesung ist die Rahmen-Adresse**, nicht die des Tabs —
  ehrlich, aber nur für die Handlungswerkzeuge in der Spec vermerkt.
- **Kriterium 6 ist gemessen** (2026-10-29, `## Messlauf`): `about:blank`-Rahmen
  stehen in der Liste und sind damit injizierbar, die Ruhe-Erkennung läuft im
  adressierten Rahmen (`settled: true`, `waitedMs: 999` gegen `settled: false` im
  Hauptrahmen).
- **Zwei Zahlen für „wie viele Rahmen":** `frame_not_found` nennt 55 antwortende
  Rahmen, `browser_frames` listet 9 (dieselbe Seite). `details.frames` zählt
  Objekt-Einträge der Injektion, `count` die gefilterte Liste — ehrlich, aber
  nebeneinander gestellt verwirrend. Gehört in eine eigene Spec.
- **Kein adressierbarer `about:blank`-Rahmen live erprobt** (immer mehrere auf
  den besuchten Seiten ⇒ `frame_ambiguous`).

Noch keine — das Inkrement ist nicht begonnen.

## Open questions

Keine offenen. Beantwortet vom Betreiber am 2026-10-27:

1. **URL-Teilstring** als Adresse — stabil, prüfbar, steht in `browser_frames`;
   kein Index (verschiebt sich beim Nachladen) und kein CSS-Selektor (beschreibt
   ein Element, nicht einen Rahmen).
2. **Eigenes Werkzeug `browser_frames`** als zwölftes — `browser_status` bleibt
   schlank.
3. **`frame` für `read`, `click`, `type`, `inspect`, `eval`**; `navigate`,
   `focus`, `screenshot`, `status`, `open_tab`, `close_tab` bleiben Tab-Werkzeuge.

## Messlauf

Noch keine Messung — Kriterium 6 ist live und nach dem Commit zu messen.
Eingetragen werden: die Seite, die Zahl der Rahmen aus `browser_frames`, der
`frame`-Teilstring, `chars` aus `read` im Rahmen und ohne `frame` (Hauptrahmen),
die Antwortzeit mit und ohne `frame`, und ob ein `about:blank`-Rahmen adressierbar
war.

## Review

### Runde 3, 2026-10-27 — `🔧 Fix these`, Blocker: ja (D1–D3) → **Teilung**

C1–C8 saßen bis auf zwei Reste: `browser_frames` hätte im Fehlerfall den
`status`-Satz gesprochen (D1, jetzt Bridge-Zweig + drei Testfälle), ein letztes
„durchsuchten" (D2), und `docs/05:220` trug weiter „Elf Werkzeuge" (D3).

Weil das der **dritte** Block war, greift `CONTRIBUTING.md` Schritt 4: die Spec ist
geteilt. `browser_frames` und `frame` für `read` bleiben hier (Stufen 1–5,
Kriterien 1–7); `frame` für `click`/`type`/`inspect`/`eval` und die
Ruhe-Erkennung im adressierten Rahmen sind **Spec 25**
(`docs/25-frame-handeln.md`).

### Runde 4, 2026-10-28 — `🔧 Fix these`, Blocker: ja (E1–E6)

Die Teilung war zur Hälfte ausgeführt: Kriterien und Stufen sauber beschnitten,
der Fließtext erzählte weiter vom Fünf-Werkzeug-Inkrement (E1), Amendments und
Boundary beanspruchten die vier Dateien, die zu Spec 25 gehören (E2),
`## Ziel`/`## Non-goals` nannten Spec 25 nicht (E3), die Ruhe-Erkennung für `read`
hatte einen Test aber keine Stufe mehr (E4), Verweise auf Stufen 6/7 und
„Kriterium 7" hingen (E5), und die datierte Ausnahme zeigte auf ein
„Kriterium 8", das es nicht gibt (E6). Alle sechs übernommen.

**Runde 1, 2026-10-27 — `🔧 Fix these`, Blocker: ja** (Befunde B1–B12, drei gering).

Der Plan ist tragfähig, und die Umstellung von Kriterium 7 auf das Prüfbare ist
richtig (MV2s `tabs.executeScript` liefert keine Rahmen-Kennung, `webNavigation`
ist ausgeschlossen) — die Ersatzprüfung (derselbe Filter, Auswahl nach Inhalt,
Ruhe-Paar des adressierten Rahmens) ist mit Stufe 5 entscheidbar.

Blockierend waren vier Stellen, die der Umsetzer sonst selbst entscheiden müsste:
(1) Spec 24 widersprach `docs/05:48`, `06:54`, `19:81,442` und den „Elf
Werkzeuge"-Zeilen, ohne dass Amendments oder Boundary das Nachziehen beauftragen
(B1); (2) die Position des Frame-Guards war nicht festgelegt — bei
`click`/`type`/`eval` hieße das „wirkt in jedem Rahmen" (B2); (3) „Frame-Fehler
kommen vor der eigentlichen Arbeit" widersprach dem Plan-Catch, in dem
`page_busy` gewinnt (B3); (4) Stufe 5 machte aus der Wächter-Frist (`undefined`)
und `SUPERSEDED_SETTLE` einen `frame_not_found`, und die `…Of(results)`-Konsumenten
erwarten ein Array, keinen Eintrag (B4, B5). Dazu `about:blank`: versprochen,
braucht `matchAboutBlank` (stand nur im Plan) und war von keinem Kriterium
entschieden (B7).

Gering: `## Messlauf` fehlte (B6), zwei Zahlen hießen beide „Rahmen" (B8), die
Fixture hätte eine Rahmen-Adresse auf stderr geschrieben (B9), Kriterium 1
behauptete `frameId: 0` für fünf Werkzeuge und war für eins gepinnt (B10), `runAt`
fehlte im `allFrames`-Zweig (B11), und „beide tragen Zahlen in der Meldung" stimmte
für `frame_ambiguous` nicht (B12).

### Runde 2, 2026-10-27 — `🔧 Fix these`, Blocker: ja (C1)

Elf der zwölf Befunde aus Runde 1 sind an der Stelle geprüft und sitzen: B2 (Guard
als erste Anweisung, plus Testing-Zeile), B3 (Rangfolge: Injektionsfehler
gewinnen), B4 (SUPERSEDED → NO_SETTLE → Auswahl; `want === null` wirft nie), B5
(vollständige Konsumentenliste, „Eintrag statt Array", `Array.isArray` bei `eval`
davor), B6, B7 (`matchAboutBlank` als Option in Non-goals und Stufe 2, `runAt` in
beiden Zweigen), B8 (`count`/`details.frames` = geantwortete Rahmen), B9, B10, B11,
B12. Die Amendments-Tabelle ist vollständig, die Zeilenangaben stimmen in allen
sechs Dateien; `#reportResult` schreibt für eine unbekannte Methode wirklich
nichts.

Geblieben war B1 zur Hälfte: die Touch boundary führte die Amendments-Dateien
weiter unter „nicht angefasst" und verbot damit, was die Amendments-Tabelle
verlangt (C1). Dazu ein Naht-Fehler in der Stufenreihenfolge — Stufe 4 stellt
`settleOutcomeOf` auf einen Eintrag um, der einzige Aufrufer kommt erst in Stufe 5
dran (C3) — und `browser_frames` ohne Fehlerfälle (C6).

Minors: „durchsuchte Rahmen" gegen „Rahmen, die geantwortet haben" (C2), die
falsche Pin-Aussage zu `read`/`inspect` (C4), das fehlende `FramesError` (C5), der
Verweis auf Kriterium 6 statt `## Messlauf` (C7), die fehlende Register-Zeile (C8).

## Log

Noch keine Befunde.

Runde 1 des Spec-Reviews — alle zwölf Befunde übernommen:

- **B1** (Widerspruch zu fünf aktiven Specs ohne Nachzieh-Auftrag) — übernommen:
  `## Amendments to previous spec docs` nennt `docs/05`, `06`, `07`, `09`, `19`,
  `20` mit Stellen; die Touch-Boundary nennt dieselben Dateien.
- **B2** (Position des Frame-Guards unbestimmt) — übernommen: „Der Filter ist die
  erste Anweisung jedes Schnipsels", plus Testing-Zeile, dass der nicht adressierte
  Rahmen unverändert bleibt.
- **B3** (Fehlerrangfolge widersprüchlich) — übernommen: Injektionsfehler
  (`no_agent_tab`, `page_busy`, `not_readable`) gewinnen; `frame_not_found`/
  `frame_ambiguous` gelten nur für Rahmen, die geantwortet haben.
- **B4** (Stufe 5 machte die Wächter-Frist zum `frame_not_found`) — übernommen:
  Reihenfolge ausgeschrieben (SUPERSEDED → NO_SETTLE → Auswahl), `frameTargetOf`
  wirft bei `want === null` nie.
- **B5** (die `…Of(results)`-Konsumenten indizieren selbst `results[0]`) —
  übernommen: vollständige Liste (settle/page/click/type/inspect/eval) und der
  Vertrag „Eintrag statt Array"; `Array.isArray` bleibt bei `eval` vor der Auswahl.
- **B6** (`## Messlauf` fehlte) — Abschnitt angelegt.
- **B7** (`about:blank` brauchte `matchAboutBlank`, das nur im Plan stand) —
  übernommen: in `## Non-goals` als **Option** (keine Berechtigung) und in Stufe 2.
- **B8** (zwei Zahlen hießen „Rahmen") — übernommen: `count` und
  `details.frames` meinen „Rahmen, die geantwortet haben"; ein Eintrag ohne
  brauchbare `href` fällt aus beiden.
- **B9** (Fixture hätte Adressen geloggt) — übernommen: `frame=yes`.
- **B10** (`frameId: 0` nur für `read` gepinnt) — übernommen: je eine Zusicherung
  für `click`, `type`, `inspect`, `eval` in Stufe 6.
- **B11** (`runAt` fehlte im `allFrames`-Zweig) — übernommen.
- **B12** („beide tragen Zahlen") — übernommen: `details.frames` bzw.
  `details.candidates`.

Runde 2 des Spec-Reviews — alle acht Befunde übernommen:

- **C1** (Boundary verbot die Amendments-Dateien) — übernommen: die sechs Specs und
  `docs/24` selbst stehen unter „Angefasst", mit dem Hinweis, dass der Orchestrator
  sie nachzieht.
- **C2** (zwei Zahlen unter dem Namen „Rahmen") — übernommen: überall „die
  geantwortet haben".
- **C3** (Naht Stufe 4/7: `settleOutcomeOf` liest selbst `results[0]`, sein
  Aufrufer kommt erst in Stufe 5) — übernommen: `settleAgentTab` reicht hinter dem
  `undefined`-Wächter `winner[0]` weiter, der Filter kommt in Stufe 5.
- **C4** (falsche Pin-Aussage: `inspect` ist schon gepinnt, `read`s Pin sitzt auf
  `scriptCalls[1]`) — übernommen, mit Index je Werkzeug.
- **C5** (`FramesError` existierte nicht, Stufe 2 braucht es) — übernommen: neu in
  Stufe 2.
- **C6** (`browser_frames` ohne Fehlerfälle) — übernommen: erbt
  `no_agent_tab`/`page_busy`/`not_readable`, plus Testing-Zeile.
- **C7** (Verweis auf Kriterium 6 für die Antwortzeit) — übernommen: `## Messlauf`.
- **C8** (Register-Zeile fehlte) — übernommen.

Runde 4 des Spec-Reviews — alle sechs Blocker übernommen: Prosa auf `read`
durchgezogen (E1), Amendments und Boundary auf `docs/05`/`docs/20` reduziert und
`docs/05:222` ergänzt (E2), Spec-25-Verweis in `## Ziel`/`## Non-goals` (E3), die
Ruhe-Erkennung für `read` in Stufe 4 verlegt (E4), Stufen-/Kriteriumsverweise
bereinigt (E5), Live-Kriterium von 8 auf 6 korrigiert (E6).
