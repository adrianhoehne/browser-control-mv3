---
description: Ein Klick, dessen Anfrage keine Antwort bekommt, soll den eigenen Code click_outcome_unknown tragen statt not_readable — die Antwort sagt dann, dass der Klick durchgegangen sein kann, und der Agent prüft die Seite, bevor er erneut klickt.
status: proposed
---

# Ein Klick ohne Antwort sagt das

## Anlass

Zwei Stellen im heutigen Code lassen den Agenten den Klick wiederholen, obwohl er
schon gelaufen sein kann.

**Stelle 1 — die Anfrage bekommt keine Antwort.** `clickAgentTab` schickt den
Klick-Schnipsel und wartet. Bleibt die Antwort aus (Zeitüberschreitung, Kanal
gestört, Erweiterung neu gestartet), wirft der Aufruf einen Fehler ohne Auskunft
über den Klick. `clickErrorFor` fällt dann auf `readErrorFrame` zurück oder auf
`click_failed`. Der Agent liest „die Seite ist nicht lesbar" und klickt erneut.

**Stelle 2 — der Vorher-Fall ist benachbart.** Ist der Tab schon vor dem Klick
unlesbar (`about:config`, PDF, `view-source:`), bleibt es seit `docs/61` bei
`not_readable`. Dort ist die Aussage richtig: Es wurde nicht geklickt.

Die zwei Fälle sehen für den Agenten gleich aus, obwohl sie es nicht sind. Dass ein
Klick auf das falsche Ziel teuer ist, steht in `docs/ROADMAP.md` (magicline,
2026-10-23: `a[href*="termin"]` traf den Kündigungslink). Ein zweiter, unnötiger
Klick auf denselben Knopf ist die andere Hälfte desselben Risikos.

## Ziel

1. Eine Klick-Anfrage **ohne Antwort** antwortet mit dem neuen Code
   **`click_outcome_unknown`**.
2. Der englische Satz lautet, gepinnt in `extension/bridge.js` und in
   `bridge-rs/src/mcp/texts.rs`:

   ```
   The page gave no answer to the click request: it may have gone through. Check the page before you click again.
   ```

3. Der Fehler trägt `url` (die Adresse, unter der geklickt wurde) und **kein**
   `clicked` — die Beschreibung des Elements lag in der Antwort, die verloren ging.
   Der Satz wird **einzeilig** gepinnt, mit einem Leerzeichen zwischen den zwei Sätzen.
4. `not_readable` bleibt für den Vorher-Fall (`docs/61`), `read_failed` bleibt für
   eine unbrauchbare Antwort. Der neue Code ersetzt keinen der beiden.
5. **Kein Wiederholen im Werkzeug.** Die Extension versucht den Klick nicht erneut;
   sie sagt, was sie weiß, und lässt die Entscheidung beim Agenten.

## Der Vertrag

| Feld | Regel |
|---|---|
| Code | `click_outcome_unknown`, `isError: true` |
| Satz | der Wortlaut aus Ziel 2, englisch, gepinnte Konstante |
| Belegfelder | `url`; **kein** `clicked` |
| Abgrenzung | `not_readable` = nicht geklickt (Vorher-Fall), `not_readable_after_click` = geklickt, Seite danach unlesbar (`docs/61`), `read_failed` = Antwort unbrauchbar |
| `frame` | **nicht abgedeckt:** mit `frame` läuft die Injektion als Rundruf, der Stille-Zweig greift nicht, und der Agent liest weiter `frame_not_found` (`docs/26`). Siehe `## Bekannte Lücken` |
| `page_busy` / `no_agent_tab` | im Stille-Zweig gewinnt der neue Code: „versuch es erneut" ist beim Klick der falsche Rat (`docs/13`). Das ist eine Änderung an einer `active`-Zusage und steht darum hier |
| `CLICK_OUTCOMES` | **kein** Eintrag: der Code entsteht nach dem Klick, nicht als Ausgang des Schnipsels |

**Woher die Extension weiß, dass sie nichts weiß.** `clickAgentTab` kennt den
Fehler der Klick-Anfrage: Eine Zeitüberschreitung oder ein Kanalabbruch ist etwas
anderes als ein `not_readable` der Seite. Der neue Code gilt genau für die erste
Klasse. Ein Fall im Harness hält die Grenze fest: derselbe Tab, einmal mit
abgelehnter Injektion (bleibt `not_readable`), einmal mit einer Anfrage, die nie
antwortet (`click_outcome_unknown`).

