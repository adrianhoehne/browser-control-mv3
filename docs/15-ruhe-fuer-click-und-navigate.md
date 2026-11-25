---
description: click und navigate warten nach dem Auslösen bis zur DOM-Ruhe statt 300 ms zu raten — mit Rückfall auf die alten 300 ms, falls die Ruhe-Erkennung nichts liefert, und abbrechbarem Warten, damit ein überholter Aufruf nicht zu spät antwortet.
status: active
---

# Ruhe statt 300 ms: `click` und `navigate`

**Zweiter Teil von Spec 14** (geteilt am 2026-10-23). Der erste Teil
(`docs/14-ruhe-statt-300ms.md`) baut die Ruhe-Erkennung und lässt `read` warten.
Dieser hier bringt sie an die Werkzeuge, die etwas **auslösen** — und mit ihnen die
zwei Fragen, an denen die Reviews hingen: was passiert, wenn die Ruhe-Erkennung
nichts liefert, und was passiert, wenn der Aufruf überholt wird.

**Voraussetzung:** Spec 14 ist umgesetzt (`settlePageSource`, `settleAgentTab`,
`QUIET_WINDOW_MS`, `SETTLE_DEADLINE_MS`, `NO_SETTLE`) und der Live-Prüfpunkt aus
deren Kriterium 5 hat bestanden. Besteht er nicht, wird dieses Inkrement nicht
begonnen.

## Ziel

Nach dem Auslösen wartet der Aufruf auf **Ruhe** (250 ms ohne Mutation, höchstens
3 000 ms) und meldet das im Ergebnis:

```json
{"tabId":23,"url":"…","title":"…","clicked":"a#kaufen","scrolled":false,"settled":true,"waitedMs":412, …}
```

- **`click`**: klicken → warten → lesen. Die feste **300-ms-Pause entfällt** —
  **außer** das Warten liefert `NO_SETTLE`, dann werden die alten 300 ms
  nachgeholt. Damit kann dieses Inkrement die Zusage aus Spec 06 nicht
  verschlechtern: entweder es wartet besser, oder es wartet wie bisher.
- **`navigate`**: `complete` abwarten → warten → Ergebnis. Die Ruhe kommt
  **nach** dem Ladeereignis und ersetzt es nicht.
- **Abbrechbar:** ein überholter Aufruf (`superseded`, `supersedeActiveNavigation`)
  löst sein Warten sofort auf und antwortet prompt. Der Seiten-Observer läuft im
  Tab zu Ende, liest aber nichts und antwortet niemandem.

## Non-goals

- **`read` gehört zu Spec 14.** Hier wird an `read` nichts geändert.
- **`type` behält seine 300 ms** (`TYPE_WAIT_MS`) — eigene Spec, wenn es die Ruhe
  auch bekommen soll. `focus` und `inspect` warten weiter nicht.
- **Keine neuen Parameter**; kein neuer Fehlercode.
- Keine neue Berechtigung.

## Wire-Protokoll

- `click`-Ergebnis: `settled` und `waitedMs` zusätzlich, **hinten** angehängt (die
  Feldreihenfolge ist Vertrag).
- `navigate`-Ergebnis: dasselbe, zusätzlich zu `complete`.
- `read` unverändert gegenüber Spec 14.

## MCP-Werkzeug

- `browser_click`: „… wartet, bis sich die Seite beruhigt hat (höchstens 3 s), und
  meldet `settled`/`waitedMs`."
- `browser_navigate`: dasselbe, zusätzlich zum Ladeereignis.
- Schema unverändert, Hub unverändert.

## Hub

Keine Änderung, keine neue Logzeile. Die zwei Felder stehen im Ergebnis und damit im
Debug-Block.

## Extension

- `NO_SETTLE = {settled:false, waitedMs:0}` (aus Spec 14) ist **die** Kennung für
  „nicht gewartet". **`SUPERSEDED_SETTLE`** ist eine eigene Kennung mit denselben
  Werten auf dem Draht: sie entsteht, wenn ein Aufruf überholt wird. Ohne die
  Trennung würde jeder überholte Klick die 300-ms-Rückfall-Zeit verbrennen und
  einen Timer zurücklassen.
- `settleWindow(tabId)`: ein Promise auf `settleAgentTab(tabId)`; `finish()` löst es
  sofort mit `SUPERSEDED_SETTLE` auf.
