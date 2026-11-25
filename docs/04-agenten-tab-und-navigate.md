---
description: Der Agent bekommt einen eigenen Tab — browser_navigate öffnet eine http(s)-URL im Agenten-Tab des Betreiber-Profils (Default-Container), wartet auf das Laden und meldet Tab-Id, URL, Titel und ob die Seite fertig ist.
status: active
---

# Agenten-Tab und `browser_navigate`

Inkrement 3 hat pi den Browser **lesen** lassen. Dieses Inkrement lässt ihn
**handeln** — mit einer einzigen, klar begrenzten Handlung: eine Seite öffnen.

Der Agent bekommt dafür einen eigenen Tab. `docs/PROJECT-STATE.md`,
Entscheidung 3 legt fest: „Sichtbarer Tab in einem normalen Fenster des
Betreibers: der Agent navigiert im Hintergrund-Tab, `focus` holt ihn nach vorn."
Bis heute gab es diesen Tab nicht; `navigate` legt ihn an.

## Ziel

`browser_navigate` mit einer URL öffnet die Seite im Agenten-Tab, wartet, bis
sie geladen ist, und antwortet mit `tabId`, `windowId`, `url`, `title` und
`complete`. Der Betreiber sieht den Tab in seiner Tableiste, ohne dass ihm der
Agent die aktuelle Seite unter den Händen wegzieht.

Beim ersten Aufruf wird der Tab angelegt; danach wird derselbe Tab
weiterverwendet. Ist er weg — geschlossen, Fenster zu, Browser neu gestartet
(Tab-Ids überleben keinen Neustart) —, legt die Extension einen neuen an.

## Non-goals

- **Kein Lesen des Seiteninhalts.** DOM-Text oder Screenshot brauchen Zugriff
  auf jede Seite (`<all_urls>` bzw. `activeTab` plus Injektion) — das ist eine
  Berechtigungsentscheidung des Betreibers und eine eigene Spec (Inkrement 5).
- Kein `click`, `type`, `focus`, `screenshot`, kein Schließen von Tabs, keine
  Tab-Liste als Werkzeug (`browser_status` gibt es schon).
- Keine Navigation im Tab des Betreibers — nur im Agenten-Tab.
- Keine mehreren Agenten-Tabs, kein Fenster-Handling, kein Ziehen von Tabs.
- Keine Änderung an Auth, Filtern, Zeitgrenzen oder am stdout-Vertrag.
- Keine neuen Berechtigungen: `tabs` und `storage` reichen.

## Wire-Protokoll (neu: `navigate`)

`PROTOCOL.METHODS` bekommt `navigate`. Anfrage der Bridge:

```json
{"type":"request","id":2,"method":"navigate","params":{"url":"https://example.org/"}}
```

Antwort der Extension:

```json
{"type":"response","id":2,"ok":true,
 "result":{"tabId":42,"windowId":1,"url":"https://example.org/","title":"Example Domain","complete":true}}
```

- **Nur `http:` und `https:`.** Alles andere (`file:`, `about:`, `javascript:`,
  `data:`, relative Angaben) beantwortet die Extension mit
  `{"ok":false,"error":{"code":"invalid_url","message":"Nur http:// und https:// sind erlaubt."}}`
  — geprüft in der Extension **und** in der MCP-Schicht, bevor eine Anfrage
  rausgeht (zwei Zeilen Doppelboden, ein Test je Seite).
- **Warten auf das Laden.** Nach `tabs.create`/`tabs.update` wartet die
  Extension auf `tabs.onUpdated` mit `changeInfo.status === "complete"` für
  genau diese Tab-Id, höchstens **8 s**. Danach antwortet sie in jedem Fall, mit
  `complete: true` oder `complete: false` — der Aufruf hängt nie, und die
  10-s-Grenze der Bridge (`BC_CALL_TIMEOUT_MS`) bleibt die Obergrenze.
- `url` und `title` stammen aus dem Tab **nach** dem Laden, damit
  Weiterleitungen und Fehlerseiten sichtbar werden.
- **Ein `complete` zählt nur, wenn es nach dem Update beobachtet wurde.** Ein
  `tabs.update` ändert den Tab nicht im selben Moment — ein `tabs.get` direkt
  danach meldet noch `status: "complete"` **der vorherigen** Seite. Genau das
  ist in einem echten Lauf passiert: `navigate` auf YouTube antwortete mit
  `url: "https://example.org/"` und `title: "Example Domain"`, während der Tab
  längst auf YouTube stand. Deshalb gilt nach einem Update: `complete` ist erst
  ein Ergebnis, wenn **entweder** ein `onUpdated` mit `status: "complete"` für
  diese Tab-Id nach dem Update eintraf **oder** ein `tabs.get` `complete`
  meldet **und** eine andere URL als die vor dem Update gemerkte liefert (die
  neue Seite hat also schon geladen). Die vor dem Update gemerkte URL lebt
  **pro Navigation**, nicht modulweit — sonst erbte eine Navigation das
  Ergebnis der vorigen. Kein Polling: es gibt keinen zusätzlichen Timer, die
  8-s-Grenze bleibt die einzige.
- **`about:` ist nie eine geladene Seite.** Beobachtet beim Verschieben des Tabs
  in ein neues Fenster: `navigate("https://quant.com")` antwortete
  `{"url":"about:blank","title":"(369) YouTube","complete":true}`, während der
  Tab danach korrekt auf der angefragten Adresse stand. Ein Tab, der
  `about:blank` (oder irgendeine `about:`-Adresse) meldet, gilt als **noch nicht
  geladen**: die Antwort wartet weiter. Greift die 8-s-Grenze, während der beim
  Update gemeldete Tab-Stand eine `about:`-Adresse ist, trägt `complete: false`
  die **angefragte** Adresse und den Titel `""`; war der gemeldete Stand dagegen
  eine echte Seite, bleibt es bei deren URL und Titel.
- **Dieselbe Adresse antwortet sofort** — aber nur im Update-Pfad, und erst
  nachdem eine laufende Navigation abgelöst wurde (`supersedeActiveNavigation`
  zuerst, sonst antwortet die alte Anfrage später mit der Seite der neuen).
  Verglichen wird die **normalisierte** Adresse (`new URL(x).href`, sonst ist
  `https://example.org` ≠ `https://example.org/`); meldet der Tab dabei
  `status: "loading"`, wird nicht sofort geantwortet, sondern normal gewartet —
  `complete: true` wäre gelogen.
- **`complete: false`** gibt es in zwei Fällen, und beide liefern denselben
  Payload: Zeitgrenze erreicht, oder ein zweiter `navigate` hat diesen hier
  abgelöst. Alle fünf Felder werden beim Beenden **synchron aus dem bereits
  bekannten Stand** gesetzt (der Tab, den `create`/`update` geliefert hat, plus
  die angefragte URL): `tabId` und `windowId` aus dem Anlegen, `url` aus dem
  letzten bekannten Tab-Stand oder der Anfrage, `title` ebenso oder `""`. Der
  abgelöste Aufruf liest **nicht** noch einmal — sonst könnte er die URL des
  zweiten Aufrufs als seine eigene melden. Ein zweiter
  `navigate` löst die Überlappung **erst nach** seiner eigenen URL-Prüfung auf —
  ein abgelehnter Aufruf darf eine laufende, erlaubte Navigation nicht killen.
