---
description: Der Vertrag des func und der Umzug von browser_eval auf den Kanal-freien Weg — setzt den Harness-Runner aus docs/47 voraus.
status: proposed
---

# Der `func`-Vertrag und der Umzug von `browser_eval`

**Geteilte Hälfte** der Vorgängerspec (dritter Block, 2026-11-19). Der
Harness-Runner steht in `docs/47-func-runner-im-harness.md` und ist
**Voraussetzung**; die Seitenwelt und die CSP-Meldung sind `docs/48`.

## Ziel

- **`browser_eval` antwortet wieder**, mit demselben Vertrag wie bisher: `code`
  hinein, Ergebnis heraus, `elapsedMs`, `null` wenn der Ausdruck nichts liefert,
  benannte Fehlercodes.
- **Der Code reist als `func`** statt als Nachricht an den Agenten-Tab. Damit
  braucht `eval` weder den Kanal noch einen stummen Frame.
- **Ein Serialisierer bleibt lebendig.** `serialize` in `page-agent.js` hat genau
  einen Aufrufer: den `eval`-Op. Beide werden gelöscht; es gibt danach **eine**
  Implementierung, im `func`.
- **Kein sichtbares Verhalten ändert sich** außer dem, was `docs/48` umstellt.

## Der Vertrag

**Argumente:** `args: [code, limits, want]`.

| Teil | Inhalt |
|---|---|
| `code` | der auszuwertende Ausdruck, als String |
| `limits` | `{ timeoutMs, messageLimit, resultLimit, valueLimit, classLimit }`. Alle fünf reisen mit, weil der `func` die Konstanten der Brücke nicht sieht. Werte: `timeoutMs` = 2 000 (`EVAL_TIMEOUT_MS`), `messageLimit` = 500 (`EVAL_MESSAGE_LIMIT`), `resultLimit` = 10 000 (`EVAL_RESULT_LIMIT`). `valueLimit` und `classLimit` sind die `inspect`-Grenzen, damit `selectorForElement` denselben Selektor baut wie heute: `INSPECT_TEXT_LIMIT` 200 und `INSPECT_CLASS_LIMIT` 10 (`extension/bridge.js:263-264`, angewandt auf `:3588-3589`) |
| `want` | der Frame-Filter, **erste Anweisung** im `func` — sonst läuft er mit `allFrames` in jedem Frame |

**Rückgabe:** ein Objekt, dessen Felder am `outcome` hängen. `href` trägt
**jede** Antwort, weil `frameTargetOf` daraus die Kandidaten baut — ohne `href`
werden zwei werfende Frames zu `frame_ambiguous` mit `candidates: [null, null]`,
und `eval_withTwoFramesThatBothThrow_shouldAnswerFrameAmbiguousWithBothAddresses`
(`:13890`) fällt:

| `outcome` | Felder |
|---|---|
| `not_the_frame` | `outcome`, `href` |
| `ok` | `outcome`, `href`, `url`, `title`, `elapsedMs`, `json` |
| `threw` | `outcome`, `href`, `message` (`extension/page-agent.js:1563` liefert genau diese drei) |
| `timeout`, `too_large`, `unserializable` | `outcome`, `href` |

- `json` ist ein **JSON-String** (`evalResultOf` steht auf
  `extension/bridge.js:3633` und parst auf `:3658`); seine Länge zählt gegen
  `resultLimit`.
- `message` ist der Fehlertext der Seite, gekürzt auf `messageLimit` — gepinnt
  von `eval_withAThrownMessageOf600Characters_shouldCutItAt500` (`:12438`).
- `undefined` ⇒ `null`, BigInt ⇒ String, Funktion ⇒ `"[function]"`, Symbol ⇒
  `"[symbol]"`, nicht serialisierbar ⇒ `unserializable`.

**Ein Promise als Rückgabe:** der `func` wartet in der Seitenwelt, nicht die
Brücke — er gibt erst das aufgelöste Ergebnis zurück. Der Transport steht im
Harness: `runFuncIn` gibt ein Promise zurück, `inject` ist `async`, der
`func`-Arm treibt die Uhr (gebaut und gemessen in `50c5569`, `docs/47` Stufe 2).
Die Frist von 2 000 ms läuft im `func` selbst, sodass ein Promise, das zu spät
auflöst, `timeout` liefert und nicht hängt. Gepinnt von
`eval_withAPromiseThatResolvesAfter50ms_shouldAnswerTheValue` (`:12246`) und
`eval_withAPromisePastTheDeadline_shouldAnswerEvalTimeout` (`:12268`).

