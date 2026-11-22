---
description: Teil 2 des Rust-Projekts — die Bridge-Module (Konstanten, Config, WebSocket, Hub, Werkzeuge, HTTP, stdio) nach Rust, danach Windows, Installer und der Schnitt; gemessen wird gegen den Paritätsmaßstab aus Teil 1.
status: active
---

# Die Rust-Bridge, Teil 2: der Port

`docs/37-rust-bridge.md` (Teil 1) hat den **Maßstab** gebaut: sieben
eingecheckte Soll-Artefakte und `scripts/parity.sh` mit `--record`, `--check`
und `--self-test`. Dieser Teil portiert die Bridge dagegen und schaltet um.

**Voraussetzung:** Teil 1 ist gebaut — Werkzeugkette, baubares Gerüst,
sieben Artefakte. Ohne ihn gibt es nichts, wogegen gemessen wird.

**Nachtrag 2026-11-22 (`docs/54`):** die Sätze der Werkzeugschicht sind
inzwischen englisch. Wo diese Spec „deutsche Sätze" sagt (`## Ziel`,
`## Das Inventar`, `## Testing`, Kriterium 4), gilt: kopiert und byteweise
geprüft, nur eben auf Englisch. Die Parität misst unverändert.

## Ziel

- **Die Module nach Rust**, eines nach dem anderen, jedes gegen den Maßstab
  gemessen: Konstanten, Config, Log, Portbesitzer, WebSocket-Codec, Hub,
  Werkzeugschicht, HTTP, stdio.
- **Dieselbe Oberfläche.** Dreizehn Werkzeuge, dieselben Schemata, dieselben
  deutschen Sätze aus `mcp.mjs` — **kopiert, nicht formuliert**; dieselben
  Logzeilen, dieselben Exit-Codes `0`/`1`/`2`.
- **Windows** bekommt Portbesitzer (`GetExtendedTcpTable`), stdin-Erkennung
  (`GetFileType`) und einen Startweg (Task Scheduler).
- **Der Schnitt am Ende:** `bridge/` fällt in **einem** Commit, Unit und
  Installer zeigen auf das Binary, `docs/18`/`docs/35` sind nachgezogen.

## Non-goals

- **Kein Protokollwechsel, keine neuen Werkzeuge, keine neuen Codes.** Die 13
  bleiben 13.
- **Keine Änderung an der Extension** (`extension/` bleibt JavaScript).
- **Kein macOS, kein arm64.**
- **Kein Parallelbetrieb auf Dauer** — nach dem Schnitt gibt es eine
  Implementierung.
- **Keine neuen Funktionen.** Was heute fehlt, fehlt danach auch.

## Dependency changes

Neue Abhängigkeiten — und **die einzigen**:

| Crate | Zweck | Lizenz |
|---|---|---|
| `tokio` (`rt-multi-thread`, `net`, `time`, `signal`, `sync`, `io-util`, `io-std`, `process`, `macros`) | asynchrones I/O, Fristen, Signalende, stdin/stdout, Prozessfälle | MIT |
| `serde` + `serde_json` (`preserve_order`) | JSON-RPC, Schemata, Antworten **in der Reihenfolge von `mcp.mjs`** | MIT / Apache-2.0 |
| `sha2` | Tokenvergleich wie heute: `timingSafeEqual(sha256(…))` in `bridge/hub.mjs` | MIT / Apache-2.0 |
| `subtle` | konstantzeitiger Vergleich der beiden Hashes (`==` auf `[u8]` bricht beim ersten Unterschied ab — ein Regressionsschritt) | MIT |
| `sha1` + `base64` | `Sec-WebSocket-Accept` | MIT / Apache-2.0 |
| `hyper` (`server`, `http1`) + `hyper-util` (`tokio`) + `http-body-util` | `POST /mcp` (nur der MCP-Port); `hyper-util`s `server`-Feature ist wirkungslos (`= ["hyper/server"]`, schon direkt gesetzt) | MIT |
| `windows-sys` (`cfg(windows)`; Features `Win32_NetworkManagement_IpHelper`, `Win32_Storage_FileSystem`, `Win32_System_Threading`, `Win32_Foundation`) | Portbesitzer, `GetFileType`, Prozessname | MIT / Apache-2.0 |

**`preserve_order` ist entschieden, nicht geerbt:** es zieht `indexmap` (MIT/Apache-2.0)
mit. Die Alternative wäre, jede Antwort aus `json!`-Literalen in fester
Reihenfolge zu bauen — genau das tut der Code heute nicht (er gibt das Ergebnis
der Extension unverändert aus), deshalb bleibt es bei `preserve_order`.

**Kein `hyper` für den Extension-Port.** Dort steht ein eigener, kleiner
HTTP/1.1-Kopfleser: er sieht genau zwei Formen (`GET` mit `Upgrade`, alles
andere ⇒ `426`), und die Bytes **nach** dem Handshake müssen ohnehin in den
Frame-Codec — genau die Stelle, an der eine Bibliothek Arbeit spart oder Bytes
verschluckt.

**Versionen:** die exakten Versionen stehen im **eingecheckten `Cargo.lock`** —
er existiert seit Stufe 1 (leerer Graph) und **wächst** in 2a mit der ersten
Abhängigkeit. Die in 2a eingetragenen Versionen stehen im `## Log`; ein
`cargo update` ist ein eigener Commit mit eigenem Parity-Lauf.

## Das Inventar (aus dem Code gelesen, 2026-11-16)

| Datei | Zeilen | Was | Muss portiert werden |
|---|---|---|---|
| `bridge.mjs` | 291 | CLI (`--http`), Start, Signalende | ja |
| `config.mjs` | 136 | ENV, Bind/Port, Tokenpfad, Tokenprüfung | ja |
| `protocol.mjs` | 49 | Drahtkonstanten (Version, Typen, Methoden, Close-Codes) | ja |
| `websocket.mjs` | 432 | RFC 6455 von Hand: Handshake, Maskierung, Fragmentierung, Grenze, Close | ja |
| `hub.mjs` | 1.021 | eine Sitzung, Fristen, Anfrage-Ids, Statuszeilen, Log | ja |
| `mcp.mjs` | 1.820 | JSON-RPC, `tools/list`, 13 Werkzeuge, Schemata, deutsche Sätze | ja |
| `http-transport.mjs` | 247 | `POST /mcp`, Bearer, Body-Grenze, Statuscodes | ja |
| `port-owner.mjs` | 161 | Portbesitzer (`/proc`; Windows: `GetExtendedTcpTable`) | ja, plattformspezifisch |

**Nicht verhandelbar:** WS-Frames und Close-Codes, Statuszeilen
(`status windows=<n> tabs=<m>`), Werkzeugantworten als eingerücktes JSON,
Bildblöcke, die deutschen Fehlersätze, Exit-Codes.

## Die Testlandkarte

