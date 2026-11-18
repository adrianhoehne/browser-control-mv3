---
description: Das Manifest auf MV3 — scripting statt executeScript, host_permissions statt permissions, und eine Messung, die belegt, dass die Verbindung im Tab wirklich hält.
status: proposed
---

# Das Manifest auf MV3

**Roadmap-Zeilen 27 und 28.** `docs/42` hat den Socket in den Tab gebracht und
die Injection-Naht auf den MV3-Vertrag umgebaut. Jetzt wird das Manifest
umgestellt — und danach **gemessen**, nicht gefeiert.

**Voraussetzung:** `docs/42` ist gebaut. Ohne den Tab stirbt der Socket mit der
Eventpage; das Manifest zu wechseln, bevor der Tab steht, wäre die Umstellung
von „funktioniert" auf „funktioniert nicht".

## Ziel

- **`manifest_version: 3`**, `background` als Eventpage (ohne `persistent`),
  `scripting` in `permissions`, `<all_urls>` in `host_permissions`.
- **`browser.scripting.executeScript`** statt `browser.tabs.executeScript` — die
  Aufrufstelle ist vorbereitet (`docs/42`, Stufe 2), hier wird sie umgestellt.
- **Die Kriterien von `docs/02` werden bewusst umgestellt**, nicht gelöscht: der
  Messbeleg (30,0 s) bleibt stehen, die Behauptung „persistent löst das" wird zu
  „der Tab löst das".
- **Gemessen:** 8 h Leerlauf, Tab-Neustart, Tab-Discard, Browser-Neustart,
  Mitschnitt nach dem Einschlafen des Hintergrunds.

## Non-goals

- **Kein Schalter, keine Icons, kein `goodbye`.** Das ist `docs/44`.
- **Keine neue Berechtigung außer `scripting`** — und die ist eine
  Betreiberentscheidung, siehe unten.
- **Keine Änderung an der Bridge**, kein neues Protokoll, kein neuer Close-Code.
- **Kein Signieren.** MV3 macht es möglich, `docs/ROADMAP.md` 23/24 macht es.
- **Keine kleinere Reichweite** (Roadmap 25).

## Das Inventar (nach `docs/42`)

| Was | Stand |
|---|---|
| `extension/manifest.json` | MV2, `background.persistent: true`, keine `host_permissions` |
| `test/manifest.test.js` | 16 Fälle; mehrere **nageln MV2 fest** (`manifest_version === 2`, `persistent === true`, kein `host_permissions`) |
| Injection | eine Aufrufstelle, 16 Aufrufer; seit `docs/42` über `page-agent.js` und `{op, args}` |
| Hintergrund | Koordinator, hält keinen Zustand, darf sterben |
| Parität | sieben **eingefrorene** Artefakte, `--record` verweigert; Peer ist `test/fixtures/fake-extension.mjs` |

## Die Berechtigungen

| Heute (MV2) | Künftig (MV3) | Warum |
|---|---|---|
| `permissions: ["tabs","storage","<all_urls>","webRequest"]` | `permissions: ["tabs","storage","webRequest","scripting"]` + `host_permissions: ["<all_urls>"]` | `scripting.executeScript` braucht `scripting`; Host-Rechte sind in MV3 ein eigener Schlüssel |

**`scripting` ist eine neue Berechtigung** — die einzige in diesem Inkrement. Sie
ist **entschieden** (2026-11-17): der Betreiber nimmt sie, weil ohne sie sieben
von dreizehn Werkzeugen wegfallen. Die verworfene Alternative steht in
`## Verworfene Alternative`.

## Verworfene Alternative: ein deklariertes Content-Script

Statt `scripting` könnte `page-agent.js` als `content_scripts`-Eintrag mit
`<all_urls>`, `all_frames` und `match_about_blank` im Manifest stehen. Das
braucht die Berechtigung nicht und erreicht dieselben Werkzeuge über
`tabs.sendMessage(tabId, msg, {frameId})` (die Antwort trägt `sender.frameId`).

**Verworfen am 2026-11-17, mit Gründen:**