**DOM-Ergebnisse haben einen Besitzer:** ein Element ⇒
`{ kind: "node", tag, selector }`; ein **Textknoten** ⇒
`{ kind: "node", nodeType: 3 }` — er trägt keinen Selektor und keinen Text, weil
er beides nicht hat (`extension/page-agent.js:1476-1479`, der Vertrag ab
`:1480`). Gebaut von **einem** Selektor-Bauer, der mit dem `func` reist
(`selectorForElement`, heute `extension/page-agent.js:1179`). Gepinnt von
`eval_withADomNodeResult_shouldAnswerTheSelectorOfThatElement` (`:12453`) und
`eval_withATextNodeResult_shouldAnswerKindNodeAndNodeType` (`:12473`).

## Die Zahlen

- **30** `eval_`-Fälle zählt `npm test` heute.
- **5** davon antworten, **bevor** injiziert wird (`:11889`, `:11910`, `:11928`,
  `:11944`, `:11964` — Schalter aus, Schalter als String `"true"`, Code leer, die
  Grenzen des Argumentbaus), und **2** antworten aus einer **abgelehnten**
  Injektion (`:11979` reicht ein werfendes `executeScript` herein, `:12003`
  antwortet danach und prüft selbst `tabs.scriptCalls.length === 1`).
  *(Zeilen nach `50c5569`.)*
- **23** laufen über den Nachrichtenkanal. Nach Stufe 1 sind es **0** — sie
  brechen nicht „einer nach dem anderen", sondern im selben Schritt, in dem der
  `eval`-Op fällt. Deshalb ist die Umstellung **eine** Änderung, keine Reihe.
- **16** `askPageAgent`-Aufrufe hat `extension/bridge.js`. Der `eval`-Aufruf
  (`:3597`) kann **keiner** davon bleiben: `askPageAgent` (`:2528-2535`) schickt
  immer `sendPageMessage` und wartet auf die Kanalsammlung — mit ihm würde
  `tabs.channel.calls.length` nie 0, und das `[{frameId, result}]` des `func`
  fiele weg. Nach dem Umzug gibt es **15** `askPageAgent`-Aufrufer und **einen
  direkten** Aufruf der einen `executeScript`-Stelle (`injectScript`, `:2464`).
  `frameTargetOf` bekommt die `result` je Frame statt der Kanalantworten.

## Non-goals

- **Kein `world: "MAIN"`** — das ist `docs/48`.
- **Kein `'unsafe-eval'`**, keine Änderung an `bridge-rs`, kein neues Werkzeug.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `injection_forEval_shouldCarryArgsFuncTarget` (**neu**) | die Schlüssel sind genau `args`, `func`, `target`; den `world`-Schlüssel besitzt `docs/48` |
| `test/extension.test.js` | `eval_withReturnDocumentTitle_shouldAnswerTheTitle` (bestehend, umgestellt) | der Kanal wird nicht mehr benutzt: `tabs.channel.calls.length` ⇒ 0 |
| `test/extension.test.js` | `eval_withAThrownMessageOf600Characters_shouldCutItAt500` (`:12438`, bestehend) | `message` steht im Vertrag und ist gekürzt |
| `test/extension.test.js` | `eval_withADomNodeResult_shouldAnswerTheSelectorOfThatElement` (`:12453`) und `eval_withATextNodeResult_shouldAnswerKindNodeAndNodeType` (`:12473`) | DOM-Ergebnisse haben einen Besitzer |
| `test/extension.test.js` | `eval_withAResultOfExactlyTenThousandJsonCharacters_shouldAnswerOk` (`:12409`) und `eval_withAResultOfTenThousandAndOneJsonCharacters_shouldAnswerTooLarge` (`:12424`) | die Grenze gilt für `json` |
| `test/extension.test.js` | `eval_withFrame_shouldRunTheCodeInTheAddressedFrame` (`:13816`) | der Frame-Pin `:13835-13836` — die einzige Stelle, die `details` anfasst |
| `test/extension.test.js` | `eval_withAPromiseThatResolvesAfter50ms_shouldAnswerTheValue` (`:12246`) und `eval_withAPromisePastTheDeadline_shouldAnswerEvalTimeout` (`:12268`) | das Promise quert als aufgelöstes Ergebnis |
| `test/extension.test.js` | `eval_whenThePageNeverAnswers_shouldAnswerEvalTimeoutThroughTheGuard` (`:12286`) | siehe `## Bekannte Lücken` — der Fall sucht einen neuen Gegenstand |

## Acceptance criteria

