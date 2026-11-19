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
| `limits` | `{ timeoutMs, messageLimit, resultLimit, valueLimit, classLimit }`. Alle fünf reisen mit, weil der `func` die Konstanten der Brücke nicht sieht. Werte: `timeoutMs` = 2 000 (`EVAL_TIMEOUT_MS`), `messageLimit` = 500 (`EVAL_MESSAGE_LIMIT`), `resultLimit` = 10 000 (`EVAL_RESULT_LIMIT`). `valueLimit` und `classLimit` sind die `inspect`-Grenzen, damit `selectorForElement` denselben Selektor baut wie heute |
| `want` | der Frame-Filter, **erste Anweisung** im `func` — sonst läuft er mit `allFrames` in jedem Frame |

**Rückgabe:** ein Objekt, dessen Felder am `outcome` hängen. `href` trägt
**jede** Antwort, weil `frameTargetOf` daraus die Kandidaten baut — ohne `href`
werden zwei werfende Frames zu `frame_ambiguous` mit `candidates: [null, null]`,
und `eval_withTwoFramesThatBothThrow_shouldAnswerFrameAmbiguousWithBothAddresses`
(`:13824`) fällt:

| `outcome` | Felder |
|---|---|
| `not_the_frame` | `outcome`, `href` |
| `ok` | `outcome`, `href`, `url`, `title`, `elapsedMs`, `json` |
| `threw` | `outcome`, `href`, `message` (`extension/page-agent.js:1563` liefert genau diese drei) |
| `timeout`, `too_large`, `unserializable` | `outcome`, `href` |

- `json` ist ein **JSON-String** (`evalResultOf` macht `JSON.parse(entry.json)`,
  `extension/bridge.js:3633`); seine Länge zählt gegen `resultLimit`.
- `message` ist der Fehlertext der Seite, gekürzt auf `messageLimit` — gepinnt
  von `eval_withAThrownMessageOf600Characters_shouldCutItAt500` (`:12372`).
- `undefined` ⇒ `null`, BigInt ⇒ String, Funktion ⇒ `"[function]"`, Symbol ⇒
  `"[symbol]"`, nicht serialisierbar ⇒ `unserializable`.

**Ein Promise als Rückgabe:** der `func` wartet in der Seitenwelt, nicht die
Brücke — er gibt erst das aufgelöste Ergebnis zurück. Dafür wird der Harness
aus `docs/47` um **ein** `await` je Frame erweitert (`runFuncIn` wartet auf den
Rückgabewert, bevor es ihn durch JSON schickt); das ist ein Amendment an
`docs/47`. Die Frist von 2 000 ms läuft dabei im `func` selbst, sodass ein
Promise, das zu spät auflöst, `timeout` liefert und nicht hängt. Gepinnt von
`eval_withAPromiseThatResolvesAfter50ms_shouldAnswerTheValue` (`:12234`) und
`eval_withAPromisePastTheDeadline_shouldAnswerEvalTimeout` (`:12256`).

**DOM-Ergebnisse haben einen Besitzer:** ein Element ⇒
`{ kind: "node", tag, selector }`; ein **Textknoten** ⇒
`{ kind: "node", nodeType: 3 }` — er trägt keinen Selektor und keinen Text, weil
er beides nicht hat (`extension/page-agent.js:1476-1479`, der Vertrag ab
`:1480`). Gebaut von **einem** Selektor-Bauer, der mit dem `func` reist
(`selectorForElement`, heute `extension/page-agent.js:1179`). Gepinnt von
`eval_withADomNodeResult_shouldAnswerTheSelectorOfThatElement` (`:12387`) und
`eval_withATextNodeResult_shouldAnswerKindNodeAndNodeType` (`:12407`).

## Die Zahlen

- **30** `eval_`-Fälle zählt `npm test` heute.
- **7** davon antworten, bevor injiziert wird: `:11877`, `:11898`, `:11916`,
  `:11932`, `:11952`, `:11967`, `:11991` — der Schalter aus, der Schalter als
  String `"true"`, der Code leer, die Grenzen des Argumentbaus.
  *(Zeilen nach `35be904`.)*
- **23** laufen über den Nachrichtenkanal. Nach Stufe 1 sind es **0** — sie
  brechen nicht „einer nach dem anderen", sondern im selben Schritt, in dem der
  `eval`-Op fällt. Deshalb ist die Umstellung **eine** Änderung, keine Reihe.
