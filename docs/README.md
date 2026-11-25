# Docs — Spezifikationen für browser-control

Dieses Projekt wird **spec-getrieben** weitergeführt: die Spezifikation beschreibt
das gewollte Verhalten, der Code setzt sie um, die Prüfläufe belegen beides.
Der Ablauf steht in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Platzhalter in den Messungen

Die Specs dokumentieren Messungen an echten Videos. **Video-IDs und
Kanalnamen sind durch Platzhalter ersetzt** (`<video-en>`, `<video-en-2>`,
`<video-ja>`, `<video-ja-2>`, `<video-1>`); die konkreten IDs gehören nicht zur
Veröffentlichung. Was zählt, steht daneben: welche Sprache das Original hat und
was gemessen wurde.

## Format

- Dateiname `NN-kurzbeschreibung.md`, `NN` = Reihenfolge der Entstehung,
  eindeutig, zweistellig. Kleinbuchstaben, Bindestriche, keine Umlaute.
- Markdown mit YAML-Frontmatter; Pflichtfelder:
  - `description`: ein Satz, der den Inhalt zusammenfasst (damit man Specs ohne
    Öffnen scannen kann),
  - `status`: `proposed` | `active` | `superseded`. Bei `superseded` optional
    `replacement: <datei.md>` oder eine Liste davon.
- Fehlt das Frontmatter, gilt das Dokument als `proposed`.
- **Ausnahme:** `00-project-overview.md` hat kein Frontmatter. Es ist die
  Leitseite (Ziel, Nicht-Ziele, Landkarte) und erzeugt keinen Code.
  `PROJECT-STATE.md` ist ebenfalls kein Spec-Dokument.

## Pflicht- und Empfehlungsabschnitte

- **`## Testing` (Pflicht):** was die Tests abdecken müssen — Datei und Fall,
  jeweils mit dem, was der Fall beweist.
- **`## Acceptance criteria` (Pflicht):** prüfbare Kriterien, jedes mit dem
  Kommando oder Logzeilen-Beleg, der es entscheidet. „Schnell", „sauber" oder
  „besser" sind keine Kriterien.
- **`## Dev plan` (Pflicht für `proposed`):** Stufen in Bau-Reihenfolge, jede mit
  Dateien/Funktionen und dem Beweis, dass sie funktioniert. Keine Stufe darf von
  einer späteren abhängen.
- **`## Bekannte Lücken` (empfohlen):** Abweichungen zwischen Spec-Absicht und
  Code, jeweils mit Datum. Das ersetzt keine Arbeit, es macht sie sichtbar.
- **`## Open questions`:** offene Entscheidungen. Solange eine Frage offen ist,
  kann die Spec nicht `active` werden — nur der Betreiber beantwortet sie.
- **`## Additional dependencies` / `## Dependency changes`:** Pflicht, sobald
  eine Spec eine Abhängigkeit einführt, ändert oder entfernt — mit exakter
  Version und Lizenz.
- **`## Amendments to previous spec docs`:** nur in einer Spec, die eine andere
  ablöst; nach der Umsetzung wird der Abschnitt entfernt.
- **`## Review` und `## Log`:** gehören zu jedem `proposed`-Dokument. `## Review`
  sammelt die Runden des Spec-Reviews (Datum, Verdict, ob ein Blocker dabei war),
  `## Log` die Entscheidung je Befund (übernommen, oder nicht übernommen und
  warum) aus Spec- und Code-Review.

## Recherche-Specs

Eine **Recherche-Spec** erzeugt **keinen Produktcode**. Ihr Ertrag ist eine
Messung und eine Entscheidung; sie beschreibt Verhalten, das es **noch nicht
gibt** — das ist bei ihr erlaubt und sonst nicht. Die erste ist
`31-youtube-recherche.md` (2026-11-11).

- **`## Testing`** trägt bei ihr **keine** Testfälle, sondern das
  **Messprotokoll**: welche Beobachtung mit welchem Werkzeug wie wiederholt
  wird. Kriterien prüfen ein Dokument, nicht ein Verhalten.
