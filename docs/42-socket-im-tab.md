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
- **Gemessen:** die Verbindung hält über Stunden, überlebt Tab-Neustart,
  Tab-Discard und Browser-Neustart.

## Non-goals

- **Kein `manifest_version: 3`.** Das ist `docs/43`.
- **Kein Schalter, keine Icons, kein `goodbye`.** Das ist `docs/44`.
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
| Socket | `let socket = null` (506), Aufbau `new WebSocket(settings.endpoint)` (618), `onSocketClosed` ab 6990, `socket = null` (6995) |
| `injectPageCode` | **eine** Definition (2185), **16** echte Aufrufe (2039, 2086, 2943, 3128, 3304, 3357, 3717, 4726, 5450, 6718, 6720, 6736, 6747, 6821, 6840, 6866) |
| `pageSnippetCode` | baut **Quelltext**: `(() => { ${PAGE_HELPERS_CODE} … return (${source.toString()})(${argumentList}); })()`; die drei Helfer (`describeElement`, `isVisible`, `isAddressedFrame`) reisen als **Text** mit (2229–2233, 2834) |
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

**Der Tab ist angepinnt** (`tabs.update(tabId, {pinned: true})` direkt nach dem
Anlegen, Betreiberentscheid 2026-11-17). Angepinnt ist er dauerhaft sichtbar und
wird seltener verworfen — beides ist gewollt: der Betreiber soll sehen, dass die
Brücke läuft.

**Identität des Tabs:** `browser.tabs.query({url: browser.runtime.getURL("bridge.html")})`.
Weil `query` und `create` nicht atomar sind, braucht der Koordinator einen
**Single-Flight-Guard**: ein laufendes Anlegen blockiert ein zweites, auch wenn
`onStartup` und `tabs.onRemoved` gleichzeitig feuern.

**Kein Backoff im Koordinator.** Der Reconnect-Timer gehört zum Tab; stirbt der
Tab, stirbt der Timer mit ihm. Ein Hintergrund, der weiterverbindet, wäre der
Fehler von `docs/02` in neuem Gewand.

## Der Umbau der Injection-Naht

`injectPageCode` reicht heute `{ code, runAt, allFrames, matchAboutBlank }` an
`browser.tabs.executeScript`. `pageSnippetCode` baut diesen `code` aus einer
Funktion plus den drei Helfern als **Text**.

**MV3s `scripting.executeScript` kennt kein `code`.** Die Schnittstelle trägt
`func`, `args` und `files` (MDN, `scripting.ScriptInjection`); Funktionen reisen
in `args` nicht mit. Damit ist `pageSnippetCode` nicht „umgestellt", sondern
**ersetzt**:

- eine **Content-Script-Datei** `page-agent.js` mit den drei Helfern und einem
  Dispatcher,
- injiziert über `files` (oder als `func`, das eine Nachricht schickt),
- der Aufruf übergibt `{op, args}` als Nachricht, die Antwort kommt als
  Rückgabewert des Dispatchers.

**Diese Arbeit ist der Kern des Inkrements** und bekommt deshalb eine eigene
Stufe mit eigenem Beweis: alle 16 Aufrufstellen müssen danach unverändert
antworten, und `framesOf`/der Frame-Filter (`docs/24`) entscheiden weiterhin
nach **Inhalt**, nicht nach Position.

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
| `test/extension.test.js` | die 16 Injection-Aufrufer, Harness auf `page-agent.js` umgestellt | die Werkzeuge antworten unverändert |
| `test/extension.test.js` | `transcript_captureAndWaiter_shouldLiveInTheSameContext` | Listener und Wartender im selben Kontext (kein Promise über den Worker) |
| `test/manifest.test.js` | die zwei `background.js`-Leser auf die neue Datei | `ALLOW_EVAL`/`ALLOW_SCREENSHOT` werden weiter gepinnt |
| `test/ci/e2e.test.js` | `e2e_seamPatch_shouldFindBothLines` (Pfad **und** Inhalt) | der Seam findet seine zwei Zeilen in `bridge.js` |
| live (Betreiber) | 8 h Leerlauf, Tab schließen, Tab verwerfen, Browser-Neustart | die Verbindung hält |