- **16** `askPageAgent`-Aufrufe hat `extension/bridge.js`. Der `eval`-Aufruf
  (`:3597`) ist **einer** davon: nach dem Umzug schicken **15** `{files, target}`
  und **einer** `{args, func, target}`. Die Zahl 16 in `docs/45` bleibt richtig,
  die Form ist es nicht mehr.

## Non-goals

- **Kein `world: "MAIN"`** — das ist `docs/48`.
- **Kein `'unsafe-eval'`**, keine Änderung an `bridge-rs`, kein neues Werkzeug.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `injection_forEval_shouldCarryArgsFuncTarget` (**neu**) | die Schlüssel sind genau `args`, `func`, `target`; den `world`-Schlüssel besitzt `docs/48` |
| `test/extension.test.js` | `eval_withReturnDocumentTitle_shouldAnswerTheTitle` (bestehend, umgestellt) | der Kanal wird nicht mehr benutzt: `tabs.channel.calls.length` ⇒ 0 |
| `test/extension.test.js` | `eval_withAThrownMessageOf600Characters_shouldCutItAt500` (`:12372`, bestehend) | `message` steht im Vertrag und ist gekürzt |
| `test/extension.test.js` | `eval_withADomNodeResult_shouldAnswerTheSelectorOfThatElement` (`:12387`) und `eval_withATextNodeResult_shouldAnswerKindNodeAndNodeType` (`:12407`) | DOM-Ergebnisse haben einen Besitzer |
| `test/extension.test.js` | `eval_withAResultOfExactlyTenThousandJsonCharacters_shouldAnswerOk` (`:12343`) und `eval_withAResultOfTenThousandAndOneJsonCharacters_shouldAnswerTooLarge` (`:12358`) | die Grenze gilt für `json` |
| `test/extension.test.js` | `eval_withFrame_shouldRunTheCodeInTheAddressedFrame` (`:13804`) | der Frame-Pin `:13823-13825` — die einzige Stelle, die `details` anfasst |
| `test/extension.test.js` | `eval_withAPromiseThatResolvesAfter50ms_shouldAnswerTheValue` (`:12234`) und `eval_withAPromisePastTheDeadline_shouldAnswerEvalTimeout` (`:12256`) | das Promise quert als aufgelöstes Ergebnis |
| `test/extension.test.js` | `eval_whenThePageNeverAnswers_shouldAnswerEvalTimeoutThroughTheGuard` (`:12274`) | siehe `## Bekannte Lücken` — der Fall sucht einen neuen Gegenstand |

## Acceptance criteria

**Kriterien 1–4 entscheidet der Umsetzer**, ohne Browser.

1. **Ein Serialisierer.** `grep -c 'function serialize' extension/page-agent.js`
   ⇒ **0**, in `extension/bridge.js` ⇒ **1**.
2. **Der Kanal ist frei.** In `eval_withReturnDocumentTitle_shouldAnswerTheTitle`
   ist `tabs.channel.calls.length` ⇒ **0**, und der Inject-Aufruf trägt `func`.
3. **Der Vertrag steht.** `injection_forEval_shouldCarryArgsFuncTarget` ⇒ grün;
   die Schlüssel sind **genau** `args`, `func`, `target`.
4. **Kein Frame-Verhalten geändert.** Die vier Frame-Fälle
   (`eval_withFrame_shouldRunTheCodeInTheAddressedFrame` `:13804`,
   `eval_withAFrameThatMatchesNoFrame_shouldAnswerFrameNotFound` `:13832`,
   `eval_withFrame_shouldNotRunTheCodeInTheUnaddressedFrame` `:13852`,
   `eval_withTwoFramesThatBothThrow_shouldAnswerFrameAmbiguousWithBothAddresses`
   `:13878`) ⇒ grün. **Nur `:13804` fasst `details` an** (`:13823` `files`,
   `:13824` die Kanalzeile `args.want`); die anderen drei beweisen das Verhalten.
   Beide Reparaturen fallen in **Stufe 1**, nicht in Stufe 2 — der Fall bricht
   sonst, bevor die Stufe ihn repariert.
5. **Die Suite bleibt grün.** `npm test` ⇒ `# fail 0`, `# cancelled 0`;
   `npm run check` ⇒ 0.

## Dev plan

**Stufe 1 — der `func` und der Umzug**

Dateien: `extension/bridge.js` (der eigenständige `func` mit Frame-Filter, den
fünf `limits`, Serialisierer, DOM-Formen; der Aufruf auf `:3597` schickt
`{args, func, target}`), `extension/page-agent.js` (`eval`-Op und `serialize`
löschen), `test/extension.test.js` (die 23 Kanal-Fälle auf den `func`-Zweig aus
`docs/47`).

