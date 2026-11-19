---
description: Der Vertrag für browser_eval und der Func-Runner im Harness — Vorarbeit für den Umzug in die Seitenwelt.
status: proposed
---

# Der `eval`-Vertrag und der Func-Runner

Abgespalten von der ursprünglichen `docs/47` nach dem **dritten** Review-Block
(2026-11-18, `CONTRIBUTING.md` Schritt 4: teilen statt durchwinken). Der
sichtbare Teil — `world: "MAIN"`, die CSP-Meldung, die Optionsseite — steht in
`docs/48-eval-in-der-seitenwelt.md`.

**Warum diese Spec zuerst:** `browser_eval` ist unter MV3 tot (`call to
Function() blocked by CSP`, gemessen 2026-11-18). Der Fix verlangt einen `func`,
der per `toString` serialisiert wird und **nichts** aus seiner Umgebung
mitnehmen kann. Bevor irgendetwas in die Seitenwelt zieht, muss feststehen, was
dieser `func` zurückgibt und wie der Harness ihn ausführt — sonst ist jeder der
30 `eval_`-Fälle blind.

## Ziel

- **Der Vertrag des `func` ist festgeschrieben**, bevor Code umzieht: Argumente,
  Rückgabe, Frist, Fehlertext, DOM-Ergebnisse.
- **Der Harness kann einen `func` ausführen**, in **zwei Welten je Frame**
  (isoliert und Seitenwelt) — sonst lässt sich die Grenze nicht messen.
- **Ein einziger Serialisierer bleibt lebendig.** `serialize` in
  `page-agent.js` hat heute genau einen Aufrufer: den `eval`-Op. Zieht der um,
  wird die Kopie dort gelöscht; es gibt danach **eine** Implementierung, nicht
  zwei, und die Grenzfälle bewachen sie.
- **Kein sichtbares Verhalten ändert sich.** Die Werkzeuge antworten wie heute;
  der Umzug in die Seitenwelt ist `docs/48`.

## Der Vertrag

**Argumente:** `args: [code, limits, want]`.

| Teil | Inhalt |
|---|---|
| `code` | der auszuwertende Ausdruck, als String |
| `limits` | `{ timeoutMs, messageLimit, resultLimit, valueLimit, classLimit }`. Alle fünf reisen mit, weil der `func` die Konstanten der Brücke nicht sieht: `timeoutMs` = `EVAL_TIMEOUT_MS` 2 000 (`extension/bridge.js:387`), `messageLimit` = `EVAL_MESSAGE_LIMIT` 500 (`:404`), `resultLimit` = `EVAL_RESULT_LIMIT` 10 000. `valueLimit` und `classLimit` sind die `inspect`-Grenzen, damit `selectorForElement` denselben Selektor baut wie heute |
| `want` | der Frame-Filter, **erste Anweisung** im `func` — sonst läuft er mit `allFrames` in jedem Frame |

**Rückgabe:** genau ein Objekt. Die Felder hängen am `outcome` —
`href` trägt **jede** Antwort, weil `frameTargetOf` daraus die Kandidaten baut
(ohne `href` werden zwei werfende Frames zu `frame_ambiguous` mit
`candidates: [null, null]`, und `test/extension.test.js:13824` fällt):

| `outcome` | Felder |
|---|---|
| `not_the_frame` | `outcome`, `href` |
| `ok` | `outcome`, `href`, `url`, `title`, `elapsedMs`, `json` |
| `threw` | `outcome`, `href`, `url`, `title`, `elapsedMs`, `message` |
| `timeout`, `too_large`, `unserializable` | `outcome`, `href` |

- `json` ist ein **JSON-String** (`evalResultOf` macht `JSON.parse(entry.json)`,
  `extension/bridge.js:3633`); seine Länge zählt gegen `resultLimit`.
- `message` ist der Fehlertext der Seite, gekürzt auf `messageLimit`. Ohne
  dieses Feld kann die Antwort „`eval_failed` mit dem Fehlertext" nicht
  entstehen (`test/extension.test.js:12143` pinnt sie).
- `undefined` ⇒ `null`, BigInt ⇒ String, Funktion ⇒ `"[function]"`,
  nicht serialisierbar ⇒ `unserializable`.