## Non-goals

- **Kein Seiten-Marker.** Ein `globalThis`-Zähler im Schnipsel könnte später sagen,
  ob `element.click()` wirklich lief. Das wäre ein zweiter Weg in die Seite und ein
  eigener Anlass; diese Spec begnügt sich mit „kann durchgegangen sein".
- **Kein automatisches Wiederholen** und kein Rückzug des Klicks.
- **Keine Änderung an `read`, `type`, `inspect`.** Sie behalten ihre Codes.
- **Keine Änderung an `docs/61`.** Der Vorher-Fall bleibt, wie er ist.

## Amendments to previous spec docs

- **`docs/61-klick-seite-danach.md`**: die Abgrenzung kommt in die Vertragstabelle —
  `not_readable` gilt nur, wenn die Injektion abgelehnt wurde, nicht wenn die
  Anfrage ausblieb.
- **`docs/54-refusals-englisch.md`**: der neue Satz in der Textliste.

Nach der Umsetzung wird dieser Abschnitt entfernt.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `click_whenTheClickRequestNeverAnswers_shouldAnswerClickOutcomeUnknown` | der neue Code samt Satz und `url`; kein `clicked` |
| `test/extension.test.js` | `click_onATabThatIsUnreadableBeforeTheClick_shouldAnswerNotReadable` (bestehend, `:7753`) | die Grenze: abgelehnte Injektion bleibt `not_readable` |
| `test/extension.test.js` | `click_whenThePageCannotBeReadAfterTheClick_shouldAnswerNotReadableAfterClick` (bestehend, `:7674`) | `docs/61` bleibt unberührt; der Nachbar `…_shouldCarryTheAddressAndKind` (`:7722`) ebenfalls |
| `test/extension.test.js` | `click_whenTheReadAfterTheClickNeverAnswers_shouldAnswerNotReadableAfterClick` (neu) | die stille **Nachlese** nach einem belegten Klick bleibt bei `not_readable_after_click` — der Ausgang ist nicht unbekannt |
| `bridge-rs/tests/mcp.rs` | `click_withClickOutcomeUnknown_shouldNameTheUncertainty` | die Bridge bildet den Code auf den englischen Satz ab |
| `bridge-rs/tests/texts.rs` | `texts_shouldContainNoGermanUmlauts` | der Wächter aus `docs/54` deckt den neuen Satz |

## Acceptance criteria

1. **Die Anfrage ohne Antwort.** Der Fall
   `click_whenTheClickRequestNeverAnswers_shouldAnswerClickOutcomeUnknown` ⇒
   `click_outcome_unknown`, der Satz als Literal, `url` gesetzt, kein `clicked`.
   Beleg: `grep -cE '^ok [0-9]+ - click_whenTheClickRequestNeverAnswers_shouldAnswerClickOutcomeUnknown'`
   ⇒ 1 und `npm test` ⇒ 0 mit `^# fail 0` und `^# cancelled 0`.
2. **Die Grenze hält.** Die zwei bestehenden Fälle
   `click_onATabThatIsUnreadableBeforeTheClick_shouldAnswerNotReadable` (`:7753`) und
   `click_whenThePageCannotBeReadAfterTheClick_shouldAnswerNotReadableAfterClick`
   (`:7674`) antworten weiter mit `not_readable` bzw. `not_readable_after_click`. Beleg:
   je Name `grep -cE '^ok [0-9]+ - <name>'` ⇒ 1.
3. **Die Bridge kennt den Code.**
   `cargo test --manifest-path bridge-rs/Cargo.toml --test mcp
   click_withClickOutcomeUnknown_shouldNameTheUncertainty -- --exact` ⇒ die Zeile
   `test result: ok. 1 passed` (die Zeile zählt, nicht der Exit-Code).
4. **`CLICK_OUTCOMES` bleibt unverändert.** `grep -c 'click_outcome_unknown'
   extension/bridge.js` ⇒ **2**: die Code-Konstante und der Doc-Kommentar über der
   Satz-Konstante. Der Satz trägt keine Adresse, also gibt es keinen Bauer. Keine Zeile
   steht in `CLICK_OUTCOMES`.
5. **Alles andere grün.** `npm run check` ⇒ 0,
   `cargo test --manifest-path bridge-rs/Cargo.toml -- --test-threads=1` ⇒
   `test result: ok` mit `0 failed`, `bash scripts/parity.sh --impl rust --check` ⇒ 7/7.
