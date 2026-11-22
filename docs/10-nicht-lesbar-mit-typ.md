---
description: Wenn die Extension eine Seite nicht lesen kann, nennt die Fehlerantwort Art und Adresse — interner Browserdialog, PDF, Datei, sonst unbekannt — damit der Agent den Link weiterreichen kann statt in einer Sackgasse zu stehen.
status: active
---

# Nicht lesbar, und jetzt? `not_readable` bekommt Typ und Link

Zweimal in einer Sitzung (2026-10-23) stand der Agent vor derselben Wand: Die
Preisliste war ein **JPEG**, die AGB ein **PDF**, und `browser_read` antwortete
„Diese Seite kann die Extension nicht lesen (interne Seite oder Sonderformat)." (so die Antwort damals; englisch seit `docs/54`)
Der Agent wusste danach **nicht**, ob er es mit einer internen Seite zu tun hat,
mit einem PDF, mit einem Bild — oder ob die Seite einfach nur kaputt geladen war.

Dieses Inkrement macht aus der Sackgasse eine Auskunft: **welche Art** von Seite
es ist und **welche Adresse** sie hat.

**Zuschnitt nach der dritten Review-Runde (2026-10-23):** Der `Content-Type` per
HEAD-Anfrage ist ein eigenes Inkrement geworden — `docs/11-content-type-per-head.md`.
Er hängt an diesem hier und baut darauf auf.

## Ziel

Jede Fehlerantwort mit `code: "not_readable"` trägt zwei zusätzliche Felder:

```json
{"ok": false,
 "error": {"code": "not_readable",
           "message": "Die Seite gibt keinen lesbaren Inhalt her.",
           "url": "https://example.org/preisliste.pdf",
           "kind": "pdf"}}
```

- **`url`** — die Adresse des Agenten-Tabs zum Zeitpunkt des Fehlers, aus
  `tabs.get`, **auf 2 048 Zeichen gekürzt** (dieselbe Grenze wie in Spec 05).
  Ohne Deckel könnte eine `data:`-Adresse den Antwortrahmen über die 1-MiB-Grenze
  von `bridge/websocket.mjs` treiben — dann fliegt `MESSAGE_TOO_BIG` und der Agent
  sieht keinen Fehler, sondern einen Verbindungsabbruch. **Gekürzt wird erst beim
  Ablegen in `details`**: `kindFromUrl` sieht die **volle** Adresse, sonst würde
  ein langer Pfad, der auf `.pdf` endet, zu `kind: "unknown"`. `null`, wenn
  `tabs.get` scheitert oder keine Adresse liefert.
- **`kind`** — aus der Adresse abgeleitet, **kein** Inhaltsbeweis:
  - `"internal"` — Schema `about:`, `moz-extension:`, `chrome:`, `edge:`, `view-source:`
  - `"pdf"` — Pfad endet auf `.pdf` (Groß-/Klein egal, auch mit `?query` oder `#fragment`)
  - `"file"` — Schema `file:`
  - `"unknown"` — alles andere, auch wenn `tabs.get` keine Adresse liefert

  Das Feld heißt bewusst nicht `fileType`: es sagt, was die Adresse verrät, nicht
  was der Server liefert. `/download?id=7` bleibt `unknown` — eine Extension, die
  den Inhalt liest, ist Spec 11.

Der Fehler entsteht an **einer** Stelle (`injectPageCode`), also gilt die
Anreicherung für `read`, `click`, `type` und `inspect` gleichermaßen. Sie ist
**best effort und wirft nie**: Scheitert `tabs.get`, bleiben die Felder `null`
bzw. `unknown`, und die Fehlermeldung ist dieselbe wie heute.

## Non-goals

- **Keine Netzwerkanfrage.** Kein `fetch`, kein HEAD, kein `Content-Type`. Das ist
  Spec 11.
