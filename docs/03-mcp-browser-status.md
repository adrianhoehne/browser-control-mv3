---
description: Die Bridge spricht MCP über stdio, damit pi den Browser erreicht — mit browser_status als erstem Tool (Fenster und Tabs aus dem Default-Container als JSON); stdout gehört von jetzt an dem Protokoll.
status: active
---

# MCP: pi erreicht den Browser (`browser_status`)

Bis hierher hat die Bridge den Status nur protokolliert. Dieses Inkrement macht
sie zum MCP-Server: pi fragt, die Bridge antwortet. Damit ist zum ersten Mal
etwas von außen benutzbar, ohne dass jemand ein Log liest.

## Ziel

Eine neue pi-Sitzung hat ein Tool `browser_status`; ein Aufruf liefert die
Fenster und Tabs des Betreibers (Default-Container, ohne private Fenster) als
JSON-Text. Ist die Extension nicht verbunden, kommt eine verständliche
Fehlermeldung statt eines Hängers.

Der Zuschnitt ist bewusst mager: **ein** Tool, **keine** Steuerung. Der Wert
dieses Inkrements ist, dass die MCP-Verdrahtung steht und die Naht damit
benutzbar wird — `navigate`, `click` und `screenshot` sind danach nur noch
weitere Methoden im selben Rahmen.

## Non-goals

- Keine Tab-Steuerung: kein `navigate`, `click`, `type`, `screenshot`, `focus`,
  kein Agenten-Tab.
- Kein zweites Tool, keine MCP-Resources, keine Prompts, kein Sampling, keine
  Notifications von der Bridge an den Client (`listChanged` bleibt `false`).
- Keine Änderung am Wire-Protokoll zwischen Extension und Bridge, an den
  Filtern, den Close-Codes oder am Reconnect-Verhalten.
- Keine Authentifizierung auf MCP-Ebene: der Server läuft als Kindprozess von
  pi und erbt dessen Rechte — die Grenze ist das Token gegenüber der Extension,
  nicht der Client.
- Kein systemd-Dienst, keine Signierung, kein Umbau der Bridge-Architektur.

## Betroffene Dateien

- `bridge/mcp.mjs` (neu) — JSON-RPC-Framing über stdio, `initialize`,
  `tools/list`, `tools/call`, `ping`; die Tool-Tabelle mit `browser_status`.
- `bridge/bridge.mjs` — startet den MCP-Teil zusätzlich zum WebSocket-Listener;
  stdout gehört ab jetzt dem Protokoll, jeder Logschreiber bleibt auf stderr.
- `bridge/hub.mjs` — `requestStatus()` liefert ein Promise auf die Antwort und
  vergibt je Anfrage eine eigene, aufsteigende `id` (heute gibt es genau eine
  feste `1`).
- `test/mcp.test.js` (neu) — Bridge als Kindprozess, JSON-RPC über stdin/stdout.
- `test/hub.test.js` — neue Fälle für `requestStatus()` (Stufe 1 des Dev-Plans).
- `INSTALL.md` — der Eintrag für `~/.pi/agent/mcp.json` (Betreiber).
- `extension/*`, `bridge/websocket.mjs`, `bridge/config.mjs` — **unverändert**.

## MCP über stdio (der Vertrag)

**Framing: eine JSON-Nachricht pro Zeile, jede Zeile endet mit `\n`, und auf
stdout steht nichts anderes.** Belegt am Client, gegen den es laufen muss: pis
`StdioTransport` sendet `${JSON.stringify(message)}\n`, liest stdout über
`indexOf(10)`, und wenn beim Beenden noch ein Rest ohne Zeilenende im Puffer
liegt, meldet er `MCP stdio server closed with an incomplete JSON-RPC message`.
Ein `console.log` irgendwo in der Bridge macht den Server also unbrauchbar —
deshalb ist stdout in dieser Spec ein Kanal, kein Ausgabegerät.

| Methode | Verhalten |
|---|---|
| `initialize` | gibt die `protocolVersion` des Clients zurück, wenn sie bekannt ist (`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`), sonst `2025-11-25`; `capabilities: {"tools":{"listChanged":false}}`; `serverInfo: {"name":"browser-control","version":"0.1.0"}` |
| `notifications/*` | werden geschluckt, keine Antwort (JSON-RPC: Notifications haben keine `id`) |
| `ping` | `{}` |
| `tools/list` | das Tool `browser_status` (Spec 04 ergänzte `browser_navigate`, Spec 05 `browser_read`), siehe unten |
| `tools/call` | siehe unten |
| unbekannte Methode | JSON-RPC-Fehler `{code:-32601, message:"method not found"}` |
| `tools/call` ohne brauchbares `name` | JSON-RPC-Fehler `{code:-32602, message:"invalid params"}` (die Anfrage ist fehlerhaft, nicht das Tool unbekannt) |
| kaputtes JSON in einer Zeile | `{code:-32700, message:"parse error"}`, und der Server **läuft weiter** (eine schlechte Zeile ist kein Grund zu sterben) |
| Zeile ist kein JSON-Objekt (Array, Zahl) | `{code:-32600, message:"invalid request"}` |

Jeder Fehler trägt `code` **und** `message`: JSON-RPC 2.0 verlangt beides, und
pi zeigt die Meldung sonst ohne Text an. Die Texte sind englisch, weil sie zur
Protokollebene gehören. Auch der Werkzeug-Text ist englisch (seit `docs/54`).

`tools/list` liefert genau:

| Feld | Wert |
|---|---|
| `name` | `browser_status` |
| `description` | Shows the windows and tabs of the operator's browser in the Default container, along with the extension's connection state, and marks the agent tab with `agent: true`. (englisch seit `docs/54`) |
| `inputSchema` | `{"type":"object","properties":{},"additionalProperties":false}` |

