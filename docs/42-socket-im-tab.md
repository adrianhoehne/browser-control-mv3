---
description: Der Socket zieht aus dem Hintergrund in einen eigenen Tab — Voraussetzung für MV3; dazu der Umbau der Injection-Naht.
status: proposed
---

# Der Socket zieht in den Tab

`docs/02` hat MV2 **gewählt**, weil Firefox die MV3-Eventpage nach 30 Sekunden
Leerlauf entlädt und eine offene WebSocket **nicht** als Aktivität zählt. Dort
steht als Non-Goal: „Kein Socket im Tab. Ein immer offener Tab, der die
Verbindung hält, ist ein **Kandidat** für eine eigene Spec (und dort mit dem
Betreiber zu entscheiden)."

Diese Spec ist diese Entscheidung — **Roadmap-Zeile 26**, der erste von drei
Schritten. Sie ändert das Manifest noch **nicht** auf MV3; sie schafft die
Voraussetzung dafür. Der Schalter (Icons, `goodbye`) ist `docs/44`, das Manifest
`docs/43`.

**Warum das der erste Schritt ist:** solange der Socket im Hintergrund lebt, ist
jede MV3-Frage sinnlos — die Eventpage stirbt mit ihm. Ein Tab stirbt nicht nach
30 Sekunden Leerlauf. Das ist die einzige Annahme, die diese Spec trägt, und sie
wird in Stufe 3 gemessen, nicht geglaubt.

## Die Messung, auf der alles ruht

Aus `docs/02`, am 2026-10-23 mit dem Bridge-Log belegt:
`extension connected` 16:00:30.471 → `extension disconnected reason=1001`
16:01:00.496 — **genau 30,0 s**, danach 4,5 Minuten nichts bis zum manuellen
Reload.

## Ziel

- **Der Socket lebt in einem Erweiterungs-Tab** (`bridge.html`), nicht im
  Hintergrund. Mit ihm ziehen die Sitzung, der Tab-Store, die
  Werkzeugausführung **und** der `webRequest`-Mitschnitt dorthin.
- **Der Hintergrund wird Koordinator** und darf sterben: er sorgt dafür, dass
  genau ein Brücken-Tab existiert, und sonst nichts.
- **Kein Warten über zwei Kontexte.** `transcript` wartet heute im Werkzeugpfad
  auf eine Adresse, die ein Listener einsammelt
  (`transcriptCaptionWaitFor`, `background.js:6819` gegen den Listener bei
  5679). Läge der Listener im Hintergrund und der Wartende im Tab, wäre das ein
  Promise über einen Sterbenden. Beides gehört in den Tab.
- **Das Wire-Protokoll bleibt unverändert.** Bridge, Hub und die dreizehn
  Werkzeuge merken nichts; die Parität (`7/7`) bleibt der Maßstab.
- **Gemessen:** die Verbindung hält über die Messdauer, überlebt Tab-Neustart,
  Tab-Discard und Browser-Neustart.

## Non-goals

- **Kein `manifest_version: 3`.** Das ist `docs/43`.
- **Kein Schalter, keine Icons, kein `goodbye`.** Das ist `docs/44`.
- **Kein Umbau der Injection-Naht.** Das ist `docs/45`.
- **Keine neue Berechtigung.** `tabs`, `storage`, `<all_urls>`, `webRequest`
  bleiben, wie sie sind.
- **Keine Änderung an der Bridge** — weder Protokoll noch Logzeile noch
  Close-Code.
- **Kein Signieren.**

## Das Inventar (aus dem Code gelesen, 2026-11-17)

