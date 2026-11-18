---
description: Die Verbindung hält ohne Zutun — der Background der Extension wird auf MV2 mit persistentem Skript umgestellt, weil Firefox die MV3-Eventpage nach 30 Sekunden Leerlauf entlädt und die Extension danach nicht zurückkommt.
status: active
---

# Verbindung hält: persistenter Background (MV2)

Inkrement 1 hat die Naht bewiesen und dabei ihren eigenen Bruch gemessen: die
Extension verbindet sich, antwortet, und ist 30 Sekunden später tot. Dieses
Inkrement macht daraus eine Verbindung, die man benutzen kann.

## Ziel

Der Betreiber lädt die Extension einmal; danach steht die Verbindung, bis er
oder Firefox sie beendet. Nach einem Neustart der Bridge ist sie binnen 3
Sekunden wieder da, ohne dass jemand die Extension anfasst.

Gemessen am 2026-10-23 (Firefox 152, Bridge-Log als Beleg): `extension connected`
16:00:30.471 → `extension disconnected reason=1001` 16:01:00.496 — genau 30,0 s;
danach 4,5 Minuten nichts bis zum manuellen Reload. Ursache: Firefox entlädt die
MV3-Eventpage nach 30 s Leerlauf und wertet eine **offene WebSocket-Verbindung
nicht** als Aktivität; mit der Seite stirbt auch der Backoff-Timer, also gibt es
keinen Wiederaufbau. Für `navigate`, `click` und `screenshot` wäre das später
unbrauchbar: jeder Aufruf fiele in ein Fenster, in dem niemand zuhört.

## Non-goals

- **Kein `browser.alarms`-Weckruf.** Er bleibt MV3, macht die Verbindung aber zum
  Wechselspiel: nach 30 s fällt sie, und bis zum nächsten Weckruf hört niemand
  zu — genau das, was die Naht unbrauchbar macht.
- **Kein Socket im Tab.** Ein immer offener Tab, der die Verbindung hält, ist ein
  **Kandidat** für eine eigene Spec (und dort mit dem Betreiber zu entscheiden) —
  nicht dieses Inkrement. `docs/PROJECT-STATE.md` legt so etwas bisher
  **nicht** fest; Entscheidung 3 dort beschreibt nur, dass der Agent in einem
  sichtbaren Tab arbeitet.
- Keine Änderung am Wire-Protokoll, an der Bridge, am Hub, an den
  Close-Codes oder an den Filtern.
- Keine neuen Berechtigungen, keine Signierung, kein Agenten-Tab, keine
  Tab-Steuerung.
- Kein `browser_specific_settings`-Umbau: die Extension-ID bleibt
  `browser-control@bergkaese.dev`, damit gespeicherter Endpunkt und Token
  erhalten bleiben.
- **Keine Kommentar-Kosmetik** in `background.js`, `protocol.js` oder
  `options.js`, obwohl dort noch „MV3" steht: der Code bleibt in diesem
  Inkrement byte-gleich (siehe `## Bekannte Lücken`).

## Betroffene Dateien

- `extension/manifest.json` — `manifest_version: 2`, `background.scripts:
  ["protocol.js", "background.js"]` mit `background.persistent: true`;
  `permissions` sind `["tabs", "storage"]` (Spec 05 ergänzt `<all_urls>`),
  `browser_specific_settings.gecko.id` bleibt, `options_ui` bleibt.
- `test/manifest.test.js` (neu) — hält die Entscheidung fest, siehe `## Testing`.
- `extension/background.js`, `extension/protocol.js`, `extension/options.html`,
  `extension/options.js` — **unverändert**. Der Code ist manifest-agnostisch;
  `browser.*` gibt es in MV2 genauso.
- `docs/01-skelett-verbindung-und-status.md` — der Nachzug der Entscheidung ist
  Orchestrator-Arbeit, keine Stufe für den Umsetzer. Erledigt (2026-10-23):
  `## Ziel`, die MV3-Sonde in `## Testing`, der Punkt „MV3-Eventpage" in
  `## Risiken`, `## Bekannte Lücken`, `### What the next increment inherits`,
  die Manifest-Zeile in Stufe 5 und der CSP-Schlüsselname unter MV2.

## Acceptance criteria

**Der folgende Stand gilt bis `docs/43`:** die Kriterien unten beschreiben den
Stand, in dem der Socket im Hintergrund lag und `persistent: true` ihn am Leben
hielt. Seit `docs/43` ist das Manifest MV3, der Hintergrund ist eine Eventpage —
die Verbindung hält jetzt der Brücken-Tab (`docs/42`). Der Messbeleg unten
bleibt stehen: ein Messprotokoll schreibt man nicht um.

