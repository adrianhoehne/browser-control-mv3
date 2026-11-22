---
description: browser_screenshot liefert ein Bild des sichtbaren Ausschnitts im Agenten-Tab als Base64 — PNG, bei Überschreiten der Grenze verkleinert und als JPEG neu kodiert, hinter dem Schalter allowScreenshot.
status: active
---

# Sehen statt nur lesen: `browser_screenshot`, Teil 1 (Transport)

`browser_read` liefert Text. Der Betreiber hat am 2026-10-23 eine Sitzung mit
echten Aufgaben gefahren, in der genau das zu wenig war: ein Kursplan, ein
Bewertungsportal und ein Chat-Widget lieferten 0 Zeichen (Shadow DOM, SPA), und
ein PDF war über den Text gar nicht erreichbar. Ein Bild hätte in allen drei
Fällen geholfen.

Die Roadmap teilt das in zwei Stücke (Zeilen 11 und 12), weil zwei Dinge
auseinanderfallen: **der Transport** (ein Bild kommt heil aus dem Browser in die
Bridge, ohne die Nachrichtengrenze zu sprengen) und **der Bildinhalt im
MCP-Protokoll** (`type: "image"`). Dieses Inkrement ist Teil 1 — es baut den
Transport und belegt ihn mit einem Werkzeug, das Base64 liefert. Teil 2 macht
daraus ein Bild, das der Agent *sieht*.

## Ziel

`browser_screenshot({tab?})` fotografiert den **sichtbaren Ausschnitt** des
Agenten-Tabs und gibt das Bild als Base64 zurück:

```json
{"tabId":4,"url":"https://example.org/","title":"Example Domain",
 "format":"png","width":1280,"height":720,"bytes":48211,
 "scaled":false,"activated":false,"base64":"iVBORw0…"}
```

- **Aufnahme** über `browser.tabs.captureTab(tabId, {format: "png"})`; das
  Ergebnis ist eine Data-URL (`data:image/png;base64,…`), und der Base64-Teil
  geht über den Draht.
- **Nur der sichtbare Ausschnitt.** `captureTab` liefert den Viewport des Tabs,
  nicht die ganze Seite. Eine ganze Seite braucht Scrollen und Zusammensetzen
  und ist ein eigenes Inkrement (siehe `## Non-goals`).
- **Die Grenze gilt für die Bytes, die wirklich rausgehen**:
  `SCREENSHOT_MAX_BYTES = 3145728` (3 MiB dekodiert). Base64 davon sind
  699 052 Byte (≈ 683 KiB) und passen mit Luft unter
  `PROTOCOL.MAX_MESSAGE_BYTES` (5 242 880 Byte); die Grenze wird **hier** gezogen
  und nicht erst vom Socket.
- **Passt das PNG nicht, wird es kleiner** — die Stufenleiter ist Vertrag, nicht
  Optimierung:

  | Stufe | Was | Ergebnis-`format` |
  |---|---|---|
  | 0 | PNG, wie `captureTab` es liefert, wenn ≤ 3 MiB | `png` |
  | 1 | auf höchstens 1600 px lange Kante skaliert, JPEG q = 0,75 | `jpeg` |
  | 2 | dieselbe Größe, JPEG q = 0,5 | `jpeg` |
  | 3 | auf höchstens 1200 px lange Kante skaliert, JPEG q = 0,6 | `jpeg` |
  | — | auch Stufe 3 über der Grenze ⇒ `screenshot_too_large` | — |

  Skaliert wird nur herunter, nie herauf; ist das Bild schon kleiner als die
  Stufe verlangt, bleibt die Größe. `width`/`height` sind **immer** die Maße des
  gelieferten Bildes. `scaled: true` sagt, dass das Bild **neu kodiert** wurde und
  nicht mehr das PNG der Aufnahme ist — die Maße können dabei gleich bleiben
  (Stufe 1 auf einer 1600 × 900 großen Aufnahme liefert 1600 × 900). Wer `scaled`
  als „weniger Pixel als der Viewport" liest, rechnet Koordinaten falsch.
- **`format` ist `"png"` oder `"jpeg"`** — der Agent sieht in der Antwort, was er
  bekommen hat, statt es aus dem Base64-Kopf raten zu müssen. **`base64` ist
  immer das Bild, das `format`, `width`, `height` und `bytes` beschreiben** — nie
  die Aufnahme neben einer Beschreibung, die eine andere ist. Ein `format:
  "jpeg"` mit PNG-Bytes wäre der Fehler, den Teil 2 erben würde.
- **`tab`** wie bei allen Werkzeugen seit Spec 16: mit `tab` genau dieser
  Agenten-Tab, ohne `tab` der zuletzt benutzte.
- **Kein Warten auf Ruhe, kein Slot.** `captureTab` ist ein Lesevorgang; ob die
  Seite „fertig" ist, ändert das Bild nicht. `settled`/`waitedMs` wären hier eine
  Behauptung über einen Zustand, den das Bild selbst zeigt.
- **Kein `executeScript`.** `captureTab` braucht keine Injektion; damit gelten
  `page_busy`/`not_readable` hier **nicht**. Ein Tab, den es nicht gibt, ist
  `no_agent_tab`; eine Seite, die Firefox nicht fotografieren kann (interner
  Bereich, PDF-Viewer, `view-source:`), ist `screenshot_failed` mit der Meldung
  des Browsers, gekürzt.
- **Das Bild kann den Tab nach vorn holen.** Firefox fotografiert in manchen
  Fällen nur den aktiven Tab einer Fenstergruppe; dann schlägt der erste Versuch
  fehl. Die Extension versucht es **einmal** ohne Fokus und bei einem Fehler
  **einmal** mit aktiviertem Tab (`tabs.update {active: true}`, Fenster bleibt,
  wo es ist) — und sagt in der Antwort, ob das nötig war (`activated: true`).
  Der Fokusgriff passiert **nur, wenn der Tab nicht schon aktiv ist** — ein
  zweiter `tabs.update` auf einem ohnehin vorn stehenden Tab wäre ein Aufruf ohne
  Wirkung, und der Betreiber sieht keinen Wechsel, den er nicht braucht. **Was
  das nicht abdeckt:** liegt der Agenten-Tab hinten und ist die Seite gar nicht
  fotografierbar (PDF-Viewer, `view-source:`), holt der Rückfall ihn trotzdem
  nach vorn und meldet danach `screenshot_failed`. Der Betreiber verliert dann den
  Blick auf seine Seite für ein Bild, das es nicht gibt. Das ist offen benannt und
  nicht behoben: dafür müsste der Code die Ursache des ersten Fehlers kennen, und
  die Rejection-Texte sind laut Spec 10 kein Vertrag. Der Betreiber sieht den
  Agenten-Tab, wenn der Wechsel nötig war; das ist der Preis dafür, dass das Bild
  entsteht.

## Non-goals

- **Kein MCP-Bildinhalt.** Das Werkzeug liefert Base64-Text; `type: "image"` ist
  Teil 2 (Roadmap 12). Ein Bild als Text ist für den Agenten noch kein Bild.
- **Keine ganze Seite, kein Ausschnitt-Rechteck (`rect`), kein Zoomen (`scale`).**
  `captureTab` kann `rect` und `scale`; beides ist ein eigener Zuschnitt, und
  `rect` ohne Kenntnis der Seite ist Raten.
- **Kein PNG-Verkleinern.** Die Leiter wechselt beim Verkleinern das Format, weil
  ein verkleinertes PNG von einer fotolastigen Seite immer noch groß ist; PNG
  bleibt die Stufe für alles, was ohnehin passt.
- **Keine neue Berechtigung.** `tabs` + `<all_urls>` decken `captureTab` ab;
  `manifest.json` bleibt in `permissions` unverändert.
- **Keine Frames, keine Ablage auf Platte, kein Zwischenspeicher.** Das Bild lebt
  in der Antwort und nirgends sonst — nicht im Journal, nicht im Speicher der
  Bridge.
- **Kein Screenshot ohne Agenten-Tab.** Es wird nie ein fremder Tab des
  Betreibers fotografiert.

## Konfiguration (neu): Bildschirmfotos

| Schlüssel | Element-Id | Typ | Default | Wirkung |
|---|---|---|---|---|
| `allowScreenshot` | `allowScreenshot` | Boolean | `false` | Ist er nicht `true`, lehnt die Extension **jeden** Aufruf mit `screenshot_not_allowed` ab, ohne `captureTab` aufzurufen |

- Gelesen bei **jedem** Aufruf aus `browser.storage.local`; nur der Boolean
  `true` öffnet, ein Lesefehler zählt als aus. Dieselbe Regel wie
  `allowPasswordFields` (Spec 07) und `allowEval` (Spec 19).
- `options.html` bekommt eine dritte Checkbox „Bildschirmfotos erlauben" mit
  Hinweistext: ein Bild zeigt, was auf dem Bildschirm steht — das eingeloggte
  Profil, also Postfach, Warenkorb oder Kontodaten; verdeckte Tabs und andere
  Fenster sind nicht im Bild.
- Die Schreibweise steht in `options.html`, `options.js` und `background.js`;
  `test/manifest.test.js` pinnt die beiden Optionsdateien, der Schlüssel in
  `background.js` wird dort in einem eigenen Fall gepinnt.

## Wire-Protokoll (neu: `screenshot`)

`PROTOCOL.METHODS` bekommt in **beiden** Kopien (`extension/protocol.js`,
`bridge/protocol.mjs`) `SCREENSHOT: "screenshot"`.

Anfrage:

```json
{"type":"request","id":11,"method":"screenshot","params":{"tab":4}}
```

Antwort, Erfolg:

```json
{"type":"response","id":11,"ok":true,
 "result":{"tabId":4,"url":"https://example.org/","title":"Example Domain",
           "format":"jpeg","width":1600,"height":900,"bytes":214311,
           "scaled":true,"activated":false,"base64":"/9j/4AAQ…"}}
```

Antwort, abgelehnt:

