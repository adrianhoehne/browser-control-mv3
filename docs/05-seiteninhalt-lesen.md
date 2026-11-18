---
description: Der Agent darf lesen — die Extension bekommt mit <all_urls> Zugriff auf Seiteninhalte und liefert über browser_read Titel, URL und den Text des Agenten-Tabs (sichtbarer Text, sonst Textinhalt, mit via gekennzeichnet); Klicken und Tippen bleiben ausdrücklich draußen.
status: active
---

# Seiteninhalt lesen (`browser_read`)

Mit `browser_navigate` kann der Agent eine Seite öffnen, aber nicht sagen, was
darauf steht. Dieses Inkrement gibt ihm die Augen — und dafür die erste breite
Berechtigung im Projekt.

**Der Betreiber hat am 2026-10-23 entschieden: `<all_urls>`.** Nicht
`activeTab` (das setzt einen Klick des Menschen voraus und wäre für einen Agenten
wertlos) und keine Positivliste (die müsste jemand pflegen). Damit kann die
Extension **jede** Seite im Default-Container lesen — auch die, in der der
Betreiber eingeloggt ist. Das ist die bewusste Entscheidung dieses Inkrements und
steht unter `## Sicherheit`, nicht in einer Fußnote.

## Ziel

`browser_read` liefert für den Agenten-Tab
`{tabId, url, title, text, offset, chars, totalChars, truncated, via, mode}`:
den Titel, die Adresse und den Text der Seite (sichtbarer Text; liefert die
Seite keinen, ihren Textinhalt), auf eine feste Länge
gekürzt. Im Artikelmodus (`mode: "article"`) kommen `root` und `fellBack` dazu
(Spec 23), im Textmodus fehlen sie. Der Agent kann damit eine Seite beurteilen,
ohne dass jemand ein Screenshot ansieht.

Gelesen wird der **Agenten-Tab**, nicht „irgendein Tab": der Agent liest, was er
selbst geöffnet hat, nicht was der Betreiber gerade ansieht. Gibt es keinen
Agenten-Tab, ist das eine klare Fehlermeldung und kein Zugriff auf ein
Ersatzfenster.

## Non-goals

- **Kein Klicken, Tippen, Scrollen.** `click`, `type`, `focus` sind ein eigenes
  Inkrement: sie brauchen Selektoren, Sichtbarkeitsprüfungen und eine Antwort auf
  die Frage, was passiert, wenn das Ziel verschwindet.
- **Kein Screenshot.** Binärdaten durch den WebSocket (1-MiB-Grenze) und
  MCP-Bildinhalt sind ein eigener Transport-Schnitt.
- **Keine Zusammenfassung, kein Modell.** Ausgegeben wird der Seitentext;
  `mode: "article"` wählt daraus mit einer Heuristik über das DOM einen
  Artikelkörper und lässt Navigation, Fußzeile und Cookie-Banner weg (Spec 23).
  Das ist eine **Auswahl**, keine Zusammenfassung: der Text bleibt der Text der
  Seite, nur ein Ausschnitt davon. Vendoring von Readability.js bleibt
  ausgeschlossen (Betreiberentscheidung vom 2026-10-27) — die Heuristik ist
  unsere, mit ihren eigenen Fehlern, und `root`/`fellBack` machen sie sichtbar.
- **Keine Frames.** Nur der Hauptrahmen (`frameId: 0`); iframes und Shadow DOM
  bleiben ungelesen.
- **Kein Lesen fremder Tabs**, kein `getSelection`, kein Auslesen von Formular-
  feldern oder Cookies (die Extension liest den DOM, nicht den Cookie-Jar).
- Keine Änderung an `status`/`navigate`, am stdout-Vertrag oder an den Zeitgrenzen.

## Berechtigung

`extension/manifest.json` bekommt in `permissions` den Eintrag `<all_urls>`:
`["tabs", "storage", "<all_urls>"]`. Unter MV2 sind Wirtsrechte Teil von
`permissions`; `host_permissions` gibt es dort nicht (der bestehende Test prüft
das weiter und bleibt richtig).