- `click`: `claimPageSlot(() => settleWindow(tab.id))`; nach
  `requireClickOwnership` wird der **Rückfall scharfgemacht**: `NO_SETTLE` ⇒ 300 ms
  nachholen, `SUPERSEDED_SETTLE` ⇒ nicht.
- **`click` wartet nicht, wenn der Tab `status: "loading"` meldet — und zwar der
  Zustand, der VOR dem Klick gelesen wurde** (`tab` aus der Tab-Auflösung). Der
  Zustand **nach** dem Klick ist die Lade-Auslösung des Klicks selbst und wird nicht
  abgefragt; sonst würde jeder Klick auf einen Link die Ruhe überspringen und
  Kriterium 7 wäre unerreichbar. Die Ausnahme ist ein Wächter ohne eigenen Fall:
  ist der Tab schon vorher am Laden, scheitert die Klick-Injektion und antwortet
  `page_busy` — schneller als jede Wartezeit.
- `navigate`: dasselbe `settleWindow` nach dem Ladeereignis — **zweiphasig**:
  - Überholen **in der Ladephase** (oder Timeout) ⇒ sofort `complete: false`, keine
    Injektion.
  - Überholen **während der Ruhe** ⇒ `complete: true` (die Seite lud wirklich) und
    die Ruhe meldet `NO_SETTLE`. `complete: false` wäre dort gelogen. Der `alreadyThere`-Zweig (Adresse, die der Tab schon zeigt) wartet
  **nicht**: `NO_SETTLE`.
- `TYPE_WAIT_MS` ersetzt `CLICK_WAIT_MS` im Wert 300 (nur noch `type`);
  `startClickWindow` wird `startFixedWaitWindow`, `claimClickSlot` wird
  `claimPageSlot(armWait)`.

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `click_onAVisibleElement_shouldClickOnceSettleAndRead` | drei Injektionen: Klick, Ruhe, Lesen — der mittlere trägt den Marker |
| `click_whenTheSettleSnippetReturnsNothing_shouldFallBackToTheFixedWait` | `NO_SETTLE` ⇒ 300 ms über `clock`, Ergebnis trägt `settled:false, waitedMs:0` |
| `click`, Warten wird überholt | Antwort `superseded`, **kein** Rückfall, `pendingDelays() === []` |
| `navigate_shouldSettleOnlyAfterComplete` | vor dem Ladeereignis keine Injektion, danach genau eine |
| `navigate` bei schon gezeigter Adresse | kein Warten, `NO_SETTLE` |
| `type` (bestehend) | weiter 300 ms über `[TYPE_WAIT_MS]` — **unverändert** |
| `test/mcp.test.js` | die zwei Beschreibungen; `test/hub.test.js` ohne Diff |

## Acceptance criteria

1. `npm test; echo $?` → `0`, `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. Bestehende Fälle ändern sich an genau diesen Sorten:
   - **Injektionszahlen** in vier `click_`-Fällen (`onAVisibleElement`,
     `withASlowFirstInjection`, `withTwoOverlappingRequests`,
     `whenANavigationArrivesDuringTheWait`);
   - **ganze Ergebnisse** in zwei `click_`-Fällen, samt der
     `Object.keys(answer.result)`-Reihenfolge;
   - **Fixture-Zweige, die Injektionen nach Index beantworten** (fünf Stellen, in der
     Umsetzung am 2026-10-23 gezählt): sie müssen umgebaut werden, weil Injektion 2
     jetzt die Ruhe ist;
   - die **Ergebnis-Literale** von `navigate` in Stufe 3.
   Am Diff geprüft und im Bericht namentlich genannt.
2. `click` macht drei Injektionen in der Reihenfolge Klick → Ruhe → Lesen; der
   mittlere trägt den Marker. Fall
   `click_onAVisibleElement_shouldClickOnceSettleAndRead`.
3. Liefert die Ruhe-Erkennung `NO_SETTLE`, wartet `click` die alten 300 ms
   nach — über die Uhr belegt. Fall
   `click_whenTheSettleSnippetReturnsNothing_shouldFallBackToTheFixedWait`.
4. Ein überholter Klick antwortet `superseded` **ohne** Rückfall und lässt keinen
   Timer zurück (`pendingDelays() === []`) — geprüft mit einem **überholenden
   `navigate` auf die schon gezeigte Adresse** als Gegenspieler (der wartet selbst
   nicht und ignoriert den Slot). Ein zweiter `click` als Überholer endet mit
   `[300]`, ein `navigate` mit `[8000]`; beides ist erwartet und steht unter
   `## Risiken`.
