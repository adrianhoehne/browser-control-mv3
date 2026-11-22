---
description: Der Warte-Slot für click und type gilt je Tab statt global — zwei Klicks in zwei Tabs laufen nebeneinander, statt sich gegenseitig abzulösen; mit einem Live-Kriterium, weil ein Sandkasten Nebenläufigkeit nicht widerlegen kann.
status: active
---

# Der Warte-Slot gilt je Tab

**Abgetrennt von Spec 16** (Roadmap 08a, 2026-10-23), weil die Review den Punkt
traf: „Zwei Klicks in zwei Tabs laufen gleichzeitig, Firefox trägt das" lässt sich
im Sandkasten **nicht widerlegen** — ein Fake kann die Zusage nicht falsifizieren.
Also bekommt die Nebenläufigkeit ein eigenes Inkrement mit einem **Live**-Kriterium,
statt sie einem ohnehin großen Umbau anzuhängen.

**Voraussetzung:** Spec 16 ist umgesetzt (Liste `agentTabIds`, `tab`-Parameter,
`open_tab`/`close_tab`).

## Ziel

Heute ist der Slot für `click`/`type` **global**: ein zweiter Klick löst den ersten
ab, egal in welchem Tab. Mit mehreren Agenten-Tabs ist das falsch — zwei Suchen in
zwei Tabs sind unabhängige Arbeit.

- `claimPageSlot(tabId, armWait)` trägt sich unter der Tab-Id ein; `pageSlots` ist
  eine `Map`.
- `supersedePageSlot(tabId)` löst nur den Slot **dieses** Tabs auf.
- `requirePageSlotOwnership(tabId, slot)` vergleicht gegen den Eintrag dieses Tabs.
- Jedes `finally` löscht nur bei **Identität** (`pageSlots.get(tabId) === slot`),
  sonst räumt ein alter Aufruf den Slot seines Nachfolgers weg.
- `close_tab` ruft `supersedePageSlot(tabId)`, damit ein wartender Klick sofort
  `superseded` antwortet, statt in eine tote Injektion zu laufen — auch auf dem Pfad
  ohne `tab`, der den zuletzt benutzten schließt (`answerCloseTab`).
- **`navigate` löst nur den Slot seines Ziels ab.** Zwei `navigate` auf zwei Tabs laufen ab jetzt
  nebeneinander, und ein Klick in Tab B löst kein `navigate` in Tab A mehr ab — Folge der
  Schlüsselung, hier genannt, damit sie nicht als Nebenwirkung durchgeht.

Alles andere bleibt: `navigate` benutzt denselben Slot je Tab, `type` behält seine
300 ms, `click` seinen Ruhe-Warten-mit-Rückfall.

## Non-goals

- **Keine Parallelität über Tabs hinaus** (kein Worker, keine Promise-Pools).
- **Kein Fenster-Parameter.**
- **Keine Änderung an der Obergrenze** (5) oder an `too_many_tabs`.
- Keine neue Berechtigung, keine neuen Felder in Ergebnissen.

## Wire-Protokoll

Keine Änderung. `superseded` bedeutet weiter dasselbe, nur seltener.

## MCP-Werkzeug

Keine Änderung.

## Hub

Keine Änderung.

## Extension

- `activeNavigation` (eine Variable) → `pageSlots = new Map()`.
- `claimPageSlot(tabId, armWait)`, `supersedePageSlot(tabId)`,
  `requirePageSlotOwnership(tabId, slot)`.