| Was | Stand |
|---|---|
| `extension/manifest.json` | `manifest_version: 2`, `background.scripts: ["protocol.js","background.js"]`, `persistent: true`, `permissions: ["tabs","storage","<all_urls>","webRequest"]`, **kein** `browser_action` |
| `extension/background.js` | **7 032 Zeilen**, eine IIFE; Sitzung, Tab-Store, Werkzeuge, Logzeilen |
| Socket | `let socket = null` (506), Aufbau `new WebSocket(settings.endpoint)` (619), `onSocketClosed` ab 6990, `socket = null` (6995) |
| `injectPageCode` | **eine** Definition (2185), **16** echte Aufrufe (2039, 2086, 2943, 3128, 3304, 3357, 3717, 4726, 5450, 6718, 6720, 6736, 6747, 6821, 6840, 6866) |
| `pageSnippetCode` | baut **Quelltext**: `(() => { ${PAGE_HELPERS_CODE} … return (${source.toString()})(${argumentList}); })()`; die drei Helfer (`describeElement`, `isVisible`, `isAddressedFrame`) reisen als **Text** mit (2229–2233, 2830) |
| `captureTab` | eine Stelle (5083) |
| `webRequest` | `onBeforeRequest` für `*://*.youtube.com/api/timedtext*` (5679), ohne Blockieren; die Treffer liegen in `transcriptCaptionWire`/`…Waiters` (5511–5517) |
| `test/extension.test.js` | **16 343 Zeilen**, lädt `background.js` in eine `vm` mit gestubbten Browser-APIs |
| `test/manifest.test.js` | 16 Fälle, mehrere nageln MV2 fest; **zwei** lesen `background.js` auf `const ALLOW_EVAL` / `ALLOW_SCREENSHOT` |
| E2E-Seam | `scripts/e2e/build-test-extension.mjs` patcht **zwei** Zeilen in `background.js` (Endpunkt, Token) |

## Die Architektur

**`bridge.html` + `bridge.js` (der Brücken-Tab):** hält WebSocket,
Einstellungen, Tab-Store, Werkzeugausführung, Injection und den
`webRequest`-Mitschnitt. Es ist eine Erweiterungsseite: sie kann
`browser.webRequest.onBeforeRequest.addListener` selbst aufrufen, weil sie die
Host-Berechtigung hat — deshalb braucht der Mitschnitt keinen zweiten Kontext.

**`background.js` (Koordinator):** legt den Brücken-Tab an, wenn keiner
existiert, und öffnet ihn wieder, wenn er verschwindet. Er hält **keine**
Sitzung und **keinen** Zustand, der einen Tab überlebt.

**Der Brücken-Tab erscheint nicht in `browser_status`.** Die Statusliste filtert
jede URL, die mit `browser.runtime.getURL("bridge.html")` beginnt — sonst sieht
der Agent einen Tab, den er nicht anfassen darf, und das lädt zum Probieren ein.
Filtern ist **paritätssicher:** die eingefrorenen Artefakte kommen von der
Fixture, nicht aus der Erweiterung, und enthalten keinen solchen Tab; ein neues
Feld im Status wäre es nicht. Ansprechen kann er ihn ohnehin nicht:
`resolveAgentTab` akzeptiert nur Ids aus der Agenten-Tab-Liste, dort steht er
nie — `read`, `eval`, `click`, `screenshot` und `close_tab` antworten
`no_agent_tab`.

**Der Tab ist angepinnt und landet im zuletzt benutzten Fenster.**
`tabs.create({url, pinned: true, windowId})` — ein Aufruf, nicht `create` plus
`update`. Die `windowId` merkt sich der Koordinator vom letzten Brücken-Tab; ist
das Fenster weg, legt er ein **neues** an. Ein privates Fenster ist keine
Adresse. Angepinnt ist der Tab dauerhaft sichtbar und wird seltener verworfen —
beides ist gewollt (Betreiberentscheid 2026-11-17).

**Identität des Tabs:** `browser.tabs.query({url: browser.runtime.getURL("bridge.html")})`.
Weil `query` und `create` nicht atomar sind, braucht der Koordinator einen
**Single-Flight-Guard**: ein laufendes Anlegen blockiert ein zweites, auch wenn
`onStartup` und `tabs.onRemoved` gleichzeitig feuern.