6. **Live, Betreiber.** Auf einer Seite mit einem Formular: den Kanal stören
   (Erweiterung neu laden, während die Anfrage läuft) und `browser_click` aufrufen.
   Die Antwort nennt `click_outcome_unknown`, nicht `not_readable`.

## Dev plan

Verfasst von einem zweiten Autor (2026-11-23), geprüft gegen den Code.

1. **Stufe 1 — die Grenze in `extension/bridge.js`, mit ihren Fällen in `test/extension.test.js`.**

   **Die Grenze ist an keinem bestehenden Feld zu ziehen.** `askPageAgent` (`bridge.js:2573`)
   wirft für drei verschiedene Lagen denselben `ReadError`: (a) `injectScript` (`:2509`)
   lehnt die Datei ab — der Vorher-Fall aus `docs/61`; (b) `answers.some(answer => answer.ok
   === false)` (`:2593`) — die Seite hat geantwortet und ihren Op abgelehnt; (c)
   `answers.length === 0 && allFrames !== true` (`:2599`) — **keine Antwort** (Frist
   `PROTOCOL.INJECTION_REPLY_TIMEOUT_MS`, 5 000 ms, `protocol.js:58`; oder ein abgelehnter
   `sendMessage`, den `markSilent` als stumm einträgt, `:2584`). Alle drei laufen durch
   `unavailablePageError` (`:2530`) und tragen danach `not_readable`, `page_busy` oder
   `no_agent_tab`. „Keine Antwort" existiert nur im Zweig (c) und wird dort verworfen —
   also entsteht die Unterscheidung genau dort, nicht in `clickErrorFor`:

   - `unavailablePageError` (`:2530`) wird geteilt: `pageRefusalFor(tabId, { head })` baut
     den `ReadError` (der heutige Rumpf), `unavailablePageError` bleibt als
     `throw await pageRefusalFor(...)` für (a) und (b).
   - Neue Klasse `NoAnswerError extends ReadError` neben `ReadError` (`:1888`), die den
     gebauten `ReadError` nimmt und `code`, `message`, `details` unverändert übernimmt. (c)
     wirft `new NoAnswerError(await pageRefusalFor(tabId, { head }))`. `readErrorFrame`
     (`:1905`) bleibt unangetastet: der Rahmen ist für `read`, `type`, `inspect`, `frames`,
     `eval`, `screenshot`, `transcript` byte-gleich, nur der Klick liest die Klasse.
   - `clickErrorFor` (`:2832`): ein Arm **vor** `if (error instanceof ReadError)` (`:2842`):
     `if (error instanceof NoAnswerError && !clicked) return { code:
     CLICK_OUTCOME_UNKNOWN_CODE, message: CLICK_OUTCOME_UNKNOWN_MESSAGE, url:
     cappedAddress(url) };` — hinter diesem Arm stünde sonst die `not_readable`-Umbenennung
     aus `docs/61`. **Das `!clicked` ist Pflicht:** `askPageAgent` ist derselbe Einstieg für
     die Nachlese nach dem Klick, und dort ist `clicked` schon `true` — ohne das Prädikat
     bekäme die stille Nachlese „es kann durchgegangen sein", obwohl der Klick belegt ist
     (Code-Review 2026-11-23).
   - Konstanten: `CLICK_OUTCOME_UNKNOWN_CODE = "click_outcome_unknown"` neben
     `NOT_READABLE_AFTER_CLICK_CODE` (`:119`) — **ihr Doc-Kommentar nennt den Code nicht**,
     sonst zählt Kriterium 4 drei Literale statt zwei. Der Satz als gepinnte Konstante
     `CLICK_OUTCOME_UNKNOWN_MESSAGE` neben `CLICK_FAILED_MESSAGE` (`:317`), **eine Zeile**:
     `The click was sent, but the page gave no answer: it may have gone through. Check the`
     `page before you click again.` Der Doc-Kommentar darüber nennt den Code — das ist die
     zweite Zeile, die Kriterium 4 zählt (Vorbild `:2789`). **Kein** Bauer: der Satz trägt
     keine Adresse, anders als `notReadableAfterClickMessage` (`:2819`).
   - Die Adresse: `answerClick` (`:2793`) führt statt `const clicked = { done: false }`
     (`:2798`) die Box `const attempt = { done: false, url: "" }`; `clickAgentTab` (`:2932`)
     setzt hinter `const before = pageStateBeforeClick(tab)` (`:2939`) `attempt.url =
     before.url` — vor der ersten Injektion. Nötig, weil der `ReadError` aus (c) bei
     `no_agent_tab`/`page_busy` keine `details` hat; die Adresse ist die des Tabs *vor* dem
     Klick, also die, unter der geklickt wurde (`pageStateBeforeClick`, `:3199`).
     `clickErrorFor(error, { clicked: attempt.done, url: attempt.url })`; die Adresse geht
     durch `cappedAddress` (`:1953`, Deckel 2048, `null` bei leerer Adresse) — dieselbe
     Stelle, die `docs/61` und `read` benutzen. Keine eigene `=== ""`-Regel.
   - Kein Eintrag in `CLICK_OUTCOMES` (`:536`), kein Marker in `extension/page-agent.js`.
   - Der Doc-Kommentar von `unavailablePageError` (`:2528-2532`) nennt heute „a refused
     injection, and a call that no frame answered at all"; nach dem Split bleibt nur der
     erste Fall, der Kommentar wird mitgezogen.

   **Testinfrastruktur: kein neuer Stub nötig.** `createTabsStub` kann eine einzelne Op
   stumm stellen (`{ silent: true }`, `test/extension.test.js:594`); für `click` und `read`
   nutzt das noch kein Fall. Der neue Fall, eingefügt vor
   `click_withTwoOverlappingRequests_…` (`:7827`):
   - `click_whenTheClickRequestNeverAnswers_shouldAnswerClickOutcomeUnknown`:
     `createClickTabs({ page, answer: (m) => (m.op === "click" ? { silent: true } : undefined) })`,
     `sendClick`, dann `clock.runByDelay(INJECTION_REPLY_TIMEOUT_MS)` (`:85`, 5000). Erwartet:
     Code, der Satz **als Literal** (wie `:7700` es für `not_readable_after_click` tut),
     `url === "https://before.example/"` (Tab-Adresse, `createAgentTabFixture:2359`),
     `"clicked" in answer.error === false`, `tabs.scriptCalls.length === 1` (kein settle,
     kein read), `channel.ops()` ⇒ `["click"]`.
   - Der zweite neue Fall `click_whenTheReadAfterTheClickNeverAnswers_shouldAnswerNotReadableAfterClick`
     stellt die `read`-Op stumm (`{ silent: true }`) und erwartet
     `not_readable_after_click` samt `url` — der Klick ist belegt, also ist der Ausgang
     nicht unbekannt.

   Unverändert bleiben die zwei Grenzfälle:
   `click_onATabThatIsUnreadableBeforeTheClick_shouldAnswerNotReadable` (`:7753`, abgelehnte
   Injektion, `channel.ops()` ⇒ `[]`) und
   `click_whenThePageCannotBeReadAfterTheClick_shouldAnswerNotReadableAfterClick` (`:7674`,
   `refuseInjectionAfter: 2`). Der neue Fall wird ab `:7831` eingefügt.

   Proof: `npm test 2>&1 | grep -cE '^ok [0-9]+ - click_whenTheClickRequestNeverAnswers_shouldAnswerClickOutcomeUnknown'`
   ⇒ 1, dasselbe für `click_onATabThatIsUnreadableBeforeTheClick_shouldAnswerNotReadable` und
   `click_whenThePageCannotBeReadAfterTheClick_shouldAnswerNotReadableAfterClick`;
   `grep -cE '^# (fail 0|cancelled 0)'` ⇒ 2. Gegenprobe, dass die Klasse nicht leckt:
   `injection_whenAFrameStaysSilent_shouldRejectAtTheDeadline` (`:18230`) und
   `injection_whenSendMessageIsRejected_shouldAnswerNotReadable` (`:18252`) bleiben grün.