- Aufrufer: `navigate`/`startNavigation`, `clickAgentTab`, `typeAgentTab`.

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `click_inTwoDifferentTabs_shouldBothAnswerAndNeitherBeSuperseded` | zwei Tabs, zwei Slots, beide `ok` |
| `click_twiceInTheSameTab_shouldSupersedeTheFirst` | innerhalb eines Tabs gilt die alte Regel |
| `navigate_withTwoOverlappingRequests…` (bestehend) | derselbe Tab löst weiterhin ab |
| `navigate_inTwoDifferentTabs_shouldBothAnswerAndNeitherBeSuperseded` | zwei Tabs, zwei Slots — die neue Zusage |
| `type_inTwoDifferentTabs_shouldBothAnswerAndNeitherBeSuperseded` | dasselbe für `type` |
| `click_`- und `type_`-Überholfälle (bestehend) | unverändert, `pendingDelays() === []` |
| Tab wird während des Wartens geschlossen | der wartende Klick antwortet `superseded`, kein Timer bleibt |
| `click_inTwoDifferentTabs…`, `type_inTwoDifferentTabs…`, `click_whenItsTabIsClosedDuringTheWait…` | am Ende dieser drei Fälle liefert `slotMapKeys` genau eine Map, und die ist leer (`[[]]`); andere Fälle werden nicht mitgezählt |

## Acceptance criteria

