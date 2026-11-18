---
description: Teil 2b von browser_transcript — die Spurendatei nicht suchen, sondern beobachten: die Extension schneidet mit der webRequest-Berechtigung die api/timedtext-Anfragen des Agenten-Tabs mit, weil der performance-Kanal für Anfragen der Seite blind ist (docs/33, M18).
status: active
---

# `browser_transcript`, Teil 2b: die Spurendatei beobachten

`docs/33-spurwahl.md` sollte die Sprache des Transkripts über die
**Spurendatei** bestimmen: die signierte `api/timedtext`-Adresse, gelesen aus
`performance.getEntriesByType('resource')`. Der Live-Lauf am 2026-11-12 hat
das widerlegt (`docs/33`, **M18**): dieser Kanal ist **keine**
Resource-Timeline der Seite — ein `<img>`, das die Seite selbst anfordert,
erscheint dort nicht, auf `youtube.com` so wenig wie auf `example.org`.

**Diese Spec ersetzt genau diesen einen Schritt.** Spur bestimmen, Spur
setzen, springen, zurückstellen — das bleibt, wie `docs/33` es baut. Neu ist,
**wer** die Adresse liefert: nicht ein Schnipsel, der eine Timeline liest,
sondern die **Extension selbst**, die den Netzwerkverkehr des Agenten-Tabs
mitschneidet. Dafür bekommt sie eine Berechtigung, und das ist eine
Betreiberentscheidung (2026-11-12, unten).

## Ziel

- **Die Extension beobachtet die Anfragen des Agenten-Tabs** über
  `browser.webRequest` und merkt sich die `api/timedtext`-Adressen — je Tab
  und je Sprache. Sie liest keine Timeline mehr.
- **Nur das Nötigste wird behalten:** die Adresse und ihre Sprachmerkmale
  (`lang`, `tlang`, `kind`) für **youtube.com-Tabs**. Aufgenommen wird je Tab
  das Letzte seiner Sprache, gedeckelt — **gelesen** wird ausschließlich für
  den **Agenten-Tab**, den der Aufruf adressiert. Welche Tabs der Agent führt,
  steht asynchron in `storage.local`; ein `webRequest`-Listener ist synchron
  und kann das nicht fragen (Verdrängung: `## Bekannte Lücken`).
- **Die Adresse bleibt in der Extension.** Sie ist ein Zugangsmittel für die
  Sitzung des Betreibers: nicht in der Antwort, nicht in einer Fehlermeldung,
  nicht im Log (`bridge/hub.mjs` bleibt unangetastet).
- **Der Rest des Wegs bleibt, wie `docs/33` ihn gebaut hat:** Modell lesen,
  Betreiberregel, Spur im Menü setzen, Sprung ±1 s, ein Wiederholungsversuch,
  Spur vor Position zurückstellen, `requestedLanguage`/`deliveredLanguage`/
  `source` in der Antwort.