## Acceptance criteria

**Kriterien 1–8 entscheidet der Umsetzer, 9–13 der Betreiber** (`CONTRIBUTING.md`:
„Where a criterion can only be decided in a real browser, the spec says so").

1. **Genau ein Brücken-Tab, und er ist angepinnt.**
   `tabs.query({url: runtime.getURL("bridge.html")})` ⇒ **1** nach zwei Aufrufen
   des Koordinators (Stub-Harness) und ⇒ **1** nach einem gleichzeitigen Paar
   (`bridgeTab_withTwoConcurrentStarts_…`); sein `pinned` ⇒ **true**.
2. **Ein geschlossener Tab kommt zurück.** Im Harness `tabs.onRemoved` feuern ⇒
   genau **ein** `tabs.create`. Die Zeit (10 s) und die Logzeile prüft der
   Betreiber in Kriterium 11 — in Stufe 1 ist das Manifest noch MV2 mit
   `persistent: true`, eine Eventpage gibt es dort nicht.
3. **Ein verworfener Tab kommt zurück.** `browser.tabs.discard(tabId)` im
   Harness ⇒ `tabs.onUpdated` mit `changeInfo.discarded` ⇒ Reload; die Bridge
   loggt `disconnected` und danach `connected`.
4. **Ein weg-navigierter Tab bekommt einen Nachfolger.** Im Harness die URL des
   Brücken-Tabs auf `https://example.org/` setzen ⇒ der Koordinator legt einen
   neuen an und schließt den fremden.
5. **Kein privates Fenster, kein Container.** `bridgeTab_shouldNeverUseAPrivateWindow`
   ⇒ grün; der angelegte Tab hat `cookieStoreId === "firefox-default"`.
6. **Die Werkzeuge antworten unverändert.** `npm test` ⇒ `# fail 0`,
   `# cancelled 0`; `node --test test/bridge-tab.test.js` ⇒ `# fail 0`.
7. **Der Seam findet seine Zeilen.** `node scripts/e2e/build-test-extension.mjs
   --self-check --source extension` ⇒ Ausgabe **`seams ok: endpoint=1 token=1`**,
   Exit **0**.
8. **Die Parität bleibt.** `scripts/parity.sh --impl rust --check` ⇒ `7/7 wie
   erwartet`, `--self-test` ⇒ `7/7 rot wie erwartet`. Die Bridge ist unberührt.
9. **Die Verbindung hält 8 Stunden.** (Betreiber.) Vor dem Lauf: Bridge starten,
   Brücken-Tab offen und verbunden; den Zeitstempel `T1` der Zeile
   `extension connected` notieren. Nach **8 h** (gewählt: ein Arbeitstag-Rest,
   die Absicht in `docs/02` war „über Stunden") im Fenster `T1 … T1+8 h`:
   `grep -c 'extension connected'` ⇒ **1**, `grep -c 'extension disconnected'` ⇒
   **0**, und `ss -Htn state established '( sport = :8110 )'` ⇒ **1** Zeile.
   Erlaubte Abbrüche (Tab-Neuaufbau, Bridge-Neustart) werden **vor** dem Lauf
   aufgezählt und mitgezählt, nicht hinterher entschuldigt.
10. **Ohne Tab keine Verbindung, mit Tab sofort.** (Betreiber.) Tab schließen ⇒
    die Bridge loggt `extension disconnected`, ein Werkzeugaufruf antwortet
    „Keine Extension verbunden"; nach dem Neuaufbau antwortet `browser_status`
    wieder.
11. **Der Tab überlebt den Browser-Neustart.** (Betreiber.) Firefox beenden und
    starten ⇒ innerhalb **30 s** ist ein Brücken-Tab da und verbunden (gewählt:
    Sitzungswiederherstellung plus Koordinator).
12. **Der Mitschnitt wartet im selben Kontext.** (Betreiber.) Eine Seite mit
    `api/timedtext`-Anfrage laden, **30 s** warten (Hintergrund schläft), dann
    `browser_transcript` ⇒ die Original-Adresse wird gefunden. Das entscheidet
    das Kriterium. Die Negativkontrolle (Adresse **nicht** vorhanden ⇒
    `no_address`, nicht `no_transcript_panel`) ist ein Regressionswächter: das
    Verhalten ist schon heute so, es belegt den Umzug nicht.
13. **Die 30-Sekunden-Grenze fällt.** (Betreiber.) Nach **5 min** ohne
    jede Interaktion antwortet `browser_status` noch — das war unter MV2 nach
    30 s vorbei.

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

Beweis: Kriterien 1, 2, 4, 6, 7, 8.

**Stufe 2 — die Injection-Naht**

Dateien: `extension/page-agent.js` (neu, die drei Helfer und der Dispatcher),
`extension/background.js`/`bridge.js` (`injectPageCode` und
`pageSnippetCode`-Aufrufer), `test/extension.test.js` (die 16 Aufrufstellen).

Der Umbau nach dem MV3-Vertrag: `files`/`func` plus `{op, args}` als Nachricht,
kein `code` mehr. Das ist die Vorbereitung für `docs/43` und **muss** hier
passieren, weil `--record` der Parität verweigert und ein späterer Umbau sonst
mit dem Manifest-Umzug zusammenfällt.

Beweis: Kriterium 6 mit den 16 Aufrufern; `grep -Fc 'browser.tabs.executeScript'
extension/background.js` ⇒ **0** (ein `grep 'code:'` zählt 30 Treffer, davon
Fehlercodes — es wäre ein Beweis, der nie grün wird).

**Stufe 3 — der Mitschnitt zieht mit**

Dateien: `extension/bridge.js` (Listener und Wartender), `extension/background.js`
(Listener raus), `test/extension.test.js` (`transcript_captureAndWaiter_…`),
`docs/34` (`## Bekannte Lücken`), `docs/02` (Verweis).

Beweis: Kriterien 12, 13; und die bestehenden Transkript-Fälle bleiben grün.

**Stufe 4 — die Messung**

Dateien: `docs/42` (Messwerte), `docs/PROJECT-STATE.md`.

Beweis: Kriterien 9, 10, 11 mit Zeitstempeln aus dem Bridge-Log.

## Amendments to previous spec docs

| Dokument | Abschnitt | was gilt |
|---|---|---|
| `docs/02-persistenter-background.md` | `## Non-goals` („Kein Socket im Tab") | **überholt**: erledigt durch `docs/42` |
| `docs/02-persistenter-background.md` | `## Ziel`, `## Acceptance criteria` | sie beschreiben den MV2-Hintergrund als Lösung. Sie bleiben **stehen** (der Messbeleg 30,0 s gehört nicht umgeschrieben) und bekommen einen Satz „gilt bis `docs/42`" |
| `docs/34-spurendatei-beobachten.md` | `## Bekannte Lücken` | der Mitschnitt lebt jetzt im Brücken-Tab; die Lücke „läuft nur, solange der Tab lebt" tritt an ihre Stelle |
| `docs/36-standard-endpunkt.md` | Kriterium 1 | es pinnt `const DEFAULT_ENDPOINT = …` in `extension/background.js`; nach dem Umzug steht die Zeile in `bridge.js` |
| `docs/40-ci-ablauf.md` | Ankertabelle | die zwei Anker liegen in `extension/bridge.js`; `test/ci/e2e.test.js` prüft Pfad **und** Inhalt |
| `INSTALL.md` | §8 „Silence usually means …" | gehört zu `docs/44`: die häufigste Ursache ist dort der ausgeschaltete Schalter |

## Bekannte Lücken

- **Nichts davon ist gemessen.** Es gibt keine Tab-Variante im Baum; die 30,0 s
  stammen aus `docs/02`, die 16 Aufrufstellen aus dem Code.
- **Tab-Discard ist eine Vermutung mit Vorsicht.** Dass ein angepinnter Tab
  seltener verworfen wird, ist **nicht belegt** — die Spec pinnt ihn trotzdem
  (Sichtbarkeit, Betreiberentscheid), und Kriterium 3 erzwingt das Verwerfen
  über `tabs.discard`, statt auf die Vermutung zu bauen.
- **Die Injection-Naht ist ein Umbau, keine Umbenennung.** 16 Aufrufstellen und
  drei Helfer, die bisher als Text mitreisen.

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