1. `npm test; echo $?` → `0`, `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. Die bestehenden Fälle laufen bis auf die im Diff
   benannten unverändert.
2. Zwei `click` in **zwei verschiedenen** Tabs antworten beide `ok`; keiner trägt `superseded`.
   Fall `click_inTwoDifferentTabs_shouldBothAnswerAndNeitherBeSuperseded`. Dasselbe für `type`
   (`type_inTwoDifferentTabs…`) und `navigate` (`navigate_inTwoDifferentTabs…`).
3. Zwei `click` im **selben** Tab: der erste `superseded`, der zweite `ok`.
4. Ein geschlossener Tab hinterlässt keinen Slot. **Beleg ist die Sonde**: `slotMapKeys(started)
   === [[]]` (genau eine Map, danach leer) in `click_inTwoDifferentTabs…`,
   `click_whenItsTabIsClosedDuringTheWait…` und `type_inTwoDifferentTabs…`.
   **Gegenprobe, die wirklich leckt:** den Identitäts-Wächter zu entfernen genügt **nicht** — der
   veraltete Aufruf löscht dann den Eintrag des Nachfolgers, die Map endet weiter leer und der Fall
   bleibt grün. Es braucht eine Mutation, die einen Eintrag **hinterlässt**:
   `supersedePageSlot(tab.id)` aus `closeAgentTab` entfernen, oder das `releasePageSlot` in einem
   `finally` weglassen. Beide machen den Fall rot.
5. **Live-Beleg:** im echten Profil zwei Tabs öffnen (`complete` abwarten) und in
   beiden **im selben Tick** je einen Klick auslösen — beide antworten `ok:true`, keiner
   `superseded`, jede Antwort trägt ihre eigene `tabId`, und im Messbericht stehen die
   Zeiten (`settled`/`waitedMs`) beider Antworten.
   **Was das nicht zeigt:** ob Firefox die zwei Injektionen wirklich nebeneinander
   ausführt. Beide Antworten entstehen in der Extension; ein serialisierender Browser
   zeigte sich als **Zeit**, nicht als `superseded`.

**Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 5 ist erst
nach Reload und Neustart messbar. Kriterien 1–4 laufen vor dem Commit. Ist die
**Kernannahme** widerlegt (Firefox serialisiert die Injektionen so, dass ein Tab den
anderen blockiert), geht das Inkrement zurück in diese Spec — der Slot bleibt dann
global, und das ist eine Entscheidung, kein Rückbau.

## Messlauf (Kriterium 5, 2026-10-23, live)

Nach Reload der Erweiterung, über den laufenden Dienst (MCP über HTTP):

- **Zwei Tabs, zwei Klicks im selben Tick:** beide Aufrufe wurden abgeschickt, bevor einer
  antwortete. Ergebnis: **beide beantwortet, keiner `superseded`**, jeder mit seiner eigenen
  `tabId` (10 und 11). Vor diesem Inkrement hätte der erste `superseded` bekommen.
- **Ein Tab, zwei Klicks im selben Tick (Gegenprobe):** der erste antwortet `superseded`
  („Die Extension konnte die Anfrage nicht ausführen (code=superseded)" — so die Antwort damals; englisch seit `docs/54`), der zweite liefert sein
  Ergebnis. Die alte Regel gilt innerhalb eines Tabs unverändert.
- **Zeiten, wie Kriterium 5 sie verlangt:** beide Klicks meldeten `settled: false, waitedMs: 0` —
  sie lösten eine Navigation aus, die Ruhe-Injektion wurde beim Dokumentwechsel abgelehnt, der
  Rückfall auf 300 ms hat gegriffen. Der Beleg zeigt also **unsere Schlüsselung**, nicht FireFox'
  Nebenläufigkeit; das war vorher so festgehalten und bleibt so stehen.

## Bekannte Lücken

- **Der Beleg misst unsere Map, nicht Firefox:** beide Antworten entstehen in der Extension. Ob
  Firefox zwei Injektionen wirklich parallel ausführt, zeigt sich höchstens als Zeit — hier waren
  beide `waitedMs: 0`, weil der Rückfall griff. Bleibt offen.

## Dev plan

1. **Ein Slot je Tab statt einer Variablen — Mechanik und alle Aufrufer.**
   `let activeNavigation = null` wird `const pageSlots = new Map()`.
   - `claimPageSlot(tabId, armWait)` baut das Slot-Objekt unverändert und **trägt es selbst
     ein** — `pageSlots.set(tabId, slot)`, Schlüssel ist die **Tab-Id, ausgeschrieben** (in genau
     dieser Stufe bliebe ein falscher Schlüssel ewig grün). Zwischen dem Aufruf und dem `try` liegt **kein
     `await`**, deshalb kann ein Aufruf, der vorher wirft (`addressedAgentTab`:
     `invalid_params`, `no_agent_tab`), keinen Eintrag hinterlassen.
   - `supersedePageSlot(tabId)` = `get` → `delete` → `finish()`: löschen **vor** `finish`. Das ist
     **Defence-in-Depth**, nicht tragend: das `finally` des Vorgängers läuft als Mikrotask, und der
     Identitäts-Wächter fängt es ohnehin ab — der Code-Review hat die Reihenfolge vertauscht und
     alle Fälle blieben grün. Die Reihenfolge bleibt trotzdem so, weil sie die Absicht ausdrückt.
   - `requirePageSlotOwnership(tabId, slot)` ersetzt `requireClickOwnership` und wirft weiter
     `ClickError(SUPERSEDED_CODE, …)`.
   - `releasePageSlot(tabId, slot)` = `if (pageSlots.get(tabId) === slot) pageSlots.delete(tabId)`
     — die Identitätsprüfung steht damit an **einer** Stelle für drei `finally`.
   Aufrufer, alle **nach** der Tab-Auflösung: `clickAgentTab` und `typeAgentTab`
   (`supersedePageSlot` → `claimPageSlot` → `try`); `navigate`
   (`supersedePageSlot(target.tab.id)` → `startNavigation` → `pageSlots.set(…)`, `finally`
   `releasePageSlot`). **`navigate` löst nur den Slot seines Ziels ab**, auch ohne `tab` — die
   Auflösung hat vorher den zuletzt benutzten Tab geliefert, ein dabei neu angelegter Tab trägt
   eine frische Id, unter der nichts liegt. Zwei `navigate` auf zwei Tabs laufen ab jetzt
   nebeneinander. Die Werte in `pageSlots` sind `{finish}`-förmig, nicht zwingend Claim-Slots.
   Mitziehen: der Doc-Kommentar von `closeAgentTab` („nimmt keinen Slot") und die Stellen, die
   `supersedeActiveNavigation` nennen.
   Proof: `npm test` grün **ohne eine geänderte Zusicherung** — die Überholfälle
   (`navigate_withTwoOverlappingRequests…`, `click_withTwoOverlappingRequests…`,
   `click_whenANavigationArrivesDuringTheWait…`, `type_withTwoOverlappingRequests…`,
   `type_whenAClickArrivesDuringTheWait…`, `click_whenTheSettleWaitIsOvertaken…`) arbeiten alle in
   **einem** Tab und bleiben wörtlich, was sie sind.
2. **Harness-Sonde und der Zwei-Tab-Fall.** `background.js` ist eine IIFE, `pageSlots` ist
   Closure-Zustand — von außen unsichtbar. Deshalb patcht `createSandbox` im Sandbox-Realm
   `Map.prototype.set`/`delete` und schreibt `{map, op, key}` nach `globalThis.__bcMapOps`; ein
   Node-seitiger Helfer `slotMapKeys(started)` rechnet die Ops nach und prüft mit, dass es **genau
   einen** Empfänger gibt (heute entsteht in `background.js` keine `Map`) — eine spätere zweite Map
   scheitert damit **laut**, mit der Zahl der Empfänger in der Meldung. Drei Fallstricke,
   ausdrücklich: der Patch muss **vor** dem Laden von `background.js` im **Sandbox**-Realm stehen
   (nicht nur im Host-Kontext), er muss `return this` liefern, und die Ops müssen als **einfache
   Objekte** in den Host-Realm zurück (sonst scheitert `deepStrictEqual` an den Prototypen —
   dieselbe Falle wie `inThisRealm` weiter oben — die Ops werden deshalb mit `inThisRealm`
   kopiert, nicht als Literal zurückgereicht). Geprüft wird **je Fall** (`slotMapKeys(started)`),
   sonst kippen Fälle ohne Slot-Arbeit die Zählung.
   **Drei** neue Fälle, alle in Stufe 2: `click_inTwoDifferentTabs_shouldBothAnswerAndNeitherBeSuperseded`
   (Klick in 500, dann in 501; beide `ok:true`, keine `superseded`, je eigene `tabId`, sechs
   Injektionen, `pendingDelays()` erst `[300,300]`, am Ende `[]`),
   `type_inTwoDifferentTabs_shouldBothAnswerAndNeitherBeSuperseded` (dasselbe Muster mit
   `TYPE_WAIT_MS`) und `navigate_inTwoDifferentTabs_shouldBothAnswerAndNeitherBeSuperseded`
   (zwei `navigate` auf zwei Tabs, beide `complete`, keine `superseded`). Jeder der drei endet mit
   `slotMapKeys(...) === [[]]`.
   `started` ist der **beim Start erzeugte Sandbox-Zustand** (das, was `startBackground` liefert);
   `slotMapKeys(started)` liest daraus die Ops-Spur, nicht aus einem globalen Sammler.
   Proof: die drei Fälle sind grün — und **rot mit Stufe 1 und konstantem Schlüssel**
   (`pageSlots.set(0, …)`): dann findet **der erste** Aufruf seinen Eintrag nicht mehr, der
   Ownership-Check wirft, und **der erste** antwortet `superseded`. Ohne Stufe 1 (also auf
   dem heutigen globalen Slot) sind sie **schon heute rot** — das ist ihre Daseinsberechtigung.
   Gegenprobe von Hand für Kriterium 4: **nicht** den Identitäts-Wächter entfernen (der veraltete
   Aufruf löscht dann den Eintrag des Nachfolgers, die Map bleibt leer, der Fall grün), sondern
   `supersedePageSlot(tab.id)` aus `closeAgentTab` entfernen oder ein `releasePageSlot` im
   `finally` weglassen — dann bleibt ein Eintrag stehen und `slotMapKeys` zeigt ihn.
3. **`close_tab` löst den Slot seines Tabs ab.** In `closeAgentTab` nach `addressedAgentTab` und
   **vor** `removeAgentTab`: `supersedePageSlot(tab.id)`; der Pfad ohne `tab` ist derselbe, weil
   die Auflösung vorher läuft. Neuer Fall
   `click_whenItsTabIsClosedDuringTheWait_shouldAnswerSupersededAndLeaveNoSlot`: der Klick wartet,
   `close_tab` kommt ⇒ Antwort `superseded`, `tabs.scriptCalls` bleibt bei 2 (kein Lesen in den
   toten Tab), `pendingDelays() === []`, `slotMapKeys` = `[[]]`.
   **Grenze, die der Fall einhalten muss:** hängt der Klick noch in seiner *Klick*-Injektion,
   antwortet er mit dem Fehler der Injektion (`no_agent_tab`), nicht `superseded` — eine laufende
   Injektion kann der Slot nicht abbrechen. Der Fall schließt deshalb während des **Wartens**.
   `pendingDelays() === []` und `slotMapKeys(started) === [[]]` stehen am Ende **dieses** Falls,
   nicht in jedem der 400 anderen.
   Proof: `--test-name-pattern="closeTab_|click_whenItsTabIsClosed"` — der neue Fall heißt
   `click_whenItsTabIsClosedDuringTheWait…` und wird von `closeTab_` **nicht** erfasst.
4. **Messlauf (Betreiber, nach Commit und Reload — Kriterium 5).** Zwei `browser_open_tab`, `complete`
   abwarten, dann **zwei `browser_click` mit je eigener `tab` in einer Antwort**. Die Bridge
   serialisiert nicht; gemessen wird die Antwort: beide `ok:true`, keine `superseded`, jede mit
   ihrer `tabId`. Eine weiter mutierende Seite ist **nicht** nötig — der Auslöser ist die
   *Ankunft* des zweiten Aufrufs, und der erste ist ab seiner Injektion mindestens 250 ms
   unbeantwortet.
   Proof: zwei Tool-Antworten im Log, beide `ok:true`, keine `superseded`, je eigene `tabId`, und
   die Zeiten beider Antworten im Messbericht. **Der Aufbau muss die Gleichzeitigkeit erzwingen** —
   zwei pi-Sitzungen oder ein Skript, das beide `click`s im selben Tick auf den Bridge-Socket
   schreibt. Werden sie nacheinander geschickt, ist das ein **Aufbaufehler** und die Messung wird
   wiederholt; sie wird nicht als „nicht entscheidbar" verbucht und wandert **nicht** unter
   `## Bekannte Lücken`.