- **Kein Herunterladen und kein Auslesen** von PDFs oder Bildern.
- **Keine neue Berechtigung**, keine Änderung an `manifest.json`.
- **Keine Änderung an erfolgreichen Antworten.** Nur der Fehlerpfad wächst.

## Wire-Protokoll

Die Fehlerform `{code, message}` bleibt; die zwei Felder sind **optional** und
stehen nur bei `not_readable`:

```json
{"type":"response","id":7,
 "ok":false,
 "error":{"code":"not_readable","message":"…","url":"…","kind":"pdf"}}
```

- Die Felder erscheinen **immer** bei `not_readable` (mit `null`/`"unknown"`, wo
  nichts bekannt ist), damit ein Aufrufer nicht raten muss.
- Andere Codes (`no_agent_tab`, `read_failed`, `invalid_selector`, …) bleiben
  unverändert und tragen **keine** der beiden Felder.

## MCP-Werkzeug

| Fall | Satz |
|---|---|
| `kind: "pdf"`, `url` | „The extension cannot read this page (kind: pdf). Address: <url>" |
| `kind: "internal"`, `url` | „… (Typ: internal). Adresse: …" |
| `kind: "unknown"`, `url` | „The extension cannot read this page. Address: <url>" — kein Typ, weil keiner bekannt ist |
| alles `null`/`unknown` ohne `url` | unverändert: „The extension cannot read this page (internal page or special format)." |

`<kind>` steht klein und wörtlich da (`internal`, `pdf`, `file`, `unknown`).
`isError: true` bleibt, `content` bleibt ein Textblock. Ein unbekannter
`kind`-Wert von der Extension wird ignoriert (Whitelist), damit kein fremder
String in den Satz gerät.

## Hub

**Der Hub muss die Felder durchlassen — er verwirft sie heute.** `#handleResponse`
baut `new HubRequestError(EXTENSION_ERROR, …, { code })`, und `HubRequestError`
nimmt nur `{ code }`; `url` und `kind` kämen in `bridge/mcp.mjs` also nie an.
Nötig sind **drei** Zeilen: `details` im Konstruktor aufnehmen, `this.details`
setzen und `message.error` durchreichen.

**Sonst keine strukturelle Änderung, keine neue Logzeile.** Die Felder werden
**nicht geloggt**, und das ist eine Entscheidung: `url` kann eine Query mit
Zugangsdaten tragen (dieselbe Regel wie in Spec 05, wo die `url` der Leseantwort
ihre Query behält). Im Erfolgsfall steht die `url` bei `read` in der Logzeile — im
`not_readable`-Pfad gibt es diese Zeile nicht, also entsteht durch dieses
Inkrement **keine** neue Logzeile mit Adresse. Die Logzeile
`… failed peer=… code=…` bleibt wörtlich, wie sie ist.

## Extension

- `kindFromUrl(url)` — reine Funktion, kein Netz, mit der **vollen** Adresse
  aufgerufen; testbar ohne Stub.
- ~~`async notReadableError(tabId)` — holt die Adresse per `tabs.get`, leitet `kind`
  ab, kürzt für `details` auf 2 048 Zeichen und gibt eine `ReadError`-Instanz
  zurück. Wirft nie.~~ **Abgelöst am 2026-10-23 durch Spec 13**: die Funktion heißt
  `notReadableErrorForTab(tab)`, ist synchron und bekommt den Tab statt der Id.
- `class ReadError` bekommt einen optionalen **dritten** Parameter `details`
  (Default `{}`). Ein Helfer `readErrorFrame(error)` baut
  `{ code, message, ...error.details }` und ersetzt die vier
  `instanceof ReadError`-Zeilen in `readErrorFor`, `clickErrorFor`,
  `typeErrorFor` und `inspectErrorFor`. Damit ist „die Felder gibt es nur bei
  `not_readable`" **konstruktiv** garantiert: `details` setzt allein
  `notReadableError`, immer mit beiden Schlüsseln.