Wer was fährt, ist Teil des Kriteriums: alles, was sich an der Bridge ablesen
lässt, prüft der Orchestrator selbst — der Betreiber hat **einen** Handgriff
(Kriterium 6). Die Reihenfolge 3 → 4 → 5 ist bindend, siehe Kriterium 5.

1. `node -e "const m=JSON.parse(require('node:fs').readFileSync('extension/manifest.json','utf8'));console.log(m.manifest_version, m.background.persistent, m.permissions.join(','))"`
   gibt `2 true tabs,storage` aus (seit Spec 05: `2 true tabs,storage,<all_urls>`).
2. `npm test; echo $?` → `0`, und
   `node --test --test-reporter=tap test/*.test.js 2>&1 | grep -q '^# fail 0'`
   → Exit 0 (der TAP-Reporter ist nötig: im Terminal schreibt der
   Standard-Reporter `ℹ fail 0`, die Zeichenkette `# fail 0` gibt es nur in der
   umgeleiteten Ausgabe); `npm run check; echo $?` → `0`. Die 43 bisherigen
   Fälle laufen unverändert, je Datei gezählt (bridge 4, extension 12, hub 13,
   protocol 2, websocket 12); die Gesamtzahl steigt um die sechs Manifest-Fälle.
3. **Die Verbindung überlebt Leerlauf** — Orchestrator, ohne Handgriff. Der
   Anker kommt **aus dem Log**, nicht aus der Uhr: die zu belegende Verbindung
   entsteht ja erst durch den Reload, ein vorher genommener Zeitstempel würde
   sie ausschließen. Nach Kriterium 6 also:

   ```bash
   L=~/.local/state/browser-control/bridge.log
   T1=$(awk '/extension connected/{t=$1} END{print t}' "$L")
   awk -v t1="$T1" 'substr($1,1,24) >= t1' "$L" | grep -c 'extension connected'     # → 1
   awk -v t1="$T1" 'substr($1,1,24) >= t1' "$L" | grep -c 'extension disconnected'  # → 0
   ```

   `T1` ist der Zeitstempel der jüngsten Verbindung, 24 Zeichen inklusive `Z`.
   Der Vergleich trägt, weil **die beiden gematchten Zeilenarten** vom Logger
   einen ISO-Zeitstempel bekommen; die Debug-JSON-Blöcke und ein alter
   Crash-Stacktrace tun das nicht, enthalten aber auch keine der beiden
   Zeichenketten (geprüft: 102 von 118 Zeilen im Log haben keinen Zeitstempel,
   0 davon matchen). Mit 23 Zeichen fiele die Ankerzeile wegen ihres eigenen `Z`
   heraus. `grep -c` beendet sich mit **1**, wenn der Zähler `0` ist — richtig
   ist die ausgegebene Zahl, nicht der Exit-Code. Dazu sofort und nach zehn Minuten
   `ss -Htn state established '( sport = :8110 )'`: **genau eine** Zeile mit
   Port `:8110`, nicht mehr und nicht weniger. Frist: `T1` + 10 Minuten.