### What could go wrong

- **Kriterium 5 misst unsere Map, nicht Firefox.** Beide Antworten entstehen in der Extension;
  blockiert Firefox zwei Injektionen, zeigt sich das als Zeit (`settled`/`waitedMs`), nicht als
  `superseded`. Die Risikozeile „Firefox trägt das nicht" wird also nur halb geprüft — das gehört
  in den Messbericht, nicht als grüner Haken.
- **Ein falscher Schlüssel fällt nur im Zwei-Tab-Fall auf.** Alle Überholfälle arbeiten in Tab 500;
  `pageSlots.set(true, …)` bliebe dort grün. Deshalb ist Stufe 2 die einzige Stufe, deren Fall rot
  werden kann, wenn man vor ihr implementiert.
- **Ein fehlender Identitäts-Wächter hat in den *neuen* Fällen kein Symptom** — die Sonde sieht
  den Rest-Eintrag nicht, weil der veraltete Aufruf den Eintrag des Nachfolgers löscht. **Er ist
  trotzdem bewiesen**, nur woanders: entfernt man ihn, werden vier bestehende Fälle rot
  (`click_withTwoOverlappingRequests…`, `click_duringARunningNavigation…`,
  `type_withTwoOverlappingRequests…`, `type_whenAClickArrivesDuringTheWait…`). Das hat der
  Code-Review mit Mutationen gezeigt — die frühere Behauptung „kein Symptom von außen" war zu
  absolut.