2. **Stufe 2 — die Bridge kennt den Code** (`bridge-rs/`).

   - `src/mcp/texts.rs`: `pub const CLICK_OUTCOME_UNKNOWN: &str` neben
     `NOT_READABLE_AFTER_CLICK` (`:63`), derselbe Satz, umlautfrei.
   - `src/mcp/failure.rs`: `const CLICK_OUTCOME_UNKNOWN_CODE: &str = "click_outcome_unknown";`
     neben `NOT_READABLE_AFTER_CLICK_CODE` (`:32`); im `tools::BROWSER_CLICK`-Zweig (`:142`)
     ein Arm hinter `not_readable_after_click` (`:167`) und **vor** `page_failure_text`
     (`:170`), der `texts::CLICK_OUTCOME_UNKNOWN` ohne `details` zurückgibt — der Satz nennt
     keine Adresse (bewusst anders als `not_readable_after_click_text`, `:370`).
   - `tests/mcp.rs`: `const CLICK_OUTCOME_UNKNOWN_TEXT` neben `NOT_READABLE_AFTER_CLICK_TEXT`
     (`:744`) und der Fall `click_withClickOutcomeUnknown_shouldNameTheUncertainty` direkt
     hinter `click_withNotReadableAfterClick_shouldNameTheReturnPath` (`:2604`) — ohne
     `mcp_`-Präfix, weil Kriterium 3 mit `--exact` filtert (Grund wie `:2575`). Er schickt
     `error_frame_with("click_outcome_unknown", json!({ "url": "https://example.org/" }))`,
     prüft `text_of(&answer) == CLICK_OUTCOME_UNKNOWN_TEXT` und ein `assert_ne!` gegen
     `call_extension_failed("click_outcome_unknown")` — die Sonde gegen den Rückfall, wie
     `:2634` sie für `not_readable` führt.

   Proof: `cargo test --manifest-path bridge-rs/Cargo.toml --test mcp
   click_withClickOutcomeUnknown_shouldNameTheUncertainty -- --exact` ⇒ die Zeile `test
   result: ok. 1 passed` (die Zeile zählt, nicht der Exit-Code); `--test texts` ⇒ `test
   result: ok. 1 passed`.

   **Parity: kein eingefrorenes Artefakt ist betroffen.** `scripts/parity/expected/2-tools.txt`
   trägt `# cases=39` und keinen Seitencode; `scripts/parity/requests/2-refusal.jsonl`
   schickt nur Argument-Ablehnungen; keine `.jsonl` ruft `browser_help`. Der Nachweis:
   `grep -rn 'click_outcome_unknown\|not_readable' scripts/parity/expected/` bleibt leer.
   `--check` ⇒ 7/7 wie heute, ohne eine geänderte Zeile.