- **Codes, die die Extension selbst vergibt**: `invalid_params` (kein `url`),
  `invalid_url` (kein http/https), `no_default_window` (kein normales,
  nicht-privates Fenster). **Alles andere** — etwa wenn `tabs.create` scheitert —
  fasst die Extension als `navigate_failed` zusammen; die MCP-Schicht gibt jeden
  Code als `isError` weiter (Text siehe `## MCP-Werkzeug`).
- Ein `navigate` ohne `url` oder mit nicht-string `url` beantwortet die
  Extension mit `ok:false, code:"invalid_params"`.

## MCP-Werkzeug

| Feld | Wert |
|---|---|
| `name` | `browser_navigate` |
| `description` | Opens an http(s) URL in the agent tab of the operator's browser (Default container), waits until the page has loaded and then until it has settled (3 s at most); reports `settled`/`waitedMs`. With `tab` exactly that tab, without `tab` the one used last. |
| `inputSchema` | `{"type":"object","properties":{"url":{"type":"string"}},"required":["url"],"additionalProperties":false}` |

`tools/call` mit `browser_navigate`:

- **Erfolg**: `{"content":[{"type":"text","text":"<JSON, 2 Leerzeichen eingerückt>"}]}`
  mit dem Ergebnis aus dem Wire-Protokoll.
- **`url` fehlt oder ist kein String**: JSON-RPC-Fehler `{code:-32602, message:"invalid params"}`.
- **unbekanntes Argument**: `{"content":[{"type":"text","text":"browser_navigate
  takes only `url` and `tab`."}],"isError":true}` — gleiche Präzedenz wie bei
  `browser_status` in Spec 03: ein Argumentenfehler ist eine Meldung an den
  Client, kein Protokollfehler.
- **kein http(s)**: `{"content":[{"type":"text","text":"Only http:// and https:// are allowed."}],"isError":true}`.
- **Extension-Code `invalid_url`**: derselbe englische Satz, `isError: true`.
- **keine Extension / Zeitüberschreitung**: dieselben zwei Sätze wie bei
  `browser_status` (Spec 03) — nicht neu formuliert.
- **`ok:false` mit anderem Code**: `"The extension could not carry out the
  request (code=<code>)."`, `isError: true`.

## Hub

`requestStatus()` aus Inkrement 3 wird zu `request(method, params)`;
`requestStatus()` bleibt als dünne Hülle (`request("status", {})`), damit die
bestehende automatische Anfrage beim Verbinden unverändert bleibt. Die
Id-Vergabe je Session, die Zeitgrenze und die Fehlertypen
(`ExtensionUnavailable`, `ExtensionTimeout`, `ExtensionError`) gelten
unverändert für jede Methode.

**Jede erfolgreiche Anfrage bekommt eine Logzeile**, nicht nur `status`:
`navigate tab=<id> url=<url> complete=<true|false>` auf stderr. Grund: eine
Navigation ist die einzige Handlung, die der Agent im Browser des Betreibers
ausführt — ohne Zeile gibt es dafür keinen Beleg außer dem Tab. Bei
`BC_LOG=debug` kommt wie bei `status` das eingerückte Ergebnis dazu; die
bestehenden Zeilen (`status windows=…`, `status timeout`, `status failed`)
bleiben wörtlich, wie sie sind.

## Extension

- `storage.local` bekommt `agentTabId` (Zahl) — nur ein Hinweis, keine Wahrheit:
  vor jedem `navigate` wird `browser.tabs.get(id)` versucht; wirft es oder liegt
  der Tab nicht im Default-Container (`cookieStoreId !== "firefox-default"`),
  wird ein neuer angelegt und die Id neu gespeichert.
- **Das Fenster wird vor dem Anlegen bestimmt.** `tabs.create` ohne `windowId`
  legt den Tab im *aktuellen* Fenster an — ist das ein privates, ist der neue Tab
  privat (`firefox-private`), fällt durch den Statusfilter und würde beim
  nächsten Aufruf als „nicht Default-Container" verworfen: pro `navigate` ein
  neuer Tab. Deshalb wählt die Extension das Fenster **zuerst**, nach derselben
  Regel wie der Statusfilter (`isInspectableWindow`: `type === "normal"` **und**
  `incognito === false`), in dieser Reihenfolge: das fokussierte solche Fenster,
  sonst das erste solche, sonst `ok:false, code:"no_default_window"`. Erst dann
  `tabs.create({url, active: false, windowId})` — kein Anlegen und Wegwerfen,
  kein `tabs.remove` nötig. Keine neue Berechtigung.
- Vorhandener Tab: `browser.tabs.update(tabId, {url})`.
- `answerRequest` (der Zweig, den `onMessage` heute schon für `status` nutzt)
  bekommt den `navigate`-Fall; `status` bleibt unverändert.

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `test/extension.test.js` — `navigate` ohne gespeicherten Tab | Es wird ein Tab angelegt: `active: false`, `windowId` des gewählten normalen Fensters (also Default-Container), neue `agentTabId` gespeichert |
| dito — mit gespeicherter, noch existierender Tab-Id | `tabs.update` statt `tabs.create`; keine zweite Tableiste |
| dito — gespeicherte Id zeigt auf einen geschlossenen Tab (`tabs.get` wirft) | Neuer Tab, neue Id gespeichert |
| dito — gespeicherte Id liegt in einem Container | Neuer Tab im Default-Container, nicht der Container-Tab |
| dito — das fokussierte Fenster ist privat (`incognito: true`) | Der Tab landet im normalen Fenster (`windowId` gesetzt), **kein** Tab im privaten Fenster — die Fensterwahl passiert vor `tabs.create` |
| dito — nur private Fenster vorhanden | `ok:false, code:"no_default_window"`, kein `tabs.create` |
| dito — `file:`/`javascript:`/`data:`/fehlende `url` | `ok:false` mit `invalid_url` bzw. `invalid_params`, **kein** `tabs.create`/`update` |
| dito — zweiter `navigate` auf demselben Tab, das `tabs.get` direkt nach dem Update meldet noch `complete` der alten Seite | Antwort erst nach dem `onUpdated` der **neuen** Seite; `url`/`title` sind die neuen, und die Antwort trägt **alle fünf** Felder (der belegte Fehler ließ `windowId` weg) |
| dito — `navigate` auf die Adresse, die der Tab schon hat | Sofortige Antwort ohne Warten |
| dito — dieselbe Adresse, während der Tab `loading` meldet | Kein Sofortweg: normal warten (`complete: true` wäre gelogen) |
| dito — der Tab meldet nach dem Update `about:blank` (Fensterwechsel, frisch gezogener Tab) | `about:blank` zählt nicht als geladen: weiter warten, notfalls `complete: false` mit der **angefragten** Adresse und `title: ""` |
| dito — `onUpdated` mit `complete` (beim Emittieren) | Antwort mit `complete: true` und allen fünf Feldern, `url`/`title` **aus dem Tab nach dem Laden** (`create`/`update` und `get` teilen sich einen Tab-Speicher im Stub) |
| dito — zwei `navigate` im **selben Tick** | Genau **ein** `tabs.create`; der zweite Aufruf landet per `tabs.update` auf demselben Tab (keine Waise in der Tableiste) |
| dito — `tabs.update` scheitert, weil der Tab zwischen `get` und `update` geschlossen wurde | Fallback auf `tabs.create` mit `windowId`, neue `agentTabId` gespeichert |
| `test/hub.test.js` — `BC_LOG=debug` mit einer navigierten Antwort | Zeile `navigate tab=… url=… complete=…` **und** eingerückter JSON-Block auf stderr, in dieser Reihenfolge |
| dito — `onUpdated` für eine **andere** Tab-Id | Keine Antwort, der Wart läuft weiter (sonst löst jede Navigation des Betreibers die Agenten-Navigation vorzeitig auf) |
| dito — `onUpdated` bleibt aus | Antwort nach 8 s mit `complete: false` und **allen fünf Feldern** (Timer-Stub, kein echter Wartelauf) |
| `test/hub.test.js` — `request("navigate", …)` | Zuordnung über die `id`, `ExtensionError` trägt den Code der Antwort |
| `test/mcp.test.js` — `tools/list` | Genau zwei Werkzeuge, beide Schemata mit `additionalProperties:false` |
| dito — `browser_navigate` mit Fake-Extension | Text ist JSON mit `tabId`/`url`/`title`/`complete` |
| dito — `browser_navigate` ohne `url` | `-32602` |
| dito — `browser_navigate` mit `file:///etc/passwd` | `isError:true` und der englische Satz, **ohne** dass eine Anfrage an die Extension geht |
| dito — Fake-Extension antwortet `ok:false, code:"invalid_url"` | `isError:true`, derselbe Satz |
| dito — `browser_navigate` mit einem zweiten Argument | `isError:true`, „browser_navigate takes only `url` and `tab`." |
| dito — Fake-Extension antwortet `ok:false, code:"navigate_failed"` | `isError:true`, „The extension could not carry out the request (code=navigate_failed)." |
| `test/protocol.test.js` | `navigate` steht in beiden Kopien der Konstanten (`extension/protocol.js`, `bridge/protocol.mjs`) |