- ~~`injectPageCode`-`catch`: **`throw await notReadableError(tabId)`** — ohne
  `await` würde ein Promise geworfen, `instanceof ReadError` wäre `false` und der
  Code kippte auf `read_failed`.~~ **Abgelöst am 2026-10-23 durch Spec 13**: der
  `catch` entscheidet zuerst (`no_agent_tab`, `page_busy`) und wirft nur im dritten
  Fall `notReadableErrorForTab(tab)`.
- Kein `console.warn` im Fehlerpfad.

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `test/extension.test.js` — `kindFromUrl` für `about:blank`, `about:config`, `moz-extension://…`, `chrome://…`, `view-source:…` | `internal` |
| dito — `…/preisliste.pdf`, `…/AGB.PDF`, `…/x.pdf?token=1`, `…/x.pdf#page=2` | `pdf` (Suffix, Groß/Klein, Query, Fragment) |
| dito — `file:///tmp/a.pdf` | `file` (Schema schlägt Suffix) |
| dito — `https://example.org/seite`, `https://example.org/bild.jpg` | `unknown` — ein Bildsuffix ist **kein** Beweis |
| dito — `null`/leerer String | `unknown` |
| `test/extension.test.js` — `read` auf `about:config` | `not_readable` mit `kind: "internal"`, `url` gesetzt |
| dito — `read` auf einer PDF-Adresse | `not_readable` mit `kind: "pdf"` und `url` |
| ~~dito — `tabs.get` wirft **ab dem zweiten Aufruf** (der erste gehört `findDefaultContainerTab`)~~ | ~~`url: null`, `kind: "unknown"`, kein Wurf nach außen~~ **Abgelöst durch Spec 13**: ein fehlender Tab ist dort `no_agent_tab` |
| dito — `tabs.get` liefert keine `url` | `url: null`, `kind: "unknown"` |
| dito — Adresse **über** 2 048 Zeichen, die auf `.pdf` endet | `kind: "pdf"` (Ableitung sieht die volle Adresse), `url` gekürzt |
| dito — `click`, `type`, `inspect` auf unlesbarer Seite | alle drei tragen `url` und `kind` |
| dito — `no_agent_tab` und `read_failed` | Fehlerobjekt hat **keine** der beiden Felder |
| `test/hub.test.js` — Antwort mit `ok:false` und Fehlerdetails | `HubRequestError` trägt `details`, und die Logzeile bleibt wörtlich, wie sie war |
| `test/mcp.test.js` — `kind: "pdf"` und `url` | Satz nennt Typ und Adresse |
| dito — `kind: "unknown"` mit `url` | Satz nennt die Adresse, aber **keinen** Typ |
| dito — `kind: "quatsch"` (nicht in der Whitelist) mit `url` | Satz ignoriert den Typ, nennt aber die Adresse |
| dito — **dieselben Formen über `browser_inspect`** | der zweite Mapper (`inspectFailureTextFor`) baut denselben Satz |
| dito — `not_readable` ohne Details | der heutige Satz, unverändert |

## Acceptance criteria

1. `npm test; echo $?` → `0`, Ausgabe enthält `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. Alle 281 bisherigen Fälle laufen unverändert — das ist
   **am Diff** zu prüfen (`git diff -- test/` enthält in bestehenden Fällen nur
   `+`-Zeilen und keine geänderten Erwartungen), nicht an der Gesamtzahl.
2. Im `vm`-Sandkasten liefert `read` auf einer unlesbaren Seite `not_readable` mit
   `url` und `kind`; die Fälle der `## Testing`-Tabelle für die Ableitung laufen.
3. `about:config` ergibt `kind: "internal"` — und **keine** Netzwerkanfrage
   (in diesem Inkrement gibt es keine; der Fall hält fest, dass auch später keine
   entsteht).