3. **Stufe 3 — Anleitung und Doku.**

   - `bridge-rs/src/mcp/help.rs`, `## Pitfalls` von `CLICK` (`:101`), hinter dem
     `not_readable_after_click`-Satz: „A click whose request gets no answer from the page
     answers `click_outcome_unknown`: it may have gone through. Check the page before you
     click again." Der Umlaut-Wächter deckt `help.rs`; kein Fall pinnt die Anleitung
     byteweise (`help_forEveryTool_shouldAnswerWithTheSixSections`, `tests/mcp.rs:4678`,
     prüft nur die sechs Abschnitte).
   - `docs/06-klicken.md`: eine Aufzählungszeile in der Code-Liste (`:114-124`), hinter
     `not_readable_after_click`; die `Zeitüberschreitung`-Zeile (`:121`) meint die Frist des
     ganzen Aufrufs und bleibt.
   - `docs/54-refusals-englisch.md`: ein Absatz „Nachgezogen nach `docs/63`" hinter dem
     `docs/61`-Absatz (`:101-104`), die Fallzahl und die Zeile `51 Texte` (`docs/54:16`) auf
     die gemessene Zahl — `grep -cE '^pub (const|fn)' bridge-rs/src/mcp/texts.rs` zählt
     heute 57, nach dem neuen `pub const` 58.
   - `docs/61-klick-seite-danach.md`, Vertragstabelle (`:51-57`): eine Zeile „keine Antwort
     ⇒ `click_outcome_unknown` (`docs/63`)" neben „vor dem Klick unlesbar".
   - `docs/README.md` (die Zeile `63-klick-ohne-antwort.md`), `docs/PROJECT-STATE.md`; der
     Abschnitt `## Amendments to previous spec docs` entfällt.
   - **`status: active` erst, wenn `## Open questions` leer ist** — `docs/README.md` lässt
     kein `active` mit offener Frage zu, und dort stehen zwei. Bis der Betreiber sie
     beantwortet, endet die Stufe mit `proposed`.

   Proof: `npm run check; echo $?` ⇒ 0; `grep -n '63-klick-ohne-antwort' docs/README.md`
   zeigt die Zeile mit `active` (bzw. `proposed`, siehe oben); `bash scripts/parity.sh
   --impl rust --check; echo $?` ⇒ 0 mit 7/7.