**DOM-Ergebnisse haben einen Besitzer:** liefert der Code ein Element, antwortet
`json` mit `{ kind: "node", tag, selector }`; bei einem **Textknoten** mit
`{ kind: "node", nodeType: 3 }` — ein Textknoten trägt keinen Selektor und keinen
Text, weil er beides nicht hat (`extension/page-agent.js:1476-1479`). Gebaut von
**einem** Selektor-Bauer, der mit dem `func` reist (`selectorForElement`, heute
`extension/page-agent.js:1179`). Die Fälle
`eval_withADomNodeResult_shouldAnswerTheSelectorOfThatElement` (`:12387`) und
`eval_withATextNodeResult_shouldAnswerKindNodeAndNodeType` (`:12407`) pinnen das
und bleiben unverändert.

## Der Func-Runner im Harness

Der Harness (`test/extension.test.js`) kennt heute nur `inject()` mit
`{files, target}` (`:468-500`). Er bekommt einen zweiten Zweig:

- Schlüssel genau `["args", "func", "target", "world"]` — `world` fehlt, solange
  `docs/48` nicht gebaut ist; dann prüft der Fall nur `{args, func, target}`.
- `args` reist durch JSON (kein Closure, kein DOM).
- `func` läuft in einem **Seitenwelt-Realm**, der vom isolierten Realm desselben
  Frames getrennt ist: zwei Kontexte, zwei `window`, ein gemeinsames DOM.
- Antwort: `[{frameId, result}]` wie `executeScript` es liefert.

**Das ist die Voraussetzung für jeden Fall**, nicht nur für die Grenze: alle 30
`eval_`-Fälle laufen heute über den Nachrichtenkanal und müssen auf den
`func`-Zweig umgestellt werden.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `inject_withAFunc_shouldRunItInThePageWorldRealm` | der Runner existiert und trennt die Welten |
| `test/extension.test.js` | `eval_withReturnDocumentTitle_shouldAnswerTheTitle` (bestehend, umgestellt) | der erste Fall beweist, dass der Umbau trägt |
| `test/extension.test.js` | `eval_whenTheCodeThrows_shouldAnswerEvalFailedWithTheMessageAndNoStack` (bestehend) | `message` steht im Vertrag |
| `test/extension.test.js` | `eval_withADomNodeResult_shouldAnswerTheSelectorOfThatElement` (bestehend, `:12387`) und `eval_withATextNodeResult_shouldAnswerKindNodeAndNodeType` (`:12407`) | DOM-Ergebnisse haben einen Besitzer |
| `test/extension.test.js` | `eval_withAResultOfExactlyTenThousandJsonCharacters_shouldAnswerOk` (`:12343`) und `…TenThousandAndOne…_shouldAnswerTooLarge` (`:12358`) | die Grenze gilt für `json` |
| `test/extension.test.js` | `eval_whenTheCodeThrows_shouldAnswerEvalFailedWithTheMessage` (bestehend, `:12372`) | `message` ist auf `messageLimit` gekürzt |
| `test/extension.test.js` | `injection_forEval_shouldCarryArgsFuncTargetWorld` | die Schlüssel sind gepinnt; ein Rückfall in den Kanal bleibt nicht grün |

## Acceptance criteria

**Alle Kriterien entscheidet der Umsetzer** — sie brauchen keinen Browser.

1. **Ein Serialisierer.** `grep -c 'function serialize' extension/page-agent.js
   extension/bridge.js` ⇒ **0** in `page-agent.js` (der `eval`-Op und sein
   Serialisierer sind dort gelöscht) und **1** in `bridge.js`.
2. **Der Vertrag steht.** `injection_forEval_shouldCarryArgsFuncTargetWorld`
   ⇒ grün; die Schlüssel sind **genau** `args`, `func`, `target` (und `world`,
   sobald `docs/48` gebaut ist).
3. **Die 30 Fälle laufen über den `func`.** `node --test --test-reporter=tap
   test/extension.test.js 2>&1 | grep -cE '^ok [0-9]+ - eval_'` ⇒ **≥ 30**
   (`docs/48` fügt zwei dazu; die Zahl wächst dort, nicht hier).
4. **Der Fehlertext reist.** `eval_whenTheCodeThrows_shouldAnswerEvalFailedWithTheMessageAndNoStack`
   ⇒ grün, und die Antwort enthält den Text der Seite, keinen Stack.
5. **DOM-Ergebnisse.**
   `eval_withADomNodeResult_shouldAnswerTheSelectorOfThatElement` und
   `eval_withATextNodeResult_shouldAnswerKindNodeAndNodeType` ⇒ grün.
