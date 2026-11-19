---
description: Im eval-Code ist await auf oberster Ebene erlaubt — der func baut den Code als Rumpf einer async-Funktion.
status: proposed
---

# `await` im `eval`-Code

Kleine Änderung an `docs/19-browser-eval.md`, gemessen am 2026-11-19 bei der
ersten echten Arbeit mit dem Werkzeug.

## Ziel

- **`await` auf oberster Ebene ist erlaubt.** Wer eine API der Seite abfragen
  will, schreibt:

  ```
  const r = await fetch("/web/api/…");
  return (await r.json()).slice(0, 5);
  ```

  und nicht mehr `return (async () => { … })()`.
- **Sonst ändert sich nichts.** Dieselben Felder, dieselben Fehlercodes,
  dieselben Grenzen, derselbe Schalter `allowEval`.
- **`return` bleibt Pflicht**, wenn ein Wert herauskommen soll.

## Warum

Der `func` baut den Code heute mit `new Function(code)()`. Das ist eine
**synchrone** Funktion, und `await` ist darin ein Syntaxfehler. Der Agent hört:

```
Der Code im Agenten-Tab ist gescheitert: await is only valid in async functions
and async generators and modules
```

Das ist am 2026-11-19 zweimal passiert, beide Male bei einem `fetch` gegen die
Seite selbst. Die Umhüllung `return (async () => { … })()` funktioniert, aber sie
ist eine Falle: der naheliegende Code scheitert, und die Fehlermeldung nennt eine
Regel, die der Aufrufer nicht kennt.

## Non-goals

- **Kein `await` in `read`, `click`, `type` oder `inspect`** — die nehmen keinen
  Code.
- **Keine Änderung an Fristen.** Weiterhin 2 000 ms im `func`, 2 500 ms Wächter in
  der Brücke (`docs/49`).
- **Kein automatisches Auflösen** von Promise-Ergebnissen über die Frist hinaus:
  ein Promise, das zu spät auflöst, bleibt `eval_timeout`.

## Die Änderung

```js
produced = await new (Object.getPrototypeOf(async function () {}).constructor)(code)();
```

Der Konstruktor der async-Funktion statt `Function`: derselbe Rumpf, dieselbe
Seitenwelt, aber `await` ist erlaubt. Ein Code **ohne** `await` verhält sich
identisch — die Funktion gibt dann ein Promise zurück, das sofort erfüllt ist,
und der bestehende `isThenable`-Zweig wartet darauf. Die Frist gilt damit auch
für Code, der gar nicht warten wollte: sie ist eine Obergrenze, keine Wartezeit.

## Risiken

| Risiko | Wirkung | Gegenmittel |
|---|---|---|
| Jeder Code wird zum Promise | `elapsedMs` könnte durch einen Microtask wachsen. Gemessen: 0–1 ms bei trivialem Code | Fall `eval_withReturnDocumentTitle…` pinnt den Wert nur auf `Number.isInteger`, nicht auf 0 |
| `await` in einer Seite ohne Promise | die Seite hat Promise | kein Fall, jede Seite hat `Promise` |
| Ein Fehler in einer async-Funktion wird zur Rejection statt zum Wurf | `catch` im `func` fängt beides, weil `await` die Rejection wirft | Fall `eval_whenTheCodeThrows…` bleibt unverändert |

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `eval_withTopLevelAwait_shouldAnswerTheResolvedValue` (**neu**) | `const v = await Promise.resolve(7); return v;` ⇒ `7` |
| `test/extension.test.js` | `eval_withTopLevelAwaitThatRejects_shouldAnswerEvalFailed` (**neu**) | eine abgelehnte Zusage wird `eval_failed` mit dem Text der Seite |
| `test/extension.test.js` | `eval_withAPromisePastTheDeadline_shouldAnswerEvalTimeout` (bestehend, `:12268`) | die Frist gilt weiter |
| `test/extension.test.js` | die 30 übrigen `eval_`-Fälle | nichts anderes ändert sich |

## Acceptance criteria

1. **`await` trägt.** `node --test --test-reporter=tap --test-name-pattern="eval_withTopLevelAwait" test/extension.test.js`
   ⇒ zwei `ok`, kein `not ok`.
2. **Die Frist bleibt.** `eval_withAPromisePastTheDeadline_shouldAnswerEvalTimeout`
   ⇒ grün.
3. **Sonst nichts.** `npm test` ⇒ `# fail 0`, `# cancelled 0`, `# skipped 0`;
   `npm run check` ⇒ 0.

## Dev plan

**Stufe 1 — der Konstruktor**

Dateien: `extension/bridge.js` (die Zeile `new Function(code)()` im `func`
`evalInPage`), `test/extension.test.js` (die zwei neuen Fälle).

Beweis: Kriterien 1–3. Kein Produktivpfad ändert seine Form, nur die Art, wie der
Code gebaut wird.

## Amendments to previous spec docs

| Dokument | Abschnitt | was gilt |
|---|---|---|
| `docs/19-browser-eval.md` | `## Extension` | der Code wird als Rumpf einer **async**-Funktion gebaut; `await` auf oberster Ebene ist erlaubt, `return` bleibt Pflicht; datiert nachgezogen |
| `docs/19-browser-eval.md` | `## Bekannte Lücken` | der Satz über `await` (falls vorhanden) entfällt |
| `docs/49-func-vertrag-und-umzug.md` | `## Der Vertrag` | der `func` baut den Code mit dem Konstruktor der async-Funktion; `isThenable`/`withinDeadline` bleiben unverändert |

## Bekannte Lücken

- **`await` in einem `for`-Ausdruck oder in einer Klasse** bleibt, was es ist:
  gültig, weil der Rumpf einer async-Funktion es erlaubt. Nichts zu tun.
- **Die Frist gilt auch für sofort erfüllte Promises.** Das kostet keinen
  Mikrotask mehr als heute, ist aber die eine Stelle, an der `elapsedMs` um 1 ms
  wandern kann.

## Open questions

**Keine.**

## Review

### Runde 1 — steht aus

## Log

- **2026-11-19, gemessen:** `await` auf oberster Ebene scheitert mit
  „await is only valid in async functions"; die Umhüllung
  `return (async () => { … })()` trägt, weil das Werkzeug ein Promise als
  Ergebnis annimmt. Zwei Fälle in der Sitzung.