Die 9.572 Zeilen Bridge-Tests sind die Spezifikation des Verhaltens. Sie bleiben
bis zum Schnitt, wo sie sind, und werden Modul für Modul übertragen:

| Testdatei | Zeilen | Prüft | Rust-Ziel |
|---|---|---|---|
| `websocket.test.js` | 466 | Framing, Maskierung, Close | `ws` |
| `hub.test.js` | 2.029 | Sitzung, Fristen, Statuszeilen, Log | `hub` |
| `mcp.test.js` | 4.692 | Werkzeuge, Schemata, Sätze | `mcp` |
| `http-mcp.test.js` | 573 | `POST /mcp`, Auth, Statuscodes | `http` |
| `http-transport.test.js` | 697 | Body-Grenzen, Header, Fehler | `http` |
| `protocol.test.js` | 233 | Konstanten gleich `extension/protocol.js` | `protocol` |
| `port-owner.test.js` | 60 | Besitzerzeile | `platform` |
| `config.test.js` | 38 | ENV, Tokenpfad | `config` |
| `ports.test.js`, `bridge.test.js` | 784 | Portreservierung, Startverhalten | `main` |

**1:1 übertragbar:** die 14 reinen Fälle aus `test/hub.test.js` (2
`formatStatusLine_*`, 9 `debugBlockOf_*`, 3 `verifyToken_*`), die 13 aus
`test/websocket.test.js`, die 3 aus `test/config.test.js`, die 2 aus
`test/port-owner.test.js`, die Naht-Fälle aus `test/mcp.test.js` (Zahl in 2d
ausgezählt), die 14 aus `test/http-transport.test.js`, die 3 Invarianten aus
`test/ports.test.js`.

**Umgeschrieben, weil sie Node-Interna prüfen:** `test/protocol.test.js` (17) —
`vm.runInNewContext` und `Object.isFrozen` haben keine Entsprechung; Ersatz sind
3 Fälle mit einem Textauszug aus `extension/protocol.js`, der bei unbekannter
Form laut scheitert. Die 41 `hub_*`-Fälle (kein Pollen mehr nötig, der Test
treibt `hub.on_message` direkt). Die Prozessfälle aus `test/mcp.test.js` und die
10 aus `test/bridge.test.js` (`spawn(process.execPath, …)` ⇒ `Command::new`,
Zeile schreiben/lesen mit Frist). `test/deploy.test.js` und
`test/install.test.js` werden **nicht** portiert, sondern in Stufe 4a in der
Node-Suite nachgezogen.

**Fällt ohne Ersatz weg:** die Node-spezifischen Fälle aus `test/mcp.test.js`
(EPIPE auf stdout, `MaxListenersExceededWarning`) — sie prüfen Node-Verhalten.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `bridge-rs/tests/protocol.rs` | `protocol_constants_matchTheExtension` | dieselben Konstanten wie `extension/protocol.js` |
| `bridge-rs/tests/config.rs` | `loadConfig_withoutHttpPortEnv_shouldDefaultTo8111`, `loadConfig_withHttpPortEnv_shouldUseThatPort`, `loadConfig_withGarbageHttpPort_shouldFallBackToTheDefault`, dazu `parseBind` (`:0`, `[::1]`, leerer Host) und die Timeout-Fälle (`BC_HELLO_TIMEOUT_MS`, `BC_CALL_TIMEOUT_MS`) | Config, die stille Lüge `:0 ⇒ 8110`, JS-`Number()`-Arithmetik |
| `bridge-rs/tests/platform.rs` | `findPortOwner_withOwnListeningSocket_shouldNameThisProcess`, `findPortOwner_withReleasedPort_shouldReturnNull` | die `/proc`-Auswertung (Linux-only) |
| `bridge-rs/tests/ports.rs` | `everyNumber…Range`, `twoEntriesOnOneNumber`, `everyEntry…ExtensionPort` | die Porttabelle aus `tests/common/mod.rs` gegen sich selbst |
| `bridge-rs/tests/ws.rs` | 13 Fälle unter den Node-Namen (`acceptKey_withRfcSampleKey_*`, `encodeFrame_*`, `frameDecoder_*` (2), `upgradeSocket_*`, `websocket_*` (8)) + 30 `ws_`-Fälle, darunter `ws_onAnAnnouncedOversizedFrame_shouldCloseWith1009BeforeThePayloadArrives`, Ping zwischen zwei Fragmenten, Close-Frame mit einem Byte Payload, fehlende `Sec-WebSocket-Version`, ein Chunk mit vielen kleinen Frames | die Grenze feuert vor dem Puffern; Fragmentzustand überlebt Steuerframes; der Decoder bleibt linear |
| `bridge-rs/tests/hub.rs` | 55 Fälle: 41 `hub_*` (Sitzung, Fristen, Close-Codes `1002`/`4401`/`4408`/`4409`, kein Geister-Timeout), 9 `debugBlockOf_*` (Whitelist, `<unlisted field>`, `length`, `lengthEach`), 2 `formatStatusLine_*`, 3 `verifyToken_*`; der `welcome`-Frame ist in `hub_afterWelcome_…` gepinnt (ein eigener Fall würde den Zähler 55 verschieben) | Sitzung, Fristen, Statuszeilen, `welcome` |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsListIsByteIdentical`, `failureTextFor_transcriptNeedsFocus_shouldUseTheExtensionMessage`, die Naht-Fälle (Zahl in 2d) und die Prozessfälle aus 2f | Werkzeuge, deutsche Sätze, stdio |
| `bridge-rs/tests/http.rs` | **15** = 14 portierte aus `test/http-transport.test.js` (`http_` + der Node-Name: `…withToolsListAndValidToken_shouldAnswer200…`, `…withoutToken_shouldAnswer401…`, `…withWrongToken…`, `…withBasicScheme…`, `…withGetOnMcpAndNoToken_shouldAnswer405…`, `…withUnknownPath_shouldAnswer404`, `…withOversizedContentLength_shouldAnswer413BeforeAnyBodyArrives`, `…withABodyOfOneByteOverTheRequestLimit_shouldAnswer413…`, `…withOversizedChunkedBody_shouldAnswer413BeforeTheBodyFinishes`, `…afterARejection_shouldStillAnswerTheNextRequest`, `…withNotification_shouldAnswer202…`, `…whenTheToolSetThrows_shouldAnswer500…`, `…onDefaultHost_shouldBindLoopbackOnly`, `…afterARejection_shouldCloseTheSocket…`) + 1 neue Naht (`http_withTheSameAnswerAsStdio_shouldMatch`) | Auth, Grenzen, Statuscodes, Naht zu stdio |
| `bridge-rs/tests/bridge.rs` | `mcp_whenStdinEnds_shouldExitZeroAfterASingleShutdownLine`, `mcp_withAnIgnoredStdin_shouldKeepRunningAndListeningAfterTheEof` | stdin-Lebenszyklus |
| **live (Betreiber)** | die echte Extension verbindet sich mit dem Binary | der Port ist kein Selbstgespräch |

## Acceptance criteria

1. **Die Module sind portiert und paritätisch.** Beweis:
   `cargo test --manifest-path bridge-rs/Cargo.toml` ⇒ 0 failed, und
   `cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl && bash scripts/parity.sh --impl rust --check` ⇒ **7/7 wie erwartet**, Exit 0.
2. **Dieselben Einstellungen und Exit-Codes.** Beweis:
   `grep -rho 'BC_[A-Z_]*' bridge-rs/src | sort -u` ⇒ sechs Zeilen (`BC_BIND`,
   `BC_CALL_TIMEOUT_MS`, `BC_HELLO_TIMEOUT_MS`, `BC_HTTP_PORT`, `BC_LOG`,
   `BC_TOKEN_FILE`); die Config-Fälle grün; Exit `2`/`1` wie in Teil 1 gemessen.
3. **Dieselben Logzeilen.** Beweis: Paritätsvergleich 7 grün, und
   `grep -rho 'listening on\|extension connected\|status windows=' bridge-rs/src
   | sort -u | wc -l` ⇒ **3**.
4. **Die deutschen Sätze sind kopiert — die in Vergleich 2 gemessenen.**
   Beweis: Paritätsvergleich 2 grün. Er umfasst **13 × 3** Fälle (je Werkzeug
   ein Fixture-Erfolg, ein `error:<code>` und die Argument-Verweigerung); die
   Codes stehen in `bridge/mcp.mjs` (`TOOL_TEXTS`, `extensionFailureText`).
   **Zwei benannte Ausnahmen:** `BRIDGE_FAILED` ist nicht auslösbar (Rust-Unit-
   Test pinnt ihn), und Sätze, die nur bei einem Bridge-Bug entstehen,
   erreicht der Vergleich nicht.
5. **Windows ist gebaut.** Beweis:
   `cargo build --release --manifest-path bridge-rs/Cargo.toml --target
   x86_64-pc-windows-gnu` ⇒ 0; `cargo clippy --manifest-path
   bridge-rs/Cargo.toml --target x86_64-pc-windows-gnu --all-targets -- -D warnings`
   ⇒ 0; `file -b …/browser-control-bridge.exe | grep -Eq 'PE32\+ executable
   \(console\) x86-64'` ⇒ 0 (Teilprüfung — `file` hängt Abschnittszahl und
   `for MS Windows` an). **Der Lauf auf Windows ist eine
   Betreiber-Messung** (`## Bekannte Lücken`).