```json
{"type":"response","id":11,"ok":false,
 "error":{"code":"screenshot_too_large",
          "message":"The picture is too large even after scaling down: 611400 bytes at 1200 × 675 (limit 3145728)."}}
```

Neue Codes:

| Code | Wann |
|---|---|
| `screenshot_not_allowed` | Schalter `allowScreenshot` ist nicht `true` |
| `screenshot_too_large` | auch die letzte Stufe der Leiter liegt über 3 MiB |
| `screenshot_failed` | `captureTab` ist gescheitert (auch beim zweiten Versuch), oder die Neukodierung ist gescheitert/hat die Frist gerissen |

Dazu die geerbten `no_agent_tab` und `invalid_params` (ein `tab`, das keine Zahl
ist). **Nicht** geerbt: `page_busy`, `not_readable` — es gibt keine Injektion,
also auch kein `executeScript`, das abgelehnt werden könnte.

## MCP-Werkzeug

Elfter Eintrag der Tabelle in `bridge/mcp.mjs`, **angehängt** (Position 10, nach
`browser_eval`) — `test/mcp.test.js` indiziert die Tabelle nach Position.

- Name: `browser_screenshot`
- Beschreibung (deutsch): „Fotografiert den sichtbaren Ausschnitt des
  Agenten-Tabs und liefert das Bild als Base64 (höchstens 3 MiB; PNG, bei
  Überschreiten verkleinert und als JPEG neu kodiert). `format`, `width`,
  `height`, `bytes` und `scaled` stehen dabei. Mit `tab` genau diesen Tab, ohne
  `tab` den zuletzt benutzten."
- `inputSchema`: `{tab: integer ≥ 1}`, kein Pflichtfeld,
  `additionalProperties: false`.
- Der Werkzeugtext bei Ablehnung nennt Code und – bei `screenshot_too_large` –
  die gemessenen Werte: die Zahl entscheidet, ob der Agent es mit einem anderen
  Tab erneut versuchen kann.

## Hub

- `request(PROTOCOL.METHODS.SCREENSHOT, params)` — derselbe Weg wie `inspect`.
- Logzeile: `screenshot tab=4 bytes=214311 format=jpeg scaled=true ok=true`.
  **Kein Base64 im Log**, keine Bilddaten: dieselbe Log-Hygiene wie bei `eval`
  (Tab-Id, Größe, Format, Zustand).
- Der Hub prüft die Nachrichtengröße **nicht** selbst: die Extension hält die
  3 MiB ein, und der Socket bricht bei 5 MiB mit `1009` — eine zweite Grenze
  im Hub wäre eine zweite Wahrheit.

## Extension

- Konstanten: `SCREENSHOT_MAX_BYTES = 3145728`, `SCREENSHOT_SCALE_STEPS =
  [{maxEdge: null, format: "png"}, {maxEdge: 1600, quality: 0.75},
  {maxEdge: 1600, quality: 0.5}, {maxEdge: 1200, quality: 0.6}]`,
  `SCREENSHOT_ENCODE_TIMEOUT_MS = 3000` (Begründung in `## Risiken`), `ALLOW_SCREENSHOT = "allowScreenshot"`,
  die drei Codes, `SCREENSHOT_MESSAGE_LIMIT = 500` (derselbe Wert wie
  `EVAL_MESSAGE_LIMIT`, damit eine gekürzte Browser-Meldung so lang ist wie eine
  gekürzte Seitenmeldung), die englischen Sätze (seit `docs/54`).
- `screenshotRequestParams(params)` prüft **nur** die Form von `tab` (wie
  `focus`). Reihenfolge in `screenshotAgentTab`: **Schalter → Parameter → Tab →
  Aufnahme** — dieselbe Reihenfolge wie bei `eval`.
- `captureTabOnce(tabId)`: `browser.tabs.captureTab(tabId, {format: "png"})`,
  Data-URL-Präfix abschneiden, Base64 behalten. `width`/`height` aus dem PNG-Kopf
  (IHDR, Bytes 16–23, als vier Bytes gelesen) — kein Umweg über ein geladenes
  `Image`, nur um Maße zu erfahren. Fehlt die PNG-Signatur oder ist die Strecke
  kürzer als 24 Byte, ist das `screenshot_failed`: aus einem Bild ohne Kopf lassen
  sich keine Maße ableiten, und `0 × 0` wäre eine stille Nicht-Antwort.
- `bytesOf(base64)`: dekodierte Länge aus der Base64-Strecke
  (`Math.floor(len * 3 / 4)` minus Padding) — `Buffer` gibt es im Browser nicht.
- `shrinkToLimit(capture)`: die Leiter. Jede Stufe kodiert im **Hintergrund**
  (`document.createElement("canvas")`, `Image` mit der Data-URL, `drawImage` auf
  die Zielmaße, `canvas.toDataURL("image/jpeg", quality)`), misst `bytes` und
  gibt zurück, sobald sie unter der Grenze liegt. Die Frist
  (`SCREENSHOT_ENCODE_TIMEOUT_MS`) umschließt **eine** Stufe; reißt sie, ist das
  `screenshot_failed` — ein hängendes `Image` darf den Aufruf nicht offen lassen.
  Die Leiter gibt ihre Versuche zurück, damit die Meldung bei `screenshot_too_large`
  die Zahlen des **letzten** Versuchs nennt.
- `activateTabForCapture(tabId)`: `tabs.update {active: true}` — der einzige
  Fokusgriff dieses Inkrements, und nur im Rückfall.
- Die Optionsseite bekommt die dritte Checkbox, `loadSettings`/`handleSubmit`
  um `allowScreenshot` erweitert, `readChecked` unverändert.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/protocol.test.js` | `METHODS.SCREENSHOT === "screenshot"` auf beiden Seiten wörtlich | die Methode fehlt in keiner Kopie |
| `test/manifest.test.js` | `allowScreenshot` in `options.html`, `options.js` und `background.js` gleich geschrieben; Hinweistext im Block der Box | der Schalter speichert, wo die Extension liest, und sagt, was er öffnet |
| `test/mcp.test.js` | elfter Eintrag, `browser_screenshot` an Position 10, `additionalProperties: false` | angehängt, nicht eingefügt |
| `test/mcp.test.js` | `screenshot_too_large` nennt Bytes und Maße im Werkzeugtext; `screenshot_failed` und `screenshot_not_allowed` je eigener Satz | der Agent liest eine Ursache, keine Zahl |
| `test/hub.test.js` | `screenshot` löst über die `id` auf; Logzeile `screenshot tab=4 bytes=… format=jpeg scaled=true ok=true`; **kein** Base64 im Log (mit `BC_LOG: "debug"`) | Log-Hygiene und Auflösung |
| `test/extension.test.js` | `captureTab` liefert eine bekannte 1×1-PNG-Data-URL (68 Bytes) → `format: "png"`, `scaled: false`, `bytes: 68`, `width: 1`, `height: 1`, Base64 ohne Präfix | der Transport inklusive Kopfdaten |
| `test/extension.test.js` | Bild mit genau 3 145 728 Bytes → `ok` ohne Neukodierung; 3 145 729 → Stufe 1 greift | die Grenze ist exakt und Stufe 0 wird nur bei Passen genommen |
| `test/extension.test.js` | Stufe 1 liefert 400 000 Bytes → `format: "jpeg"`, `scaled: true`, `bytes: 400000`, genau **ein** Kodieraufruf; der zurückgegebene `base64` beginnt mit `/9j/`, Stufe 0 mit `iVBORw0` | die Leiter hält bei der ersten passenden Stufe an **und** liefert das Bild, das sie beschreibt (nicht die Aufnahme daneben) |
| `test/extension.test.js` | `Image` meldet `naturalWidth: 0` beim Dekodieren → `screenshot_failed`, keine Antwort mit `bytes: 0` | der Guard gegen `"data:,"`, den ein Canvas der Größe 0 produzieren würde |
| `test/extension.test.js` | `captureTab` liefert eine Data-URL mit **12 dekodierten Bytes** (16 Base64-Zeichen, kein PNG-Kopf) → `screenshot_failed`, keine `0 × 0`-Antwort | der Längen-Fehlerfall von `pngSizeOf`; `atob` auf einer zu kurzen Strecke darf keinen Absturz und keine erfundenen Maße ergeben |
| `test/extension.test.js` | `captureTab` liefert **40 dekodierte Bytes** ohne PNG-Signatur → `screenshot_failed` | die Signaturprüfung selbst — Länge allein reicht nicht, die Bytes müssen mit `89 50 4E 47` beginnen |
| `test/extension.test.js` | Stufe 1 liefert 600 000, Stufe 2 450 000 → `jpeg` mit q = 0,5, genau zwei Kodieraufrufe | die zweite Stufe wird wirklich versucht |
| `test/extension.test.js` | alle Stufen zu groß → `screenshot_too_large`, Meldung trägt die Zahlen der **letzten** Stufe | die Meldung ist handlungsfähig |
| `test/extension.test.js` | Schalter aus → `screenshot_not_allowed`, `captureTab` **nicht** aufgerufen (der Stub zählt) | der Schalter schützt |
| `test/extension.test.js` | `captureTab` wirft einmal, gelingt beim zweiten → `ok` mit `activated: true`, genau zwei Aufrufe, ein `tabs.update` | der Fokus-Rückfall |
| `test/extension.test.js` | derselbe Fall auf einem **aktiven** Tab (`active: true`) → `ok` mit `activated: false`, zwei `captureTab`-Aufrufen und **kein** `tabs.update` | der Guard: kein Fokusgriff auf einem Tab, der schon vorn ist |
| `test/extension.test.js` | beide Versuche werfen → `screenshot_failed`, Meldung gekürzt, kein Stack | der Fehlerpfad |
| `test/extension.test.js` | Neukodierung reißt die Frist → `screenshot_failed` | kein hängender Aufruf |
| `test/extension.test.js` | Tab fehlt → `no_agent_tab`; `tab` keine Zahl → `invalid_params` | geerbte Adressregel |
| `test/extension.test.js` | `tabs.scriptCalls` bleibt in allen `screenshot`-Fällen leer | `captureTab`, keine Injektion |
| `test/http-mcp.test.js` | `tools/list` nennt `browser_screenshot` (seit Spec 24 zwölf Werkzeuge, seit Spec 32 dreizehn) | auch über den Dienst erreichbar |

Die bestehenden Fälle bleiben grün bis auf die Werkzeugzählung (heute zwölf, damals zehn:
`tools.length`, beide Namensarrays, `TOOL_COUNT`) — vier Pins, wie bei Spec 19.
Der Harness braucht Stubs für `Image`, `document.createElement("canvas")` und
`toDataURL`, die **programmierbar** sind (Zielmaße und Qualität bestimmen die
Länge der erzeugten Data-URL), sonst ist die Leiter nicht prüfbar.

## Acceptance criteria

Jedes Kriterium trägt `(lokal)` oder `(live)`; live heißt: echter Browser des
Betreibers, Reload der Erweiterung und pi-Neustart — das hakt der Betreiber ab.

**Ausnahme mit Datum** (2026-10-27, `CONTRIBUTING.md`, `## Acceptance`): die Live-Kriterien
9, 10 und 11 sind erst nach dem `git pull` im eigenen Klon des Betreibers messbar,
also nach dem Commit. Dann gilt: die lokal entscheidbaren Kriterien laufen vor
dem Commit, die Messung danach; fällt ein Messkriterium rot aus, wird vorwärts
korrigiert und die rote Zeile steht unter `## Bekannte Lücken`. **Kernannahme** ist
Kriterium 9: ein echtes Bild kommt dekodierbar an. Ist das widerlegt, geht das
Inkrement zurück in die Spec.