`tools/call` mit `browser_status` (keine Argumente):

- **Extension verbunden**: `{"content":[{"type":"text","text":"<JSON, 2 Leerzeichen eingerückt>"}]}`
  wobei `<JSON>` das Ergebnis aus `### Ergebnis von status` in Spec 01 ist
  (`{"extension":{…},"windows":[…]}`).
- **keine Extension verbunden**: `{"content":[{"type":"text","text":"No
  extension connected — Firefox with the extension is not running, or the
  connection was dropped."}],"isError":true}` (englisch seit `docs/54`).
- **keine Antwort binnen `BC_CALL_TIMEOUT_MS`** (Default 20 s):
  `{"content":[{"type":"text","text":"The extension did not answer
  (timeout)."}],"isError":true}` — kein Hänger, kein Absturz.
- **unbekannter Tool-Name**: `{"content":[{"type":"text","text":"Unknown
  tool: <name>"}],"isError":true}` (kein JSON-RPC-Fehler: der Client soll die
  Meldung sehen, nicht einen Protokollfehler).
- **`arguments` mit Inhalt**: `{"content":[{"type":"text","text":"browser_status
  takes no arguments."}],"isError":true}` — das Schema sagt
  `additionalProperties:false`, also gibt es auch keine stillschweigend
  ignorierten Argumente.
- **`ok:false` von der Extension** (der vierte Fall, vom Architekten gefunden):
  `{"content":[{"type":"text","text":"The extension could not deliver the status
  (code=<code>)."}],"isError":true}`.

## Hub-Änderung

`Hub.requestStatus()` gibt ein Promise zurück, das mit dem `status`-Ergebnis
auflöst oder mit einem typisierten Fehler ablehnt:

- `ExtensionUnavailable` — keine Extension verbunden (auch: Verbindung fällt
  während der Anfrage weg).
- `ExtensionTimeout` — `BC_CALL_TIMEOUT_MS` ohne Antwort.

Die Anfrage-Ids kommen aus einem Zähler **je Session** (`session.nextRequestId`,
`1`, `2`, …) statt aus der festen `STATUS_REQUEST_ID` — nicht aus einem Zähler
der Hub-Instanz, weil `pendingRequests` und damit die Id-Eindeutigkeit pro
Session gelten und weil der bestehende Fall
`hub_withSecondValidConnection_shouldReplaceOnlyThePreviousOneWith4409` für die
zweite Verbindung `id: 1` erwartet. `pendingRequests` ist bereits eine Map, also
bleibt die Zuordnung Antwort↔Anfrage unverändert. Die automatische
`status`-Anfrage beim Verbinden (Spec 01, Logzeile `status windows=…`) bleibt
erhalten und zieht aus demselben Zähler — sie ist der Grund, warum das
Bridge-Log weiterhin zeigt, dass die Naht lebt.

## Configuration

Keine neue Umgebungsvariable. `BC_CALL_TIMEOUT_MS` gilt weiter (Default 20000).

Eintrag für pis `~/.pi/agent/mcp.json` (kein Geheimnis, nur ein Pfad):

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "node",
      "args": ["~/browser-control/bridge/bridge.mjs"]
    }
  }
}
```

Der Block steht in der Datei unter dem vorhandenen `mcpServers`-Objekt — die
Hülle ist Teil des Vertrags mit pi, nicht Zierde.

Das Token liest die Bridge aus ihrem Default-Pfad
(`~/.config/browser-control/token`), eine `env`-Angabe ist nicht nötig. Fehlt
die Datei, endet die Bridge mit Exit 2 — pi meldet dann einen Serverstart-Fehler;
das ist die richtige Diagnose, gehört aber in `INSTALL.md`.

**Wer besitzt Port 8110.** pi läuft auf **dem Server**, also auf demselben Host wie
die Extension-Verbindung; der von pi gestartete Kindprozess ist damit der
einzige, der lauschen darf. Die Standalone-Bridge aus `INSTALL.md` §3 (`nohup`)
muss vorher **beendet** werden — sonst endet der pi-Kindprozess mit
`listener failed on 127.0.0.1:8110: EADDRINUSE` und Exit 1, und `browser_status`
existiert nicht. pi liest stderr mit, die Zeile steht dann im Client.

Daraus folgt eine **bekannte Grenze** dieses Inkrements: genau eine pi-Sitzung
kann die Bridge halten. Startet eine zweite pi-Sitzung, bekommt deren
Kindprozess denselben Fehler und hat kein `browser-control`. Das ist bewusst
akzeptiert und in `## Risiken` festgehalten; ein Besitz-Lock oder ein
detachter Dienst ist ein eigenes Inkrement.

## Testing

Alles ohne Browser und ohne Netz (`npm test` → `node --test test/*.test.js`).

