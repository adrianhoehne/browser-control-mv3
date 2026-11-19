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
| `limits` | `{ timeoutMs, messageLimit, resultLimit, valueLimit, classLimit }`. Alle fünf reisen mit, weil der `func` die Konstanten der Brücke nicht sieht. Werte: `timeoutMs` = 2 000 (`EVAL_TIMEOUT_MS`), `messageLimit` = 500 (`EVAL_MESSAGE_LIMIT`), `resultLimit` = 10 000 (`EVAL_RESULT_LIMIT`). `valueLimit` und `classLimit` sind die `inspect`-Grenzen, damit `selectorForElement` denselben Selektor baut wie heute |
| `want` | der Frame-Filter, **erste Anweisung** im `func` — sonst läuft er mit `allFrames` in jedem Frame |

**Rückgabe:** genau ein Objekt. Die Felder hängen am `outcome` —
`href` trägt **jede** Antwort, weil `frameTargetOf` daraus die Kandidaten baut
(ohne `href` werden zwei werfende Frames zu `frame_ambiguous` mit
`candidates: [null, null]`, und `test/extension.test.js:13824` fällt):

| `outcome` | Felder |
|---|---|
| `not_the_frame` | `outcome`, `href` |
| `ok` | `outcome`, `href`, `url`, `title`, `elapsedMs`, `json` |
| `threw` | `outcome`, `href`, `message` (`extension/page-agent.js:1563` liefert genau diese drei; `evalResultOf` liest nicht mehr) |
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
Text, weil er beides nicht hat (`extension/page-agent.js:1476-1479`, der Vertrag selbst ab `:1480`). Gebaut von
**einem** Selektor-Bauer, der mit dem `func` reist (`selectorForElement`, heute
`extension/page-agent.js:1179`). Die Fälle
`eval_withADomNodeResult_shouldAnswerTheSelectorOfThatElement` (`:12387`) und
`eval_withATextNodeResult_shouldAnswerKindNodeAndNodeType` (`:12407`) pinnen das
und bleiben unverändert.

## Der Func-Runner im Harness

Der Harness (`test/extension.test.js`) kennt heute nur `inject()` mit
`{files, target}` (`:468-506`, der `return` steht auf `:505`). Er bekommt einen zweiten Zweig:

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
| `test/extension.test.js` | `eval_withAThrownMessageOf600Characters_shouldCutItAt500` (bestehend, `:12372`) | `message` ist auf `messageLimit` gekürzt |
| `test/extension.test.js` | `injection_forEval_shouldCarryArgsFuncTarget` | die Schlüssel sind gepinnt; den `world`-Schlüssel besitzt `docs/48` (`injection_forEval_shouldCarryWorldMain`) |

## Acceptance criteria

**Alle Kriterien entscheidet der Umsetzer** — sie brauchen keinen Browser.

1. **Ein Serialisierer.** `grep -c 'function serialize' extension/page-agent.js
   extension/bridge.js` ⇒ **0** in `page-agent.js` (der `eval`-Op und sein
   Serialisierer sind dort gelöscht) und **1** in `bridge.js`.
2. **Der Vertrag steht.** `injection_forEval_shouldCarryArgsFuncTarget` ⇒ grün;
   die Schlüssel sind **genau** `args`, `func`, `target`. `world` kommt erst mit
   `docs/48` dazu und wird dort geprüft.
3. **Die Fälle laufen über den `func`, nicht über den Kanal.** Die Zahl allein
   beweist nichts — `grep -cE '^ok … - eval_'` zählt **heute schon 30**. Der
   Beweis ist der Kanal: im umgestellten Fall
   (`eval_withReturnDocumentTitle_shouldAnswerTheTitle`) ist
   `tabs.channel.calls.length` ⇒ **0**, und der Inject-Aufruf trägt `func`.
   **23** der 30 Fälle laufen heute über den Kanal (sieben antworten vor der
   Injection: `:11823`, `:11844`, `:11862`, `:11878`, `:11898`, `:11913`,
   `:11937`); nach Stufe 2 keiner mehr.
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
Frame) **und** der Schlüssel-Pin `:471-473` als **Vereinigung** zweier Mengen:

```
details.func === undefined ? ["files", "target"] : ["args", "func", "target"]
```

Der Pin prüft **jeden** Inject-Aufruf, und alle 17 `askPageAgent`-Stellen
schicken weiter `{files, target}` — eine echte Ersetzung machte die Suite
flächendeckend rot. Dazu ein **neuer** reiner Harness-Fall
(`inject_withAFunc_shouldRunItInThePageWorldRealm`).

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

Beweis: nicht „Suite grün", sondern die vier Frame-Fälle namentlich:
`eval_withFrame_shouldRunOnlyInTheAddressedFrame` (`:13778`),
`eval_withFrame_shouldNotRunTheCodeInTheUnaddressedFrame` (`:13798`),
`eval_withTwoThrowingFrames_shouldAnswerFrameAmbiguousWithBothCandidates`
(`:13824`) und `eval_withoutFrame_shouldRunInTheMainFrame` (`:13750`) — jeder
einzeln grün, nachdem der Pin gezogen ist.

## Amendments to previous spec docs

| Dokument | Abschnitt | was gilt |
|---|---|---|
| `docs/45-injection-naht.md` | `## Die Naht` | `eval` antwortet nicht mehr über den Kanal: seine Antwort kommt mit dem `executeScript`-Promise, und einen „stummen Frame" gibt es dort nicht. Datiert in Stufe 2 nachgezogen |
| `docs/45-injection-naht.md` | `## Bekannte Lücken` („`func` wurde verworfen") | für `eval` ist die Entscheidung **aufgehoben**: dort reist die Nutzlast als `func`. Der Grund (die Helfer reisen sonst als Text) bleibt für die anderen Werkzeuge gültig |
| `docs/45-injection-naht.md` | `## Testing` („die 16 Aufrufer gegen `{file}` plus Nachrichtenkanal") | nach Stufe 2 sind es **16 gegen `{file}`** und **ein** Aufrufer gegen `func` |

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

### Runde 2 des neuen Zuschnitts — 2026-11-19, `grizzled-senior-dev`: 🔧

Sechs Blocker: eine Testnamen-Leiche aus Runde 1
(`eval_whenTheCodeThrows…` existiert nicht; `:12372` heißt
`eval_withAThrownMessageOf600Characters_shouldCutItAt500`); die `threw`-Zeile
versprach `url`/`title`/`elapsedMs`, die niemand liefert; der Schlüssel-Pin war
als Ersetzung statt als Vereinigung geschrieben (alle 17 `askPageAgent`-Stellen
schicken weiter `{files, target}`); das `docs/45`-Amendment ließ „`func` wurde
verworfen" stehen; derselbe Pin hatte zwei Namen (`…ArgsFuncTargetWorld` hier,
`…CarryWorldMain` in `docs/48`); und Kriterium 3 war heute schon grün, weil es
nur die Zahl 30 zählte.

**Übernommen:** Name getauscht; `threw` liefert `outcome`, `href`, `message`;
der Pin ist die Vereinigung `details.func === undefined ? ["files","target"] :
["args","func","target"]`; Stufe 3 beweist sich mit den vier Frame-Fällen
namentlich statt mit „Suite grün"; das Amendment nennt jetzt auch die
aufgehobene `func`-Entscheidung und die Aufruferzahl; der Pin heißt hier
`…ArgsFuncTarget` (den `world`-Schlüssel besitzt `docs/48`); Kriterium 3 hängt
am Kanal (`tabs.channel.calls.length` ⇒ 0) und nennt die echte Zahl **23**.

## Log

- **2026-11-18, Messung:** `browser_eval` scheitert unter MV3 mit
  `call to Function() blocked by CSP` (zweimal reproduziert).
- **2026-11-18, Messung `world: "MAIN"`:** trägt in Firefox 152.0.3 — Details in
  `docs/48`.
- **2026-11-18, Teilung:** nach dem dritten Block in Vertrag/Harness (hier) und
  sichtbares Verhalten (`docs/48`).