- Das Script liegt dann **auf jeder Seite ab dem Laden**, auch wenn der Agent
  nichts tut — sichtbar im Add-on-Dialog als „läuft auf allen Seiten".
- Bereits offene Tabs kennen es erst nach einem Reload.
- Aus „injiziere jetzt" wird „frage, ob jemand zuhört": ein Fehlerfall mehr in
  jedem der 16 Aufrufer.
- **Der Datengewinn ist null:** `scripting` öffnet keine Daten, die `<all_urls>`
  nicht schon öffnet. Es ist eine zweite Berechtigungszeile für eine Fähigkeit,
  die MV2 über `tabs` gegeben hat.

## Was die Umstellung im Code bedeutet

1. **Manifest:** drei Schlüssel ändern sich, `background` verliert `persistent`
   und die `scripts`-Liste wird zur Eventpage.
2. **Injection:** `browser.tabs.executeScript(tabId, {code, …})` →
   `browser.scripting.executeScript({target: {tabId, frameIds|allFrames},
   files: ["page-agent.js"]})` beziehungsweise `func`. Die Antwortform ändert
   sich: MV2 gab je Frame einen Wert, MV3 gibt `{frameId, result}`.
   `framesOf` und der Frame-Filter (`docs/24`) entscheiden nach **Inhalt** — sie
   dürfen keine leeren Einträge sehen.
3. **Tests:** `test/manifest.test.js` bekommt neue Pins (MV3, `scripting`,
   `host_permissions`, kein `persistent`, `page-agent.js` in den web-accessible
   resources, falls nötig); `test/extension.test.js`-Stubs sprechen
   `tabs.executeScript` an und brauchen `scripting`.
4. **Action-Block und API-Namespace ziehen mit.** Hat `docs/44` schon gebaut,
   steht `browser_action` im Manifest; MV3 verlangt `action`. Der Namespace
   ändert sich mit: `browser.browserAction.setIcon` ist unter MV3 `undefined`,
   das Icon bliebe stumm und kein Test merkte es. `test/manifest.test.js` bindet
   den Schlüssel an `manifest_version`.

## Risiken

1. **`host_permissions` sind nicht automatisch erteilt.** Nach dem Upgrade muss
   Firefox die Rechte bestätigen; ohne Grant liest `browser_read` nichts.
   Deshalb ein Kriterium mit `browser.permissions.contains({origins:
   ["<all_urls>"]})` ⇒ `true`.
2. **`page-agent.js` muss web-accessible sein**, weil es per `files` injiziert
   wird. Fehlt der Eintrag, schlägt jede Injection fehl und alle Werkzeuge
   antworten `not_readable` — der Betreiber sieht das in Kriterium 6.
   **`bridge.html` und `bridge.js` gehören nie dorthin** — sie tragen Token und
   Sitzung, und ein `"resources": ["*"]` machte sie für jede Webseite ladbar.
3. **Die Eventpage schläft weiter** — sie darf es. Jeder Zustand, der einen
   Schlaf überleben muss, gehört in `storage.local` oder in den Tab; ein
   In-Memory-Feld im Hintergrund ist ab hier ein Fehler.
4. **`webRequest` in MV3 ist Nur-Lese.** Der Listener bleibt ohne
   `webRequestBlocking`; die Mitschrift aus `docs/34` ist davon nicht betroffen,
   weil sie nie blockiert hat.
5. **Die Fixture ist zweifach verheiratet** (Peer von `npm test` und Parität).
   Sie wird nicht angefasst; `--record` ist verweigert.

## Touch boundary

**Erlaubt:** `extension/manifest.json`, `extension/background.js`,
`extension/bridge.js` (Injection-Aufrufe), `extension/page-agent.js`,
`test/manifest.test.js`, `test/extension.test.js`, `test/ci/e2e.test.js`,
`docs/02`, `docs/43`, `docs/README.md`, `docs/PROJECT-STATE.md`, `CHANGELOG.md`.
`docs/36`, `docs/40` und `docs/42` gehören zu `docs/42` und werden hier **nicht**
angefasst.

