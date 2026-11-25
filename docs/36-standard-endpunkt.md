---
description: Ein Standard-Endpunkt für die Extension — ist das Feld leer, verbindet sie nach ws://127.0.0.1:8110 (die Vorgabe der Bridge), sichtbar vorbelegt und änderbar; gespeicherte Endpunkte bleiben unberührt.
status: active
---

# Der Standard-Endpunkt

Wer Bridge und Firefox auf **einem** Rechner laufen lässt, muss heute eine
WebSocket-URL eintippen, die die Gegenseite ohnehin vorgibt: die Bridge bindet
per Default `127.0.0.1:8110` (`bridge/config.mjs`, `DEFAULT_BIND`). Diese Spec
nimmt diesen einen Eintrag aus dem Weg.

**Was sie nicht tut:** die Bridge suchen. Kein Probieren mehrerer Adressen,
kein mDNS, kein Caddy-Erraten. Der Standard ist eine **Vorgabe**, die man
überschreibt — kein Automatismus.

## Ziel

- **Ist der Endpunkt leer, ist er `ws://127.0.0.1:8110`.** Einmal als Konstante
  je Datei benutzt: die Optionsseite **zeigt** ihn, der Hintergrund
  **verwendet** ihn — und die Testdatei trägt die Adresse bereits als `ENDPOINT`
  (10 Vorkommen des Namens); sie bleibt, wie sie ist. Anzeige und Verhalten dürfen nicht auseinanderlaufen —
  deshalb pinnt ein Test, dass beide Dateien denselben Wert tragen und dass er
  zum Port der Bridge passt.
- **Sichtbar, nicht still.** Das Feld ist vorbelegt, nicht in letzter Sekunde
  gefüllt; darunter ein Satz, wann man ihn ändert (Bridge auf einem anderen
  Rechner). Ein stiller Fallback würde aus „falsch konfiguriert" ein
  „verbindet nicht, und niemand weiß warum" machen.
- **Gespeicherte Endpunkte bleiben unangetastet.** Wer eine `wss://`-Adresse
  hinter Caddy eingetragen hat, merkt nichts — der Standard greift nur bei
  leerem Feld.
- **`ws://` gilt nur für Loopback, `wss://` überall.** Ein `ws://`-Dial auf
  `127.0.0.1`, `[::1]` oder `localhost` bleibt erlaubt und geprüft wie bisher;
  auf jeden anderen Host verweigert die Seite den Dial mit **einer** deutschen
  Logzeile statt eines Sockets und ohne erneuten Versuch (Betreiberentscheid
  2026-11-18, `INSTALL.md` §9 „No certificate? Tunnel it.“). Grund: ein
  unverschlüsseltes `ws://` über das Netz schickt das Token im `hello` im
  Klartext. `wss://` ist auch auf Loopback erlaubt, und ein Pfad ändert nichts —
  das Schema am Host entscheidet. Ein ungültiger Endpunkt endet weiter mit
  `bc: Endpunkt ungültig:` und einem erneuten Versuch, nicht mit einem Absturz;
  die Regel greift **vor** dem Dial und **nicht** in der Optionsseite, wo sie
  nur das Speichern verweigern würde.
- **Die Optionsseite bleibt abhängigkeitsfrei** (eine Datei, kein Build), und
  das Manifest ändert sich nicht.

## Non-goals

- **Keine Discovery.** Kein Ausprobieren mehrerer Adressen, kein Netzwerk-Scan,
  kein mDNS, kein Lesen des Bridge-Ports aus einer Datei.
- **Keine Caddy-Erkennung.** Der öffentliche Weg bleibt Handarbeit
  (`INSTALL.md` §9).
- **Keine Änderung an gespeicherten Werten**, keine Migration, kein Umschreiben
  von `storage.local`.
- **Kein neues Feld, kein neues Werkzeug, keine neue Berechtigung.**
- **Keine stille Verbindung.** Der Endpunkt, der benutzt wird, steht im Feld —
  was verbindet, ist ablesbar.

## Die Entscheidung des Betreibers (2026-11-15)

