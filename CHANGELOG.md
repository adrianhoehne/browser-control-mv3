# Changelog

Alle nennenswerten Änderungen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionierung nach [SemVer](https://semver.org/lang/de/).

## [Unreleased]

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