Die Umstellung ist **ein** Schritt: der `eval`-Op fällt, und mit ihm alle 23
Fälle, die ihn verwenden.

Beweis: Kriterien 1, 2, 3, 4, 5 — die Reparatur der Frame-Assertions
(`:13823-13825`, `details.files` und die Kanalzeile `args.want`) gehört in diese
Stufe, weil der `eval`-Op hier fällt.

**Stufe 2 — die Doku**

Dateien: `docs/45-injection-naht.md` (datiertes Amendment),
`docs/PROJECT-STATE.md`, `docs/47-func-runner-im-harness.md` (Amendment: ein
`await` je Frame für ein Promise-Ergebnis).

Beweis: keiner in Code — die Suite aus Stufe 1 bleibt grün.

## Amendments to previous spec docs

| Dokument | Abschnitt | was gilt |
|---|---|---|
| `docs/45-injection-naht.md` | `## Die Naht` | `eval` antwortet nicht mehr über den Kanal: seine Antwort kommt mit dem `executeScript`-Promise, und einen „stummen Frame" gibt es dort nicht |
| `docs/45-injection-naht.md` | `## Bekannte Lücken` („`func` wurde verworfen") | für `eval` ist die Entscheidung **aufgehoben**: dort reist die Nutzlast als `func`. Der Grund bleibt für die anderen Werkzeuge gültig |
| `docs/45-injection-naht.md` | `## Testing` („16 Aufrufer gegen `{file}` plus Nachrichtenkanal") | nach Stufe 1: **16** Aufrufer, davon 15 gegen `{files, target}` und einer gegen `{args, func, target}`; kein Kanal |

## Bekannte Lücken

- **Der Wächter-Fall verliert seinen Gegenstand.**
  `eval_whenThePageNeverAnswers_shouldAnswerEvalTimeoutThroughTheGuard`
  (`:12274`) hängt an `silent`-Frames und den `INJECTION_REPLY_TIMEOUT_MS`-Timern
  des Kanals. Der `func`-Arm ignoriert `silent`, und einen Haken
  „`executeScript` antwortet nie" gibt es im Stub nicht (nur
  `refuseInjectionAfter`). Der Fall braucht in Stufe 1 **einen neuen
  Gegenstand**: der Stub bekommt `neverAnswer`, und der Fall prüft, dass die
  Frist der Brücke (`EVAL_GUARD_MS`) greift, wenn das Promise nie aufgelöst
  wird. Bis dahin ist die Wächter-Frist unbelegt.
- **`selectorForElement` reist als Kopie im `func`.** Eine echte
  Wiederverwendung ginge nur über eine injizierte Datei, und die kann keine
  Funktion zurückgeben.
- **Der `func` ist ein String.** Er kann nichts aus der Brücke mitnehmen; alles,
  was er braucht, steht in `args`.

## Open questions

**Keine.**

## Review

### Runde 1 dieses Zuschnitts — 2026-11-19, `grizzled-senior-dev`: 🔧

Vier Blocker: alle Testzeilen waren um 54 verrutscht (die Spec war gegen den
Baum **vor** `35be904` geschrieben, das den Harness-Fall einfügte), und Kriterium
4 zeigte damit auf einen Kommentar statt auf den Frame-Fall; ein Promise als
Rückgabe hatte keinen Transport (zwei Fälle hätten nie grün werden können);
Stufe 2 fasste Zeilen an, die Stufe 1 schon bricht; und der Wächter-Fall
`:12274` verlor mit dem Kanal seinen Gegenstand.

**Übernommen:** alle Zeilen gegen HEAD neu verankert (Zusatz „Zeilen nach
`35be904`"), der siebte Injection-Fall
(`eval_whenTheSwitchHoldsTheStringTrue_shouldRefuseWithoutInjecting`) ergänzt,
der Promise-Übergang in den Vertrag und als `docs/47`-Amendment aufgenommen,
die Reparatur der Frame-Assertions nach Stufe 1 gezogen, Stufe 2 auf die Doku
reduziert, Kriterium 4 auf „nur `:13804` fasst `details` an" korrigiert, der
Wächter-Fall mit `neverAnswer` als Lücke benannt, und `symbol ⇒ "[symbol]"`
steht im Vertrag.

Die Block-Runden des Vorgängers stehen in der Git-Historie
(`docs/47-eval-vertrag.md`, `ab986b1` und davor).

## Log

- **2026-11-19, Teilung:** dritter Block; Vertrag und Umzug hier, der
  Harness-Runner in `docs/47`.