5. `navigate` wartet erst nach `complete`; vor dem Ladeereignis gibt es keine
   Injektion. Fall `navigate_shouldSettleOnlyAfterComplete`.
6. `type` ist unverändert (300 ms) — `type_onAVisibleField…` läuft ohne Änderung.
   **Ausnahme, benannt:** `type_whenAClickArrivesDuringTheWait…` ändert seine
   Injektionszahl (2 → 3), weil der **Klick** darin jetzt den Ruhe-Schnipsel
   injiziert — und er braucht dafür einen Tab mit `status: "complete"`, sonst greift
   die Lade-Ausnahme und die Zahl bliebe 2. Das ist die Änderung dieses Inkrements,
   kein Verstoß.
7. **Live-Beleg:** nach Reload und Neustart ein `click` auf einer Seite, die nach
   dem Klick noch nachlädt — `settled: true` und `waitedMs > 0`, und die Antwort
   enthält Text, der vor dem Warten nicht da war.

**Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 7 ist erst
nach den Handgriffen messbar und nach dem `git pull` aus dem Betreiber-Klon.
Kriterien 1–6 laufen vor dem Commit; fällt 7 rot aus, wird vorwärts korrigiert und
die rote Zeile steht unter `## Bekannte Lücken`.

- **Sechster Live-Versuch, 2026-11-23: die Ruhe wird auf einer Seite mit Timern nie
  erreicht.** `browser_click` auf `a.mw-jump-link` (ein `#`-Anker, also ohne
  Navigation) im Artikel `https://en.wikipedia.org/wiki/Example` antwortet
  `settled: false, waitedMs: 3937`. Der Wert ist der Guard
  (`SETTLE_GUARD_MS = 4000`), nicht die Ruhe: Wikipedia betreibt dauerhaft Timer, die
  250-ms-Stille tritt nie ein. Der Rückfall greift wie vorgesehen, aber ein Klick auf
  einer solchen Seite kostet **etwa vier Sekunden**, und die Antwort sagt das nicht.
  Zum Vergleich: `navigate` auf dieselbe Seite meldet `settled: true, waitedMs: 1763`
  — der Lade-Pfad erreicht die Ruhe, der Klick-Pfad nicht.
  **Folge für den Agenten:** `settled: false` heißt hier „die Seite war nicht still",
  nicht „die Seite hat nicht reagiert"; wer daraus ein Wiederholen ableitet, klickt
  doppelt. `docs/56` hat dieselbe Zahl (`waitedMs: 0` bei den Suchseiten) gemessen.

## Bekannte Lücken

- **Kriterium 7 ist live nur halb belegt** (2026-10-23): `navigate` auf einen
  Wikipedia-Artikel liefert `complete: true` **`settled: true, waitedMs: 1938`** —
  die Mechanik trägt. Für **`click`** ließ sich `settled: true` **nicht** erzeugen:
  In fünf Versuchen (Wikipedia-Links, clever-fit-Akkordeon) löste jeder Klick
  entweder eine Navigation aus — dann wird die Ruhe-Injektion beim Dokumentwechsel
  abgelehnt (`NO_SETTLE`) — oder er lief auf einem Tab, der noch lud, wo die Ruhe
  übersprungen wird. In beiden Fällen greift der **Rückfall auf 300 ms**, das
  Verhalten ist also unverändert zu Spec 06, nur nicht besser. Offen bleibt der
  Nachweis auf einer Seite, die **in der Seite** nachlädt, ohne zu navigieren.
- **Auf `clever-fit.com` liefert die Ruhe reproduzierbar `NO_SETTLE`**, obwohl
  `read` dort funktioniert und `navigate` `complete: true` meldet. Ursache nicht
  bestimmt (Verdacht: der Tab meldet weiter `status: "loading"`, oder die Injektion
  wird abgelehnt). Steht hier, damit es nicht als Messfehler verschwindet.
- **`{settled:false, waitedMs:0}`** heißt hier dreierlei, auf dem Draht
  ununterscheidbar: „nicht gewartet" (`alreadyThere`, ladender Tab), „lief nicht"
  (Injektion abgelehnt) und — bei `click` — „der Rückfall hat gegriffen".
