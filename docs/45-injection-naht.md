---
description: Die Injection-Naht — Quelltext raus, Datei plus Nachrichten; 16 Aufrufstellen antworten danach unverändert, und die Frame-Inventur entsteht aus Selbstmeldungen.
status: active
---

# Die Injection-Naht

Abgespalten von `docs/42` nach dem dritten Review-Block (2026-11-17). `docs/42`
bringt den Socket in einen Tab; **diese Spec ersetzt, wie Code in die Seite
kommt.** Sie läuft nach `docs/42`, weil die 16 Aufrufer danach in `bridge.js`
liegen.

**Warum das ein eigenes Inkrement ist:** `pageSnippetCode` baut heute
**Quelltext** und schickt ihn als `code` an `browser.tabs.executeScript`. Das
ist mehr als eine Umbenennung — es ist ein anderer Weg in die Seite, mit einem
anderen Rückweg, und es berührt 16 Aufrufstellen.

## Ziel

- **Kein Quelltext mehr auf der Leitung.** Die drei Helfer (`describeElement`,
  `isVisible`, `isAddressedFrame`) reisen als **Datei** (`page-agent.js`), nicht
  als eingebetteter Text; `pageSnippetCode` verschwindet.
- **Die Antwort kommt als Nachricht.** `{file}` liefert `undefined`; der
  Aufrufer schickt `{callId, op, args}` per `tabs.sendMessage`, der Dispatcher
  antwortet mit `{callId, ok, value}`, die Seite ordnet über `callId` zu.
- **Die Frame-Inventur entsteht aus Selbstmeldungen.** Jeder Frame antwortet
  selbst, `sender.frameId` steht in der Nachricht — der Inhaltsfilter bleibt,
  weil ein Frame stumm bleiben darf.
- **Alle 16 Aufrufer antworten unverändert.** Dieselben Werkzeugergebnisse,
  dieselben Fehlercodes, dieselben englischen Sätze (seit `docs/54`).
- **Noch MV2.** Die Umstellung auf `scripting` ist `docs/43`; hier bleibt es bei
  `browser.tabs.executeScript({file})`.

## Non-goals

- **Kein `scripting`, keine neue Berechtigung.** Das ist `docs/43`.
- **Kein Umzug des Sockets, keine Tab-Verwaltung.** Das ist `docs/42`.
- **Kein Schalter, keine Icons.** Das ist `docs/44`.
- **Kein neues Werkzeug, kein neues Argument.** Die dreizehn Werkzeuge bleiben
  dreizehn, ihre Argumente bleiben.
- **Keine Änderung an der Bridge.**

## Das Inventar (aus dem Code gelesen, 2026-11-17)

| Was | Stand |
|---|---|
| `injectPageCode` | **eine** Definition (2185), **16** echte Aufrufe (2039, 2086, 2943, 3128, 3304, 3357, 3717, 4726, 5450, 6718, 6720, 6736, 6747, 6821, 6840, 6866) |
| `pageSnippetCode` | baut Quelltext: `(() => { ${PAGE_HELPERS_CODE} … return (${source.toString()})(${argumentList}); })()`; Helfer als Text mit (2229–2233, 2830) |
| Aufrufer je Werkzeug | `readAgentTabPage`, `settleAgentTab`, `clickAgentTab`, `clickResult`, `typeAgentTab`, `typeResult`, `inspectAgentTab`, `evalAgentTab`, `framesAgentTab` (4×), `transcriptAgentTab`, `seekAndReadTranscriptFile`, `restoreTranscriptPlayer` |
| `framesOf` | entscheidet nach **Inhalt**, weil `tabs.executeScript` mit `allFrames` in unversprochener Reihenfolge liefert |
| Fristen | `PROTOCOL.CALL_TIMEOUT_MS` gilt für den Werkzeugaufruf über die Bridge |

## Die Naht

**Aufrufer:** `injectPageCode(tabId, {op, args, allFrames})` injiziert
`page-agent.js` per `{file, runAt: "document_idle", allFrames, matchAboutBlank}`
und schickt danach die Nachricht. Es wartet auf die Antwort mit derselben
`callId`; ein zweiter Aufruf derselben Seite erhält eine eigene `callId`.