### Was schiefgehen kann

- **Grenze am falschen Ort.** Wer sie an `error.code` zieht (`if (code === NOT_READABLE_CODE
  && !clicked)`), nimmt den Vorher-Fall mit — genau das, was Kriterium 2 bestraft.
  `NoAnswerError` darf nur in `askPageAgent`s drittem Zweig (`:2599`) entstehen.
- **`frame` bleibt draußen.** Mit `frame` läuft die Injektion als Rundruf
  (`allFrames: true`), der Stille-Zweig greift nicht; `frameTargetOf([], want)` (`:2129`)
  wirft `FrameError(frame_not_found)`. Ein stummer Frame-Klick sagt weiter „check the
  addresses" und lädt zum Wiederholen ein — bewusst nicht in diesem Inkrement.
- **`about:`-Adresse.** `pageStateBeforeClick` (`:3199`) liefert dort `""`; ohne
  `cappedAddress` stünde ein leerer String im Feld, statt `null` wie in jedem anderen
  Fehlerrahmen.
- **Zwei Sätze, zwei Räte.** Der neue Satz darf `browser_navigate` nicht nennen, und der
  `not_readable_after_click`-Satz wird nicht angefasst (`docs/61`).
- **Der Satz ist eine Zeile.** In `texts.rs` und `bridge.js` steht er als eine Zeile mit
  einem Leerzeichen zwischen den Sätzen — ein Zeilenumbruch bräche den gepinnten Vergleich
  in `tests/mcp.rs`.
- **Kriterium 4 zählt Literale.** Eine dritte Zeile (etwa `code: "click_outcome_unknown"`
  direkt) macht aus der erwarteten 2 eine 3; die zweite Zeile ist der Doc-Kommentar über
  der Satz-Konstante.

### Reihenfolge und Abhängigkeiten

- Stufe 1 und 2 sind technisch unabhängig (Stufe 2 prüft mit einer Fake-Extension), aber
  ohne Stufe 1 käme der Code nie über den Draht: 1 vor 2.