- **Der Wächter aus Spec 14 gilt auch hier:** ein Ruhe-Schnipsel, der nie auflöst
  (gedrosselte Timer im Hintergrund-Fenster), kostet `SETTLE_GUARD_MS`; beim Klick
  kommen die 300 ms des Rückfalls dazu — Worst Case 4,3 s vor dem Lesen.
- Kriterium 7 steht aus.

## Risiken

- **Der Rückfall des *Nachfolgers* bleibt stehen.** Wird ein Klick von einem
  zweiten `click` überholt, endet der Nachfolger mit `pendingDelays() === [300]`
  (seine eigene Ruhe liefert `NO_SETTLE`, also greift sein Rückfall); bei einem
  überholenden `navigate` ist es `[8000]` (dessen Lade-Frist). Nur ein `navigate`
  auf die schon gezeigte Adresse kommt auf `[]` — deshalb ist er der Gegenspieler
  in Kriterium 4.
- **Der Rückfall ist absichtlich grob.** Jedes `NO_SETTLE` fällt hinein — auch eine
  **abgelehnte** Ruhe-Injektion (PDF, `about:`). Ein Klick auf eine Seite, die sich
  nicht injizieren lässt, wartet also 300 ms, bevor er `not_readable` sagt. Der
  feinere Schnitt bräuchte einen vierten Zustand, den diese Spec nicht einführt.
  `read` bekommt den Rückfall nicht.

- **Ein überholter Klick lässt seinen Observer bis zu 3 s weiterlaufen.** Abbrechbar
  ist nur unser Warten; der Schnipsel im Tab liest nichts und antwortet niemandem.
- **Der Rückfall ist eine Brücke, kein Ziel.** Er existiert, damit dieses Inkrement
  nicht schlechter sein kann als Spec 06 — nicht, weil 300 ms gut wären.
- **`navigate` wird um bis zu 3 s langsamer**, wenn die Seite unruhig ist. Das ist
  der Preis; `complete:false` bleibt davon unberührt.
- **`MutationObserver` sieht nur den Hauptrahmen** (iframes: Roadmap 15).

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine neue Berechtigung.
- `extension/manifest.json`, `extension/options.*`, `bridge/hub.mjs` bleiben
  unverändert; `bridge/mcp.mjs` nur die zwei Beschreibungen.
- `docs/*` und `INSTALL.md` pflegt der Orchestrator.

## Dev plan

1. **Wartemechanik umbauen (kein Verhalten).** `extension/background.js`:
   `CLICK_WAIT_MS` → `CLICK_FALLBACK_MS = 300` (ab jetzt **nur** der Rückfall) und
   `TYPE_WAIT_MS = 300`; `startClickWindow()` → `startFixedWaitWindow(delayMs)`;
   `claimClickSlot()` → `claimPageSlot(armWait)`, dessen `arm(wait = armWait)` bei
   jedem Aufruf `finishWindow` neu setzt, sodass das bestehende `finally` den
   zuletzt scharfen Timer räumt. `arm` liefert je Werkzeug anderes (`type`:
   `true`/`false`; `click`: das Ruhe-Ergebnis) — nicht vereinheitlichen.
   Neu: `SUPERSEDED_SETTLE = Object.freeze({settled:false, waitedMs:0})` (gleiche
   Werte wie `NO_SETTLE`, andere Identität); `haltSignal()` als Paar wie
   `guardAfter`, dessen Promise erst auf `halt()` aufgeht; `settleWindow(tabId)` =
   `{finish: halt.halt, answer: settleAgentTab(tabId, halt)}`.
   `settleAgentTab(tabId, halt = null)` bekommt den Halt als dritten Teilnehmer im
   `Promise.race`, gibt bei `winner === SUPERSEDED_SETTLE` **den Sentinel selbst**
   zurück (nicht durch `settleOutcomeOf`, das ihn zur Kopie machen würde) und ruft
   im `finally` `guard.cancel()` **und** `halt.cancel()`.
   Proof: `--test-name-pattern="type_"` und `--test-name-pattern="read_"` — beide
   `# fail 0`, `# cancelled 0`, **ohne eine Teständerung**.
   **Completed 2026-10-23** (zusammen mit Stufe 2) — 76 Fälle, 328 Tests grün.