- **`close_tab` mitten in der Injektion antwortet `no_agent_tab`**, nicht `superseded`.
- **Kriterium 3 braucht keinen neuen Fall:** `click_withTwoOverlappingRequests…` behauptet schon
  „erster `superseded`, zweiter `ok`" und bleibt unverändert; ein zweiter Fall mit anderem Namen
  wäre Ballast.

### Ordering and dependencies

1 → 2 → 3 → 4. Stufe 1 ist bis auf die noch ungeprüfte Nebenläufigkeit verhaltensgleich und muss
**ohne Teständerung** grün sein — bleibt ein Überholfall rot, ist der Schlüssel oder der Wächter
falsch, nicht die Erwartung. Stufe 2 bringt das Instrument (ohne das Kriterium 4 nicht entscheidbar
ist) und kommt deshalb vor Stufe 3. Kriterien 1–4 laufen vor dem Commit, Kriterium 5 danach durch
den Betreiber.

### What the next increment inherits

- `type` behält 300 ms, `click` Ruhe plus Rückfall, `navigate` zwei Phasen; `read`, `inspect`,
  `focus` nehmen weiter keinen Slot.
- Die Map hält nur *arbeitende* Tabs; jeder Slot verschwindet im `finally` oder in
  `supersedePageSlot`. Die Sonde ist ab jetzt Harness-Inventar.