4. `…/bild.jpg` ergibt `kind: "unknown"` — die Endung ist kein Beweis.
5. Die MCP-Sätze aus `## MCP-Werkzeug` sind im `test/mcp.test.js` gepinnt, der
   heutige Satz ohne Details bleibt wörtlich.

**Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Acceptance`): Der **Live-Beleg**
(Extension in `about:debugging` neu laden, pi neu starten, `browser_read` auf einer
PDF-Adresse) ist erst nach den Handgriffen möglich, und der Betreiber lädt die
Erweiterung aus seinem eigenen Klon — also nach dem `git pull`. Kriterien 1–5
laufen vor dem Commit, der Live-Beleg danach; fällt er rot aus, wird vorwärts
korrigiert und die rote Zeile steht mit Datum unter `## Bekannte Lücken`. Ist die
**Kernannahme** widerlegt (der Agent bekommt weder `kind` noch `url`), geht das
Inkrement zurück in diese Spec.

## Messlauf (2026-10-23)

Der Live-Beleg aus Kriterium 5, im echten Browser, mit neu geladener Extension und
neu gestartetem pi:

- **PDF-Adresse** `https://www.clever-fit.com/app/uploads/2022/10/AGB.pdf` →
  `browser_read` antwortet:
  „Diese Seite kann die Extension nicht lesen **(Typ: pdf)**. Adresse:
  https://www.clever-fit.com/app/uploads/2022/10/AGB.pdf"
  — genau die zugesagte Form: Typ benannt, Adresse weiterreichbar (so die
  Antwort damals; englisch seit `docs/54`).
- Bestätigt nebenbei, dass die Durchreiche durch den Hub funktioniert: ohne die
  drei Zeilen in `bridge/hub.mjs` wäre der Satz der alte geblieben.

Die Sackgasse, die das Inkrement auslöst, ist damit belegt: der Agent weiß jetzt,
dass es ein PDF ist und **welche** Adresse er weitergeben kann.

## Bekannte Lücken

Noch keine — der Live-Beleg aus Kriterium 5 steht aus. Fällt dort eine Zeile rot
aus, steht sie hier mit Datum. `## Bekannte Lücken` ist **kein** Ersatz für eine
widerlegte Kernannahme.

## Risiken

- **`kind: "pdf"` lügt bei PDFs ohne Endung** (`/download?id=7`). Deshalb heißt das
  Feld `kind` und nicht `fileType` — und deshalb gibt es Spec 11, das den echten
  Typ holt.
- **`tabs.get` ist ein zweiter Aufruf im Fehlerpfad.** Scheitert er, kostet das
  nichts: die Felder bleiben `null`/`unknown`, die Meldung ist die alte.
- **Zwei Felder in einem Fehlerobjekt sind eine Formänderung.** Ein Aufrufer, der
  das Fehlerobjekt starr vergleicht, bricht — im Repo tut das niemand (geprüft:
  kein `deepStrictEqual` auf Fehlerobjekte), und Fremde gibt es nicht.
- **`edge:` ist ein Chromium-Schema** und wird in Firefox nie feuern. Ein toter
  String in der Schema-Liste, kein Risiko.

## Amendments to previous spec docs

- **Spec 05** (`05-seiteninhalt-lesen.md`) pinnt den `not_readable`-Satz als
  Antwort auf eine unlesbare Seite. Der Satz bleibt für den Fall **ohne** Details
  wörtlich derselbe; die neuen Sätze sind Ergänzungen für den Fall **mit** Details.
- **Spec 06** und **Spec 07** sagen, `not_readable` werde „unverändert
  durchgereicht". Das gilt weiter für Code und Meldung; das Fehlerobjekt trägt
  jetzt zusätzlich zwei Felder.
- **Spec 09** (`browser_inspect`) erbt denselben Fehler; dort steht im
  `## Wire-Protokoll` nur `not_readable` ohne Felder. Diese Spec ergänzt das.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine neue Berechtigung, kein Seitentext
  in Logs, Tests, Fixtures oder Doku.