1. **Die Grenze ist exakt** (lokal). 3 145 728 Bytes → `ok`; 3 145 729 → Stufe 1
   greift, und erst wenn alle Stufen scheitern, `screenshot_too_large`.
2. **Der Transport trägt** (lokal). Eine bekannte 1×1-PNG-Data-URL ergibt
   `format: "png"`, `bytes: 68`, `width: 1`, `height: 1` und den Base64-Teil ohne
   Präfix.
3. **Die Leiter hält an der ersten passenden Stufe an** (lokal). Drei Fälle:
   Stufe 0 passt; Stufe 1 passt (genau ein Kodieraufruf); Stufe 2 passt (genau
   zwei, `format: "jpeg"`).
4. **Die Meldung ist handlungsfähig** (lokal). `screenshot_too_large` trägt die
   Bytes und Maße der letzten Stufe.
5. **Der Schalter schützt** (lokal). Aus ⇒ `screenshot_not_allowed`,
   `captureTab` null Mal aufgerufen. Beleg: der Fall mit
   `settings: { ...STORED_TAB_SETTINGS }` und `tabs.captureCalls.length === 0`,
   dazu die vier Fälle in `test/manifest.test.js`, die Checkbox, Label und
   Hinweistext („Bildschirmfotos", „Profil", „Postfach") im Block der Box pinnen.
6. **Keine Injektion** (lokal). `tabs.scriptCalls` bleibt in jedem
   `screenshot`-Fall leer.
7. **Ein Werkzeug mehr, und nur die Zählung ändert sich** (lokal). `tools/list` nennt
   `browser_screenshot`; `TOOL_COUNT = 13` (seit Spec 24: 12, seit Spec 32: 13). Beleg:
   `git diff -U0 test/mcp.test.js test/http-mcp.test.js | grep '^-'` zeigt
   ausschließlich: die vier Zähl-/Namenszeilen (`tools.length`, die zwei
   Namensarrays, `TOOL_COUNT`) und die Zeilen, in denen nur `ten`/`Ten` zu
   `eleven`/`Eleven` wird (Testname `…ExactlyTheTen…`, die drei Kommentare
   „exactly ten tools", „The ten tools of the contract" und „both offer the ten
   tools of the contract", `test/http-mcp.test.js:44` **und** `:339`) — sowie die
   drei Zähl-Kommentare, die der Code-Review als veraltet gemeldet hat
   (`eight schemas` in `bridge/mcp.mjs` und `test/mcp.test.js`, „the two tab
   tools are last but one"). Jede andere gelöschte Zeile ist ein Befund.
8. **Die Fehlerwege sind gepinnt** (lokal). `captureThrowsTimes: 1` ⇒ `ok` mit
   `activated: true`, genau zwei `captureTab`-Aufrufe und genau ein
   `tabs.update {active: true}`; `captureThrowsTimes: 2` ⇒ `screenshot_failed`
   ohne Stack; Tab 999 ⇒ `no_agent_tab`; `tab: "500"` ⇒ `invalid_params`; und der
   Agenten-Tab mit `active: true` plus `captureThrowsTimes: 1` ⇒ `ok` mit
   `activated: false` und **kein** `tabs.update` (der Guard aus C6). Beleg: die
   genannten Fälle in `test/extension.test.js`.
9. **Ein echtes Bild kommt heil an** (live, Kernannahme).
   `browser_screenshot` auf `https://example.org/` → `format: "png"`,
   `bytes > 0`, `width`/`height` plausibel (≥ 320), und der Base64-Teil ist
   dekodierbar (PNG-Kopf `89 50 4E 47`).
10. **Der Fallback läuft im echten Browser** (live). Auf einer fotolastigen Seite
   (etwa `https://en.wikipedia.org/wiki/Firefox`) wird entweder PNG oder — wenn
   die Aufnahme über 3 MiB liegt — `format: "jpeg"` mit `scaled: true`
   geliefert; `bytes ≤ 3145728`. Die gemessenen Zahlen stehen unter `## Messlauf`.
   Kein `screenshot_failed` und kein `screenshot_too_large` auf einer normalen
   Seite: die Leiter muss reichen.
11. **Das Log bleibt sauber** (live). Nach Kriterium 9 steht
    `screenshot tab=… bytes=… format=png scaled=false ok=true` im Journal, aber
    **kein** Base64-Fragment (`journalctl --user -u browser-control -n 200 |
    grep -c 'iVBORw0'` → `0`).
12. **Die Abnahme ist grün** (lokal). `npm test; echo $?` → `0` mit `# fail 0`
    **und** `# cancelled 0`; `npm run check; echo $?` → `0`;
    `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → keine Ausgabe, Exit 1;
    `git diff --exit-code extension/manifest.json` → 0.

## Dev plan

**Vorab, geprüft am Code (nicht angenommen):** `browser.tabs` hat heute **kein**
`captureTab` (`createTabsStub` in `test/extension.test.js` endet bei
`executeScript`/`update`/`get`/`create`/`remove`), `extension/background.js`
benutzt **kein** `atob`, `btoa`, `Uint8Array`, `Image` oder
`document.createElement` (die vielen `document.`-Treffer stehen ausschließlich in
eingefügten Snippet-**Strings**), und `createSandbox` gibt der VM nur `browser`,
`WebSocket`, `URL`, `fetch`, `AbortController`, `setTimeout`, `clearTimeout`,
`console`, `Math`. Es gibt **keinen** vorhandenen Helfer für Base64-Länge oder
PNG-Kopf — beides ist neu. Ein programmierbares `Image`/Canvas ist reine
Harness-Arbeit in `test/extension.test.js`.

1. **Methode in beiden Protokollkopien** — `extension/protocol.js` und
   `bridge/protocol.mjs`: `METHODS.SCREENSHOT: "screenshot"` als **letzter**
   Eintrag in `METHODS` (nach `EVAL`), beide Dateien in einem Schritt. Keine
   weiteren Konstanten dort (`SCREENSHOT_MAX_BYTES` bleibt in `background.js`,
   sonst müsste eine Zahl gespiegelt werden, die nur eine Seite liest).
   Proof: `node --test test/protocol.test.js` → `# fail 0`; der bestehende Fall
   `extensionProtocol_comparedToBridgeProtocol_shouldBeIdentical`
   (`deepStrictEqual` beider Kopien) wird grün nur, wenn **beide** Seiten den
   Schlüssel tragen. Neuer Fall nach dem Muster des `EVAL`-Falls:
   `PROTOCOL.METHODS.SCREENSHOT === "screenshot"` und
   `extensionProtocol.METHODS.SCREENSHOT === "screenshot"` — wörtlich zweimal,
   weil der Objektvergleich grün bleibt, wenn beide Kopien den Schlüssel
   verlieren.

   **Completed 2026-10-27**

2. **Der Schalter, nur die Verdrahtung** — `extension/options.html` (dritte
   Checkbox: `<input id="allowScreenshot" name="allowScreenshot"
   type="checkbox">` mit Label „Bildschirmfotos erlauben" und einem Hinweisblock,
   der „Bildschirmfotos", das eingeloggte Profil (Postfach, Warenkorb,
   Kontodaten) und den Ausschnitt-Charakter nennt), `extension/options.js`
   (`const ALLOW_SCREENSHOT = "allowScreenshot";`, `loadSettings` um den Schlüssel
   und `stored[ALLOW_SCREENSHOT] === true`, `handleSubmit` um
   `[ALLOW_SCREENSHOT]: readChecked(ALLOW_SCREENSHOT)`), `extension/background.js`
   (`const ALLOW_SCREENSHOT = "allowScreenshot";` neben `ALLOW_EVAL`, in diesem
   Schritt noch ungenutzt). `readChecked` bleibt unverändert. Diese Stufe ändert
   **kein** Verhalten — sie existiert, damit der Schalter vor der Aufnahme
   gepinnt ist.
   Proof: `node --test test/manifest.test.js` → `# fail 0`, mit vier neuen Fällen
   im Muster der `allowEval`-Fälle: Checkbox mit `type="checkbox"`
   (`optionsHtml_forTheScreenshotSwitch_shouldCarryACheckboxNamedAllowScreenshot`),
   Label „Bildschirmfotos erlauben", Hinweisblock geschnitten von
   `id="allowScreenshot"` bis `<button` (Hilfsfunktion `allowScreenshotBlockOf`,
   Gegenstück zu `allowEvalBlockOf`) und darin `/Bildschirmfotos/`, `/Profil/`,
   `/Postfach/`; `const ALLOW_SCREENSHOT = "allowScreenshot";` in `options.js`
   **und** `background.js`; `\[ALLOW_SCREENSHOT\]:\s*readChecked\(ALLOW_SCREENSHOT\)`
   und `stored\[ALLOW_SCREENSHOT\] === true`.

   **Completed 2026-10-27**

3. **Aufnahme, Kopfdaten, Grenze — ohne Verkleinerung** — `extension/background.js`:

   - Konstanten neben den `eval`-Konstanten: `SCREENSHOT_MAX_BYTES = 524288`,
     `SCREENSHOT_MESSAGE_LIMIT = 500`, `SCREENSHOT_NOT_ALLOWED_CODE/_MESSAGE`,
     `SCREENSHOT_TOO_LARGE_CODE`, `SCREENSHOT_FAILED_CODE/_MESSAGE`,
     `SCREENSHOT_PARAMS_MESSAGE`, `SCREENSHOT_OPTION_READ_FAILED_LOG_LINE`.
   - `screenshotAllowed()` — Zeile für Zeile der Zwilling von `evalAllowed` (nur
     `=== true` öffnet, Lesefehler zählt als aus, `console.warn` mit eigener
     Zeile).
   - `class ScreenshotError extends Error { code }`, `screenshotErrorFor(error)`,
     `answerScreenshot(target, request)` — genau die Form von
     `answerFocus`/`answerEval`.
   - `screenshotRequestParams(params)` — nur die Form von `tab`, Vorbild
     `focusRequestParams`; alles andere `invalid_params`.
   - `screenshotAgentTab(params)` — Reihenfolge **Schalter → Parameter → Tab →
     Aufnahme**, wie `evalAgentTab`; Tab über das vorhandene
     `addressedAgentTab(params, ScreenshotError)` (das bringt `no_agent_tab` und
     die `tab`-Typprüfung mit, keine zweite Meinung).
   - `captureTabOnce(tabId)` — `browser.tabs.captureTab(tabId, { format: "png" })`,
     Präfix abschneiden, **`dataUrl` und `base64` beide** zurückgeben (die Leiter
     in Stufe 4 braucht die Data-URL wieder; nur `base64` zu behalten ist die
     Falle).
   - `bytesOf(base64)` — `Math.floor(len * 3 / 4)` minus `=`-Padding, kein
     `Buffer`.
   - `pngSizeOf(base64)` — `atob(base64.slice(0, 32))` (24 Bytes reichen für den
     IHDR), Breite aus den Zeichen 16–19, Höhe aus 20–23, jeweils
     `<<24|<<16|<<8|` zusammengesetzt. Kein `Image`-Umweg nur für Maße;
     `readUInt32BE` gibt es im Browser nicht.
   - `captureAgentTab(tab)` — erster `captureTabOnce`, bei Fehler **einmal**
     `browser.tabs.update(tab.id, { active: true })` — aber **nur, wenn
     `tab.active !== true`**, sonst entfällt der Aufruf und der zweite Versuch
     läuft trotzdem — und ein zweiter `captureTabOnce`; zweiter Fehler ⇒ `screenshot_failed` mit
     `String(error?.message)` auf `SCREENSHOT_MESSAGE_LIMIT` gekürzt (kein Stack).
     Ergebnis `{tabId, url: asText(tab.url), title: asText(tab.title),
     format: "png", width, height, bytes, scaled: false, activated, base64}`.
   - Über der Grenze antwortet diese Stufe noch `screenshot_too_large` mit den
     Zahlen der Stufe 0 — **bewusst interim**; Stufe 4 ersetzt das durch die
     Leiter. Kein Vertragsbruch, sondern der Zustand, in dem ein zu großes PNG
     noch nicht verkleinert werden kann.
   - Dispatch: `if (request.method === PROTOCOL.METHODS.SCREENSHOT) { await
     answerScreenshot(target, request); return; }` **vor** dem `STATUS`-Rückfall
     in `answerRequest` (sonst `unsupported_method`).

   Harness in `test/extension.test.js`: `createTabsStub` bekommt `captureDataUrl`
   (Default: die 68-Byte-1×1-PNG-Data-URL), `captureThrowsTimes` (Zähler der
   ersten Fehlschläge — der Rückfall braucht „wirft einmal") und den Rekorder
   `captureCalls` (`{tabId, details}`); `createSandbox`, `startBackground`,
   `connectedBackground` reichen `atob` durch (Node hat ein echtes `atob`; es ist
   **nicht** gestubbt, nur in die VM gelegt — dieselbe Begründung wie bei
   `URL`/`fetch`).
   Proof: `node --test test/extension.test.js` → `# fail 0`, mit den Fällen:
   Kriterium 2 (Data-URL der 68-Byte-1×1-PNG ⇒ `format: "png"`, `scaled: false`,
   `bytes: 68`, `width: 1`, `height: 1`, `base64` ohne `data:`-Präfix); Grenze
   exakt (Base64 von genau 524 288 Bytes ⇒ `ok`, 524 289 ⇒ Stufe-0-Ablehnung mit
   `bytes=524289`); Kriterium 5 (`settings: { ...STORED_TAB_SETTINGS }` ohne
   `allowScreenshot` ⇒ `screenshot_not_allowed`, `tabs.captureCalls.length === 0`);
   `tab: "500"` ⇒ `invalid_params`; Tab 999 ⇒ `no_agent_tab`;
   `captureThrowsTimes: 1` ⇒ `ok` mit `activated: true`, `captureCalls.length === 2`,
   genau ein `{kind: "tabs.update", changes: {active: true}}` in `calls`;
   derselbe Fall mit einem **aktiven** Tab (`active: true`) ⇒ `ok` mit
   `activated: false`, `captureCalls.length === 2` und **kein** `tabs.update` in
   `calls` (der Guard aus C6);
   `captureThrowsTimes: 2` ⇒ `screenshot_failed`, Meldung ohne `\n`; und in
   **jedem** dieser Fälle `tabs.scriptCalls` leer (Kriterium 6).
   Die PNG-Fixture ist ein echter 1×1-PNG, 8 Bit, Farbtyp 4 (grau+Alpha):
   Signatur + IHDR(1,1) + IDAT + IEND = **68 Byte**; ihre Base64-Strecke ist 92
   Zeichen mit **einem** `=` (68 = 3·22 + 2). Daran prüft der Fall, dass `bytesOf`
   das Padding wirklich abzieht: `Math.floor(92 * 3 / 4) = 69`, ohne Subtraktion
   wäre das Ergebnis 69 statt 68.

   **Completed 2026-10-27**

4. **Die Leiter** — `extension/background.js`: `SCREENSHOT_SCALE_STEPS =
   [{maxEdge: null, format: "png"}, {maxEdge: 1600, quality: 0.75},
   {maxEdge: 1600, quality: 0.5}, {maxEdge: 1200, quality: 0.6}]`,
   `SCREENSHOT_ENCODE_TIMEOUT_MS = 3000` (Begründung in `## Risiken`), `encodeStep(dataUrl, step)`
   (`new Image()`, `onload`/`onerror` **vor** `img.src = dataUrl` setzen;
   Zielmaße = Quelle, nur herunterskalieren, längste Kante auf `step.maxEdge`,
   Seitenverhältnis erhalten; `document.createElement("canvas")`,
   `getContext("2d").drawImage(...)`, `toDataURL("image/jpeg", step.quality)`;
   `onerror` und `naturalWidth === 0` ⇒ `ScreenshotError(SCREENSHOT_FAILED_CODE)`),
   `shrinkToLimit(capture)` (Stufe 0 ist `capture` selbst — das PNG der
   Aufnahme, wenn es passt —, `shrinkToLimit` überspringt `SCREENSHOT_SCALE_STEPS[0]`
   deshalb und nimmt es nur als Beschreibung der Stufe; sonst je Stufe
   `Promise.race([encodeStep(...), guard.promise])` mit `const guard =
   guardAfter(SCREENSHOT_ENCODE_TIMEOUT_MS)` und `guard.cancel()` im `finally` —
   **eine** Frist pro Stufe, wie die Spec es verlangt, und der Timer wird über
   `guard.cancel()` entschärft, weil die Timer-Id in `guardAfter`s Closure liegt
   (dasselbe Muster wie `evalAgentTab`); Rückgabe des letzten Versuchs, damit die
   Meldung dessen Zahlen nennt). Der `screenshot_too_large`-Zweig aus Stufe 3 ruft jetzt `shrinkToLimit`
   und nennt Bytes und Maße des **letzten** Versuchs. Kein `executeScript`, kein
   Slot, kein `page_busy`.

   Harness: `createSandbox` bekommt `document` (nur `createElement(tag)`; alles
   andere wirft, damit ein versehentlich im Hintergrundrealm ausgeführter
   Seitenschnipsel weiter laut scheitert), `Image` und den Encoder-Stub. Der
   Encoder ist **programmierbar**: `createEncoderStub({ byteCounts })` liefert pro
   `toDataURL(type, quality)`-Aufruf den nächsten Byte-Wert, protokolliert
   `{type, quality, width, height}` in `encodeCalls` und gibt eine **echte**
   Base64-Strecke exakt dieser Länge zurück (`base64OfLength(n)`:
   `Math.floor(n/3)` volle Vierergruppen `"AAAA"`, Rest 1 ⇒ `AA==`, Rest 2 ⇒
   `AAA=`), **mit dem Format-Magic davor**: für `jpeg` lautet die Strecke
   `"/9j/" + base64OfLength(n - 3)`, für `png` `iVBORw0` + passende Füllung — so
   tragen Kopf-Pin (B2) und Längenbeweis zugleich, und `bytesOf` liefert weiter
   genau `n`. Damit prüft der Fall die Padding-Arithmetik von `bytesOf` statt sie
   zu unterstellen, und es steht **kein** Megabyte-Literal im Repo (wichtig für
   den Secret-Grep und den Diff). Das `Image` im Stub ruft `onload` synchron beim
   `src`-Setzen und trägt `naturalWidth`/`naturalHeight` aus einer Map, die der
   Canvas beim Erzeugen der Data-URL füllt; `decodeNeverFinishes: true` ist der
   Schalter für den Fristfall. `FakeTimerClock` bekommt additiv `armedDelays`
   (Historie im `setTimeout`, `pendingDelays` bleibt wie es ist) — ohne diese Spur
   ist „eine Frist pro Stufe" lokal nicht prüfbar, und die Historie stört keinen
   bestehenden Fall.
   Proof: Fälle nach den `eval`-Guard-Mustern: Quellbild 1600×900 mit 600 000
   Bytes (aus `pngOf({width: 1600, height: 900, bytes: 600000})`: echte Signatur +
   echter IHDR + Füllbytes, damit Breite/Höhe wirklich aus dem Kopf gelesen
   werden), Encoder liefert `[400000]` ⇒ `format: "jpeg"`, `scaled: true`,
   `bytes: 400000`, `encodeCalls.length === 1`, `encodeCalls[0].quality === 0.75`,
   `width: 1600`; `[600000, 450000]` ⇒ `encodeCalls.length === 2`,
   `encodeCalls[1].quality === 0.5`, `format: "jpeg"`; `[600000, 550000, 500000]`
   ⇒ `encodeCalls[2].width === 1200`, `height === 675`, `quality === 0.6`;
   `[600000, 550000, 530000]` ⇒ `screenshot_too_large` und `error.message`
   enthält `530000` und `1200 × 675`; `Image` mit `naturalWidth: 0` ⇒
   `screenshot_failed` (der Guard gegen `"data:,"`); Quellbild 800×450 ⇒
   `encodeCalls[0].width === 800` (kein Hochskalieren); `decodeNeverFinishes` +
   `clock.runByDelay(3000)` + `settleAsyncWork` ⇒ `screenshot_failed`, davor
   **keine** Antwort (`responsesById(socket).has(id) === false`, wie im
   `eval`-Guard-Fall); nach jedem Erfolgsfall
   `assert.deepStrictEqual(clock.pendingDelays(), [])` und
   `clock.armedDelays.filter((d) => d === 3000).length === encodeCalls.length`.

   **Completed 2026-10-27**

5. **Das Werkzeug in der Bridge, samt der vier Zähl-Pins** — `bridge/mcp.mjs`:
   `const BROWSER_SCREENSHOT = "browser_screenshot";`, elfter `TOOLS`-Eintrag
   **angehängt** (Position 10) mit dem wörtlich aus der Spec kopierten
   Beschreibungstext und `inputSchema: { type: "object", properties: { tab:
   TAB_PROPERTY }, additionalProperties: false }`,
   `UNEXPECTED_ARGUMENTS[BROWSER_SCREENSHOT]`, `TOOL_TEXTS.SCREENSHOT_NOT_ALLOWED`,
   `.SCREENSHOT_FAILED` (+ `_WITH_MESSAGE`-Variante wie `EVAL_FAILED_WITH_MESSAGE`,
   weil die Browser-Meldung die einzige handlungsfähige Information ist),
   `.SCREENSHOT_TOO_LARGE` (+ Variante, die `details.message` der Extension
   durchreicht — die trägt Bytes und Maße und ist damit die Zahl, die der Agent
   braucht), `INVALID_SCREENSHOT_PARAMS`; `case BROWSER_SCREENSHOT: return
   screenshotTool(id, params, context);` in `callTool`, `screenshotTool` als
   Einzeiler über `optionalArgumentsTool` mit `allowedArguments: TAB_ARGUMENTS`
   und `request: (hub, tab) => hub.request(PROTOCOL.METHODS.SCREENSHOT,
   withOptionalTab({}, tab))` (Vorbild `focusTool`; prüfen, ob
   `optionalArgumentsTool` `error.details` schon durchreicht, statt einen zweiten
   `catch` zu bauen), `extensionFailureText` um `if (toolName ===
   BROWSER_SCREENSHOT) return screenshotFailureTextFor(code, details);` und
   `screenshotFailureTextFor` (Vorbild `evalFailureTextFor`, aber **ohne**
   `page_busy`/`not_readable`: die gibt es hier nicht). `details.message` nur über
   `nonEmptyString` einsetzen, nie ungeprüft.

   Zähl-Pins, die sich ändern dürfen und **nur** diese: `test/mcp.test.js`
   `assert.equal(tools.length, 10)` → `11`, das Namensarray in
   `mcp_toolsList_shouldOfferExactlyTheTenTools…` (auch der Testname nennt „Ten"
   und wird zu „Eleven"), `test/http-mcp.test.js` `const TOOL_COUNT = 10;` → `11`
   und das Namensarray; dazu `tools[10]`-Behauptungen (Name, Beschreibung, Schema,
   `additionalProperties: false`). `test/fixtures/fake-extension.mjs` bekommt
   `SCREENSHOT_RESULT` (`tabId: 20` — eine eigene Zahl, damit eine Logzeile aus
   dem falschen Ergebnis auffällt), `BC_TEST_SCREENSHOT_ANSWER`,
   `screenshotResponse` und den `case "screenshot"` in `responseFor`; der
   Kopfkommentar der Fixture zählt die Methoden auf und wird mitgezogen.
   Proof: `node --test test/mcp.test.js test/http-mcp.test.js` → `# fail 0`; neuer
   Fall `mcp_toolsCallBrowserScreenshot_shouldReturnTheBase64ResultAsText` (fake
   extension, Antwort `SCREENSHOT_RESULT` ⇒ Textblock =
   `JSON.stringify(SCREENSHOT_RESULT, null, 2)`, `isError` undefiniert), plus
   `SCREENSHOT_REFUSAL_CASES` im Muster von `EVAL_REFUSAL_CASES` für
   `screenshot_not_allowed`, `screenshot_failed`, `screenshot_failed` mit
   Message, `screenshot_too_large` **mit** `details: { message: "Das Bild ist
   auch nach dem Verkleinern zu groß: 611400 Bytes bei 1200 × 675 (Grenze
   524288)." }` **und** einmal **ohne** `details` (Rückfall auf den generischen
   Satz) — beide Fälle pinnen die ganze Antwortzeile per `deepEqual`, nicht per
   `includes`.

   **Completed 2026-10-27**

6. **Die Hub-Logzeile** — `bridge/hub.mjs`: `formatScreenshotLine(result)` →
   `screenshot tab=4 bytes=214311 format=jpeg scaled=true ok=true` (`ok` als
   Literal `true`, Vorbild `formatEvalLine`; fehlende Felder als `NO_FIELD`),
   `#reportScreenshot(result)` mit **nur** dieser Zeile und ausdrücklich **ohne**
   `#logDebugResult` (das Base64 wäre nicht nur eine Zeile, sondern ein Bild im
   Journal — dieselbe Regel wie bei `eval`), und der Zweig in `#reportResult`
   nach `EVAL` (`entry.method === PROTOCOL.METHODS.SCREENSHOT`) — ohne Zweig
   schreibt `#reportResult` gar nichts.
   Proof: `node --test test/hub.test.js` → `# fail 0`; zwei Fälle nach
   `hub_eval_shouldLogOnlyTabElapsedAndOk`: der Auflösungsfall
   (`hub.request(PROTOCOL.METHODS.SCREENSHOT, { tab: 4 })`, Antwort per
   `responseFrame`, `assert.deepEqual(await pending, result)`,
   `waitForLogLine((line) => line === "screenshot tab=4 bytes=214311 format=jpeg scaled=true ok=true")`)
   und derselbe Fall mit `startHubServer(t, { BC_LOG: "debug" })`, in dem
   zusätzlich gilt: genau **eine** Zeile beginnt mit `"screenshot "`, und
   `logLines.join("\n")` enthält weder `iVBORw0` noch `/9j/` — der lokale
   Zwilling von Kriterium 11.

   **Completed 2026-10-27**

7. **Abnahme und Übergabe** — keine Produktcodeänderung mehr. `npm test`,
   `npm run check`, der Secret-Grep und `git diff --exit-code
   extension/manifest.json` aus `CONTRIBUTING.md`, `## Acceptance`; dazu ein Blick auf
   `git diff --stat`, dass die Touch-Boundary hält (`extension/manifest.json`,
   `bridge/{websocket,config,bridge,http-transport}.mjs`, `INSTALL.md`,
   `CONTRIBUTING.md` und alle `docs/` unberührt).
   Proof: `npm test; echo $?` → `0`, Ausgabe enthält `# fail 0` **und**
   `# cancelled 0` (einzeln prüfen, nicht nur `# fail 0`); `npm run check; echo $?`
   → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → keine Ausgabe, Exit 1;
   `git diff --exit-code extension/manifest.json` → 0. Ein abgelaufener Test
   zählt als `cancelled` und lässt `# fail 0` grün — der Fristfall aus Stufe 4
   ist genau die Sorte Fall, die so durchrutscht, also `# cancelled 0` mitlesen.
   `status: active`, Prosa und `docs/README.md`/`PROJECT-STATE.md` macht der
   Orchestrator (Schritt 7); der Umsetzer fasst die Spec nicht an.

   **Completed 2026-10-27**: `npm test` → 515 Fälle, `# fail 0`,
   `# cancelled 0`, Exit 0 (mit `--test-timeout=120000`);
   `npm run check` → 0; Secret-grep → keine Ausgabe, Exit 1;
   `git diff --exit-code extension/manifest.json` → 0. Die
   Live-Kriterien 9, 10 und 11 stehen aus — sie brauchen den Reload
   der Erweiterung, den Schalter „Bildschirmfotos erlauben“ und
   einen pi-Neustart, also den Betreiber.

### What could go wrong

- **Der Harness ist an drei Stellen die Behauptung, nicht der Beweis.** (a)
  `toDataURL` liefert im Stub **erfundene** Bytes — die Fälle beweisen, *welche*
  Stufe genommen wurde, mit welcher Qualität und welchen Zielmaßen, und dass
  `bytesOf` richtig zählt. Sie beweisen **nicht**, dass ein JPEG eines
  fotolastigen Viewports unter 512 KiB fällt; das ist Kriterium 10 und nur live.
  (b) `Image.onload` feuert synchron: der Stub beweist nichts über echtes
  Dekodieren, DPI oder Speicher. (c) `drawImage` zeichnet nichts: die
  Seitenverhältnis-Arithmetik wird an Stub-Maßen geprüft, die aus einem echten
  IHDR stammen — die Pixel sind es nicht. Wer diese Grenze verwischt, hat einen
  grünen Lauf und ein Werkzeug, das im Profil `screenshot_failed` liefert.
- **Zwei echte Firefox-Eigenschaften, die kein lokaler Fall sehen kann.**
  `captureTab` liefert auf HiDPI die Gerätepixel (2× Kante) — `width`/`height`
  aus dem IHDR sind dann doppelt so groß wie der CSS-Viewport, und die
  1600-px-Stufe greift entsprechend früher. Und `canvas.toDataURL` auf einem
  Canvas der Größe 0 (weil `naturalWidth` aus einem misslungenen Dekodieren 0
  ist) ergibt `"data:,"`; die Leiter würde daraus Bytes von 0 lesen und „passen"
  melden. Beides ist im Stub unsichtbar; Kriterium 9/10 sind die einzigen
  Wächter. Ein Guard (`naturalWidth > 0`, sonst `screenshot_failed`) ist billig
  und gehört dazu.
- **`dataUrl` verlieren.** Die Spec sagt „Präfix abschneiden, Base64 behalten",
  die Leiter braucht die Data-URL aber wieder. Wer `captureTabOnce` nur `base64`
  zurückgeben lässt, baut das Präfix zweimal zusammen — und beim zweiten Mal mit
  falschem Mime, was im Stub (der jedes `src` akzeptiert) grün bleibt und im
  Browser scheitert.
- **`onload` nach `src` setzen.** Beim synchronen Stub ist das egal, im echten
  Browser nicht: ein bereits gecachtes `data:`-Bild kann vor der Zuweisung des
  Handlers fertig sein, und der Aufruf hängt bis zur Frist. Der Fall mit
  hängendem Dekodieren deckt nur die Frist ab, nicht die Reihenfolge; die
  Reihenfolge gehört als Kommentar in den Code.
- **Die Frist pro Stufe ist im Stub nur halb prüfbar.** Mit synchronem `onload`
  feuert nie eine Frist im Erfolgsfall; „eine Frist pro Stufe" wird über
  `armedDelays` gezählt, nicht über echtes Warten. Wer eine Frist um die ganze
  Leiter legt, bleibt grün, wenn er die Historie nicht prüft.
- **Die Testdatei wächst.** `test/extension.test.js` hat schon ~358 KB. Die neuen
  Fixtures müssen generiert werden (`pngOf`, `base64OfLength`), nicht als
  Literale hinein — ein 524 289-Byte-Fixture als String wäre ein Diff von 700 KB
  und könnte außerdem zufällig einen 32-stelligen Hex-Lauf enthalten, den der
  Secret-Grep dann meldet.
- **Ein zweiter Fehlertext.** Die Bridge darf die Zahlen bei
  `screenshot_too_large` nicht selbst formatieren; sie stehen in
  `details.message` der Extension. Zwei Formatierungen wären zwei Wahrheiten über
  dieselbe Messung — dieselbe Falle, die `eval_failed` mit der Seitenmeldung
  schon einmal gelöst hat.

### Ordering and dependencies

Jede Stufe ist für sich grün und hängt nur an früheren: 1 (Methode) → 2
(Schalter-Verdrahtung) → 3 (Aufnahme und Grenze, ohne Verkleinerung) → 4 (Leiter)
→ 5 (Werkzeug) → 6 (Hub-Zeile) → 7 (Abnahme). Die Reihenfolge ist bewusst so,
dass **Kriterium 5 ohne `captureTab`-Aufruf** prüfbar wird: Stufe 2 pinnt die drei
Literale, Stufe 3 pinnt die Ablehnung mit `captureCalls.length === 0` — also
*bevor* irgendein Kodierpfad existiert. Der Schalter steht in `screenshotAgentTab`
**vor** Parametern und Tab, damit ein ausgeschalteter Aufruf gar nichts erst
auflöst.

Kriterium 1 und Kriterium 3 werden erst in **Stufe 4** grün: Stufe 3 antwortet
über der Grenze bewusst noch `screenshot_too_large` mit den Zahlen der Stufe 0,
und Stufe 4 ersetzt genau diesen Zweig durch die Leiter — der Interim-Fall wird
ersetzt, nicht behalten.

Die Bridge (5) hängt nicht an der Hub-Zeile (6): `hub.request(method, params)` ist
generisch, und ohne `#reportResult`-Zweig schreibt der Hub nur keine Zeile — der
Werkzeugfall bleibt grün. Umgekehrt braucht 6 den Erfolgsfall aus 5 nicht; die
Hub-Fälle sprechen den Socket direkt. Stufe 5 zieht die vier Zähl-Pins **im selben
Schritt** nach, in dem das elfte Werkzeug entsteht — ein roter Zähl-Pin darf keine
Stufe überleben.

### What the next increment inherits

- **Teil 2 (Roadmap 12): `type: "image"`.** `textResultMessage` in
  `bridge/mcp.mjs` ist die Stelle, an der aus dem Base64 ein Bildinhalt wird;
  `screenshot`-Methode, Leiter, Grenze, Schalter und Logzeile bleiben unverändert.
  Offen und hier ausdrücklich **nicht** entschieden: ob die 512 KiB dann noch die
  richtige Grenze sind (ein Bildinhalt im MCP-Frame wird nicht base64-verpackt) —
  das ist eine Betreiberfrage der nächsten Spec.
- **Ganze Seite / `rect` / `scale`.** `SCREENSHOT_SCALE_STEPS` und
  `captureAgentTab` sind so gebaut, dass ein vierter Parameter dort anschließt;
  `captureTab`s `rect` und `scale` sind bewusst ungenutzt (Non-goals).
- **Der Harness.** `createTabsStub.captureCalls`, der programmierbare
  Encoder-Stub, `pngOf`/`base64OfLength`, `atob` in `createSandbox` und
  `FakeTimerClock.armedDelays` sind ab jetzt Allgemeingut: jede spätere Bild-
  oder Canvas-Arbeit erbt sie, und ein späterer Fall, der nur `toDataURL`-Längen
  prüft, sollte den Kommentar aus Stufe 4 mitlesen, der sagt, was daran Behauptung
  ist.
- **Nicht geerbt:** `page_busy`/`not_readable` für `screenshot` (kein
  `executeScript`), ein Cache oder eine Ablage auf Platte, ein Fokusgriff außer
  dem einen Rückfall in `captureAgentTab`, und jede Änderung an
  `extension/manifest.json`.


## Risiken

- **`captureTab` kann einen Fokuswechsel erzwingen.** Auf manchen Plattformen
  fotografiert Firefox nur den aktiven Tab; dann holt der Rückfall den
  Agenten-Tab nach vorn und der Betreiber sieht ihn. Deshalb steht `activated`
  in der Antwort und der Grund hier.
- **Verkleinern kostet Zeit.** Drei Stufen mit `Image`-Dekodierung können
  zusammen einige hundert Millisekunden brauchen; die Frist pro Stufe
  (`3000 ms`) hält den Aufruf begrenzt, aber ein sehr großes Bild kann in
  `screenshot_failed` laufen, obwohl eine vierte Stufe geholfen hätte.
- **JPEG auf Text ist unscharf.** Ein verkleinertes JPEG ist für „was steht da"
  gedacht, nicht für „lies den Absatz" — dafür bleibt `browser_read`.
- **Base64 bläht um 33 % auf.** Die Grenze ist an den dekodierten Bytes gezogen;
  am Draht wären 512 KiB schon 700.
- **Ein Screenshot ist eine Datenschutz-Entscheidung.** Deshalb der Schalter,
  Default aus: das Bild kann ein Postfach zeigen.

## Touch boundary

Angefasst: `extension/protocol.js`, `bridge/protocol.mjs`, `extension/background.js`,
`bridge/hub.mjs`, `bridge/mcp.mjs`, `extension/options.html` + `.js`,
`test/{protocol,manifest,mcp,hub,extension,http-mcp}.test.js`,
`test/fixtures/fake-extension.mjs`.

**Nicht** angefasst: `extension/manifest.json`, `bridge/{websocket,config,bridge,http-transport}.mjs`,
`INSTALL.md`, `CONTRIBUTING.md` (die Passwortfeld-Regel bleibt, wie Spec 19 sie
hinterlassen hat — der Bildschirmfoto-Schalter ist kein Passwortthema), andere
Specs.

## Bekannte Lücken

Stand 2026-10-27, nach den Stufen 1–6 und dem Code-Review:

- **Drei Stufenfristen liegen dicht unter der Hub-Frist** (2026-10-27,
  Code-Review): `3 × SCREENSHOT_ENCODE_TIMEOUT_MS` = 9 s gegen
  `PROTOCOL.CALL_TIMEOUT_MS` = 20 s, dazu zwei Aufnahmen. Hängen alle drei
  Dekodierungen, antwortet der Hub `ExtensionTimeout` statt `screenshot_failed`.
  Kein Vertragsbruch — die Leiter endet, nur später als der Hub wartet —, aber
  die Meldung nennt dann die falsche Ursache.
- **Der hoffnungslose Fokus-Fall ist offen** (2026-10-27, Spec): liegt der
  Agenten-Tab hinten und ist die Seite nicht fotografierbar (PDF-Viewer,
  `view-source:`), holt der Rückfall den Tab nach vorn und meldet danach
  `screenshot_failed`. Behoben ist nur „Tab ist schon vorn" (kein sinnloser
  `tabs.update`); die Ursache des ersten Fehlers zu lesen wäre gegen Spec 10
  (Rejection-Texte sind kein Vertrag).
- **Keine offene Live-Lücke** (2026-10-27): die Kriterien 9, 10 und 11 sind im
  Betreiber-Profil gemessen (siehe `## Messlauf`). Was der Messlauf **nicht**
  zeigt: die Stufen 2 und 3 der Leiter (q = 0,5 und 1200 px) wurden live nicht
  erzwungen, nur Stufe 1; und ein Bild, das auch nach Stufe 3 zu groß bleibt, ist
  im Sandkasten belegt, nicht im echten Profil.

## Open questions

Keine offenen mehr. Beantwortet vom Betreiber am 2026-10-27:

1. **Eigener Schalter `allowScreenshot`, Default aus** — ein Bild zeigt das
   eingeloggte Profil, also mehr als jeder Text.
2. **Verkleinern statt nur ablehnen**: Leiter aus PNG → JPEG q = 0,75 (max.
   1600 px) → q = 0,5 → max. 1200 px bei q = 0,6; erst danach
   `screenshot_too_large`.
3. **Nur der sichtbare Viewport**; eine ganze Seite ist ein eigenes Inkrement.

## Messlauf (2026-10-27, Betreiber-Profil)

Gemessen über den systemd-Dienst (`curl` gegen `http://127.0.0.1:8111/mcp`), nach
Reload der Erweiterung und mit eingeschaltetem Schalter „Bildschirmfotos
erlauben", im Agenten-Tab 4:

- **Der Schalter wirkt live.** Vor dem Einschalten antwortete `browser_screenshot`
  mit `screenshot_not_allowed` („Bildschirmfotos sind in den Einstellungen der
  Erweiterung nicht erlaubt — erst dort einschalten."), ohne `captureTab`
  aufzurufen. Nach dem Umstellen wirkte es sofort, ohne Reload.
- **Kriterium 9 grün.** `https://example.org/` → `format: "png"`,
  `width: 1904`, `height: 853`, `bytes: 99232`, `scaled: false`,
  `activated: false`; der Base64-Teil (132 312 Zeichen) dekodiert zu 99 232 Byte
  mit PNG-Kopf `89 50 4E 47`.
- **Kriterium 10 grün.** `https://en.wikipedia.org/wiki/Firefox` → `format:
  "png"`, `bytes: 376084`, `scaled: false` — unter der Grenze, die Leiter wurde
  nicht gebraucht. Den Fallback erzwungen auf demselben Tab mit einem
  verrauschten Canvas (1904 × 853, Zufallsbytes über `eval`): `format: "jpeg"`,
  `width: 1600`, `height: 717`, `bytes: 329865`, `scaled: true`, JPEG-Kopf
  `ff d8 ff e0`. **Stufe 1 der Leiter hat live getragen**; Stufen 2 und 3 sind
  im Sandkasten gepinnt, nicht live erzwungen.
  Ein erster Versuch mit einem regelmäßigen Muster (`(n * 7) % 256` …) ergab ein
  winziges PNG — das Muster wiederholt sich alle 64 Pixel und komprimiert
  entsprechend. Erst der LCG-Zufall erzeugte ein Bild, das über die Grenze geht;
  wer den Fallback live nachstellen will, braucht echten Zufall.
- **Kriterium 11 grün.** Im Journal stehen genau die erwarteten Zeilen
  (`screenshot tab=4 bytes=99232 format=png scaled=false ok=true`, …,
  `screenshot tab=4 bytes=329865 format=jpeg scaled=true ok=true`), und
  `grep -cE "iVBORw0|/9j/"` über die letzten 300 Zeilen → **0**.

## Review

### Runde 1, 2026-10-27 — `🔧 Fix these` (Blocker dabei)

Geprüft gegen `spec-doc-review`, `CONTRIBUTING.md` und `docs/README.md`. Die
Dev-Plan-Zitate wurden am Code gegengeprüft und stimmen: `createTabsStub` ohne
`captureTab`, `createSandbox` ohne `atob`, `optionalArgumentsTool` reicht
`error.details` bereits durch, die vier Werkzeugzähl-Pins liegen wie benannt,
`allowEvalBlockOf`, `guardAfter`, `pendingDelays`, `EVAL_RESULT` und
`EVAL_REFUSAL_CASES` existieren. Auch die Zahlen halten: 68-Byte-1×1-PNG, Base64
92 Zeichen mit einem `=`, 699 051 Byte Base64 unter der 1-MiB-Framegrenze
(`websocket.mjs` bricht mit `1009`). Touch-Boundary ist korrekt, `CONTRIBUTING.md`
bleibt zu Recht unberührt.

Blockierend: `scaled` widerspricht sich (Prosa gegen das Wire-Beispiel und den
Plan-Fall), `base64` ist nirgends als das gelieferte Bild gepinnt,
`screenshot_failed` und der `activated`-Rückfall haben kein Abnahmekriterium,
AC 5 und AC 7 tragen Nicht-Kriterien, AC 10 zitiert die Logzeile ohne `scaled=`.
Dazu sieben Einzeiler (NaturalWidth-Guard ohne Fall, `clearTimeout` vs.
`guard.cancel()`, Zahlen ohne Quelle/Einheit, AC 1/3 erst ab Stufe 4,
`## Messlauf`-Verweis, Fokus-Rückfall bei hoffnungslosem Fall, fehlender
`too_large`-Fall ohne `details`).



### Runde 2, 2026-10-27 — `🔧 Fix these` (Blocker dabei)

B1–B13 am Text nachgeprüft, nicht an der Zusammenfassung. Übernommen und in
Ordnung: `scaled` (eine Definition, konsistent mit Wire-Beispiel und Plan-Fall),
`base64` als das gelieferte Bild, Kriterium 8 mit Belegen, AC 5/AC 7 mit Befehl
statt Behauptung, AC 11 feldgleich mit `## Hub`, `naturalWidth`-Fall an beiden
Stellen, `guardAfter`/`guard.cancel()`, `## Messlauf`, beide `too_large`-Varianten.
Sechs Reste: die Live-Kriterien hießen in der Ausnahme noch „8, 9 und 10" statt
„9, 10 und 11" (C1), `### What could go wrong` verwies für den Live-JPEG-Beweis
auf Kriterium 9 statt 10 (C2), AC 8 zählte „fünf Fälle" für vier benannte Wege
(C3), der `/9j/`-Pin aus B2 war gegen den `base64OfLength`-Encoder-Stub nicht
erfüllbar (C4), AC 7s Whitelist übersah den umbenannten Testnamen und die
„ten tools"-Kommentare (C5), und der neue Fokus-Guard hatte weder Fall noch
AC-Zeile, während seine Begründung den PDF-Fall nicht deckte (C6). Dazu drei
Kleinigkeiten ohne Entscheidungswert (C7–C9).


### Runde 3, 2026-10-27 — `✅ Ship it` (kein Blocker)

C1–C9 am Text nachgeprüft, nicht an der Log-Zusammenfassung. Alle neun halten:
die Ausnahme nennt „9, 10 und 11" und AC 8 ist `(lokal)` (C1); `### What could
go wrong` verweist für den Live-JPEG-Beweis auf Kriterium 10 (C2); AC 8 zählt
fünf benannte Wege statt „fünf Fälle für vier" (C3); der Encoder-Stub stellt
`"/9j/"` voran, und `bytesOf("/9j/" + base64OfLength(n - 3))` ergibt für alle
drei Restklassen exakt `n` (C4, nachgerechnet); AC 7s Whitelist nennt Testname
und die „ten tools"-Kommentare (C5, ein Rest: D3); der Fokus-Guard hat Fall,
AC-Zeile und in `## Ziel` den offen benannten, nicht behobenen PDF-Fall samt
Grund (C6); die 12-Byte-Zeile steht in `## Testing` (C7); 699 052 Byte (C8,
4·⌈524288/3⌉) und 611400 an beiden Stellen (C9). Keine neuen Widersprüche:
AC 1–12 gegen Ausnahme und `## Messlauf`, Leitertabelle gegen
`SCREENSHOT_SCALE_STEPS`, `format`/`scaled`/`bytes` gegen Wire-Beispiel und
Plan-Fälle, `## Testing` gegen beide Proof-Listen. Am Code bestätigt:
`EVAL_MESSAGE_LIMIT = 500`, `MAX_MESSAGE_BYTES = 1048576` mit `1009`,
`optionalArgumentsTool` reicht `error.details` bereits durch, die vier
Zähl-Pins, `createTabsStub` ohne `captureTab`.

Vier Reste ohne Entscheidungswert, die der Orchestrator als Zeilen übernimmt:
D1 (Guard-Bedingung fehlte in Stufe 3 und der Guard-Fall in `## Testing`), D2
(Signaturprüfung ohne Fall; „12-Byte" mehrdeutig), D3 (`http-mcp.test.js:339`
nicht in AC 7s Whitelist), D4 (Tippfehler „Eilfter"). Kein dritter Block, also
kein Teilungsgrund.

### Code-Review 1, 2026-10-27 — `✅ Ship it` (kein Blocker)

Geprüft gegen `review-changes`, `CONTRIBUTING.md`, `docs/README.md` und diese Spec,
am Diff gegen `b16cbef` (14 Dateien, +1835/−24, keine untracked). Abnahme selbst
gefahren: `npm test` 512 Tests, `# fail 0`, `# cancelled 0`, Exit 0; `npm run
check` 0; Secret-Grep ohne Ausgabe, Exit 1; `git diff --exit-code
extension/manifest.json` 0; `docs/`, `CONTRIBUTING.md`, `INSTALL.md` unberührt.

Getragen: der Schalter (Prüfung vor jeder Aufnahme, `captureCalls` als Beleg),
die Leiter (Stufe 0 ohne Kodieraufruf, `bytes`/`width`/`height` des gelieferten
Bildes, `base64` mit dem Magic seines `format`, `screenshot_too_large` mit den
Zahlen der letzten Stufe, `guard.cancel()` je Stufe über `armedDelays`
widerlegbar gepinnt), die Kopfdaten (`bytesOf` mit Padding-Abzug am 68-Byte-Fall,
`pngSizeOf` mit Signatur- und Längenprüfung statt `0 × 0`), der Fokus-Rückfall
(zweiter Versuch nur nach Fehler, `tabs.update` nur bei `active !== true`,
`activated` ehrlich, Guard-Fall vorhanden), die Log-Hygiene (`ok` als Literal,
kein `#logDebugResult`, Debug-Fall ohne `iVBORw0`/`/9j/`), AC 7 per Befehl, und
kein `executeScript`, kein Slot, kein `page_busy`/`not_readable`.

Acht Zeilen als Follow-up (R1–R8, siehe `## Log`) — keine blockiert.

## Log

Runde 1 des Spec-Reviews — alle 13 Befunde übernommen:

- **B1** (`scaled: true` widersprach dem Wire-Beispiel: bei 1:1-Rekodierung sind
  die Maße die der Aufnahme) — übernommen: `scaled` heißt „neu kodiert, nicht
  mehr das PNG der Aufnahme"; die Maße können gleich bleiben, und der Satz sagt,
  warum ein Agent das nicht als „weniger Pixel" lesen darf.
- **B2** (`base64` war nirgends als das gelieferte Bild gepinnt) — übernommen:
  Satz in `## Ziel` („`base64` ist immer das Bild, das `format`, `width`,
  `height` und `bytes` beschreiben"), und die Testing-Zeile pinnt die Köpfe
  (`iVBORw0` bei Stufe 0, `/9j/` bei Stufe 1).
- **B3** (`screenshot_failed`, `activated`, `no_agent_tab`, `invalid_params`
  hatten kein Kriterium) — übernommen als neues **Kriterium 8**; die alten
  8–11 sind 9–12.
- **B4** (AC 5 und AC 7 trugen Nicht-Kriterien: ein `grep`-Halbsatz und eine
  Behauptung ohne Befehl) — übernommen: AC 5 nennt die vier manifest-Fälle und
  den `captureCalls`-Beleg, AC 7 hat einen Befehl
  (`git diff -U0 … | grep '^-'` zeigt nur die vier Zähl-/Namenszeilen).
- **B5** (AC 10 zitierte die Logzeile ohne `scaled=`) — übernommen, jetzt exakt
  wie in `## Hub`.
- **B6** (`naturalWidth > 0` war „gehört dazu", ohne Fall) — übernommen: eine
  Testing-Zeile und ein Fall im Plan-Proof („`Image` meldet `naturalWidth: 0` ⇒
  `screenshot_failed`").
- **B7** (der Fokus-Rückfall feuerte auch bei hoffnungslosem Fall und kostete
  dem Betreiber den Tab) — übernommen: `tabs.update` nur, wenn der Tab nicht
  schon aktiv ist; der Grund steht in `## Ziel`.
- **B8** (`pngSizeOf` ohne Fehlerfall, Stufe 0 doppelt dargestellt) —
  übernommen: fehlende Signatur oder Strecke unter 24 Byte ⇒ `screenshot_failed`;
  `shrinkToLimit` überspringt `SCREENSHOT_SCALE_STEPS[0]` und nimmt es nur als
  Beschreibung.
- **B9** (der Plan verlangte `clearTimeout` im `finally`, obwohl die Timer-Id in
  `guardAfter`s Closure liegt) — übernommen: `const guard = guardAfter(…)` mit
  `guard.cancel()`, wie in `evalAgentTab`.
- **B10** (zwei Zahlen ohne Quelle, „699 KiB" als Einheitenrutsch) —
  übernommen: `SCREENSHOT_MESSAGE_LIMIT` mit Quelle (`EVAL_MESSAGE_LIMIT`), die
  Frist mit Verweis auf `## Risiken`, und 699 051 Byte (≈ 683 KiB) statt „699 KiB".
- **B11** (AC 1 und AC 3 sind erst ab Stufe 4 grün) — übernommen: Satz unter
  `### Ordering and dependencies`, der den Interim-Zweig benennt, der ersetzt
  wird.
- **B12** (`## Messlauf` wurde referenziert, existierte nicht) — übernommen: der
  Abschnitt steht jetzt mit „noch keine Messung" und den Feldern, die einzutragen
  sind.
- **B13** (der Bridge-Fall `screenshot_too_large` ohne `details` fehlte) —
  übernommen: `SCREENSHOT_REFUSAL_CASES` bekommt beide Varianten.

Runde 2 des Spec-Reviews — alle neun Befunde übernommen (C1–C9), damit ist die
Runden-Regel aus `CONTRIBUTING.md` erreicht:

- **C1** (Ausnahmesatz nannte „8, 9, 10"; Kriterium 8 ist lokal) — übernommen:
  „9, 10 und 11", deckungsgleich mit `## Messlauf`.
- **C2** (Verweis auf Kriterium 9 statt 10 für den Live-JPEG-Beweis) —
  übernommen.
- **C3** (AC 8 zählte fünf Fälle für vier Wege) — übernommen und die Wege in der
  Kriterienzeile aufgezählt.
- **C4** (der `/9j/`-Pin war gegen einen `"AAAA…"`-Stub unerfüllbar) —
  übernommen: der Encoder-Stub stellt das Format-Magic voran
  (`"/9j/" + base64OfLength(n - 3)`), Kopf-Pin und Längenbeweis tragen beide.
- **C5** (AC 7s Whitelist übersah Testname und „ten tools"-Kommentare) —
  übernommen: die Whitelist nennt beides ausdrücklich.
- **C6** (der Fokus-Guard hatte keinen Fall und seine Begründung deckte den
  PDF-Fall nicht) — übernommen: ein Fall (Tab aktiv, erster `captureTab` wirft ⇒
  `activated: false`, kein `tabs.update`), AC 8 nennt ihn, und `## Ziel` sagt
  jetzt offen, dass der hoffnungslose PDF-Fall **nicht** abgedeckt ist und warum
  (die Rejection-Texte sind laut Spec 10 kein Vertrag).
- **C7** (der `pngSizeOf`-Fehlerfall war Vertrag ohne Fall) — übernommen: eine
  Testing-Zeile mit 12-Byte-Base64 ⇒ `screenshot_failed`.
- **C8** (699 051 statt 699 052) — übernommen.
- **C9** (698 112 Byte für ein 1200 × 675 JPEG war unrealistisch) — übernommen:
  611 400, in beiden Beispielen.

Runde 3 des Spec-Reviews — Gate mit `✅ Ship it` geöffnet; die vier Reste als
Zeilen übernommen (D1–D4):

- **D1** (Stufe 3 beschrieb den Fokusgriff ohne die Bedingung „Tab nicht aktiv",
  und der Guard-Fall fehlte in `## Testing` und im Stufen-Proof) — übernommen:
  Bedingung in Stufe 3, Guard-Fall in `## Testing` (aktiver Tab ⇒ `activated:
  false`, kein `tabs.update`) und in der Proof-Liste.
- **D2** (die Signaturprüfung aus `## Extension` hatte keinen Fall, und „12-Byte"
  war zwischen Zeichen und Bytes mehrdeutig) — übernommen: zwei Zeilen (16
  Base64-Zeichen = 12 dekodierte Bytes ⇒ `screenshot_failed`; 40 dekodierte Bytes
  ohne PNG-Signatur ⇒ `screenshot_failed`).
- **D3** (AC 7s Whitelist nannte `http-mcp.test.js:44`, nicht `:339`) —
  übernommen, beide Stellen und alle drei Kommentare stehen in der Whitelist.
- **D4** (Tippfehler „Eilfter") — übernommen.

Code-Review Runde 1 — `✅ Ship it`, acht Zeilen übernommen:

- **R1** (PNG-Zweig von `encodedBase64Of` rechnete ein Byte zu wenig: `"iVBORw0"`
  sind 7 Zeichen, `7 % 4 = 3`) — übernommen: Präfix `"iVBORw0KGgo"` (12 Zeichen
  = 9 Byte, ausgerichtet) samt Fall.
- **R2/R3/R4** (drei Zähl-Kommentare sagten „eight schemas" bzw. „the two tab
  tools are last but one") — übernommen; AC 7 nennt sie in der Whitelist.
- **R5** (AC 6, „kein `executeScript`", war in 7 von 18 Fällen nicht gepinnt) —
  übernommen: 19 `scriptCalls`-Zusicherungen im `screenshot`-Abschnitt.
- **R6** (`UNEXPECTED_ARGUMENTS[browser_screenshot]` ohne Fall) — war bereits
  gebaut; mit einer Mutation nachgewiesen (Eintrag entfernt ⇒ genau
  `mcp_toolsCallBrowserScreenshot_withAnArgument_shouldReturnTheOnlyTabSentence`
  rot).
- **R7** (der Lesefehler-Zweig von `screenshotAllowed` ohne Fall) — übernommen:
  `storageReadFailsFor: ["allowScreenshot"]` ⇒ `screenshot_not_allowed`.
- **R8** (der Fixture-Block stand mitten im `createTabsStub`-JSDoc) —
  übernommen: der Block steht davor, Kommentar und Funktion wieder zusammen.
- **Beobachtung** (3 × 3000 ms Stufenfrist gegen `CALL_TIMEOUT_MS` = 10 000) —
  als Zeile unter `## Bekannte Lücken`.

Nebenbefund, außerhalb des Inkrements: die Abnahme hing zweimal ohne Meldung
(`test/http-transport.test.js`, `test/mcp.test.js`). Seit 2026-10-27 läuft
`npm test` mit `--test-timeout=120000`; ein Hänger scheitert nach 2 Minuten,
statt die Abnahme offen zu halten (eigener Commit `5496e64`).

- **2026-11-15 — sichtbare Labels sind englisch.** Der Betreiber hat die
  Optionsseite übersetzen lassen (das Projekt ist öffentlich, die Doku ist
  englisch). Die Zitate oben beschreiben den Stand ihrer Zeit; im Code heißt
  der Schalter jetzt **“Allow screenshots”**. Einzelnachweis: `extension/options.html`,
  `test/manifest.test.js`.