- `supersedeActiveNavigation` existiert nicht mehr; `SUPERSEDED_SETTLE` bleibt
  Steuerfluss-Sentinel und reist nie in ein Ergebnis.
- Nicht in diesem Inkrement: Firefox' tatsächliches Nebenläufigkeits-Verhalten als Messung, ein
  Fenster-Parameter, die Obergrenze 5, parallele Arbeit **im selben** Tab.

## Risiken

- **Nebenläufigkeit ist eine neue Klasse von Fehlern.** Zwei Injektionen gleichzeitig
  können in Firefox langsamer sein als zwei nacheinander (ein Prozess je Tab, aber
  gemeinsame Ressourcen). Wenn Kriterium 5 zwar grün ist, aber die Aufrufe messbar
  träger werden, ist das ein eigener Befund und gehört hierher.
- **Die Map wächst mit den arbeitenden Tabs**, nicht mit den offenen; ein Eintrag
  verschwindet im `finally`. Bleibt einer stehen, ist das ein Leck — deshalb die
  Zählung im Harness.
- **`superseded` wird seltener**, und damit auch getestet seltener: die bestehenden
  Überholfälle decken den Ein-Tab-Fall weiter ab.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine neue Berechtigung.
- `bridge/*`, `extension/manifest.json`, `extension/options.*` bleiben unverändert.
- `docs/*` pflegt der Orchestrator.

## Open questions

Keine. Der Zuschnitt (Slot je Tab als eigenes Inkrement, Live-Kriterium) ist am
2026-10-23 aus der Review von Spec 16 entstanden.

## Review

**Runde 1 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Elf Befunde, alle übernommen:

1. **Kriterium 5 behauptete mehr, als es misst** — jetzt: beide `ok`, keine `superseded`, eigene
   `tabId`, **Zeiten im Messbericht**, Firefox-Frage getrennt.
2. **Der Ausstieg in Stufe 4** war ein Freibrief — jetzt ein **Aufbaufehler**, der wiederholt wird.
3. **`## Amendments` fehlte** — ergänzt, samt der Entdeckung, dass Spec 16 auf
   `supersedePageSlot` verwies, das es dort nicht gab (**dort korrigiert**).
4. **Die `navigate`-Folge war unbenannt und ungetestet** — jetzt in `## Ziel`, Testing, Kriterium 2.
5. **`type` fehlte** — eigener Zwei-Tab-Fall.
6. **Kriterium 4 nannte das Instrument nicht** — jetzt `slotMapKeys(started) === [[]]`.
7. **„nach jedem Fall leer"** — auf die drei einschlägigen Fälle eingegrenzt.
8. **Die Sonden-Mechanik war geraten** — drei Fallstricke ausgeschrieben.
9. **„genau ein Empfänger" war unskopiert** — jetzt je Fall, mit lauter Meldung.
10. **Stufe 1 schrieb den Schlüssel ausgelassen** — gerade dort, wo ein falscher Schlüssel ewig
    grün bliebe.