**Kein Backoff im Koordinator.** Der Reconnect-Timer gehört zum Tab; stirbt der
Tab, stirbt der Timer mit ihm. Ein Hintergrund, der weiterverbindet, wäre der
Fehler von `docs/02` in neuem Gewand.

## Die Injection-Naht ist eine eigene Spec

`pageSnippetCode` baut heute Quelltext, und `scripting.executeScript` kennt kein
`code`. Dieser Umbau — 16 Aufrufstellen, drei Helfer, `callId`-Nachrichten — ist
`docs/45-injection-naht.md`. Er läuft **nach** dieser Spec, weil die 16 Aufrufer
dann in `bridge.js` liegen.

## Risiken

1. **Doppel-Tab.** `query` → `create` ist nicht atomar; `onStartup` und
   `tabs.onRemoved` können gleichzeitig laufen. Ohne Single-Flight entstehen
   zwei Brücken-Tabs und zwei Sockets (der zweite verdrängt den ersten mit
   `4409`).
2. **Der Betreiber navigiert den Brücken-Tab weg.** Die Identität hängt an der
   URL; eine fremde Seite dort macht den Tab „unsichtbar" für `query`. Der
   Koordinator legt dann einen zweiten an — und der tote Tab bleibt stehen.
3. **Tab-Discard.** Firefox entlädt Tabs unter Speicherdruck; der Socket stirbt.
   Erkennung über `changeInfo.discarded`, Neuaufbau über den Koordinator.
4. **Privates Fenster.** „Zuletzt benutztes Fenster" kann ein privates sein; dort
   läuft die Erweiterung nur mit `incognito: "split"`/`"spanning"`, sonst gar
   nicht. Der Koordinator darf kein privates Fenster wählen.
5. **Container.** Ein Tab in einem Container verschwindet aus
   `isDefaultContainerTab` — der Brücken-Tab darf dort nicht landen.
6. **Der Testharness.** 16 343 Zeilen prüfen `background.js` in einer `vm`.
   Zieht der Code um, muss der Harness mit — sonst prüft er eine Datei, die es
   nicht mehr gibt.
7. **Der E2E-Seam.** `docs/40` patcht zwei Zeilen in `background.js`; liegen
   Endpunkt und Token künftig in `bridge.js`, muss der Patch dort greifen —
   sonst meldet `checkSeams` „seam moved" und `npm run test:ci` fällt.
8. **Die Fixture ist zweifach verheiratet.** `test/fixtures/fake-extension.mjs`
   ist Peer von `npm test` **und** von `scripts/parity.sh`. Wer sie für einen
   grünen Test anfasst, verliert den Maßstab: `--record` ist verweigert, die
   sieben Artefakte sind eingefroren.

## Touch boundary

**Erlaubt:** `extension/{bridge.html,bridge.js,background.js,manifest.json,page-agent.js}`,
`extension/protocol.js` (nur falls nötig), `test/extension.test.js`,
`test/manifest.test.js`, `test/bridge-tab.test.js` (neu), `test/ci/e2e.test.js`
(der Seam-Fall liest den Pfad), `scripts/e2e/build-test-extension.mjs`,
`docs/02`, `docs/34`, `docs/36`, `docs/40`, `docs/42`, `docs/README.md`,
`docs/PROJECT-STATE.md`, `CHANGELOG.md`.