2. **`click` = klicken → Ruhe → lesen.** `clickAgentTab`: nach `clickOutcomeOf` und
   dem ersten `requireClickOwnership` `const settle = await click.arm();`
   (Slot-Fabrik `() => settleWindow(tab.id)`). Rückfall **nur** bei
   `settle !== SUPERSEDED_SETTLE && settle.settled === false && settle.waitedMs === 0`:
   `await click.arm(() => startFixedWaitWindow(CLICK_FALLBACK_MS))` — über den Slot,
   damit `finish()`/`finally` ihn abbrechen und nie ein Timer zurückbleibt.
   Der zweite `arm`-Aufruf (Rückfall) liefert einen Boolean, der **verworfen** wird
   — `arm` liefert je Werkzeug anderes, und das bleibt so.
   Danach der zweite `requireClickOwnership`, dann
   `clickResult(tabId, reported, before, settle, want)`; `scrolled` steht seit
   `docs/56` direkt hinter `clicked`, die zwei Felder `settled`/`waitedMs` bleiben
   **hinten**
   hinter `via`. Ein überholter Klick armed keinen Rückfall; der Sentinel reist nie
   in ein Ergebnis.
   Testseite: `createClickTabs({settle = NO_SETTLE_RESULT})` beantwortet den Marker
   wie `createReadTabs`; Standard `NO_SETTLE`, damit die bestehenden Fälle ihre
   300 ms behalten und nur Zählungen/Ergebnisse wandern.
   **Completed 2026-10-23** — 28 `click_`-Fälle grün, Gesamt 328.
   Proof: `--test-name-pattern="click_"` grün, darunter
   `click_onAVisibleElement_shouldClickOnceSettleAndRead` (drei Injektionen,
   mittlere mit `/*bc:settle*/`, `pendingDelays() === []`),
   `click_whenTheSettleSnippetReturnsNothing_shouldFallBackToTheFixedWait` (Uhr
   zeigt 300 ms, Ergebnis `settled:false, waitedMs:0`) und der Überhol-Fall
   (Ruhe-Injektion hängt, Antwort `superseded`, kein Rückfall,
   `pendingDelays() === []`).
3. **`navigate` wartet nach `complete`.** `startNavigation`: `alreadyThere` →
   `finishedNavigation` mit angehängtem `NO_SETTLE` (kein Warten, kein Rückfall —
   der ist `click`-eigen); sonst `wait.settled.then(...)`: `loadedTab === null`
   (Timeout **oder** Supersede in der Ladephase) ⇒ `navigationResult(known, null,
   NO_SETTLE)` ohne Injektion; sonst `settleWindow(known.tabId)` öffnen,
   `finishSettle` merken und `navigationResult(known, loadedTab, outcome)`.
   Das `finish` des Navigations-Objekts ruft `wait.finish()` **und**
   `finishSettle()` — ein Überhol-Mechanismus, kein zweiter.
   `navigationResult(known, loadedTab, settle)` hängt die zwei Felder hinten an.
   Wird **während** der Ruhe überholt, bleibt `complete: true` (die Seite lud
   wirklich) und die Ruhe meldet `NO_SETTLE`.
   Proof: `--test-name-pattern="navigate_"` und `--test-name-pattern="focus_"` grün,
   inklusive `navigate_shouldSettleOnlyAfterComplete`, `listenerCount() === 0`,
   `pendingDelays() === []`.
4. **MCP-Beschreibungen.** `bridge/mcp.mjs`: die zwei `description` von
   `BROWSER_CLICK` und `BROWSER_NAVIGATE`; die gepinnten Kopien
   `CLICK_TOOL_DESCRIPTION`/`NAVIGATE_TOOL_DESCRIPTION` in `test/mcp.test.js` ziehen
   mit. Dazu `CLICK_RESULT`/`NAVIGATE_RESULT` in `test/fixtures/fake-extension.mjs`
   um das Paar ergänzt, damit sichtbar ist, dass die Bridge beide Felder unverändert
   durchreicht.
   Proof: `node --test --test-reporter=tap test/mcp.test.js test/hub.test.js` →
   `# fail 0`, `# cancelled 0`; `git diff --stat test/hub.test.js` leer.

### What could go wrong