## Acceptance criteria

1. `npm test; echo $?` → `0`, die Ausgabe enthält `# fail 0` **und**
   `# cancelled 0` (ein hängender 8-s-Test zeigt sich dort, nicht bei
   `# fail`); `npm run check; echo $?` → `0`;
   `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → keine Ausgabe, Exit 1.
   Von den 77 bisherigen Fällen laufen **75 unverändert**; **zwei müssen sich
   ändern**, weil das Inkrement ihre Voraussetzung aufhebt:
   `onMessage_withUnknownMethod_shouldReplyUnsupportedMethod` (nutzt `navigate`
   als Beispiel für „nicht implementiert") und
   `mcp_toolsList_shouldOfferExactlyOneToolThatTakesNoArguments` (behauptet
   genau ein Werkzeug). Beide Änderungen stehen mit Begründung im Bericht. Ein
   Fall, der **nicht** angepasst wird, obwohl er `navigate` nennt:
   `mcp_toolsCall_withAnUnknownToolName_…` — `navigate` ist kein Werkzeugname,
   das Werkzeug heißt `browser_navigate`. Die Gesamtzahl steigt um die neuen
   Fälle in `test/extension.test.js`, `test/hub.test.js` und
   `test/mcp.test.js`.
2. `tools/list` liefert genau zwei Werkzeuge, `browser_status` und
   `browser_navigate`, letzteres mit `required: ["url"]` und
   `additionalProperties: false`.
3. Mit Fake-Extension liefert `browser_navigate` Text, der sich als JSON parsen
   lässt und **alle fünf** Felder enthält: `tabId`, `windowId`, `url`, `title`,
   `complete`.
4. `file:///etc/passwd` und ein fehlendes `url` werden **vor** jeder
   Extension-Anfrage abgelehnt — in **einem** Lauf mit verbundener Fixture
   (Beleg: dieselbe Testdatei wartet auf `extension connected`). Der Test zählt
   die Anfragen der Fixture über ihre stderr-Zeilen: nach den zwei abgelehnten
   Aufrufen steht noch **keine** solche Zeile, nach dem einen erfolgreichen
   `navigate` steht **genau eine** da — und die Erfolgsantwort ist der Beleg,
   dass genau dieser Aufruf die Zeile erzeugt hat. Die Eins ist die Gegenprobe, dass der Zähler
   überhaupt zählt — eine Null ohne Ordnung wäre auch dann grün, wenn gar keine
   Fixture läuft.
5. Auf stdout steht weiterhin ausschließlich JSON-RPC (Kriterium 5 aus Spec 03
   gilt unverändert, geprüft im selben Testfile).
6. **Die Handgriffe des Betreibers**, in dieser Reihenfolge: (a) die Extension
   in `about:debugging` **neu laden** — das Manifest ändert sich nicht, aber der
   Background im Speicher kennt `navigate` sonst nicht und antwortet mit
   `unsupported_method`; (b) pi neu starten (vorher ist das Werkzeug nicht in der
   Sitzung). Danach ruft der Orchestrator das Werkzeug
   `mcp__browser_control__browser_navigate` (pi präfixt) mit
   `https://example.org/` auf; Beleg ist die Antwort mit `complete: true`, die
   Logzeile aus `## Hub` und ein sichtbarer Agenten-Tab im Profil.

   **Ausnahme mit Datum** (2026-10-23, wie in `CONTRIBUTING.md`, `## Acceptance`
   vorgesehen): Kriterium 6 ist erst nach (a) und (b) messbar. Die Kriterien 1–5
   laufen vor dem Commit, Kriterium 6 danach; fällt es rot aus, wird vorwärts
   korrigiert und die rote Zeile steht mit Datum unter `## Bekannte Lücken`.
   Ist dagegen die **Kernannahme** widerlegt (Kriterium 6 zeigt, dass der Agent
   den Tab nicht bekommt oder er im Profil nicht sichtbar ist), geht das
   Inkrement zurück in diese Spec — `## Bekannte Lücken` ist dafür kein Ersatz.

## Dev plan

1. **`navigate` in beiden Protokollkopien.** `extension/protocol.js` und
   `bridge/protocol.mjs`: `METHODS` bekommt `NAVIGATE: "navigate"` (sonst
   nichts). Neu in `test/protocol.test.js`: ein Fall, der
   `PROTOCOL.METHODS.NAVIGATE === "navigate"` **auf beiden Seiten** wörtlich
   prüft — der vorhandene `deepStrictEqual`-Vergleich fängt nur Abweichung,
   nicht beidseitiges Fehlen.
   Proof: `node --test test/protocol.test.js` → 3 Fälle, `# fail 0`. **Completed 2026-10-23**