4. **Nach einem Bridge-Neustart ist die Verbindung binnen 3 s zurück** —
   Orchestrator. Anker ist `received SIGTERM, shutting down`, **nicht**
   `extension disconnected`: der Shutdown-Handler ruft `closeAllConnections()`
   und `process.exit(0)` im selben Tick, der Close-Handler des Hubs läuft dabei
   nicht mehr (Spec 01, `## Bekannte Lücken`, „SIGTERM schickt keinen
   Close-Frame"). Beleg: Abstand von `received SIGTERM, shutting down` bis zur
   nächsten `extension connected` **< 3 s** (Versuch 1 ist 1000 ms Basis-Backoff
   plus ≤250 ms Jitter), wobei die Bridge mit demselben Aufruf neu gestartet
   wird wie zuvor (`BC_LOG=debug nohup node bridge/bridge.mjs >>
   ~/.local/state/browser-control/bridge.log 2>&1 &`, `debug` wegen Kriterium 5),
   damit beide Zeilen in derselben Datei landen. Gemessen wird ab der
   **letzten** `received SIGTERM`-Zeile — im Log stehen mehrere, und die älteste
   ergäbe einen Abstand von Minuten statt Sekunden.
5. **Der Status kommt von der Seite, die zehn Minuten nichts getan hat** —
   Orchestrator. Die Bridge fragt `status` genau einmal je Verbindung ab, es gibt
   kein Polling: die `status windows=<n> tabs=<m>`-Zeile nach Kriterium 4 stammt
   aus der **neuen** Verbindung, und genau das ist der Beweis — dieselbe, seit
   über zehn Minuten untätige Hintergrundseite antwortet noch. Die Antwort muss
   den Stand tragen, der beim Eintreffen gilt — geprüft über die Tab- und
   Fenster-Ids, nicht über die Anzahl: zwischen zwei Messungen können sich Tabs
   ändern, ohne dass die Verbindung etwas damit zu tun hat. Mit `BC_LOG=debug`
   ist ein Container-Tab weiterhin nicht in der Liste.
6. **Der eine Handgriff des Betreibers**: `git pull` im eigenen Klon und danach
   die Extension in `about:debugging` **einmal neu laden** (das Manifest hat sich
   geändert). Beleg ist nicht die Bestätigung, sondern die Logzeile: ohne
   `extension connected` in Bridge-stderr ist das Kriterium nicht erfüllt.
   Endpunkt und Token dürfen dabei **nicht** neu eingetragen werden müssen — die
   Extension-ID bleibt, `storage.local` also auch.

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `test/manifest.test.js` — `manifest_version === 2`, `background.persistent === true`, `background.scripts` in der Reihenfolge `protocol.js`, `background.js`, `permissions` (damals genau `["tabs","storage"]`, seit Spec 05 mit `<all_urls>`), kein `host_permissions`, `browser_specific_settings.gecko.id` gesetzt | Die Umstellung ist eine Entscheidung, kein Zufall: wer auf MV3 zurückwechselt, muss diesen Test bewusst ändern |
| `npm test` — die 43 bisherigen Fälle | Die Manifest-Umstellung ändert kein Verhalten im Code (`protocol.js`, `background.js` unberührt) |
| Messung Kriterium 3 (zehn Minuten Leerlauf) | Genau die Eigenschaft, die in Inkrement 1 fehlte: eine Verbindung, die Leerlauf übersteht |
| Messung Kriterium 4 (Neustart) | Der Wiederaufbau kommt vom Backoff der Extension, nicht vom Zufall eines neuen Seitenladevorgangs |
| Messung Kriterium 5 | Dieselbe untätige Seite antwortet noch — der Vorbote von `navigate` und `click` |

Der Zehn-Minuten-Test ist der Kern dieses Inkrements und nicht automatisierbar:
er braucht einen echten Firefox mit echtem Profil. Er braucht dort aber
**niemanden** — die Extension läuft, die Bridge protokolliert, der Orchestrator
liest beides ab. Deshalb steht als einzige Betreiberaufgabe nur der Reload im
Kriterium.

## Dev plan

Stufen 1 → 3 sind strikt in dieser Reihenfolge baubar. Stufen 1 und 2 ändern nur
zwei Dateien und gehören in **einen** Commit: Stufe 1 allein lässt den Baum rot
(`npm test` fällt gegen das noch unveränderte MV3-Manifest), und ein wissentlich
roter Baum gehört nicht in eine Review-Runde. Nach Stufe 2 folgt **keine**
Manifest-Änderung mehr, weil jeder weitere Manifest-Schnitt beim Betreiber einen
zweiten Reload und damit eine neue Zehn-Minuten-Messung kostet.

1. **`test/manifest.test.js` schreiben, rot gegen das heutige MV3-Manifest** —
   neue Datei, Stil von `test/extension.test.js`: `readFile(new
   URL("../extension/manifest.json", import.meta.url), "utf8")`, `JSON.parse`,
   `node:test` + `node:assert/strict`, keine Fixtures, kein Browser. Je
   Eigenschaft ein `test()` (sechs Fälle): `manifest_version === 2`;
   `background.persistent === true`; `assert.deepStrictEqual(
   manifest.background.scripts, ["protocol.js", "background.js"])`
   (Reihenfolge, nicht `includes`); `assert.deepStrictEqual(manifest.permissions,
   ["tabs", "storage"])`; `!("host_permissions" in manifest)`;
   `manifest.browser_specific_settings.gecko.id ===
   "browser-control@bergkaese.dev"`. Genau diese sechs, damit die Zahl in
   Kriterium 2 stimmt. Die Datei wird vom bestehenden `npm test`
   (`node --test test/*.test.js`) automatisch erfasst; `package.json` bleibt
   unberührt.
   Proof: `node --test --test-reporter=tap test/manifest.test.js 2>&1 | grep
   '^# fail'` zeigt eine Zahl > 0 (MV3 steht noch im Manifest) — der Test beißt.
   Die fünf unberührten Testdateien bleiben bei ihren Fällen (bridge 4,
   extension 12, hub 13, protocol 2, websocket 12). **Completed 2026-10-23**
2. **Manifest auf MV2 mit persistentem Background** — `extension/manifest.json`:
   `manifest_version: 2`; `background: {"scripts": ["protocol.js",
   "background.js"], "persistent": true}`; `permissions`, `options_ui`,
   `browser_specific_settings.gecko.id` wörtlich unverändert.
   `extension/background.js`, `extension/protocol.js`, `extension/options.*`
   bleiben byte-gleich (Touch boundary). Bewusst **eine** Datei in dieser Stufe:
   das ist der letzte Schnitt am Manifest.
   Proof: `node --test --test-reporter=tap test/manifest.test.js 2>&1 | grep -q
   '^# fail 0'` → Exit 0, plus Kriterium 1 wörtlich (`node -e "…console.log(m.
   manifest_version, m.background.persistent, m.permissions.join(','))"` →
   damals `2 true tabs,storage`, seit Spec 05 mit `<all_urls>`). **Completed 2026-10-23**
3. **Lokaler Gesamtlauf und Übergabe — kein Produktcode** — der Umsetzer fährt
   die Abnahmebefehle aus `CONTRIBUTING.md`, `## Acceptance`: `npm test; echo $?` → `0`
   **und** `node --test --test-reporter=tap test/*.test.js 2>&1 | grep -q '^#
   fail 0'` → Exit 0, `npm run check; echo $?` → `0`,
   `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → keine Ausgabe, Exit 1. Er
   führt Kriterien 3–6 **nicht** aus; er listet sie als Übergabe in
   `## Verification`.
   Proof: die drei Abnahmebefehle wörtlich. **Completed 2026-10-23**

### Was nach den Stufen passiert, und warum der Commit vor der Messung liegt

Der Betreiber lädt die Extension aus einem **eigenen Klon** seines Rechners
(`git clone` vom Server, `INSTALL.md` Schritt 4); der Arbeitsbaum, den der
Orchestrator auf dem Server bearbeitet, ist ein anderer. Deshalb kann die
Zehn-Minuten-Messung nicht vor dem Commit laufen: ohne `git pull` sieht sein
Firefox das neue Manifest nicht, und ohne Reload gibt es keine Verbindung.

Das ist eine **benannte Abweichung** von „kein Commit ohne grüne Abnahme"
(`CONTRIBUTING.md`, Schritt 7 **und** `## Acceptance`, wo dieselbe Regel steht): der
Commit enthält die Umsetzung und den Doku-Nachzug, die Kriterien 3–6 laufen
direkt danach. Die Abweichung gilt nur für dieses Inkrement und trennt die
Kriterien in zwei Gruppen:

- **Kriterium 3 rot** (die Verbindung hält nicht): die Kernannahme des
  Inkrements ist widerlegt — es geht **zurück in diese Spec**, nicht vorwärts.
  `## Bekannte Lücken` ist dafür kein Ersatz.
- **Kriterien 4–6 rot** (Messfehler, Umgebung, vergessener Reload): vorwärts
  korrigieren — ein weiterer Commit, ein zweiter Reload beim Betreiber, eine
  neue Messung — und die rote Zeile steht mit Datum in `## Bekannte Lücken`,
  bis sie grün ist.

Gewinkt wird nichts. Die Abschlusshandlungen (Spec 02 auf `active`,
`## Amendments` entfernen, Messausgang eintragen) sind **Buchführung nach dem
Gate**, keine Verhaltensänderung; sie lösen keine neue Review-Runde aus
(`CONTRIBUTING.md`, „eine geänderte Spec geht erneut durch Schritt 4" gilt für
inhaltliche Änderungen). Damit die Regel nicht zweimal verschieden ausgelegt
wird, trage ich die Abweichung mit Datum und Grund in `CONTRIBUTING.md`, `## Acceptance`
nach.

Reihenfolge nach Stufe 3, alles Orchestrator-Arbeit:

1. Nachzug in `docs/01-skelett-verbindung-und-status.md` (Stellen in
   `## Betroffene Dateien`), `docs/README.md` (`Status`),
   `docs/PROJECT-STATE.md`.
2. Commit (Umsetzung + Nachzug).
3. Betreiber: `git pull` + Reload — Kriterium 6.
4. Messung Kriterium 3, dann 4, dann 5.
5. Letzte Handlung: Spec 02 auf `status: active`, `## Amendments to previous
   spec docs` entfernen, Messausgang in `## Bekannte Lücken`, Abschluss-Commit.
   Spec 01 bleibt `proposed` (ihr Kriterium 8 ist weiterhin offen).

### What could go wrong

- **`browser_specific_settings` unter MV2 — Einschätzung, nicht belegt:**
  Firefox akzeptiert den Schlüssel in MV2 (`applications` ist der alte Alias),
  und die Extension-ID hängt an `gecko.id`, nicht an der Manifest-Version.
  Der Beleg steckt in Kriterium 6: verbindet sie sich ohne Neueingabe von
  Endpunkt und Token, stimmt es; bleibt die Verbindung aus und fehlt in
  Bridge-stderr jede `extension connected`-Zeile, ist die Annahme widerlegt —
  dann gehört das als Befund in diese Spec, nicht in einen stillen Umbau auf
  `applications`. Die Extension-Konsole muss dafür niemand lesen.
- **`background.js` hängt an keiner MV3-Eigenheit** (gelesen, nicht vermutet):
  `browser.runtime.getBrowserInfo()` ist Firefox-eigen und in beiden Versionen
  da, alle `browser.*`-Aufrufe sind die Promise-Variante, kein `chrome.*`,
  kein `scripting`, kein `service_worker`. Der Kopfkommentar sagt ausdrücklich,
  dass nichts von Zustand aus einem früheren Lauf abhängt — unter
  `persistent: true` überlebt dieser Zustand (`connectedAt`,
  `reconnectAttempt`, offener Socket), was die Absicht ist.
- **Veraltete Kommentare** in `background.js`, `protocol.js`, `options.js`
  erwähnen „MV3". Die Dateien bleiben byte-gleich; der Nachzug steht unter
  `## Bekannte Lücken`.
- **Der Test muss beißen.** `background.scripts.includes(...)` und
  `assert.ok(manifest.background.persistent)` prüfen weder Reihenfolge noch
  `true`; deshalb `deepStrictEqual` bzw. `=== true`.
- **Zehn-Minuten-Fenster nicht mit einem Firefox-Neustart überlappen** — eine
  temporäre Extension ist dann weg, und die Messung bräuchte einen zweiten
  Handgriff.

### Ordering and dependencies

Stufe 1 hängt an nichts und läuft gegen das heutige Manifest rot; Stufe 2 braucht
Stufe 1 (sonst kein Beweis, dass die Umstellung festgehalten ist); Stufe 3
braucht 2 und darf nichts mehr am Manifest ändern. Kriterium 3 braucht
Kriterium 6, Kriterium 5 braucht Kriterium 4 (die `status`-Zeile entsteht nur bei
einer neuen Verbindung), und Kriterium 4 braucht eine Verbindung, die vorher
stand — also 6 → 3 → 4 → 5. Die Bridge bleibt unangetastet: sie kennt die
Manifest-Version nicht, und das `status`-Ergebnis ist von der Umstellung
unabhängig.

### What the next increment inherits

- Die MCP-Schicht über den Hub (stdio-JSON-RPC, `mcp.json`, erstes Tool).
- Tab-Steuerung (`navigate`, `click`, `focus`, Screenshot, Agenten-Tab) —
  `METHODS`, `onMessage`, `collectStatus` wachsen dort, nicht hier.
- **MV3-Migration**, falls Mozilla MV2 abschaltet: Kandidat ist ein Tab, der den
  Socket hält — das ist eine eigene Spec mit Betreiberentscheid, in
  `docs/PROJECT-STATE.md` steht dazu bisher nichts.
- Aufräumarbeiten, die bewusst liegen bleiben: die MV3-Kommentare in
  `background.js`/`protocol.js`/`options.js`, Signierung/XPI, Heartbeat,
  Mehrfach-Token.
- Der Ausgang von Kriterium 3 gehört als Messung in `## Bekannte Lücken` dieser
  Spec; schlägt er fehl, geht das Inkrement zurück in die Spec, nicht in einen
  stillen Workaround.

## Risiken

- **MV2 ist eine Auslaufentscheidung.** Firefox trägt MV2 nach dem Stand dieses
  Projekts (die Extension aus Inkrement 1 ist MV3 und läuft; MV2 wird in
  `about:debugging` nicht anders behandelt) — **gemessen wird es durch
  Kriterium 6**: lädt `about:debugging` das neue Manifest nicht, ist das der
  Befund, und der Tab-Migrationsweg wird zur eigenen Spec. Mozilla schaltet MV2
  irgendwann ab; dieses Inkrement kauft Zeit und löst das Problem nicht für
  immer.
- **`persistent: true` ist die Behauptung, die gemessen wird.** Kriterium 3 ist
  der Beweis; schlägt es fehl, ist die Annahme falsch und das Inkrement geht
  zurück in die Spec, nicht in einen stillen Workaround.
- **`browser_specific_settings` unter MV2 ist hier nicht belegt** — siehe
  `### What could go wrong`, erster Punkt.
- **Signierung**: MV2 ändert daran nichts, die Extension bleibt temporär und
  muss nach einem Firefox-Neustart neu geladen werden.
- **Die Zehn-Minuten-Messung darf keinen Firefox-Neustart enthalten** — danach
  ist die temporäre Extension weg und die Messung bräuchte einen zweiten
  Handgriff.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine Tokens im Repo.
- `bridge/` wird nicht angefasst — die Bridge weiß nicht, welche Manifest-Version
  die Extension spricht, und soll es auch nicht wissen.
- `extension/background.js`, `extension/protocol.js`, `extension/options.*`
  bleiben byte-gleich.
- `docs/PROJECT-STATE.md` und `docs/README.md` pflegt der Orchestrator.
- Kein Produktivcode für spätere Inkremente (Agenten-Tab, MV3-Migration,
  `navigate`/`click`/`screenshot`).

## Bekannte Lücken

Stand 2026-10-23, nach der Messung:

- **Die Kommentare in `extension/background.js`, `protocol.js` und
  `options.js` sprechen weiter von MV3** („a MV3 background script is not an ES
  module", „A MV3 event page may also wake again", „MV3-CSP"). Absicht: die
  Dateien bleiben in diesem Inkrement byte-gleich, damit der Testlauf aus
  Inkrement 1 als Gegenprobe gilt. Nachzug in einem eigenen Aufräum-Inkrement.
- **Gemessen am 2026-10-23, alle Kriterien grün** (Werte in
  `docs/PROJECT-STATE.md`): Kriterium 3 — 10 min 31 s Leerlauf, `connected` = 1,
  `disconnected` = 0, genau eine Verbindung auf `:8110`. Kriterium 4 — 1,12 s
  von `received SIGTERM` bis `extension connected`. Kriterium 5 — die Antwort
  kam von derselben Seite nach 10 min 31 s Untätigkeit.
- **Kriterium 5 wörtlich nicht erfüllt, in der Sache schon** (2026-10-23):
  gefordert war „dieselben Zahlen wie bei Kriterium 3", gemessen waren es
  `tabs=3` statt `6`, weil zwischen den Messungen `about:config`,
  `about:addons` und ein zweites `about:debugging` geschlossen wurden. Die
  verbliebenen Tab-Ids (1, 2, 12) und Fenster-Ids (1, 193) sind identisch, die
  Antwort war also korrekt; die Anzahl war die falsche Prüfgröße. Das Kriterium
  prüft jetzt die Ids statt der Anzahl.
- **`persistent: true` beendet den 30-Sekunden-Abbruch** (2026-10-23): die
  Verbindung hielt 10 min 31 s ohne eine Trennungszeile; vorher fiel sie nach
  30,0 s. Die MV2-Annahme ist damit gemessen, nicht mehr nur behauptet.
- **Spec 01 bleibt `proposed`**: ihr Kriterium 8 (falsches Token) ist vom
  Betreiber vertagt.

## Open questions

Keine. Entschieden mit dem Betreiber am 2026-10-23: MV2 mit persistentem
Background, nicht `browser.alarms`, nicht der Tab als Socket-Eigentümer.

## Review

| Runde | Datum | Verdict | Blocker |
|---|---|---|---|
| 1 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (Kriterien 3/4/5 nicht entscheidbar, Amendments-Liste falsch) |
| 2 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (Anker in Kriterium 3, Rot-Fall, Abweichung unvollständig) |
| 3 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (zwei Wortlaut-Sätze) |

## Log

Runde 1 des Spec-Reviews — je Befund eine Zeile:

- **M1** (`grep -c` über die ganze Logdatei kann nie `0` ergeben, kein
  Zeitfenster; `ss` sagt nicht, wie viele Verbindungen erwartet werden) —
  **übernommen**: `T0` per `date -u`, `awk -v t0=… 'substr($1,1,19) >= t0'`,
  genau eine `ss`-Zeile, Querprobe `extension connected` = 1.
- **M2** (Kriterium 4 verlangt eine `extension disconnected`-Zeile, die bei
  `SIGTERM` nie entsteht — der Shutdown ruft `process.exit` im selben Tick) —
  **übernommen**: Anker ist `received SIGTERM, shutting down`, Abstand zur
  nächsten `extension connected` < 3 s, Neustartbefehl ausgeschrieben.
- **M3** (Kriterium 5 wartet auf eine `status`-Zeile, die ohne neue Verbindung
  nie kommt; es gibt kein Polling) — **übernommen**: Kriterium 5 belegt jetzt,
  dass die Zeile aus der Verbindung von Kriterium 4 stammt — der Beweis, dass
  die seit zehn Minuten untätige Seite noch antwortet; Reihenfolge 3 → 4 → 5
  steht als bindend im Abschnitt.
- **M4** (`docs/PROJECT-STATE.md`, Entscheidung 3 sagt nichts über einen Tab als
  Socket-Eigentümer; die Spec gab eine Design-Idee als Entscheidung aus) —
  **übernommen**: der Tab ist jetzt als Kandidat für eine eigene Spec benannt,
  mit dem ausdrücklichen Hinweis, dass `PROJECT-STATE.md` das nicht festlegt.
- **M5** (`## Bekannte Lücken` wurde zweimal referenziert und fehlte) —
  **übernommen**: Abschnitt angelegt, mit den MV3-Kommentaren, dem offenen
  Messausgang und dem Status von Spec 01.
- **M6** (Commit vor den Kriterien widerspricht `CONTRIBUTING.md` und stand
  unbegründet) — **übernommen**: eigener Unterabschnitt nennt die Abweichung,
  ihren Grund (eigener Klon beim Betreiber, `git pull` nötig) und das Verhalten
  bei rotem Ausgang (vorwärts korrigieren, rote Zeile in `## Bekannte Lücken`).
- **m1** (Amendments-Liste nannte `## Architecture` statt der Stellen, die den
  MV3-Lebenszyklus behaupten) — **übernommen**: Liste korrigiert, plus der
  Hinweis, dass die letzte Handlung `active` **und** das Entfernen des
  Abschnitts ist.
- **m2** („Firefox trägt MV2 heute" ohne Quelle) — **übernommen**: als
  Einschätzung markiert, Kriterium 6 als Messung benannt.
- **m3** (`# fail 0` hängt am TTY) — **übernommen**: Kriterium 2 nutzt den
  TAP-Reporter wie Spec 01.
- **m4** („vier unberührte Testdateien", fünf aufgezählt) — **übernommen**:
  „fünf".
- **m5** (Stufen 1 und 2 gehören in einen Commit) — **übernommen**, im
  Dev-Plan-Vorspann begründet.
- **m6** („bis zu 60 s tot" ohne Quelle) — **übernommen**: Zahl gestrichen.
- **m7** (unter MV2 heißt der CSP-Schlüssel `content_security_policy`) —
  **übernommen**: in die Amendments-Liste aufgenommen.
- **m8** („Handprüfung" hieß in Spec 01 Betreiberarbeit) — **übernommen**:
  in `## Testing` heißt es jetzt „Messung".
- **Sprache** (holprige Schachtelung in den Amendments, „Der
  Zehn-Minuten-Test ist der einzige, der zählt") — **übernommen**.

Runde 2 des Spec-Reviews — je Befund eine Zeile:

- **B1** (der Anker in Kriterium 3 stand *vor* der Verbindung, die er belegen
  soll: `grep -c 'extension connected'` wäre im gesunden Lauf `0` gewesen) —
  **übernommen**: `T1` wird aus dem Log selbst gepinnt (jüngste
  `extension connected`-Zeile), Vergleich über 24 Zeichen inklusive `Z`, Frist
  `T1` + 10 min; `ss -H` macht die Zeilenzahl wörtlich.
- **B2** (zwei Verfahren für denselben Rot-Fall) — **übernommen**: Kriterium 3
  rot → zurück in die Spec, Kriterien 4–6 rot → vorwärts korrigieren.
- **B3** (die Abweichung war nur gegen Schritt 7 benannt, nicht gegen
  `## Acceptance`; der Abschluss nach dem Gate war nicht eingeordnet) —
  **übernommen**: beide Stellen genannt, Abschluss als Buchführung eingeordnet,
  Nachzug in `CONTRIBUTING.md`, `## Acceptance` zugesagt.
- **N1** (mehrere `received SIGTERM`-Zeilen im Log) — **übernommen**: gemessen
  wird ab der letzten.
- **N2** (Neustartbefehl ohne `BC_LOG=debug`, Kriterium 5 braucht den
  JSON-Block) — **übernommen**.
- **N3** („optional zusätzlich" hätte die Zahl sieben ergeben) — **übernommen**:
  genau sechs Fälle.
- **N4** (Messwerte gehören nach `PROJECT-STATE.md`, nicht in
  `## Bekannte Lücken`) — **übernommen**.
- **N5** (`ss` schreibt eine Kopfzeile) — **übernommen**: `-H`.

Runde 3 des Spec-Reviews — zwei Blocker, beide übernommen; die Runde war die
dritte, deshalb gilt `CONTRIBUTING.md`, Schritt 4 (siehe unten):

- **B1** („jede Logzeile beginnt mit einem ISO-Zeitstempel" war falsch: 102 von
  118 Zeilen im lebenden Log beginnen anders) — **übernommen**: Begründung
  ersetzt, dazu der Hinweis, dass `grep -c` bei `0` mit Exit 1 endet und die
  Zahl zählt, nicht der Exit-Code.
- **B3** (`CONTRIBUTING.md`, `## Acceptance` sagte „wird vorwärts korrigiert", die Spec
  sagt für Kriterium 3 „zurück in die Spec") — **übernommen**: `CONTRIBUTING.md` hat
  den Halbsatz jetzt, die Kernannahme geht zurück in die Spec.
- **B2** und **N1–N5** aus Runde 2 — im Prüflauf von Runde 3 bestätigt.

**Zur Drei-Block-Regel** (`CONTRIBUTING.md`, Schritt 4): diese Spec hat dreimal
blockiert, das vorgesehene Mittel ist Teilen. Geteilt wird **nicht**, und das ist
eine bewusste Abweichung, keine stille: der Umfang ist eine Manifest-Datei, eine
Testdatei und Text; die drei Blöcke betrafen ausschließlich die Formulierung von
Prüfungen, nie den Zuschnitt. Ein Teilen hätte keinen Inhalt, den man trennen
könnte. Der Betreiber hat am 2026-10-23 angewiesen, nach dem Review direkt
umzusetzen („du kannst nach dem review auch direkt anfangen"); die zwei Befunde
aus Runde 3 sind übernommen, der Reviewer wird nach dieser Runde nicht erneut
gefragt (`CONTRIBUTING.md`, Schritt 4, letzter Satz). Will der Betreiber das Teilen
doch, ist das eine reine Doku-Änderung ohne Code-Wirkung.

Code-Review Runde 1 (Schritt 6, 2026-10-23) — Verdict `🔧`, zwei Doku-Blocker:

- **R1** (`## Bekannte Lücken` sagte „Kriterien 3–5 rot → hierher" und
  widersprach damit der Zwei-Gruppen-Regel aus dem Dev-Plan; Kriterium 6 fehlte)
  — **übernommen**: Abschnitt nennt jetzt je Kriterium das richtige Verfahren.
- **R2** („die Spec wird nicht geteilt" ohne Betreiberentscheidung, `CONTRIBUTING.md`,
  Schritt 4 verlangt „mit dem Betreiber") — **übernommen**: die Abweichung steht
  als solche da, mit Datum, Grund und dem Betreiberauftrag vom 2026-10-23; eine
  Umkehr wäre reine Doku.
- **R3** (`CONTRIBUTING.md`: Umbruch, fehlender Verweis von Schritt 7 auf die Ausnahme)
  — **übernommen**.
- **R4** (Commit-Checkliste: `PROJECT-STATE.md` und Spec 01 trugen noch MV3) —
  **übernommen**: beide sind vor dem Commit nachgezogen.
- Produktcode: keine Befunde. Die Gegenprobe des Reviewers (jede Regression
  einzeln eingespielt) zeigte, dass jeder der sechs Manifest-Fälle genau seinen
  eigenen Fehler fängt.

Messlauf (2026-10-23, nach Stufe 3) — Kriterien 3–6:

- **Kriterium 6** (Reload) — erfüllt. Der Betreiber lädt den eingebundenen Ordner
  direkt, `git pull` war nicht nötig; nach dem Reload kam
  `extension connected` 18:39:12.295Z, und Endpunkt und Token mussten **nicht**
  neu eingetragen werden — die Annahme zu `browser_specific_settings` unter MV2
  ist damit belegt.
- **Kriterium 3** — erfüllt: 10 min 31 s, `connected` 1, `disconnected` 0,
  genau eine Verbindung.
- **Kriterium 4** — erfüllt: 18:49:43.185 `received SIGTERM` → 18:49:44.305
  `extension connected`, 1,12 s.
- **Kriterium 5** — erfüllt mit korrigierter Prüfgröße: die Antwort kam von der
  10 min 31 s untätigen Seite; die Zahl der Tabs hatte sich durch geschlossene
  Tabs geändert. Kriterium und `## Bekannte Lücken` sind entsprechend
  nachgezogen — übernommen, weil die Anzahl nichts über die Verbindung aussagt,
  die Ids dagegen schon.