- `extension/manifest.json`, `extension/options.*`, `bridge/websocket.mjs`,
  `bridge/config.mjs` bleiben unverändert.
- **`bridge/hub.mjs` wird angefasst, aber nur an drei Stellen**: `details` im
  `HubRequestError`-Konstruktor, `this.details` und `message.error` in
  `#handleResponse`. Keine neue Logzeile, kein anderer Aufbau des Fehlerblocks.
- `docs/PROJECT-STATE.md`, `docs/README.md`, `docs/ROADMAP.md` und `INSTALL.md`
  pflegt der Orchestrator.

## Open questions

Keine. Entschieden mit dem Betreiber am 2026-10-23 (Roadmap-Auswahl, Zeile 08c):
Typ und Link mitliefern. Der Typ wird **abgeleitet und benannt**, nicht als
Inhaltsbeweis ausgegeben.

## Dev plan

**Entscheidungen vorab:**

1. **Details-Plumbing an einer Stelle.** `class ReadError` bekommt `details` als
   dritten Parameter (Default `{}`); `readErrorFrame(error)` ⇒
   `{ code, message, ...error.details }` ersetzt die vier `instanceof
   ReadError`-Zeilen. „Nur bei `not_readable`" ist damit konstruktiv garantiert.
2. **Kein zweiter Erzeuger.** `throw new ReadError(NOT_READABLE_CODE, …)` steht
   genau einmal, in `injectPageCode`. `readAgentTabPage` wirft davor
   `no_agent_tab` (ohne Felder), `pageResultOf` `read_failed`. Die Anreicherung
   sitzt dort und nur dort.
3. **`tabs.get` wirft ab dem zweiten Aufruf** — der erste gehört
   `findDefaultContainerTab`. `createBrowserStub` gibt `tabs` per Referenz zurück,
   also braucht es dafür keinen neuen Schalter im Harness.
4. **Ein Satz-Bauer.** `notReadableText(details)` in `bridge/mcp.mjs`, aufgerufen
   von den vier Stellen, die heute `TOOL_TEXTS.NOT_READABLE` zurückgeben;
   `extensionFailureText` bekommt einen vierten Parameter `details = {}`,
   `failureTextFor` reicht `error.details ?? {}` durch. Den heutigen Satz pinnt
   genau ein Fall; er bleibt unverändert.
5. **`url` und Privatsphäre.** Der `url` geht in den Wire-Rahmen und in den Satz,
   den der Agent liest — das ist gewollt. Er geht **nicht** in eine Logzeile.
   Tests benutzen ausschließlich erfundene Adressen.

**Stufen:**

1. **Extension: ableiten, anreichern, durchreichen.** `extension/background.js`:
   `INTERNAL_URL_SCHEMES`, `kindFromUrl(url)`, `URL_DETAIL_LIMIT = 2048`,
   `async notReadableError(tabId)`, `ReadError` mit `details`, `readErrorFrame`,
   `injectPageCode`-`catch` mit `throw await …`.
   Proof: `node --test --test-reporter=tap test/extension.test.js | grep -E '^# (pass|fail|cancelled)'`
   → `# fail 0`, `# cancelled 0`; dazu die Fälle der `## Testing`-Tabelle. **Completed 2026-10-23** — 11 Neufälle,
   `# pass 166` in der Extension, Gesamt 292 grün; Testdiff rein additiv.
2. **Hub: die Felder durchlassen, sonst nichts.** `bridge/hub.mjs` wie in
   `## Hub`; neuer Fall
   `hub_requestAnsweredWithOkFalse_shouldRejectWithTheExtensionErrorAttached`.
   Proof: `node --test --test-reporter=tap --test-name-pattern='WithTheExtensionErrorAttached' test/hub.test.js`
   → `# pass 1`, `# fail 0`; `node --test --test-reporter=tap test/hub.test.js | grep '^# fail'`
   → `# fail 0`. **Completed 2026-10-23** — `# pass 36` im Hub,
   Gesamt 293 grün.