| Datei / Fall | Was er beweist |
|---|---|
| `test/mcp.test.js` — Bridge als Kindprozess, `initialize` mit `2025-06-18` | Die angeforderte Version wird zurückgegeben |
| dito — `initialize` mit `1999-01-01` | Rückfall auf `2025-11-25` statt Fehler |
| dito — `tools/list` | `browser_status` mit dem Schema wie oben, `additionalProperties:false` (seit Spec 04 zwei Werkzeuge, seit Spec 05 drei) |
| dito — jede Zeile auf stdout mit `JSON.parse` | stdout trägt ausschließlich JSON-RPC; Logzeilen landen auf stderr |
| dito — `tools/call` ohne Extension | `isError: true` und der englische Satz aus dem Vertrag (seit `docs/54`) |
| dito — `tools/call` mit Fake-Extension | `isError` fehlt/false, der Text ist JSON mit `windows`/`tabs` aus dem Fixture |
| dito — `tools/call` mit unbekanntem Tool | `isError: true`, „Unknown tool: …" (englisch seit `docs/54`) |
| dito — unbekannte Methode | JSON-RPC-Fehler `-32601` |
| dito — eine Zeile kaputtes JSON, danach `ping` | `-32700` und der Server antwortet danach weiter |
| dito — Bridge beenden (stdin zu) | Prozess endet mit 0, kein Rest ohne Zeilenende im Puffer |
| dito — `tools/call` ohne `name` | JSON-RPC-Fehler `-32602` mit `message` |
| dito — Zeile, die kein JSON-Objekt ist (z. B. `[1,2]`) | `-32600`, der Server läuft weiter |
| dito — Zeile über `MAX_MESSAGE_BYTES` | `-32700`, Puffer verworfen, danach antwortet `ping` |
| dito — `stdio: ["ignore"]` statt Pipe | Der Prozess lebt weiter: die Standalone-Bridge aus `INSTALL.md` wird nicht vom EOF getötet |
| dito — `BC_LOG=debug` mit verbundener Extension | Das eingerückte JSON steht auf stderr; auf stdout steht keine Zeile ohne `jsonrpc` |

## Acceptance criteria

1. `npm test; echo $?` → `0`, Ausgabe enthält `# fail 0` (TAP-Reporter:
   `node --test --test-reporter=tap test/*.test.js 2>&1 | grep -q '^# fail 0'`);
   `npm run check; echo $?` → `0`. Die 49 bisherigen Fälle laufen unverändert;
   die Gesamtzahl steigt um die neuen Fälle aus `test/hub.test.js` **und**
   `test/mcp.test.js`.
2. `initialize` mit `1999-01-01` antwortet `2025-11-25`, mit `2025-06-18`
   antwortet es `2025-06-18` (Beleg: `test/mcp.test.js`, sichtbar mit
   `--test-reporter=spec`).
3. `tools/list` liefert `browser_status` mit
   `inputSchema.additionalProperties === false` (zwei Werkzeuge seit Spec 04,
   drei seit Spec 05).
4. Bei verbundener Fake-Extension liefert `tools/call browser_status` Text, der
   sich als JSON parsen lässt und `windows` mit mindestens einem Fenster enthält;
   ohne Extension kommt `isError: true` mit dem englischen Satz (seit `docs/54`).