**Nicht:** `bridge-rs/**` (keine Bridge-Änderung), `extension/options.*`
(Optionsseite bleibt), `test/fixtures/**`, `scripts/parity/**`,
`deploy/**`, `scripts/install.sh`.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/bridge-tab.test.js` | `bridgeTab_whenMissing_shouldBeCreatedOnce` | sequenzielle Idempotenz: zwei Aufrufe ⇒ ein Tab |
| `test/bridge-tab.test.js` | `bridgeTab_withTwoConcurrentStarts_shouldStillCreateOne` | **Single-Flight**: gleichzeitige Aufrufe ⇒ ein `tabs.create` |
| `test/bridge-tab.test.js` | `bridgeTab_whenClosedByTheOperator_shouldComeBack` | Schließen ist kein Endzustand |
| `test/bridge-tab.test.js` | `bridgeTab_whenDiscarded_shouldBeReloaded` | `changeInfo.discarded` führt zum Neuaufbau |
| `test/bridge-tab.test.js` | `bridgeTab_afterANavigationAway_shouldBeReplaced` | weg-navigierter Tab wird erkannt und ersetzt |
| `test/bridge-tab.test.js` | `bridgeTab_shouldNeverUseAPrivateWindow` | ein privates Fenster ist keine Adresse |
| `test/bridge-tab.test.js` | `bridgeTab_shouldNeverLandInAContainer` | der Tab entsteht im Default-Container (`cookieStoreId === "firefox-default"`) |
| `test/bridge-tab.test.js` | `bridgeTab_whenTheWindowIsGone_shouldOpenANewOne` | gemerkte `windowId` weg ⇒ neues Fenster |
| `test/extension.test.js` | die 16 Aufrufer, Harness auf den Tab umgestellt | die Werkzeuge antworten unverändert (die Naht selbst ist `docs/45`) |
| `test/extension.test.js` | `transcript_captureAndWaiter_shouldLiveInTheSameContext` | Listener und Wartender im selben Kontext (kein Promise über den Worker) |
| `test/manifest.test.js` | die zwei `background.js`-Leser auf die neue Datei | `ALLOW_EVAL`/`ALLOW_SCREENSHOT` werden weiter gepinnt |
| `test/ci/e2e.test.js` | `e2e_seamPatch_shouldFindBothLines` (Pfad **und** Inhalt) | der Seam findet seine zwei Zeilen in `bridge.js` |
| live (Betreiber) | 30 min Leerlauf, Tab schließen, Tab verwerfen, Browser-Neustart | die Verbindung hält |

## Acceptance criteria

**Kriterien 1–8 entscheidet der Umsetzer, 9–13 der Betreiber** (`CONTRIBUTING.md`:
„Where a criterion can only be decided in a real browser, the spec says so").

1. **Genau ein Brücken-Tab, angepinnt.**
   `tabs.query({url: runtime.getURL("bridge.html")})` ⇒ **1** nach zwei Aufrufen
   des Koordinators (Stub-Harness) und ⇒ **1** nach einem gleichzeitigen Paar
   (`bridgeTab_withTwoConcurrentStarts_…`); sein `pinned` ⇒ **true**.
2. **Ein geschlossener Tab kommt zurück.** Im Harness `tabs.onRemoved` feuern ⇒
   genau **ein** `tabs.create` mit `pinned: true`.
3. **Ein verworfener Tab kommt zurück.** `browser.tabs.discard(tabId)` im
   Harness ⇒ `tabs.onUpdated` mit `changeInfo.discarded` ⇒ Reload; die Bridge
   loggt `disconnected` und danach `connected`.
4. **Ein weg-navigierter Tab bekommt einen Nachfolger.** Im Harness die URL des
   Brücken-Tabs auf `https://example.org/` setzen ⇒ der Koordinator legt einen
   neuen an und schließt den fremden.
5. **Kein privates Fenster, kein Container, richtiges Fenster.**
   `bridgeTab_shouldNeverUseAPrivateWindow` ⇒ grün; der angelegte Tab hat
   `cookieStoreId === "firefox-default"`; und `bridgeTab_whenTheWindowIsGone_shouldOpenANewOne`
   ⇒ der neue Tab entsteht in einem neuen Fenster.
6. **Die Werkzeuge antworten unverändert.** `npm test` ⇒ `# fail 0`,
   `# cancelled 0`; `node --test test/bridge-tab.test.js` ⇒ `# fail 0`. Die
   Injection-Naht prüft `docs/45` mit eigenen Kriterien.
