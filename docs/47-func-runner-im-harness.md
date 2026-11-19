---
description: Der Harness kann einen func in zwei Welten je Frame ausführen — testbare Infrastruktur, kein sichtbares Verhalten.
status: active
---

# Der Func-Runner im Harness

**Geteilte Hälfte.** Die Vorgängerspec hatte drei Blocker-Runden; nach
`CONTRIBUTING.md` Schritt 4 wird beim dritten Mal geteilt, nicht durchgewinkt.
Der Schnitt ist der des Reviewers (2026-11-19):

| Teil | Dokument |
|---|---|
| Func-Runner im Harness, Vereinigung am Schlüssel-Pin, ein neuer Fall | **hier** |
| Vertrag des `func`, Umzug, die 23 Kanal-Fälle, `docs/45`-Amendment | `docs/49-func-vertrag-und-umzug.md` |
| `world: "MAIN"`, CSP-Meldung, Optionsseite | `docs/48-eval-in-der-seitenwelt.md` |

Diese Hälfte ist bewusst klein: **eine** Stufe, **ein** neuer Fall, **kein**
Produktivcode. Sie hat einen Beweis, der nicht auf die anderen Hälften zeigt.

## Ziel

- **Der Harness kann einen `func` ausführen**, in **zwei Welten je Frame** —
  sonst ist der Vertrag aus `docs/49` nicht messbar.
- **Der Schlüssel-Pin prüft zwei Formen**, nicht eine: `{files, target}` bleibt
  für die 16 bestehenden Aufrufer gültig, `{args, func, target}` kommt für den
  einen `eval`-Aufruf dazu.
- **Kein Produktivcode ändert sich.** `extension/` bleibt in dieser Spec
  unangetastet; geändert wird nur `test/extension.test.js`.

## Die Naht im Harness

`inject()` (`test/extension.test.js:468-506`, der `return` steht auf `:505`)
prüft heute `Object.keys(details)` gegen `["files", "target"]` — für **jeden**
Aufruf. Es gibt **16** `askPageAgent`-Aufrufe in `extension/bridge.js`
(`:2165`, `:2214`, `:2809`, `:2994`, `:3127`, `:3180`, `:3313`, `:3597`,
`:4158`, `:4779`, `:4781`, `:4797`, `:4808`, `:4882`, `:4901`, `:4927`; der
17. Treffer ist die Definition auf `:2528`). Nach dieser Stufe schicken **alle 16** davon weiter `{files, target}`; eine
Ersetzung des Pins machte sie sofort rot.

Deshalb wird der Pin eine **Vereinigung**:

```
details.func === undefined ? ["files", "target"] : ["args", "func", "target"]
```

Der Zweig im Harness:

- `args` reist durch JSON — kein Closure, kein DOM.
- **`func` quert die Grenze als Quelltext**, nicht als Funktionswert: der Zweig
  materialisiert ihn im Seitenwelt-Kontext (`vm.runInContext("(" +
  func.toString() + ")", pageContext)`), ruft ihn dort mit den JSON-`args` auf
  und holt das `result` per JSON zurück. Ein direkter Aufruf des
  Funktionswerts liefe im Sandbox-Realm — der Fall wäre grün, ohne je zwei
  Welten zu zeigen.
- `func` läuft in einem **Seitenwelt-Realm**, getrennt vom isolierten Realm
  desselben Frames: zwei Kontexte, zwei `window`, ein gemeinsames DOM.
- **Die `files`-Zusicherung wandert in den `files`-Arm.** Heute steht
  `details.files === [PAGE_AGENT_FILE]` (`:477-481`) bedingungslos da und wäre im
  `func`-Arm `undefined` ⇒ rot; `runFileIn` gehört ebenfalls dorthin.
- Antwort: `[{frameId, result}]`, wie `executeScript` sie liefert.
- Der `func`-Arm pinnt **genau** `["args", "func", "target"]`. `world` kommt in
  `docs/48` dazu und weitet den Pin dort — hier steht er nicht.

## Non-goals

