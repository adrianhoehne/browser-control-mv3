---
description: Die Erweiterung auf MV3 — der Socket lebt in einem eigenen Tab, weil Firefox die Eventpage nach 30 Sekunden entlädt; der Hintergrund koordiniert.
status: proposed
---

# Die Migration auf MV3

`docs/02` hat MV2 **gewählt**, weil Firefox die MV3-Eventpage nach 30 Sekunden
Leerlauf entlädt und eine offene WebSocket-Verbindung **nicht** als Aktivität
zählt. Dort steht als Non-Goal: „Kein Socket im Tab. Ein immer offener Tab, der
die Verbindung hält, ist ein **Kandidat** für eine eigene Spec (und dort mit dem
Betreiber zu entscheiden)."

Diese Spec ist diese Entscheidung. Sie kehrt das Non-Goal von `docs/02` um und
macht den Tab zur tragenden Idee.

**Warum überhaupt:** eine unsignierte Erweiterung ist nach jedem Firefox-Neustart
weg (`about:debugging`), und AMO nimmt für neue Einreichungen nur noch MV3 an
(`docs/ROADMAP.md`, 23/24). Ohne diese Migration gibt es keine signierte
Auslieferung.

## Die Messung, auf der alles ruht

Aus `docs/02`, am 2026-10-23 mit dem Bridge-Log belegt:
`extension connected` 16:00:30.471 → `extension disconnected reason=1001`
16:01:00.496 — **genau 30,0 s**, danach 4,5 Minuten nichts bis zum manuellen
Reload. Eine offene WebSocket hält die Eventpage nicht am Leben.

Daraus folgt der Zuschnitt: **Wer den Socket hält, muss in einem Tab leben.**
Ein Tab wird nicht nach 30 Sekunden Leerlauf entladen.

## Ziel

- **Der Socket lebt in einem Erweiterungs-Tab** (`bridge.html`), nicht im
  Hintergrund. Mit ihm ziehen die Sitzung, der Tab-Store und die
  Werkzeugausführung dorthin — wer die Verbindung hat, hat die Arbeit.
- **Der Hintergrund wird Koordinator** und darf sterben: er sorgt dafür, dass
  der Brücken-Tab existiert (anlegen, wieder öffnen), und hält die
  `webRequest`-Mitschrift.
- **`manifest_version: 3`**, mit `scripting` statt `tabs.executeScript` und
  `<all_urls>` in `host_permissions`.
- **Das Wire-Protokoll bleibt unverändert.** Bridge, Hub und die dreizehn
  Werkzeuge merken von der Migration nichts; die Parität (`7/7`) bleibt der
  Maßstab.
- **Gemessen, nicht behauptet:** die Verbindung hält über Stunden, überlebt
  einen Tab-Neustart und einen Browser-Neustart, und der Betreiber sieht den
  Brücken-Tab.

## Non-goals

- **Kein Signieren.** MV3 ist die Voraussetzung dafür, nicht die Signierung
  selbst (Roadmap 23/24).
- **Keine kleinere Reichweite** — `<all_urls>` bleibt, nur an anderer Stelle im
  Manifest (Roadmap 25 ist eine eigene Entscheidung).
- **Kein neues Protokoll, keine Bridge-Änderung, kein neuer Close-Code.**
- **Kein Umzug der Optionsseite** und keine Änderung an ihren Feldern.
- **Kein `browser.alarms`-Wachhalten** des Hintergrunds: das wäre derselbe
  Wechselspiel-Fehler wie in `docs/02`.

## Das Inventar (aus dem Code gelesen, 2026-11-17)