11. **„rot vor Stufe 1" hatte keine Methode** — jetzt eine konstante Schlüssel-Mutation.

**Runde 2 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Sieben Befunde — und der
Reviewer hatte in einem Punkt schlicht recht: **mehrere Ersetzungen aus Runde 1 waren gar nicht
gelandet**, weil ihre Anker nicht mehr passten. Ich habe den Dateizustand geprüft statt dem
eigenen Bericht zu glauben. Alle übernommen:

1. **Zwei deklarierte Fälle hatten keine Stufe** (`type_…`, `navigate_…`) — jetzt baut Stufe 2
   **drei** Zwei-Tab-Fälle, jeder endet mit `slotMapKeys(...) === [[]]`.
2. **Die Testing-Zeile „nach jedem Fall"** hätte 400 Fälle gemeint — jetzt namentlich die drei
   einschlägigen.
3. **Stufe 4 hatte noch den Ausstieg** („nacheinander ⇒ Bekannte Lücken") — jetzt ein
   **Aufbaufehler**, der wiederholt wird, mit zwei Wegen, Gleichzeitigkeit zu erzwingen.
4. **Kriterium 5 behauptete noch die Firefox-Zusage** — jetzt: beide `ok`, eigene `tabId`, Zeiten
   im Messbericht, und ausdrücklich, was der Beleg **nicht** zeigt.
5. **„rot vor Stufe 1"** war ohne Stufe 1 begrifflos — jetzt „rot mit Stufe 1 und konstantem
   Schlüssel; ohne Stufe 1 schon heute rot".
6. **`started` war nirgends definiert** — jetzt: der beim Start erzeugte Sandbox-Zustand.
7. **„als einfache Objekte" war falsch** — Literale behalten den Realm-Prototyp; die Ops werden
   mit `inThisRealm` kopiert.

**Nach diesem zweiten Block gilt die Projektregel:** blockiert Runde 3 erneut, wird die Spec
geteilt (Mechanik + Sonden-Instrument als ein Inkrement, die drei Zwei-Tab-Fälle als das nächste),
statt sie durchzuwinken.

**Runde 3 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Fünf Befunde, alle übernommen —
und **der dritte Block löst die Teilungsregel aus**. Der Reviewer sagt zugleich: „no criterion
changes, no rethink", die Befunde seien drei Prosa-Zeilen und ein Befehl.

**Entscheidung des Orchestrators — mit dem Betreiber am 2026-10-23 —: freigegeben, nicht geteilt.**
Begründung, damit sie prüfbar bleibt und nicht als Bequemlichkeit durchgeht:

- Die Blöcke betrafen **Präzision**, nicht Größe: die Spec hat vier Stufen, und keine ist
  gewachsen. Sie ist damit nicht „zu groß" im Sinne der Regel.
- Der vorgeschlagene Schnitt (Stufen 1–2 = Mechanik + Sonde, danach die drei Zwei-Tab-Fälle) hätte
  **ein Inkrement ohne beobachtbares Ziel** ergeben: die Proof-Zeile von Stufe 1 ist „grün ohne
  geänderte Zusicherung", und die drei Fälle sind die einzige Stelle, an der die neue Zusage rot
  werden kann. Getrennt wäre der erste Teil unbelegbar und der zweite reine Testarbeit.
- Was die Regel verhindern soll — durchwinken trotz offener Substanz — liegt hier nicht vor: alle
  23 Befunde sind umgesetzt und einzeln gegengegrept, und der letzte Block enthielt keinen einzigen
  Kriteriumsbefund mehr.

**Wenn die Umsetzung zeigt, dass die Zwei-Tab-Fälle nicht rot werden können**, geht es zurück in
diese Spec — dann war die Teilung nicht die fehlende Antwort, sondern die Mechanik falsch.

## Log

Je Review-Runde eine Zeile pro Befund, alle **übernommen**:

- **Runde 1** (11): Kriterium 5 maß nicht, was es behauptete → Zeiten in den Messbericht.
  „nacheinander ⇒ Bekannte Lücken" war ein Freibrief → Aufbaufehler. `## Amendments` fehlte →
  ergänzt (Spec 16 an fünf Stellen, Spec 15 Signatur). `navigate`-Folge unbenannt → Ziel, Testing,
  Kriterium. `type` ohne eigenen Fall → ergänzt. Kriterium 4 ohne Instrument → Sonde benannt.
  „nach jedem Fall" → drei Fälle. Sonden-Mechanik geraten → drei Fallstricke. „genau ein Empfänger"
  unskopiert → je Fall. Schlüssel ausgelassen → ausgeschrieben. „rot vor Stufe 1" ohne Methode →
  konstante Schlüssel-Mutation.
- **Runde 2** (7): **Drei Runde-1-Ersetzungen waren nie gelandet** (Anker passten nicht) — der
  Orchestrator hat den Dateizustand geprüft statt dem eigenen Bericht zu glauben. Dazu: zwei
  deklarierte Fälle ohne Stufe → Stufe 2 baut drei; Testing-Zeile eingegrenzt; Ausstieg in Stufe 4
  entfernt; Kriterium 5 ehrlich; `started` definiert; `inThisRealm` statt Literal.
- **Runde 3** (5): **Die Gegenprobe zu Kriterium 4 war wirkungslos** — wer nur den Identitäts-
  Wächter entfernt, löscht den Eintrag des *Nachfolgers*, die Map bleibt leer und der Fall grün;
  jetzt eine Mutation, die wirklich einen Eintrag hinterlässt. Dazu: Symptomrichtung (der
  **erste** Aufruf verliert), das Testmuster für Stufe 3, „im selben Tick" statt „in einer
  Antwort", und dieser Log-Abschnitt.

Befunde beim Schreiben des Dev-Plans (2026-10-23), vom Architekten:

- **Die Map ist von außen unsichtbar** (`background.js` ist eine IIFE) — Kriterium 4 wäre ohne
  Instrument nicht entscheidbar. Gelöst mit einer Sonde im Sandbox-Realm (gepatchtes
  `Map.prototype`), die zusätzlich prüft, dass es **genau eine** Map ist. **Übernommen.**
- **`navigate` löst nur den Slot seines Ziels ab**, auch ohne `tab` — die Auflösung liefert vorher
  den zuletzt benutzten Tab. Damit laufen zwei `navigate` auf zwei Tabs nebeneinander, was die
  Spec nicht ausdrücklich verlangt, aber folgerichtig ist. **Übernommen.**
- **Kriterium 5 misst unsere Map, nicht Firefox.** Beide Antworten entstehen in der Extension; ein
  blockierender Browser zeigte sich als Zeit, nicht als `superseded`. **Als Grenze notiert**, damit
  der Messlauf nicht mehr behauptet, als er belegt.

**Code-Review (2026-10-23, `grizzled-senior-dev`): ✅ Ship it, ohne Blocker.** Der Reviewer hat
vier Mutationen gesetzt, statt dem Bericht zu glauben: konstanter Schlüssel ⇒ `click_`/`type_`
rot; `releasePageSlot` aus dem `finally` entfernt ⇒ Sonde zeigt `[[501,500]]`;
`supersedePageSlot` aus `closeAgentTab` entfernt ⇒ der Close-Fall rot; `background.js` auf den
Stand vor Stufe 1 zurück ⇒ alle vier neuen Fälle rot. Testdiff: **261 Zeilen hinzu, 0 gelöscht** —
keine bestehende Zusicherung angefasst, keine Referenz auf `activeNavigation`,
`requireClickOwnership` oder `supersedeActiveNavigation` übrig.

Zwei Korrekturen am Text, die er angestoßen hat: der Identitäts-Wächter **ist** bewiesen (durch
vier bestehende Fälle, nicht durch die neuen), und „löschen vor `finish`" ist
Defence-in-Depth — getauscht bleibt alles grün. Beides steht jetzt so in der Spec.