2. **`Hub.request(method, params)`.** `bridge/hub.mjs`: `#askStatus` →
   `#ask(session, method, params)`, Eintrag in `session.pendingRequests` bekommt
   `method`; `#handleStatusTimeout` → `#handleTimeout` (Logzeile
   `<method> timeout`); `#handleResponse` liest den Methodennamen aus dem
   Eintrag, loggt `<method> failed`, ruft `#reportStatus` für `METHODS.STATUS`
   und schreibt für `METHODS.NAVIGATE` die Zeile
   `navigate tab=… url=… complete=…`. Neu: `request(method, params = {})`,
   `requestStatus()` als `return this.request(PROTOCOL.METHODS.STATUS, {})`.
   Unberührt: `HubRequestError` samt `code`, `#takePending`, `#rejectPending`,
   `#rejectAllPending`, `#handleClose`, `#accept`. In `test/hub.test.js` drei
   Fälle zusätzlich (navigate löst über die `id` auf und ruft `onStatus` nicht;
   navigate `ok:false` → `ExtensionError` mit `code`; status und navigate
   verschränkt). Die 19 bestehenden Hub-Fälle bleiben unverändert, inklusive
   `hub_requestStatusAnsweredWithOkFalse_shouldRejectWithExtensionErrorCarryingTheCode`
   und der angepinnten Logzeilen `status timeout` / `status failed`.
   Proof: `node --test test/hub.test.js` → 22 Fälle grün. **Completed 2026-10-23**
3. **`navigate` in der Extension.** `extension/background.js`: lokale Konstanten
   `NAVIGATE_TIMEOUT_MS = 8000` (bewusst **nicht** in `BC_PROTOCOL` — dort
   müsste die Bridge einen Wert spiegeln, den sie nie benutzt),
   `INVALID_URL_CODE`, `INVALID_PARAMS_CODE`, `NO_DEFAULT_WINDOW_CODE`,
   `NAVIGATE_FAILED_CODE`; Zweig in `answerRequest`; neu `navigate(params)`,
   `selectAgentWindow()` (erst `browser.windows.getAll()`, dann dieselbe Regel
   wie `isInspectableWindow`: `type === "normal" && !incognito`, fokussiertes
   Fenster zuerst, sonst das erste solche, sonst `null` →
   `no_default_window`), `resolveAgentTab(url)` (liest `agentTabId`,
   `browser.tabs.get`, prüft `cookieStoreId === "firefox-default"`, sonst
   `tabs.create({url, active: false, windowId})` mit dem **vorher gewählten**
   Fenster und neu speichern), `updateOrCreateTab` (Fallback ebenfalls mit
   `windowId`), `waitForTabComplete(tabId)`, `isHttpUrl`. Der Stub hat
   `windows.getAll` mit `focused` bereits — kein neuer Attrappen-Typ nötig.
   Reihenfolge in `navigate`: `typeof url === "string"` → sonst
   `invalid_params`; `new URL` + Protokollprüfung → sonst `invalid_url` (relativ
   wirft); dann Tab. Der Wart lebt im `navigate`-Pfad selbst: **erst**
   `browser.tabs.onUpdated.addListener`, dann eine `tabs.get`-Nachkontrolle
   (`status === "complete"` → sofort fertig, sonst wartet man 8 s umsonst), dann
   `setTimeout(8000)`. Beenden über genau eine idempotente `finish()`-Funktion,
   die Listener entfernt (dieselbe Funktionsreferenz!) und den Timer löscht.
   Überlappung: ein modulweites `activeNavigation`; ein zweiter `navigate` ruft
   `finish()` des ersten mit `complete: false` auf, bevor er selbst Listener und
   Timer setzt. `tabs.update` in `try/catch` mit Fallback auf `tabs.create` (Tab
   zwischen `get` und `update` geschlossen).
   `test/extension.test.js`: die Sandbox braucht **`URL`** (in `node:vm` nicht
   automatisch vorhanden; sonst wirft `new URL(…)` einen `ReferenceError` in den
   `catch` von `answerRequest` und der Test scheitert an der falschen Stelle).
   `createBrowserStub` bekommt `tabs` (`get` wirft bei unbekannter Id, `create`,
   `update`) **mit einem gemeinsamen Tab-Speicher**, damit `get` nach `update`
   die neue URL sieht; dazu ein `onUpdated`-Paar
   `addListener`/`removeListener` mit `emitUpdated(tabId, changeInfo, tab)` und
   `listenerCount()`; `startBackground` gibt den Stub mit zurück.
   Neue Fälle laut `## Testing` plus „zwei `navigate` überlappen — der erste
   antwortet `complete:false`, genau ein Listener bleibt". Der 8-s-Fall nutzt
   `clock.runNext()` und prüft die Verzögerung `8000`; der Stub meldet
   `status: "loading"`, solange `emitUpdated` nicht gefeuert hat, damit die
   `tabs.get`-Nachkontrolle den Warte-Fall nicht abkürzt (im Update-Pfad gibt es
   **zwei** `get` vor der Nachkontrolle: `resolveAgentTab` und die Kontrolle).
   Proof: `node --test test/extension.test.js` → neue Fälle grün (Antworten mit
   allen fünf Feldern), der `status`-Pfad unverändert grün. → 25 Fälle,
   `# fail 0`. **Completed 2026-10-23**
4. **MCP-Tool `browser_navigate`.** `bridge/mcp.mjs`: `BROWSER_NAVIGATE`,
   zweiter Eintrag in `TOOLS` mit `description` und `inputSchema` wörtlich aus
   der Spec, neue Texte `INVALID_URL` und `NAVIGATE_EXTENSION_FAILED: (code) =>
   …`; `callTool` verzweigt auf den Namen (`browser_status`-Pfad Byte für Byte
   unverändert), neu `navigateTool(id, params, {hub, log})` und
   `validateNavigateUrl(raw)` (fehlend/kein String → `-32602`; `new URL` +
   `http:`/`https:` → sonst Tool-Error, **vor** `hub.request`);
   `failureTextFor` bekommt den Toolnamen als Parameter (der Textschlüssel heißt
   seit Spec 05 `CALL_EXTENSION_FAILED(code)` und wird mit `browser_read`
   geteilt). Ein unbekanntes
   Argument bei `browser_navigate` ergibt `isError` mit dem Satz aus
   `## MCP-Werkzeug` (Präzedenz aus Spec 03), **nicht** `-32602`.
   `test/fixtures/fake-extension.mjs`: antwortet `navigate` mit
   `NAVIGATE_RESULT`, `BC_TEST_NAVIGATE_ANSWER` mit `0`/`error:<code>`, und
   schreibt je Anfrage eine stderr-Zeile `fake extension: request
   method=<m>` (eigener Handle; der stderr-Vergleich in `test/bridge.test.js`
   bleibt unberührt).
   `test/mcp.test.js`: `mcp_toolsList_…` auf zwei Werkzeuge umgestellt; neue
   Fälle Erfolg (JSON mit `tabId`/`url`/`title`/`complete`), `url` fehlt,
   `file:///etc/passwd`, Fixture-`invalid_url`. Kriterium 4 wird über die
   Zählerzeilen entschieden — nach `welcome` zwei abgelehnte Aufrufe, danach
   **keine** Zeile `request method=navigate`, während der Erfolgsfall im selben
   Lauf `≥ 1` zeigt (Gegenprobe, dass der Zähler zählt).
   Proof: `node --test test/mcp.test.js` → 26 Fälle grün, die
   `browser_status`-Fälle unverändert. → 29 Fälle (sieben neue),
   `# fail 0`. **Completed 2026-10-23**