| Frage | Entscheidung |
|---|---|
| Welcher Standard? | **`ws://127.0.0.1:8110`** — die Vorgabe der Bridge (`BC_BIND`), kein geratener Wert |
| Sichtbar oder still? | **sichtbar** — Feld vorbelegt, mit einem Hinweis für den Fernfall |
| Gilt für gespeicherte Endpunkte? | **nein** — nur ein leeres Feld |

## Die Messungen

Aus den Dateien gelesen, nicht geschätzt:

- `bridge/config.mjs` bindet per Default `127.0.0.1:8110`; die Bridge sucht
  **keinen** freien Port und beendet sich mit `1`, wenn der belegt ist.
- `extension/bridge.js` liest `endpoint` und `token` aus `storage.local`;
  ist einer davon leer, schreibt es **eine** Warnung (`missing settings`) und
  verbindet **nicht**. Es gibt heute keinen Default. (Das war bis `docs/42` die
  Datei `extension/background.js`; mit dem Socket zog die Zeile in den
  Brücken-Tab. Das Kriterium 1 pinnt sie deshalb in `bridge.js`.)
- `extension/options.js` schreibt beim Speichern `readFieldValue("endpoint").trim()`;
  ein leeres Feld speichert damit `""`.
- `extension/options.html` trägt heute den Platzhalter
  `wss://example.com/browser-control/ws` — ein Fernbeispiel an der Stelle, an
  der der häufige Fall lokal ist.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `endpoint_withoutAStoredValue_shouldDialTheLoopbackDefault` | leerer Endpunkt ⇒ das Hintergrundskript wählt `ws://127.0.0.1:8110` |
| `test/extension.test.js` | `endpoint_withAStoredValue_shouldDialThatValue` | ein gespeicherter `wss://`-Endpunkt bleibt maßgeblich |
| `test/extension.test.js` | `endpoint_default_matchesTheBridgesDefaultPort` | der Standardendpunkt trägt denselben Port wie `DEFAULT_BIND` in `bridge/config.mjs` (Drift-Wächter: die zwei Dateien dürfen nicht auseinanderlaufen) |
| `test/extension.test.js` | `endpoint_default_isTheSameInOptionsAndBackground` | der **Quelltext** der Optionsseite trägt denselben Wert wie der beobachtete Dial des Hintergrunds (kein DOM-Test, siehe `## Bekannte Lücken`) |
| `test/extension.test.js` | `connect_withUnparseableEndpoint_shouldReportOnceAndScheduleReconnect` (erweitert) | ein gespeicherter Unsinn bleibt der Fehlerfall von heute — und der Standard hat ihn nicht übernommen |
| `npm test` (Projektlauf) | `# fail 0`, `# cancelled 0`, `# skipped 0` | nichts ist kaputt |

## Acceptance criteria

1. **Der Standard ist `ws://127.0.0.1:8110`, genau einmal je Datei.** Beweis —
   der Name **und** der Wert, zeilenweise gepinnt:
   `grep -Fc 'const DEFAULT_ENDPOINT = "ws://127.0.0.1:8110";' extension/bridge.js`
   ⇒ **1**; dieselbe Zeile für `extension/options.js` ⇒ **1**; dazu
   `grep -Fc 'ws://127.0.0.1:8110' extension/bridge.js` ⇒ **1** (die Adresse
   wird in der Datei nicht wiederholt — auch nicht in einem Kommentar, sonst
   zählt der Beweis zwei Zeilen und wäre falsch-rot). Die Zeile wird **wörtlich**
   gepinnt, einschließlich doppelter Anführungszeichen und eines Leerzeichens um
   `=`; wer sie umformatiert, zieht den Beweis mit.
2. **Der Port ist der der Bridge.** Beweis: der Fall
   `endpoint_default_matchesTheBridgesDefaultPort` liest `DEFAULT_BIND` aus
   `bridge/config.mjs` und vergleicht ihn mit der Dial-Adresse des
   Hintergrunds; grün gezählt:
   `node --test --test-reporter=tap --test-name-pattern='^endpoint_default_matchesTheBridgesDefaultPort$' test/extension.test.js | grep -cE '^ok [0-9]+ - endpoint_default_matchesTheBridgesDefaultPort'`
   ⇒ **1**. Ändert jemand `DEFAULT_BIND` **oder** die Konstante, wird der Fall rot.