Folge, die im Bericht stehen muss: **der Test
`permissions_afterTheSwitchToMV2_shouldStillBeTabsAndStorage` muss geändert
werden.** Er pinnt heute `["tabs","storage"]`; genau dafür wurde er in Spec 02
geschrieben („wer das ändert, ändert es bewusst"). Er heißt künftig nach dem, was
er prüft, und prüft drei Einträge. Der zweite Manifest-Test
(`manifest_underMV2_shouldNotDeclareHostPermissions`) bleibt unverändert grün.

## Wire-Protokoll (neu: `read`)

`PROTOCOL.METHODS` bekommt `READ: "read"`. Anfrage:

```json
{"type":"request","id":3,"method":"read","params":{}}
```

Die Extension liest den gespeicherten Agenten-Tab (`agentTabId`, wie bei
`navigate`) und antwortet:

```json
{"type":"response","id":3,"ok":true,
 "result":{"tabId":23,"url":"https://example.org/","title":"Example Domain",
           "text":"Example Domain\n\nThis domain is for use in illustrative examples…",
           "truncated":false,"via":"innerText","mode":"text"}}
```

**`via` sagt, woher der Text kommt.** `innerText` respektiert das Rendering —
Seiten, die ihren Body erst beim Hochfahren sichtbar machen (YouTube und viele
andere SPAs), liefern daraus **nichts**, und ein leeres `text` sähe aus wie „die
Seite ist leer". Deshalb: beide Quellen werden **erst normalisiert, dann verglichen** — ist der
normalisierte `innerText` leer und der normalisierte `textContent` nicht, wird
`textContent` genommen und `via: "textContent"` gesetzt; sonst
`via: "innerText"`. **Vor dem `textContent` fliegen `script`, `style` und
`noscript` aus einer Kopie des Bodys** (`template` steht bewusst nicht dabei:
die Kinder eines `<template>` liegen in `.content`, `textContent` ist dort
leer — der Name könnte nichts beitragen) — sonst liefert
ausgerechnet eine Seite, die noch lädt, die Inline-Skripte ihres Bootstraps
(bei YouTube gemessen: 20 000 Zeichen `if (window.ytcsi) {…}` statt Text). (Ein `textContent`, das nur aus Skript- und Leerraum-Resten
besteht, ist nach der Normalisierung leer und zählt damit nicht — sonst stünde
`via: "textContent"` über einem leeren `text`.) Die 20 000-Zeichen-Grenze gilt
für den gewählten Text, nie für eine Verkettung. Der Preis steht
unter `## Risiken`: `textContent` enthält auch, was nicht sichtbar ist.

- **Kein Agenten-Tab** (nichts gespeichert, Tab weg, oder nicht mehr im
  Default-Container): `ok:false`, `code:"no_agent_tab"`.
- **Seite nicht lesbar** (`executeScript` scheitert — `about:`-Seiten, PDF-Viewer,
  interne Seiten, `view-source:`): `ok:false`, `code:"not_readable"`.
- **Eigener Fehler** (der injizierte Code liefert kein brauchbares Objekt):
  `ok:false`, `code:"read_failed"` und eine `console.warn`-Zeile — damit bleibt
  „Seite kann nicht" von „wir sind kaputt" getrennt.
- **Text-Normalisierung**: `document.body.innerText`, bei leerem Ergebnis
  `document.body.textContent` (siehe `via` oben; ohne Body sind beide `""`),
  Zeilenumbrüche vereinheitlicht, Zeilen getrimmt, Leerzeilen
  zusammengefasst, Leerraum innerhalb einer Zeile auf ein Zeichen.
- **`mode` wählt den Text, nicht die Form der Antwort**: `"text"` (Default,
  auch beim Weglassen) liest die ganze Seite wie oben; `"article"` liest nur den
  Artikelkörper. `root` nennt dann die getroffene Wurzel (`article`, `main`,
  `[role="main"]`, `#content`, `#main`, `density`) oder ist `null`, und
  `fellBack: true` heißt „nichts Brauchbares gefunden — das hier ist die ganze
  Seite". Im Textmodus fehlen `root` und `fellBack` **ganz** — kein `null`, kein
  `false`, das etwas behauptet; eine Seitenantwort, die sie dort setzt, ist
  `read_failed`. Ein Modus, den die Extension nicht kennt, ist `invalid_params`,
  bevor irgendetwas injiziert wird: den **Typ** prüft die Bridge (`-32602`), den
  **Namen** die Extension.
- **Fenster statt Wand**: `maxChars` ist die Höchstzahl *gelieferter* Zeichen
  (Default 20 000, Grenzen 1 … 100 000), `offset` die Zahl der übersprungenen Zeichen
  des normalisierten Textes (Default 0, ganze Zahl `≥ 0`). Beide sind optional; ohne
  sie verhält sich `read` wie vor Spec 22. Beide gelten auf dem Text, den `mode`
  liefert — im Artikelmodus also auf dem gefilterten Artikeltext, mit derselben
  Bedeutung von `truncated` und `offset_out_of_range` (`offset > totalChars`).
  Geschnitten wird **in der Seite**: der
  ganze Text verlässt den Content-Prozess nie. Die Antwort nennt deshalb den
  angewandten `offset`, die Länge `chars` des Ausschnitts und die Gesamtlänge
  `totalChars` des ganzen normalisierten Textes. `truncated: true` heißt
  `offset + chars < totalChars` — „nach diesem Ausschnitt kommt noch Text", und
  `offset + chars` ist genau die Stelle, an der der nächste Aufruf weiterliest. Ohne
  Kürzung ist `truncated` auch dann `false`, wenn der Text exakt ins Fenster passt.
- `url` und `title` stammen aus dem DOM der Seite (`location.href`,
  `document.title`), nicht aus dem Tab-Objekt: nach Weiterleitungen durch
  JavaScript ist das Tab-Objekt die ungenauere Quelle. **Beide werden gekappt** —
  `url` auf 2 048, `title` auf 1 024 Zeichen —, weil eine Seite ihren Titel
  beliebig setzen darf und ein Frame über 5 MiB die Verbindung mit `1009`
  beenden würde (`bridge/websocket.mjs`); dann stünde der Aufruf als „keine
  Extension" da.
- Gelesen wird mit `browser.tabs.executeScript(tabId, {code, runAt: "document_idle"})`
  und `frameId: 0`. **`document_idle` heißt „erst wenn die Seite ruhig ist"** —
  ist sie es noch nicht (etwa nach einem `navigate`, das mit `complete: false`
  geantwortet hat), schiebt Firefox die Injektion auf. Obergrenze ist die
  Zeitgrenze der Bridge (`PROTOCOL.CALL_TIMEOUT_MS`, per `BC_CALL_TIMEOUT_MS`
  änderbar, 20 s); läuft sie ab, kommt der
  Überschreitungssatz und kein halber Text. `read` liest also **nicht**
  zwangsläufig „den Stand von jetzt", sondern den Stand, wenn die Seite ruht.

## MCP-Werkzeug

| Feld | Wert |
|---|---|
| `name` | `browser_read` |
| `description` | Liest Titel, Adresse und den Text des Agenten-Tabs (standardmäßig 20 000 Zeichen; `offset`/`maxChars` blättern, `chars`/`totalChars` sagen, wo man steht); `via` sagt, ob sichtbarer Text oder Textinhalt; `mode: article` liest nur den Artikelkörper — ohne Navigation, Fußzeile und Cookie-Banner. |
| `inputSchema` | `{"type":"object","properties":{"offset":{"type":"integer","minimum":0},"maxChars":{"type":"integer","minimum":1,"maximum":100000},"mode":{"type":"string","enum":["text","article"]},"tab":{"type":"integer","minimum":1}},"additionalProperties":false}` |

`tools/call`:

- **Erfolg**: `{"content":[{"type":"text","text":"<JSON, 2 Leerzeichen eingerückt>"}]}`.
- **Argument übergeben**: `{"content":[{"type":"text","text":"browser_read
  erwartet nur `offset`, `maxChars`, `mode` und `tab`."}],"isError":true}` (Präzedenz aus
  Spec 03). Ein Argument mit falschem Typ ist dagegen ein Protokollfehler
  (`-32602`, weil das Schema `integer` bzw. `string` sagt); die *Bereiche* und den
  *Enum-Wert* von `mode` prüft die Extension und antwortet `invalid_params`, ohne zu
  injizieren.
- **`no_agent_tab`**: `{"content":[{"type":"text","text":"Kein Agenten-Tab —
  zuerst browser_navigate aufrufen."}],"isError":true}`.
- **`not_readable`**: `{"content":[{"type":"text","text":"Diese Seite kann die
  Extension nicht lesen (interne Seite oder Sonderformat)."}],"isError":true}`.
- **keine Extension / Zeitüberschreitung**: dieselben zwei Sätze wie bisher.
- **`offset_out_of_range`**: eigener Satz mit den Zahlen aus der Meldung der
  Extension („Der Text hat 87314 Zeichen; offset 999999 liegt dahinter.") —
  `read` fällt dafür **nicht** auf den allgemeinen Satz zurück.
- **`invalid_params`**: eigener Satz mit der Meldung der Extension („Der
  Parameter ist ungültig: maxChars muss eine ganze Zahl von 1 bis 100000 sein.");
  ohne brauchbare Meldung derselbe Satz ohne Zusatz. `read` fällt dafür **nicht**
  auf den allgemeinen Satz zurück.
- **anderer Code**: `"Die Extension konnte die Anfrage nicht ausführen
  (code=<code>)."` — derselbe Satz, den `browser_navigate` schon nutzt; er wird
  als `TOOL_TEXTS.CALL_EXTENSION_FAILED(code)` geführt und von beiden Werkzeugen
  verwendet (kein zweiter Schlüssel mit gleichem Wortlaut).

## Hub

Keine strukturelle Änderung: `request(method, params)` aus Spec 04 trägt die
dritte Methode. Erfolgreiche `read`-Anfragen bekommen eine Logzeile
`read tab=<id> url=<url> chars=<n> truncated=<true|false> via=<innerText|textContent>` (kein Seitentext —
Logzeilen bleiben kurz und enthalten keine Inhalte des Betreibers). Bei
`BC_LOG=debug` wird ebenfalls **nicht** das Ergebnis geschrieben, sondern der
Block aus `DEBUG_WHITELIST` (`bridge-rs/src/hub.rs`): je Werkzeug nur die dort
eingetragenen Felder, Seiteninhalt als Länge (`text`, `title` ⇒ `"<n chars>"`),
alles Ungelistete als `"<unlisted field>"`. Sonst läge der Seiteninhalt des
Betreibers auf stderr, was `## Touch boundary` verbietet. `status` und `navigate`
zeigen damit ebenfalls eine Whitelist statt des ganzen Ergebnisses.
(Nachgezogen 2026-11-18 mit Spec 28: hier stand eine Sperrliste für `text` und
der Satz „das ist der Unterschied zu `status` und `navigate`".)

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `test/protocol.test.js` — `METHODS.READ` | Steht wörtlich in beiden Kopien der Konstanten (`extension/protocol.js`, `bridge/protocol.mjs`) |
| `test/manifest.test.js` — `permissions` | Enthält `tabs`, `storage` und `<all_urls>`; `host_permissions` existiert weiterhin nicht |
| `test/extension.test.js` — `read` ohne gespeicherten Agenten-Tab | `ok:false`, `no_agent_tab`, **kein** `executeScript` |
| dito — gespeicherter Tab existiert nicht mehr (`tabs.get` wirft) | `no_agent_tab`, kein `executeScript` |
| dito — `executeScript` wirft (interne Seite) | `ok:false`, `not_readable` |
| dito — `executeScript` liefert `[undefined]` bzw. ein Objekt ohne `text` | `ok:false`, `read_failed`, `console.warn` **ohne** Inhalt — und **nicht** `not_readable` |
| dito — normale Seite | `url`/`title` aus dem DOM, `text` normalisiert (Leerzeilen zusammengefasst), `truncated: false`, `frameId: 0` in den `executeScript`-Details |
| dito — Seite mit überlangem `title` (5 000 Zeichen) | `title` auf 1 024 Zeichen gekürzt, `url` auf 2 048 |
| dito — Text über 20 000 Zeichen | `text` endet bei 20 000 Zeichen, `truncated: true` |
| dito — Text mit genau 20 000 Zeichen | `truncated: false` (die Grenze ist „mehr als", nicht „mindestens") |
| dito — Seite ohne Body | `text: ""`, kein Fehler, `via: "innerText"` |
| dito — Seite, deren `innerText` leer ist, `textContent` aber nicht (SPA-Muster) | `text` aus `textContent`, `via: "textContent"` |
| dito — Body, der nur aus `<script>` besteht (YouTube-Muster beim Laden) | `text: ""`, `via: "innerText"` — die Skripte werden **nicht** als Text ausgegeben |
| dito — `<script>` neben echtem Text | `via: "textContent"`, und im Ergebnis steht der Text, **nicht** der Skriptinhalt |
| dito — `<style>`/`<noscript>` neben echtem Text | `via: "textContent"`, weder CSS noch `noscript`-Inhalt im Ergebnis |
| dito — sichtbarer Text vorhanden | `via: "innerText"`, und der Body wird **nicht** für den Rückfall kopiert |
| dito — Seite mit sichtbarem Text | `via: "innerText"` |
| `test/hub.test.js` — erfolgreiche `read`-Antwort | Logzeile `read tab=… url=… chars=… truncated=… via=…`; der Seitentext steht **nicht** in der Logzeile |
| `test/mcp.test.js` — `tools/list` | Dreizehn Werkzeuge (elf bis Spec 24, dreizehn ab Spec 32); `browser_read` mit `offset`/`maxChars`/`mode`/`frame`/`tab` (Reihenfolge wie im Schema) und `additionalProperties:false` |
| dito — `browser_read` mit Fake-Extension | Text ist JSON mit den **sechs** Feldern, die die Fixture trägt (`tabId`/`url`/`title`/`text`/`truncated`/`via`); die Fensterfelder `offset`/`chars`/`totalChars` belegt `test/extension.test.js` (`read_withoutAWindow_shouldAnswerTheDefaultWindowFromTheStart`, `read_whenThePageReportsATooLargeTotalChars_shouldPassItThroughUnchanged`). `mode`/`root`/`fellBack` fehlen hier, weil die Fixture sie nicht trägt — die Bridge reicht die Leseantwort unverändert durch, also belegt dieser Fall die Durchreichung, nicht das Ankommen des Modus |
| dito — Argument übergeben | `isError:true`, „browser_read erwartet nur `offset`, `maxChars`, `mode`, `frame` und `tab`." |
| dito — Fixture antwortet `no_agent_tab` / `not_readable` | je `isError:true` mit dem passenden deutschen Satz |

## Acceptance criteria

1. `npm test; echo $?` → `0`, Ausgabe enthält `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. Von den 104 bisherigen Fällen laufen **102
   unverändert**; **zwei müssen sich ändern**, weil das Inkrement ihre
   Voraussetzung aufhebt:
   `permissions_afterTheSwitchToMV2_shouldStillBeTabsAndStorage` (pinnt heute
   `["tabs","storage"]`) und
   `mcp_toolsList_shouldOfferExactlyTheTwoToolsOfTheContract` (pinnt zwei
   Werkzeuge). **Der Nachtrag vom 2026-10-23 ändert fünf weitere Bestandsfälle**,
   weil er `via` in den Vertrag bringt: die gepinnte Werkzeug-Beschreibung in
   `test/mcp.test.js` (wörtlicher Vergleich), der Feldlisten-Fall dort
   (`…AllFiveFields…` → `…AllSixFields…`), die `read`-Logzeile in
   `test/hub.test.js` und zwei `via`-Zusicherungen in
   `test/extension.test.js`. Das sind **sechs betroffene Fälle mit sieben
   Änderungen** (der `toolsList`-Fall steht in beiden Gruppen); alle stehen mit
   Begründung im Bericht.
2. `tools/list` liefert drei Werkzeuge; `browser_read` hat ein leeres
   `properties` und `additionalProperties: false`.
3. Mit Fake-Extension liefert `browser_read` Text, der sich als JSON parsen lässt
   und `tabId`, `url`, `title`, `text`, `truncated`, `via` enthält.
4. `no_agent_tab` und `not_readable` kommen als `isError` mit den deutschen
   Sätzen an — nicht als Protokollfehler.
5. Eine Logzeile für `read` enthält **keinen** Seitentext (nur `tab`, `url`,
   `chars`, `truncated`, `via` — damit beim Abnahmelauf sichtbar ist, ob die
   Zeichen aus dem Rückfall kommen). Beleg: `test/hub.test.js`.
6. **Die Handgriffe des Betreibers**: Extension in `about:debugging` **neu
   laden** (das Manifest hat sich geändert — neue Berechtigung; Firefox fragt
   beim Laden nicht nach, weil es eine temporäre Erweiterung ist) und pi neu
   starten. Ohne den Reload antwortet der alte Background mit
   `unsupported_method`, und die MCP-Schicht macht daraus „Die Extension konnte
   die Anfrage nicht ausführen (code=unsupported_method)" — das ist kein Bug,
   sondern der fehlende Handgriff. Danach ruft der Orchestrator `browser_read`
   auf.

   **Beleg sind die Antwortfelder und die Logzeile mit `chars > 0` — nicht der
   Seitentext.** (`chars` steht seit Spec 22 sowohl in der Logzeile als auch im
   Werkzeug-Ergebnis; belegt ist es dort durch `test/extension.test.js`.) Der Inhalt der Seite des Betreibers wird **nicht** in den
   Bericht, nicht in `## Bekannte Lücken` und nicht in diese Spec kopiert; das
   verbietet `## Touch boundary`. Belegt werden Feldnamen, `tabId`, `truncated`
   und die Zeichenzahl.

   **Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 6
   ist erst nach den Handgriffen messbar. Kriterien 1–5 laufen vor dem Commit,
   Kriterium 6 danach; fällt es rot aus, wird vorwärts korrigiert und die rote
   Zeile steht mit Datum unter `## Bekannte Lücken`. Ist die **Kernannahme**
   widerlegt (der Agent bekommt den Seiteninhalt nicht), geht das Inkrement
   zurück in die Spec.

## Dev plan

1. **Wire-Konstante `read` auf beiden Seiten.** `bridge/protocol.mjs` und
   `extension/protocol.js`: `METHODS.READ: "read"` (beide Kopien im selben
   Schritt — `extensionProtocol_comparedToBridgeProtocol_shouldBeIdentical`
   vergleicht sie per `deepStrictEqual`). In `test/protocol.test.js` ein neuer
   Fall `extensionAndBridgeProtocols_methodsRead_shouldBothSpellItOutLiterally`,
   gebaut wie der vorhandene `navigate`-Fall (der Vergleich der beiden Kopien
   bleibt grün, wenn *beide* den Schlüssel nicht haben).
   Proof: `node --test --test-reporter=tap test/protocol.test.js | grep -E '^# (pass|fail)'`
   → `# fail 0`, `# pass 4` (vorher 3). **Completed 2026-10-23**
2. **Manifest-Berechtigung, Test zuerst rot.** In `test/manifest.test.js`
   `permissions_afterTheSwitchToMV2_shouldStillBeTabsAndStorage` umbenennen zu
   `permissions_afterTheReadIncrement_shouldBeTabsStorageAndAllUrls` und
   `deepStrictEqual(MANIFEST.permissions, ["tabs", "storage", "<all_urls>"])`
   prüfen (Kommentar „wer das ändert, ändert es bewusst" bleibt).
   `manifest_underMV2_shouldNotDeclareHostPermissions` bleibt unverändert. Dann
   `extension/manifest.json`: `"permissions": ["tabs", "storage", "<all_urls>"]`.
   Proof: vor dem Manifest-Schnitt
   `node --test --test-reporter=tap test/manifest.test.js | grep '^# fail'` →
   `1`; danach `0`. **Completed 2026-10-23**
3. **`read` in der Extension samt injiziertem Code.** `extension/background.js`:
   `TEXT_LIMIT = 20000`; `NO_AGENT_TAB_CODE`, `NOT_READABLE_CODE`,
   `READ_FAILED_CODE`; `class ReadError` (Muster: `NavigateError`); Zweig in
   `answerRequest`; `answerRead`/`readErrorFor` (Muster:
   `answerNavigate`/`navigateErrorFor`); `readAgentTabPage()` =
   `readAgentTabId()` + `findDefaultContainerTab()` → `null` ⇒ `no_agent_tab`
   **ohne** `executeScript`, sonst
   `browser.tabs.executeScript(tabId, {code: READ_PAGE_CODE, runAt: "document_idle", frameId: 0})`.

   Der Rückweg: `READ_PAGE_CODE` entsteht aus einer echten Funktion, die per
   `toString()` in den Seitenkontext wandert und die Grenze als Argument
   bekommt — kein Closure über Modulzustand:

   ```js
   function readPageSource(limit) { /* normalisiert, schneidet, liefert {url, title, text, truncated} */ }
   const READ_PAGE_CODE = `(${readPageSource.toString()})(${TEXT_LIMIT})`;
   ```

   Reihenfolge **im injizierten Code**: `document.body ? String(body.innerText) : ""`
   → `\r\n?` → `\n` → je Zeile `[^\S\n]+` → `" "` und `trim()` → `\n{2,}` → `\n\n`
   → Gesamt-`trim()` → `text = normalised.slice(0, limit)`,
   `truncated = normalised.length > limit` (bei exakt `limit` also `false`). Der
   `slice` passiert **in der Seite**: der rohe `innerText` einer riesigen Seite
   verlässt den Seitenprozess nie; über den Draht gehen höchstens 20 000 Zeichen
   (≤ 60 kB UTF-8, mit JSON-Escapes ≤ ~120 kB) gegen
   `PROTOCOL.MAX_MESSAGE_BYTES` = 5 MiB; `url` und `title` sind zusätzlich
   gekappt. `innerText` ist nicht billig (erzwingt
   Layout) — deshalb keine Vorabkürzung des rohen Textes: die würde `truncated`
   am Rand falsch setzen.

   `executeScript`-Ablehnungen: nur der `await` steht im `try`; **jede**
   Rejection ⇒ `not_readable` (Firefox' Fehlertexte für `about:`,
   `view-source:`, AMO, PDF-Viewer sind kein Vertrag und werden nicht geparst).
   **`executeScript` löst mit einem Array auf** (ein Eintrag je Frame), also wird
   `results[0]` geprüft: `undefined`/`null`/kein Objekt ⇒ **`read_failed`**
   (nicht `not_readable` — „die Seite gibt nichts her" und „wir sind kaputt"
   sehen für den Aufrufer gleich aus, aber nur einer davon ist unser Fehler und
   soll als solcher geloggt werden). Ein
   **Objekt mit fehlenden oder falschen Feldern** (`text` kein String, `url`
   fehlt) ist dagegen der eigene Bug: `READ_FAILED_CODE`, `console.warn` mit
   `bc: read result without usable text` (nie der Inhalt), und die MCP-Schicht
   antwortet über ihren „anderer Code"-Zweig.

   `url` und `title` kappt **der injizierte Code** (`slice(0, 2048)` bzw.
   `slice(0, 1024)`) — nicht die Bridge: sonst wäre der Frame schon zu groß.

   `test/extension.test.js`: `createTabsStub` bekommt die Option `executeScript`
   plus Aufzeichnung `scriptCalls` (`{tabId, details}`); der Standard führt den
   übergebenen String per `vm.runInNewContext(code, {document: {body: {innerText}, title}, location: {href}})`
   mit `filename: "injected:read-page"` gegen eine winzige, im Test erfundene
   Seite aus — so prüfen die Fälle den **echten** injizierten Code, nicht sein
   Echo. **Der Rückgabewert wird in die Test-Realm zurückgeholt**
   (`JSON.parse(JSON.stringify(...))`), sonst scheitert `deepStrictEqual` an den
   Prototypen zweier `vm`-Realms — dieselbe Falle wie in Spec 01. `executeScript`
   liefert ein **Array** mit einem Eintrag; die Fälle prüfen
   `scriptCalls[0].details.frameId === 0`. Neufälle aus `## Testing`,
   deckungsgleich mit der Tabelle: kein gespeicherter Tab (`no_agent_tab`,
   `scriptCalls.length === 0`), gespeicherter Tab weg (`tabs.get` wirft ⇒
   `no_agent_tab`), `executeScript` wirft ⇒ `not_readable`, `executeScript`
   liefert `[undefined]` bzw. ein Objekt ohne `text` ⇒ `read_failed` mit
   `console.warn`, normale Seite (`url`/`title` aus dem DOM, Leerzeilen
   zusammengefasst, `truncated: false`, `frameId: 0`), überlanger `title`
   (5 000 Zeichen ⇒ 1 024, `url` ⇒ 2 048), `innerText` mit 20 001 Zeichen
   (`text.length === 20000`, `truncated: true`), genau 20 000
   (`truncated: false`), Seite ohne Body (`text: ""`, kein Fehler).
   Proof: `node --test --test-reporter=tap test/extension.test.js | grep -E '^# (pass|fail|cancelled)'`
   → `# fail 0`, `# cancelled 0`. **Completed 2026-10-23**
4. **Hub-Logzeile.** `bridge/hub.mjs`: `formatReadLine(result)` direkt neben
   `formatNavigateLine` — defensiv wie diese, `chars` entsteht **im Formatierer**
   aus `result.text.length` (`?` bei fehlendem/nicht-String-Text), `truncated`
   nur `true`/`false`. `#reportResult` bekommt den dritten Zweig
   (`if (entry.method === PROTOCOL.METHODS.READ) { this.#reportRead(result); return; }`)
   — drei `if`s und drei Formatierer sind die Tabelle; eine Map wird erst
   sinnvoll, wenn ein viertes Werkzeug kommt. `#reportRead` ruft **nicht**
   `#onStatus`.
   **Kein Seitentext im Debug-Block:** `#reportRead` schreibt bei `BC_LOG=debug`
   nicht das Ergebnis, sondern eine Kopie mit `text: "<n chars>"` — sonst läge
   der Seiteninhalt des Betreibers auf stderr, was `## Touch boundary`
   ausdrücklich verbietet.
   Proof: `test/hub.test.js` neuer Fall
   `hub_requestWithReadMethod_shouldResolveAndLogOneLineWithoutAnyPageText` —
   Zeile exakt `read tab=42 url=https://example.org/ chars=<n> truncated=false`,
   und `logLines.join("\n")` enthält `result.text` nicht (auch nicht mit
   `BC_LOG=debug`). **Completed 2026-10-23**
5. **MCP-Werkzeug und Fixture.** `test/fixtures/fake-extension.mjs`:
   `export const READ_RESULT` mit kurzem, erfundenem Text (z. B.
   `"Zeile eins\n\nZeile zwei"` — kein Seitentext im Repo),
   `BC_TEST_READ_ANSWER` mit denselben drei Modi wie `BC_TEST_NAVIGATE_ANSWER`
   (`0`, `error:<code>`, sonst Ergebnis), `readResponse(id)`, `case "read"` in
   `responseFor`, `answers.read`. `bridge/mcp.mjs`: `BROWSER_READ`, dritter
   `TOOLS`-Eintrag (Beschreibung wörtlich aus `## MCP-Werkzeug`,
   `inputSchema {type:"object", properties:{}, additionalProperties:false}`),
   `case BROWSER_READ` in `callTool`, `readTool(id, params, {hub, log})`
   (`hasNoArguments` → sonst „browser_read erwartet keine Argumente."),
   `NO_AGENT_TAB`/`NOT_READABLE` in `TOOL_TEXTS`; die Sätze für unbekannte
   Argumente werden **nicht** dupliziert, sondern als Tabelle je Werkzeug
   geführt — `UNEXPECTED_ARGUMENTS[browser_status]` und
   `UNEXPECTED_ARGUMENTS[browser_read]` sagen „erwartet keine Argumente.",
   `UNEXPECTED_ARGUMENTS[browser_navigate]` bleibt wörtlich „erwartet nur
   `url`." (so steht es in Spec 04 und in `test/mcp.test.js`; ein einziger Satz
   für alle drei würde zwei bestehende Tests brechen),
   `extensionFailureText` mit drittem Zweig für `BROWSER_READ`
   (`no_agent_tab`/`not_readable`/sonst generisch). In `test/mcp.test.js`
   **ändern**: `mcp_toolsList_shouldOfferExactlyTheTwoToolsOfTheContract` →
   drei Namen in `deepEqual`, Beschreibung und Schema von `browser_read`
   prüfen; **neu**: Erfolg (`JSON.parse` enthält
   `tabId`/`url`/`title`/`text`/`truncated`), `arguments: {x:1}` ⇒ `isError` mit
   dem Satz, `BC_TEST_READ_ANSWER=error:no_agent_tab` und `error:not_readable`
   ⇒ je `isError` mit dem passenden Satz und je einer
   `fake extension: request method=read`-Zeile.
   Proof: `node --test --test-reporter=tap test/mcp.test.js | grep -E '^# (fail|cancelled)'`
   → `0`/`0`. **Completed 2026-10-23**
6. **Abschluss — Orchestrator, nicht der Umsetzer.** `npm test; echo $?`,
   `npm run check; echo $?`, `git grep --untracked -nE '[0-9a-f]{32,}' -- .`,
   dann die Spec auf `active`. Kriterium 6 sind Handgriffe des Betreibers
   (Extension in `about:debugging` neu laden, pi neu starten) und laufen nach dem
   Commit gemäß der Ausnahme in `CONTRIBUTING.md`, `## Acceptance`;
   `~/.pi/agent/mcp.json` und `INSTALL.md` fasst der Umsetzer nicht an.

### What could go wrong

- **Kriterium 1 ist um eins zu optimistisch.** Neben dem Manifest-Fall muss auch
  `test/mcp.test.js::mcp_toolsList_shouldOfferExactlyTheTwoToolsOfTheContract`
  geändert werden (er pinnt `["browser_status","browser_navigate"]` per
  `deepEqual`) — also **102 unverändert, zwei geändert**. Das Kriterium sagt es
  jetzt; ohne die Zeile wäre es nicht prüfbar.
- **Der Debug-Block ist die Falle.** `#reportRead` schreibt bei
  `BC_LOG=debug` keine Kopie des Ergebnisses, sondern eine gekürzte
  (`text: "<n chars>"`); Test: der Seitentext steht auch mit `BC_LOG=debug`
  nicht in den Logzeilen. (Nachgezogen 2026-11-18: statt der Kopie entscheidet
  `DEBUG_WHITELIST`, und `#logDebugResult` gibt es nicht mehr.)
- **`innerText` ist nicht folgenlos.** Sehr große Seiten kosten hunderte
  Millisekunden im Seitenkontext; `executeScript` hat keine eigene Frist, die
  einzige Grenze ist `CALL_TIMEOUT_MS` (20 s) der Bridge. Eine danach
  eintreffende Antwort verwirft `#takePending` ohne Geisterzeile — bestehendes
  Verhalten, keinen Retry einbauen.
- **Injizierbare Sonderfälle liefern `text: ""`** (`about:blank`, Fehlerseiten,
  Seite ohne Body). Das ist kein Fehler und darf nicht in `not_readable`
  rutschen; der Body-Fall hat seinen eigenen Test.
- **Kein eigenes Warten auf „fertig geladen".** `read` hängt keinen
  Ladezustand ab, sondern liest, was `document_idle` zulässt (siehe
  `## Wire-Protokoll`); nach einem `navigate` mit `complete: false` kann das eine
  halb geladene Seite sein, und wenn die Seite nicht ruhig wird, läuft die
  Zeitgrenze der Bridge ab.
  `## Non-goals` schließt Änderungen an Zeitgrenzen aus — nichts nachrüsten.

### Ordering and dependencies

1 → 3, 4, 5. Stufe 2 ist von allem unabhängig (kein Test hängt an der
Berechtigung; der Reload in Kriterium 6 schon). 3 und 4 sind unabhängig: der
Hub-Test schickt eigene Antwortframes, der Extension-Test liest keine Logs.
5 braucht 1 und 4 (der MCP-Test spawnt `bridge/bridge.mjs` mit dem echten Hub).
6 ist Orchestrator-Arbeit. Nach jeder Stufe ist `npm test` grün; die zwei
geänderten Fälle ändern sich in Stufe 2 bzw. 5, nie beide in derselben Stufe.

### What the next increment inherits

Klicken/Tippen/`focus`, Screenshot (1-MiB-Grenze plus MCP-Bildinhalt),
Readability, Frames/Shadow DOM, `getSelection` und Formularfelder — alles
`## Non-goals`. Dazu: ein Ausschnitts-Parameter (Offset/`maxChars`), den
`## Risiken` als „den es heute nicht gibt" nennt; eine Positivliste statt
`<all_urls>` und die Berechtigungsseite einer signierten Auslieferung, falls der
Betreiber die Reichweite verkleinert; ein Content-Script statt Injektion pro
Aufruf, erst wenn `read` heiß wird; und ein vierter Werkzeug-Eintrag, der aus den
`if`-Ketten in `#reportResult` und `extensionFailureText` wirklich eine Tabelle
macht. Aus Spec 01 steht Kriterium 8 (falsches Token) weiter aus — Spec 01
bleibt `proposed`.

## Sicherheit

- **Die Entscheidung:** `<all_urls>`, getroffen vom Betreiber am 2026-10-23.
  Verworfen: `activeTab` (setzt einen Klick des Menschen voraus) und eine
  Positivliste (müsste jemand pflegen). Was das heißt: die Extension kann jede
  Seite im Default-Container lesen, auf der der Betreiber eingeloggt ist —
  Postfach, Bank, internes Wiki. Sie tut es nur beim Aufruf von `browser_read`.
- **Der Inhalt verlässt den Rechner nicht, aber er steht im Werkzeug-Ergebnis:**
  der Text geht an pi (das Modell). Das ist die Folge jeder Leseberechtigung und
  der Grund, warum sie hier als Entscheidung steht.
- **Der Rückfall liest mehr als den sichtbaren Text.** `textContent` enthält
  auch `<script>`-/`<style>`-Reste im Body — Inline-Konfigurationen mit Tokens
  wandern damit ins Werkzeug-Ergebnis und ans Modell. `via` sagt, welcher Weg
  gegriffen hat; wer das nicht will, sieht dort nach.
- **Kein Seitentext in Logzeilen.** `read` schreibt `tab`, `url`, `chars`,
  `truncated` — und auch bei `BC_LOG=debug` nur `text: "<n chars>"`. Das gilt
  auch für die `console.warn`-Zeile des eigenen Fehlerfalls: dort steht
  `bc: read result without usable text`, nie der Inhalt.
- **Die `url` in der Logzeile trägt ihre Query.** Wer Tokens in URLs hat, findet
  sie im `bridge.log` — geerbtes Verhalten von `navigate`, hier zum ersten Mal
  relevant, weil die Zeile Seiteninhalte berührt.
- **Was der Betreiber nach dem Reload sieht:** in `about:addons` steht bei der
  Erweiterung „Zugriff auf alle Websites". Das ist erwartet, keine Fehlfunktion.

7. **Nachtrag vom 2026-10-23 — Rückfall auf `textContent` (entstanden nach der
   ersten Umsetzung).** `extension/background.js`: im injizierten Code beide
   Quellen normalisieren, `text = visible || content`, `via` entsprechend
   setzen; das Ergebnisobjekt und `pageResultOf` um `via` erweitern (fehlendes
   oder unbekanntes `via` zählt wie ein fehlendes `text` ⇒ `read_failed`).
   `bridge/hub.mjs`: `via` in `formatReadLine` **ohne** Inhalt; die Debug-Kopie
   redigiert weiterhin den Text. `test/fixtures/fake-extension.mjs`: `via` in
   `READ_RESULT` und in der Fehlerantwort. Tests: SPA-Muster (`innerText` leer,
   `textContent` gefüllt ⇒ `via: "textContent"`), normale Seite
   (⇒ `via: "innerText"`), `textContent` nur aus Skript-Resten (⇒ `via:
   "innerText"`, `text: ""`), fehlendes `via` ⇒ `read_failed`, Hub-Zeile mit
   `via`.
   Proof: `node --test --test-reporter=tap test/extension.test.js test/hub.test.js`
   → `# fail 0`; Gegenprobe: Rückfall entfernen ⇒ der SPA-Fall wird rot.
   **Nachtrag zum Nachtrag (2026-10-23, nach einem echten Lauf):** `textContent`
   nimmt auf YouTube die Inline-Skripte mit (20 000 Zeichen JavaScript statt
   Text). Im Rückfall fliegen deshalb `script`, `style`, `noscript` und
   `template` aus einer Kopie des Bodys (Ausnahme `template`, siehe
   `## Wire-Protokoll`); bleibt danach nichts, ist `text: ""` mit
   `via: "innerText"`. Vier Testfälle: nur Skripte im Body (⇒ `text: ""`),
   Skript neben echtem Text (⇒ Text ohne Skriptinhalt), `style`/`noscript`
   neben echtem Text (⇒ beides nicht im Ergebnis) und „sichtbarer Text
   antwortet" (⇒ der Body wird gar nicht kopiert).
   **Completed 2026-10-23**

## Risiken

- **Die Berechtigung ist breit, und das ist die Entscheidung.** `<all_urls>` heißt:
  die Extension kann jede Seite im Default-Container lesen, auf der der
  Betreiber eingeloggt ist — Postfach, Bank, internes Wiki. Sie tut es nur, wenn
  `browser_read` aufgerufen wird, und der Aufruf landet im Log (ohne Inhalt).
  Wer die Reichweite später verkleinern will, braucht eine Positivliste — das
  wäre ein eigenes Inkrement mit eigener Spec.
- **Nicht jede Seite ist lesbar.** `about:`-Seiten, der PDF-Viewer, AMO-Seiten und
  `view-source:` verweigern `executeScript`. Das ist `not_readable` und kein
  Fehler des Aufrufers.
- **`innerText` ist nicht der Artikel.** Navigation, Werbung und Cookie-Banner
  stehen mit im Text; der Agent muss damit umgehen. Eine Readability-Extraktion
  ist bewusst nicht Teil dieses Inkrements.
- **`textContent` ist der Rückfall, nicht die Regel** (2026-10-23, nach einem
  echten Lauf): YouTube lieferte mit `innerText` 0 Zeichen, obwohl die Seite
  voll ist. Jetzt greift `textContent`, und `via` sagt es. Der Preis:
  `textContent` enthält auch versteckte Texte (Menüs, Skript-Reste) — wer nur
  Sichtbares will, sieht es an `via`.
- **20 000 Zeichen sind eine Grenze, keine Meinung.** Große Seiten werden
  abgeschnitten; `truncated: true` sagt es, und der Agent kann sich auf einen
  Abschnitt konzentrieren, indem er erneut navigiert — oder später über einen
  Ausschnitts-Parameter, den es heute nicht gibt.
- **Temporäre Erweiterung, neue Berechtigung.** Firefox fragt bei
  `about:debugging` nicht nach; wer die Erweiterung signiert ausliefert, braucht
  eine Berechtigungsseite — das ist außerhalb dieses Inkrements.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine Tokens im Repo, **keine
  Seitentexte in Logs, Tests oder Beispieldaten** — die Tests erzeugen ihren
  HTML-Inhalt selbst.
- `bridge/websocket.mjs`, `bridge/config.mjs` werden nicht angefasst.
- `docs/PROJECT-STATE.md`, `docs/README.md` und `INSTALL.md` pflegt der
  Orchestrator.
- Kein Produktivcode für Inkrement 6 oder später (Klicken, Tippen, Screenshot,
  Frames, Readability).

## Bekannte Lücken

Stand 2026-10-23, vor der Umsetzung:

- **Kein Ausschnitts-Parameter.** `read` liefert immer die ersten 20 000 Zeichen;
  wer einen späteren Abschnitt braucht, kann heute nicht danach fragen.
- **`document_idle` schiebt auf.** Ist die Seite noch nicht ruhig, kommt die
  Antwort später oder gar nicht (Zeitgrenze der Bridge). Ein eigenes
  Lade-Kriterium hat `read` nicht.
- **Die `url` in der Logzeile trägt ihre Query** — geerbt von `navigate`; wer
  Tokens in URLs hat, findet sie im `bridge.log`.
- **Kriterium 6 ist erst nach dem Commit messbar** (Extension-Reload,
  pi-Neustart); die Ausnahme steht dort und in `CONTRIBUTING.md`, `## Acceptance`.
- ~~**Der Debug-Block redigiert per Sperrliste**~~ — **geschlossen 2026-11-18
  durch Spec 28** (`docs/28-log-hygiene.md`): der Block entsteht aus
  `DEBUG_WHITELIST` (`bridge-rs/src/hub.rs`), ein künftiges Feld im
  `read`-Ergebnis (etwa `html` oder `selection`) erscheint als
  `"<unlisted field>"` statt auf stderr. Der Befund vom 2026-10-23 („die Kopie
  ersetzt nur `text`", sechs Felder) beschreibt die gelöschte Node-Fassung
  `bridge/hub.mjs`.
- **`title` fällt still auf `""` zurück**, während `text`/`url` `read_failed`
  auslösen. Die Spec nennt nur `text` und `url`, also regelkonform; die
  Asymmetrie ist beim nächsten Feld geradezuziehen.
- **Eine Leak-Zusicherung im Test ist zu schwach** (2026-10-23, Code-Review):
  sie vergleicht gegen den **rohen** `innerText`, den die Normalisierung
  verändert — ein Leck über einen normalisierenden Pfad käme daran vorbei.
  Gegen den normalisierten Ausschnitt prüfen.

## Open questions

Keine. Entschieden vom Betreiber am 2026-10-23: `<all_urls>`, kein `activeTab`,
keine Positivliste. Das Lesen ist der Zweck des Inkrements; das Klicken kommt
separat.

## Review

| Runde | Datum | Verdict | Blocker |
|---|---|---|---|
| 1 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (toter Verweis, `read_failed` ohne Test, Beleg mit Seitentext, `document_idle`, `url`/`title` ungekappt, Amendments) |
| 2 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (Widerspruch zu `document_idle`, Textschlüssel, toter Verweis, Fundstellen, Stufenliste) |

## Log

Befunde beim Schreiben des Dev-Plans (2026-10-23), alle vom Architekten:

- **Kriterium 1 war um eins zu optimistisch** („einer muss sich ändern") — auch
  `mcp_toolsList_shouldOfferExactlyTheTwoToolsOfTheContract` pinnt zwei
  Werkzeuge. **Übernommen**: 102 unverändert, zwei geändert, beide benannt.
- **`## Hub` und `## Touch boundary` widersprachen sich beim Debug-Log**:
  `BC_LOG=debug` hätte den ganzen Seitentext auf stderr geschrieben.
  **Übernommen**: `read` schreibt im Debug-Block `text: "<n chars>"` statt des
  Inhalts, und ein Test prüft, dass der Seitentext in keiner Logzeile steht.
- **Ein dritter Code fehlte**: „Seite nicht lesbar" und „eigener Fehler" waren
  nicht unterscheidbar. **Übernommen**: `read_failed` für den eigenen Bug, mit
  `console.warn`.

Runde 1 des Spec-Reviews — sechs Blocker, alle übernommen:

- **B1** (Verweis auf `## Sicherheit`, das es nicht gab) — **übernommen**:
  eigener Abschnitt `## Sicherheit` angelegt; die Betreiberentscheidung, die
  Log-Regel, die Query in der `url` und „Zugriff auf alle Websites" stehen dort.
- **B2** (`read_failed` hatte keinen Test) — **übernommen**: Fall
  `executeScript` liefert `[undefined]`/Objekt ohne `text` ⇒ `read_failed` mit
  `console.warn` und **nicht** `not_readable`, plus die `console.warn`-Regel
  (nie der Inhalt).
- **B3** (Kriterium 6 machte den Seitentext zum Beleg — und damit ins Repo) —
  **übernommen**: Beleg sind Felder und `chars > 0`; der Text wird ausdrücklich
  nicht kopiert.
- **B4** („liest den Stand von jetzt" widersprach `runAt: "document_idle"`) —
  **übernommen**: die Verzögerung bis zum Ruhezustand steht im Wire-Abschnitt,
  mit `BC_CALL_TIMEOUT_MS` als Obergrenze und Überschreitungssatz.
- **B5** (`url`/`title` ungekappt — ein überlanger Titel kostet die Verbindung
  mit `1009`) — **übernommen**: der injizierte Code kappt auf 2 048 bzw. 1 024
  Zeichen, Testfall für einen 5 000-Zeichen-Titel.
- **B6** (zwei `active` Specs und `INSTALL.md` blieben falsch) — **übernommen**:
  `## Amendments to previous spec docs` nennt Spec 02, Spec 03 und `INSTALL.md`.
- **Minors** — **übernommen**: Protokoll-Testzeile in `## Testing`,
  `frameId: 0`-Zusicherung, `executeScript` liefert ein **Array**
  (`results[0]`), Rückweg über die Realm-Grenze per JSON, Hinweis auf
  `unsupported_method` bei fehlendem Reload, `console.warn` ohne Inhalt,
  kein doppelter Textschlüssel (`UNEXPECTED_ARGUMENTS(toolName)`), 60 kB statt
  80 kB.

Runde 2 des Spec-Reviews — fünf Blocker, alle übernommen:

- **Der Widerspruch zu `document_idle` stand noch im Dokument** („liest den Stand
  von jetzt" im Risiko-Absatz, gegen den Wire-Abschnitt) — **übernommen**:
  umgeschrieben auf „liest, was `document_idle` zulässt".
- **`UNEXPECTED_ARGUMENTS(toolName)` konnte den `navigate`-Satz nicht erzeugen**
  („erwartet nur `url`" vs. „erwartet keine Argumente") und hätte damit zwei
  bestehende Tests gebrochen — **übernommen**: Tabelle je Werkzeug, drei Sätze,
  `navigate` wörtlich unverändert.
- **Kriterium 6 verwies auf `## Bekannte Lücken`, das es nicht gab** — derselbe
  Fehlertyp wie B1 — **übernommen**: Abschnitt angelegt (Ausschnitts-Parameter,
  `document_idle`, Query in der `url`, Messung nach dem Commit).
- **Die Fundstellen in den Amendments waren falsch** (`## Touch boundary` nennt
  keine `permissions`; `## Testing` und der Dev-Plan fehlten) — **übernommen**:
  vier Stellen für Spec 02, wie sie wirklich heißen.
- **`## Testing` und die Stufenliste erzählten verschiedene Geschichten**
  (`read_failed` und der lange Titel fehlten in der Stufe, „genau 20 000" in der
  Tabelle) — **übernommen**: deckungsgleich.
- **Nits** — **übernommen**: „Noch keine Befunde." entfernt,
  `PROTOCOL.CALL_TIMEOUT_MS` statt der Env-Variable, `chars` ausdrücklich als
  Logzeilen-Feld, gemeinsamer Textschlüssel `CALL_EXTENSION_FAILED(code)`.

Runde 3 des Spec-Reviews — Verdict `✅ Ship it`, drei Nachträge übernommen:

- **`[undefined]` war an zwei Stellen verschieden beantwortet** (Stufe 3 sagte
  `not_readable`, Testtabelle und Log sagten `read_failed`) — **übernommen**:
  überall `read_failed`, mit der Begründung, dass nur einer der beiden Fälle
  unser Fehler ist.
- **„Deckungsgleich" war geschwindelt**, weil „genau 20 000 Zeichen" nur in der
  Stufe stand — **übernommen**: Tabellenzeile ergänzt.
- **Spec 04 nannte `NAVIGATE_EXTENSION_FAILED`**, das jetzt
  `CALL_EXTENSION_FAILED(code)` heißt — **übernommen**, in die Amendments-Liste.

Code-Review Runde 1 (Schritt 6, 2026-10-23) — Verdict `✅ Ship it` ohne Blocker.
Sechs Gegenproben des Reviewers waren rot, wenn das jeweilige Verhalten entfernt
wird: Kappung des Textes, Kappung des Titels, `read_failed` statt
`not_readable`, `>` gegen `>=` bei `truncated`, Debug-Redaktion, Argument-Prüfung
vor dem Draht. Der injizierte String wurde zusätzlich von Hand in einen nackten
Kontext geworfen und lieferte das erwartete Objekt — kein Closure über
Modulzustand, Grenzen als Argumente. Drei Follow-ups stehen unter
`## Bekannte Lücken` (Sperrliste statt Whitelist, `title`-Asymmetrie, schwache
Leak-Zusicherung), keiner davon blockiert den Commit.

Nachtrag nach einem echten Lauf (2026-10-23, Betreiberentscheidung):

- **`browser_read` lieferte auf YouTube 0 Zeichen**, reproduzierbar, während
  `example.org` 917 Zeichen ergab. Ursache: `innerText` respektiert das
  Rendering, und YouTube macht seinen Body erst nach dem Hochfahren sichtbar.
  Der Betreiber hat den Rückfall auf `textContent` entschieden — **übernommen**:
  eigenes Feld `via`, gleiche Normalisierung und Grenze, Testfälle für beide
  Wege; der Preis (unsichtbare Texte) steht unter `## Risiken`.

Code-Review der Nachträge (2026-10-23) — zwei Runden:

- **Runde 1, Whitelist ungetestet** (`bridge/hub.mjs` schützte `via` gegen
  Zeilenumbrüche, aber kein Test hielt das fest; die Mutation blieb grün) —
  **übernommen**: Fall mit `via: "innerText\nnavigate tab=7 …"` ⇒ Zeile endet
  `via=?`, genau eine Logzeile; Gegenprobe rot.
- **Runde 1, Kriterium 1 war unwahr geworden** (der Nachtrag ändert fünf
  weitere Bestandsfälle) — **übernommen**: sechs betroffene Fälle mit sieben
  Änderungen, benannt.
- **Runde 1, `## Ziel` nannte fünf Felder** — **übernommen**: sechs.
- **Runde 2, „Alle sechs Änderungen" rechnete nicht auf**, und
  `## Bekannte Lücken` sprach weiter von „fünf Feldern" — **übernommen**.
- Kein Seitentext in Logs, Fixtures oder Doku: geprüft mit `grep`; die
  Debug-Redaktion (`text: "<n chars>"`) und die `via`-Validierung auf beiden
  Seiten sind durch Gegenproben belegt.

Messlauf (2026-10-23, Kriterium 6) — erfüllt:

- Betreiber: Extension in `about:debugging` neu geladen, pi neu gestartet.
- **`via` steht im Ergebnis** — der Beweis, dass der neue Code läuft.
- **Der Rückfall greift genau dort, wo es vorher 0 Zeichen gab:** direkt nach
  `navigate("https://www.youtube.com/")` lieferte `browser_read`
  `chars: 20000`, `truncated: true`, **`via: "textContent"`** — vorher waren es
  an derselben Stelle `text: ""`.
- **Und er ist nicht die Regel:** `example.org` liefert `chars: 917`,
  `via: "innerText"`.
- Damit sind die Kriterien 1–6 gelaufen; die Zahlen stehen in
  `docs/PROJECT-STATE.md`.

Korrektur der eigenen Messung (2026-10-23):

- Der im Messlauf als Erfolg notierte Wert `chars: 20000, via: "textContent"`
  war **kein** Seiteninhalt, sondern der Inline-JavaScript des YouTube-Bootstraps
  (`if (window.ytcsi) {…}`, `//# sourceURL=yt-desktop-body-width.js`). `via` war
  richtig, die Schlussfolgerung nicht. **Übernommen**: der Rückfall entfernt
  `script`/`style`/`noscript`/`template` vor dem Lesen, ein Testfall hält es
  fest, und diese Zeile ersetzt den zu optimistischen Eintrag.

Messlauf des Nachtrags (2026-10-23) — erfüllt:

- **Kein Skript-Salat mehr:** direkt nach `navigate("https://www.youtube.com/")`
  lieferte `browser_read` `chars: 14`, `via: "textContent"`, Text
  `"Zurück\n\nSuchen"` — vorher waren es 20 000 Zeichen Inline-JavaScript.
- **Der Rückfall ist nicht die Regel:** zwei Sekunden später, mit gerenderter
  Seite, `via: "innerText"` mit dem echten Seiteninhalt.
- Damit ist die Fehlmessung vom Vortag (`chars: 20000` als Erfolg notiert)
  korrigiert und der Fix belegt.