5. **Gesamtbeleg.** Keine Datei. Die drei Abnahmebefehle aus `CONTRIBUTING.md` laufen
   lassen und die Ausgabe in den Bericht legen.
   Proof: `npm test; echo $?` → `0` mit `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`;
   `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → Exit 1. Kriterium 6 ist
   kein Schritt, sondern Übergabe: pi einmal neu starten, dann ruft der
   Orchestrator `browser_navigate` mit `https://example.org/` auf.
   → 101 Fälle, `# fail 0`, `# cancelled 0`, beide Kommandos Exit 0, grep
   Exit 1. **Completed 2026-10-23**

4a. **Nachtrag vom 2026-10-23 — `complete` nach dem Update (entstanden nach der
   ersten Umsetzung, nach einem echten Lauf).** `extension/background.js`: die
   vor dem Update gemerkte URL in den Navigations-Zustand legen; die
   `tabs.get`-Nachkontrolle vertraut `complete` nur noch, wenn die URL sich
   geändert hat; der Update-Pfad prüft vor dem Warten, ob die normalisierte
   angefragte Adresse der aktuellen entspricht (und der Tab nicht `loading`
   meldet) und antwortet dann sofort — **nach** `supersedeActiveNavigation`.
   Die Antwort trägt in jedem Pfad alle fünf Felder.
   `test/extension.test.js`: der Stub braucht eine Option, die den Fehler
   nachstellt (`updateKeepsStatusCompleteFor`: `tabs.get` liefert nach dem
   Update weiter die alte URL mit `status: "complete"`), sonst kann der Fall
   gar nicht rot werden. Drei Fälle: stale `complete` ⇒ Antwort erst nach dem
   Ereignis, mit fünf Feldern; dieselbe Adresse ⇒ sofortige Antwort, keine
   neue Navigation; dieselbe Adresse, während der Tab `loading` meldet ⇒
   normales Warten.
   Proof: `node --test --test-reporter=tap test/extension.test.js` → `# fail 0`;
   Gegenprobe: die URL-Bedingung entfernen ⇒ der stale-Fall antwortet mit der
   alten Seite und wird rot. **Completed 2026-10-23**
4b. **Nachtrag vom 2026-10-23 — `about:blank` zählt nicht (entstanden nach einem
   echten Lauf).** `extension/background.js`: in `reportsLoadedPage` und im
   Ereignispfad eine Adresse mit Schema `about:` wie „nicht geladen" behandeln;
   im `complete:false`-Pfad die angefragte Adresse und `title: ""` liefern, wenn
   der bekannte Tab-Stand `about:` ist.
   `test/extension.test.js`: ein Fall, in dem `tabs.get` nach dem Update
   `about:blank` mit dem alten Titel liefert ⇒ Antwort erst nach dem Ereignis;
   und der Zeitgrenzen-Fall mit `about:blank` ⇒ `complete: false`, `url` ist die
   angefragte Adresse, `title` `""`.
   Proof: `node --test --test-reporter=tap test/extension.test.js` → `# fail 0`;
   Gegenprobe: die `about:`-Bedingung entfernen ⇒ der neue Fall antwortet mit
   `about:blank` und wird rot.
   **Completed 2026-10-23**

### What could go wrong

- **Zwei der 77 Bestandsfälle müssen sich ändern**, das ist die Folge des
  Inkrements und keine Nachlässigkeit:
  `onMessage_withUnknownMethod_shouldReplyUnsupportedMethod` benutzt heute
  `method: "navigate"` als Beispiel für „nicht implementiert" (muss auf z. B.
  `"click"` wechseln), und `mcp_toolsList_shouldOfferExactlyOneToolThatTakesNoArguments`
  behauptet genau ein Werkzeug. Die Änderung gehört in den Bericht, nicht in
  ein stilles Achselzucken; Kriterium 1 zählt sie ausdrücklich mit.
- **`onUpdated`-Rennen.** Ohne die `tabs.get`-Nachkontrolle nach dem Listener
  kann `complete` vor dem Warten eintreffen (gecachte Seite, `update` auf
  dieselbe URL) und der Aufruf wartet die vollen 8 s. Umgekehrt darf die
  Nachkontrolle die Tests nicht abkürzen — der Stub muss `loading` melden.
- **Listener-Leck.** Zwei Austrittspfade, ein `finish()`; ein `removeListener`
  mit einer neu erzeugten Funktion entfernt nichts, deshalb muss dieselbe
  Referenz gespeichert werden. Der Überlappungsfall ist der Test, der das
  dauerhaft beweist.
- **Hub-Logzeilen sind angepinnt.** `status timeout`, `status failed` und
  `status windows=` stehen wörtlich in bestehenden Tests; die Verallgemeinerung
  muss sie aus dem Methodennamen ableiten, nicht umbenennen. `#reportStatus` für
  navigate liefe in `status windows=0 tabs=0`.
- **Das Fenster muss gewählt werden, der Container nicht.** Ein privates Fenster
  würde sonst still einen privaten Tab bekommen; deshalb wird das Fenster vor
  `tabs.create` nach `type === "normal" && !incognito` gewählt (dieselbe Regel
  wie `isInspectableWindow`) und als `windowId` mitgegeben. Einen bestimmten
  *Container* kann `tabs.create` ohne `contextualIdentities`/`cookies` nicht
  adressieren — beides sind neue Berechtigungen und durch die Spec
  ausgeschlossen; in einem normalen Fenster ist der Tab im Default-Container.
  Die Testzusicherung pinnt deshalb die Argumente `{url, active: false,
  windowId}`.
- **Zwei URL-Prüfungen, zwei Wahrheiten.** `new URL` in der Extension und in
  `bridge/mcp.mjs` sind getrennte Kopien (klassisches Skript vs. ESM). Der je
  eine Test pro Seite ist der Doppelboden, nicht die gemeinsame Funktion.
- **Verschärfte Testumgebung.** `test/mcp.test.js` startet echte Kindprozesse und
  Sockets; `EVENT_TIMEOUT_MS` nicht senken, nur weil `navigate` schneller
  antwortet als `status`.

### Ordering and dependencies

1 → 2, 1 → 3; 2 → 4; Stufe 3 ist von 2 unabhängig (andere Seite des Drahts,
eigene Tests) und darf im getrennten Worktree parallel laufen. Stufe 4 braucht 2
(`hub.request`) und die Fixture-Antwort, nicht Stufe 3 — die MCP-Tests fahren
gegen `test/fixtures/fake-extension.mjs`, nie gegen den echten Background.
Stufe 5 setzt 1–4 voraus. Kriterium 6 kommt nach Stufe 5 und gehört dem
Betreiber.

### What the next increment inherits

Lesen des Seiteninhalts (`<all_urls>`/`activeTab` als
Berechtigungsentscheidung des Betreibers), `focus`, `click`/`type`/`screenshot`,
mehrere Agenten-Tabs, eine Warte- oder Retry-Strategie für `complete:false` bei
langsamen Hintergrund-Tabs, das Schließen des Agenten-Tabs — und der
Statuswechsel dieser Spec auf `active`, den der Orchestrator nach Kriterium 6
macht.

## Risiken

- **Die Tab-Id ist keine Identität.** Firefox vergibt Tab-Ids je Sitzung; nach
  einem Neustart zeigt die gespeicherte Id auf irgendetwas oder nichts. Deshalb
  wird sie bei jedem Aufruf geprüft und notfalls verworfen — der Testfall
  „gespeicherte Id zeigt auf einen geschlossenen Tab" ist der Beleg.