| Was | Stand |
|---|---|
| `extension/manifest.json` | `manifest_version: 2`, `background.scripts: ["protocol.js","background.js"]`, `persistent: true`, `permissions: ["tabs","storage","<all_urls>","webRequest"]`, kein `host_permissions`, kein `browser_action` |
| `extension/background.js` | **7 032 Zeilen**, eine IIFE; Sitzung, Tab-Store, Werkzeuge, Logzeilen |
| Socket | `let socket = null` (Zeile 506), Aufbau `new WebSocket(settings.endpoint)` (619), Abbau (6992) |
| `executeScript` | genau **eine** Aufrufstelle (`injectPageCode`, Zeile 2187), aber **17** Aufrufer dieses Helfers |
| `captureTab` | eine Stelle (5083) — Firefox-eigen, bleibt in MV3 |
| `webRequest` | `onBeforeRequest` für `*://*.youtube.com/api/timedtext*` (5679), ohne Blockieren |
| Browser-APIs | `storage.local` (7×), `tabs.update` (3×), `windows.getAll` (2×), `tabs.onUpdated` (2×), `runtime.getManifest` (2×), je 1× `windows.get`/`windows.update`/`tabs.get`/`tabs.create`/`tabs.remove`/`tabs.captureTab`/`executeScript`/`webRequest`/`runtime.getBrowserInfo` |
| `test/extension.test.js` | **16 343 Zeilen**, lädt `background.js` in eine `vm`-Kontext mit gestubbten Browser-APIs |
| `test/manifest.test.js` | **16** Fälle, davon mehrere, die MV2 **festnageln** (`manifest_version === 2`, `persistent === true`, kein `host_permissions`) — `docs/02` sagt: wer zurückwechselt, ändert sie bewusst |
| E2E-Seam | `scripts/e2e/build-test-extension.mjs` patcht `background.js` an zwei Zeilen (Endpunkt, Token) — **zieht mit um**, sonst bricht `docs/40` still |

## Die Architektur

**`bridge.html` + `bridge.js` (der Brücken-Tab):** hält WebSocket, Einstellungen,
Tab-Store und die Werkzeugausführung. Es ist eine Erweiterungsseite, keine
Webseite: sie hat volle Rechte, braucht kein Content-Script und keinen
Netzwerkzugriff nach außen außer dem Socket.

**`background.js` (Event Page):**

1. Legt den Brücken-Tab an, wenn keiner existiert (nach Browser-Start, nach
   Schließen, nach einem Absturz).
2. Hält die `webRequest`-Mitschrift — sie muss laufen, **bevor** ein
   Transkript-Auftrag kommt, und darf nicht am Leben des Brücken-Tabs hängen.
3. Vermittelt nichts Weiteres: Werkzeuge laufen im Tab.

**Verbindung zwischen beiden:** `runtime.sendMessage`/`onMessage` für
Einzelaufträge; der Brücken-Tab ist der einzige, der den Socket kennt.

## Risiken, die diese Spec benennen muss

1. **Tab-Discard.** Firefox entlädt Tabs unter Speicherdruck
   (`tabs.Tab.discarded`). Der Socket stirbt damit. Erkennung über
   `tabs.onUpdated` (`changeInfo.discarded`) und Neuaufbau; ein angepinnter Tab
   ist wahrscheinlich seltener betroffen, aber nicht immun.
2. **Browser-Neustart.** Ob der Tab wiederhergestellt wird, hängt an
   Sitzungswiederherstellung und `pinned`. Der Koordinator muss ihn notfalls
   neu anlegen — und dann darf es **keinen** zweiten Brücken-Tab geben.
3. **`webRequest` im sterbenden Hintergrund.** Die Mitschrift aus `docs/33`/`34`
   lebt vom Adress-Mitschnitt. Stirbt die Eventpage mitten in einer Navigation,
   ist die Adresse weg. Muss gemessen werden (Stufe 3); falls es beißt, ist die
   Alternative, den Mitschnitt in den Brücken-Tab zu legen — dann aber mit der
   Einschränkung, dass er nur läuft, solange der Tab lebt.
4. **`scripting.executeScript` antwortet anders.** MV2 gab je Frame einen Wert
   zurück, MV3 gibt `{frameId, result}`-Einträge. Eine Aufrufstelle, 17 Aufrufer
   — die Umstellung ist klein, ihre Wirkung nicht: `framesOf` und der
   Frame-Filter (`docs/24`) entscheiden nach Inhalt, dürfen aber nicht plötzlich
   leere Einträge sehen.
5. **Der Testharness.** 16 343 Zeilen prüfen `background.js` in einer `vm` mit
   `tabs.executeScript`. Zieht der Code um, muss der Harness mit — sonst prüft er
   eine Datei, die es nicht mehr gibt.