**Kriterien 1–4 entscheidet der Umsetzer**, ohne Browser.

1. **Ein Serialisierer, und kein toter Aufrufer.**
   `grep -c 'serialize(' extension/page-agent.js` ⇒ **0**, in
   `extension/bridge.js` ⇒ **1** (die Aufrufform, nicht die Deklarationsform —
   der `func` reist als Quelltext); `grep -c 'evalPageSource' extension/page-agent.js`
   ⇒ **0**. Sonst bleibt ein Rumpf stehen, der `serialize` aufruft und nie
   läuft, und `npm test` wie `node --check` merken es nicht.
2. **Der Kanal ist frei.** In `eval_withReturnDocumentTitle_shouldAnswerTheTitle`
   ist `tabs.channel.calls.length` ⇒ **0**, und der Inject-Aufruf trägt `func`.
3. **Der Vertrag steht.** `injection_forEval_shouldCarryArgsFuncTarget` ⇒ grün;
   die Schlüssel sind **genau** `args`, `func`, `target`. Geprüft wird der Pin
   **in `inject`** — `tabs.scriptCalls` taugt dafür nicht: der Stub protokolliert
   `JSON.parse(JSON.stringify(details))` (`:1791`), und eine Funktion überlebt
   das nicht.
4. **Kein Frame-Verhalten geändert.** Die vier Frame-Fälle
   (`eval_withFrame_shouldRunTheCodeInTheAddressedFrame` `:13816`,
   `eval_withAFrameThatMatchesNoFrame_shouldAnswerFrameNotFound` `:13844`,
   `eval_withFrame_shouldNotRunTheCodeInTheUnaddressedFrame` `:13864`,
   `eval_withTwoFramesThatBothThrow_shouldAnswerFrameAmbiguousWithBothAddresses`
   `:13890`) ⇒ grün. **Nur `:13816` fasst `details` an** (`:13835` `files`,
   `:13836` die Kanalzeile `args.want`, danach eine Leerzeile); die anderen drei
   beweisen das Verhalten.
   Beide Reparaturen fallen in **Stufe 1**, nicht in Stufe 2 — der Fall bricht
   sonst, bevor die Stufe ihn repariert.
5. **Die Suite bleibt grün.** `npm test` ⇒ `# fail 0`, `# cancelled 0`;
   `npm run check` ⇒ 0.

## Dev plan

**Stufe 1 — der `func` und der Umzug**

Dateien: `extension/bridge.js` (der eigenständige `func` mit Frame-Filter, den
fünf `limits`, Serialisierer, DOM-Formen; der Aufruf auf `:3597` wird ein
direkter `injectScript`-Aufruf), `extension/page-agent.js` (`eval`-Op, `serialize`, `evalPageSource` `:1432`
samt `isThenable` `:1507` und `withinDeadline` `:1519` löschen — sie rufen sich
gegenseitig und `:1568` ruft das gelöschte `serialize`; auf der Brückenseite wird
`evalPageRequest` `:3684` genauso arbeitslos), `test/extension.test.js` (die 23 Kanal-Fälle auf den
`func`-Zweig aus `docs/47`).

**Voraussetzung: `docs/47` Stufe 2** (der Transport — `runFuncIn` async, `inject`
gibt ein Promise, die Uhr im `func`-Arm, `neverAnswer`). Diese vier Stellen sind
dort gebaut und bewiesen; ohne sie können `:12246` und `:12268` nicht grün
werden.

Die Umstellung ist **ein** Schritt: der `eval`-Op fällt, und mit ihm alle 23
Fälle, die ihn verwenden.

Beweis: Kriterien 1, 2, 3, 4, 5 — die Reparatur der Frame-Assertions
(`:13835-13836`, `details.files` und die Kanalzeile `args.want`) gehört in diese
Stufe, weil der `eval`-Op hier fällt.

**Stufe 2 — die Doku**

Dateien: `docs/45-injection-naht.md` (datiertes Amendment),
`docs/PROJECT-STATE.md`, `docs/47-func-runner-im-harness.md` (`## Bekannte
Lücken`: der `func`-Zweig ist ab jetzt genutzt statt ungenutzt).

Beweis: keiner in Code — die Suite aus Stufe 1 bleibt grün.

## Amendments to previous spec docs