**Nicht:** `bridge-rs/**`, `test/fixtures/**`, `scripts/parity/**`,
`extension/options.*`, `deploy/**`.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/manifest.test.js` | `manifest_shouldDeclareVersionThree` | `manifest_version: 3` |
| `test/manifest.test.js` | `manifest_shouldNotClaimAPersistentBackground` | kein `persistent` — der Grund von `docs/02` ist entfallen, nicht vergessen |
| `test/manifest.test.js` | `manifest_shouldAskForScriptingAndHostPermissions` | `scripting` in `permissions`, `<all_urls>` in `host_permissions`, nicht mehr in `permissions` |
| `test/manifest.test.js` | `manifest_shouldExposeThePageAgent` | `page-agent.js` steht in `web_accessible_resources`, und **nicht** `bridge.html`/`bridge.js` |
| `test/extension.test.js` | die 16 Aufrufer gegen `scripting` gestubbt | die Werkzeuge antworten unverändert, `{frameId, result}` wird gelesen |
| `test/extension.test.js` | `frames_withEmptyResultEntries_shouldNotShiftTheFilter` | der Frame-Filter entscheidet nach Inhalt, nicht nach Position |

## Acceptance criteria

**Kriterien 1–5 entscheidet der Umsetzer, 6–9 der Betreiber.**

1. **Das Manifest ist MV3.** `node -e "const m=require('./extension/manifest.json');
   console.log(m.manifest_version, Boolean(m.background.persistent),
   m.permissions.includes('scripting'), (m.host_permissions||[]).includes('<all_urls>'),
   JSON.stringify(m.web_accessible_resources).includes('page-agent.js'),
   JSON.stringify(m.web_accessible_resources).includes('bridge.js'))"` ⇒
   `3 false true true true false` (der letzte Wert: `bridge.js` steht **nicht**
   in den web-accessible resources).
2. **Die alte API ist weg, die neue steht genau einmal da.**
   `grep -Fc 'browser.tabs.executeScript(' extension/bridge.js
   extension/background.js` ⇒ **0** in beiden Dateien (der Werkzeugpfad liegt
   nach `docs/42` in `bridge.js`); `grep -Fc 'browser.scripting.executeScript('
   extension/bridge.js` ⇒ **1** (eine Aufrufstelle, 16 Aufrufer). Die zwei
   Kommentare, die den alten Namen nennen, werden mit umgeschrieben.
3. **Die Tests stellt der Umbau bewusst um.** `node --test --test-reporter=tap
   test/manifest.test.js` ⇒ `# fail 0`, und die vier neuen Fälle sind darin
   namentlich grün.
4. **Die Werkzeuge antworten unverändert.** `npm test` ⇒ `# fail 0`,
   `# cancelled 0`; die 16 Aufrufer laufen gegen den `scripting`-Stub.
5. **Die Parität bleibt.** `scripts/parity.sh --impl rust --check` ⇒ `7/7 wie
   erwartet`, `--self-test` ⇒ `7/7 rot wie erwartet`.
6. **Firefox erteilt die Rechte.** (Betreiber.) In der Konsole der Erweiterung
   (`about:debugging` → **Inspect** → Konsole, nicht die Seitenkonsole):
   `browser.permissions.contains({origins: ["<all_urls>"]})` ⇒ `true`. Danach
   `browser_read` auf eine echte Seite ⇒ Text, kein `not_readable`. Liefert
   `contains` `false`, erteilt der Betreiber die Rechte in `about:addons` neu
   (Add-on öffnen → Berechtigungen) — ohne sie liest nichts.
7. **Die Verbindung hält 8 Stunden.** (Betreiber.) Wie `docs/42`, Kriterium 9:
   Zeitstempel `T1`, Fenster `T1 … T1+8 h`, `connected` ⇒ **1**,
   `disconnected` ⇒ **0**, `ss -Htn state established '( sport = :8110 )'` ⇒
   **1** Zeile.
8. **Der Hintergrund darf schlafen, die Verbindung nicht.** (Betreiber.) 5 min
   ohne Interaktion, dann `browser_status` ⇒ Antwort; im Log keine neue
   `extension disconnected`-Zeile in dieser Zeit.