6. **Der E2E-Seam.** `docs/40` patcht zwei Zeilen in `background.js`; liegen
   Endpunkt und Token künftig in `bridge.js`, muss der Patch dort greifen.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/manifest.test.js` | `manifest_shouldDeclareVersionThree` | `manifest_version: 3`, `background` ohne `persistent`, `scripting` in `permissions`, `<all_urls>` in `host_permissions` |
| `test/manifest.test.js` | `manifest_shouldNotClaimAPersistentBackground` | kein `persistent: true` mehr — der Grund von `docs/02` ist entfallen, nicht vergessen |
| `test/bridge-tab.test.js` | `bridgeTab_whenMissing_shouldBeCreatedOnce` | der Koordinator legt genau **einen** Brücken-Tab an, auch wenn er zweimal startet |
| `test/bridge-tab.test.js` | `bridgeTab_whenClosedByTheOperator_shouldComeBack` | Schließen ist kein Endzustand |
| `test/bridge-tab.test.js` | `bridgeTab_whenDiscarded_shouldReload` | `changeInfo.discarded` führt zum Neuaufbau, nicht zu einer toten Verbindung |
| `test/extension.test.js` | bestehende Fälle, Harness auf den Tab umgestellt | die Werkzeuge arbeiten unverändert; die 492 Node-Fälle bleiben grün |
| `test/ci/e2e.test.js` | `e2e_seamPatch_shouldFindBothLines` (Pfad angepasst) | der E2E-Seam findet seine zwei Zeilen in der neuen Datei |
| live (Betreiber) | 8 h Leerlauf, Tab schließen, Browser-Neustart | die Verbindung hält — der Punkt der ganzen Spec |

## Acceptance criteria

1. **Das Manifest ist MV3.** `node -e "const m=require('./extension/manifest.json'); console.log(m.manifest_version, Boolean(m.background.persistent), m.permissions.includes('scripting'), (m.host_permissions||[]).includes('<all_urls>'))"`
   ⇒ `3 false true true`.
2. **Es gibt genau einen Brücken-Tab.** Nach zwei Aufrufen des Koordinators
   (`bridgeTab_whenMissing_shouldBeCreatedOnce`) und nach Browser-Neustart
   (Betreiber) zählt `tabs.query({url: browser.runtime.getURL('bridge.html')})`
   ⇒ **1**.
3. **Die Verbindung hält ohne Zutun.** Betreiber-Messung: Bridge-Log zeigt nach
   **8 Stunden** Leerlauf **keine** `extension disconnected`-Zeile außer denen,
   die ein Tab-Neuaufbau selbst verursacht; dieselbe Messung ergab unter MV2
   nach 30 s einen Abbruch.
4. **Ein geschlossener Tab kommt zurück.** Tab schließen ⇒ binnen **10 s** ist
   er wieder da und die Bridge loggt `extension connected`.
5. **Ein verworfener Tab kommt zurück.** `about:unloads` erzwingt das Verwerfen
   ⇒ der Tab lädt neu, die Bridge loggt `extension disconnected` und danach
   `extension connected`.
6. **Die Werkzeuge arbeiten unverändert.** `npm test` ⇒ `# fail 0`,
   `# cancelled 0`; `node --test test/bridge-tab.test.js` ⇒ `# fail 0`.
7. **Die Parität bleibt.** `scripts/parity.sh --impl rust --check` ⇒ **7/7**,
   `--self-test` ⇒ 7/7 rot — die Bridge hat sich nicht geändert, und das soll
   sie auch nicht.
8. **Der E2E findet seinen Seam.** `node scripts/e2e/build-test-extension.mjs
   --self-check --source extension` ⇒ Exit 0, `seams {endpoint:1, token:1}`;
   `E2E_BEACON_MODE=broken node scripts/e2e/run.mjs` ⇒ Exit 1 (der Test ist
   weiterhin in der Lage, rot zu werden).
9. **Der `webRequest`-Mitschnitt überlebt den Worker.** Betreiber-Messung: eine
   Seite mit `api/timedtext`-Anfrage laden, **nachdem** der Hintergrund
   eingeschlafen ist (30 s warten), dann `browser_transcript` ⇒ die
   Original-Adresse wird gefunden, nicht `no_transcript_panel`.

## Dev plan

**Stufe 1 — der Socket zieht in den Tab, noch auf MV2**