6. **Die Suite bleibt grün.** `npm test` ⇒ `# fail 0`, `# cancelled 0`;
   `npm run check` ⇒ 0.

## Dev plan

**Stufe 1 — der Func-Runner und der gelockerte Schlüssel-Pin**

Dateien: `test/extension.test.js` (`inject()` um den `func`-Zweig, zwei Realms je
Frame) **und** der Schlüssel-Pin `:471-473` (`["files","target"]` ⇒
`["args","func","target"]`), dazu ein **neuer** reiner Harness-Fall
(`inject_withAFunc_shouldRunItInThePageWorldRealm`).

Der Pin muss in derselben Stufe fallen wie der Zweig — sonst ist der erste
Aufruf rot.

Beweis: Kriterium 2 (der neue Fall).

**Stufe 2 — der `func` und sein Vertrag**

Dateien: `extension/bridge.js` (der eigenständige `func` mit Frame-Filter, den
fünf `limits`, Serialisierer, DOM-Formen), `extension/page-agent.js` (`eval`-Op
und `serialize` löschen), `test/extension.test.js` (die 30 Fälle, davon einer
umgestellt als erster Beweis: `eval_withReturnDocumentTitle_shouldAnswerTheTitle`),
**`docs/45`** (Amendment: `eval` nimmt den Kanal nicht mehr in Anspruch —
datiert, siehe `## Amendments`).

Beweis: Kriterien 1, 3, 4, 5.

**Stufe 3 — die Frame-Pins ziehen**

Dateien: `test/extension.test.js` (`:13769-13771` — die Frame-Fälle prüfen
`details.files`/`scriptCalls`).

Beweis: Kriterium 6.

## Amendments to previous spec docs

| Dokument | Abschnitt | was gilt |
|---|---|---|
| `docs/45-injection-naht.md` | `## Die Naht` | `eval` antwortet nicht mehr über den Kanal: seine Antwort kommt mit dem `executeScript`-Promise, und einen „stummen Frame" gibt es dort nicht. Datiert in Stufe 2 nachgezogen |

## Bekannte Lücken

- **Der Zwei-Welten-Harness ist eine Attrappe.** Er trennt zwei Kontexte, aber
  nicht mit derselben Mechanik wie Firefox; dass die echte Grenze hält, zeigt
  erst `docs/48` am laufenden Browser.
- **`selectorForElement` reist als Kopie im `func`.** Eine echte Wiederverwendung
  ginge nur über eine injizierte Datei, und die kann keine Funktion
  zurückgeben.

## Open questions

**Keine.**

## Review

### Runde 1 des neuen Zuschnitts — 2026-11-18, `grizzled-senior-dev`: 🔧

Der dritte Block der ursprünglichen (ungeteilten) `docs/47` — nach `CONTRIBUTING.md`
der Grund für die Teilung; hier steht das Ergebnis: der Rückgabevertrag trug den
Fehlertext nicht (`message` fehlte), die „zwei Serialisierer" waren eine
Fehlannahme (`serialize` hat genau einen Aufrufer, den `eval`-Op), der Harness
konnte einen `func` gar nicht ausführen, DOM-Ergebnisse hatten keinen Besitzer,
`EVAL_TIMEOUT_MS` lag am falschen Ort, vier Testnamen existierten nicht, und die
Runden-Zählung im `## Review` fehlte.

**Folge: geteilt.** Diese Spec trägt den Vertrag und den Harness-Runner
(unsichtbares Verhalten); `docs/48` trägt `world: "MAIN"`, die CSP-Meldung, die
Optionsseite und die Amendments.

**Übernommen:** `message` im Vertrag; ein Serialisierer (der in `page-agent.js`
wird gelöscht); der Func-Runner mit zwei Welten je Frame als Voraussetzung für
alle Fälle; `selectorForElement` als mitreisende Kopie mit den zwei bestehenden
DOM-Fällen; `timeoutMs` reist in `limits`; die Testnamen sind die echten; diese
Runde steht hier.

## Log

- **2026-11-18, Messung:** `browser_eval` scheitert unter MV3 mit
  `call to Function() blocked by CSP` (zweimal reproduziert).
- **2026-11-18, Messung `world: "MAIN"`:** trägt in Firefox 152.0.3 — Details in
  `docs/48`.
- **2026-11-18, Teilung:** nach dem dritten Block in Vertrag/Harness (hier) und
  sichtbares Verhalten (`docs/48`).