- Stufe 3 zuletzt — sie beschreibt gebauten Zustand („keine Spec beschreibt Verhalten, das
  es noch nicht gibt", `docs/README.md`).
- Innerhalb Stufe 1 ist die Reihenfolge frei; ein Zwischenstand mit fehlender
  Testerwartung ist kein Stufenende. Keine Stufe hängt an einer späteren.

### Was der nächste Inkrement erbt

- **Stille in einem adressierten Frame** bleibt `frame_not_found` (`docs/26`);
  `type`, `inspect`, `eval`, `screenshot`, `transcript` behalten bei Stille ihre Codes —
  `NoAnswerError` wird nur im Klick gelesen.
- **Die stille Lese-Injektion nach dem Klick** bleibt `not_readable_after_click`: Der Klick
  ist belegt, also ist der Ausgang nicht unbekannt (Entscheidung 2026-11-23, siehe `## Log`).
- **Kein Seiten-Marker** (Non-goal): aus „kann durchgegangen sein" wird kein „ist
  durchgegangen"; `## Bekannte Lücken` und `## Open questions` 1 bleiben.
- **Drei Codes, drei Stellen** — Injektion abgelehnt, Antwort abgelehnt, Antwort
  ausgeblieben. Eine spätere Spec, die `click` in Frames oder die Stille von `type` anfasst,
  muss diese Grenze mitziehen.
## Touch boundary

| erlaubt | nicht |
|---|---|
| `extension/bridge.js` (Klick-Pfad, Konstanten) | `extension/page-agent.js` — kein Seiten-Marker |
| `test/extension.test.js` (der neue Fall und die zwei Grenzfälle) | `docs/56`, `docs/60` — sie bleiben, wie sie sind |
| `bridge-rs/src/mcp/failure.rs`, `texts.rs`, `help.rs`, `bridge-rs/tests/mcp.rs`, `texts.rs` | `bridge-rs/src/hub.rs`, `protocol.rs`, `scripts/parity/**` |
| `docs/06`, `docs/54`, `docs/61`, `docs/README.md`, `docs/PROJECT-STATE.md` | `docs/09`, `docs/57`, `docs/58`, `docs/62` |

## Bekannte Lücken

- **Die Antwort bleibt eine Vermutung.** Ohne Seiten-Marker kann die Extension nicht
  sagen, ob `element.click()` lief; sie sagt „kann durchgegangen sein". Das ist die
  ehrliche Form, aber sie kostet den Agenten einen Prüfschritt (2026-11-23).
- **Der Satz nennt keinen nächsten Werkzeugaufruf.** „Check the page" ist Absicht:
  `browser_read` ist der übliche Weg, aber nicht der einzige (2026-11-23).
- **Ein Kanalabbruch mitten in der Antwort** ist von einer Zeitüberschreitung nicht
  zu unterscheiden. Beide bekommen denselben Code (2026-11-23). Dasselbe gilt für einen
  abgelehnten `sendMessage` („Receiving end does not exist", `bridge.js:2585`) und für eine
  Injektion, die keinen Frame erreicht (`createReplyCollection`, `:2457`): Der Klick kann
  ausgeliefert worden sein oder nicht — der Satz sagt darum „may have gone through".
- **Ein stummer Klick in einem adressierten `frame`** bekommt den neuen Code nicht: Der
  Rundruf (`allFrames: true`) schaltet den Stille-Zweig ab, der Agent liest
  `frame_not_found` (`docs/26`) (2026-11-23).

## Open questions

1. **Soll der Seiten-Marker doch kommen?** Ein Zähler in `globalThis`, den der
   Schnipsel vor `element.click()` setzt, würde aus „kann" ein „ist" machen. Preis:
   ein zweiter Weg in die Seite und eine neue Op. Der Betreiber entscheidet.
2. **Soll der Satz `browser_read` ausdrücklich nennen** statt „check the page"? Der
   Rat wäre konkreter, aber er setzt voraus, dass die Seite lesbar ist — und das
   weiß die Extension gerade nicht.

## Review

### Runde 1 — steht aus

Nach `CONTRIBUTING.md`, Schritt 4, öffnet erst ein `✅ Ship it` die Umsetzung.

## Log

- **2026-11-23, angelegt.** Aus dem Befund des Code-Reviews zu `docs/61`: „Lief der
  Klick, ging aber seine Antwort verloren, bleibt es bei `not_readable` — das ist
  die eine verbleibende Stelle, an der ein Agent den Klick wiederholt." Der
  Betreiber hat den eigenen Code dafür gewählt.

- **2026-11-23, vier Befunde des zweiten Autors eingearbeitet.** Die Testing-Tabelle
  nannte zwei Fallnamen, die es nicht gibt (`click_onATabThatIsUnreadableBeforeTheClick…`
  heißt `…_shouldAnswerNotReadable`, der Nachbar `…_shouldCarryTheAddressAndKind`).
  Kriterium 4 zählt zwei Literale, nicht „Konstante und Bauer" — der Satz trägt keine
  Adresse. Ziel 2 sagt, dass der Satz einzeilig gepinnt wird. Stufe 3 endet mit
  `proposed`, solange die zwei offenen Fragen stehen (`docs/README.md`).
  **Abgelehnt:** der Plan wollte auch die stille Lese-Injektion **nach** dem Klick auf
  `click_outcome_unknown` ziehen. Dort ist der Klick belegt, also ist der Ausgang nicht
  unbekannt; `not_readable_after_click` bleibt richtig.

- **2026-11-23, Spec-Gate Runde 1 eingearbeitet.** Neun Befunde, alle übernommen:
  der `NoAnswerError`-Arm braucht `&& !clicked` (sonst bekäme die stille Nachlese
  „es kann durchgegangen sein", obwohl der Klick belegt ist); dafür kommt ein
  eigener Fall `click_whenTheReadAfterTheClickNeverAnswers_shouldAnswerNotReadableAfterClick`.
  Die Adresse geht durch `cappedAddress` statt durch eine eigene Regel. Der Vertrag
  nennt die Grenzen: `frame` ist nicht abgedeckt, `page_busy`/`no_agent_tab` im
  Stille-Zweig gewinnen den neuen Code. Kriterium 1 belegt sich über den Fallnamen,
  Kriterium 5 zählt mit `--manifest-path` und `--test-threads=1`. Der Satz heißt
  jetzt „The page gave no answer to the click request: it may have gone through." —
  bei einem abgelehnten `sendMessage` war „was sent" nicht wahr. Dazu vier
  Zeilenangaben, die `docs/54`-Textzahl (58 statt 51) und zwei Begründungen.
  **Runde 2 steht aus.**