9. **Der Mitschnitt überlebt den Schlaf.** (Betreiber.) Seite mit
   `api/timedtext` laden, 30 s warten, `browser_transcript` ⇒ Original-Adresse
   gefunden; ohne Adresse heißt die Antwort `no_address`.

## Dev plan

**Stufe 1 — Manifest und Injection**

Dateien: `extension/manifest.json`, `extension/background.js`,
`extension/bridge.js`, `test/manifest.test.js`, `test/extension.test.js`.

Beweis: Kriterien 1, 2, 3, 4, 5.

**Stufe 2 — `docs/02` nachziehen**

Dateien: `docs/02-persistenter-background.md`.

Die Kriterien von `docs/02` bekommen den einen Satz „gilt bis `docs/43`"; der
Messbeleg bleibt **stehen** — ein Messprotokoll schreibt man nicht um. Der Satz
steht genau einmal, damit der Beweis oben nicht vakuum-grün wird. `docs/36` und `docs/40`
gehören zu `docs/42` und werden hier **nicht** angefasst.

Beweis: `grep -c 'gilt bis' docs/02-persistenter-background.md` ⇒ **1**, und der
Messwert `30,0 s` steht weiterhin dort (`grep -c '30,0 s'` ⇒ ≥ 1).

**Stufe 3 — die Messung**

Dateien: `docs/43`, `docs/PROJECT-STATE.md`.

Beweis: Kriterien 6, 7, 8, 9 mit Zeitstempeln.

## Bekannte Lücken

- **Nichts ist gemessen.** Der Tab ist gebaut, das Manifest nicht.
- **Die Eventpage darf schlafen — ob sie es tut, entscheidet Firefox.** Kriterium
  8 prüft die Folge (Verbindung bleibt), nicht den Schlaf selbst.
- **`web_accessible_resources` ist der Preis für `files`.** Der Eintrag macht
  `page-agent.js` für Webseiten ladbar (nicht die Brücke, siehe Risiko 2) — das
  ist bewusst und steht im Manifest-Test.

## Open questions

**Keine.** Am 2026-11-17 entschieden: `scripting` kommt dazu, das deklarierte
Content-Script ist verworfen (Gründe im Abschnitt oben).

## Review

### Runde 1 — 2026-11-17, `grizzled-senior-dev`: 🔧, Blocker dabei

Acht Befunde: Kriterium 2 fiel heute durch (`grep -c` über mehrere Dateien,
Kommentar-Treffer); `web_accessible_resources` widersprach sich („muss" gegen
„falls"); der Action-Block und der API-Namespace fehlten ganz; „In der Konsole"
nannte keinen Ort und keinen Fehlerweg; `bridge.html`/`bridge.js` gehörten
ausdrücklich **nicht** in die web-accessible resources; Stufe 2 fasste
`docs/36`/`docs/40` an (die gehören zu `docs/42`); `docs/02` wäre zweimal
geschrieben worden; die Review-Zeile hatte kein Datum.

**Übernommen:** Kriterium 2 mit `grep -Fc` und den zwei Kommentaren;
`web_accessible_resources` wird in Stufe 1 **gemessen** statt vermutet, mit der
Verbotszeile für `bridge.html`/`bridge.js`; Action-Schlüssel und
`browser.browserAction`→`browser.action` stehen jetzt in der Umstellungsliste;
Kriterium 6 nennt `about:debugging` → Inspect und den Weg zurück über
`about:addons`; Stufe 2 fasst nur `docs/02` an; die Review-Zeile hat Datum und
Verdict.

## Log

- **2026-11-17, Betreiberentscheid:** `scripting` wird genommen. Ohne sie fielen
  `read`, `click`, `type`, `inspect`, `eval`, `frames` und `transcript` weg, dazu
  das `settle` von `navigate` und `open_tab`. „Ich will auf Features nicht
  verzichten."
- **2026-11-17, Abspaltung:** war Stufe 2 der gemeinsamen MV3-Spec; nach dem
  Review-Block geteilt (Roadmap 27+28).