| Dokument | Abschnitt | was gilt |
|---|---|---|
| `docs/45-injection-naht.md` | `## Die Naht` | `eval` antwortet nicht mehr über den Kanal: seine Antwort kommt mit dem `executeScript`-Promise, und einen „stummen Frame" gibt es dort nicht |
| `docs/45-injection-naht.md` | `## Bekannte Lücken` („`func` wurde verworfen") | für `eval` ist die Entscheidung **aufgehoben**: dort reist die Nutzlast als `func`. Der Grund bleibt für die anderen Werkzeuge gültig |
| `docs/47-func-runner-im-harness.md` | `## Bekannte Lücken` („Der `func`-Zweig ist nach dieser Stufe ungenutzt") | wird mit Stufe 1 **falsch**: `eval` ist der erste und einzige Nutzer. Der Satz fällt |
| `docs/45-injection-naht.md` | `## Testing` („16 Aufrufer gegen `{file}` plus Nachrichtenkanal") | nach Stufe 1: **15** `askPageAgent`-Aufrufer gegen `{files, target}` und **ein** direkter `injectScript`-Aufruf (`:2464`) gegen `{args, func, target}`; kein Kanal |

## Bekannte Lücken

- **Der Wächter-Fall muss umgebaut werden.**
  `eval_whenThePageNeverAnswers_shouldAnswerEvalTimeoutThroughTheGuard`
  (`:12286`) hängt an `silent`-Frames und den zwei `INJECTION_REPLY_TIMEOUT_MS`
  (`:12321`, `:12325`, mit der Schleife `:12322-12328` und den
  Doppelantwort-Pins `:12329-12330`). Beides fällt mit dem Kanal weg. Der Haken ist da —
  `neverAnswer` (`test/extension.test.js:559`) —, Stufe 1 stellt den Fall darauf
  um und prüft, dass `EVAL_GUARD_MS` greift, wenn das Promise nie aufgelöst
  wird. Bis dahin ist die Wächter-Frist unbelegt.
- **`selectorForElement` reist als Kopie im `func`.** Eine echte
  Wiederverwendung ginge nur über eine injizierte Datei, und die kann keine
  Funktion zurückgeben.
- **Der `func` ist ein Funktionswert, der als Quelltext reist.** Firefox nimmt nur
  einen Funktionswert entgegen; der Harness nimmt beides und ruft
  `func.toString()` auf. Er kann nichts aus der Brücke mitnehmen — alles, was er
  braucht, steht in `args`.

## Open questions

**Keine.**

## Review

### Runde 1 — 2026-11-19, `grizzled-senior-dev`: 🔧 *(Vorgänger-Zuschnitt)*

Vier Blocker: alle Testzeilen waren um 54 verrutscht (die Spec war gegen den
Baum **vor** `35be904` geschrieben, das den Harness-Fall einfügte), und Kriterium
4 zeigte damit auf einen Kommentar statt auf den Frame-Fall; ein Promise als
Rückgabe hatte keinen Transport (zwei Fälle hätten nie grün werden können);
Stufe 2 fasste Zeilen an, die Stufe 1 schon bricht; und der Wächter-Fall
`:12286` verlor mit dem Kanal seinen Gegenstand.

**Übernommen:** alle Zeilen gegen HEAD neu verankert (Zusatz „Zeilen nach
`35be904`"), der siebte Injection-Fall
(`eval_whenTheSwitchHoldsTheStringTrue_shouldRefuseWithoutInjecting`) ergänzt,
der Promise-Übergang in den Vertrag und als `docs/47`-Amendment aufgenommen,
die Reparatur der Frame-Assertions nach Stufe 1 gezogen, Stufe 2 auf die Doku
reduziert, Kriterium 4 auf „nur `:13816` fasst `details` an" korrigiert, der
Wächter-Fall mit `neverAnswer` als Lücke benannt, und `symbol ⇒ "[symbol]"`
steht im Vertrag.

Die Block-Runden des Vorgängers stehen in der Git-Historie
(`docs/47-eval-vertrag.md`, `ab986b1` und davor).

### Runde 2 des Zuschnitts — 2026-11-19, `grizzled-senior-dev`: 🔧

Drei Blocker: fünf Zeilen aus dem `12400`-Block waren noch der Stand vor
`35be904` (−54); der Promise-Transport stand im Vertrag, aber in **keiner**
Stufe — und es ist mehr als ein `await` (`runFuncIn` synchron, `inject`
synchron, `letPageClocksRun` fährt die Seitenwelt-Uhr nicht weiter, `neverAnswer`
fehlt); und der `eval`-Aufruf konnte kein `askPageAgent`-Aufrufer bleiben, weil
`askPageAgent` immer den Kanal nimmt.

**Übernommen:** die fünf Zeilen nachgezogen (`:12409`, `:12424`, `:12438`,
`:12453`, `:12473`); die vier Harness-Stellen stehen als Tabelle in **Stufe 1**,
und Stufe 2 ist nur noch Doku; die Zahlen sind **15 `askPageAgent` + 1 direkter
`injectScript` (`:2464`)**, mit `frameTargetOf` auf die `result` je Frame; dazu
`valueLimit`/`classLimit` mit Namen und Zahlen und `:13823-13824` statt
`:13823-13825`.

### Runde 3 — 2026-11-19, `grizzled-senior-dev`: 🔧 → **geteilt**

Drei Blocker: die Harness-Zeile nannte die falsche Ursache (`letPageClocksRun`
wird nur aus `deliver` gerufen, nicht aus dem `func`-Arm; die Seitenwelt-Uhr ist
dasselbe Objekt wie die aus `realms`); Kriterium 3 war mit `tabs.scriptCalls`
nicht entscheidbar (der Stub protokolliert durch JSON, `func` fällt weg); und von
den „7 Fällen vor der Injection" injizieren zwei doch (`:11979`, `:12003`).

**Folge: geteilt.** Die vier Harness-Stellen (Transport) sind nach `docs/47`
**Stufe 2** gewandert — dort sind sie ohne Produktivcode beweisbar
(`inject_withAFuncThatAnswersAPromise_shouldAnswerTheResolvedValue`), und die
Runde-2-Klasse („steht im Vertrag, aber in keiner Stufe") kann strukturell nicht
wiederkommen. Hier bleibt: `func`, Vertrag, die 23 Fälle, die Frame-Reparaturen
und die Doku.

**Übernommen:** Kriterium 3 prüft den Pin **in `inject`**, mit der Begründung
(`:1791`); die Zahlen sind 5 + 2; `evalResultOf` `:3633` und das Parsen `:3658`;
der `func` ist ein Funktionswert, der als Quelltext reist.

### Runde 1 dieses Zuschnitts — 2026-11-19, `grizzled-senior-dev`: 🔧 *(nach der Teilung)*

Der vierte Rutsch derselben Art: `50c5569` (der Transport in `docs/47`) schob
jede Testzeile um **+12**, und die Spec war gegen den Stand davor geschrieben —
zwei der sieben Zahlen zeigten auf Leerzeilen. Dazu begründete Kriterium 3 sich
mit `:1777` (dem Rückgabeobjekt des Stubs) statt mit `:1791` (dem
JSON-Rundlauf), und zwei Dinge waren als offen beschrieben, die `50c5569`
gebaut hat (`neverAnswer`, der Promise-Transport).

**Übernommen:** alle Testzeilen um +12 nachgezogen, Herkunft auf `50c5569`
gesetzt, die zwei Sonderfälle von Hand (`:13890` für den
Zwei-Frame-Fall im Vertrag, `:13835-13836` für den Frame-Pin); `:1791` für den
JSON-Rundlauf; der Promise-Transport ist als **gebaut** benannt; die Lücke ist
jetzt der **Fall-Umbau** (`silent` und die zwei `INJECTION_REPLY_TIMEOUT_MS`
fallen weg, `neverAnswer` `:559` tritt an ihre Stelle); und das fehlende
Amendment steht in der Tabelle — `docs/47 ## Bekannte Lücken` („der
`func`-Zweig ist ungenutzt") wird mit Stufe 1 falsch.

### Runde 2 dieses Zuschnitts — Nachtrag — 2026-11-19, `grizzled-senior-dev`: 🔧

Zwei Blocker: das Löschen von „`eval`-Op und `serialize`" ließ `evalPageSource`
(`:1432`) mit `isThenable` und `withinDeadline` stehen, deren Rumpf auf `:1568`
das gelöschte `serialize` aufrief — Kriterium 1 wäre grün geworden, obwohl die
Datei einen toten Aufruf trägt; und der Lücken-Bereich `:12308-12316` zeigte auf
die Stelle, die **bleiben** muss (die `eval_timeout`-Assertion der
`frame`-Variante), statt auf `:12321`/`:12325` mit der Schleife und den
Doppelantwort-Pins.

**Übernommen:** die drei Funktionen stehen in der Stufe-1-Datei-Liste,
Kriterium 1 prüft außerdem `grep -c 'evalPageSource'` ⇒ 0, `evalPageRequest`
(`:3684`) ist als arbeitslos benannt, und der Bereich ist `:12317-12330`.

## Log

- **2026-11-19, Teilung:** dritter Block; Vertrag und Umzug hier, der
  Harness-Runner in `docs/47`.