**Dispatcher (`page-agent.js`):** hört auf `runtime.onMessage`, prüft `op`,
führt die Funktion mit `args` aus, antwortet `{callId, ok, value}` oder
`{callId, ok: false, error}`. Er kennt seine eigene `frameId` nicht — sie steht
beim Empfänger in `sender.frameId`.

**Drei Fälle, die die Naht festlegen muss** (aus dem Review von `docs/42`):

1. **Die Frame-Liste kommt aus den Selbstmeldungen.** Ein Aufruf schickt
   `{op: "inventory"}` ohne `frameId` an den Tab; jeder Frame antwortet, die
   Liste entsteht aus den Antworten. `framesOf` darf **kein** Array aus der
   Injection erwarten, sonst wirft es sofort `frames_failed`.
2. **Die Frist ist ein eigenes Budget: `INJECTION_REPLY_TIMEOUT_MS = 5000`.**
   **Nicht** `PROTOCOL.CALL_TIMEOUT_MS` (20 000): die wäre genauso lang wie der
   Bridge-Timeout, und der Agent sähe `ExtensionTimeout`, statt die Antwort des
   Werkzeugs zu bekommen. 5 000 liegt unter allen lokalen Budgets
   (`SETTLE_GUARD_MS` 4 s, `NAVIGATE_TIMEOUT_MS` 8 s) und über einem normalen
   frame-übergreifenden Antwortweg.