7. **Der Seam findet seine Zeilen.** `node scripts/e2e/build-test-extension.mjs
   --self-check --source extension` ⇒ Exit **0**, und die Ausgabe nennt
   **`endpoint=1`** und **`token=1`** (gezählt je für sich, nicht als ein
   Präfix-String — `docs/44` hängt einen dritten Anker an dieselbe Zeile).
8. **Die Parität bleibt.** `scripts/parity.sh --impl rust --check` ⇒ `7/7 wie
   erwartet`, `--self-test` ⇒ `7/7 rot wie erwartet`. Die Bridge ist unberührt.
9. **Die Verbindung hält 30 Minuten.** (Betreiber.) Vor dem Lauf: Bridge
   starten, Brücken-Tab offen und verbunden; den Zeitstempel `T1` der Zeile
   `extension connected` notieren. Nach **30 min** im Fenster `T1 … T1+30 min`:
   `grep -c 'extension connected'` ⇒ **1**, `grep -c 'extension disconnected'` ⇒
   **0**, `ss -Htn state established '( sport = :8110 )'` ⇒ **1** Zeile.
   Erlaubte Abbrüche werden **vor** dem Lauf aufgezählt, nicht hinterher
   entschuldigt.

   **Warum 30 Minuten und nicht 8 Stunden:** der Manifest-Wechsel kommt erst in
   `docs/43`, und `docs/43` misst die 8 h dort, wo sie zählen. Dieselbe Messung
   zweimal zu fahren kostet zwei Betreiber-Tage für eine Zahl.
10. **Ohne Tab keine Verbindung, mit Tab binnen 10 s zurück.** (Betreiber.) Tab
    schließen ⇒ die Bridge loggt `extension disconnected` und ein Werkzeugaufruf
    antwortet „Keine Extension verbunden". Binnen **10 s** (gewählt: `onRemoved`
    plus `tabs.create` plus Laden; Reserve) steht ein neuer Tab, die Bridge loggt
    `extension connected` und `browser_status` antwortet wieder.
11. **Der Tab überlebt den Browser-Neustart.** (Betreiber.) Firefox beenden und
    starten ⇒ innerhalb **30 s** ist ein Brücken-Tab da und verbunden (gewählt:
    Sitzungswiederherstellung plus Koordinator).

    **Nicht messbar mit einem temporären Add-on** (Messung 2026-11-18): nach
    einem Firefox-Neustart ist die Erweiterung selbst weg. Gemessen wurde
    stattdessen der **Dienst**-Neustart — die Eigenschaft, um die es geht:
    **1 453 ms** bis `extension connected`, und der Brücken-Tab blieb derselbe.
    Der Browser-Neustart wird erst nach einer dauerhaften Installation messbar
    (Roadmap 23/24).
12. **Der Mitschnitt wartet im selben Kontext.** (Betreiber.) Eine Seite mit
    `api/timedtext`-Anfrage laden, dann `browser_transcript` ⇒ die
    Original-Adresse wird gefunden. Das entscheidet das Kriterium. Die
    Negativkontrolle (Adresse **nicht** vorhanden ⇒ `no_address`, nicht
    `no_transcript_panel`) ist ein Regressionswächter: das Verhalten ist schon
    heute so, es belegt den Umzug nicht.

    **Warum hier keine Schlaf-Messung steht:** diese Stufe bleibt MV2 mit
    `persistent: true` — der Hintergrund schläft nicht. Die 30-Sekunden-Grenze
    fällt erst mit dem Manifest und wird in `docs/43`, Kriterien 8 und 9,
    gemessen.

## Die Messung (2026-11-18, bigdelli, Firefox 152, Dienst auf 8110)