- **Kein `func` in der Brücke.** Den schickt erst `docs/49`.
- **Kein `world`-Schlüssel.** Den besitzt `docs/48`.
- **Kein neuer Produktivpfad, keine neue Datei in `extension/`.**

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `inject_withAFunc_shouldRunItInThePageWorldRealm` (**neu**) | der Zweig existiert, und die zwei Realms sind getrennt: der `func` sieht eine Seitenvariable, die isolierte Welt nicht |
| `test/extension.test.js` | `eval_withReturnDocumentTitle_shouldAnswerTheTitle` (bestehend) | die `files`-Form bleibt unberührt gültig — der Pin ist eine Vereinigung, keine Ersetzung |
| `test/extension.test.js` | alle Frame-Fälle (`:13750`, `:13778`, `:13798`, `:13824`) | die Suite bleibt grün, obwohl der Pin jetzt zwei Formen kennt |

## Acceptance criteria

**Alle vier entscheidet der Umsetzer**, ohne Browser.

1. **Der Zweig läuft.** `node --test --test-reporter=tap test/extension.test.js
   2>&1 | grep -cE '^ok [0-9]+ - inject_withAFunc_shouldRunItInThePageWorldRealm'`
   ⇒ **1**.
2. **Jede Welt sieht nur ihr Eigenes.** Derselbe Fall prüft beides: der `func` schreibt
   `window.__bcProbe` und liest sie zurück (Wert kommt an), die isolierte Welt
   liest `undefined`.
3. **Die Vereinigung trägt.** Alle **16** `files`-Aufrufer bleiben grün, und der
   `func`-Zweig ist grün — im selben Lauf: `npm test` ⇒ `# fail 0`,
   `# cancelled 0`. (Dass danach 15 + 1 gilt, ist `docs/49`.)
4. **Kein Produktivcode.** `git diff --stat extension/` ⇒ **leer**.
5. **Die Suite bleibt grün.** `npm run check` ⇒ 0.

## Dev plan

**Stufe 1 — der Func-Runner und die Vereinigung**

Dateien: **nur** `test/extension.test.js` — der `func`-Zweig in `inject()`, die
zwei Realms je Frame, die Vereinigung an `:471-473`, der neue Fall
`inject_withAFunc_shouldRunItInThePageWorldRealm`.

Beweis: Kriterien 1, 2, 3, 4, 5.

**Keine Stufe 2.** Was danach kommt, steht in `docs/49`.

## Bekannte Lücken

- **Der Zwei-Welten-Harness ist eine Attrappe.** Er trennt zwei Kontexte, aber
  nicht mit derselben Mechanik wie Firefox; dass die echte Grenze hält, zeigt
  erst `docs/48` am laufenden Browser.
- **Der `func`-Zweig ist nach dieser Stufe ungenutzt** — kein Produktivpfad
  schickt einen `func`. Das ist Absicht: der Zweig wird gebaut, bevor ihn
  jemand braucht, damit `docs/49` sich auf ihn stützen kann.

## Open questions

**Keine.**

## Review

### Runde 1 dieses Zuschnitts — steht aus

Die Block-Runden des Vorgängers stehen in der Git-Historie von
`docs/47-eval-vertrag.md` (`ab986b1` und davor); die Zählung beginnt mit dieser
geteilten Hälfte neu, weil ihr Umfang ein anderer ist.

## Log

- **2026-11-19, gebaut und gemessen:** der `func`-Zweig steht in `inject()`, der
  Pin ist die Vereinigung, `inject_withAFunc_shouldRunItInThePageWorldRealm` ist
  grün. Belege: `# tests 539, # fail 0, # cancelled 0, # skipped 0`;
  `npm run check` 0 (23 Dateien); `git diff --stat extension/` leer. Der Fall
  beweist beides: der `func` schreibt `globalThis.__bcProbe` und liest sie im
  nächsten Aufruf wieder (42), die isolierte Welt desselben Frames sieht
  `undefined`.
- **2026-11-19, Teilung:** dritter Block des geteilten `docs/47`; der Schnitt
  folgt dem Reviewer — Harness-Infrastruktur hier, Vertrag und Umzug in
  `docs/49`.