6. **Der Schnitt ist eine Stufe.** Beweis — zwei Zeitpunkte:
   `test -d bridge && echo present || echo gone` ⇒ `present` bis 4b, danach
   `gone`; `git log --diff-filter=D --oneline -- bridge/
   | wc -l` ⇒ **1**.
7. **Unit und Installer zeigen auf das Binary.** Beweis:
   `grep -c 'ExecStart=%h/.local/bin/browser-control-bridge --http' deploy/browser-control.service`
   ⇒ **1**; `grep -c 'bridge/bridge.mjs' scripts/install.sh` ⇒ **0**;
   `node --test --test-reporter=tap test/deploy.test.js test/install.test.js |
   grep -cE '^ok [0-9]+ - (install_|browserControlService_|execStart_)'` ⇒ **31**
   (21 heutige `install_` − 1 entfallener `fixPath`-Fall + 2 neue + 9
   Unit-/`ExecStart`-Fälle);
   und das Binary lauscht wirklich: `BC_BIND=127.0.0.1:18115 BC_HTTP_PORT=18116
   BC_TOKEN_FILE=<mktemp>/token $HOME/.local/bin/browser-control-bridge --http &`
   (die Tokendatei mit ≥ 32 Hex-Zeichen füllen — ohne sie endet der Prozess mit
   `2` und `curl` druckt `000`), dann `curl -s -o /dev/null -w '%{http_code}'
   -X POST http://127.0.0.1:18116/mcp` ⇒ `401` (mit `-X POST`, weil die
   Reihenfolge Pfad → Methode → Token lautet).
8. **Die Node-Suite bleibt grün und schrumpft nachvollziehbar.** Beweis:
   `npm test` ⇒ `# fail 0`, `# cancelled 0`, `# skipped 0`; **in 4b** wird die
   Zahl `# tests N` gegen die gelöschten 10 Dateien (234 Fälle) geprüft und im
   `## Log` eingetragen — `# fail 0` allein bliebe auch grün, wenn die halbe
   Suite verschwände. `npm run check` ⇒ 0.
9. **Kein Produktcode außerhalb der Grenze.** Beweis: `git status --porcelain
   -uall` nennt je Stufe nur die dort erlaubten Dateien (siehe `## Dev plan`) —
   **`-uall`**, weil `git status` unversionierte Verzeichnisse sonst zu einer
   Zeile faltet und fünf der elf neuen Dateien unsichtbar blieben;
   `git diff HEAD -- extension/` ⇒ leer.
10. **Kein Geheimnis.** Beweis:
    `git grep --untracked -nE '[0-9a-f]{32,}' -- . ':(exclude)bridge-rs/Cargo.lock'` ⇒ keine Ausgabe, Exit 1,
    und `git grep -nE '[0-9a-f]{32,}' -- bridge-rs/Cargo.lock | grep -v 'checksum = "'` ⇒ keine
    Ausgabe, Exit 1 (zweistufig: die Lock-Datei trägt 64-stellige Crate-Prüfsummen,
    eine Pauschalausnahme machte genau sie blind)

## Dev plan

**Der Release-Build gehört zu jeder Stufe, die `--impl rust` aufruft.**
`parity.sh` baut nie (docs/37) — es startet
`bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge`. Ohne
`cargo build --release --target x86_64-unknown-linux-musl` davor misst der Lauf
das Binary der *letzten* Stufe, und ein zurückgedrehter Fix bliebe grün.

**Stufe 2a — `protocol`, `config`, `log`, `platform/linux`, Startverhalten**

