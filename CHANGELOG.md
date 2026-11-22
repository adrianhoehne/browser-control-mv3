# Changelog

Alle nennenswerten Änderungen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionierung nach [SemVer](https://semver.org/lang/de/).

## [Unreleased]

Nichts offen.

## [0.6.2] — 2026-11-22

**Alles, was der Agent liest, ist englisch.** Die Refusals der Bridge, die
Meldungen der Erweiterung und die vierzehn Werkzeugbeschreibungen sind
übersetzt; Fehlercodes, Logzeilen und Kommentare bleiben, wie sie sind. Ein
neuer Wächter (`bridge-rs/tests/texts.rs`) prüft `texts.rs`, `tools.rs` und
`help.rs` auf Umlaute, damit keine deutsche Zeile unbemerkt zurückkommt.

Dazu: `docs/54` (Refusals und Beschreibungen), `docs/55` (die alten Zitate in
den aktiven Specs), `docs/53` und `CONTRIBUTING.md` nachgezogen. Kein Verhalten
geändert — dieselben Codes, dieselben Fälle, nur der Satz.

## [0.6.1] — 2026-11-20

**`browser_eval` läuft wieder.** Unter MV3 war es tot: `new Function` ist im
isolierten Kontext von der CSP der Erweiterung blockiert. Der Code reist jetzt als
`func` in die **Seitenwelt** (`world: "MAIN"`), ohne Nachrichtenkanal — kein
stummer Frame, kein Antwortbudget. `await` ist auf oberster Ebene erlaubt. Eine
Seite mit eigener CSP antwortet mit `eval_blocked_by_the_page` statt mit einem
nackten Fehlertext; der Hinweis am `allowEval`-Schalter nennt jetzt auch die
Seitenvariablen, die der Code sieht.

Dazu: `docs/50` (await), `docs/49` (Vertrag und Umzug), `docs/48` (Seitenwelt),
Ende-zu-Ende gegen den laufenden Dienst gemessen — Titel, Seitenvariable, DOM-Knoten
mit Selektor, Promise mit Frist, geworfener Fehler ohne Stack, `null` ohne `return`,
`eval_timeout`, `eval_result_too_large` und der CSP-Fall.

## [0.6.0] — 2026-11-18

**Die Erweiterung läuft auf MV3, und der Socket wohnt in einem eigenen Tab.**
Firefox entlädt eine MV3-Eventpage nach 30 Sekunden Leerlauf und zählt eine
offene WebSocket nicht als Aktivität (`docs/02`, gemessen 2026-10-23). Deshalb
hält jetzt ein **angepinnter Brücken-Tab** die Verbindung; der Hintergrund ist
nur noch Koordinator und darf sterben.

- **Gemessen:** 33 Minuten Leerlauf ohne ein einziges Verbindungsereignis, ein
  offener Socket; ein geschlossener Brücken-Tab ist nach **168 ms** und **147 ms**
  zurück; nach einem Dienst-Neustart ist die Verbindung in **1 453 ms** wieder da,
  ohne neuen Tab.
- **Injection-Naht:** kein Quelltext mehr auf der Leitung. Die Seitenfunktionen
  liegen als `page-agent.js` im Tab, die Antworten laufen als `{callId, ok, value}`
  zurück; die Frame-Inventur entsteht aus Selbstmeldungen, die Sammlung endet bei
  der Frame-Zahl oder nach 5 000 ms. `bridge.js` schrumpft von 7 036 auf 4 973
  Zeilen.
- **Schalter in der Symbolleiste:** drei Icons (Brücke, gelber Blitz bei
  unerreichbarer Bridge, rot überkreuzt), Vorgabe **aus**. Ausschalten sagt
  `goodbye` auf der Leitung, schließt den Socket mit `1000`, schließt den Tab.
- **`ws://` gilt nur noch für Loopback** — der Fernfall braucht `wss://` oder
  einen SSH-Tunnel (`INSTALL.md` §9). Die Meldung nennt beide Wege.
- **MV3-Preis, ehrlich:** die Vorgabe-CSP hebt `ws://` auf `wss://` an (Socket
  schloss mit `1015`); der Manifest setzt jetzt
  `content_security_policy.extension_pages` mit `connect-src 'self' ws: wss:`.
- **522 → 530 Node-Fälle**, 283 Rust-Fälle, Parität **7/7** unverändert. Der
  Windows-Blackbox-E2E läuft gegen MV3.

**`ws://` gilt nur noch für Loopback** — der Fernfall braucht `wss://` oder einen
SSH-Tunnel (Betreiberentscheid 2026-11-18).

- **Regel im Code, vor dem Dial:** `extension/bridge.js` prüft den Endpunkt,
  bevor es einen Socket baut. `ws:` auf `127.0.0.1`, `[::1]` oder `localhost`
  verbindet wie bisher; `ws:` auf jedem anderen Host wird verweigert — kein
  Socket, kein Reconnect, genau eine Zeile `bc: ws:// ist nur für 127.0.0.1
  erlaubt — für andere Rechner wss:// verwenden oder einen SSH-Tunnel auf
  127.0.0.1 legen`. Der Endpunkt selbst wird nicht geloggt (ein Hostname kann
  Zugangsdaten tragen). `wss://` bleibt überall erlaubt, auch auf Loopback; ein
  Pfad ändert nichts (`isUnencryptedRemoteEndpoint`). Die Optionsseite prüft die
  Regel nicht — dort würde sie nur das Speichern verweigern.
- **Die CSP bleibt weit** (`connect-src 'self' ws: wss:`;
  `extension/manifest.json` unverändert): eine engere Policy würde den
  Fehlversuch mit einem stummen `1015` beenden, statt unsere Meldung sprechen zu
  lassen (`docs/43`, Punkt 5).
- **`INSTALL.md` §9, neu „No certificate? Tunnel it.“:**
  `ssh -N -L 8110:127.0.0.1:8110 <user>@<server>` auf dem Browser-Rechner,
  offen halten (zweites Terminal, `tmux`/`autossh`), danach `ws://127.0.0.1:8110`
  eintragen; dazu `ss -ltn | grep 8110` als Fehlersuche. §8 hat die passende
  Troubleshooting-Zeile.
- **Tests:** sechs neue Fälle in `test/extension.test.js` (Loopback IPv4/IPv6/Name,
`ws://` mit Pfad, `wss://` auf fremdem Host, und die Verweigerung mit genau einer
Logzeile, ohne Socket und ohne Timer).

**Spec 43 (Manifest auf MV3) ist `active`** — das Manifest steht auf MV3, die
Werkzeuge antworten im echten Firefox.

- **Manifest:** `manifest_version: 3`, Hintergrund als Eventpage ohne
  `persistent`, `permissions: ["tabs","storage","webRequest","scripting"]` plus
  `host_permissions: ["<all_urls>"]`, `action` statt `browser_action`, und
  `web_accessible_resources` in MV3-Form (`[{resources: ["page-agent.js"],
  matches: ["<all_urls>"]}]`) — `bridge.html`/`bridge.js` bleiben ausdrücklich
  draußen.
- **Injection:** `browser.tabs.executeScript` ist durch
  `browser.scripting.executeScript({target: {tabId, frameIds|[allFrames]},
  files: ["page-agent.js"]})` ersetzt. Gelesen wird nur `injected.length`; die
  Antworten laufen weiter über den `callId`-Kanal (`docs/45`).
- **Befund und Fix, der in keiner Spec stand:** mit der Vorgabe-CSP von MV3 kam
  keine Verbindung zustande — Firefox lädt `ws://` auf `wss://` hoch, der Socket
  schloss mit `1015`, die Bridge loggte nichts. Das Manifest trägt jetzt
  `content_security_policy.extension_pages` mit `connect-src 'self' ws: wss:`
  und ohne `upgrade-insecure-requests`; ein Manifest-Fall pinnt es.
- **Tests:** vier MV3-Pins und der CSP-Pin in `test/manifest.test.js`,
  `action_namespace_shouldFollowTheManifestVersion` in `test/extension.test.js`,
  dessen Injection-Stub auf `browser.scripting` umgestellt ist. `npm test` 524
  Fälle `# fail 0`, `npm run check` 0, Parität 7/7.
- **Gemessen am 2026-11-18** (Firefox 152 headless, web-ext, eigener
  Bridge-Prozess auf 18810/18811): `extension connected` nach 6,5 s,
  `browser_open_tab` ⇒ `tabId 3`, `https://example.com/`; `browser_read` ⇒ 917
  Zeichen `innerText`, kein `not_readable`. **Offen (Betreiberentscheid):** die
  8-h-Messung (Kriterium 7 von `docs/43`) sowie Kriterien 6, 8 und 9.
- **Docs:** `docs/02` trägt den einen Satz „gilt bis `docs/43`“ (Messbeleg
  30,0 s bleibt stehen), `INSTALL.md` hat die überholte Zeile „the add-on has to
  be MV3 first" verloren.

**Spec 30 (Windows-Betrieb, Teil 1b) ist `active`** — zwei Lücken im Rust-Port
geschlossen, der Rest war schon da.

- **`Strg+Untbr` beendet die Bridge** wie `Strg+C`: `ctrl_break` neben `ctrl_c`
  (`bridge-rs/src/main.rs`), dieselbe Zeile `received SIGBREAK, shutting down`, Exit 0.
  `docs/38` Stufe 3 hatte den Signal bewusst weggelassen, um zeichengleich zur gelöschten
  Node-Vorlage zu bleiben — der Paritätsmaßstab läuft auf Linux und sieht keinen der
  beiden Handgriffe.
- **Das MCP über stdio schweigt in einer Konsole:** `stdio::serve` startet nur noch, wenn
  stdin keine Konsole ist (`std::io::IsTerminal`, `bridge-rs/src/stdio.rs`). Pipe,
  Socketpair und `/dev/null` (pi, Paritäts-Treiber, systemd) sind unverändert; in einem
  Terminal hätte die Vorlage den ersten Tastendruck als Parse-Fehler auf stdout
  beantwortet.
- **Überholt:** Kriterium 3 (Skip-Zählung der Node-Tests) und Kriterium 6 (zwei
  `INSTALL.md`-Empfehlungszeilen) haben kein Subjekt mehr; Kriterium 4 ist gegen
  `GetExtendedTcpTable` nachgeprüft. Die Amendments an `docs/18` sind fallengelassen — der
  Absatz beschreibt eine gelöschte Datei.
- **Beweise:** `cargo build`/`cargo clippy` für `x86_64-pc-windows-gnu` ⇒ 0, Parität 7/7,
  `cargo test` 283 Fälle 0 failed, `npm test` 522 Fälle `# fail 0`, `npm run check` 0.
- **Offen beim Betreiber:** die Windows-Messung (`Strg+C`/`Strg+Untbr` im echten
  Konsolenfenster, stdout 0 Byte, `tools/list`) und der Nachtrag in `docs/38` Stufe 3 und
  `bridge-rs/README.md`, die den `Ctrl+Break` noch als „nicht verdrahtet" führen.

**Spec 28 (Log-Hygiene) ist abgeschlossen und `active`** — kein Code, eine
Dokumentation: die Whitelist für den Debug-Block war seit 2026-10-30 gebaut,
jetzt sind die Amendments nachgezogen, die bekannten Lücken gegen den Rust-Port
geprüft und das Live-Kriterium gemessen.

- **Amendments nachgezogen** in `docs/05` (Hub-Absatz, `## Bekannte Lücken`,
  `#logDebugResult`), `docs/08` (Hub und Testing-Zeile), `docs/09`
  (Inspect-Block, Dev-Plan-Stufe 3) und `docs/07` (`title`-Falle): der
  Debug-Block ist eine Whitelist (`DEBUG_WHITELIST` in `bridge-rs/src/hub.rs`),
  `title` erscheint dort als Länge — außer in `status`, wo der Block byte-genau
  gepinnt ist.
- **Lücken:** von fünf bleiben zwei (`docs/28`). Ein Ergebnis, das kein Objekt
  ist, druckt weiter JSON im Klartext (gepinnt, nicht zugesagt); `title` als
  Länge ist in `click`/`type` nicht gepinnt. Der Tabellen-Tippfehler, das flache
  `Object.freeze` und `__proto__` sind mit dem Rust-Port entfallen.
- **Live gemessen ohne Browser** (zweiter Prozess auf 18810/18811, `BC_LOG=debug`,
  nachgebaute Extension): der `read`-Block zeigt `"text": "<19 chars>"`,
  `"title": "<14 chars>"` und `"surpriseField": "<unlisted field>"`; kein
  Seiteninhalt im stderr, bei `log=info` gar kein Block. Kriterium 5 am echten
  Firefox bleibt beim Betreiber.
- **Belege:** Parität 7/7, `cargo test` 283 Fälle 0 failed, `npm test` 522 Fälle
  `# fail 0`/`# cancelled 0`, `npm run check` 0.

**Der Schalter in der Symbolleiste (`docs/44`, Stufen 1–4)** — die Erweiterung
hat ein Symbol und ist nach der Installation **aus**. Ein Klick öffnet den
Brücken-Tab und den Socket, ein zweiter schließt beides wieder, und dabei sagt
sie Servus.

- **Drei Icons, drei Zustände** (`extension/icons/`): Brücke (verbunden),
  überkreuzte Brücke (`off`, die Vorgabe) und Brücke mit gelbem Blitz (an, aber
  die Bridge antwortet nicht). Gezeichnet auf `viewBox="0 0 32 32"` mit
  `context-fill`; die zwei Laufzeit-Zustände setzt `setIcon`. Im Manifest steht
  `browser_action` mit `default_icon: icons/bridge-off.svg`, `default_title`
  und **ohne** `default_popup` — mit Popup feuert `onClicked` nicht.
- **`extension/background.js`:** `bridgeEnabled` aus `storage.local` (kein Wert
  ⇒ aus), Klick schaltet um, `setIcon`/`setTitle` folgen dem Zustand, der
  Namespace hängt an `manifest_version` (`browserAction` unter MV2, `action`
  unter MV3). Ausschalten in dieser Reihenfolge: `goodbye` an die Seite,
  `close(1000)`, Tab zu, `bridgeEnabled = false`.
- **`extension/bridge.js`:** liest den Schalter vor jedem Verbindungsversuch,
  verbindet bei `aus` nicht weiter (der Reconnect-Timer wird abgebrochen),
  meldet dem Koordinator über `runtime.sendMessage`, ob der Socket steht, und
  führt den Abschied aus (`goodbye` vor `close`).
- **`GOODBYE` in beiden Protokolldateien** (`extension/protocol.js`,
  `bridge-rs/src/protocol.rs`); die Bridge reagiert nicht darauf (Roadmap 32).
  Nebenbei nachgetragen: `INJECTION_REPLY_TIMEOUT_MS` fehlte in
  `bridge-rs/src/protocol.rs`, weshalb `protocol_constants_matchTheExtension`
  schon vor diesem Inkrement rot war.
- **`docs/42`, Kriterien 13/14:** der Brücken-Tab wird aus `browser_status`
  gefiltert und ist für jedes Werkzeug `no_agent_tab`, auch mit einer von Hand
  eingetragenen Id in `agentTabIds`.
- **Dritter E2E-Seam:** `const DEFAULT_BRIDGE_ENABLED = false;` in `bridge.js`
  **und** `background.js`, gepatcht und je Datei einmal gezählt
  (`--self-check` ⇒ `endpoint=1 token=1 state=1`).
- **Belege:** 522 Node-Fälle grün (`# fail 0`, `# cancelled 0`), 16 Fälle in
  `test/bridge-tab.test.js` (davon 6 `switch_*`), `cargo test --test protocol`
  grün, `npm run test:ci` 11 Fälle grün, Parität 7/7, `npm run check` ⇒ 0. Zwei
  Mutationsproben: Klick ohne Zustandsprüfung und weggelassenes `goodbye`
  machen je einen `switch_`-Fall rot. **Ungemessen:** der echte Klick, der
  Blitz binnen 5 s, `off` über den Neustart, 60 s ohne `extension connected`
  (Betreiber-Kriterien 5–8).

**Die Injection-Naht, Block 2 von Stufe 1b — der Quelltext-Pfad ist weg** — auch
`inspect`, `eval`, `frames` und `transcript` schicken keinen Quelltext mehr in die
Seite. Damit ist die Naht aus `docs/45` auf dem Produktionspfad vollständig:
`tabs.executeScript({file})` lädt `extension/page-agent.js`, jeder Aufruf reist
als `{callId, op, args}` über `tabs.sendMessage`, die Antwort kommt als
`{callId, ok, value}` zurück. Werkzeugergebnisse, Fehlercodes und deutsche Sätze
sind unverändert.

- **`extension/page-agent.js`:** `inspect`, `eval`, `transcriptGate`,
  `transcriptModel`, `transcriptCaption` und `transcriptMenu` als Ops; die
  Seitenfunktionen sind wörtlich mitgewandert (`inspectPageSource`,
  `inspectShadowPageSource`, `splitPiercingSelector`, `isSimpleSelector`,
  `selectorForElement`, `shadowSelectorForElement`, `evalPageSource`,
  `transcriptGateSource`, `transcriptModelSource`, `transcriptCaptionSource`,
  `transcriptMenuSource`). Welche `inspect`-Variante läuft, entscheidet jetzt die
  Seite (`inspectAnswerFor`) — die Frage nach einem `>>>` ist eine über das DOM.
- **`frames`:** die Inventur entsteht aus Selbstmeldungen. Jeder Frame antwortet
  auf `{op: "inventory"}`, `sender.frameId` steht an der Nachricht, `framesOf`
  bekommt die Antworten statt eines Arrays aus der Injection. Kein Auflösen beim
  ersten Treffer; der Inhaltsfilter bleibt.
- **`extension/bridge.js`:** `injectPageCode` heißt `askPageAgent` und hat nur
  noch den Nachrichtenpfad; `pageSnippetCode`, `PAGE_HELPERS_CODE`,
  `describeElement`, `isVisible`, `isAddressedFrame` und der Testhaken
  `globalThis.__bcInjectionProbe` sind gelöscht. Die vierte `injection_*`-Prüfung
  läuft über `inspect` statt über einen Haken; neue Fälle:
  `frames_inventory_shouldComeFromSelfReports`,
  `frames_withAnEmptyEntry_shouldNotShiftTheFilter`.
- **Beleg:** 508 Node-Fälle grün, Parität 7/7, `pageSnippetCode(` ⇒ 0,
  `PAGE_HELPERS_CODE` ⇒ 0, `__bcInjectionProbe` ⇒ 0. Ungemessen bleibt die
  Messung am echten Browser (Kriterien 6 und 7).

**Die Injection-Naht, Block 1 von Stufe 1b** — `read`, `click` und `type` schicken
keinen Quelltext mehr in die Seite: sie laden `page-agent.js` als Datei und
fragen `{op, args}` über den Nachrichtenkanal (`docs/45`). Die vier Seitenfunktionen
sind wörtlich in die Datei gewandert; die Werkzeugergebnisse, Fehlercodes und
deutschen Sätze sind unverändert.

- **`extension/page-agent.js`:** `read`, `settle`, `click` und `type` als
  benannte Ops neben `inventory`; jeder Op bekommt ein flaches, JSON-fähiges
  Argumentobjekt. Der Dispatcher wartet das Ergebnis ab, weil `settle` eine
  Zusage beantwortet.
- **`extension/bridge.js`:** `readPageRequest`, `pageStateRequest`,
  `settlePageRequest`, `clickPageRequest`, `typePageRequest` bauen `{op, args}`;
  `readAgentTabPage`, `settleAgentTab`, `clickAgentTab`, `clickResult`,
  `typeAgentTab` und `typeResult` lesen die Antworten über `valuesOf`. Ein Op, der
  wirft, wird wie eine abgelehnte Injection in `not_readable`/`page_busy`/
  `no_agent_tab` übersetzt — derselbe eine Fehlerpfad wie vorher.
- **Noch offen (Block 2):** `inspect`, `eval`, `frames` und `transcript` senden
  weiter Quelltext; `pageSnippetCode`, `PAGE_HELPERS_CODE` und der Testhaken
  `globalThis.__bcInjectionProbe` bleiben bis zum letzten dieser Aufrufer.

**Der Socket zieht in einen eigenen Tab** — Stufe 1 von `docs/42`, die
Voraussetzung für MV3. Der Code der bisherigen Hintergrundseite lebt jetzt als
`extension/bridge.js` in einem angepinnten Erweiterungs-Tab; `background.js` ist
nur noch der Koordinator, der genau diesen Tab anlegt und hält. Das Manifest
bleibt MV2 mit `persistent: true`, die Injection-Naht (`docs/45`) ist unberührt,
und die Werkzeuge, ihre Argumente und ihre deutschen Sätze sind unverändert.

- **`extension/bridge.html` + `extension/bridge.js` (neu):** Socket, Sitzung,
  Tab-Store, Werkzeugausführung **und** der `webRequest`-Mitschnitt. Die Datei
  ist die umbenannte `background.js` — 7 032 Zeilen unverändert, nur der Kopf
  nennt den neuen Ort.
- **`extension/background.js` (jetzt Koordinator):** ein `tabs.create` mit
  `pinned: true` und der gemerkten `windowId`, ein Single-Flight-Guard gegen zwei
  gleichzeitige Anläufe, Neuanlage bei `tabs.onRemoved`, Reload bei
  `changeInfo.discarded` und Ersatz, wenn der Tab weg-navigiert wurde. Kein
  privates Fenster, kein Container, kein Socket, kein Backoff.
- **`extension/manifest.json`:** nur noch ein Hintergrundskript.
- **E2E-Seam und Tests:** der Seam (`scripts/e2e/build-test-extension.mjs`,
  `docs/40`) patcht `bridge.js`; `test/bridge-tab.test.js` trägt neun Fälle für
  den Koordinator; `test/extension.test.js` fährt die Werkzeuge unverändert
  gegen `bridge.js`.
- **Ungemessen:** die 30-Minuten-Messung, Tab-Schließen im echten Browser und
  der Browser-Neustart (Kriterien 9–13) folgen in Stufe 3 beim Betreiber.

## [0.5.1] — 2026-11-17

**Die Firefox-Anleitung führt jetzt zum richtigen Ort.** `about:debugging`
installiert ein temporäres Add-on, zeigt aber nur **Reload** und **Remove** —
einen Einstellungs-Link gibt es dort nicht. `FIREFOX.md` sagte „open the
settings" und schickte jeden neuen Nutzer damit ins Leere.

- `docs/portable/FIREFOX.md`: Schritt 5 öffnet **`about:addons` → Browser
  Control → Preferences**; Schritt 9 nennt **Reload** beim Namen.
- Die Warnung verweist jetzt auf die Schritte 2 bis 4 statt 3 bis 9 und sagt,
  dass Firefox Endpunkt und Token im Profil behält — mit dem Hinweis, sie nach
  einem Reload zu prüfen, statt es zu versprechen.
- `INSTALL.md` nennt `about:addons` als **primären** Weg; das Kontextmenü-Icon
  fehlt bei einem temporären Add-on oft.
- Sonst unverändert: Binary und Erweiterung sind identisch mit 0.5.0.

## [0.5.0] — 2026-11-17

**Die Bridge ist Rust.** Der Node-Prozess ist ersetzt durch ein statisch
gelinktes Binary (`bridge-rs/`, 2,7 MB, musl), das ohne Node und ohne
Interpreter startet. Der Umbau lief gegen einen **Paritätsmaßstab**: sieben
Antworten der alten Node-Bridge wurden aufgezeichnet, die Rust-Fassung wird
Zeichen für Zeichen dagegen gemessen — `scripts/parity.sh --impl rust --check`
⇒ **7/7**, `--self-test` ⇒ 7/7 rot. Die Node-Bridge ist gelöscht.

- **Gemessen statt behauptet:** `initialize`/`tools/list` byte-identisch
  (7.390 Byte), alle dreizehn Werkzeuge über 15 Argumentformen (218 von 218
  Antworten gleich), der Hub mit seinen 55 Fällen, WebSocket mit den
  Close-Codes 4401/4408/4409, `POST /mcp` mit 401/404/405/413/500.
- **Drei Fehler, die erst die Messung zeigte:** der WebSocket-Decoder war
  quadratisch (70 888 ms gegen 193 ms bei 3,58 MB in einem Chunk); ein `hello`
  im Handshake-Paket wurde nicht zugestellt und die Verbindung endete mit 4408
  statt `welcome`; ein Panic in der Werkzeugschicht lieferte gar keine Antwort
  statt 500 — und schrieb einen zeitstempellosen Block ins Journal.
- **Betrieb:** `deploy/browser-control.service` startet
  `%h/.local/bin/browser-control-bridge --http`; `scripts/install.sh` kopiert das
  Binary und prüft es; `--fix-path` ist entfallen. Windows: dieselbe `.exe`, als
  Task-Scheduler-Aufgabe (`deploy/windows/browser-control-bridge.xml`).
- **Windows ist kompiliert, nicht gelaufen** — die Proben für den Betreiber
  stehen in `bridge-rs/README.md`.
- **492 Node-Fälle** (vorher 765: die 273 der gelöschten Bridge-Tests sind mit
  ihrem Gegenstand entfallen), **283 Rust-Fälle**.

**Die CI prüft jetzt, was ausgeliefert wird.** Vorher lief im Workflow nur
`npm run check` und `npm test` — kein `cargo`, kein `parity.sh`, keine
Installation. Jetzt gibt es fünf Jobs in einer Datei (`docs/40`).

- **`unit`:** beide Ziele mit `--release`, `cargo test -- --test-threads=1`,
  `clippy -D warnings --all-targets` für beide Ziele, `parity.sh --check` (7/7)
  und `--self-test`; `npm run test:ci`; danach die Artefakte `bridge-linux` und
  `bridge-windows`.
- **`e2e`** (Windows, Blackbox): Firefox headless, `web-ext@8.9.0` installiert die
  Erweiterung als temporäres Add-on, `browser_open_tab` über `POST /mcp` öffnet
  eine Seite, und **die Seite selbst** meldet sich beim Beacon. Ein Lauf mit
  kaputtem Beacon (`E2E_BEACON_MODE=broken`) ist rot, obwohl die Bridge „open tab"
  meldet.
- **`bundle`** baut die zwei Zips aus `docs/39` und lädt `portable-zips` hoch;
  **`release`** hängt sie bei Tag `v*` an das Release — in derselben Datei, weil
  `needs` und `download-artifact` nicht über Dateigrenzen gelten.
- **Neu:** `scripts/e2e/{run,beacon,build-test-extension}.mjs`,
  `scripts/ci-local.sh` (unit + bundle in CI-Reihenfolge), `npm run test:ci`
  (11 Fälle in `test/ci/`). `npm test` bleibt binary-frei bei 492 Fällen.
- **Gemessen (2026-11-17, Linux, Firefox 152):** der volle Lauf endet mit
  `PING <ISO-8601>` und Exit 0; der kaputte Beacon mit Exit 1 und ohne PING.
  Der Windows-Lauf steht noch aus.

**Das portable Zip.** `bash scripts/bundle.sh` baut je Plattform ein Zip —
Binary, XPI, Startskript und zwei Anleitungen —, das ohne Installation läuft.

- **Inhalt (sieben Einträge):** Ordner-Eintrag, `browser-control-bridge`, die
  XPI, `start.sh`, `README.txt`, `FIREFOX.md`, `CLIENTS.md`; Windows mit `.exe`
  und `start.cmd` (CRLF, kein WSL). Startskript und Binary liegen mit `0755` im
  Archiv.
- **`start.sh` / `start.cmd`** legen `data/token` beim ersten Lauf an
  (`openssl rand -hex 32`, Rückfall `/dev/urandom`; Windows
  `RandomNumberGenerator`), überschreiben es nie, drucken genau drei Zeilen und
  werden das Binary mit `--http`. Nichts wird außerhalb des Ordners geschrieben.
- **`docs/portable/FIREFOX.md` und `CLIENTS.md`** — Englisch nach STE100: die
  XPI in `about:debugging` laden, Endpunkt und Token eintragen; pi, Codex,
  OpenCode plus ein generisches JSON- und TOML-Muster.
- **Neu:** `scripts/bundle.sh`, `npm run test:bundle` (9 Fälle in
  `test/bundle/bundle.test.js`); `npm test` bleibt binary-frei.
- `docs/39` und `docs/41` sind `active`.

## [0.4.0] — 2026-11-15

**Die Einstellungsseite der Erweiterung ist englisch.** Das Projekt ist
öffentlich und die Doku ist englisch; die Optionen folgen jetzt.

- Labels: „Endpoint URL", „Token", „Allow password fields", „Allow code
  evaluation", „Allow screenshots", „Save"; die Hinweistexte sind übersetzt,
  `lang="en"`.
- Die Statuszeilen der Seite („Saved.", „Settings could not be loaded.") ebenso.
- **Unverändert deutsch** bleiben die Meldungen, die der Agent sieht
  (Werkzeugfehler, Logzeilen) — sie richten sich an den Betreiber, nicht an den
  Browser.
- 760 Tests (die Manifest-Pins prüfen die englischen Labels).

## [0.3.0] — 2026-11-15

**Der Endpunkt muss nicht mehr getippt werden.** Läuft die Bridge auf derselben
Maschine, ist das Feld in den Add-on-Einstellungen mit `ws://127.0.0.1:8110`
vorbelegt — dem Port, den die Bridge per Default bindet. Es bleibt sichtbar und
änderbar; ein gespeicherter Wert, etwa hinter Caddy, gewinnt unverändert.

- Gilt nur für ein **leeres** Feld; nichts wird in `storage.local`
  zurückgeschrieben.
- Ein leerer **Token** verhindert die Verbindung weiterhin.
- Ein Test wacht darüber, dass Optionsseite und Hintergrund denselben Wert
  tragen **und** dass er zum `DEFAULT_BIND` der Bridge passt.
- 760 Tests.

## [0.2.0] — 2026-11-15

**Installation in einem Befehl.** `scripts/install.sh` legt das Token an,
installiert die systemd-User-Unit, aktiviert und startet den Dienst und prüft
ihn — dann sagt es, was in Firefox noch zu tun ist.

- **Idempotent:** ein zweiter Lauf ändert nichts, was stimmt; ein vorhandenes
  Token wird nie überschrieben.
- **Das Token erscheint genau einmal**, auf dem Terminal — nicht in einer
  zweiten Datei, nicht im Journal.
- **Kein `sudo`**, geschrieben wird nur nach `~/.config/browser-control/` und
  `~/.config/systemd/user/`; jeder Schreibvorgang läuft durch einen
  Pfadwächter.
- **Vorprüfungen vor dem ersten Schreibvorgang:** Node ≥ 22, Klonpfad,
  beschreibbares `$HOME`, freie Ports (mit Besitzer).
- Optionen: `--dry-run`, `--print-token`, `--fix-path`, `--uninstall`,
  `--help`; Exit `0`/`1`/`2` wie die Bridge.
- **21 neue Tests** (`test/install.test.js`) mit temporärem `HOME` und Stubs —
  nichts am echten System. Insgesamt 757 Tests.

**Doku:** `README.md` und `INSTALL.md` sind englisch (Specs bleiben deutsch);
`CONTRIBUTING.md` ersetzt `AGENTS.md` und beschreibt denselben Ablauf.

## [0.1.0] — 2026-11-12

Erste Fassung, aus 34 Specs gebaut (`docs/`).

**Werkzeuge (13):** `browser_status`, `navigate`, `read`, `click`, `type`,
`focus`, `inspect`, `open_tab`, `close_tab`, `eval`, `screenshot`, `frames`,
`transcript`.

**Bridge:** WebSocket zur Erweiterung (`127.0.0.1:8110`), MCP über HTTP
(`127.0.0.1:8111/mcp`, Bearer-Token), ein systemd-User-Dienst, persistenter
Hintergrunddienst ohne Portsuche, Log im Journal.

**Erweiterung (MV2):** Agenten-Tabs im Default-Container (höchstens fünf),
Ruhe-Erkennung für `navigate`/`click`, Frames und Shadow DOM, Screenshots,
Protokollierung ohne Seitentext.

**`browser_transcript`:** liest das YouTube-Transkript als Segmente mit
Zeitstempeln, in der Originalspur des Videos — die signierte Spurendatei wird
über `webRequest` mitgeschnitten, die Spur bei Bedarf im Player gesetzt, und
Spur wie Abspielposition werden danach zurückgestellt.

**Sicherheit:** drei Schalter in den Add-on-Einstellungen
(Passwortfelder, Code-Auswertung, Bildschirmfotos), alle aus per Voreinstellung;
keine Secrets im Repo; Token nur im Dateisystem des Betreibers.

**Bekannte Grenzen:** die Erweiterung ist unsigniert (temporär zu laden, nach
einem Firefox-Neustart erneut); Windows nur teilweise (Spec 29/30); ein
YouTube-Spurenetikett kann falsch sein, und Spracherkennung ist kein Ziel.