| Kriterium | Verlangt | gemessen |
|---|---|---|
| 9 — 30 min Leerlauf | `connected` 1, `disconnected` 0, 1 Socket | **33 min** ohne Ereignis, 1 Socket; die eine `4409`-Zeile ist die Übergabe von einem zweiten Browser |
| 10 — Tab schließen | Rückkehr ≤ 10 s | **168 ms** und **147 ms** (zweimal geschlossen) |
| 11 — Neustart | ≤ 30 s | Dienst-Neustart: **1 453 ms**, Tab blieb derselbe; Browser-Neustart mit temporärem Add-on **nicht messbar** |
| 12 — Transkript | Original-Adresse gefunden | Segmente geliefert (`en`, `source: ytplayer.bootstrapPlayerResponse`), **aber** der `webRequest`-Pfad lief nicht — siehe Lücken |

**Ein Nebenbefund:** der **erste** `browser_transcript`-Aufruf auf einer kalten
YouTube-Seite lief in `BC_CALL_TIMEOUT_MS` (20 s, Vorgabe) und antwortete nicht;
der zweite war sofort da. Das ist älter als dieser Umbau, aber jetzt zum ersten
Mal gemessen.

13. **Der Brücken-Tab bleibt unsichtbar.** `browser_status` listet keinen Tab,
    dessen Url `bridge.html` enthält: über MCP aufrufen und
    `grep -c 'bridge.html'` auf die Antwort ⇒ **0**.
14. **Der Brücken-Tab ist unantastbar.** `browser_read` mit seiner Tab-Id ⇒
    `no_agent_tab`; `browser_close_tab` auf ihn ⇒ `no_agent_tab` (er ist kein
    Agenten-Tab).

## Dev plan

**Stufe 1 — der Tab hält den Socket, das Manifest bleibt MV2**

Dateien: `extension/bridge.html`, `extension/bridge.js`, `extension/background.js`
(Koordinator, Sitzung raus), `extension/manifest.json` (`bridge.html` als Seite),
`test/bridge-tab.test.js` (die sieben Tab-Fälle), `test/extension.test.js`
(Harness-Ziel), `test/manifest.test.js` (die zwei `background.js`-Leser),
`scripts/e2e/build-test-extension.mjs` (Seam-Pfad), `docs/40` (Ankertabelle).

Der Tab entsteht, hält den Socket und führt die Werkzeuge aus; der Hintergrund
legt ihn an und hält ihn. **Stufe 1 und der Seam-Umzug sind ein Commit** — sonst
ist `npm run test:ci` rot, weil `checkSeams` seine zwei Zeilen nicht mehr findet.

`docs/36` (Kriterium 1 pinnt die Endpunkt-Zeile in `background.js`) und `docs/40`
(Ankertabelle) ziehen **im selben Commit** mit um — der Seam-Fall liest den Pfad.
Die Injection-Naht folgt als `docs/45`.

Beweis: Kriterien 1, 2, 4, 6, 7, 8.

**Stufe 2 — der Mitschnitt zieht mit** *(gebaut 2026-11-17)*

Dateien: `extension/bridge.js` (Listener und Wartender), `extension/background.js`
(Listener raus), `test/extension.test.js` (`transcript_captureAndWaiter_…`),
`docs/34` (`## Bekannte Lücken`), `docs/02` (Verweis).

Beweis: Kriterium 12 im Harness (`transcript_captureAndWaiter_shouldLiveInTheSameContext`,
`transcript_capture_whenTheTabGoesAway_shouldNotResolveWithAGhostEntry`) — **gebaut**:
`background.js` hat 0 `webRequest`-Vorkommen, `bridge.js` genau einen Listener, und
die Mutationsprobe (Listener stillgelegt bzw. das Wecken der Wartenden
auskommentiert) macht den Fall rot. 504 Node-Fälle grün.

**Stufe 3 — die Messung**

Dateien: `docs/42` (Messwerte), `docs/PROJECT-STATE.md`.

Beweis: Kriterien 9, 10, 11 mit Zeitstempeln aus dem Bridge-Log.

## Amendments to previous spec docs