- **Der Betreiber kann im Agenten-Tab selbst navigieren.** Dann überschreibt der
  nächste `navigate` seine Seite. Das ist gewollt (es ist der Agenten-Tab), steht
  aber in `INSTALL.md`, damit es keine Überraschung ist.
- **Hintergrund-Tabs können verzögert laden.** `complete: false` nach 8 s ist
  deshalb ein reguläres Ergebnis, kein Fehler; der Agent kann `browser_status`
  fragen oder erneut navigieren.
- **`tabs.update` mit einer URL, die die Seite selbst weiterleitet**, liefert
  erst nach der Weiterleitung `complete` — deshalb stammen `url` und `title` aus
  dem Tab nach dem Laden und nicht aus den Parametern.
- **`BC_CALL_TIMEOUT_MS` unter 8000 macht `navigate` immer rot.** Die 20 s sind
  der Default, nicht die Grenze: wer die Variable kleiner stellt als die
  8-s-Wartezeit der Extension, bekommt für jede Navigation eine
  Zeitüberschreitung, obwohl die Seite lädt.
- **Kein Inhalt, kein Klick.** Mit `navigate` allein kann der Agent eine Seite
  öffnen, aber nicht lesen. Das ist die Grenze dieses Inkrements und der Grund,
  warum Inkrement 5 eine Berechtigungsentscheidung braucht.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine Tokens im Repo.
- Keine neuen Berechtigungen im Manifest; `extension/manifest.json` bleibt
  unverändert (der Test aus Spec 02 prüft das weiter).
- `bridge/websocket.mjs`, `bridge/config.mjs` werden nicht angefasst.
- `docs/PROJECT-STATE.md`, `docs/README.md` und `INSTALL.md` pflegt der
  Orchestrator.
- Kein Produktivcode für Inkrement 5 oder später (Lesen, Klicken, Screenshot,
  `focus`).

## Bekannte Lücken

Stand 2026-10-23, vor der Umsetzung. **Entschieden am 2026-11-23:** die drei Punkte
unten bleiben dauerhaft Lücken. Sie beschreiben Lagen, die nur per Race entstehen
(ein `complete`-Ereignis der auslaufenden Seite, eine Weiterleitung auf die alte
Adresse); ein Fix hieße, den Vertrag um einen vierten Zustand zu erweitern, und das
ist mehr Risiko als Nutzen. Wer sie schließen will, schreibt dafür eine eigene Spec.

- **Der `onUpdated`-Zweig prüft die Adresse nicht** (2026-10-23, Code-Review nach
  dem Nachtrag): ein `complete`-Ereignis für den richtigen Tab, aber noch von
  der auslaufenden Seite, wird als Ergebnis genommen — dieselbe Signatur wie der
  behobene Fehler, nur über den anderen Zweig. Spec-konform (der Vertrag nennt
  beide Wege), aber ein Restloch: sauber wäre ein Flag „Tab war beim Update
  `loading`", das der Ereignis-Pfad ebenfalls verlangt.
- **`complete: false` nennt weiter die vorherige Seite** (2026-10-23): der
  bekannte Tab-Stand stammt aus dem `update`, das noch die alte Seite meldet.
  Die Spec erlaubt an dieser Stelle ausdrücklich die angefragte URL — der Code
  nutzt sie noch nicht.
- **Eine Weiterleitung zurück auf die vorherige Adresse endet in
  `complete: false`** (2026-10-23): „alte Seite" und „alte Seite neu geladen"
  sind unter der Regel nicht unterscheidbar.
- **Kriterium 6 ist erst nach dem Commit messbar** (Reload der Extension, dann
  pi neu starten); die begründete Ausnahme steht dort und in `CONTRIBUTING.md`,
  `## Acceptance`.
- **Kein Lesen des Seiteninhalts, kein Klick, kein Screenshot** — bewusst, siehe
  `## Non-goals`; Inkrement 5 braucht dafür eine Berechtigungsentscheidung.
- **`complete:false` bei langsamen Hintergrund-Tabs** bleibt ein reguläres
  Ergebnis ohne Retry; ob eine Wartestrategie nötig ist, zeigt der Alltag.