- **Das Rückfall-Prädikat ist absichtlich grob.** Jedes `NO_SETTLE` fällt zurück —
  auch eine **abgelehnte** Ruhe-Injektion (PDF, `about:`), also antwortet ein Klick
  auf eine danach unlesbare Seite 300 ms später als nötig, mit demselben
  `not_readable`. Der feinere Schnitt bräuchte einen vierten Zustand, den die Spec
  verbietet. `read` bekommt den Rückfall nicht.
- **Der Wächter kostet im Klick-Pfad nichts Neues** außer im Hängefall: eine
  Ablehnung läuft sofort auf `NO_SETTLE`. Nur ein Schnipsel, der nie auflöst,
  kostet `SETTLE_GUARD_MS`; der Klick addiert dann seine 300 ms ⇒ Worst Case 4,3 s.
- **Kriterium 4 ist nur mit dem Halt prüfbar.** Ein bloßes `Promise.race` um ein
  inneres `settleAgentTab` ließe dessen Wächter-Timer nach dem Überholen stehen und
  `pendingDelays()` wäre `[SETTLE_GUARD_MS]`.
- **Der Sentinel darf nie gespreadet werden** — `{...SUPERSEDED_SETTLE}` ist auf dem
  Draht `NO_SETTLE`; die Unterscheidung existiert nur als Identität im Steuerfluss.
- **`type_whenAClickArrivesDuringTheWait…` ändert sich** (2 → 3 Injektionen), weil
  der **Klick** darin jetzt den Ruhe-Schnipsel injiziert. Das gehört in den Bericht,
  sonst liest es sich wie ein Verstoß gegen Kriterium 6.

### Ordering and dependencies

1 → 2, 1 → 3, (2 | 3) → 4; nach jeder Stufe `npm test` grün. Stufe 2 erweitert das
Navigations-Ergebnis noch **nicht** um das Paar — das kommt mit Stufe 3 (zusammen mit
den Ergebnis-Literalen in `test/extension.test.js`). Mit Stufe 2 wandern vier
`click_`-Fälle in ihren Injektionszahlen und zwei ganze Ergebnisse; alle
Verweigerungsfälle enden vor jedem Warten und bleiben unberührt. Kriterium 7 nach dem
Commit, Betreiber.

### What the next increment inherits

- `type` behält seine 300 ms über `TYPE_WAIT_MS`; `focus` und `inspect` warten nicht.
- Der Rückfall bleibt die **einzige** Stelle, an der eine alte Zahl weiterlebt.
- Abbrechbar ist nur unser Warten: der Schnipsel im Tab läuft nach einem Überholen
  bis zu 3 s weiter und antwortet niemandem.
- `SUPERSEDED_SETTLE` ist auf dem Draht unsichtbar.
- `navigate` mit `complete:false` injiziert nichts; `alreadyThere` wartet nie.

## Review

**Runde 1 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Sieben Befunde, alle
übernommen:

1. **Zwei `## Dev plan`-Abschnitte** (Rest aus dem Teilen) — der ältere, der dem
   neuen widersprach, ist gelöscht.
2. **`## Extension` sagte das Gegenteil von Stufe 3** — beim Überholen *während der
   Ruhe* bleibt `complete: true`; `complete: false` wäre dort gelogen. Zweiphasig
   formuliert.
3. **Die PDF-Zusage stand am falschen Ort** und `## Log` behauptete sie in den
   Risiken — jetzt in `## Risiken` und in `## Bekannte Lücken`.
4. **`click` auf einem ladenden Tab hätte vor `page_busy` gewartet** — dieselbe
   Ausnahme wie bei `read` ist jetzt Pflicht.
5. **Der Test-Diff war nicht gebunden** — Kriterium 1 nennt jetzt auch die
   Fixture-Zweige, die Injektionen nach Index beantworten, und die
   `Object.keys`-Liste; Kriterium 6 ist auf `type_onAVisibleField…` eingeschränkt und
   benennt die eine `type_`-Ausnahme.
6. **Kriterium 4 war nicht mit jedem Überholer prüfbar** — der Gegenspieler ist
   jetzt benannt, samt der erwarteten `[300]`/`[8000]`-Fälle.
7. **`arm` liefert je Werkzeug anderes** — der verworfene Boolean im Rückfall steht
   jetzt im Plan.

**Die Runden 1–3 des Vorläufers stehen im `## Log` von Spec 14**, die letzte dort als
„Runde 3 (geteilter Zuschnitt)". Geerbt hat dieses Inkrement: Rückfall-Predikat,
`SUPERSEDED_SETTLE`, abbrechbares `navigate`, Kriterien mit Fall und Kommando. Die
Teilung selbst war die Antwort auf den zweiten Block.