- **`## Acceptance criteria`** müssen je einen Befehl nennen, der eine
  eindeutige Antwort liefert. Ein Kriterium, das sich selbst zitiert oder
  dessen Zähler durch eigene Beispiele im Text verfälscht wird, ist nicht
  abnahmefähig — der Schnitt des Befehls (`sed -n '/^## …/,/^## …/p'`) gehört
  dazu.
- **`## Dev plan`** besteht aus Stufen an Dokumenten; die letzte Stufe setzt
  `status: active` und committet.
- Die **Absprache** nach `CONTRIBUTING.md` Schritt 2 umfasst bei ihr Ziel **und**
  Kriterien — beides ist Abnahmeobjekt.
- Eine Recherche-Spec **darf** eine Folge-Spec benennen, aber **nicht**
  beschreiben: die benannte Spec entscheidet ihren Zuschnitt selbst.

## Änderungen an bestehenden Specs

- **Direkt ändern:** Spec von `active` auf `proposed` zurückstellen, Verhalten
  anpassen, bei Bedarf Stufen im `## Dev plan` ergänzen (mit Datum und dem
  Hinweis, dass sie nach der ersten Umsetzung entstanden sind). Die letzte Stufe
  stellt die Spec wieder auf `active`.
- **Über eine neue Spec:** die neue Spec bekommt
  `## Amendments to previous spec docs` und einen `## Dev plan`. Nach der
  Umsetzung wird der Amendments-Abschnitt entfernt.
- **Reihenfolge:** keine Spec beschreibt Verhalten, das es noch nicht gibt. Eine
  geänderte Spec wird in **der** Stufe nachgezogen, die das Verhalten umsetzt.
- Jede Verhaltensänderung braucht Tests. Alter Code ohne Tests: Tests nachziehen.

## Übersicht