Dateien: `src/lib.rs` (vier `pub mod`, keine Logik — ohne Lib-Target kann kein
Integrationstest unter `tests/` die Module importieren; die Node-Suite hat die
Module ebenfalls importiert), `src/{protocol,config,log}.rs`,
`src/platform/{mod,linux}.rs`, `src/main.rs` (Token ⇒ `2`; binden ⇒ `1` +
Besitzerzeile; `listening on … log=…`; SIGTERM ⇒ `received SIGTERM, shutting
down` + `0`), `tests/{protocol,config,platform}.rs`, `tests/common/mod.rs`,
`tests/ports.rs`, `Cargo.toml` (tokio, dazu `[lib]` mit `name`/`path`),
`Cargo.lock`, und **`bridge-rs/README.md`** (drei Sätze stimmen nach dieser Stufe
nicht mehr: „does nothing yet", „No dependencies", „empty `[dependencies]`
table").

Mitzuportieren, weil es Verhalten ist: **`log_line` bildet `toISOString()`
exakt nach** (immer drei Millisekunden, `Z`) — die Maskierung des Maßstabs
strippt genau dieses Präfix, jeder andere Zeitstempel wäre ein Unterschied;
`parseBind` (letzter Doppelpunkt,
`[::1]`-Klammern, leerer Host ⇒ `127.0.0.1`, ungültiger Port ⇒ `8110`)
**einschließlich `:0` ⇒ `8110`** (nicht „reparieren"); `BC_LOG` nur `info|debug`;
Token ≥ 32 Hex, getrimmt, `ENOENT` ⇒ `2`, sonst `bridge failed: …` + `1`;
`EADDRINUSE` als **String** in der Zeile.

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --lib --test protocol --test config --test platform --test ports
# `--lib` fährt die 13 Unit-Tests (u. a. `iso_timestamp` mit drei Millisekunden —
# die Begründung dieser Stufe), `--test ports` die Porttabelle. Beides fehlt,
# wenn man nur die drei Integrationstests nennt.
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl && bash scripts/parity.sh --impl rust --check --only 5,6      # ⇒ 2/2 wie erwartet (Exit 0)
# `--only` zählt nur die gewählten Vergleiche. Der volle Lauf zeigt den Abstand:
# `bash scripts/parity.sh --impl rust --check` ⇒ `2/7 wie erwartet`, Exit 1 —
# Vergleiche 1–4 und 7 brauchen 2b–2e.
```

**Stufe 2b — `ws`: Handshake, Codec, Close**

Dateien: `src/ws/{mod,frame,handshake}.rs`, `tests/ws.rs`, `src/lib.rs` (ein
`pub mod ws;`, wie in 2a), `Cargo.toml` (`sha1`, `base64`), `Cargo.lock`.

**Keine WebSocket-Bibliothek**: die Close-Codes `4401/4408/4409` und
`1002/1003/1009` sind Vertrag, die Grenze muss **vor** dem Puffern feuern, und
Bytes nach dem Handshake sind ein eigener Fall.

**Der Puffer darf nicht pro Frame wandern.** `drain(..frame_end)` in der
Decoderschleife verschiebt jedes Mal den Rest des Puffers — quadratisch in der
Chunk-Größe, gemessen 66 s gegen 0,6 s der Vorlage bei 3 MB (Grenze: 5 MiB, und
der Extension-Port prüft vor dem `hello` kein Token). Leseoffset, einmal pro
`push` kompaktieren; ein Fall mit vielen kleinen Frames in einem Chunk hält es
fest.

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test ws 2>&1 | grep -cE '^test (acceptKey|encodeFrame|frameDecoder|upgradeSocket|websocket)_[A-Za-z0-9_]+ \.\.\. ok'   # ⇒ 13
# Das `_` in der Zeichenklasse ist Pflicht: jeder Node-Name trägt einen weiteren
# Unterstrich (`acceptKey_withRfcSampleKey_shouldReturn…`), mit `[A-Za-z0-9]+`
# zählt der Beweis 0 und die Abnahme wäre rot.
```

**Stufe 2c — `hub`**

Dateien: `src/hub.rs`, `tests/hub.rs`, `src/lib.rs` (ein `pub mod hub;`),
`src/main.rs` (der Hub muss im Startpfad hängen, sonst misst `--only 4` ein
Binary ohne Verhalten), `bridge-rs/README.md`, `Cargo.toml` (`sha2`, `subtle`,
**`serde_json` mit `preserve_order`** — der Hub kann ohne JSON-Werttyp weder
`hello` parsen noch Frames bauen; damit wird der `Cargo.toml`-Schritt von 2d ein
No-op), `Cargo.lock`.

**Kein `4402`.** Die Vorlage kennt nur `1002` für ein kaputtes `hello`
(`hub.mjs:634`); eine **abweichende Protokollversion** wird nicht abgelehnt,
sondern als `protocol=<n|unknown>` geloggt und akzeptiert (ein Reload darf den
Betreiber nicht aussperren). Wer hier einen Close-Code erfindet, verschiebt
Verhalten.

Der Hub kennt keinen Socket, sondern
`mpsc::Sender<Outbound>` + `Arc<AtomicBool>`; `close(code, reason)` geht als
`Outbound::Close` durch denselben Kanal. Fristen über `tokio::time` mit den
Werten aus der Config (Tests: 100–300 ms).

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test hub 2>&1 | grep -cE '^test (hub|formatStatusLine|debugBlockOf|verifyToken)_[A-Za-z0-9_]+ \.\.\. ok'   # ⇒ 55
# Das `_` in der Zeichenklasse ist Pflicht (jeder Name trägt weitere Unterstriche).
# 55 = 41 `hub_*` (einer davon umbrochen in test/hub.test.js, deshalb zählt die
# Quelle 54) + 9 `debugBlockOf_*` + 2 `formatStatusLine_*` + 3 `verifyToken_*`.
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl && bash scripts/parity.sh --impl rust --check --only 4        # ⇒ 1/1 wie erwartet (Exit 0)
# `--only` zählt nur die gewählten Vergleiche; im vollen Lauf sind es 3/7
# (Vergleich 3 braucht 2d, Vergleich 7 braucht 2e).
```

**Stufe 2d — Werkzeugschicht und stdio**

Dateien: `src/mcp/{mod,tools,texts,failure}.rs`, `src/stdio.rs`, `src/main.rs`,
`tests/mcp.rs` (Naht), `Cargo.toml` (`serde`, `serde_json` mit
`preserve_order`).

`tools.rs` schreibt die 13 Einträge als `json!`-Literale **in der Reihenfolge
von `bridge/mcp.mjs`**; `texts.rs` kopiert `TOOL_TEXTS` wörtlich. `SERVER_INFO`
bleibt `{"name":"browser-control","version":"0.1.0"}` (nicht aus `Cargo.toml`).
**`BRIDGE_VERSION`** (`bridge/hub.mjs:19`) ist eine **zweite** harte Version, die
im `welcome`-Frame landet — kein Artefakt und keiner der 55 Hub-Fälle prüft
diesen Frame, deshalb pinnt ihn ein eigener Fall (`hub_welcomeFrame_shouldCarry
TheBridgeVersionAndTheProtocol`).

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test mcp 2>&1 | tail -1   # ⇒ 0 failed; N im ## Log gegen die Naht-Fälle gestellt
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl && bash scripts/parity.sh --impl rust --check --only 1,2,3    # ⇒ 3/7 (Vergleich 7 braucht --http aus 2e)
```

**Stufe 2e — `POST /mcp`**

Dateien: `src/http.rs`, `tests/http.rs`, `src/lib.rs` (ein `pub mod http;`),
`src/main.rs` (der `--http`-Zweig und die zweite Logzeile, ohne die Vergleich 7
nicht grün wird), `Cargo.toml` (`hyper` mit `server`/`http1`, `hyper-util` mit `tokio`,
`http-body-util`), `Cargo.lock`, `bridge-rs/README.md`.
Reihenfolge Pfad → Methode → Token → Körper; `404`, `405` +
`Allow: POST`, `401` + `WWW-Authenticate`, `413` vor dem ersten Body-Byte und
beim chunked-Körper, `200`, `null` ⇒ `202`; jede Ablehnung mit
`Connection: close`; `MAX_BODY_BYTES = 1048576`.

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test http 2>&1 | grep -cE '^test http_[A-Za-z0-9_]+ \.\.\. ok'   # ⇒ 15 (14 portiert + 1 Naht, s. Testlandkarte)
# `[A-Za-z0-9_]` — jeder Name trägt weitere Unterstriche.
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl && bash scripts/parity.sh --impl rust --check --only 7        # ⇒ 1/1 wie erwartet (Exit 0)
```

**Stufe 2f — Prozesstests, stdin, voller Paritätslauf**

Dateien: `tests/bridge.rs`, `tests/mcp.rs` (Prozessfälle), `src/{main,stdio}.rs`.

**stdin-EOF beendet nur, wenn stdin eine Pipe oder ein Socketpair ist** — unter
systemd ist stdin `/dev/null`, sonst beendet sich der Dienst sofort und
`Restart=on-failure` dreht eine Schleife. Linux:
`metadata("/proc/self/fd/0")` + `FileTypeExt::is_fifo()/is_socket()`.

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml -- --test-threads=1 2>&1 | tail -1   # ⇒ 0 failed
# `--test-threads=1` ist Pflicht, sobald echte Bridges auf den reservierten Ports
# starten: `cargo test` fährt Fälle einer Datei parallel, die Node-Suite läuft aus
# genau diesem Grund mit `--test-concurrency=1`.
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl && bash scripts/parity.sh --impl rust --check; echo $?              # ⇒ 7/7, 0
```

**Stufe 3 — Windows**

Dateien: `src/platform/windows.rs` (`GetExtendedTcpTable` → PID →
`QueryFullProcessImageNameW`), `src/stdio.rs` (`GetFileType`), `src/main.rs`
(`ctrl_c`), `Cargo.toml` (`windows-sys`), `bridge-rs/README.md`,
`deploy/windows/browser-control-bridge.xml` (Task Scheduler, `AtLogOn`,
`InteractiveToken`, ohne Admin).

Proof:
```
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-pc-windows-gnu; echo $?   # ⇒ 0
cargo clippy --manifest-path bridge-rs/Cargo.toml --target x86_64-pc-windows-gnu --all-targets -- -D warnings; echo $?   # ⇒ 0
file -b bridge-rs/target/x86_64-pc-windows-gnu/release/browser-control-bridge.exe   # ⇒ "PE32+ … (console) x86-64"
```

**Stufe 4a — Unit, Installer, `docs/35`**

Dateien: `deploy/browser-control.service` (`ExecStart=%h/.local/bin/browser-control-bridge
--http`, `RestartPreventExitStatus=2` bleibt), `scripts/install.sh`
(`check_binary`, `install_binary` aus
`<clone>/bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge`
nach `$HOME/.local/bin` mit `0755`; fehlt die Quelle: „nicht gebaut, `cargo
build --release --target x86_64-unknown-linux-musl` zuerst" + Exit `1`;
`guard_path` bekommt `$HOME/.local/bin` als dritten Ort, und
`install_guardPathRejectsAPathOutsideTheAllowedSet` wird **erweitert**, nicht
aufgeweicht; `--fix-path` entfällt), `test/deploy.test.js`,
`test/install.test.js` (Sandbox legt nur noch `home/browser-control/` an, nicht
mehr `…/bridge/bridge.mjs`; zwei neue Fälle
`install_copiesTheBinaryToLocalBin`, `install_withMissingBinary_abortsBeforeWriting`;
`install_withOldNode_abortsBeforeWriting` wird umgeschrieben,
`install_fixPathWritesTheDropInOnlyWhenNeeded` **entfällt ersatzlos** (das Flag
gibt es nicht mehr — einen Test zu behalten, der ein gelöschtes Flag behauptet,
nur damit eine Zahl hält, ist Selbstbetrug); die Zahl **31** = 20 verbleibende `install_`-Fälle + 2 neue + 9 Unit-/`ExecStart`-Fälle), **`docs/35` wird hier
nachgezogen** (`docs/README.md`: die Stufe, die das Verhalten ändert).
`docs/18` bleibt bis 4b unangetastet.

Proof:
```
node --test --test-reporter=tap test/deploy.test.js test/install.test.js 2>&1 | grep -cE '^ok [0-9]+ - (install_|browserControlService_|execStart_)'   # ⇒ 31 (20 install_ nach dem Wegfall des fixPath-Falls + 2 neue + 9 Unit-/ExecStart-Fälle)
grep -c 'ExecStart=%h/.local/bin/browser-control-bridge --http' deploy/browser-control.service   # ⇒ 1
grep -c 'bridge/bridge.mjs' scripts/install.sh                                                   # ⇒ 0
bash -n scripts/install.sh; echo $?
```

**Stufe 4b — der Schnitt**

Löschen: `bridge/` (8 Dateien), die zehn Node-Bridge-Testdateien, `test/ports.js`.
**`--impl node`, `--record` und `node,node` verlieren ihr Subjekt:** `scripts/parity.sh`
und `scripts/parity/driver.mjs` werden angepasst, sodass `--impl node` mit
„keine Node-Bridge mehr — die sieben Artefakte sind eingefroren" und Exit `1`
antwortet, statt ein fehlendes Skript zu spawnen. Die Artefakte bleiben der
Maßstab; nur ihr Erzeuger ist weg.
Ändern: `test/extension.test.js` (der `loadConfig`-Import wird zu den Literalen
`127.0.0.1`/`8110` plus Drift-Satz), `docs/18` und `docs/29` (Amendments aus der
Tabelle unten), `docs/30` und `INSTALL.md` (Task-Scheduler-Weg; Node nur noch für
Tests), `CONTRIBUTING.md` (`cargo test` in der Abnahme), `scripts/parity.sh` +
`scripts/parity/driver.mjs` (`--impl node` ⇒ laute Meldung), `scripts/install.sh`
(die zwei `bridge/`-Kommentare und `pkill -f bridge.mjs`), **und die Specs
abschließen** (`CONTRIBUTING.md`, Schritt 7): `docs/38` und `docs/37` auf
`status: active`, den eigenen `## Amendments`-Abschnitt von `docs/38` entfernen,
`docs/README.md` (zwei Status-Zellen), `docs/PROJECT-STATE.md`.

Proof:
```
test -d bridge && echo present || echo gone                 # ⇒ "gone"
git log --diff-filter=D --oneline -- bridge/ | wc -l        # ⇒ 1
npm test 2>&1 | grep -E '^# (tests|fail|cancelled|skipped)'  # ⇒ fail/cancelled = 0
cargo test --manifest-path bridge-rs/Cargo.toml 2>&1 | tail -1
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl && bash scripts/parity.sh --impl rust --check; echo $?         # ⇒ 7/7, 0
grep -rnE 'bridge/config\.mjs|bridge/bridge\.mjs|bridge\.mjs' test/ scripts/ deploy/ package.json   # ⇒ keine Ausgabe
```

### What could go wrong

- **`EADDRINUSE` ist in Rust kein String** — `kind()`/`raw_os_error()` (98 bzw.
  10048); die Logzeile braucht das Wort, sonst fällt Vergleich 5 leise.
- **`preserve_order` und Zahlenformate** — ohne `preserve_order` sortiert
  `serde_json` Schlüssel alphabetisch (Vergleich 1 sofort rot); ein `12.0`
  schreibt Node als `12`, Rust als `12.0` ⇒ Zahlenformatierer wie Node plus
  Testfall.
- **stdin-EOF unter systemd** — ohne die Prüfung startet der Dienst im
  Sekundentakt neu.
- **Bytes nach dem Handshake** — der eigene Kopfleser muss die Restbytes an den
  Codec weiterreichen, sonst geht ein `hello` im selben Paket verloren.
- **Die Fixture ist geteilt** — sie wird nicht angefasst; `ws-probe.mjs` deckt,
  was sie nicht kann.
- **`npm test` wird in 4b kleiner** — das gehört in den Commit und in
  `PROJECT-STATE.md`, sonst liest es sich wie ein Verlust.
- **`~/.local/bin` ist ein neuer Schreibort** — ohne Pfadwächter-Eintrag bricht
  `install_writesOnlyUnderHome`.
- **`BC_BIND=127.0.0.1:0` bleibt eine stille Lüge** — portieren, nicht beheben.
- **Rust-Testnamen sind nicht snake_case** (sie tragen die Node-Namen, damit die
  Zuordnung ablesbar bleibt). `clippy --all-targets -- -D warnings` würde daran
  scheitern ⇒ `#![allow(non_snake_case)]` in den Test-Crates, bewusst und
  kommentiert.
- **Lone surrogates** nimmt Node, `serde_json` nicht — benannte Lücke, kein
  Blocker.

### Ordering and dependencies

`2a → 2b → 2c → 2d → 2e → 2f → 3`, dann `4a → 4b`. Voraussetzung ist Teil 1
(`docs/37`). 2c braucht 2b; 2d braucht 2c und 2a; 2e braucht 2d; 2f braucht 2e;
3 braucht 2f; 4a braucht ein gebautes statisches Binary; 4b braucht 4a.
Unberührt bis 4a: `docs/18`, `deploy/browser-control.service`; unberührt bis 4b:
`bridge/**`, `extension/**`, `test/fixtures/fake-extension.mjs`.

### What the next increment inherits

- **macOS und arm64** bleiben eine eigene Zeile; `platform/` ist dafür geschnitten.
- **Der Windows-Startweg ist kompiliert, nicht gelaufen.**
- **`scripts/parity.sh --check` ist ab 4b das Regressionsnetz** für alles, was
  früher die Node-Tests waren.
- **Node bleibt für Tests und Parity** — nicht für den Betrieb.

## Bekannte Lücken

Stand 2026-11-17, nach dem Schnitt:

- **Windows ist kompiliert, nicht gelaufen.** Task Scheduler,
  `GetExtendedTcpTable`, `GetFileType` sind Betreiber-Messungen.
- **Lone surrogates und `x.0`-Zahlen** sind nicht zeichengleich zu Node —
  benannt, nicht behoben.
- **`BRIDGE_FAILED`** erreicht die Parität nicht; ein Rust-Unit-Test pinnt ihn.
- **`test/mcp.test.js`-Fälle, die Node-Verhalten prüfen** (EPIPE,
  `MaxListenersExceededWarning`) fallen ohne Ersatz weg.
- **Die Zahl der Naht-Fälle** (ausgezählt in 2d): 148 portierbare Node-Fälle
  (151 Blattfälle minus 3 stdin-Fälle aus 2f), davon 114 in `tests/mcp.rs` —
  die Differenz sind ~37 Fälle, die in `for`-Schleifen zusammengefasst sind.
- **Windows ist kompiliert, nicht gelaufen** — die Proben für den Betreiber
  stehen in `bridge-rs/README.md` (Portbesitzer gegen `Get-NetTCPConnection`,
  `name=unknown` bei fremden Prozessen, `GetFileType` mit `< NUL` und Pipe,
  Strg+C ⇒ `received SIGINT`), dazu `row_capacity` in `platform/windows.rs`:
  reine Arithmetik über `size_of`, aber noch hinter `cfg(windows)`.
- **Vier Abweichungen aus 2d:** `is_http_url` akzeptiert `http://user@:80`, wo
  `new URL()` lokal verweigert (sichtbar nur ohne verbundene Extension:
  `ExtensionUnavailable` statt der Verweigerung); stdio trennt nur an `\n`,
  Nodes `readline` auch an einem einzelnen `\r`; eine letzte Zeile **ohne** `\n`
  beantwortet Rust, die Vorlage nicht; `stdio.rs` loggt `mcp write failed: …`,
  während die Vorlage still schluckt (bewusst — ein Schreibfehler auf stdout
  ist ohne Zeile nicht diagnostizierbar). Die EOF-Regel hängt an
  `/proc/self/fd/0`: ohne gemountetes `/proc` endet die Bridge nicht; auf
  Windows ist `false` dagegen **deckungsgleich mit der Vorlage**, nicht die
  Lücke.

## Open questions

**Keine.** Die HTTP-Frage (eigener Kopfleser am Extension-Port, `hyper` nur für
`/mcp`) ist mit `## Dependency changes` entschieden.

## Review

### Runden 1–3 der gemeinsamen Fassung — 2026-11-16, `grizzled-senior-dev`

Die gemeinsame Fassung wurde dreimal blockiert (Runde 1 `🤔` mit 7 Blockern,
Runde 2 `🔧` mit 8 Punkten, Runde 3 `🔧` mit 5 Punkten und vier neuen
Textwidersprüchen). Statt einer vierten Runde wurde **geteilt**
(`CONTRIBUTING.md`, Schritt 4). Aus Runde 3 sind hier eingearbeitet: der
2b-Nachsatz („tokio und serde erst mit 2a/2d") ist weg, `docs/35` steht nur
noch in 4a (in 4b wird nur der Amendments-Abschnitt entfernt), der Plan-Baum
nennt **kein** `.cargo/config.toml` mehr, die 2f-Begründung „Node-Seite gibt es
nicht mehr" ist nach 4b gewandert, und die beiden `install_`-Fälle, die 4a
umschreibt, behalten ihr Präfix (Zahl **32** hält).

### Runde 1 dieses Dokuments — 2026-11-16, `grizzled-senior-dev`: 🔧

Neun Blocker, vierzehn Major. **Alle übernommen** (`## Log`). Die Zählung beginnt
mit der Teilung neu (`docs/37`); die Runden 1–3 der gemeinsamen Fassung stehen
dort als Vorgeschichte.

### Runde 2 — steht aus

Teil 2 geht erst weiter, wenn diese Runde abgearbeitet ist; gebaut wird nach
`CONTRIBUTING.md`, Schritt 6.

## Log

- **2026-11-16, Betreiberentscheid:** Rust, paralleler Aufbau, Linux und Windows
  x86_64.
- **2026-11-16, Teilung:** nach dem dritten Block in „Maßstab" (`docs/37`) und
  „Port" (dieser Teil) getrennt.
- **Secret-Grep ausgenommen (2026-11-17):** `bridge-rs/Cargo.lock` enthält mit
  der ersten Abhängigkeit 16 Zeilen à 64 Hex-Zeichen (Crate-Prüfsummen). Der
  Grep läuft jetzt zweistufig — Repo ohne die Lock-Datei, und die Lock-Datei
  ohne `checksum = "…"`-Zeilen —, damit die Datei nicht pauschal blind wird.
- **Stufe 2a, Review-Runde (2026-11-17):** `error_code` liegt in `log.rs` und
  bildet `ErrorKind` auf `EADDRINUSE`/`EACCES`/`EADDRNOTAVAIL` ab, mit Unit-Test
  gegen `expected/5-port-busy.txt`; `token_path` liest nur noch das übergebene
  Env (Passwd-Rückfall bewusst aufgegeben); `read_token`s Fehlerzweig hat einen
  Fall (Verzeichnis ⇒ `Err`); `parse_timeout` hat die Fälle `1e3`/`0.5`, und der
  Kommentar behauptet kein `Number(raw)` mehr; `protocol_constants!` erzeugt
  Konstanten und Vergleichstabelle aus einer Quelle; `bridge-rs/README.md`
  beschreibt den Stand nach 2a. **29 Rust-Fälle** (18 Unit + 11 Integration).
- **Stufe 2b, Review-Runde (2026-11-17):** der Decoder wanderte pro Frame per
  `drain` (quadratisch); mit Leseoffset und einer Kompaktierung pro `push`
  **70 888 ms → 193 ms** bei 512 000 Frames / 3,58 MB in einem Chunk. Dazu:
  Head-Bytes vor dem `Close` zugestellt (sonst verschluckt sie ein sofortiger
  Socket-Abbau), `Headers::push` trimmt OWS wie Nodes Parser, der
  Mixed-Case-Test prüft die Token-Schreibweise wirklich, und fünf Lücken sind
  gepinnt (Ping zwischen Fragmenten, zwei Fragmentierungsrunden, exakte Grenze,
  Ein-Byte-Close, fehlende Version). **72 Rust-Fälle.**
- **Stufe 2c, Review-Runde (2026-11-17):** zwei Blocker im neuen Kopfleser
  (`src/head.rs`, `src/link.rs` — aus `main.rs` herausgezogen, damit `tests/`
  ihn messen kann): ein `hello` im Handshake-Paket wurde nicht zugestellt und
  die Verbindung endete mit `4408` statt `welcome` (am Binary gemessen), und
  einfaches HTTP bekam `400` statt `426`. Dazu: `send`-Fehlschlag beendet die
  Verbindung (sonst 20-s-Timeout statt „could not be sent"), Accept-Fehler
  loggen `listener failed on …` und enden mit `1` (nur `ECONNABORTED` läuft
  weiter), `number_field`/`string_field` prüfen Typen wie die Vorlage,
  `handle_hello_timeout` respektiert `authenticated`, der Peer wird im selben
  Lock wie der Auftrag gelesen, Kopfleser hat eine Frist und der 16-KiB-Deckel
  steht **vor** der Terminatorsuche. **134 Rust-Fälle.**
- **Korrektur an Runde 1 (2026-11-17, Orchestrator):** die Zahl „16" war doppelt
  gezählt — `http_rejectsAnOversizedChunkedBody` ist der Node-Fall
  `withOversizedChunkedBody`, es gibt also **14 portierte + 1 Naht = 15**
  (`http_withTheSameAnswerAsStdio_shouldMatch`). Ebenso fehlte `src/main.rs` in
  der Dateiliste von 2e, obwohl die Stufe ohne die zweite Logzeile Vergleich 7
  nicht grün bekommt, und beide Proof-Zeilen zählten mit `[A-Za-z0-9]` statt
  `[A-Za-z0-9_]` (jeder Node-Name trägt weitere Unterstriche). Die
  Runde-1-Zeile bleibt als Protokoll stehen, wie sie war.
- **Stufe 4a gebaut (2026-11-17):** Unit und Installer zeigen auf das Binary.
  `deploy/browser-control.service` startet
  `%h/.local/bin/browser-control-bridge --http` (`RestartPreventExitStatus=2`
  bleibt: Exit 2 heißt „Tokendatei fehlt oder ist zu kurz", das heilt kein
  Neustart); `scripts/install.sh` prüft das gebaute musl-Artefakt (vorhanden
  **und** ausführbar), kopiert es mit `0755` idempotent (Staging + `mv` gegen
  `ETXTBSY`), `guard_path` kennt `$HOME/.local/bin` als dritten Ort, und
  `--fix-path` samt Drop-in-Logik ist **ersatzlos entfallen**. **31 Fälle**
  (`install_`/`browserControlService_`/`execStart_`), `npm test` 765 grün.
- **Stufe 3 gebaut (2026-11-17):** Windows-Seite. `platform/windows.rs` holt den
  Portbesitzer über `GetExtendedTcpTable` (`TCP_TABLE_OWNER_PID_ALL`, IPv4 **und**
  IPv6, `LISTEN`/`ESTAB`) und `QueryFullProcessImageNameW`; `stdio.rs` erkennt
  den Client-Kanal über `GetFileType` (`FILE_TYPE_PIPE`), `main.rs` beendet über
  `ctrl_c` mit `received SIGINT, shutting down` (die Schreibweise der Vorlage);
  `deploy/windows/browser-control-bridge.xml` startet die Bridge als
  Task-Scheduler-Aufgabe (`AtLogOn`, `InteractiveToken`, `LeastPrivilege`).
  Die **reine** Dekodierung (`port_of`, `holds_port`, `image_basename`,
  Zustandszahlen) liegt in `platform/windows_table.rs` **ohne `cfg`** und wird
  auf Linux getestet — der erste Anlauf hatte sie hinter `cfg(windows)`, wo sie
  nur `clippy` sah, und der Test baute das Feld mit falscher Byte-Ordnung
  (`port_of` lieferte 44575 statt 8110). **283 Rust-Fälle**, parity 7/7.
  **Bewusste Abweichung:** `GetFileType` beendet die Bridge bei einer Pipe auf
  Windows, wo die Vorlage weiterläuft.
- **Stufe 2f gebaut (2026-11-17):** Prozesstests und stdin-Lebenszyklus.
  `tests/bridge.rs` startet das echte Binary für die drei Verträge — Pipe-EOF ⇒
  Exit 0 mit genau einer Zeile `stdin closed, shutting down`, dasselbe mit
  verbundener Extension-Sitzung, und `/dev/null` auf stdin ⇒ die Bridge läuft
  weiter und ihr Port bleibt erreichbar (ohne diese Regel dreht systemd eine
  Neustartschleife). Die Regel war im Code schon richtig; drei Mutationsproben
  zeigen, dass die Fälle sie wirklich messen (Prüfung entfernt, Logzeile auf
  stdout umgeleitet, Abschiedssatz verändert ⇒ je genau ein Fall rot). **279
  Rust-Fälle**, `parity --impl rust --check` ⇒ **7/7**, Exit 0.
- **Stufe 2e gebaut (2026-11-17):** `POST /mcp` mit `hyper`/`hyper-util`/
  `http-body-util`; Reihenfolge Pfad → Methode → Token → Körper, `413` vor dem
  ersten Körperbyte, `Connection: close` an jeder Ablehnung, `202` für
  Notifications, `500` bei einem Panic in der Werkzeugschicht. **Der Maßstab
  steht: `parity --impl rust --check` ⇒ 7/7, Exit 0.** 276 Rust-Fälle, davon 22
  in `tests/http.rs` (14 portiert + 1 Naht + 7 aus der Review-Runde).
  Drei Abweichungen, die erst die Messung zeigte: `hyper` löscht
  `Content-Length` aus der Kopf-Map, sobald danach `Transfer-Encoding` kommt
  (deshalb ein passiver `HeadTap` auf dem Rohkopf — eine Map-Prüfung hätte nur
  eine Header-Reihenfolge abgedeckt); ein Panic wird jetzt zu `500` **ohne**
  mehrzeiligen Panic-Block auf stderr (Hook im Startpfad, die Vorlage schluckt
  den Fehler ebenfalls); ein abgebrochener Körper beantwortet **nichts** wie die
  Vorlage, nicht `400`. Kopf-Frist 60 s wie Nodes `headersTimeout`.
- **Stufe 2d gebaut (2026-11-17):** Werkzeugschicht und stdio. Die Werkzeugliste
  ist **byte-identisch** (`parity --only 1,2,3` ⇒ 3/3; `tools/list` 7.390 Byte
  wie die Vorlage), 218 von 218 Antworten über 13 Werkzeuge × 15 Argumentformen
  stimmen zeichengleich. `tests/mcp.rs` hat **114 Fälle** — portierbar sind
  **148** Node-Fälle (151 Blattfälle minus die 3 stdin-Fälle, die zu 2f
  gehören); die Differenz sind ~37 Fälle, die in `for`-Schleifen zusammengefasst
  sind. **250 Rust-Fälle.** Review-Blocker: die Antwort auf die *letzte* Zeile
  vor stdin-EOF ging verloren (`printf … | bridge` schrieb 0 Byte) — `serve`
  wartet jetzt auf die Writer-Task, mit einem Prozessfall
  (`mcp_process_theAnswerToTheLastLineBeforeStdinEof_shouldReachStdout`).
- **Stufe 2c gebaut (2026-11-17) — Abhängigkeiten:** `sha2`, `subtle`,
  `serde_json` + `indexmap` (eine Stufe früher als geplant, Begründung in der
  Dateiliste), Lock: `serde`, `itoa`, `memchr`, `hashbrown`, `equivalent`,
  `foldhash`. Korrektur am Auftrag: **kein `4402`** — die Vorlage schließt bei
  kaputtem `hello` `1002` und akzeptiert eine abweichende Protokollversion.
- **Stufe 2b gebaut (2026-11-17) — Abhängigkeiten:** `sha1 0.10.7`,
  `base64 0.22.1` (transitiv `digest`, `block-buffer`, `crypto-common`,
  `generic-array`, `typenum`, `cpufeatures`, `cfg-if`, `version_check`).
- **Stufe 2a gebaut (2026-11-17) — Abhängigkeit:** `tokio 1.54.1` (Lock-Angabe;
  `Cargo.toml` schreibt `"1"`), 16 Pakete, ausschließlich tokios transitiver
  Graph — kein `serde`, `sha2`, `base64` vorweg.
- **Runde 1 dieses Dokuments (2026-11-16) — Neun Blocker übernommen:**
  Release-Build vor jedem `--impl rust`-Lauf (B1); `sha2` + `subtle` für den
  Tokenvergleich (B2); `hyper-util` und hyper-Features (B3); die 16 in
  `tests/http.rs` hergeleitet (14 + 2) (B4); `--test-threads=1` für die
  Prozessfälle (B5); 4b nimmt `scripts/parity*` auf und schafft `--impl node` ab
  (B6); 4b schließt die Specs ab (B7); Amendments für `docs/29`, `docs/18` und
  `docs/35` (B8); `docs/30`-Non-Goals und Roadmap-Zeile 31 (B9).
- **Runde 1 — Major übernommen:** `|| echo gone` in Kriterium 6;
  `grep -Eq` für `file`; `BC_TOKEN_FILE` im `curl`-Beweis; `# tests N` in 4b;
  Clippy mit `--all-targets` und `allow(non_snake_case)`; `Cargo.lock` existiert
  seit Stufe 1; tokio-Features `io-std`/`process` und `windows-sys`-Features;
  `BRIDGE_VERSION` und der `welcome`-Frame gepinnt; `toISOString()` in 2a;
  der `fixPath`-Test **entfällt** statt umbenannt; Rundenzählung neu;
  4b entfernt den Amendments-Abschnitt von `docs/38` (nicht von `docs/35`).
- **Aus Runde 1–3 der gemeinsamen Fassung:** `## Dependency changes` mit Crates;
  eigene Abhängigkeiten in 2a/2b/2d/2e/3 statt einer Sammelzeile; kein
  `.cargo/config.toml`; Zahlen statt „≥" (16 in 2e, 32 in 4a); `--check` in
  jedem Parity-Beweis; `docs/35` in 4a, `docs/18` in 4b; `git log
  --diff-filter=D` in 4b; `deploy/windows/` in Stufe 3 erlaubt.