3. **Ein abgelehntes `tabs.sendMessage`** („Could not establish connection.
   Receiving end does not exist") trifft nach jeder Navigation einen Frame. Es
   ist **kein** Fehler, sondern wird wie ein stummer Frame behandelt: Werkzeug ⇒
   `not_readable`, Inventur ⇒ `frames_failed`.

**Wie eine Sammlung endet** (Betreiber- und Umsetzerfrage aus dem Bauversuch am
2026-11-18): `tabs.executeScript({file, allFrames: true})` liefert **ein Element
je injiziertem Frame** (bei `{file}` jeweils `undefined`) — die **Länge ist die
Frame-Zahl**. Gesammelt wird also, bis **genau diese Zahl** Antworten mit der
passenden `callId` da ist; danach wird nicht weiter gewartet. Ein stummer Frame
wird durch die Frist beendet, nicht durch eine Idle-Heuristik.

Drei Regeln hängen daran:

- **Kein Auflösen beim ersten Treffer.** `frame_ambiguous` (und der Frame-Filter
  aus `docs/24`) braucht **alle** Antworten; ein früher Abbruch würde den Fall
  still entwerten.
- **Späte Antworten werden über `callId` verworfen.** Trifft eine Antwort nach
  der Frist ein, gehört sie zu einem abgeschlossenen Aufruf und darf nicht dem
  nächsten zugeschlagen werden.
- **`callId` ist je Aufruf eindeutig**, auch bei zwei Aufrufen auf demselben
  Tab: ein Zähler, kein Zeitstempel, kein Zufall.

## Risiken

1. **`page-agent.js` läuft in der isolierten Welt.** Es sieht das DOM, aber
   keine Seitenvariablen — genau wie heute der injizierte Quelltext. Kein
   Verhaltensunterschied, aber es muss im Kommentar stehen, damit niemand
   später „warum kein `window.x`?" fragt.
2. **Doppelte Injection.** Zwei Aufrufe kurz hintereinander laden die Datei
   zweimal; der zweite Dispatcher überschreibt den ersten. Der Guard ist die
   `callId`: jede Antwort gehört genau einem Aufruf, und ein zweiter Listener
   darf keine fremde `callId` bedienen.
3. **`about:`, `view-source:`, AMO und der PDF-Viewer** lassen keine Injection
   zu. Heute fängt `injectPageCode` den Fehler und übersetzt ihn in
   `not_readable`/`frames_failed`; das muss unverändert bleiben.
4. **Der Harness.** `test/extension.test.js` (16 512 Zeilen) stubbt
   `tabs.executeScript` mit `{code}`; nach dem Umbau braucht er `{file}` plus
   einen Nachrichtenkanal. Das ist der größte Einzelposten dieser Spec.
5. **Die zwei Kommentare**, die `tabs.executeScript` mit `code` erklären
   (2176, 5395), beschreiben danach einen Weg, den es nicht mehr gibt.

## Touch boundary

**Erlaubt:** `extension/page-agent.js` (neu), `extension/bridge.js` (die 16
Aufrufer, `injectPageCode`, `framesOf`), `extension/background.js` (nur falls
Reste dort liegen), `extension/manifest.json` (nur `web_accessible_resources`
für `page-agent.js`), `test/extension.test.js`, `test/bridge-tab.test.js`
(Nachrichtenkanal im Stub), `docs/45`, `docs/README.md`,
`docs/PROJECT-STATE.md`, `CHANGELOG.md`.

**Nicht:** `bridge-rs/**`, `extension/options.*`, `test/fixtures/**`,
`scripts/parity/**`, `docs/42` (außer dem Verweis), `deploy/**`.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | die 16 Aufrufer gegen `{file}` plus Nachrichtenkanal | die Werkzeuge antworten unverändert |
| `test/extension.test.js` | `injection_whenAFrameStaysSilent_shouldRejectAtTheDeadline` | die Frist ist `INJECTION_REPLY_TIMEOUT_MS` (5 000 ms), also **unter** dem Bridge-Timeout — der Agent bekommt die Werkzeugantwort statt `ExtensionTimeout` |
| `test/extension.test.js` | `injection_whenSendMessageIsRejected_shouldAnswerNotReadable` | ein abgelehnter Kanal ist `not_readable`, kein Absturz |
| `test/extension.test.js` | `injection_withTwoCallIds_shouldAnswerEachCallerOnce` | Antworten werden über `callId` zugeordnet, nicht über Reihenfolge |
| `test/extension.test.js` | `frames_inventory_shouldComeFromSelfReports` | die Inventur entsteht aus Antworten mit `sender.frameId` |
| `test/extension.test.js` | `frames_withAnEmptyEntry_shouldNotShiftTheFilter` | der Inhaltsfilter bleibt (Einträge dürfen leer sein) |

## Acceptance criteria

1. **Kein Quelltext mehr.** `grep -Fc 'pageSnippetCode(' extension/bridge.js`
   ⇒ **0** und `grep -Fc 'pageSnippetCode(' extension/background.js` ⇒ **0**;
   `grep -Fc 'PAGE_HELPERS_CODE' extension/bridge.js extension/background.js`
   ⇒ **0** in beiden.
2. **Der Aufrufer lädt die Datei, er baut nichts.** `grep -Fc 'page-agent.js'
   extension/bridge.js` ⇒ **≥ 1**; `test -f extension/page-agent.js` ⇒ **0**.
3. **Alle 16 Aufrufer antworten.** `npm test` ⇒ `# fail 0`, `# cancelled 0`.
4. **Die drei Randfälle haben Fälle.** `node --test --test-reporter=tap
   test/extension.test.js 2>&1 | grep -cE '^ok [0-9]+ - injection_'` ⇒ **≥ 3**
   (stummer Frame, abgelehnter Kanal, zwei `callId`).
5. **Die Inventur kommt aus Selbstmeldungen.** `frames_inventory_shouldComeFromSelfReports`
   ⇒ grün, und `framesOf` bekommt kein Array aus der Injection mehr
   (`grep -Fc 'executeScript' extension/bridge.js` ⇒ **1**, die eine
   Aufrufstelle).
6. **Die Parität bleibt.** `scripts/parity.sh --impl rust --check` ⇒ `7/7 wie
   erwartet`, `--self-test` ⇒ `7/7 rot wie erwartet`.
7. **Der Fehlerpfad ist unverändert.** `about:debugging` öffnen und `read`
   aufrufen ⇒ `not_readable` mit demselben englischen Satz wie vorher (seit
   `docs/54`; der Satz bleibt, nur seine Sprache hat gewechselt)
   (`test/extension.test.js` deckt ihn; hier als Sichtprüfung des Betreibers).

## Dev plan

Der Umbau läuft in zwei Blöcken — er ist zu groß für einen Zug, und
`pageSnippetCode` darf erst fallen, wenn der letzte der 16 Aufrufer umgestellt
ist.

**Stufe 1a — `page-agent.js`, der Kanal und die Sammlung**

Dateien: `extension/page-agent.js` (neu: Helfer, idempotenter Dispatcher),
`extension/bridge.js` (`injectPageCode`, `callId`-Zähler, Sammler mit
`INJECTION_REPLY_TIMEOUT_MS`, `frameTargetOf`), `extension/manifest.json`
(`web_accessible_resources`), `test/extension.test.js` (Stub: `{file}` plus
Kanal).

Beweis: Kriterien 2, 3, 4 und die drei `injection_*`-Fälle. `pageSnippetCode`
steht danach noch — das ist der Zwischenstand, nicht das Ziel.

**Stufe 1b — die 16 Aufrufer, in zwei Blöcken**

Erster Block: `read`, `click`, `type` — sie antworten auf `sender.frameId` und
brauchen den Frame-Filter. **Gebaut am 2026-11-18** (siehe Log). Zweiter Block:
`inspect`, `eval`, `frames`, `transcript` — **gebaut am 2026-11-18**. Mit dem
letzten Aufrufer sind `pageSnippetCode`, `PAGE_HELPERS_CODE`, die drei Helfer in
`bridge.js` und der Testhaken gefallen; `injectPageCode` heißt `askPageAgent` und
hat nur noch den Nachrichtenpfad.

Beweis: Kriterien 1, 5, 6; `grep -Fc 'pageSnippetCode('` ⇒ 0.

**Stufe 2 — die Frame-Inventur auf Selbstmeldungen**

Dateien: `extension/bridge.js` (`framesAgentTab`, `framesOf`),
`test/extension.test.js` (die zwei Frame-Fälle).

Beweis: Kriterium 5 und `frames_withAnEmptyEntry_shouldNotShiftTheFilter`.

**Stufe 3 — Messung am echten Browser**

Dateien: `docs/45` (Messwerte), `docs/PROJECT-STATE.md`.

Beweis: Kriterium 6 und die Sichtprüfung in Kriterium 7.

## Bekannte Lücken

- **Nichts ist gemessen.** `extension/page-agent.js` steht im Baum und die 508
  Node-Fälle fahren alle 16 Aufrufer, aber kein Lauf hat die Naht in einem echten
  Firefox gesehen (Stufe 3).
- **Die isolierte Welt ist eine Grenze, kein Fehler.** Seitenvariablen bleiben
  unsichtbar — wie heute.
- **`func` wurde verworfen**, weil die Helfer sonst wieder als Text reisen
  (Entscheidung aus `docs/43`).

## Open questions

**Keine.**

## Review

### Runde 1 — steht aus

## Log

- **2026-11-17, Abspaltung:** war Stufe 2 von `docs/42`; nach dem dritten
  Review-Block geteilt (Betreiberentscheid „B"). Die Naht ist ein eigener
  Umbau: 16 Aufrufstellen, drei Helfer, ein Nachrichtenkanal mit Frist.
- **2026-11-18, Frist und Sammlung entschieden** (aus dem gestoppten
  Bauversuch): eigenes Budget `INJECTION_REPLY_TIMEOUT_MS = 5000` statt des
  Bridge-Timeouts (20 000), weil sonst beide gleichzeitig feuern und der Agent
  `ExtensionTimeout` statt der Werkzeugantwort sieht. Gesammelt wird bis zur
  Frame-Zahl, die `tabs.executeScript({file, allFrames})` liefert — kein
  Auflösen beim ersten Treffer (`frame_ambiguous` braucht alle Antworten),
  späte Antworten werden über `callId` verworfen.
- **2026-11-18, Umbau in zwei Blöcke geteilt:** 1a (Dispatcher, Kanal,
  Sammlung) und 1b (die 16 Aufrufer). `pageSnippetCode` fällt erst mit dem
  letzten Aufrufer; der Zwischenstand ist kein Ziel.
- **2026-11-18, Stufe 1a gebaut:** `extension/page-agent.js` (drei Helfer wörtlich,
  idempotenter Dispatcher), `injectPageCode` mit `{file}` plus Nachricht,
  `callId`-Zähler und Sammlung bis zur Frame-Zahl unter
  `INJECTION_REPLY_TIMEOUT_MS` (5 000), `web_accessible_resources` im Manifest,
  vier `injection_*`-Fälle im Harness. **Offen für Stufe 1b:** die 16 Aufrufer
  senden weiter Quelltext (`pageSnippetCode` steht), und weil damit noch kein
  Produktionsaufrufer den Nachrichtenpfad nutzt, hängt Stufe 1a an einem
  Testhaken (`globalThis.__bcInjectionProbe`); der fällt mit dem letzten
  umgestellten Aufrufer.
- **2026-11-18, Stufe 1b Block 2 gebaut:** `inspect`, `eval`, `frames` und
  `transcript` senden `{op, args}`. Elf Seitenfunktionen sind wörtlich nach
  `extension/page-agent.js` gewandert (`inspectPageSource`,
  `inspectShadowPageSource`, `splitPiercingSelector`, `isSimpleSelector`,
  `selectorForElement`, `shadowSelectorForElement`, `evalPageSource`,
  `transcriptGateSource`, `transcriptModelSource`, `transcriptCaptionSource`,
  `transcriptMenuSource`) und dort als `inspect`, `eval`, `transcriptGate`,
  `transcriptModel`, `transcriptCaption`, `transcriptMenu` registriert. Die
  `>>>`-Verzweigung entscheidet die Seite (`inspectAnswerFor`), nicht mehr die
  Wahl des Payloads. Die Frame-Inventur entsteht aus Selbstmeldungen: ein
  `{op: "inventory"}` an alle Frames, `framesOf` nimmt die Antworten statt eines
  Injection-Arrays; kein Auflösen beim ersten Treffer, späte Antworten fallen
  über `callId` weg. `pageSnippetCode`, `PAGE_HELPERS_CODE`, `describeElement`,
  `isVisible`, `isAddressedFrame` und `globalThis.__bcInjectionProbe` sind
  gelöscht; die vier `injection_*`-Fälle laufen ohne Haken über `inspect`. Neue
  Fälle: `frames_inventory_shouldComeFromSelfReports`,
  `frames_withAnEmptyEntry_shouldNotShiftTheFilter`. Der Harness fährt
  `inspect`/`eval`/`frames`/`transcript` im Seitenrealm der Fixture über den
  Kanal; der Standard-`executeScript` eines Stubs verweigert `{code}` laut,
  damit kein Rest des Quelltext-Pfads grün bleiben kann. **Offen: Stufe 3** (die
  Messung am echten Browser, Kriterien 6 und 7).
- **2026-11-18, Stufe 1b Block 1 gebaut:** `read`, `click`, `type` senden
  `{op, args}`. `readPageSource`, `settlePageSource`, `clickPageSource` und
  `typePageSource` sind wörtlich nach `extension/page-agent.js` gewandert und
  als `read`, `settle`, `click`, `type` registriert; die vier Builder in
  `bridge.js` heißen jetzt `readPageRequest`, `pageStateRequest`,
  `settlePageRequest`, `clickPageRequest`, `typePageRequest` und bauen nur noch
  `{op, args}`. Ein `op`, der wirft, wird wie eine abgelehnte Injection
  behandelt (`not_readable`/`page_busy`/`no_agent_tab`) — der eine Fehlerpfad,
  den die Naht ersetzt. Der Harness fährt die Ops im Seitenrealm der Fixture
  (`pageContextOf`) und sammelt die Antworten über den Kanal; `answer` kann
  eine Antwort pro Op stellen (`{silent: true}` für einen stummen Op), und
  `refuseInjection`/`refuseInjectionTimes`/`refuseInjectionAfter` bilden die
  drei Wege ab, auf denen Firefox die Datei verweigert. **Offen (Block 2):**
  `inspect`, `eval`, `frames` und `transcript` (10 Aufrufe) senden weiter
  Quelltext; `pageSnippetCode`, `PAGE_HELPERS_CODE` und der Testhaken bleiben
  deshalb stehen.