- **Ein während des Wartens geschlossener Agenten-Tab** (2026-10-23, Code-Review
  F4): kein `onRemoved`-Handler, also antwortet der Aufruf nach 8 s mit
  `complete:false` und einer `tabId`, die es nicht mehr gibt. Spec-konform
  („höchstens 8 s, in jedem Fall eine Antwort"), aber der nächste Aufruf legt
  dann einen neuen Tab an.
- **Die Tab-Auflösung ist serialisiert, aber nicht begrenzt** (2026-10-23,
  Re-Review): eine Browser-API, die nie antwortet, blockiert die Kette dauerhaft
  — alle späteren `navigate` reihen sich dahinter und laufen einzeln in die
  10-s-Grenze. `tabs.*` und `storage` antworten in Firefox immer, deshalb
  theoretisch; ein `Promise.race` mit Zeitgrenze wäre der Fix.

## Open questions

Keine. Entschieden am 2026-10-23: Inkrement 4 ist Agenten-Tab plus `navigate`,
ohne Lesen des Seiteninhalts, ohne neue Berechtigungen. Das Lesen kommt als
eigenes Inkrement, weil es eine Berechtigungsentscheidung des Betreibers
verlangt.

## Review

| Runde | Datum | Verdict | Blocker |
|---|---|---|---|
| 1 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (Payload bei `complete:false`, privates Fenster, Kriterium 4/6, Amendments) |
| 2 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (Widerspruch Fenster, Payload-Löcher, Code-Ausnahme, Fensterwahl) |
| 3 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (Stufe 3 und eine Testing-Zeile bauten die verbotene Version) |

## Log

Code-Review Runde 1 (2026-10-23) — je Befund eine Zeile:

- **B1** (zwei `navigate` im selben Tick lasen die noch leere `agentTabId` und
  legten je einen Tab an; einer blieb als Waise in der Tableiste) —
  **übernommen**: die Tab-Auflösung läuft über eine modulweite Promise-Kette,
  der zweite Aufruf landet per `tabs.update` auf demselben Tab; Testfall „zwei
  `navigate` im selben Tick → genau ein `tabs.create`".
- **F1** (kein Test für den `tabs.update`-Rückfall) — **übernommen**: Fall mit
  scheiterndem `update` (Tab zwischen `get` und `update` geschlossen) prüft
  `create` mit `windowId` und die neue `agentTabId`.
- **F2** (`!stderr.includes("status failed")` belegte die Reihenfolge nicht) —
  **übernommen**: der Fall prüft jetzt den Fixture-Zähler
  (`navigateRequestCount === 0`) statt der Logzeile.
- **F3** (Debug-Ausgabe einer `navigate`-Antwort ungetestet) — **übernommen**:
  Fall mit `BC_LOG=debug` prüft Zeile `navigate tab=… url=… complete=…` und den
  eingerückten JSON-Block, Zeile vor Block.
- **F5** (der `catch` um `tabs.update` legte bei jedem Fehler still einen neuen
  Tab an) — **übernommen**: `console.warn` mit dem Fehlergrund, kein neues
  Verhalten.

Befund beim Schreiben des Dev-Plans (2026-10-23):

- **Kriterium 1 („77 unverändert") war falsch.** Zwei Bestandsfälle können nach
  diesem Inkrement nicht unverändert bleiben: der „unknown method"-Test benutzt
  `navigate` als Beispiel für eine nicht implementierte Methode, und der
  `tools/list`-Test behauptet genau ein Werkzeug. Vom Architekten gefunden, im
  Kriterium korrigiert (75 unverändert, 2 begründet angepasst) — **übernommen**,
  statt die Zahl später stillschweigend zu biegen.

Runde 1 des Spec-Reviews — je Befund eine Zeile:

- **M1** (`complete:false`-Payload und die Reihenfolge der Überlappungs-Auflösung
  standen nur im Dev-Plan; nach einem Abbruch gibt es keinen geladenen Tab, aus
  dem `url`/`title` kämen) — **übernommen**: eigener Punkt im Wire-Protokoll
  (`tabs.get` ein letztes Mal, sonst angefragte URL und `""`; Überlappung erst
  nach bestandener URL-Prüfung).
- **M2** („Default-Container ist das Ergebnis" gilt nicht, wenn das aktuelle
  Fenster privat ist — `tabs.create` legt dann einen privaten Tab an, der beim
  nächsten Aufruf verworfen wird) — **übernommen**: `cookieStoreId` nach dem
  Anlegen prüfen, notfalls in einem normalen Fenster neu anlegen, sonst
  `no_default_window`; zwei Testfälle.
- **M3** (Kriterium 6 ließ den Reload der Extension weg und sagte die Ausnahme
  aus `CONTRIBUTING.md` nicht an) — **übernommen**: zwei Handgriffe in der richtigen
  Reihenfolge, plus datierte Ausnahme mit Ort für einen roten Ausgang.
- **M4** (Kriterium 4 konnte aus dem falschen Grund grün sein) — **übernommen**:
  ein Lauf mit verbundener Fixture, zwei abgelehnte Aufrufe und **genau eine**
  `request method=navigate`-Zeile nach einem Erfolg.
- **M5** (`## Amendments` fehlte, obwohl Spec 03 `active` ist und an vier
  Stellen „genau ein Tool" sagt) — **übernommen**: Abschnitt angelegt, Spec 03
  und Spec 01 benannt, Entfernung nach der Umsetzung.
- **Minors** — **übernommen**: `URL` und gemeinsamer Tab-Speicher im vm-Stub,
  `get` meldet `loading` bis zum Ereignis, Testfall für fremde Tab-Id,
  `# cancelled 0` in Kriterium 1, Hinweis auf den unveränderten
  Unknown-Tool-Fall, unbekanntes Argument als `isError`, Logzeile für
  erfolgreiche Navigationen, `BC_CALL_TIMEOUT_MS` unter 8000 als Risiko,
  `INSTALL.md` in der Touch-Boundary.

Runde 2 des Spec-Reviews — vier Blocker, alle übernommen:

- **B1** (`### What could go wrong` behauptete weiter „der Default-Container ist
  das Ergebnis" und pinnte `tabs.create` auf `{url, active: false}` — im
  Widerspruch zur neuen Fensterwahl) — **übernommen**: Absatz umgeschrieben,
  gepinnte Argumente jetzt `{url, active: false, windowId}`.
- **B2** (bei `complete:false` hatte `windowId` keine Quelle, und ein
  asynchrones Nachlesen hätte dem abgelösten Aufruf die URL des zweiten
  Aufrufs unterschieben können) — **übernommen**: alle fünf Felder werden
  synchron aus dem bekannten Stand gesetzt, kein Nachlesen.
- **B3** (die Sammelregel „alles andere → `navigate_failed`" widersprach
  `no_default_window` als eigenem Code) — **übernommen**: die drei eigenen Codes
  stehen jetzt in einer abschließenden Liste, `navigate_failed` ist der Rest.
- **B4** (die Fensterwahl filterte nur `incognito === false`, die Projektregel
  ist `type === "normal" && !incognito`; „verworfen" nannte kein `tabs.remove`)
  — **übernommen**: das Fenster wird **vor** `tabs.create` gewählt
  (fokussiert, sonst das erste, sonst `no_default_window`), damit entfällt das
  Anlegen-und-Wegwerfen samt `tabs.remove`.
- **m1** (Amendments nannte vier Stellen, die `## Testing`-Zeile von Spec 03
  fehlte; Dev-Plan und Log sind Historie) — **übernommen**, mit der
  ausdrücklichen Notiz, welche Stellen Historie bleiben.
- **m2** (Kriterium 6 nannte den nackten Werkzeugnamen) — **übernommen**:
  `mcp__browser_control__browser_navigate`.
- **m3** (die Ausnahme in Kriterium 6 kannte die Kernannahme-Klausel nicht, und
  `## Bekannte Lücken` fehlte) — **übernommen**: Klausel ergänzt, Abschnitt
  angelegt.
- **m4** (`windowId` wurde versprochen, aber in Kriterium 3 nicht geprüft) —
  **übernommen**: Kriterium 3 und die Testing-Zeilen verlangen alle fünf Felder.
- **m5** (zwei Vertragszeilen ohne Testzeile: unbekanntes Argument,
  `navigate_failed`) — **übernommen**: zwei Zeilen in `## Testing`.
- **m6** (Kriterium 4 prüfte nur die Endsumme) — **übernommen**: Reihenfolge
  ausgeschrieben (vor dem Erfolg keine Zeile, danach genau eine).

Runde 3 des Spec-Reviews — zwei Blocker, beide übernommen:

- **B5** (Stufe 3 des Dev-Plans legte den Tab noch ohne `windowId` an und kannte
  `no_default_window` nicht — der Per-navigate-neuer-Tab-Fehler aus M2 war eine
  Stufe lang wieder eingebaut) — **übernommen**: `selectAgentWindow()` als
  erster Schritt, `NO_DEFAULT_WINDOW_CODE` in der Konstantenliste,
  `tabs.create({url, active: false, windowId})` in beiden Anlegepfaden.
- **B6** (die Testing-Zeile verlangte „Tab wird verworfen und neu angelegt" —
  genau den Ablauf, den die Prosa ausschließt) — **übernommen**: die Zeile
  prüft jetzt, dass das private fokussierte Fenster **nicht** den Tab bekommt.
- **Nits** (vier statt fünf Felder an zwei Stellen, „Default-Container" ohne
  `windowId`, `onMessage` statt `answerRequest`) — **übernommen**.

Der Log-Eintrag zu M2 (Runde 1, „`cookieStoreId` nach dem Anlegen prüfen") ist
durch B4 überholt: die Fensterwahl passiert **vor** dem Anlegen. Er bleibt als
Historie stehen, gilt aber nicht mehr.

**Zur Drei-Block-Regel** (`CONTRIBUTING.md`, Schritt 4): Diese Spec hat dreimal
blockiert. Geteilt wird **nicht** — der Zuschnitt ist ein Werkzeug plus eine
Methode; die drei Blöcke betrafen ausschließlich das Nachziehen einer einmal
getroffenen Entscheidung (Fensterwahl) in alle Abschnitte, nie den Umfang. Die
zwei Befunde aus Runde 3 sind übernommen, der Reviewer wird nach dieser Runde
nicht erneut gefragt (`CONTRIBUTING.md`, Schritt 4, letzter Satz). Der Betreiber ist
informiert („dann mal los", 2026-10-23); eine Umkehr wäre eine reine
Doku-Änderung.

Code-Review Runde 2 (2026-10-23) — Verdict `✅ Ship it`, mit eigenen Sonden
bestätigt: zwei und drei `navigate` im selben Tick ergeben genau ein
`tabs.create`, beide Aufrufe werden beantwortet, ein Listener bleibt mittendrin
und null am Ende; die Kette bleibt nach `no_default_window`, `invalid_params`
und einem werfenden `tabs.create` benutzbar, ohne unbehandelte Rejection. Die
Gegenproben zu F1/F2/F3/F5 sind rot, wenn das jeweilige Verhalten entfernt wird.
Zwei Doku-Nachträge (doppelter Log-Block, fehlende `## Testing`-Zeile für die
Debug-Ausgabe) sind hier erledigt; das Restrisiko der serialisierten Kette steht
unter `## Bekannte Lücken`.

Messlauf (2026-10-23, Kriterium 6) — erfüllt:

- Betreiber: Extension in `about:debugging` neu geladen, pi neu gestartet. Danach
  stand das Werkzeug in der Sitzung (`mcp__browser_control__browser_navigate`).
- **Erster Aufruf** mit `https://example.org/`:
  `{"tabId":23,"windowId":1,"url":"https://example.org/","title":"Example Domain","complete":true}`
  — alle fünf Felder, `complete: true`.
- **Der Tab ist echt:** `browser_status` listet unmittelbar danach Tab 23 mit
  `https://example.org/` und dem Titel „Example Domain" in Fenster 1, neben den
  drei Tabs, die vorher da waren.
- **Derselbe Tab wird wiederverwendet:** zweiter Aufruf mit
  `https://example.com/` antwortet `tabId: 23` — kein zweiter Tab in der
  Tableiste.
- Die Logzeile `navigate tab=… url=… complete=…` selbst konnte in dieser Sitzung
  nicht mitgelesen werden: die Bridge läuft als Kindprozess von pi, und pi fängt
  ihren stderr ab (kein Logfile mit dieser Zeile auf der Maschine). Belegt ist
  sie durch `test/hub.test.js`
  (`hub_withDebugLogging_shouldLogTheNavigateLineAndTheIndentedResult`); der
  Betreiber sieht sie in pis MCP-Ausgabe.

Nachtrag nach einem echten Lauf (2026-10-23) — Verhalten geändert, Spec deshalb
zurück auf `proposed`:

- **`navigate` konnte die vorherige Seite als Ergebnis melden.** Belegt:
  `navigate("https://www.youtube.com/")` antwortete
  `{"tabId":6,"url":"https://example.org/","title":"Example Domain","complete":true}`,
  während `browser_status` unmittelbar danach zeigte, dass der Tab auf YouTube
  stand. Ursache: die `tabs.get`-Nachkontrolle sah das `complete` der alten
  Seite. **Zweiter Defekt in derselben Antwort:** sie trug nur vier Felder —
  `windowId` fehlte —, obwohl `## Wire-Protokoll` fünf verlangt; der Test für
  den zweiten Aufruf muss deshalb **alle fünf** Felder prüfen.
  **Übernommen**: ein `complete` zählt nur nach dem Update (Ereignis oder
  `tabs.get` mit geänderter URL), die Wiederholung derselben Adresse antwortet
  sofort (ohne `loading`), und die Ablösung passiert vor dieser Antwort. Drei
  Testfälle, siehe `## Testing`. Stage 4a baut es, die letzte Stufe stellt die
  Spec wieder auf `active`.

Code-Review Runde 1 zum Nachtrag (2026-10-23) — Verdict `🔧`:

- **`onUpdated`-Zweig prüft die Adresse nicht** (ein `complete` der auslaufenden
  Seite wird genommen) — **nicht behoben**, spec-konform, steht mit Datum unter
  `## Bekannte Lücken`.
- **`complete: false` nennt weiter die vorherige Seite** — **nicht behoben**,
  die Spec erlaubt an dieser Stelle die angefragte URL; Zeile in
  `## Bekannte Lücken`.
- **Weiterleitung zurück auf die vorherige Adresse endet in `complete: false`**
  — **nicht behoben**, unter der Regel nicht unterscheidbar; Zeile in
  `## Bekannte Lücken`.
- **`## Testing` versprach drei Fälle, die Tabelle hatte zwei** —
  **übernommen**: Zeile „dieselbe Adresse, während der Tab `loading` meldet".

Code-Review Runde 2 (2026-10-23) — Verdict `🔧` nur noch für zwei Textzeilen in
Spec 05; der Code und die Gegenproben (URL-Bedingung, Adress-Shortcut,
Ablösungs-Reihenfolge, fünf Felder in jedem Pfad) sind abgenommen.

Messlauf des Nachtrags (2026-10-23) — erfüllt:

- **Der belegte Fehler ist weg:** nach `navigate("https://example.org/")`
  antwortete ein zweiter `navigate("https://www.youtube.com/")` mit
  `{"tabId":7,"windowId":1,"url":"https://www.youtube.com/","title":"YouTube","complete":true}`
  — die **neue** Seite, **fünf** Felder, derselbe Tab 7. Vorher kam an dieser
  Stelle `example.org`/„Example Domain" mit vier Feldern.
- **Der Agenten-Tab wird wiederverwendet** (beide Aufrufe `tabId: 7`), und ein
  gelöschter Tab führt zu `no_agent_tab` statt zu einem Ersatzgriff — beides
  beim Aufräumen der Messung beobachtet.

Nachtrag nach einem echten Lauf (2026-10-23):

- **`navigate` antwortete mit `about:blank` und dem alten Titel.** Belegt:
  `navigate("https://quant.com")` → `{"url":"about:blank","title":"(369)
  YouTube","complete":true}`, während der Tab danach auf `https://quant.com/`
  stand (die Adresse existiert nicht, die Seite war eine Fehlerseite).
  Ursache: `about:blank` unterscheidet sich von der vorherigen URL und passiert
  damit die Regel aus Stage 4a. **Übernommen**: `about:` zählt nie als geladene
  Seite, Stage 4b baut es, die letzte Stufe stellt die Spec wieder auf `active`.

Messlauf des Nachtrags (2026-10-23) — erfüllt:

- **`about:blank` kommt nicht mehr vor:** `navigate("https://quant.com")` (die
  Adresse existiert nicht) antwortete
  `{"tabId":7,"windowId":103,"url":"https://quant.com/","title":"quant.com/","complete":true}`
  — die angefragte Adresse, nichts mit `about:`. Vorher kam an dieser Stelle
  `about:blank` mit dem alten Titel.

**Nachtrag 2026-10-23 (Spec 16):** Es gibt **mehrere** Agenten-Tabs. `storage.local`
führt eine Liste `agentTabIds` (Migration vom alten Einzelwert beim ersten Lesen),
`browser_open_tab` legt einen an (höchstens fünf), `browser_close_tab` schließt einen,
und jedes Werkzeug nimmt einen optionalen `tab`-Parameter — ohne ihn gilt der zuletzt
benutzte Tab. `browser_status` markiert **jeden** Agenten-Tab mit `agent: true`.