- **Fehlt der Mitschnitt, ist das ein benannter Fehler** (`transcript_failed`,
  „Spurendatei … nicht gefunden") — kein stiller Rückfall aufs Panel.
- **Die Berechtigung ist die einzige neue.** Kein `webRequestBlocking`, kein
  neues Host-Recht (`<all_urls>` steht schon im Manifest), keine Abhängigkeit.

## Non-goals

- **Kein Blockieren, kein Verändern von Anfragen.** Nur beobachten
  (`onBeforeRequest`/`onCompleted`), nie `onBeforeSendHeaders` mit Blockade.
- **Kein allgemeines Netzwerkprotokoll.** Kein Werkzeug, das Verläufe
  ausgibt; die Liste ist ein Zwischenspeicher für dieses Werkzeug.
- **Keine anderen Hosts.** Nur `*://*.youtube.com/api/timedtext*`.
- **Kein zweites Werkzeug, keine neuen Fehlercodes.**
- **Kein Ersatz für `docs/33`.** Die Spurregel, das Menü und das Zurückstellen
  bleiben dort spezifiziert; diese Spec ändert nur die Herkunft der Adresse.

## Die Entscheidung des Betreibers (2026-11-12)

| Frage | Entscheidung |
|---|---|
| Wie kommt die Extension an die Adresse? | **selbst mitschneiden** — `webRequest`-Berechtigung ins Manifest, statt eine Timeline zu lesen, die für Seiten-Anfragen blind ist (M18) |
| Darf dafür eine Berechtigung dazukommen? | **ja** — ausdrücklich entschieden am 2026-11-12, nachdem gemessen war, dass der bisherige Weg live nicht trägt |
| Bleibt es bei „kein stiller Rückfall"? | **ja** — fehlt der Mitschnitt, antwortet das Werkzeug benannt |
| Warum kein Haken bei `document_start` statt einer Berechtigung? | der Weg ist **ungemessen** (`docs/33`, Open question 1: gemessen wurden nur Haken *nach* dem Laden, und die sahen nichts); er bräuchte einen Content-Script-Eintrag, der auf **jeder** Seite mitläuft, und einen Monkey-Patch im Seitenkontext. Der Mitschnitt ist die kleinere Änderung — und sieht er nichts, ist der Weg zu (Kriterium 10) |

## Die Messungen

**M18 (`docs/33`)** trägt diese Spec:

- `performance.getEntriesByType('resource')` enthält **keine**
  `api/timedtext`-Adresse — vor dem Spurwechsel nicht, danach nicht, bei
  Wiedergabe nicht, nach einem Sprung nicht.
- Ein `<img>`, das die Seite selbst anfordert, erscheint dort nicht; auf
  `example.org` in **beiden** Objekten (`performance` und
  `window.wrappedJSObject.performance`) je 1 Eintrag vorher und nachher.
- Die Untertitel **sind** da: der Player rendert sie, das Panel baute 133
  Segmente.
- Der Werkzeugaufruf endet deshalb mit `no_address`.

**Nicht gemessen und der Kern dieser Spec:** ob die Seite die Datei überhaupt
anfragt und ob `webRequest` sie sieht. Das entscheidet der Live-Lauf; bis
dahin ist die Annahme „die Anfrage existiert und ist beobachtbar"
**unbelegt** — genau wie M13 es war.

## Dependency changes

**Keine npm-Abhängigkeit.** Eine Manifest-Berechtigung:

| Änderung | Wert | Warum | Freigabe |
|---|---|---|---|
| `permissions` | `webRequest` **hinzu** | die Anfragen des Agenten-Tabs beobachten; ohne sie ist die Adresse nicht erreichbar (M18) | Betreiber, 2026-11-12 |

Nicht hinzu: `webRequestBlocking` (es wird nichts blockiert), keine neuen
Host-Rechte (`<all_urls>` ist vorhanden), kein natives Paket.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/manifest.test.js` | `manifest_requestsWebRequestWithoutBlocking` | `webRequest` steht genau einmal in `permissions`, `webRequestBlocking` **nicht** |
| `test/extension.test.js` | `transcript_captionWire_recordsTheAddress` | ein `timedtext`-Ereignis des Agenten-Tabs landet mit `lang`/`kind` im Speicher |
| `test/extension.test.js` | `transcript_captionWire_ignoresOtherHosts` | `example.com/api/timedtext` wird **nicht** aufgenommen |
| `test/extension.test.js` | `transcript_captionWire_ignoresOtherTabs` | ein Ereignis eines fremden Tabs wird **nicht** aufgenommen |
| `test/extension.test.js` | `transcript_captionWire_keepsTheLatestPerLanguage` | zwei Anfragen derselben Sprache: die **letzte** gewinnt |
| `test/extension.test.js` | `transcript_captionWire_survivesTabSwitch` | der Eintrag gilt für seinen Tab, nicht global |
| `test/extension.test.js` | `transcript_captionWire_forgetsOnClose` | beim Schließen des Tabs fällt sein Eintrag weg |
| `test/extension.test.js` | `transcript_captionWire_forgetsOnNavigate` | ein Eintrag zu einem anderen Video wird nicht benutzt |
| `test/extension.test.js` | `transcript_captionWire_forgetsTheOldestLanguage` | je Tab bleibt nur eine begrenzte Zahl von Sprachen |
| `test/extension.test.js` | `transcript_captionWire_resolvesOnALaterEvent` | ein Ereignis **während** des Wartens genügt (kein zweiter Versuch) |
| `test/extension.test.js` | `transcript_captionWire_ignoresForeignEventsWhileWaiting` | ein fremdsprachiges Ereignis beendet den Wartenden **nicht** (Regression zu B1) |
| `test/extension.test.js` | `transcript_captionWire_withoutAnEvent_shouldFail` | ohne Ereignis: `transcript_failed`, kein Rückfall |
| `test/extension.test.js` | `transcript_captionWire_readsTheAddress` | der Transkript-Pfad nimmt die Adresse aus dem Mitschnitt, nicht aus `performance` |
| `test/extension.test.js` | `transcript_captionUrl_doesNotLeakIntoTheAnswer` | die Antwort enthält kein `http` (bleibt aus `docs/33`) |
| `test/mcp.test.js` | `mcp_toolsCallBrowserTranscript_shouldNotLeakTheUrl` | bleibt grün (die Bridge sieht keine Adresse) |
| `npm test` | `# fail 0`, `# cancelled 0`, `# skipped 0` | nichts ist kaputt (unter Linux) |
| **live (Betreiber)** | Kriterium 8: `aircAruvnKk` → englische Segmente, beide Sprachfelder `en` | der Mitschnitt sieht, was die Timeline nicht sieht |
| **live (Betreiber)** | Kriterium 9: `wKv-g1uEoDY` → japanische Segmente, `requestedLanguage: "ja"` | die Regel im Nicht-en/de-Fall, mit dem neuen Weg |

## Acceptance criteria

1. **Die Berechtigung ist minimal.** `webRequest` steht genau einmal in
   `extension/manifest.json`, `webRequestBlocking` **nicht** (es wird nichts
   blockiert), kein neues Host-Recht. Beweis:
   `grep -c '"webRequest"' extension/manifest.json` ⇒ **1**;
   `grep -c 'webRequestBlocking' extension/manifest.json` ⇒ **0**;
   `grep -c 'webRequest' test/manifest.test.js` ⇒ **≥ 1**;
   `npm test 2>&1 | grep -c '^# skipped 0'` ⇒ **1** (auch die stille dritte
   Zeile wird gezählt, nicht nur `# fail 0` und `# cancelled 0`).
2. **Der Mitschnitt nimmt nur, was er soll, und liest nur den Agenten-Tab.**
   Das Filter-Muster steht am `addListener`, ein fremder Host wird abgewiesen,
   ein fremder Tab kommt nie in eine Antwort. Beweis:
   `grep -c 'api/timedtext\*' extension/background.js` ⇒ **1** (das Muster am
   Listener, nicht nur in der Prüffunktion);
   `grep -c 'transcript_captionWire' test/extension.test.js` ⇒ **12** (neun
   aus Stufe 2, drei aus Stufe 3);
   je einzeln gepinnt: `_ignoresOtherHosts` ⇒ **1**, `_ignoresOtherTabs` ⇒ **1**;
   `npm test` grün.
3. **Die letzte Anfrage je Sprache gewinnt, und Einträge gehören zu ihrem
   Tab.** Beweis: `grep -c 'transcript_captionWire_keepsTheLatestPerLanguage'
   test/extension.test.js` ⇒ **1**; `…_survivesTabSwitch` ⇒ **1**; `npm test`
   grün.
4. **Der Speicher wird nicht zum Verlauf.** Beim Schließen eines Tabs fällt
   sein Eintrag weg, ein Eintrag zu einem anderen Video wird nicht benutzt, und
   je Tab bleibt nur eine benannte Zahl von Sprachen. Beweis:
   `grep -c 'transcript_captionWire_forgetsOnClose' test/extension.test.js` ⇒
   **1**; `…_forgetsOnNavigate` ⇒ **1**; `…_forgetsTheOldestLanguage` ⇒ **1**;
   `grep -c 'TRANSCRIPT_CAPTION_WIRE_LIMIT' extension/background.js` ⇒ **≥ 2**;
   `npm test` grün.
5. **Kein `performance` mehr im Transkript-Pfad.** Beweis:
   `grep -c 'getEntriesByType' extension/background.js` ⇒ **0**;
   `grep -c 'transcript_captionWire_readsTheAddress' test/extension.test.js`
   ⇒ **1**; `npm test` grün.
6. **Die Adresse verlässt die Extension nicht.** Sie steht nicht in der
   Antwort, nicht in einer Fehlermeldung, nicht in `bridge/hub.mjs`. Beweis:
   `grep -c 'transcript_captionUrl_doesNotLeakIntoTheAnswer'
   test/extension.test.js` ⇒ **1**; `grep -c 'signature'
   test/extension.test.js` ⇒ **≥ 1** (die Zusicherung ist sichtbar);
   `grep -c 'transcript' bridge/hub.mjs` ⇒ **0** (Wächter, gilt schon heute);
   `git diff -- bridge/` ⇒ **leer**; `npm test` grün.
7. **Kein stiller Rückfall.** Fehlt der Mitschnitt für die Zielsprache, ist das
   `transcript_failed` mit eigener Meldung — kein Panel-Text, der wie ein
   Erfolg aussieht. Beweis:
   `grep -c 'transcript_captionWire_withoutAnEvent_shouldFail'
   test/extension.test.js` ⇒ **1** (der 404-Fall aus `docs/33` bleibt daneben
   grün); `npm test` grün.
8. **LIVE (Betreiber): der Mitschnitt trägt.** Auf `v=<video-en>` liefert
   `browser_transcript` englische Segmente, `requestedLanguage` und
   `deliveredLanguage` sind `en` — obwohl `performance` die Adresse nicht
   zeigt (M18). Beweis: die ersten drei Segmente wörtlich, beide Sprachfelder
   wörtlich.
9. **LIVE (Betreiber): ein Nicht-en/de-Video.** Auf `v=<video-ja>`
   japanische Segmente mit `requestedLanguage: "ja"`. Beweis: die ersten drei
   Segmente und der Wert des Feldes.
10. **Bleibt der Mitschnitt leer, ist diese Spec widerlegt.** Dann fragt die
   Seite die Datei nicht über `webRequest` sichtbar an, und der Weg zur
   Originalspur ist mit Bordmitteln zu — zurück in `## Open questions`, nicht
   in `## Bekannte Lücken`. Beweis: **Kriterium 8 allein** — die Bridge sieht
   keine Adresse, und die Extension darf über den Mitschnitt nichts loggen
   (`## Ziel`); einen zweiten Beleg gibt es bewusst nicht.
11. **Kein Produktcode außerhalb der Grenze.** Beweis:
    `git status --porcelain` ⇒ nur `extension/manifest.json`,
    `extension/background.js`, `test/manifest.test.js`,
    `test/extension.test.js`, `docs/…` — **kein** `test/fixtures/fake-extension.mjs`,
    kein `bridge/`-Eintrag, kein `test/mcp.test.js` (Wächter: eine enge Liste
    lässt einen Fremd-Diff auffallen); `git diff -- package.json` ⇒ leer.
12. **Kein Geheimnis.** Beweis:
    `git grep --untracked -nE '[0-9a-f]{32,}' -- .` ⇒ keine Ausgabe, Exit 1.

**Ausnahme mit Datum (2026-11-12).** Kriterium 8 und 9 sind nur im Profil des
Betreibers messbar (Extension-Reload, ein Aufruf in einer pi-Sitzung). Sie
werden **nach** dem Commit gemessen — die Ausnahme aus `CONTRIBUTING.md`,
`## Acceptance`. Die Kriterien 1–7, 11 und 12 laufen davor. **Kriterium 10 ist
der Sonderfall:** fällt 8 rot aus, ist die Kernannahme widerlegt und die Spec
geht zurück.

## Dev plan

**Der Zuschnitt.** Ein einziger Schritt ändert seine Herkunft: die signierte
`api/timedtext`-Adresse kommt nicht mehr aus
`performance.getEntriesByType("resource")` (live blind, `docs/33`, **M18**),
sondern aus einem Mitschnitt, den die Extension selbst führt
(`browser.webRequest.onBeforeRequest`). Der Weg drumherum — Gate, Modell,
Betreiberregel, Menüwahl nach dem Modellnamen, Sprung ±1 s, ein
Wiederholungsversuch, Spur vor Position zurück, `requestedLanguage`/
`deliveredLanguage`/`source` — wird **nicht** angefasst. Geändert werden die
Herkunft, der Ort des Wartens (vom Seiten-Schnipsel in den Hintergrund) und das
Fixture, das den Mitschnitt anstoßen muss.

**Was den Plan bindet** (gemessen und entschieden, nicht neu verhandelt): M18
(die Timeline zeigt die Anfrage nicht — auch nicht für ein `<img>` der Seite);
die Adresse ist signiert und bleibt in der Extension; `bridge/hub.mjs` bleibt
unangetastet; MV2 mit `persistent: true`; `webRequest` **ohne**
`webRequestBlocking`; Filter `*://*.youtube.com/api/timedtext*`; Menü-Anker
`.ytp-menuitem-content` (Gegenprobe `captionTracks + 2`);
`TRANSCRIPT_CAPTION_DEADLINE_MS = 3000`; ein Wiederholungsversuch;
`PROTOCOL.CALL_TIMEOUT_MS = 20000` bleibt das Budget des ganzen Laufs.

**Vor dem Bau gelesen** (Befunde aus den Dateien, keine Annahmen):

- `transcriptCaptionSource(request)` (`extension/background.js`, Marker
  `/*bc:transcript-caption*/`) macht heute drei Dinge in einem: Adresse suchen
  (`addressOf` über `performance`), auf ihr Erscheinen warten (die
  `while (address === null && Date.now() - startedAt < deadlineMs)`-Schleife am
  Ende), Cues holen und das Fenster anwenden. Nur die ersten zwei gehen;
  `paramOf`, `json3AddressOf`, `timeTextOf`, `textOf`, `cueOf` und die
  Fensterlogik (`docs/32`, Kriterium 3) bleiben **wörtlich**.
- **Drei** Berührungspunkte, nicht zwei: `readTranscriptFile(tab, request,
  deadlineMs)` wird bei `:6477` mit `0` gerufen (der „einmal hinsehen"-Blick)
  und in `seekAndReadTranscriptFile` mit der 3000-ms-Frist. Die **Frist
  bleibt**: `transcriptCaptionWaitFor(tab, target, 0)` heißt „einmal nachsehen,
  **nicht** abonnieren". `transcriptCaptionIsMissing`, die Regel „setzen, wenn
  `checkedName` ≠ Ziel, springen, wenn die Adresse fehlt" und der eine
  Wiederholungsversuch bleiben unverändert.
- Das Fixture kennt den Mitschnitt nicht: `createSandbox` baut seine
  `browser`-Stimme aus `createBrowserStub`, und dort fehlt `webRequest`.
  **Ohne Stub scheitert `background.js` beim Laden in allen Fällen der Testdatei** — der
  Stub kommt vor dem Code.
- `slotMapKeys()` (Fixture) behauptet, dass `background.js` **genau eine** `Map`
  baut (`operationsPerMap.size === 1`). Der Speicher darf deshalb **kein** `Map`
  sein.
- `tabs.listenerCount()` zählt ausschließlich `onUpdated`-Listener; **28**
  Zusicherungen im bestehenden Test erwarten dort `0`, `1` oder `2`. Ein
  dauerhafter `onUpdated`-Listener würde sie alle rot machen.
- `sendTranscript(socket, id, params)` wartet 1000 `setImmediate`-Runden auf die
  Antwort; die Timer der Hintergrund-Uhr (`FakeTimerClock`) werden dabei **nie**
  gedraint. Ein Warten im Hintergrund braucht also einen Umgang mit der Uhr —
  aber **keinen Drain im Helfer**: der wäre ein Rennen mit der 3000-ms-Frist
  (Stufe 2). Die betroffenen Fälle treiben die Uhr selbst
  (`clock.runByDelay(TRANSCRIPT_CAPTION_DEADLINE_MS)`), und die Suite prüft
  `# cancelled 0`, weil ein hängender Fall bei `# fail 0` grün bliebe
  (`CONTRIBUTING.md`, `## Acceptance`).
- `pageContextOf` gibt dem Transkript-Realm heute genau zwei Zusätze:
  `performance.getEntriesByType` und `fetch`; `createTranscriptPage({ resources })`
  und `transcriptResourceOf`/`createTranscriptResources` liefern die Adressen.
- `test/mcp.test.js` pinnt den Fehlersatz wörtlich (`TRANSCRIPT_FAILURE_REASON`,
  `TRANSCRIPT_FAILED_WITH_MESSAGE_TEXT`). Solange
  `noCaptionFileMessageFor(languageCode)` unverändert bleibt, ist die Bridge
  **nicht** nachzuziehen; `test/fixtures/fake-extension.mjs` ebenfalls nicht.
- `test/manifest.test.js` pinnt `MANIFEST.permissions` per `deepStrictEqual` im
  Fall `permissions_afterTheReadIncrement_shouldBeTabsStorageAndAllUrls`.
  `docs/05` nennt diesen Namen in seiner Geschichte — `docs/05` bleibt
  unangetastet, der Name ändert sich in `docs/34` (siehe unten).

---

**1. Die Berechtigung, mit ihrem Test in einer Zeile** (Umsetzer)

Dateien: `extension/manifest.json`, `test/manifest.test.js`.

- `"permissions": ["tabs", "storage", "<all_urls>", "webRequest"]` — **eine**
  Zeile, kein `webRequestBlocking`, kein neuer Host-Eintrag.
- In `test/manifest.test.js`:
  `permissions_afterTheReadIncrement_shouldBeTabsStorageAndAllUrls` wird
  **ersetzt** durch `manifest_requestsWebRequestWithoutBlocking` — ein Fall,
  nicht zwei: `deepStrictEqual(MANIFEST.permissions, ["tabs", "storage",
  "<all_urls>", "webRequest"])` **und**
  `assert.equal(MANIFEST.permissions.includes("webRequestBlocking"), false)`.
  `manifest_underMV2_shouldNotDeclareHostPermissions` bleibt wörtlich. Die Zahl
  der Fälle in der Datei bleibt damit 16.

Proof:

```
grep -c '"webRequest"' extension/manifest.json          # ⇒ 1
grep -c 'webRequestBlocking' extension/manifest.json    # ⇒ 0
grep -c 'webRequest' test/manifest.test.js              # ⇒ ≥ 1
node --test --test-reporter=tap test/manifest.test.js | grep -cE '^ok [0-9]+ - '   # ⇒ 16
node --test --test-reporter=tap test/manifest.test.js | grep -c '^# fail 0'        # ⇒ 1
npm run check; echo $?                                  # ⇒ 0
```

Dazu der Betreiber einmal von Hand: Extension neu laden — ein Manifest, das
Firefox ablehnt, ließe die Extension gar nicht erst starten; `browser_status`
antwortet danach wie vorher. (Kein Log, keine Adresse.)

---

**2. Der Mitschnitt und die neue Herkunft der Adresse** (Umsetzer)

Dateien: `extension/background.js`, `test/extension.test.js`.

Was entsteht — **erst das Fixture, dann der Code** (ohne Stub lädt
`background.js` nirgends mehr):

- `createTabsStub` bekommt `wire` (die vorgemerkten Ereignisse eines Falls) und
  `emitRequest({ tabId, url })`, das **jeden** eingetragenen Listener aufruft.
  `createBrowserStub` bekommt `webRequest: { onBeforeRequest: { addListener } }`:
  der Stub trägt ein und spielt danach die vorgemerkten Ereignisse ab — der
  Listener wird beim Laden von `background.js` eingetragen, also kommen die Seeds
  vor `connect()` an. Der Stub **filtert nicht** (Firefox filtert, nicht der
  Listener) — sonst bewiese `_ignoresOtherHosts` den Stub statt den Code.
- `createTabsStub.onRemoved` als **eigener** Listener-Satz (nicht der von
  `onUpdated`), damit `listenerCount()` und seine 28 Zusicherungen unberührt
  bleiben; `emitRemoved(tabId)` feuert nur die Listener und lässt den Tab im
  Store stehen, damit ein Fall noch beobachten kann, was der Eintrag des
  geschlossenen Tabs getan *hätte*.
- `createTranscriptPage` verliert `resources`, bekommt `wire`; `pageContextOf`
  verliert `performance.getEntriesByType` im Transkript-Zweig (ein Realm, der
  einen Kanal anbietet, den kein Schnipsel liest, ist eine Einladung);
  `transcriptResourceOf` bleibt (er baut die Adresse),
  `createTranscriptResources` wird `createTranscriptWire(tabId, tracks)`.
  `createTranscriptTabs(page)` schiebt `page.wire` in den Tab-Stub und setzt
  `page.emitRequest`; `createTranscriptMenuPage`s `onWrite` ruft
  `page.emitRequest({ tabId: page.tabId, url: transcriptResourceOf(track, …) })`
  statt `page.resources.push(…)` — die Signatur von `emitRequest` ist
  `({ tabId, url })`. Alle 51 Aufrufstellen von `createTranscriptTabs` (die 52. Fundstelle ist die
  Definition) und `connectedBackground` bleiben damit unverändert.
- **`sendTranscript` bleibt unverändert.** Ein Drain „solange die Antwort fehlt"
  wäre ein Rennen: im Menü-/Sprungpfad ist die 3000-ms-Uhr gestellt, während die
  Injektion läuft — ein Drain könnte sie feuern lassen, bevor `emitRequest`
  zurück ist, und der Erfolgsfall endete als `no_address`. Stattdessen treiben
  **die Fälle ohne passendes Ereignis** (`_ignoresOtherHosts`,
  `_ignoresOtherTabs`, `_withoutAnEvent_shouldFail`) die Uhr selbst: nach dem
  Emit `clock.runByDelay(TRANSCRIPT_CAPTION_DEADLINE_MS)`, dann antworten
  lassen.
- `extension/background.js`: Konstanten `TRANSCRIPT_CAPTION_WIRE_LIMIT = 8` (je
  Tab und Sprache; **gewählt, nicht gemessen**) und
  `TRANSCRIPT_CAPTION_WIRE_TAB_LIMIT = AGENT_TAB_LIMIT`; der Speicher ist ein
  Objekt ohne Prototyp (`Object.create(null)`, **kein** `Map`), Schlüssel ist die
  Tab-Id; Eintrag `{ address, languageCode, kind, tlang, videoId }`.
- `videoId` kommt aus dem `v=`-Parameter **der Adresse**, nicht aus
  `browser.tabs.get(tabId)` (ein Promise im synchronen Listener wäre der
  klassische Fehler); `tabId < 0` (Anfragen ohne Tab) wird **verworfen**.
- `transcriptCaptionWireOf(url)` (Null, wenn Host nicht `youtube.com`/
  `.youtube.com` oder Pfad nicht `/api/timedtext`),
  `recordTranscriptCaptionRequest(details)` (Adressen mit `tlang` werden
  **aufgenommen und markiert**, nicht verworfen — sonst wäre
  `_skipsTranslatedAddresses` nicht mehr prüfbar), pro Sprache überschreiben (die
  letzte gewinnt), Obergrenze je Tab, Obergrenze der Tabs.
- `transcriptCaptionWireLookup(tab, target)` — `lang` = Zielsprache, `kind=asr`
  genau dann, wenn `transcriptIsAutomaticTrack(target)`, `tlang` leer; `null`
  sonst.
- `transcriptCaptionWaitFor(tab, target, deadlineMs)`: **erst nachsehen, dann
  abonnieren** (das Ereignis des Sprungs liegt schon vor, wenn die Injektion
  zurückkommt). Bei `deadlineMs === 0` wird **nicht** abonniert und kein Timer
  gestellt; sonst `setTimeout` bis `deadlineMs`, beim Eintreffen gelöscht.
- `readTranscriptFile(tab, request, deadlineMs)` — Signatur **unverändert** — =
  `transcriptCaptionWaitFor` + Injektion mit der gefundenen Adresse; fehlt sie,
  `{ outcome: "no_address" }`.
- `transcriptCaptionSource({ address, offset, maxChars })`: `addressOf`, die
  `API_FRAGMENT`-Suche, `matchesKind`, die Warteschleife **und**
  `TRANSCRIPT_CAPTION_POLL_MS` samt `pollMs`-Feld (beide dienen nur ihr)
  **werden gelöscht**
  (nicht als toter Zweig stehen gelassen: `docs/33` hat denselben Schnitt am
  Panel-Schnipsel so entschieden, und ein zweiter Adresspfad ist beim nächsten
  Werkzeug der bequeme Weg zurück). `getEntriesByType` steht danach **0×** in der
  Datei.
- `watchTranscriptCaptionWire()` wird **vor** `void connect()` einmal aufgerufen
  (kein `console`, keine neue Startzeile — die Startzeile wird gepinnt).

Neue Fälle (Namen snakes_case, jeder genau **einmal** im Dateitext — auch nicht
in einem Kommentar, siehe `### What could go wrong`):
`transcript_captionWire_recordsTheAddress` (Ereignis mit `lang`/`kind` → die
Antwort nennt die Sprache aus ihm, `asr`-Spur trifft `kind=asr`),
`transcript_captionWire_ignoresOtherHosts` (Ereignis auf `example.com` →
benannter Fehler, nie diese Adresse),
`transcript_captionWire_ignoresOtherTabs` (Ereignis für Tab 101, Ziel in 500 →
`page.fetched` enthält nie die fremde Signatur; der Lauf muss springen, also
`page.video.writes` nicht leer),
`transcript_captionWire_keepsTheLatestPerLanguage` (zwei `en`-Adressen,
`expire=1`/`expire=2` → gefetcht wird `expire=2`),
`transcript_captionWire_forgetsTheOldestLanguage` (mehr Sprachen als
`TRANSCRIPT_CAPTION_WIRE_LIMIT` → die älteste ist weg),
`transcript_captionWire_withoutAnEvent_shouldFail` (kein Ereignis, kein Treffer →
`transcript_failed` mit `noCaptionFileMessageFor("en")`, zwei Versuche, kein
Rückfall),
`transcript_captionWire_readsTheAddress` (die Caption-Injektion trägt die
Adresse als **Argument**, die Antwort ist `ok`; dass kein Schnipsel mehr
nachsieht, belegt der Grep auf `extension/background.js`).
`transcript_captionUrl_doesNotLeakIntoTheAnswer` wird auf den Mitschnitt
umgestellt und prüft zusätzlich: die Antwort enthält weder `http` noch
`timedtext` noch `signature`.

Proof:

```
node --test --test-reporter=tap --test-name-pattern 'transcript_captionWire' test/extension.test.js | grep -cE '^ok [0-9]+ - transcript_captionWire'   # ⇒ 9
node --test --test-reporter=tap --test-name-pattern 'transcript_captionUrl' test/extension.test.js | grep -cE '^ok [0-9]+ - transcript_captionUrl'     # ⇒ 5 (unverändert)
grep -c 'getEntriesByType' extension/background.js          # ⇒ 0 (der Beweis; die Testdatei wird nicht gegrept — ein Fall, der die Abwesenheit zusichert, enthielte den Namen selbst)
grep -c 'browser.webRequest.onBeforeRequest.addListener' extension/background.js   # ⇒ 1
grep -c 'TRANSCRIPT_CAPTION_WIRE_LIMIT' extension/background.js                    # ⇒ ≥ 2
npm test; echo $?    # ⇒ 0; Ausgabe enthält "# fail 0" und "# cancelled 0"
```

---

**3. Grenzen: je Tab, beim Schließen, beim Videowechsel** (Umsetzer)

Dateien: `extension/background.js`, `test/extension.test.js`.

- `browser.tabs.onRemoved.addListener(forgetTranscriptCaptionWire)` — löscht die
  Einträge dieses Tabs (ein Tab, der geschlossen wird, behält nichts).
- `transcriptCaptionWireLookup` verwirft einen Eintrag, dessen `videoId` von der
  `v=`-Angabe der Tab-Adresse abweicht, und löscht ihn dabei. **Kein**
  `onUpdated`-Listener: 28 bestehende Zusicherungen zählen `onUpdated`-Listener,
  und ein `v`-Vergleich trifft den echten Fall (SPA-Wechsel) genauer als ein
  Ladeereignis.
- Fälle: `transcript_captionWire_survivesTabSwitch` (Einträge für 500 und 501,
  Aufruf mit `tab: 501` → gefetcht wird 501s Signatur),
  `transcript_captionWire_forgetsOnClose` (`emitRemoved(501)`, danach findet der
  Lauf für 501 die alte Adresse nicht mehr),
  `transcript_captionWire_forgetsOnNavigate` (Tab-Adresse zeigt auf ein anderes
  `v=` → alte Adresse wird nicht benutzt, der Lauf springt).

Proof:

```
node --test --test-reporter=tap --test-name-pattern 'transcript_captionWire' test/extension.test.js | grep -cE '^ok [0-9]+ - transcript_captionWire'   # ⇒ 12
grep -c 'browser.tabs.onRemoved.addListener' extension/background.js   # ⇒ 1
grep -c 'browser.tabs.onUpdated.addListener' extension/background.js   # ⇒ 1 (nur der Warte-Pfad; der Kommentar, der `tabs.onUpdated` nennt, bleibt und wird nicht gegrept)
npm test; echo $?    # ⇒ 0; "# fail 0" und "# cancelled 0"
```

---

**4. Abschluss, Abnahme und die Live-Messung** (Orchestrator; die Messung macht
der Betreiber)

`docs/34-spurendatei-beobachten.md`: `## Bekannte Lücken` fortschreiben (die zwei
Zahlen aus Stufe 2/3 sind **gewählt**; der Mitschnitt hört auch die eigene
`fetch`-Anfrage; Worker ungemessen), `## Amendments` ausführen und **entfernen**,
Prosa beschreibend, `status: active`; `docs/README.md` (Statuszeile 33 und 34),
`docs/PROJECT-STATE.md` pflegen; committen. Danach die Ausnahme mit Datum
(`CONTRIBUTING.md`, `## Acceptance`): Kriterien 8 und 9 im Profil des Betreibers. Fällt 8
rot aus, ist die Kernannahme widerlegt → zurück in `## Open questions`
(Kriterium 10).

Proof:

```
npm test; echo $?; npm run check; echo $?      # ⇒ 0, 0; "# fail 0", "# cancelled 0"
git grep --untracked -nE '[0-9a-f]{32,}' -- .  # keine Ausgabe, Exit 1
git status --porcelain                          # nur extension/manifest.json, extension/background.js,
                                                # test/manifest.test.js, test/extension.test.js, docs/…
git diff -- bridge/hub.mjs                      # leer
grep -n '^status:' docs/34-spurendatei-beobachten.md        # ⇒ status: active
grep -c '^## Amendments' docs/34-spurendatei-beobachten.md  # ⇒ 0
grep -c 'Performance-Einträge' docs/33-spurwahl.md          # ⇒ 0 (die Amendments sind wirklich ausgeführt)
```

Live (Betreiber): `v=<video-en>` → englische Segmente, beide Sprachfelder `en`;
`v=<video-ja>` → japanische Segmente, `requestedLanguage: "ja"` — je die ersten
drei Segmente wörtlich.

---

### What had to change in the Acceptance criteria

Der Architekt hat sie geprüft; vier Punkte waren **nicht so prüfbar, wie sie
dastanden** und sind in `## Acceptance criteria` korrigiert:

1. **Kriterium 5 (damals so numeriert) zählte einen Namen, der eine fremde Spec kippt.**
   `transcript_captionUrl_readsFromTheWire` fällt in die Familie
   `transcript_(captionUrl|cues)`, die `docs/33` in Kriterium 4 mit `⇒ 7` zählt;
   der neue Fall hätte daraus 8 gemacht und `docs/33` stillschweigend rot. Der
   Fall heißt jetzt `transcript_captionWire_readsTheAddress`.
2. **Kriterium 7 war heute schon grün** (`transcript_captionUrl_withoutMatch_shouldFail`
   existiert seit `docs/33` und prüft den 404-Weg, nicht den fehlenden
   Mitschnitt). Es zählt jetzt `transcript_captionWire_withoutAnEvent_shouldFail`.
3. **Kriterium 10 hatte keinen Befehl für seine zweite Hälfte** („der Hub-Befund,
   ob ein Ereignis ankam") — die Bridge sieht keine Adresse und die Extension
   darf nichts darüber loggen. Kriterium 8 allein entscheidet.
4. **`# skipped 0`** ist im Projekt bisher nirgends ausgewertet; es wird jetzt
   ausdrücklich mitgezählt (`grep -c '^# skipped 0'` ⇒ 1), statt als Zusage
   dazustehen.

Zur Klarstellung, weil es sonst wie eine Lücke aussieht:

- **Kriterium 2, „nur Tabs der Extension"**, ist zur *Aufnahmezeit* nicht
  entscheidbar: welche Tabs der Agent führt, steht in `storage.local` und ist
  asynchron (`readAgentTabIds`), ein `webRequest`-Listener ist synchron. Der
  Plan prüft es **beim Lesen**: gefragt wird immer nur der adressierte
  Agenten-Tab, und `transcript_captionWire_ignoresOtherTabs` beweist, dass ein
  fremder Tab nie in eine Antwort kommt. Der Speicher nimmt Ereignisse je Tab
  auf, ist aber durch die Tab- und Sprachgrenze gedeckelt — ein Verlauf entsteht
  nicht (Kriterium 4).
- **Kriterium 6 ist überwiegend Wächter, kein Beweis** (`grep -c 'transcript'
  bridge/hub.mjs` ⇒ 0 gilt schon). Der neue Beweis ist, dass die Adresse aus dem
  Mitschnitt nie in einer Antwort steht; das leistet der umgestellte Fall
  `_doesNotLeakIntoTheAnswer`.
- **`test/mcp.test.js` muss nicht nachgezogen werden**, solange
  `noCaptionFileMessageFor` wörtlich bleibt. Ändert jemand den Satz, werden dort
  **zwei** Konstanten rot — dann gehört die Änderung in diese Stufe.

### What could go wrong

- **Der Wartende ohne Umgang mit der Uhr endet als `cancelled`.** Die Fälle, in
  denen kein passendes Ereignis eintrifft (`_ignoresOtherHosts`,
  `_ignoresOtherTabs`, `_withoutAnEvent_shouldFail` und die zwei Stufe-3-Fälle),
  stellen die 3000-ms-Frist; sie treiben die Uhr **selbst**
  (`clock.runByDelay(TRANSCRIPT_CAPTION_DEADLINE_MS)`) und antworten dann. Ein
  Drain in `sendTranscript` wäre ein Rennen mit genau dieser Frist und ist
  verboten — er könnte sie feuern lassen, während die Injektion noch läuft.
  Beide Zeilen prüfen (`# fail 0` **und** `# cancelled 0`), wie `CONTRIBUTING.md` es
  verlangt.
- **Ein `Map` für den Speicher macht `slotMapKeys()` rot** („background.js must
  build exactly one Map"). Objekt ohne Prototyp nehmen.
- **Ein dauerhafter `onUpdated`-Listener** für „Tab navigiert" macht 28
  `listenerCount()`-Zusicherungen rot. Deshalb der `v`-Vergleich beim Lesen.
- **`grep -c` zählt Zeilen, nicht Vorkommen.** Wer einen der exakt gezählten
  Namen in einem Kommentar oder einer zweiten Meldung nennt, macht aus `⇒ 1`
  eine 2. Testnamen nur in der `test("…")`-Zeile.
- **Der Stub darf den Filter nicht nachbauen.** Filtert der Stub die Ereignisse,
  beweist `_ignoresOtherHosts` den Stub; filtert er nicht, muss der Code Host und
  Pfad selbst prüfen.
- **Die eigene `fetch`-Anfrage wird mitgeschnitten** (sie trifft denselben
  Filter, nur mit `fmt=json3`). Sie überschreibt den Eintrag mit der Adresse, die
  gerade benutzt wurde; der Wiederholungsversuch bleibt dadurch bei genau zwei
  Versuchen. Nicht als „der Player hat geholt" missdeuten.
- **Kein `console` im Mitschnitt.** Die Adresse darf nicht in eine Zeile
  geraten, und die Startzeile wird gepinnt.
- **Der Stub vor dem Code.** Ohne `browser.webRequest` im Sandbox-Stub scheitert
  `background.js` beim Laden und **jede** Datei wird rot.
- **Der Kern ist unbelegt** (M18 zeigt nur, dass die Timeline blind ist): sieht
  `webRequest` die Anfrage überhaupt, und sieht es auch einen Worker? Das
  entscheidet erst der Live-Lauf. Kein Rückfall einbauen — Kriterium 10 schickt
  die Spec in `## Open questions` zurück.

### Ordering and dependencies

1 → 2 → 3 → 4. Stufe 1 ist Voraussetzung für 2 nur insofern, als die
Berechtigung vor der Live-Messung im Manifest stehen muss; die Tests aus 2/3
laufen mit dem Stub auch ohne sie. Stufe 2 ist die große: sie tauscht Herkunft
**und** Ort des Wartens **und** das Fixture in einem Zug, weil der Speicher ohne
die Umstellung der Leseseite nicht beobachtbar ist (kein Testpfad, kein Log,
keine Antwort enthält eine Adresse). Stufe 3 setzt auf 2 auf und fügt nur Grenzen
hinzu; sie ist der Kandidat, den eine blockende Review-Runde halbiert (Schließen
zuerst, Videowechsel danach).

### What the next increment inherits

- **Die Worker-Frage** (`## Open questions` 1) und **Tabs des Betreibers**
  (`## Open questions` 2) bleiben offen; der Plan baut für beide nichts ein.
- **`TRANSCRIPT_CAPTION_WIRE_LIMIT = 8` und
  `TRANSCRIPT_CAPTION_WIRE_TAB_LIMIT` sind gewählt, nicht gemessen** — sie
  gehören nach `## Bekannte Lücken`, samt der Frage, was ein langer Profillauf
  mit vielen YouTube-Tabs kostet.
- **Der Videowechsel wird beim Lesen erkannt, nicht beim Navigieren** (kein
  `onUpdated`-Listener). Wer die 28 `listenerCount()`-Zusicherungen eines Tages
  aufgibt, kann das nachziehen.
- **Kein `onCompleted`, keine Header, keine Blockade, kein Verlaufswerkzeug** —
  die Berechtigung ist für genau diesen einen Leser da.
- **`docs/33` bleibt `proposed`**, sein Kriterium 12 bleibt rot, bis Kriterium 8
  dieser Spec grün ist; die zwei Amendments-Zeilen sind Sache des Abschlusses.
- **`test/mcp.test.js`, `test/fixtures/fake-extension.mjs`, `bridge/**`,
  `extension/protocol.js` bleiben unangetastet.** Ein Diff dort heißt, dass sich
  die Antwortform geändert hat — das ist nicht dieses Inkrement.

## Bekannte Lücken

Stand 2026-11-12, vor der Umsetzung; der Ortswechsel vom 2026-11-17 steht im
nächsten Abschnitt.

- **Der Kern war unbelegt und ist jetzt belegt:** `webRequest` sieht die
  `timedtext`-Anfrage (Kriterium 8 und 9 am 2026-11-12), obwohl `performance`
  sie nicht zeigte (M18). Ob die Anfrage aus einem **Worker** kam, ist weiter
  offen — sichtbar ist nur, dass sie ankommt.
- **Ungemessen: Worker.** Holt der Player die Cues aus einem Worker, ist
  offen, ob `webRequest` ihn sieht. Der Live-Lauf entscheidet; fällt er rot
  aus, ist das die erste Spur (Kriterium 10).
- **Ungemessen: Lebensdauer und Kosten des Mitschnitts** bei langer Sitzung
  und vielen Tabs. **Folge des Deckels:** sind mehr YouTube-Tabs offen, als
  `TRANSCRIPT_CAPTION_WIRE_TAB_LIMIT` erlaubt, kann der Eintrag des
  Agenten-Tabs verdrängt werden — das Werkzeug antwortet dann `no_address`,
  ohne dass der Agent etwas falsch gemacht hat.
- **Die Berechtigung ist sichtbar.** Firefox zeigt sie im Profil; der Agent
  schaltet sie nie selbst, sie steht im Manifest.

## Bekannte Lücken: Nach dem Umzug in den Brücken-Tab (2026-11-17)

`docs/42`, Stufe 2 hat den Mitschnitt aus der Hintergrundseite geholt. Die Lücke
ist damit eine andere geworden, nicht kleiner.

- **Der Mitschnitt lebt im Brücken-Tab, nicht mehr im Hintergrund.** Listener
  (`browser.webRequest.onBeforeRequest.addListener`) und Wartender
  (`transcriptCaptionWaitFor`) liegen im **selben** Kontext; es gibt kein
  Promise über einen Kontext, der verschwinden kann. Beweis:
  `transcript_captureAndWaiter_shouldLiveInTheSameContext` in
  `test/extension.test.js`; `background.js` hat keinen `webRequest`-Aufruf mehr
  (`grep -Fc 'webRequest' extension/background.js` ⇒ 0).
- **Die Lücke heißt jetzt „läuft nur, solange der Tab lebt“.** Wird der
  Brücken-Tab verworfen, neu geladen oder geschlossen, ist die Liste des
  Mitschnitts weg — sie war nie irgendwo gespeichert. Ein laufendes Warten
  stirbt mit dem Tab, statt aus einem zweiten Kontext weiterzuholen. Der Preis
  ist bezahlbar, weil der Weg den Mitschnitt selbst neu erzwingt: nach einem
  Sprung fragt der Player erneut, und der Wartende sieht diese Anfrage. Der
  Fehlerfall bleibt benannt (`transcript_failed`, „Spurendatei … nicht
  gefunden“), es gibt keinen stillen Rückfall.
- **Ein Eintrag für einen toten Tab ist keine Antwort.** Die Liste ist nach
  Tab-Kennung geschlüsselt und wird beim Schließen eines Tabs nicht
  aufgeräumt; gelesen wird sie deshalb erst, nachdem der Agenten-Tab aufgelöst
  wurde. Beweis:
  `transcript_capture_whenTheTabGoesAway_shouldNotResolveWithAGhostEntry`.
- **Der Deckel bleibt der alte.** `TRANSCRIPT_CAPTION_WIRE_TAB_LIMIT` gilt
  unverändert, und der Verdrängungsfall von oben bleibt damit bestehen.

## Open questions

1. **Sieht `webRequest` auch Anfragen aus einem Worker?** Nicht gemessen. Das
   Kriterium 8 entscheidet es faktisch; ob die Antwort „Worker" heißt, sagt
   erst der Live-Lauf mit einem Blick ins Hub-Log.
2. **Soll der Mitschnitt aufnehmen, was der Betreiber in seinen eigenen Tabs
   tut?** Diese Spec sagt: **ja, aber knapp** — aufgenommen wird je Tab das
   Letzte seiner Sprache (gedeckelt), **gelesen** wird nur der Agenten-Tab. Die
   Alternative (gar nicht aufnehmen) bräuchte einen synchronen Spiegel der
   Agenten-Tab-Liste im Hintergrund; das wäre eine eigene Entscheidung.

## Review

### Runde 1 — 2026-11-12, `grizzled-senior-dev`: 🔧 Fix these

Ziel und Kriterien hat der Betreiber am 2026-11-12 abgesprochen (vor dem
Dev-Plan, `## Log`); danach ging die Spec mit Dev-Plan durch das Gate. Drei
Blocker, sechs Major, neun Minor, drei Nits — **alle übernommen**; die
Einzelzeilen stehen in `## Log`.

## Log

Je Befund eine Zeile (aus `CONTRIBUTING.md`, Schritt 4).

- **2026-11-12, Absprache (Betreiber):** Ziel und Kriterien von `docs/34` sind
  vor dem Dev-Plan bestätigt worden („Ja, so bauen") — die Berechtigung, der
  Mitschnitt, nur Agenten-Tabs zu lesen, und kein stiller Rückfall.
- **Abnahme 2026-11-12: beide Live-Kriterien grün.** Kriterium 8 (`v=<video-en>`):
  englische Segmente, `en`/`en`, 18 430 Zeichen. Kriterium 9 (`v=<video-ja-2>`):
  japanische Segmente („皆さんこんにちは！…"), `ja`/`ja`. Auf dem Weg dahin drei
  gemessene Löcher geschlossen (fehlender Originalspur-Index, `>>`-Suffix am
  Menüeintrag, zwei Spuren einer Sprache ohne Index). **`status: active`.**
- **Live 2026-11-12: Kriterium 8 grün** — auf `v=<video-en>` englische
  Segmente, `requestedLanguage`/`deliveredLanguage` = `en`, `source =
  ytplayer.bootstrapPlayerResponse`, `totalChars` 18 430. **Der Mitschnitt
  trägt**; der Weg, der laut M18 nicht ging, geht jetzt.
- **Live 2026-11-12: Kriterium 9 rot, aber nicht am Mitschnitt** — auf
  `v=<video-ja>` bricht `transcriptOriginalAudioTrackOf` ab: ein Audiotrack,
  ohne `audioTrackId`. Betreiberentscheid am selben Tag: genau ein Track ⇒
  Original. Umgesetzt und mutationsgeprüft; das erneute Messen braucht einen
  weiteren Extension-Reload.
- **Live 2026-11-12: zwei weitere Löcher gefunden und geschlossen** — beide im
  Menü-Weg, nicht im Mitschnitt: fehlt der `defaultCaptionTrackIndex` und gibt
  es genau eine Untertitelspur, ist die die Originalspur; und die Menüzeile
  trägt bei Auto-Übersetzung ein `>> …`, das der Anker abschneidet (Gegenprobe
  zählt den Paar-Eintrag mit). Fälle: `transcript_languageForTrack_withASingleCaptionTrackAndNoIndex`,
  `transcript_captionRow_withATranslatedSuffix_stillFindsTheRow`,
  `_withAPairEntry_countsOneMore`, `_miscountWithAPairEntry_namesTheRealCount`.
- **Live 2026-11-12: drittes Loch im Menü-/Spurweg geschlossen** — auf
  `v=<video-ja-2>` fehlt der `defaultCaptionTrackIndex`, und es gibt **zwei**
  Spuren derselben Sprache (`ja` manuell + ASR). Jetzt entscheidet die
  Rangfolge der englischen Spur (manuell vor ASR, zwei manuelle ⇒ Fehler);
  verschiedene Sprachen ohne Index bleiben ein benannter Fehler.
- **Stufen 1 und 2 (2026-11-12) gebaut:** `webRequest` im Manifest, Mitschnitt
  im Hintergrund, Adresse als Argument in die Lese-Injektion, `performance`
  gelöscht. 729 Tests grün.
- **Code-Review Runde 1 (Stufen 1+2) — B1 übernommen:** `settleTranscriptCaptionWaiters`
  löste **jeden** Wartenden bei **jedem** Ereignis auf (auch mit `null`) —
  ein fremdsprachiges Ereignis machte aus einem korrekten Lauf ein
  `no_address`. Jetzt wird nur bei Treffer aufgelöst.
- **Code-Review Runde 1 — M1 übernommen:** der Wartepfad mit Timer war von
  keinem Fall gedeckt; zwei neue Fälle treffen das Ereignis **während** des
  Wartens (`_resolvesOnALaterEvent`, `_ignoresForeignEventsWhileWaiting`), beide
  mutationsgeprüft.
- **Code-Review Runde 1 — m1 bis m3 übernommen:** `m.youtube.com`-Kommentar an
  die Wirklichkeit angepasst, `videoId`-Kommentar nennt Stufe 3 und verbietet
  `""` als „passt zu allem", die Testkopie der 3000 ms ist begründet.
- **Runde 1 — B1 übernommen:** der Proof `grep -c 'getEntriesByType'
  test/extension.test.js ⇒ 0` fiel weg; ein Fall, der die Abwesenheit
  zusichert, enthielte den Namen selbst. Der Grep auf `extension/background.js`
  bleibt der Beweis.
- **Runde 1 — B2 übernommen:** `## Ziel` sagt jetzt, dass **aufgenommen** wird
  (je Tab, gedeckelt) und **gelesen** nur der adressierte Agenten-Tab; Kriterium
  2 prüft das beim Lesen; Open question 2 ist so beantwortet.
- **Runde 1 — B3 übernommen:** `readTranscriptFile(tab, request, deadlineMs)`
  behält seine Signatur; `deadlineMs === 0` heißt „einmal nachsehen, nicht
  abonnieren". Drei Berührungspunkte statt zwei.
- **Runde 1 — M1 übernommen:** der `onUpdated`-Proof zählt
  `browser.tabs.onUpdated.addListener` (⇒ 1), nicht das Wort.
- **Runde 1 — M2 übernommen:** die Amendments haben vier Zeilen (auch
  `## Ziel`-Weg und Dev-Plan-Stufe 1), und Stufe 4 prüft
  `grep -c 'Performance-Einträge' docs/33-spurwahl.md` ⇒ 0.
- **Runde 1 — M3 übernommen:** kein Drain in `sendTranscript` (Rennen mit der
  3000-ms-Uhr); die betroffenen Fälle treiben die Uhr selbst. **Nachbesserung
  (Runde 2):** die zwei übrigen Stellen — „Vor dem Bau gelesen" und „What could
  go wrong" — sagten noch das Gegenteil und sind jetzt angeglichen.
- **Runde 1 — M4 übernommen:** Kriterium 4 pinnt `_forgetsOnNavigate` und
  `_forgetsTheOldestLanguage`; Kriterium 2 die genaue Fallzahl (7).
- **Runde 1 — M5 übernommen:** Kriterium 2 prüft das Filter-Muster am
  `addListener` (`api/timedtext*`).
- **Runde 1 — M6 übernommen:** die Absprache ist hier mit Datum eingetragen.
- **Runde 1 — m1 bis m9 übernommen:** Wächter gekennzeichnet, Allowlist
  verengt (`fake-extension.mjs` raus, `-- bridge/` statt `-- bridge/hub.mjs`),
  `# skipped 0` wird mitgezählt, `videoId` kommt aus dem `v=`-Parameter,
  `tabId < 0` wird verworfen, „51 Aufrufstellen", `emitRequest({ tabId, url })`,
  `TRANSCRIPT_CAPTION_POLL_MS` fällt mit, `document_start`-Haken in der
  Entscheidungstabelle begründet.
- **2026-11-12, Betreiberentscheid:** `webRequest` einführen statt weiter eine
  Timeline zu lesen, die für Seiten-Anfragen blind ist (M18). Aufgenommen in
  `## Ziel`, `## Dependency changes` und Kriterium 1.