| Datei | Inhalt | Status |
|---|---|---|
| `PROJECT-STATE.md` | Stand des Projekts: was im Code existiert, was offen ist, was gemessen wurde | — (kein Spec) |
| `ROADMAP.md` | Was als Nächstes kommt, in Reihenfolge, mit Größe und Begründung; keine Spec | — (kein Spec) |
| `01-skelett-verbindung-und-status.md` | Erstes Inkrement: Extension wählt sich per WSS zum Server, Bridge prüft Token, fragt `status` ab und loggt Fenster/Tabs; noch kein MCP | `active` |
| `02-persistenter-background.md` | Die Verbindung hält: Background der Extension auf MV2 mit `persistent: true`, weil Firefox die MV3-Eventpage nach 30 s Leerlauf entlädt | `active` |
| `03-mcp-browser-status.md` | Die Bridge spricht MCP über stdio; ein Tool `browser_status` gibt Fenster und Tabs zurück, stdout gehört dem Protokoll | `active` |
| `04-agenten-tab-und-navigate.md` | `browser_navigate` öffnet eine http(s)-URL im Agenten-Tab des Betreibers, wartet auf das Laden und meldet Tab-Id, URL, Titel und `complete` | `active` (drei Restlöcher offen, siehe Spec) |
| `05-seiteninhalt-lesen.md` | `browser_read` liefert Titel, Adresse und Text des Agenten-Tabs (sichtbarer Text, sonst Textinhalt, mit `via`); dafür `<all_urls>` als Berechtigung (Betreiberentscheidung) | `active` |
| `06-klicken.md` | `browser_click` klickt ein Element per CSS-Selektor im Agenten-Tab und liefert den Seitentext danach; Tippen bleibt draußen | `active` |
| `07-tippen.md` | `browser_type` schreibt Text in ein Feld, kann mit Enter absenden und liefert den Seitenzustand danach; Passwortfelder sind per Option gesperrt (Default) | `active` |
| `08-fokus.md` | `browser_focus` holt den Agenten-Tab nach vorn und sein Fenster in den Vordergrund, ohne die Seite zu verändern | `active` |
| `09-dom-abfrage.md` | `browser_inspect` listet Elemente per Selektor oder Textsuche auf, mit Attributen und einem fertigen Selektor zum Weiterverwenden; read-only | `active` |
| `10-nicht-lesbar-mit-typ.md` | `not_readable` nennt Art (`internal`/`pdf`/`file`/`unknown`) und Adresse, damit der Agent den Link weiterreichen kann | `active` |
| `11-content-type-per-head.md` | `not_readable` bekommt zusätzlich den echten Content-Type per HEAD-Anfrage (1,5 s Frist, nur bei 2xx); zweiter Teil von Spec 10 | `active` |
| `12-status-und-fokus-sagen-die-wahrheit.md` | `browser_status` markiert den Agenten-Tab (`agent: true`), `browser_focus` liest `focused` nach dem Fokussieren nach — zwei Lügen weniger | `active` |
| `13-page-busy.md` | `not_readable` wird ehrlich: lädt die Seite noch, antwortet der Fehler `page_busy` statt „nicht lesbar", damit der Agent es erneut versucht | `active` |
| `14-ruhe-statt-300ms.md` | `read` wartet bis zur DOM-Ruhe (250 ms still, höchstens 3 s) statt gar nicht, und meldet `settled`/`waitedMs` | `active` |
| `15-ruhe-fuer-click-und-navigate.md` | `click` und `navigate` warten nach dem Auslösen bis zur Ruhe; `click` behält die alten 300 ms als Rückfall, beide sind abbrechbar | `active` |
| `16-mehrere-agenten-tabs.md` | `browser_open_tab`/`browser_close_tab`, `tab`-Parameter an allen Werkzeugen, Obergrenze 5 — mehrere Suchen nebeneinander; der Slot bleibt global | `active` |
| `17-slot-je-tab.md` | Der Warte-Slot für `click`/`type` gilt je Tab statt global, mit einem Live-Kriterium für die Nebenläufigkeit | `active` |
| `18-dienst-und-http-mcp.md` | Die Bridge wird ein systemd-Dienst und bietet MCP über streamable HTTP auf 127.0.0.1 mit Bearer-Token — jeder MCP-Client teilt sich einen Dienst; feste Ports, keine Suche | `active` |
| `19-browser-eval.md` | `browser_eval` wertet Code im Seitenkontext des Agenten-Tabs aus (Ergebnis als JSON) und darf die Seite ändern — nur mit dem Options-Schalter „Code-Auswertung erlauben" (Default aus) | `active` |
| `20-screenshot-teil-1.md` | `browser_screenshot` fotografiert den sichtbaren Ausschnitt im Agenten-Tab und liefert PNG-Base64 mit Größen- und Formatgrenze — Teil 1 von zwei, ohne MCP-Bildinhalt | `active` |
| `21-screenshot-teil-2.md` | `browser_screenshot` (Teil 2) liefert das Bild als MCP-Bildblock (`type: "image"`) mit den Metadaten als Textblock; Bildgrenze 3 MiB, Socket 5 MiB, Aufruffrist 20 s | `active` |
| `22-read-ausschnitte.md` | `browser_read` bekommt `offset` und `maxChars` (Default 20 000, Deckel 100 000); die Antwort nennt `offset`, `chars`, `totalChars` — Blättern statt 20 000er-Wand | `active` |
| `23-artikel-extraktion.md` | `browser_read` bekommt `mode: "article"`: semantische Wurzel oder Dichte-Heuristik, Bereinigung auf einer Kopie, ehrlicher Rückfall (`root`/`fellBack`) | `active` |
| `24-frames.md` | `browser_frames` als zwölftes Werkzeug und `frame` für `read` (URL-Teilstring) — Lesen und Handeln in iframes | `active` |
| `25-frame-handeln.md` | `frame` für `inspect` und `eval` — zweiter Teil von Spec 24 | `active` |
| `26-frame-click-type.md` | `frame` für `click`/`type` und die Ruhe-Erkennung nach einem Klick im adressierten Rahmen — dritter Teil der Frame-Reihe | `active` |
| `27-shadow-dom.md` | `>>>` in `browser_inspect` durchdringt offene Schattenbäume (Piercing-Selektor) | `active` |
| `28-log-hygiene.md` | Whitelist statt Sperrliste für den Debug-Block auf stderr | `active` |
| `29-windows-betrieb.md` | `npm run check` prüft die Syntax mit einem Node-Skript statt mit `find`/`xargs` — die Abnahme läuft damit auch dort, wo keine GNU-Werkzeuge installiert sind; Teil 1a der Windows-Reihe | `active` |
| `30-prozess-und-konsole.md` | Der Bridge-Prozess läuft auf Windows ohne systemd und ohne `/proc`, startet aus einer Konsole und endet dort geordnet; Teil 1b, setzt 29 voraus. **`active`:** `Strg+Untbr` und das stille stdout im Terminal sind gebaut (`bridge-rs/src/main.rs`, `stdio.rs`); der Windows-Lauf bleibt Betreiber-Messung | `active` |
| `31-youtube-recherche.md` | Recherche zu Roadmap-Zeile 17: was der Agent von einem YouTube-Video heute bekommt (Transkript, Zeitbezug, Bild), welche Wege tragen und welche nicht; mit den Entscheidungen Q1–Q5 und der benannten Folge-Spec `browser_transcript` | `active` |
| `32-transkript-werkzeug.md` | Das dreizehnte Werkzeug `browser_transcript`, Teil 1: liest das YouTube-Transkript als Segmente mit Zeitstempeln, mit `offset`/`maxChars` wie `read`; öffnet das Panel selbst und wartet auf dessen Bereitschaft | `active` |
| `33-spurwahl.md` | `browser_transcript`, Teil 2: die Sprachspur aus der **Spurendatei** — Originalspur über den Original-Audiotrack, die en/de-Regel des Betreibers, Wahl im Untertitel-Menü nach dem Namen aus dem Modell, Lesen der signierten `api/timedtext`-Adresse, danach Spur und Abspielposition zurückstellen. **`active`:** live abgenommen am 2026-11-12 (englisch und japanisch) | `active` |
| `34-spurendatei-beobachten.md` | Teil 2b von `browser_transcript`: die signierte `api/timedtext`-Adresse nicht aus `performance` lesen (live blind, `docs/33`, M18), sondern selbst mitschneiden — `webRequest`-Berechtigung, aufgenommen je Tab (gedeckelt), gelesen nur der Agenten-Tab, nur youtube.com, Adresse bleibt in der Extension. **`active`:** beide Live-Kriterien am 2026-11-12 grün | `active` |
| `35-installationsskript.md` | Ein Installationsskript für die Server-Seite: Token, systemd-Unit, Dienststart und Prüfung in einem Befehl — idempotent, ohne Firefox-Automatisierung, ohne `sudo`; die vier Schritte in der Extension bleiben Handarbeit | `active` |
| `36-standard-endpunkt.md` | Ein Standard-Endpunkt für die Extension: ein leeres Feld verbindet nach `ws://127.0.0.1:8110` (die Vorgabe der Bridge), sichtbar vorbelegt und änderbar; gespeicherte Endpunkte bleiben unberührt, keine Discovery. **`active`** seit 2026-11-15 | `active` |
| `37-rust-bridge.md` | Die Rust-Bridge, **Teil 1**: Werkzeugkette, ein baubares Gerüst für Linux und Windows und der **Paritätsmaßstab** — sieben Vergleiche gegen eingecheckte Soll-Artefakte, Selbsttest 7/7, bevor eine Zeile portiert wird. Geteilt nach dem dritten Block des Spec-Gates | `active` |
| `38-rust-port.md` | Die Rust-Bridge, **Teil 2**: die Module (Konstanten, Config, WebSocket, Hub, Werkzeuge, HTTP, stdio) gegen den Maßstab aus Teil 1, dann Windows, Installer und der Schnitt — die Node-Bridge ist gelöscht, die sieben Artefakte sind eingefroren, Voraussetzung war `docs/37` | `active` |
| `39-portables-paket.md` | Portables Zip je Plattform: Server-Binary, unsignierte XPI und zwei Anleitungen (Firefox, MCP-Clients) in Englisch nach STE100 — entpacken, `start.sh`, fertig; Token entsteht im Ordner, nichts wird installiert | `active` |
| `40-ci-ablauf.md` | Zwei Prüfungen statt einer: Unit-Tests ohne Browser bei jedem Push, dazu ein Blackbox-Workflow auf Windows — Firefox starten, XPI installieren, über MCP eine Seite öffnen, Beweis ist der Beacon der Seite selbst; dann Zip-Bau und Release | `active` |
| `41-anleitungen.md` | Die zwei Nutzertexte im portablen Zip — `FIREFOX.md` (XPI laden, Endpunkt und Token, Warnung vor der Temporär-Eigenschaft) und `CLIENTS.md` (pi, Codex, OpenCode plus generisches Muster); Englisch nach STE100 als Schreibregel, ohne Lint | `active` |
| `42-socket-im-tab.md` | Der Socket zieht aus dem Hintergrund in einen eigenen Tab (Roadmap 26) — die Voraussetzung für MV3; mit dem Umbau der Injection-Naht (`scripting` kennt kein `code`) und dem Ende des Wartens über zwei Kontexte | `proposed` |
| `43-manifest-mv3.md` | Das Manifest auf MV3 (Roadmap 27+28): `scripting`, `host_permissions`, `docs/02` bewusst umgestellt — gebaut und im Browser belegt; die 8-h-Messung (Kriterium 7) bleibt auf Betreiberentscheid offen | `active` |
| `44-schalter.md` | Der Schalter in der Symbolleiste: drei Icons (Brücke, gelber Blitz, überkreuzt), Vorgabe aus, `goodbye` an die Bridge vor dem Schließen (Roadmap 32) | `proposed` |
| `45-injection-naht.md` | Die Injection-Naht (abgespalten von `docs/42`): Quelltext raus, `page-agent.js` plus `callId`-Nachrichten; die Frame-Inventur entsteht aus Selbstmeldungen, mit Frist und definiertem Verhalten für stumme und abgelehnte Frames | `active` |
| `46-signierung.md` | Die Signierung (AMO, `unlisted`): Daten-Erklärung im Manifest, Reichweiten-Tabelle für `<all_urls>` und `scripting`, Schlüssel außerhalb des Repos — damit die XPI per Doppelklick installiert und behalten wird | `proposed` |
| `47-func-runner-im-harness.md` | Der Harness kann einen `func` in zwei Welten je Frame ausführen, der Schlüssel-Pin wird zur Vereinigung — nur `test/extension.test.js`, kein Produktivcode | `active` |
| `48-eval-in-der-seitenwelt.md` | `browser_eval` läuft in der Seitenwelt (`world: "MAIN"`): gemessen, dass der Parameter trägt; dazu die CSP-Meldung der Seite und der ehrliche Hinweis, dass `allowEval` jetzt auch Seitenvariablen erlaubt | `active` |
| `49-func-vertrag-und-umzug.md` | Der Vertrag des `func` (`args: [code, limits, want]`, Felder je `outcome`, ein Serialisierer, DOM-Formen) und der Umzug der 23 Kanal-Fälle in einem Schritt | `active` |
| `50-await-in-eval.md` | `await` auf oberster Ebene im `eval`-Code: der `func` baut den Rumpf als async-Funktion — kleine Änderung an `docs/19`, am 2026-11-19 zweimal gestolpert | `active` |
| `51-schattenwurzeln.md` | Geschlossene Shadow Roots erreichbar machen (`attachShadow` bei `document_start` in der Seitenwelt), hinter einem Schalter, Default aus — mit drei Pflicht-Messungen vor dem Bau | `withdrawn` |
| `52-amo-einreichung.md` | Die Texte für die AMO-Einreichung: Beschreibung, Begründung der Berechtigungen, der Absatz zu `eval` für die Reviewer und Plan B ohne den Schalter | `proposed` |
| `53-browser-help.md` | Ein vierzehntes Werkzeug `browser_help` liefert die ausführliche Anleitung eines Werkzeugs samt Beispiel — hinter einem Aufruf, damit `tools/list` kurz bleibt | `active` |
| `54-refusals-englisch.md` | Alle Meldungen, die der Agent liest, sind englisch: 51 Texte in `texts.rs`, 13 Argument-Refusals und 14 Werkzeugbeschreibungen in `tools.rs`, die Meldungen in `bridge.js`, drei Fixtures — mit einem Umlaut-Wächter als maschinellem Beweis; gebaut; Review-Runde 3 teilte den Zitat-Rest nach `docs/55` | `active` |
| `55-alte-zitate-in-specs.md` | Die aktiven Specs zitierten die alten deutschen Werkzeugsätze: 73 Inventarzeilen in 27 Dateien, 38 Vertragsstellen nachgezogen, 21 Belege mit Datum markiert, 14 Ausschlüsse | `active` |
| `56-klick-sagt-die-wahrheit.md` | `browser_click` sagt, was geschah: ein Ziel außerhalb des Sichtfelds wird herangescrollt und neu gemessen (`scrolled` direkt hinter `clicked`), sonst `offscreen_after_scroll` — **Teil a**: die Lage. **`active`:** Stufen 1–3 gebaut (`e251790`), Doku nachgezogen | `active` |
| `57-inspect-engster-treffer.md` | `browser_inspect` liefert bei einer **Textsuche** den engsten Treffer statt der Containerseite (`div#a-page`) und zählt ihn in `count`; `selector` allein und `includeHidden` bleiben roh — **Teil a**: die Regel. **`active`:** Stufen 1–2 gebaut (`53528ba`), Doku nachgezogen | `active` |
| `58-klick-nach-text.md` | `browser_click` nimmt `contains_text` allein oder zusammen mit `selector` (einschränkend), bevorzugt einen exakten Treffer und lehnt bei Mehrdeutigkeit mit `text_ambiguous`, Kandidaten und einem Rat ab — **Teil a**: Erweiterung und Harness. **`active`:** Stufen 1–3 gebaut (`2320e2a`), Doku nachgezogen | `active` |
| `59-argumentnamen.md` | Zwei Namen für zwei Bedeutungen: `browser_inspect` und `browser_click` suchen mit `contains_text`, `browser_type` schreibt mit `typed_text` — ohne Alias. **`active`:** Stufen 0 und 1 gebaut (`be7846c`), Doku nachgezogen | `active` |
| `60-klick-nach-text-mcp.md` | **Teil b** des Textklicks: `contains_text` im Schema, die Leitung bleibt `text`, `CLICK_NEEDS_FILTER` vor dem Draht, `text_ambiguous` und `no_match` als englische Sätze, zwei eingefrorene Fixtures. **`active`:** Stufen 0–2 gebaut (`e798e4d`), Doku nachgezogen | `active` |
| `61-klick-seite-danach.md` | **Teil b** von `docs/56`: ein Klick, der auf einer nicht lesbaren Seite landet, antwortet `not_readable_after_click` statt `not_readable` — Satz mit Rückweg `browser_navigate`, `read` bleibt unberührt. **`active`:** Stufen 1–2 gebaut (`a78e2fc`), Doku nachgezogen | `active` |
| `62-inspect-offscreen.md` | **Teil b** von `docs/57`: jedes Element aus `browser_inspect` trägt `offscreen`, in beiden Quellen; flächenlose Elemente bleiben `false`. **`active`:** Stufen 1–2 gebaut (`6b24115`), Doku nachgezogen | `active` |
| `63-klick-ohne-antwort.md` | Ein Klick, dessen Anfrage keine Antwort bekommt, antwortet `click_outcome_unknown` statt `not_readable` — der Satz sagt, dass er durchgegangen sein kann, und der Agent prüft die Seite vor dem nächsten Klick. **`active`:** Stufen 1–3 gebaut (`6683373`), Doku nachgezogen | `active` |
| `64-testabdeckung.md` | Ein Befehl `npm run test:coverage` misst die Zeilenabdeckung der Erweiterung aus den V8-Rohdaten des Testlaufs, druckt eine Tabelle je Datei und bricht unter 90 % ab — ohne neue Abhängigkeit. **`active`:** Stufen 1–3 gebaut (`9355474`), Doku nachgezogen | `active` |
| `65-coverage-in-der-ci.md` | Die Zeilenabdeckung aus `docs/64` läuft als eigener, unabhängiger Job `coverage` in der CI; Schwelle 90 %, kein `needs:`. **`active`:** Stufen 1–3 gebaut (`0ab43ff`), Doku nachgezogen | `active` |
| `66-rust-abdeckung.md` | `npm run test:coverage:rust` misst die Zeilenabdeckung der Bridge über `cargo-llvm-cov`, druckt die Übersicht je Modul und bricht unter 90 % ab; kein CI-Job. **`active`:** Stufen 1–3 gebaut (`fe2cb7e`), Doku nachgezogen | `active` |

Meta-Datei dieses Ordners (`README.md`) trägt bewusst kein Frontmatter: sie ist
Verfahren, keine Spec.