3. **MCP: der Satz nennt Typ und Adresse.** `bridge/mcp.mjs`:
   `NOT_READABLE_KINDS` (Whitelist), `notReadableText(details)`,
   `extensionFailureText(..., details = {})`, `inspectFailureTextFor(..., details)`.
   `test/fixtures/fake-extension.mjs`: `BC_TEST_ERROR_DETAILS` (JSON) wird in
   `errorResponse(id, code)` gespreizt; ohne die Variable bleibt der Rahmen wie
   heute. Neue `test/mcp.test.js`-Fälle wie in `## Testing`.
   Proof: `node --test --test-reporter=tap --test-name-pattern='NotReadable' test/mcp.test.js`
   → `# fail 0`; danach `npm test; echo $?` → `0` mit `# fail 0` und
   `# cancelled 0`. **Completed 2026-10-23** — `# pass 7` im MCP-Ausschnitt,
   Gesamt 299 grün, `test/mcp.test.js` rein additiv.

### What could go wrong

- **Kriterium 1 ist nicht per Kommando prüfbar** — „281 unverändert" entscheidet
  der Diff, nicht der TAP-Output.
- **Verschlucktes `await`.** `throw notReadableError(tabId)` statt `throw await …`
  wirft ein Promise; `instanceof ReadError` ist dann `false`, der Code kippt auf
  `read_failed`, und die Neufälle fallen mit irreführender Meldung.
- **Kappung vor der Ableitung** würde lange `.pdf`-Adressen zu `unknown` machen.
  Die Reihenfolge steht in `## Ziel` und hat eine eigene Testzeile.
- **Der Hub ist die Naht**: ohne die drei Zeilen bleibt der MCP-Satz der alte,
  während die Extension-Fälle grün sind — genau die Konstellation, in der ein
  Umsetzer anfängt, in `mcp.mjs` zu raten.

### Ordering and dependencies

1 → 2 → 3 (ohne `details` im `HubRequestError` kann der MCP-Fall nicht grün
werden). Jede Stufe lässt die Suite grün zurück. Kriterium 5 (Reload, Neustart,
Live-Beleg) und `CONTRIBUTING.md` Schritt 7 gehören dem Betreiber bzw. dem Orchestrator.

### What the next increment inherits

- **Spec 11** (`content-type-per-head.md`) baut auf diesem hier auf: es braucht
  `notReadableError` und `kind`, um zu entscheiden, ob eine HEAD-Anfrage
  überhaupt sinnvoll ist, und fügt `contentType` als drittes Feld hinzu.
- **Kein PDF-Text, kein Download, kein Bild-Auslesen.**
- **`kind` ist Adressableitung, kein Inhaltsbeweis** — `/download?id=7` bleibt
  `unknown`, bis Spec 11 den Server fragt.

## Review

**Runde 1 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Elf Befunde,
übernommen (Details im Log dieser Runde unten). Kern: Kriterium 2 konnte nie rot
werden, die Kernannahme war unscharf, `## Ziel` widersprach `## Non-goals`, `url`
war ungebremst (1-MiB-Rahmen), Hub-Testzeile und `## Bekannte Lücken` fehlten.

**Runde 2 (2026-10-23): 🔧 Fix these.** Fünf Befunde, übernommen. Kern: Kriterium
2b maß den fremden Server statt den Code (jetzt festgenagelte Adresse plus
Statusprüfung — **in Spec 11 verschoben**), Reihenfolge von Kappung und Ableitung
war offen, `## Amendments` fehlte, zwei Signaturen für `notReadableError`,
MCP-Testzeilen wichen vom Plan ab.

**Runde 3 (2026-10-23): 🔧 Fix these — mit der Anweisung zu teilen.** Zwei Befunde
plus der Teilungshinweis, alle übernommen:

1. **Kriterien 2/2b waren vor dem Commit nicht lauffähig** (ein Live-`browser_read`
   braucht den Neustart). Der Live-Beleg steht jetzt gebündelt hinter der datierten
   Ausnahme; Kriterien 1–5 sind Harness-Fälle.
2. **„Nur zwei Zeilen" im Hub war zu knapp** — es sind drei (Konstruktor,
   `this.details`, Aufrufstelle). Korrigiert.
3. **Die Spec wurde geteilt** (Projektregel nach dem dritten Block): `kind` +
   `url` + Hub-Durchreiche + MCP-Sätze bleiben hier; `contentType` per HEAD, der
   `fetch`/`AbortController`-Harness und die 2b-Zusage wandern nach
   `docs/11-content-type-per-head.md`. Der verbleibende Teil ist genau der Kern,
   den der Reviewer als tragfähig bezeichnet hat.

**Code-Review (2026-10-23, `grizzled-senior-dev`): ✅ Ship it, ohne Blocker.** Der
Reviewer hat die Tests in einer Wegwerf-Kopie mutiert, statt ihnen zu glauben:
`await` entfernt ⇒ 8 Fälle rot; Kappung vor der Ableitung ⇒ der lange
`.pdf`-Fall rot; Schema vor Suffix getauscht ⇒ `file:///…/a.pdf` rot; Hub auf
`{ code }` zurückgedreht ⇒ Hub-Fall **und** beide MCP-Fälle rot; Whitelist
ausgebaut ⇒ beide „Kind außerhalb der Whitelist"-Fälle rot. Damit ist jede der
Zusagen an einer Stelle geprüft, an der sie auch brechen kann.

Nachgelagerte Befunde, **nicht** in diesem Inkrement behoben:

1. **`cappedAddress` prüft doppelt** — `tabAddressOrNull` hat `asUrl` schon
   laufen lassen; der `typeof`-Wächter dort ist unerreichbar (zwei Stellen zum
   Vergessen).
2. **`NOT_READABLE_KINDS` enthält `"unknown"`**, das die Zeile darunter wieder
   ausschließt. Ein Whitelist-Eintrag, der immer verworfen wird, liest sich beim
   nächsten Lesen wie ein Fehler.
3. **`details = { kind: "pdf", url: null }`** (der frühe Rückgabeweg in
   `notReadableText`) hat keinen Fall — eine Tabellenzeile würde reichen.

## Log

Je Review-Runde eine Zeile pro Befund, alle **übernommen**:

- **Runde 1:** Kriterium 2 war nicht falsifizierbar → geteilt. Kernannahme unscharf
  → präzisiert. `Ziel` widersprach `Non-goals` (`file:`) → angeglichen. `url`
  ungebremst (1-MiB-Rahmen) → 2 048 Zeichen. `tabs.get`-Zählung falsch → „ab dem
  zweiten Aufruf". Privatsphäre-Begründung halbwahr → als Entscheidung formuliert.
  Hub-Testzeile fehlte → ergänzt. `Bekannte Lücken` fehlte → ergänzt.
  `.pdf#page=2`/`tabs.get` ohne `url` ungeprüft → ergänzt.
- **Runde 2:** 2b maß den fremden Server → **an Spec 11 abgegeben**. Kappung vor
  Ableitung offen → Reihenfolge festgeschrieben. `Amendments` fehlte → ergänzt.
  Zwei Signaturen → eine. MCP-Testzeilen wichen ab → angeglichen.
- **Runde 3:** Kriterien 2/2b vor dem Commit nicht lauffähig → Live-Beleg
  gebündelt hinter die datierte Ausnahme. „Zwei Zeilen" im Hub → drei. **Spec
  geteilt** (Projektregel nach dem dritten Block).
- **Code-Review:** keine Blocker; drei Stilbefunde als Nachgelagertes notiert.