3. **Ein leerer Endpunkt verbindet, statt zu schweigen — vier Fälle, jeder
   grün.** Beweis:
   `node --test --test-reporter=tap --test-name-pattern='^endpoint_' test/extension.test.js | grep -cE '^ok [0-9]+ - endpoint_(withoutAStoredValue_shouldDialTheLoopbackDefault|withAStoredValue_shouldDialThatValue|default_matchesTheBridgesDefaultPort|default_isTheSameInOptionsAndBackground)'`
   ⇒ **4**. Der Fehlerfall mit gespeichertem Unsinn wird **nicht** dupliziert:
   die eine neue Zusicherung („keine Konsolenzeile enthält den Standard") kommt
   in den bestehenden Fall `connect_withUnparseableEndpoint_shouldReportOnceAndScheduleReconnect`.
4. **Gespeicherte Werte gewinnen.** Beweis: `endpoint_withAStoredValue_shouldDialThatValue`
   fährt einen `wss://`-Endpunkt und beobachtet ihn als Dial-Adresse (grüne
   `ok`-Zeile ⇒ **1**). **Wächter, heute schon grün:** der Bestandsfall mit
   gespeichertem Endpunkt bleibt:
   `node --test --test-reporter=tap --test-name-pattern='^connect_withEndpointAndToken_shouldSendHelloWithProtocolOneAndToken$' test/extension.test.js | grep -cE '^ok [0-9]+ - connect_withEndpointAndToken_shouldSendHelloWithProtocolOneAndToken'`
   ⇒ **1**.
5. **Anzeige und Verhalten sind derselbe Wert — und nur ein leeres Feld wird
   gefüllt.** Beweis: `endpoint_default_isTheSameInOptionsAndBackground` liest
   die Konstante aus `options.js` und vergleicht sie mit der beobachteten
   Dial-Adresse; dieselbe Zusicherung prüft, dass `options.js` die Form
   `storedEndpoint === "" ? DEFAULT_ENDPOINT : storedEndpoint` trägt (ein
   gespeicherter Wert wird angezeigt, wie er ist); `ok`-Zeile ⇒ **1**.
6. **Der Fernfall bleibt beschrieben.** `extension/options.html` nennt unter dem
   Feld, dass die URL nur für eine Bridge auf einem anderen Rechner geändert
   wird, und der Platzhalter zeigt keine konkrete Fremdadresse mehr. Beweis:
   `grep -c 'example.com' extension/options.html` ⇒ **0** (Exit 1);
   `tr '\n' ' ' < extension/options.html | grep -ciE 'andere[mnr]?[[:space:]]+Rechner'`
   ⇒ **≥ 1** (die Beugung ist offen; `grep` zählt Zeilen, `tr` macht aus dem
   umbrochenen Hinweis eine Zeile);
   dazu `INSTALL.md`, mit **demselben** Schnitt wie im Plan:
   `sed -n '/^## 4\. Browser/,/^## 5\./p' INSTALL.md | grep -Fc 'is pre-filled with'`
   ⇒ **1** (der längere Anker, weil die Adresse in §4 schon steht — ein
   `grep -Fc 'ws://127.0.0.1:8110'` wäre heute schon 1 und nach einer *richtigen*
   Ergänzung 2); `… | grep -ciE 'another machine|other machine'` ⇒ **≥ 1**;
   `grep -Fc 'endpoint or token empty' INSTALL.md` ⇒ **0** (Exit 1).
7. **Kein neues Feld, keine neue Berechtigung, kein Werkzeug. Wächter, heute
   schon grün** — er entscheidet nichts über dieses Inkrement, er hält es
   klein. Beweis:
   `git diff HEAD -- extension/manifest.json` ⇒ **leer**;
   `grep -c 'TOOL_COUNT = 13' test/http-mcp.test.js` ⇒ **1**; `npm test` grün.
8. **Kein Produktcode außerhalb der Grenze.** Beweis — **vor dem Commit**, denn
   nach dem Commit ist der Baum leer und die Prüfung vakuum-grün:
   `git diff --stat HEAD` nennt genau `extension/background.js`,
   `extension/options.js`, `extension/options.html`, `test/extension.test.js`,
   `INSTALL.md`, `docs/…` und **keine** ungetrackte Datei;
   `git diff HEAD -- bridge/` ⇒ **leer** (die Bridge wird nur **gelesen**, nicht
   geändert).
9. **Kein Geheimnis. Wächter, heute schon grün.** Beweis:
   `git grep --untracked -nE '[0-9a-f]{32,}' -- .` ⇒ keine Ausgabe, Exit 1.

## Dev plan

Bau-Reihenfolge, eine Stufe je Auftrag, keine Stufe hängt von einer späteren
ab. Der Wert `ws://127.0.0.1:8110` steht **einmal je Datei** als
`const DEFAULT_ENDPOINT`; geteilt wird er über die Fälle aus Stufe 2–4, nicht
über ein neues Modul. Alle Beweise ohne `$` am Musterende, damit ein angehängter
TAP-Kommentar den Treffer nicht verschluckt; `grep -c` mit `0` Treffern endet mit
Exit 1 — das ist dort das Ergebnis, nicht der Fehler.

**1. Hintergrund: der Standard greift vor der Leer-Prüfung.** (Umsetzer)
`extension/background.js` — die Datei heißt seit `docs/42` `extension/bridge.js`,
dort steht die Zeile: `const DEFAULT_ENDPOINT = "ws://127.0.0.1:8110";`
neben `ENDPOINT_KEY`/`TOKEN_KEY` — der Kommentar darüber nennt
`bridge/config.mjs` (`DEFAULT_BIND`) und Spec 36, wiederholt die Adresse aber
**nicht**. In `connect()` direkt nach dem `readSettings`-`try/catch` und **vor**
der Prüfung „endpoint oder token leer": `if (settings.endpoint === "")
settings.endpoint = DEFAULT_ENDPOINT;`. Der Endpunkt-Half der Warnung bleibt
stehen; ein leerer **Token** verbindet weiterhin nicht.
`test/extension.test.js`: `startBackground_withTokenButNoEndpoint_shouldNotOpenConnection`
wird durch `endpoint_withoutAStoredValue_shouldDialTheLoopbackDefault`
**ersetzt** — gleiches GIVEN (`{ token: TOKEN }`), umgekehrtes THEN (Dial-Adresse
ist der Standard, keine `warn:`-Zeile, `storage.local` unverändert). Der
Nachbarfall mit leerem Token bleibt.

Proof:
```
node --test --test-reporter=tap --test-name-pattern='^endpoint_withoutAStoredValue' test/extension.test.js | grep -cE '^ok [0-9]+ - endpoint_withoutAStoredValue_shouldDialTheLoopbackDefault'   # ⇒ 1
grep -c 'startBackground_withTokenButNoEndpoint_shouldNotOpenConnection' test/extension.test.js; echo $?   # ⇒ 0, Exit 1
npm test; echo $?   # ⇒ 0, "# fail 0" und "# cancelled 0"
```

**2. Wächter: der Port ist der der Bridge.** (Umsetzer, nur Testdatei)
Import `loadConfig` aus `../bridge/config.mjs` mit `NO_ENV = {}` (Vorbild
`test/config.test.js`) — ohne `{}` läse er `process.env` und ein exportiertes
`BC_BIND` vergliche den Standard gegen eine fremde Adresse. Fall
`endpoint_default_matchesTheBridgesDefaultPort`: Hintergrund mit
`{ token: TOKEN }` starten, `new URL(FakeWebSocket.latest().url)` gegen
`loadConfig(NO_ENV)` — `protocol === "ws:"`, `hostname === config.host`,
`port === String(config.port)`.

Proof:
```
node --test --test-reporter=tap --test-name-pattern='^endpoint_default_matchesTheBridgesDefaultPort$' test/extension.test.js | grep -cE '^ok [0-9]+ - endpoint_default_matchesTheBridgesDefaultPort'   # ⇒ 1
```

**3. Optionsseite: derselbe Wert, sichtbar, mit Hinweis.** (Umsetzer)
`extension/options.js`: `const DEFAULT_ENDPOINT = "ws://127.0.0.1:8110";`. In
`loadSettings` die Zuweisung ersetzen durch
`const storedEndpoint = asText(stored[ENDPOINT_KEY]).trim();` und in **einer**
Zeile `… = storedEndpoint === "" ? DEFAULT_ENDPOINT : storedEndpoint;` —
gespeicherte Werte werden angezeigt, wie sie sind, auch `wss://…`.
`extension/options.html`: den Platzhalter `wss://example.com/browser-control/ws`
**entfernen** (das Feld ist vorbelegt; eine zweite Kopie der Adresse wäre eine
dritte Driftstelle), unter dem Feld einen `p class="hint"` mit dem Fernfall, und
den Kopfsatz korrigieren: leer ist jetzt nur noch der **Token**, der eine
Verbindung verhindert.
Fall `endpoint_default_isTheSameInOptionsAndBackground`: `options.js` als Text
lesen, die Konstante per Muster ziehen, mit der im VM **beobachteten**
Dial-Adresse vergleichen; zweite Zusicherung im selben Fall: die Datei trägt die
Form `storedEndpoint === "" ? DEFAULT_ENDPOINT : storedEndpoint`.

Proof:
```
node --test --test-reporter=tap --test-name-pattern='^endpoint_default_isTheSameInOptionsAndBackground$' test/extension.test.js | grep -cE '^ok [0-9]+ - endpoint_default_isTheSameInOptionsAndBackground'   # ⇒ 1
grep -c 'example.com' extension/options.html; echo $?   # ⇒ 0, Exit 1
tr '\n' ' ' < extension/options.html | grep -ciE 'andere[mnr]?[[:space:]]+Rechner'   # ⇒ 1
```

**4. Unsinn bleibt ein Fehler — und der Gesamtlauf.** (Umsetzer)
Der bestehende Fall `connect_withUnparseableEndpoint_shouldReportOnceAndScheduleReconnect`
bekommt **eine** Zusicherung dazu: keine Konsolenzeile enthält
`ws://127.0.0.1:8110` — der Standard hat einen gespeicherten Tippfehler nicht
übernommen. Kein fünfter `endpoint_`-Fall: die übrigen Zusicherungen (eine
`bc: Endpunkt ungültig:`-Zeile, `instances.length === 0`, `pendingDelays()` ⇒
`[1000]`) hält dieser Fall bereits. Dazu der Fall
`endpoint_withAStoredValue_shouldDialThatValue`: `{ endpoint:
"wss://bridge.example.test/browser-control/ws", token: TOKEN }` ⇒ die
Dial-Adresse ist genau dieser Wert.

Proof:
```
node --test --test-reporter=tap --test-name-pattern='^endpoint_' test/extension.test.js | grep -cE '^ok [0-9]+ - endpoint_(withoutAStoredValue_shouldDialTheLoopbackDefault|withAStoredValue_shouldDialThatValue|default_matchesTheBridgesDefaultPort|default_isTheSameInOptionsAndBackground)'   # ⇒ 4
npm test; echo $?    # ⇒ 0, "# fail 0", "# cancelled 0", "# skipped 0"
npm run check; echo $?   # ⇒ 0
```

**1a. Die Amendments ausführen.** (Umsetzer, Teil von Stufe 1)
`docs/01-skelett-verbindung-und-status.md`: die drei in `## Amendments to
previous spec docs` genannten Stellen (Ziel-Absatz, `## Configuration`-Zeile
zum `endpoint`, die drei „ohne Endpunkt/Token"-Stellen) werden auf „ohne
**Token** kein Versuch; ohne Endpunkt der Standard" gezogen. Proof:
`grep -cE 'ohne (gespeicherten )?Endpunkt' docs/01-skelett-verbindung-und-status.md; echo $?`
⇒ **0, Exit 1**; `grep -cE 'bei fehlendem Endpunkt' docs/01-skelett-verbindung-und-status.md; echo $?`
⇒ **0, Exit 1**; `grep -ciE 'ohne Token|fehlendem Token' docs/01-skelett-verbindung-und-status.md`
⇒ **≥ 1**.

**5. `INSTALL.md` (englisch).** (Umsetzer)
§4 Schritt 5: das Feld **is pre-filled with** `ws://127.0.0.1:8110` und wird nur
geändert, wenn die Bridge auf einem **anderen** Rechner läuft; der Caddy-Verweis
in §9 bleibt. In §8 die Zeile „endpoint or token empty" auf den Token verkürzen —
ein leeres Feld schweigt nach dieser Änderung nicht mehr.

Proof:
```
sed -n '/^## 4\. Browser/,/^## 5\./p' INSTALL.md | grep -Fc 'is pre-filled with'   # ⇒ 1
sed -n '/^## 4\. Browser/,/^## 5\./p' INSTALL.md | grep -ciE 'another machine|other machine'   # ⇒ ≥ 1
grep -Fc 'endpoint or token empty' INSTALL.md; echo $?   # ⇒ 0, Exit 1
```

### What could go wrong

- **Der widersprechende Bestandsfall.** `…_withTokenButNoEndpoint_shouldNotOpenConnection`
  behauptet „es gibt nichts anzuwählen" — genau das hebt die Spec auf. Bleibt
  er stehen, wird `npm test` rot; er wird **ersetzt**, nicht repariert.
- **Der Standard am falschen Ort.** In `readSettings` gesetzt, wäre der Name
  eine Lüge und die Spec-Formulierung nicht mehr am Code ablesbar.
- **Das Literal ein zweites Mal.** Ein Kommentar mit der Adresse macht aus
  Kriterium 1 eine **2** — formal richtig, aber falsch-rot. Kommentare nennen
  `DEFAULT_ENDPOINT` und `DEFAULT_BIND`.
- **`loadConfig()` ohne Argument** liest `process.env` — `NO_ENV = {}` benutzen.
- **Der Options-Wächter kann sich selbst bestätigen.** Er vergleicht die
  Konstante aus `options.js` mit der **beobachteten** Dial-Adresse des
  Hintergrunds (`FakeWebSocket.latest().url`) — nicht mit einem Literal aus der
  Testdatei. Wer ihn gegen `"ws://127.0.0.1:8110"` aus dem Test schreibt, hat
  einen grünen Beweis, der auch bei zwei kaputten Dateien grün bleibt. Die
  Testdatei trägt die Adresse als `ENDPOINT` (10 Vorkommen); sie bleibt wie sie
  ist und ist **nicht** die Vergleichsquelle.
- **Der einzige Optionsbeweis ist Text.** Es gibt keinen DOM-Harness für
  `options.js`; die Regel „nur wenn nichts gespeichert ist" hängt an einem
  Muster auf dem Quelltext. Ein Umformatieren macht den Fall rot, obwohl das
  Verhalten stimmt — dann Zusicherung und Zeile gemeinsam ändern.
- **Die Vorbelegung ist keine Bindung.** Nach dem ersten Speichern steht die
  Adresse in `storage.local` und ist damit der Wert des Betreibers.
- **Loopback in Firefox** bleibt ungemessen (`## Bekannte Lücken`).

### Ordering and dependencies

1 → 2 → 3 → 4 → 5, dann 6 (Orchestrator: `status: active`, `docs/README.md`,
`docs/PROJECT-STATE.md`). Stufe 2 und 3 brauchen den Standard aus Stufe 1;
Stufe 4 braucht alle vier Fälle, um auf **4** zu zählen. Stufe 5 ist vom Code
unabhängig, nennt aber denselben Wert.

### What the next increment inherits

- **Die Warnung „missing settings"** sagt weiter „Endpunkt oder Token fehlt",
  obwohl nur noch der Token fehlen kann — eine offene Lüge im Log. **Warum
  nicht hier:** die Zeile ist in `docs/01` dokumentiert (`active`) und von
  keinem Test gepinnt; sie zu ändern zieht eine weitere Amendments-Zeile nach
  sich. Eine Zeile Arbeit, eine Entscheidung des Betreibers.
- **Kein DOM-Harness für `options.js`**; der ehrliche Test („leere Ablage ⇒ Feld
  zeigt den Standard") braucht einen `document`-Stub — eigene Spec.
- **`docs/PROJECT-STATE.md`** beschreibt den Endpunkt weiter als Handarbeit;
  Stufe 6 zieht nur Spec-Status und Registry nach.
- **Anderer Port, andere Maschine** bleiben Handarbeit (§9) — keine Discovery.

## Amendments to previous spec docs

Diese Spec löst **eine Zusage** von `docs/01-skelett-verbindung-und-status.md`
(`active`) ab — die Spec sagt heute das Gegenteil.

| Datei | Stelle | alt | neu |
|---|---|---|---|
| `docs/01-…` | `## Wire-Protokoll`, zitiert in `## Ziel` (~121) | „Ohne gespeicherten Endpunkt oder ohne Token wählt sich die Extension nicht raus und schreibt das einmal" | „Ohne **Token** wählt sie sich nicht raus und schreibt das einmal; ein leerer Endpunkt ist `ws://127.0.0.1:8110` (`docs/36`)" |
| `docs/01-…` | `## Configuration`, Zeile ~194 | `endpoint \| (leer) \| wss://example.com/…; leer = keine Verbindung` | `endpoint \| ws://127.0.0.1:8110 \| leer ⇒ Standard; gespeicherte Werte, auch wss://…, gewinnen (docs/36)` |
| `docs/01-…` | `## Testing` (~265), Dev-Plan-Proof (~448), `## Log` S2 (~799) | „ohne Endpunkt/Token kein Verbindungsversuch" | „ohne **Token** kein Verbindungsversuch; ohne Endpunkt der Standard" |
| `docs/01-…` | ~444, Meldungstext | „einmalig die Meldung bei fehlendem Endpunkt oder Token" | „einmalig die Meldung bei fehlendem **Token**" |

`docs/01` bleibt `active`; die Zeilen werden in **Stufe 1** mitgezogen (die
Stufe, die das Verhalten ändert, `docs/README.md`).

## Bekannte Lücken

Stand 2026-11-15, vor der Umsetzung:

- **Die Optionsseite ist nur per Textmuster geprüft (2026-11-15).** Es gibt
  keinen DOM-Harness; der Fall vergleicht Quelltext, nicht gerendertes Feld. Der
  ehrliche Test bräuchte einen `document`-Stub — eigene Spec.
- **`ws://` ist unverschlüsselt, und das Token geht im `hello` mit
  (2026-11-15).** Auf einem Einzelplatzrechner ist das vertretbar; wer Port
  8110 vor der Bridge belegt, bekommt ein gültiges Token. `wss://` (§9) oder
  Token-Rotation sind die Antworten, nicht dieses Inkrement. **Seit
  2026-11-18 ist der Fernfall geschlossen:** der Dial verweigert `ws://` auf
  jedem Nicht-Loopback-Host und nennt `wss://` und den SSH-Tunnel
  (`INSTALL.md` §9). Offen bleibt allein der lokale Fall — dort ist der
  Klartext auf das Loopback-Interface begrenzt.
- ~~**Der Endpunkt-Half der Leer-Prüfung ist toter Code (N1, 2026-11-15).**~~
  **Überholt am 2026-11-23:** `extension/background.js` enthält keine
  Endpunkt-Logik mehr (`grep -c 'ndpunkt\|ENDPOINT'` ⇒ 0); die Prüfung lebt in
  `extension/bridge.js` (Endpunkt, Standard `DEFAULT_ENDPOINT`), der alte Arm und
  sein Log-Text sind mit dem Umbau entfallen. Nachgezählt, nicht geglaubt.
- ~~**Zwei Trimmen (N2, 2026-11-15).**~~ **Erledigt am 2026-11-23:** `asText`
  (`extension/bridge.js:629-631`) trimmt beim Lesen; der handgepflegte Wert aus
  Leerzeichen fällt auf den Standard zurück, wie die Spec es will. Kein
  Produktcode geändert — der Befund war beim Nachsehen schon behoben.
- ~~**`endpoint_withAStoredValue…` zählt die Sockets nicht (N3).**~~
  **Erledigt am 2026-11-23:** der Fall prüft jetzt zusätzlich
  `FakeWebSocket.instances.length === 1` (`test/extension.test.js:2572`); eine
  doppelte Wahl wäre rot.
- ~~**Der Hinweis in `options.html` bricht die Zeilenbreite (N4)**~~ **Überholt am
  2026-11-23:** die Optionsseite ist mit `docs/54` neu geschrieben (englische
  Hinweise, eigenes `<p class="hint">` je Feld); der Hinweis steht unter seinem
  Feld und bricht sauber.
- **Ungemessen:** ob Firefox `ws://127.0.0.1:8110` aus einer
  `moz-extension://`-Seite unter allen Profil-Einstellungen erlaubt. Loopback
  gilt als vertrauenswürdig; gemessen wird es erst im Live-Lauf.
- **Nicht abgedeckt:** eine Bridge auf einem anderen Port (`BC_BIND` geändert) —
  dann muss der Betreiber den Endpunkt eintragen, wie heute.
- **Nicht abgedeckt:** mehrere Bridges im selben Netz.

## Open questions

**Keine offenen.** Entschieden am 2026-11-15 vom Betreiber: `ws://127.0.0.1:8110`,
sichtbar vorbelegt, nur bei leerem Feld.

## Review

### Code-Review Runde 2 — 2026-11-15: `✅ Ship it`

Kein Blocker, alle neun Kriterien mit Befehl belegt, sieben Mutationsproben rot
(Standard entfernt, Port geändert, Optionsseite füllt immer, Fallback schreibt
zurück, Fallback überschreibt). Vier Nachträge, alle als Lücke benannt:
toter Endpunkt-Arm der Warnung (N1), zwei Trimmen (N2), fehlende
`instances.length`-Zusicherung (N3), Formatierung des Hinweises (N4), zwei
Doku-Stellen (N5).

### Runde 1 — 2026-11-15, `grizzled-senior-dev`: 🔧 (3 Blocker)

Ziel und Kriterien hat der Betreiber am 2026-11-15 abgesprochen, der Dev-Plan
lag vor. Drei Blocker, acht Major, eine Sicherheits-Lücke, vier Nits — **alle
übernommen** (`## Log`).

## Log

- **2026-11-15, Betreiberentscheid:** Standard-Endpunkt `ws://127.0.0.1:8110`,
  sichtbar vorbelegt; gespeicherte Werte bleiben unberührt.
- **Runde 1 — B1 übernommen:** `docs/01` (`active`) sagt das Gegenteil; ein
  Abschnitt `## Amendments to previous spec docs` benennt die drei Stellen, und
  **Stufe 1** zieht sie mit (die Stufe, die das Verhalten ändert).
- **Runde 1 — B2 übernommen:** der `INSTALL.md`-Beweis pinnt jetzt den längeren
  Anker `is pre-filled with`; die Adresse steht dort schon, ein `grep` darauf
  wäre vorher wie nachher 1 und nach einer Ergänzung 2.
- **Runde 1 — B3 übernommen:** der Hinweistext wird mit
  `andere[mnr]?[[:space:]]+Rechner` geprüft (Beugung und Zeilenumbruch), nicht
  mit dem Nominativ.
- **Runde 1 — M1 bis M8 übernommen:** Wächter als Wächter gekennzeichnet
  (Kriterien 4, 7, 9); der `ok`-Befehl in Kriterium 4 ausgeschrieben; Kriterium 8
  vor dem Commit mit `git diff --stat HEAD`; der fünfte Fall fällt weg (die neue
  Zusicherung wohnt im Bestandsfall, Zählung **4**); die `ENDPOINT`-Falle richtig
  beschrieben (Vergleich gegen den beobachteten Dial, nicht gegen ein Literal);
  „10 Vorkommen" und die dritte Kopie in der Testdatei benannt; die Optionsseite
  in der Lückeliste als textgeprüft markiert; die Log-Lüge mit Begründung
  vertagt.
- **Runde 1 — S1 übernommen:** `ws://` und das Token im `hello` als Lücke
  benannt; `wss://` und Token-Rotation sind die Antworten, nicht dieses
  Inkrement.
- **Runde 1 — Nits übernommen:** Formatierung der gepinnten Zeile erwähnt; die
  `npm test`-Zeile als Projektlauf gekennzeichnet; `## Review` trägt jetzt Runde
  1 mit Datum und Verdict.