Dateien: `extension/bridge.html`, `extension/bridge.js` (neu),
`extension/background.js` (wird Koordinator), `extension/manifest.json`
(`background.scripts` bleibt, `bridge.html` kommt als Seite dazu),
`test/bridge-tab.test.js` (neu), `test/extension.test.js` (Harness-Ziel).

Der Tab entsteht und hält den Socket; der Hintergrund legt ihn an und öffnet ihn
wieder. MV2 bleibt, damit diese Stufe **einzeln** lauffähig ist: wenn sie
scheitert, ist der Rückweg `background.js` allein.

Beweis: Kriterien 2, 4, 6; live: `extension connected` nach dem Öffnen des Tabs,
`browser_status` antwortet über den Tab.

**Stufe 2 — das Manifest auf MV3**

Dateien: `extension/manifest.json` (`manifest_version: 3`, `scripting`,
`host_permissions`, `background` als Eventpage), `extension/background.js`
(`scripting.executeScript` statt `tabs.executeScript`, Rückgabeform),
`test/manifest.test.js` (die MV2-Pins bewusst umgestellt),
`test/extension.test.js`, `scripts/e2e/build-test-extension.mjs` (Seam-Pfad),
`docs/02` (Amendments), `docs/40` (Seam-Zeile).

Beweis: Kriterien 1, 6, 7, 8.

**Stufe 3 — die Messung**

Dateien: keine Produktdateien; `docs/42` bekommt die Messwerte, `docs/PROJECT-STATE.md`
den Stand.

Beweis: Kriterien 3, 5, 9 mit Zeitstempeln aus dem Bridge-Log.

## Amendments to previous spec docs

| Dokument | Abschnitt | was gilt |
|---|---|---|
| `docs/02-persistenter-background.md` | `## Non-goals` („Kein Socket im Tab") | **überholt**: der Socket im Tab ist jetzt das Design. Der Satz wird zu „erledigt durch `docs/42`" |
| `docs/02-persistenter-background.md` | `## Ziel`, `## Testing`, Kriterien | der persistente MV2-Hintergrund ist **nicht mehr** die Lösung; die Kriterien werden auf „der Brücken-Tab hält die Verbindung" umgeschrieben |
| `docs/34-spurendatei-beobachten.md` | `## Bekannte Lücken` | die Mitschrift lebt jetzt im Eventpage-Hintergrund und kann mit ihm einschlafen — offener Punkt, gemessen in Stufe 3 |
| `docs/40-ci-ablauf.md` | `## Der E2E-Ablauf`, Ankertabelle | die zwei Anker liegen nach der Migration in `extension/bridge.js`, nicht in `background.js` |

## Bekannte Lücken

- **Nichts davon ist gemessen.** Es gibt keine MV3-Version im Baum; jede Zahl in
  dieser Spec stammt aus `docs/02` (30 s) oder aus dem Code (Zeilen, Zählungen).
- **Tab-Discard ist eine Vermutung mit Vorsicht.** Ob ein angepinnter Tab
  seltener verworfen wird, ist nicht belegt; Kriterium 5 erzwingt das Verwerfen,
  statt darauf zu hoffen.
- **Die Signierung bleibt offen.** MV3 macht sie möglich, nicht fertig.

## Open questions

1. **Wie sichtbar soll der Brücken-Tab sein?** Drei Formen stehen zur Wahl:
   angepinnt (überlebt eher, kostet Platz in der Leiste), normal, oder in einem
   eigenen Fenster. Der Betreiber sieht ihn dauerhaft.
2. **Wann öffnet er sich?** Beim Browser-Start automatisch, oder erst wenn die
   Bridge ihn braucht (erster Auftrag)?
3. **Was passiert, wenn der Betreiber ihn bewusst schließt?** Sofort wieder
   öffnen, oder erst beim nächsten Auftrag — und mit welchem Hinweis?

Diese drei entscheidet der Betreiber; sie ändern das Verhalten, nicht die
Mechanik. Bis zur Antwort gilt: anpinnen, beim Start öffnen, sofort wieder
öffnen.

## Review

### Runde 1 — steht aus

## Log

- **2026-11-17, Betreiberentscheid:** Branch `mv3`, Spec zuerst.
- **2026-11-17, Vorgeschichte:** `docs/02` hat MV2 gewählt und den Socket im Tab
  ausdrücklich als Kandidaten für eine eigene Spec benannt. Diese Spec löst das
  ein.