| Dokument | Abschnitt | was gilt |
|---|---|---|
| `docs/02-persistenter-background.md` | `## Non-goals` („Kein Socket im Tab") | **überholt**: erledigt durch `docs/42` |
| `docs/02-persistenter-background.md` | `## Ziel`, `## Acceptance criteria` | sie beschreiben den MV2-Hintergrund als Lösung. Sie bleiben **stehen** (der Messbeleg 30,0 s gehört nicht umgeschrieben) ; den Satz „gilt bis" schreibt `docs/43`, weil dort der Hintergrund fällt |
| `docs/34-spurendatei-beobachten.md` | `## Bekannte Lücken` | der Mitschnitt lebt jetzt im Brücken-Tab; die Lücke „läuft nur, solange der Tab lebt" tritt an ihre Stelle |
| `docs/36-standard-endpunkt.md` | Kriterium 1 | es pinnt `const DEFAULT_ENDPOINT = …` in `extension/background.js`; nach dem Umzug steht die Zeile in `bridge.js` |
| `docs/40-ci-ablauf.md` | Ankertabelle | die zwei Anker liegen in `extension/bridge.js`; `test/ci/e2e.test.js` prüft Pfad **und** Inhalt |
| `INSTALL.md` | §8 „Silence usually means …" | gehört zu `docs/44`: die häufigste Ursache ist dort der ausgeschaltete Schalter |

## Bekannte Lücken

- **Die Tab-Variante ist gebaut, aber nicht gemessen.** Stufe 1 steht: der Code
  liegt als `extension/bridge.js` im Baum, `background.js` ist der Koordinator,
  und die neun Tab-Fälle laufen im Stub-Harness. Die 30,0 s stammen weiter aus
  `docs/02`, die 16 Aufrufstellen aus dem Code; Kriterien 9–13 entscheidet der
  Betreiber nach Stufe 3.
- **Tab-Discard ist eine Vermutung mit Vorsicht.** Dass ein angepinnter Tab
  seltener verworfen wird, ist **nicht belegt** — die Spec pinnt ihn trotzdem
  (Sichtbarkeit, Betreiberentscheid), und Kriterium 3 erzwingt das Verwerfen
  über `tabs.discard`, statt auf die Vermutung zu bauen.
- **Die Injection-Naht ist ein Umbau, keine Umbenennung.** 16 Aufrufstellen und
  drei Helfer, die bisher als Text mitreisen.

## Bekannte Lücken (nach Stufe 1, 2026-11-17)

- **Sitzungswiederherstellung kann zwei Tabs erzeugen.** `runtime.onStartup`
  kann feuern, **bevor** Firefox den wiederhergestellten Brücken-Tab anzeigt; der
  Koordinator legt dann ein Fenster und einen zweiten Tab an, und der ältere
  Socket bekommt `4409`. Kriterium 11 (Stufe 3) misst das; ob ein
  Nachlauf-Fenster (`setTimeout` vor dem `query`) reicht, entscheidet die
  Messung.
- **Zwei Texte sagen noch „background".** `STARTUP_LOG_LINE` („bc: background
  page started") bleibt, solange `INSTALL.md:442` sie zitiert — `INSTALL.md`
  gehört zu `docs/44`. `scripts/e2e/run.mjs` druckt in seiner
  `--self-check`-Meldung noch `background.js` (gehört zu `docs/40`).
- **Der `webRequest`-Pfad des Transkripts ist ungemessen.** Die Messung traf den
  Bootstrap-Zweig (`ytplayer.bootstrapPlayerResponse`), weil die englische
  Originalspur dort schon stand. Der Mitschnitt greift erst, wenn der Weg über
  das Spielermenü und die signierte `api/timedtext`-Adresse nötig ist — also bei
  einem Original, das nicht im Bootstrap steht (die Fälle aus `docs/33`, z. B.
  ein japanisches Video). Bleibt offen bis zu einem solchen Video.
- **`bridge.js` ist eine 7 000-Zeilen-IIFE.** Der Umzug hat die Form nicht
  geändert, nur den Ort; ein Aufteilen nach Zuständigkeit (Socket, Tab-Store,
  Werkzeuggruppen) wäre ein eigener Umbau.

## Open questions

**Keine.** Die drei Fragen, die `docs/44` betreffen (Icon, Sichtbarkeit,
Vorgabe), sind dort entschieden; hier bleibt die Mechanik.

## Review

### Runde 1 — 2026-11-17, `grizzled-senior-dev`: 🤔, Zuschnitt falsch

Das Verdict galt der gemeinsamen Fassung aus Migration und Schalter: acht
Blocker, darunter der Zuschnitt („kein Inkrement, ein Quartal"), die fehlende
Injection-Naht (`scripting` kennt kein `code`), ein Dev-Plan in falscher
Reihenfolge und ein Kriterium, das sich selbst aushebelt („keine
`extension disconnected` außer …").

**Folge: geteilt** in `docs/42` (dieser Schritt), `docs/43` (Manifest und
Messung) und `docs/44` (der Schalter). Die Rundenzählung beginnt je Dokument
neu.

## Log

- **2026-11-17, Betreiberentscheid:** Branch `mv3`, Spec zuerst.
- **2026-11-18, Lücke geschlossen:** bei der Teilung war verlorengegangen, dass
  der Brücken-Tab in `browser_status` sichtbar ist. Kriterien 13 und 14
  ergänzt; gebaut wird es zusammen mit `docs/44`.
- **2026-11-18, Messung durchgeführt:** Kriterien 9, 10 und 12 sind mit einem
  sichtbaren Firefox auf bigdelli gelaufen (Dienst, echter Token, Repo-Kopie mit
  eingebautem Token). Die Zahlen stehen unter `## Die Messung`.
- **2026-11-17, Teilung (dritter Block):** die Injection-Naht wird
  `docs/45-injection-naht.md`. `docs/42` behält Tab, Koordinator, Mitschnitt und
  die Messung — das ist der Umbau, den ein Tag trägt; die Naht ist ein eigener
  Umbau mit eigenem Beweis.
- **2026-11-17, Betreiberentscheid:** der Brücken-Tab ist **angepinnt**.
- **2026-11-17, Betreiberentscheid (Merge):** alle drei Inkremente
  (`docs/42`, `docs/43`, `docs/44`) landen **gemeinsam** auf `main` — der
  Manifest-Wechsel ist ein Bruch, einzeln gemergt wäre `main` zwischendurch eine
  Variante, die niemand ausliefern will. Committet wird hier trotzdem je Stufe.
- **2026-11-17, Teilung:** nach dem Review-Block in drei Specs; der Schalter ist
  nicht MV3-abhängig (`browser_action`, `setIcon`, `storage.local` gibt es unter
  MV2 genauso) und `goodbye` gehört zu Roadmap 32.
- **2026-11-17, Vorgeschichte:** `docs/02` hat MV2 gewählt und den Socket im Tab
  als Kandidaten für eine eigene Spec benannt.
- **2026-11-18, Stufe 1 gebaut:** die 7 032 Zeilen von
  `extension/background.js` zogen nach `extension/bridge.js` — unverändert bis
  auf den Kopf, der den neuen Ort nennt; `bridge.html` lädt `protocol.js` und
  `bridge.js`. Der neue `background.js` ist der Koordinator: ein `tabs.create`
  mit `pinned: true` und gemerkter `windowId`, Single-Flight-Guard, Neuanlage bei
  `onRemoved`, `changeInfo.discarded` (Reload) und Navigation weg (`query` findet
  ihn nicht mehr). Kein Socket, kein Backoff, kein Timer. Der Mitschnitt zog im
  selben Schritt mit — Stufe 2 bleibt als eigener Beweis (Kriterium 12/13) offen.
  Der Seam (`docs/40`) zeigt jetzt auf `bridge.js`; `test/bridge-tab.test.js`
  trägt neun Fälle. Nicht committet, Kriterien 9–13 ungemessen.