## Log

- **Aus Spec 14 übernommen:** Rückfall auf 300 ms bei `NO_SETTLE`,
  `SUPERSEDED_SETTLE` als eigene Kennung, abbrechbares `navigate` über dasselbe
  `settleWindow`, `alreadyThere` ohne Warten.
- **Neu hier:** die Trennung ist erst durch die Teilung möglich geworden; die
  Regeln stehen jetzt in einem Dokument, das nur diese zwei Werkzeuge betrifft.

Befunde beim Schreiben des Dev-Plans (2026-10-23), vom Architekten:

- **Der Rückfall ist absichtlich grob:** jede `NO_SETTLE` fällt hinein, auch eine
  abgelehnte Ruhe-Injektion (PDF). Ein feinerer Schnitt bräuchte einen vierten
  Zustand. **Übernommen**, in den Risiken benannt.
- **Der Sentinel reist nur im Steuerfluss**, nie im Ergebnis — `{...SUPERSEDED_SETTLE}`
  wäre auf dem Draht `NO_SETTLE`. **Übernommen.**
- **`type_whenAClickArrivesDuringTheWait…` ändert sich** (2 → 3 Injektionen), weil
  der Klick darin jetzt den Ruhe-Schnipsel injiziert. **Benannt**, damit es nicht
  wie ein Verstoß gegen Kriterium 6 aussieht.

**Runde 2 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Vier Einzeiler, alle
übernommen:

1. **Die Lade-Ausnahme nannte den Zeitpunkt ihres `status`-Lesens nicht** — gelesen
   wird der Zustand **vor** dem Klick; der Zustand danach ist die Lade-Auslösung des
   Klicks selbst. Sonst wäre Kriterium 7 unerreichbar, weil jeder Link-Klick kurz
   danach `loading` meldet. Dazu: die Ausnahme ist ein Wächter ohne eigenen Fall.
2. **Kriterium 4 verwies auf Risiken, die es nicht gab** — der Rückfall des
   *Nachfolgers* steht jetzt dort (`[300]`, `[8000]`, `[]` nur bei `alreadyThere`).
3. **Zwei Zahlen für dieselbe Menge** — vier, namentlich genannt.
4. **Rundennummern waren doppelt vergeben** — die früheren Runden stehen jetzt
   ausdrücklich im `## Log` von Spec 14.

## Messlauf (2026-10-23, live)

Nach Reload der Extension und Neustart von pi:

- **`navigate` → `de.wikipedia.org/wiki/Fahrrad`:** `complete: true`,
  **`settled: true`, `waitedMs: 1938`** — die Ruhe-Erkennung läuft im echten Browser
  und misst echte Zeit.
- **`navigate` → clever-fit-Studio:** `complete: true`, `settled: false`,
  `waitedMs: 0` — dort liefert die Ruhe nichts (siehe `## Bekannte Lücken`).
- **`click`:** fünf Versuche, jeder `settled: false, waitedMs: 0`. Jeder Klick löste
  eine Navigation aus (Ruhe-Injektion abgelehnt) oder lief auf einem ladenden Tab
  (Ruhe übersprungen). Der Rückfall auf 300 ms hat in allen Fällen gegriffen — das
  Verhalten entspricht Spec 06, es ist nicht schlechter geworden.
- **Was fehlt:** ein Klick auf einer Seite, die **in der Seite** nachlädt, ohne zu
  navigieren. Dieses Kriterium bleibt damit **rot** und ist oben unter
  `## Bekannte Lücken` festgehalten — nach der datierten Ausnahme zulässig, aber
  benannt.

**Nachtrag 2026-10-23 (Spec 16):** Der Warte-Slot für `click`/`type` bleibt **global**
— zwei Klicks in zwei Tabs lösen einander weiterhin ab. Ein Slot je Tab ist als
`docs/17-slot-je-tab.md` abgetrennt, weil sich Nebenläufigkeit im Sandkasten nicht
widerlegen lässt.

**Nachtrag 2026-10-23 (Spec 17):** `claimPageSlot` hat jetzt die Signatur
`claimPageSlot(tabId, armWait)` — der Slot gilt je Tab, nicht global.
