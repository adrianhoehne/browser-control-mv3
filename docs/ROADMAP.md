# Roadmap — browser-control

Was als Nächstes kommt, in der Reihenfolge, in der es gebaut werden soll. Kein
Spec-Ersatz: jede Zeile wird beim Bauen zu `docs/NN-….md` mit Ziel, Kriterien
und Dev-Plan. Diese Datei sagt nur, *was* und *warum jetzt*.

Stand 2026-11-17, nach Spec 38 (`docs/38-rust-port.md`) — der Port ist der einzige Implementierungsbaum.
**Reihenfolge-Regel des Betreibers: Funktionalität zuerst, Sicherheit und
Betrieb ganz ans Ende.** Und keine Zeile ist „groß": was groß wäre, ist hier in
mittlere und kleine Schritte geteilt, damit jedes Inkrement in einem Zug durch
die Gates kommt.

Die Zeilennummern bleiben stehen, auch wenn eine Zeile erledigt ist — Belege in
`PROJECT-STATE.md` und in den Specs verweisen darauf („Roadmap 08g"). Nummern
werden nicht neu vergeben.

## Gemacht

| Spec | War Zeile | Was |
|---|---|---|
| `01-skelett-verbindung-und-status.md` | 01 | Naht: WSS über Caddy, Token, `status` |
| `02-persistenter-background.md` | 02 | Verbindung hält Leerlauf aus (MV2, `persistent: true`) |
| `03-mcp-browser-status.md` | 03 | MCP über stdio, `browser_status` |
| `04-agenten-tab-und-navigate.md` | 04 | Agenten-Tab, `browser_navigate` — drei Restlöcher offen, siehe Nachträge |
| `05-seiteninhalt-lesen.md` | 05 | `browser_read` mit `<all_urls>` |
| `06-klicken.md` | 06 | `browser_click` per CSS-Selektor |
| `07-tippen.md` | 07 | `browser_type`, Passwortfelder per Option gesperrt |
| `08-fokus.md` | 08 | `browser_focus` holt Tab und Fenster nach vorn |
| `09-dom-abfrage.md` | 08b | `browser_inspect` — Selektor- oder Textsuche, read-only |
| `10-nicht-lesbar-mit-typ.md` | 08c | `not_readable` mit `kind` und `url` |
| `11-content-type-per-head.md` | 08c-b | echter Content-Type per HEAD (1,5 s Frist, nur 2xx) |
| `12-status-und-fokus-sagen-die-wahrheit.md` | 08d, 08e | `status` markiert den Agenten-Tab, `focus` liest `focused` nach |
| `13-page-busy.md` | 08g | ehrliche Fehlercodes: `page_busy` statt „nicht lesbar" |
| `14-ruhe-statt-300ms.md` | 09 | `read` wartet bis zur DOM-Ruhe, meldet `settled`/`waitedMs` |
| `15-ruhe-fuer-click-und-navigate.md` | 10 | dieselbe Ruhe für `click` und `navigate` |
| `16-mehrere-agenten-tabs.md` | 08a | `browser_open_tab`/`browser_close_tab`, `tab`-Parameter, Obergrenze 5 |
| `17-slot-je-tab.md` | — (aus 16 herausgeschnitten) | Warte-Slot für `click`/`type` je Tab statt global |
| `18-dienst-und-http-mcp.md` | 19, 20 | systemd-Dienst besitzt Port 8110, MCP über HTTP auf 8111 |
| `19-browser-eval.md` | 08f | `browser_eval` — Code im Seitenkontext, Seitenänderungen nur mit dem Schalter `allowEval` |
| `20-screenshot-teil-1.md` | 11 | `browser_screenshot` — PNG/JPEG-Base64 mit Leiter, hinter `allowScreenshot` (Teil 1 von 2) |
| `21-screenshot-teil-2.md` | 12 | `browser_screenshot` (Teil 2) — Bild als MCP-`image`-Block, Grenzen 3 MiB / 5 MiB / 20 s |
| `22-read-ausschnitte.md` | 13 | `browser_read` mit `offset`/`maxChars` — Blättern durch lange Artikel |
| `23-artikel-extraktion.md` | 14 | `browser_read` mit `mode: article` — Artikelkörper statt ganzer Seite |
| `24-frames.md` | 15 | `browser_frames` — iframes auflisten, mit `frame` adressieren |
| `25-frame-handeln.md` | 15 | Handeln im Frame: `read`/`inspect` über `frame` |
| `26-frame-click-type.md` | 15 | `click` und `type` im Frame |
| `27-shadow-dom.md` | 16 | offene Schattenbäume durchdringen (`>>>`) |
| `28-log-hygiene.md` | 18 | Debug-Block per Whitelist — **Code fertig, Spec noch `proposed`** (Amendments und Live-Messung offen) |
| `29-windows-betrieb.md` | 29 | `npm run check` ohne Shell-Werkzeuge — `scripts/check.mjs` prüft 28 Dateien, `checked 28 files` |
| `31-youtube-recherche.md` | 17 | Recherche: das Transkript ist lesbar, Werkzeug entschieden |
| `32-transkript-werkzeug.md` | 17 | `browser_transcript` (Teil 1) — Segmente mit Zeitstempeln |
| `33-spurwahl.md`, `34-spurendatei-beobachten.md` | 17 | Teil 2: die Originalspur, über eine mitgeschnittene `timedtext`-Datei |
| `35-installationsskript.md` | — (Betrieb) | `scripts/install.sh` — Token, Unit, Dienst, Prüfung in einem Befehl |
| `36-standard-endpunkt.md` | 31 (Teil) | Standard-Endpunkt `ws://127.0.0.1:8110`, sichtbar vorbelegt |
| `37-rust-bridge.md` | 26–28 (Teil) | Paritätsmaßstab: sieben eingecheckte Artefakte, `--check` 7/7, `--self-test` 7/7 rot |
| `38-rust-port.md` | 26–28 (Teil) | Die Bridge ist Rust: Werkzeugschicht, Hub, WebSocket, `POST /mcp`, Windows-Seite, Unit und Installer auf das Binary, `bridge/` gelöscht |

Gestrichen, mit Datum und Grund in der jeweiligen Zeile: **21** (Token-Rotation,
Handarbeit statt Code — Anleitung in `INSTALL.md`, `### Token wechseln`) und
**22** (Rate-Limit auf Auth-Versuche, 128 Bit Token auf Loopback).

## Offene Nachträge (keine Features, laufen nebenher)

| Vorhaben | Größe |
|---|---|
| Drei Restlöcher im `navigate`-Pfad schließen oder dauerhaft als Lücke führen: `onUpdated` prüft die Adresse nicht, `complete: false` nennt die vorherige Seite, eine Weiterleitung auf die alte Adresse endet in `complete: false` (`docs/04`, `## Bekannte Lücken`) | klein |
| Für `click` fehlt weiter ein Live-Beleg der Ruhe-Erkennung — fünf Versuche fielen auf den Rückfall (`docs/15`, `## Bekannte Lücken`) | klein |
| ~~**Windows-Installationsanleitung fehlt.**~~ **Erledigt:** `INSTALL.md`, Abschnitt 10 (Binary, Token, Task Scheduler, Prüfung) — der Weg ist mit `docs/38`, Stufe 3 gebaut; offen bleibt nur die Betreiber-Messung auf einem Windows-Rechner | winzig |
| **`docs/36`, Nachträge N1–N4** (Code-Review 2026-11-15): der Endpunkt-Arm der Leer-Prüfung in `background.js` ist nach dem Fallback toter Code, und der Log-Text „Endpunkt oder Token fehlt" nennt einen Grund, den es nicht mehr gibt; `options.js` trimmt den gespeicherten Endpunkt, `background.js` nicht; `endpoint_withAStoredValue…` prüft `FakeWebSocket.instances.length` nicht; der Hinweis in `options.html` bricht die Zeilenbreite und klebt am Token-Label | klein |
| **`docs/35`, drei ungemessene Pfade** (`## Bekannte Lücken`): ein echter systemd-Lauf auf einer fremden Distribution, der `/usr/bin`-Zweig von `--fix-path`, der `is-active`-Fehlschlag. Alle drei sind implementiert, aber nur per Stub geprüft | klein |
| **`docs/28` abschließen** — die Spec ist `proposed`, der Code fertig: Amendments, Doku-Verweise und die Live-Messung fehlen | klein |
| **`test/mcp.test.js` aufteilen** nach Werkzeugfamilien — 63–95 s bei 90 s Frist (`CONTRIBUTING.md`, `## Acceptance`); mit jeder Werkzeug-Stufe wird es enger | mittel |
| **Doku-Drift aus `docs/36` N5**: `README.md` und `PROJECT-STATE.md` beschrieben den Endpunkt als Handarbeit — in 0.4.0 nachgezogen, die Zeile bleibt als Erinnerung, dass solche Stellen beim Abschluss mitgesucht werden | winzig |
| **Spec 29, vier Nachzieher aus dem Code-Review** (2026-11-06, nicht blockierend, bewußt nicht mehr angefaßt weil `docs/29` `active` ist und ein Zurückstellen auf `proposed` mehr kostet als der Wert): (a) die Laufzeiten in `docs/29` und `PROJECT-STATE.md` sind ~20 % zu hoch — frisch gemessen 2,3–2,7 s statt 3,0–3,2 s; (b) `## Touch boundary` in `docs/29` nennt `docs/30-prozess-und-konsole.md` nicht; (c) für die Code-Review-Befunde B1, C9, C10 steht keine Zeile im `## Log` von `docs/29`; (d) `DIAGNOSIS_PATTERNS` in `scripts/check.mjs:37` hat ein zweites Muster (`/\bError\b/`), das beim Syntaxfehler nie greift | winzig |

## Funktionalität

**Diese Tabelle ist leer.** Die drei Zeilen 15 (Frames), 16 (Shadow DOM) und
17 (YouTube) sind gebaut und abgenommen — die Specs stehen unter „Gemacht",
die Begründungen in `docs/24`–`27` und `docs/31`–`34`. Offen bleiben nur
Sicherheit und Betrieb (unten) und die Nachträge (oben).

## Sicherheit und Betrieb (zuletzt)

| # | Vorhaben | Warum | Größe |
|---|---|---|---|
| 18 | **Log-Hygiene** — Whitelist statt Sperrliste für den Debug-Block | ~~Heute ersetzt die Redaktion nur `text`; ein neues Feld landet sonst ungefiltert auf stderr.~~ **Im Code erledigt durch Spec 28** (alle vier Stufen, beide Code-Reviews `✅`); offen: Amendments, Doku-Verweise, Live-Messung | klein |
| 23 | **Signierung/XPI, Teil 1** — die Erweiterung signieren und als XPI bauen | Sie ist temporär und nach jedem Firefox-Neustart weg | mittel |
| 24 | **Signierung/XPI, Teil 2** — Berechtigungsseite und Dokumentation der `<all_urls>`-Reichweite | Teilstück zwei; ohne sie ist eine signierte Auslieferung nicht ehrlich | klein |
| 25 | **Reichweite verkleinern (optional)** — Positivliste statt `<all_urls>` | Nur falls der Betreiber das später will; die Entscheidung von 2026-10-23 gilt bis dahin | mittel |
| 26 | **MV3-Migration, Teil 1** — den Socket in einen dauerhaft offenen Tab verlagern | Wenn Mozilla MV2 abschaltet; Teilstück eins. Spec: `docs/42-socket-im-tab.md` | mittel |
| 27 | **MV3-Migration, Teil 2** — Manifest auf MV3, Test aus Spec 02 bewusst umstellen | Teilstück zwei, setzt 26 voraus. Spec: `docs/43-manifest-mv3.md` | klein |
| 28 | **MV3-Migration, Teil 3** — Messung: hält die Verbindung im Tab wirklich? | Teilstück drei; ohne Messung ist der Umzug eine Behauptung. In `docs/43` als Stufe 3 | klein |
| 30 | **Windows-Betrieb, Teil 1b** — der Prozess und die Konsole | Setzt 29 voraus. Der Betreiber will pi, die Bridge und Firefox auf **einem** Windows-Rechner, und der Prozess soll aus einer **Konsole** startbar sein, nicht nur als Dienst: dafür müssen `SIGBREAK` dazukommen, das MCP-stdio im Terminal schweigen und die Amendments an `docs/18` nachgezogen werden. Spec: `docs/30-prozess-und-konsole.md` | mittel |
| 31 | ~~**Windows-Betrieb, Teil 2** — den Dienst optional einrichten, dazu der Endpunkt fürs lokale Firefox~~ — **erledigt durch `docs/38`, Stufe 3** | Der Autostart ist **entschieden und gebaut**: `deploy/windows/browser-control-bridge.xml` ist eine Task-Scheduler-Aufgabe (`AtLogOn`, `InteractiveToken`, `LeastPrivilege`) — **ohne NSSM, ohne WinSW**, ohne Adminrechte. Der lokale Endpunkt war schon mit `docs/36` entschieden (`ws://127.0.0.1:8110`, sichtbar vorbelegt), ein lokaler Caddy entfällt. Offen ist nur die Betreiber-Messung auf einem Windows-Rechner (`INSTALL.md`, Abschnitt 10) | — |
| 32 | **Handle Good Bye** — die Bridge soll auf die Abschiedsnachricht reagieren | Die Erweiterung sendet `{"type":"goodbye"}`, bevor sie den Socket schließt (`docs/44-schalter.md`). Die Bridge **empfängt und ignoriert** sie heute — das ist entschieden, nicht vergessen. Was später damit geschehen soll (Logzeile? Sitzung beenden? Statuszeile?), ist offen. Der Absender steht in `docs/44-schalter.md` | klein |

**Geteilt am 2026-11-06.** Die Zeilen 29 und 30 waren eine Spec. Das Spec-Review-Gate
hat sie dreimal blockiert (`docs/30-prozess-und-konsole.md`, `## Review`: L1–L6, M1–M5, N1/N2); nach `CONTRIBUTING.md`, Schritt 4, ist
sie damit zu groß und wurde entlang der Naht „Werkzeug gegen Verhalten" geteilt: das
Prüfskript ist überall prüfbar und braucht keinen Windows-Rechner, der Prozess nicht.

### Web-Arbeit ohne DOM-Sicht (belegt am 2026-10-23)

Eine Sitzung mit echten Aufgaben (Preisvergleich, Warenkorb, Studio-Anfrage) hat
gezeigt, wo die Werkzeuge anstoßen. Die Befunde sind inzwischen **abgearbeitet** —
`08b` → Spec 09, `08c`/`08c-b` → Specs 10 und 11, `08g` → Spec 13 —, die
Beobachtungen bleiben als Begründung stehen:

- **Selektoren raten kostet**: ~25 Versuche in einer Sitzung, ein Fehlklick
  (`a[href*="termin"]` traf „Vertrag kündigen" und navigierte auf die
  Kündigungsseite von magicline — ohne Absenden, aber es hätte schlimmer sein
  können). Antwort: `browser_inspect`.
- **Was Text nicht kann**: PDF und JPEG sind über `browser_read` nicht
  erreichbar, Shadow DOM/SPA liefert 0 Zeichen (Kursplan, Bewertungsportal),
  und ein Chat-Widget ohne erkennbaren Launcher lässt sich nicht wieder öffnen.
  Teilweise beantwortet (Typ und Link, Ruhe), Shadow DOM und Frames stehen noch
  als Zeilen 15/16.
- **Nicht unsere Baustelle:** Bot-Walls (Trustpilot antwortete mit
  „Verifying Connection") und Consent-Mauern. Fremde Abwehr umgehen ist keine
  Funktion, die dieses Projekt bauen sollte.

### Ein Agenten-Tab (belegt am 2026-10-23, erledigt durch Spec 16)

Die Extension hielt **einen** Agenten-Tab (`storage.local.agentTabId`); alle
Werkzeuge adressierten ihn, keines nahm eine Tab-Id. Das war die richtige
Entscheidung für „nicht in deinen Tabs herumschreiben", stieß aber im Alltag an
zwei Stellen an, beide am 2026-10-23 erlebt:

- **Drei Suchen, drei Tabs** — Preisvergleiche für mehrere Artikel liefen
  nacheinander im selben Tab, das Ergebnis stand nur im Gespräch, nicht im
  Browser.
- **„Lass den Tab stehen"** — der Warenkorb-Tab musste aufgegeben werden, sobald
  etwas anderes geöffnet wurde; die Seite blieb bei Douglas gespeichert, die
  Ansicht nicht.

Spec 16 (Zeile 08a) hat das verschoben: `browser_open_tab`/`browser_close_tab`,
ein optionaler `tab`-Parameter an allen Werkzeugen, höchstens fünf Agenten-Tabs.
Der Beleg steht in `## Testing` von `docs/16`.

### Parallelität und Portbesitz (belegt am 2026-10-23, erledigt durch Spec 18)

Der Betreiber arbeitet mit **mehreren pi-Sitzungen gleichzeitig** (eine im
tmux-Fenster `nektar` unter `~/nektar`, eine im Projekt). Solange die Bridge ein
Kindprozess von pi war und MCP über dessen stdio sprach, gehörte sie per
Definition dem Prozess, der sie gestartet hat. Daraus zwei Fehlerbilder, beide
am 2026-10-23 gesehen:

| Fall | Was passierte | Wie es aussah |
|---|---|---|
| **Zweite Sitzung startet** | Sie spawnnte ihre Bridge, die mit `EADDRINUSE` auf `127.0.0.1:8110` endete (Exit 1). Die Sitzung hatte danach **kein** `browser-control`. | `searchTools('browser')` fand nur noch fremde Werkzeuge; die Bridge der *ersten* Sitzung lief weiter. |
| **Neustart bei laufender alter Sitzung** | Die alte Bridge überlebte als Kind der alten Sitzung und hielt den Port weiter. Die neue Sitzung startete ihre Bridge — „port belegt" — und stand still ohne Werkzeuge da. | `ps` zeigte zwei `pi`: 20 h alt auf `pts/4`, 42 s alt in dieser Sitzung; Port 8110 gehörte der alten. |

Spec 18 (Zeilen 19 und 20) hat das erledigt: die Bridge läuft als
systemd-**User-Unit** und besitzt den Port, pi verbindet sich als MCP-Client über
streamable HTTP auf 127.0.0.1:8111 mit Bearer-Token. Ein belegter Port nennt
seinen Besitzer mit PID und Namen. **Live belegt** am 2026-10-23: nach einem
pi-Neustart ist genau ein `bridge.mjs` übrig, Elternprozess systemd; drei
gleichzeitige Clients werden beantwortet.

## Regeln, die für jede Zeile gelten

- Eine Spec, ein Inkrement; keine Zeile wird „nebenbei" mitgebaut.
- Keine neuen Berechtigungen ohne Betreiberentscheidung. Die `<all_urls>`-Frage
  ist entschieden; alles Weitere — etwa `cookies`,
  `contextualIdentities` — wäre neu.
- Jede Zeile braucht mindestens ein Kriterium, das ohne den Betreiber
  entscheidbar ist, und höchstens einen Handgriff für ihn (Extension-Reload,
  pi-Neustart).
- Was hier steht, ist eine Absicht, keine Zusage; die Reihenfolge darf der
  Betreiber jederzeit umwerfen.