5. Auf stdout steht ausschließlich JSON-RPC: **jede** Zeile des Kindprozesses
   ist ein Objekt mit `jsonrpc:"2.0"` und vorhandenem `id`-Feld — bei
   Parse-Fehlern `null` (nicht bloß „irgendwie JSON"); jede Fehlerantwort trägt
   `code` und `message`, und eine kaputte Eingabezeile beendet den Server nicht (`-32700`,
   danach antwortet `ping`). Dazu die Gegenrichtung: die Logzeilen
   (`listening on …`, `status windows=…`, bei `BC_LOG=debug` das eingerückte
   JSON) stehen auf stderr und kommen auf stdout **nicht** vor — der Fall
   `BC_LOG=debug` mit verbundener Fake-Extension ist der einzige, der mehrzeilige
   Ausgabe erzeugt. Beleg: `test/mcp.test.js`.
6. **Die Handgriffe des Betreibers**, in dieser Reihenfolge: (a) die
   Standalone-Bridge aus `INSTALL.md` §3 beenden (`kill <pid>`; sonst
   `EADDRINUSE`), (b) den Block aus `## Configuration` unter `mcpServers` in
   `~/.pi/agent/mcp.json` eintragen, (c) pi neu starten. Danach steht das
   Werkzeug zur Verfügung — pi präfixt MCP-Namen, es heißt also
   `mcp__browser_control__browser_status` und endet auf `browser_status` —, und
   ein Aufruf liefert die Tabs. Ohne Neustart sieht pi den neuen Server nicht.

## Dev plan

Fünf Stufen, jede für sich grün. `test/mcp.test.js` startet immer den echten
Einstiegspunkt `bridge/bridge.mjs` (Kriterium 5 prüft den Prozess, nicht das
Modul). Die Prozess-Helfer (`findFreePort`, `waitForListener`,
`createTokenFile`, `startFakeExtension`) werden aus `test/bridge.test.js`
**kopiert**, nicht dorthin extrahiert — ein Refactor dort riskiert die 49
Bestandsfälle für nichts. Anders als das dortige `startProcess` bekommt der
Helfer in `test/mcp.test.js` **`stdin: "pipe"`** (dort `["ignore", …]`, dann ist
`child.stdin` `null` und jede Probe würde werfen); der `["ignore"]`-Fall ist der
Gegenfall in Stufe 4.

1. **Hub: `requestStatus()` mit Zähler je Session und typisierten Fehlern** —
   `bridge/hub.mjs`: `STATUS_REQUEST_ID` fällt weg, neu `session.nextRequestId =
   0` in der Session-Struktur, vergeben mit `++session.nextRequestId` (erste
   Anfrage je Verbindung also `1`, was den bestehenden
   `deepEqual(…, id: 1)`-Fall der zweiten Verbindung grün hält).
   `#requestStatus(session)` wird `#askStatus(session)` und gibt ein Promise
   zurück; `pendingRequests`-Werte werden von Timeout-Handle zu
   `{timeout, resolve, reject}`. Neuer exportierter `HubRequestError extends
   Error` mit `name` aus `ExtensionUnavailable | ExtensionTimeout |
   ExtensionError` (`ExtensionError` trägt `code` der `ok:false`-Antwort).
   `#accept` ruft `this.requestStatus().catch(() => {})` — der Auto-Aufruf loggt
   weiterhin `status windows=…`; die Zeilen `status timeout peer=…` und
   `status failed peer=… code=…` entstehen im **Timer-Callback** bzw. im
   Reject-Pfad von `#handleResponse`, nicht in `#reportStatus` (das loggt nur den
   Erfolg). Der Timer-Callback lehnt mit `ExtensionTimeout` ab, `ok:false` mit
   `ExtensionError`, `sent === false` sofort mit `ExtensionUnavailable`.
   `#clearTimers` räumt `entry.timeout` ab (nicht mehr den nackten Handle, sonst
   feuert nach einem Disconnect eine Geister-`status timeout`-Zeile). `#handleClose`
   lehnt **vor** `#clearTimers` alle offenen Einträge der Session mit
   `ExtensionUnavailable` ab. `formatStatusLine`/`verifyToken` byte-gleich.
   Proof: neue Fälle in `test/hub.test.js` — zwei gleichzeitige `requestStatus()`
   nach der Auto-Anfrage bekommen verschiedene Ids und lösen in umgekehrter
   Antwortreihenfolge richtig auf (gesucht über `id`, nie über die Position);
   kein Peer → `ExtensionUnavailable`; stiller Peer mit
   `BC_CALL_TIMEOUT_MS=200` → `ExtensionTimeout` **und** weiterhin die
   `status timeout`-Zeile; `ok:false` → `ExtensionError` mit `code`; Disconnect
   während offener Anfrage → `ExtensionUnavailable` und keine Geister-Zeile.
   Dann `node --test --test-reporter=tap test/hub.test.js 2>&1 | grep -q '^# fail 0'; echo $?`
   → `0`. **Completed 2026-10-23**
2. **`bridge/mcp.mjs` (Framing, `initialize`, `ping`, Fehlercodes) plus
   Verdrahtung** — neu `bridge/mcp.mjs` mit `startMcpServer({ hub, log, input =
   process.stdin, output = process.stdout, onInputClosed })`: `node:readline`-
   Interface (`crlfDelay: Infinity`) mit einer Zeilenlängen-Grenze von
   `PROTOCOL.MAX_MESSAGE_BYTES` (längere Zeile → `-32700`, Puffer wird
   verworfen); `handleLine(text)` → `JSON.parse`, bei Fehler
   `{jsonrpc:"2.0", id:null, error:{code:-32700}}` und weiterlaufen;
   Nicht-Objekt/Array → `-32600` mit `id:null` (kein Batch-Support, MCP nutzt
   keine Batches). Nachricht ohne `id` = Notification → keine Antwort.
   `initialize` → `protocolVersionFor(params.protocolVersion)` (bekannt:
   `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, sonst `2025-11-25`),
   `capabilities.tools.listChanged = false`, `serverInfo {name:"browser-control",
   version:"0.1.0"}`; `ping` → `{}`; unbekannte Methode → `-32601`.
   `writeMessage()` schreibt `JSON.stringify(m) + "\n"` auf `output` und hängt
   einen leeren `error`-Handler an `output` (EPIPE darf den Exit-Code nicht
   verändern). In `bridge/bridge.mjs` nach `server.listen`
   `startMcpServer({ hub, log: logLine, onInputClosed: … })`; `logLine` bleibt
   auf stderr, stdout bekommt ausschließlich `writeMessage`.
   Proof: `test/mcp.test.js` (neu) — `initialize` mit `2025-06-18` → dieselbe
   Version, mit `1999-01-01` → `2025-11-25`; jede stdout-Zeile ist ein Objekt mit
   `jsonrpc:"2.0"`; `notifications/initialized`, dann `ping` → genau eine
   Antwortzeile, gesucht über die `id` des `ping`; unbekannte Methode →
   `-32601`; kaputte Zeile → `-32700`, danach antwortet `ping`;
   `listening on …` steht auf stderr und nicht auf stdout.
   `node --test --test-reporter=tap test/mcp.test.js 2>&1 | grep -q '^# fail 0'; echo $?`
   → `0` und `npm test` weiter grün. **Completed 2026-10-23**
3. **`tools/list` und `tools/call`** — `bridge/mcp.mjs`: Konstante `TOOLS` mit
   genau `browser_status`, `description` und `inputSchema {"type":"object",
   "properties":{},"additionalProperties":false}` wörtlich aus dem Vertrag;
   `callTool(params)`: fehlendes/falsches `name` → `-32602`; vorhandenes aber
   unbekanntes `name` → `{content:[{type:"text",text:"Unbekanntes Tool:
   <name>"}],isError:true}`; `arguments` fehlt oder ist `{}` → ok, `arguments`
   mit irgendeinem Schlüssel oder Nicht-Objekt → `isError:true` mit
   `"browser_status erwartet keine Argumente."`. `browser_status` →
   `await hub.requestStatus()`: Erfolg → `text: JSON.stringify(result, null, 2)`;
   `ExtensionUnavailable` → der Satz aus dem Vertrag; `ExtensionTimeout` → der
   Timeout-Satz; `ExtensionError` → der `ok:false`-Satz mit `code`. Zwei
   gleichzeitige `tools/call` laufen als zwei unabhängige `await`s ohne Queue,
   die Antworten tragen die Client-`id`.
   Proof: `test/mcp.test.js` erweitert — `tools/list` mit
   `additionalProperties === false`; mit Fake-Extension parst der Text und
   enthält `windows.length >= 1`; ohne Extension `isError:true` und wörtlich der
   englische Satz; `BC_CALL_TIMEOUT_MS=300` plus `BC_TEST_ANSWER=0` → Timeout-Satz
   statt Hänger; unbekanntes Tool; `{"name":"browser_status","arguments":{"x":1}}`
   abgelehnt; zwei Aufrufe in einem Schreibvorgang → zwei Antworten mit den
   richtigen Ids; `BC_LOG=debug` mit verbundener Fake-Extension → das
   eingerückte JSON steht auf stderr, auf stdout steht keine Zeile ohne
   `jsonrpc`.
   `node --test --test-reporter=tap test/mcp.test.js 2>&1 | grep -q '^# fail 0'; echo $?`
   → `0`. **Completed 2026-10-23**
4. **Lebenszyklus: stdin-Ende und ein einziger Exit-Pfad** —
   `bridge/bridge.mjs`: `installShutdownHandlers(server)` gibt ein idempotentes
   `stop(reason)` zurück (Guard-Boolean, `logLine(`${reason}, shutting down`)`,
   `server.close()`, `closeAllConnections()`, `process.exitCode = 0`, dann
   `process.exit(0)`). SIGTERM/SIGINT rufen `stop("received SIGTERM")`, das
   stdin-Ende ruft `stop("stdin closed")` — beide durch denselben Guard, also
   loggt und beendet nur der erste.
   **Festgelegt, gemessen:** stdin-Ende beendet die Bridge mit 0, aber nur wenn
   stdin eine **Pipe oder eine Socketpair** ist
   (`const st = fs.fstatSync(0)` in `try/catch` — `EBADF`, wenn fd 0 zu ist —
   und `st.isFIFO() || st.isSocket()`). `isFIFO()` **allein** wäre falsch: Node
   gibt dem Kind bei `stdio: "pipe"` eine Unix-Socketpair (gemessen:
   `isFIFO=false isSocket=true`), also würde die Regel unter pi nie greifen.
   `stdio: ["ignore", …]` liefert `/dev/null` (`isChar=true`), und `nohup … &`
   tut das **nur, wenn stdin ein Terminal war** — `echo | nohup … &` oder
   `ssh host 'nohup … &'` ohne PTY geben eine Pipe weiter (gemessen:
   `isFIFO=true`), und dort darf das Ereignis die Standalone-Bridge aus
   `INSTALL.md` §3 nicht töten. Deshalb startet `INSTALL.md` die Bridge mit
   `< /dev/null`; ohne das wäre der Start über `ssh` der Ausnahmefall, der sie
   beim ersten EOF beendet.
   Proof: zwei neue Fälle in `test/mcp.test.js` — `child.stdin.end()` nach einer
   beantworteten Anfrage → Exit `0` binnen 5 s, genau eine
   `shutting down`-Zeile auf stderr, jede stdout-Zeile ist JSON-RPC; derselbe
   Lauf mit verbundener Fake-Extension → ebenfalls `0` und nur eine
   Shutdown-Zeile; Gegenfall `stdin: "ignore"` → Prozess lebt nach 300 ms noch
   und der Port nimmt weiter Verbindungen an.
   `node --test --test-reporter=tap test/mcp.test.js 2>&1 | grep -q '^# fail 0'; echo $?`
   → `0`. **Completed 2026-10-23**
5. **Abnahmelauf und Übergabe — kein Produktcode** — der Umsetzer fährt
   `npm test; echo $?` (0, `# fail 0`), `npm run check; echo $?` (0) und
   `git grep --untracked -nE '[0-9a-f]{32,}' -- .` (keine Ausgabe, Exit 1) und
   zählt die Gesamtzahl der Fälle (49 + neue). Er prüft Kriterien 1–5 einzeln und
   schreibt die Sätze für Kriterium 6 als Hand-over-Text (Standalone-Bridge
   beenden, `mcp.json`-Block, pi neu starten); `~/.pi/agent/mcp.json`
   wird **nicht** angefasst, `INSTALL.md` und `docs/*` auch nicht — die schreibt
   der Orchestrator.
   Proof: die drei Befehle oben mit Exit-Code im Log, plus
   `node --test --test-reporter=spec test/mcp.test.js` mit den zitierten
   Fallnamen für Kriterien 2–5. **Completed 2026-10-23**

### What could go wrong

- **Unbehandelte Rejection aus der Auto-Anfrage.** Ohne `.catch()` beendet Node
  den Bridge-Prozess (`--unhandled-rejections=throw`), sobald die Extension beim
  Verbinden nicht antwortet. Der `.catch(() => {})` in `#accept` ist Pflicht,
  nicht Kosmetik.
- **`process.exit(0)` nach einem `write`.** Der stdin-Pfad schreibt keine
  Antwort mehr, deshalb ist der Exit dort unbedenklich; im SIGTERM-Pfad bleibt
  er, wie er ist, weil dort ebenfalls nichts mehr erwartet wird. Wer später eine
  Antwort auf das Schließen legt, muss `exitCode` setzen und den Loop auslaufen
  lassen, statt zu exiten.
- **Doppelter Exit.** `stop` ohne Guard loggt zweimal; SIGTERM und stdin-Ende
  können im selben Tick eintreffen. Der Boolean ist die ganze Absicherung,
  deshalb in Stufe 4 mit einem eigenen Fall geprüft.
- **`/dev/null` statt Pipe.** Wird die Prüfung auf `isTTY` verkürzt oder
  `isSocket()` vergessen, stirbt entweder die Standalone-Bridge aus
  `INSTALL.md` sofort (ersteres) oder die Regel greift unter pi nie (letzteres).
  Beides deckt Stufe 4 ab.
- **Nachrichten-Reihenfolge.** Antworten werden in Abschlussreihenfolge
  geschrieben, nicht in Anfragereihenfolge — erlaubt (Zuordnung über `id`), aber
  ein Test, der auf Zeilenreihenfolge baut, bricht zufällig. Nach `id` suchen,
  nie nach Position.
- **EADDRINUSE, wenn die Standalone-Bridge noch läuft.** Der pi-Kindprozess
  stirbt mit Exit 1, pi meldet einen Serverstart-Fehler. Das ist der
  wahrscheinlichste Stolperstein beim ersten Einsatz (siehe `## Configuration`).

### Ordering and dependencies

Stufe 1 schafft das Promise, das 2 und 3 konsumieren; Stufe 2 schafft Datei
**und** Verdrahtung, weil `test/mcp.test.js` den echten `bridge/bridge.mjs`
startet und eine halbe Verdrahtung den Baum rot ließe; Stufe 3 erweitert nur
`bridge/mcp.mjs` und `test/mcp.test.js`; Stufe 4 braucht das `stop`-Handle aus
Stufe 2 (`onInputClosed` existiert dort schon als Parameter) und ändert nur
`bridge/bridge.mjs` plus Testfälle; Stufe 5 ist ein Lauf über allem. Keine Stufe
fasst `extension/`, `bridge/websocket.mjs`, `bridge/config.mjs`, `package.json`
oder `docs/` an. `INSTALL.md` (Standalone-Abschnitt, `mcp.json`-Block) und der
`mcp.json`-Eintrag sind Hand-over-Text des Orchestrators bzw. Betreibers, keine
Stufe.

### What the next increment inherits

- **Weitere Tools** (`navigate`, `click`, `screenshot`, `focus`): ein Eintrag in
  `TOOLS` und ein Zweig in `callTool`, dazu neue Methoden in
  `PROTOCOL.METHODS`, `extension/background.js` und ein `Hub`-Gegenstück zu
  `requestStatus()` mit Methoden-Parameter. Der Rahmen aus Stufe 2/3 trägt sie
  ohne Umbau.
- **Abbruch laufender Aufrufe** (`AbortSignal` gegen die 20 s aus
  `BC_CALL_TIMEOUT_MS`) ist bewusst nicht da; ein hängender `tools/call`
  blockiert nur seinen eigenen Client-Request, nicht den Prozess.
- **Ein Besitz-Anspruch auf Port 8110** (Lock-Datei oder detachter Dienst), damit
  mehrere pi-Sitzungen denselben Browser teilen können — heute gewinnt die erste,
  die anderen bekommen `EADDRINUSE`.
- **Test-Helfer-Duplikat:** `test/bridge.test.js` und `test/mcp.test.js` tragen
  dieselben Prozess-/Port-/Token-Helfer. Eine gemeinsame Datei ist ein eigener
  kleiner Schritt, kein Nebenprodukt dieses Inkrements.

## Risiken

- **stdout ist von jetzt an ein Protokollkanal.** Jedes `console.log`, jede
  versehentliche Ausgabe macht den Server für pi unbrauchbar, und der Fehler
  sieht aus wie ein Protokollfehler, nicht wie eine Debug-Zeile. Gegenmittel:
  Kriterium 5 prüft es, und der Logschreiber der Bridge schreibt schon heute
  ausschließlich nach stderr.
- **pi liest stderr mit** (`stderr: "pipe"` im Transport). Bei `BC_LOG=debug`
  landet das eingerückte JSON im Client. Das ist gewollt (Diagnose), kann aber
  lang werden; `info` bleibt der Default.
- **Ein hängender Aufruf blockiert bis 20 s**, weil die Zeitgrenze
  `BC_CALL_TIMEOUT_MS` gilt und kein Abbrechen implementiert ist. Für dieses
  Inkrement akzeptiert; ein `AbortSignal` gehört in die Spec, die es braucht.
- **Fehlendes Token** beendet die Bridge mit Exit 2 — pi zeigt dann einen
  Serverstart-Fehler. Die Diagnose steht in `INSTALL.md`, nicht im Client.
- **Die Extension bleibt ungetestet für Tool-Aufrufe**: geprüft wird mit der
  Fake-Extension; dass der echte Browser dasselbe liefert, ist durch Spec 01
  belegt (die `status`-Antwort ist dieselbe).
- **Genau eine pi-Sitzung hält die Bridge** (siehe `## Configuration`): die
  zweite bekommt `EADDRINUSE` und kein `browser-control`. Für einen
  Ein-Personen-Betrieb akzeptiert; ein Besitz-Lock ist ein eigenes Inkrement.
- **Ohne laufende pi-Sitzung gibt es keine Bridge** und damit keine Verbindung
  für die Extension; sie versucht es mit Backoff weiter. Wer den Browser auch
  ohne pi erreichbar braucht, fährt die Standalone-Bridge weiter — dann aber
  nicht gleichzeitig mit pi.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten (JSON-RPC ist ein paar Zeilen auf
  `node:readline`), keine Tokens im Repo.
- `extension/` wird nicht angefasst, `bridge/websocket.mjs` und
  `bridge/config.mjs` auch nicht.
- `docs/PROJECT-STATE.md` und `docs/README.md` pflegt der Orchestrator.
- Kein Produktivcode für spätere Inkremente (`navigate`, `click`, Screenshot,
  Agenten-Tab, systemd, Signierung).

## Bekannte Lücken

Stand 2026-10-23, nach der Umsetzung:

- **Der `ok:true`-Zweig ohne `result` ist nicht abgedeckt** (N3 aus dem
  Code-Review): antwortet die Extension mit `ok:true` und ohne `result`, wird
  `JSON.stringify(undefined)` zu `undefined`, das `text`-Feld verschwindet und
  es bleibt `{"content":[{"type":"text"}]}`. Der Vertrag deckt den Fall nicht;
  eine kaputte Extension ist heute ein Vertragsbruch, kein Fehlerpfad.
- **Der `!sent`-Fall in `test/hub.test.js` hat kein eigenes Zeitlimit** (N2):
  ohne den Zweig wird er erst nach etwa 10 s rot statt sofort.
- **Prozess-/Port-/Token-Helfer liegen doppelt** (`test/bridge.test.js` und
  `test/mcp.test.js`, zusammen ~150 Zeilen). Extraktion ist ein eigener kleiner
  Schritt, kein Nebenprodukt dieses Inkrements.
- **`Hub.onStatus` bleibt unbenutzt** — die MCP-Schicht nimmt
  `Hub.requestStatus()`. Wer den Seam braucht, findet ihn unverändert vor.
- **Kriterium 6 ist gelaufen** (2026-10-23): Standalone-Bridge beendet,
  `mcpServers`-Block in `~/.pi/agent/mcp.json` eingetragen (Backup daneben), pi
  neu gestartet. Beleg: pi spawnt die Bridge (`node …/bridge/bridge.mjs`,
  Kindprozess von pi), sie lauscht auf `127.0.0.1:8110`, die Extension ist
  verbunden (`ss` zeigt genau eine Verbindung), und der Aufruf von
  `mcp__browser_control__browser_status` liefert `windows` mit zwei Fenstern
  und drei Tabs als JSON — der erste echte Pfad von pi bis in den Browser.
- **Ein Lauf von `npm test` war einmal rot** (2026-10-23, Exit 1), ohne dass der
  Fall festgehalten wurde; die 17 Läufe danach waren grün. Kandidaten sind die
  Zeitfenster (200 ms/300 ms in den Hub-/MCP-Fällen, 10 s im `!sent`-Fall) und
  die freie Portwahl in den beiden Kindprozess-Tests. Nicht behoben, weil nicht
  reproduzierbar — wenn es wieder auftritt, bitte mit vollständiger Ausgabe.

## Open questions

Keine. Entschieden mit dem Betreiber am 2026-10-23: Inkrement 3 ist die
MCP-Schicht mit genau einem Tool (`browser_status`), keine Steuerung.

## Review

| Runde | Datum | Verdict | Blocker |
|---|---|---|---|
| 1 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (isFIFO, Zähler-Ort, Portbesitz) |

## Log

Runde 1 des Spec-Reviews — je Befund eine Zeile:

- **M1** (`fs.fstatSync(0).isFIFO()` ist unter pi immer `false`; Node gibt dem
  Kind bei `stdio: "pipe"` eine Unix-Socketpair — vom Reviewer gemessen —, also
  hätte die eigene Stufe-4-Probe nie gegriffen) — **übernommen**:
  `try/catch` um `fstatSync(0)` und `isFIFO() || isSocket()`; `isFIFO()` allein
  als Fehlerfall in `### What could go wrong` benannt.
- **M2** (Id-Zähler gehörte an die Session, nicht an die Hub-Instanz; sonst
  bekommt die zweite Verbindung `id: 2` und der bestehende 4409-Fall bricht) —
  **übernommen**: `session.nextRequestId`, im Plan und im Abschnitt
  `## Hub-Änderung`.
- **M3** (die Spec sagte nicht, auf welchem Host pi läuft und wem Port 8110
  gehört; der pi-Kindprozess wäre mit `EADDRINUSE` gestorben) — **übernommen**:
  eigener Absatz in `## Configuration` (pi läuft auf dem Server, die
  Standalone-Bridge muss vorher weg), `## Risiken` und
  `### What the next increment inherits` benennen die Grenze „eine pi-Sitzung".
- **m1** (`#clearTimers` kannte den neuen Wertetyp nicht, Geister-Zeile
  `status timeout` nach einem Disconnect) — **übernommen**: `entry.timeout` und
  der Reject-Pfad stehen jetzt ausdrücklich in Stufe 1.
- **m2** (die kopierte `startProcess` nutzt `stdio: ["ignore"]`, dann ist
  `child.stdin` `null`) — **übernommen**: der Helfer in `test/mcp.test.js` bekommt
  `stdin: "pipe"`.
- **m3** (`-32602` war im Plan erfunden, stand in keinem Vertrag) —
  **übernommen**: Zeile in der Vertragstabelle.
- **m4** (Stufe 2 baute auf Stream-Reihenfolge, was `### What could go wrong`
  verbietet) — **übernommen**: gesucht wird über die `id`.
- **m5** (Kriterium 5 prüfte nur „ist JSON", nicht „ist JSON-RPC", und nichts
  prüfte, dass Logzeilen auf stderr landen) — **übernommen**: jede
  stdout-Zeile muss ein Objekt mit `jsonrpc:"2.0"` sein, dazu der
  `BC_LOG=debug`-Fall als Gegenprobe.
- **m6** (Hub-Schnittstelle aus Spec 01 ändert sich ohne Amendments) —
  **übernommen**: Abschnitt `## Amendments to previous spec docs`.
- **m7** (`process.exit` kann eine gequeute Antwort verschlucken; Zeilenlänge
  ohne Grenze; `#reportStatus` loggt nur den Erfolg) — **übernommen**: Exit nur
  im stdin-/SIGTERM-Pfad, Zeilenlängen-Grenze `MAX_MESSAGE_BYTES`, und die
  `status timeout`/`status failed`-Zeilen entstehen im Timer bzw. im
  Reject-Pfad.

Runde 2 des Spec-Reviews — Verdict `✅ Ship it`, sechs Nacharbeiten ohne
Gate-Wirkung, alle übernommen:

- **Kriterium 6 nannte einen Handgriff, es sind drei** (Standalone-Bridge
  beenden, Block eintragen, pi neu starten) — **übernommen**, inklusive der
  Reihenfolge.
- **Der `mcp.json`-Block hatte keine `mcpServers`-Hülle** — **übernommen**:
  vollständiges JSON mit Hülle, plus der Satz, dass die Hülle Teil des Vertrags
  ist.
- **`nohup … &` liefert nur dann `/dev/null`, wenn stdin ein Terminal war** —
  **übernommen**: die Aussage ist eingeengt, und `INSTALL.md` §3 startet die
  Bridge jetzt mit `< /dev/null`.
- **`## Log` trug noch „Noch keine Befunde."** über der Runde-1-Liste —
  **übernommen**, Zeile entfernt.
- **`test/hub.test.js` fehlte in `## Betroffene Dateien`** — **übernommen**;
  Kriterium 1 zählt die neuen Fälle jetzt auch dort.
- **Drei Vertragsverhalten ohne Testzeile** (`-32602`, `-32600`,
  Zeilenlängengrenze) — **übernommen**: drei Zeilen in `## Testing`.
- **Kriterium 5 verlangte „einer `id`"**, was mit den `id:null`-Antworten auf
  Parse-Fehler kollidiert — **übernommen**: „vorhandenes `id`-Feld, bei
  Parse-Fehlern `null`".
- **Kriterium 6 nannte den nackten Toolnamen**, pi präfixt aber
  (`mcp__browser_control__browser_status`) — **übernommen**: Halbsatz ergänzt.

Stufe 1–2, Befund des Umsetzers (2026-10-23):

- **Der Vertrag nannte bei Fehlern nur `code`, JSON-RPC 2.0 verlangt `code` und
  `message`** (pi zeigt sonst einen Fehler ohne Text) — **übernommen**: alle
  Fehlerzeilen der Vertragstabelle nennen beides, mit englischem Text, und
  Kriterium 5 prüft es.

Code-Review Runde 1 der Umsetzung (2026-10-23) — je Befund eine Zeile:

- **B1** (der Vertragsfall `ok:false` hatte keinen Test; der Reviewer änderte den
  deutschen Satz ins Englische und die Suite blieb grün, weil die Fixture
  `ok:false` gar nicht konnte) — **behoben**: `BC_TEST_ANSWER=error:<code>` in
  `test/fixtures/fake-extension.mjs`, plus ein Fall in `test/mcp.test.js`, der den
  Satz wörtlich prüft (Gegenprobe: englischer Satz → rot).
- **F1** (`void handleLine(...)` ohne `.catch` — die Falle aus `### What could go
  wrong`) — **behoben**: `.catch` mit Logzeile; gemessen kostet ein Reject aus
  `handleLine` ohne das Netz den Prozess (Exit 1, keine Antwort), mit dem Netz
  antwortet der Server weiter.
- **F2** (der Geister-Test verließ sich auf ein 200-ms-Fenster, in dem die
  automatische Anfrage noch offen war) — **behoben**: die Auto-Anfrage wird
  vorher beantwortet und ihr Log abgewartet, danach ist nur der eigene Timer scharf.
- **F3** (ohne `#rejectAllPending` hing der Fall, statt rot zu werden) —
  **behoben**: `{ timeout: 15000 }`; Gegenprobe gemessen: `test timed out after
  15000ms`, also rot nach 15 s statt blockierter Suite.
- **F4** (`parseRpcLines` verwarf einen Rest ohne `\n` stillschweigend) —
  **behoben**: `splitStdout` gibt den Rest zurück, die Ende-des-Strom-Fälle
  prüfen ihn über `assertNoUnfinishedTail`.
- **F5** (Kommentar und Testname überzeichneten die 1-MiB-Grenze als
  Speichergrenze) — **behoben**: eingeengt auf „was beantwortet wird"; `readline`
  puffert die Zeile vollständig. Kein Verhalten geändert.
- **F6** (zwei unbelegte Zusagen) — **behoben**: ein Fall mit String-`id` und `0`
  nagelt das `??` fest; der `!sent`-Zweig in `hub.mjs` wird über eine
  Send-Attrappe in `startHubServer` geprüft (`wrapConnection`).

Messlauf (2026-10-23, Kriterium 6, der einzige, der noch offen war):

- **Kriterium 6** — erfüllt. Drei Handgriffe: Standalone-Bridge beendet
  (Port 8110 frei), `browser-control` unter `mcpServers` eingetragen
  (`~/.pi/agent/mcp.json`, Backup `mcp.json.bak-2026…`), pi neu gestartet.
  Belege: der Server läuft als Kindprozess von pi (`ppid` = pi-Prozess), `ss`
  zeigt genau eine Extension-Verbindung auf `:8110`, und der Werkzeugaufruf
  `mcp__browser_control__browser_status` liefert JSON mit `windows` und `tabs`.
- **Vorher, ohne Extension**, auf einem Testport geprüft: `initialize` echot
  `2025-06-18`, `tools/list` nennt genau `browser_status`, `tools/call` gibt den
  deutschen Satz als `isError`, `stdin`-Ende beendet mit Exit 0 und einer
  `stdin closed, shutting down`-Zeile — das ist der Vertrag aus `## MCP über
  stdio`, einmal von Hand gesehen statt nur im Test.

**Nachtrag 2026-10-23 (Spec 12):** Jeder Tab im Ergebnis trägt zusätzlich
`agent` — `true` an genau dem Tab, dessen Id in den Einstellungen gespeichert ist
und der im Default-Container liegt, sonst `false`.
