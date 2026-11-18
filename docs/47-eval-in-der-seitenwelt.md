---
description: browser_eval zieht in die Seitenwelt, weil die MV3-CSP keinen Function-Aufruf in der isolierten Welt erlaubt; allowEval bleibt der Schalter.
status: proposed
---

# `browser_eval` in der Seitenwelt

Seit dem MV3-Umbau (`docs/43`) antwortet `browser_eval` mit

> Der Code im Agenten-Tab ist gescheitert: call to Function() blocked by CSP

und im Journal steht `eval failed peer=… code=eval_failed`. Gemessen am
2026-11-18 an `https://example.com/`, zweimal reproduziert.

**Ursache, und sie ist keine Kleinigkeit:** unter MV2 schickte die Erweiterung
**Quelltext** an `tabs.executeScript({code})`; die Seite führte ihn aus, und dort
galt die CSP der Seite. Unter MV3 injizieren wir eine **Datei**, ihr Code lebt in
der isolierten Welt der Erweiterung, und dort gilt unsere CSP
(`script-src 'self'`). `new Function(...)` ist damit gesperrt.
`'unsafe-eval'` dürfen wir nicht eintragen — MV3 verbietet es, Firefox lehnt das
Manifest ab.

**Der Betreiber hat die Verwendung benannt** (2026-11-18): Hotels suchen, Preise
vergleichen, Artikel in den Warenkorb legen, als Nächstes YouTube-Transkripte.
Das ist freier Code, keine Wertabfrage. Eine Ausdrucks-Teilmenge hilft nicht:
**jeder** ausgewertete Ausdruck braucht `Function`, auch `document.title`. (Den
Titel liefert `read` ohne Auswertung — das ist der Unterschied zwischen „lesen"
und „auswerten".)

## Ziel

- **`browser_eval` arbeitet wieder**, mit demselben Vertrag wie bisher:
  `code` hinein, Ergebnis heraus, `elapsedMs`, `undefined` wenn der Ausdruck
  nichts liefert, benannte Fehlercodes.
- **Der Code läuft in der Seitenwelt** (`world: "MAIN"`), weil dort die CSP der
  Seite gilt und nicht unsere.
- **Der Schalter `allowEval` bleibt Pflicht.** Ohne ihn antwortet das Werkzeug
  wie bisher mit der Aufforderung, die Code-Auswertung zu erlauben.
- **Ein CSP-Verbot der Seite wird erklärt**, nicht verschluckt: deutsche
  Meldung, die den Schalter und die Alternative (`read`, `inspect`) nennt.
- **Alles andere bleibt in der isolierten Welt.** `read`, `inspect`, `click`,
  `type`, `frames`, `transcript` sehen weiterhin keine Seitenvariablen.

## Non-goals

- **Kein `'unsafe-eval'` in der CSP.** MV3 verbietet es; ein Versuch wäre ein
  Manifest, das Firefox nicht lädt.
- **Keine Änderung an `read`, `inspect`, `click`, `type`.**
- **Kein neues Werkzeug, keine neuen Argumente.**
- **Keine Änderung an der Bridge** und am Protokoll.
- **Kein Entfernen des Schalters.** Er ist die Grenze zwischen „Werkzeuge dürfen
  die Seite bedienen" und „der Agent darf beliebigen Code ausführen".

## Die Sicherheitsfolge, ehrlich

Mit `world: "MAIN"` sieht der ausgewertete Code **Seitenvariablen**
(`window.*`, globale Objekte der Seite). Das war in `docs/25` bewusst
ausgeschlossen: die isolierte Welt war die Grenze, damit ein Agent nicht an
Sitzungsdaten der Seite kommt.

Was sich dadurch ändert und was nicht:

| | vorher (MV2) | nachher (MV3, Seitenwelt) |
|---|---|---|
| DOM-Zugriff | ja | ja |
| Seitenvariablen (`window.x`) | **nein** | **ja** |
| Schalter nötig | `allowEval` | `allowEval` (unverändert) |
| gilt für andere Werkzeuge | nein | nein |

Der Schalter ist die Zustimmung des Betreibers. Sie wird mit dieser Spec
**weiter gefasst als gedacht**: er erlaubt künftig auch den Blick auf
Seitenvariablen. Das steht so in der Optionsseite und in `README.md`.

## Der Weg in die Seitenwelt

**Erste Wahl:** `browser.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args: [code, limits] })`.
Der Code wird als Argument übergeben und im Seitenkontext ausgewertet.
**In die Seitenwelt geht nur diese eine Nutzlast** — `page-agent.js` bleibt in
der isolierten Welt, denn es spricht `browser.runtime` an, und `browser` gibt es
in der Seitenwelt nicht. Die Zielversion ist 152 (gemessen in `docs/02`).

**Gemessen am 2026-11-18 (Firefox 152.0.3, headless, Wegwerf-Extension in
`/tmp`): der Parameter trägt.**

```
STEP1 world-MAIN accepted. result = [{"frameId":0,"result":"Example Domain"}]
STEP2 page variable survives = [{"frameId":0,"result":42}]
STEP3 isolated world sees __bcProbe as = [{"frameId":0,"result":"undefined"}]
STEP4 github eval result = [{"frameId":0,"result":"caught: EvalError: call to eval() blocked by CSP"}]
```

Vier Dinge folgen daraus:

- `executeScript({ world: "MAIN", func })` liefert den normalen Vertrag
  (`frameId`, `result`).
- Eine Seitenvariable (`window.__bcProbe = 42`) **überlebt** zwischen zwei
  Aufrufen, und die isolierte Welt sieht sie nicht — die Kontrolle beweist, dass
  die Grenze wirklich verschoben und nicht nur behauptet wird.
- Die Injektion selbst überlebt eine strenge CSP (GitHub antwortet). Blockiert
  wird erst ein **ausdrückliches** `eval`/`Function` im ausgewerteten Code.
- Der Fehlertext heißt dort **`call to eval() blocked by CSP`**, nicht
  `Function()`. Die Fehlererkennung darf sich also nicht auf ein Wort
  festnageln.

**Die zweite Wahl wird damit nicht gebraucht** — sie bleibt als Notiz stehen,
falls ein künftiges Firefox den Parameter wieder fallen lässt.

**Zweite Wahl, falls `world` nicht greift:** ein `<script>`-Element mit dem Code
als Text in die Seite hängen und das Ergebnis über eine globale Variable und ein
`CustomEvent` zurückholen. Nachteil: Seiten mit `script-src` ohne `'unsafe-inline'`
blockieren es, also dieselbe Grenze wie bei `eval` in der Seitenwelt auch.

**Was in keinem Fall geht:** die Auswertung in der isolierten Welt. Dort bleibt
`Function` gesperrt.

**Der Antwortvertrag bleibt derselbe, und er bekommt einen Besitzer:** das
`func` serialisiert sein Ergebnis **im Seitenkontext** mit denselben Regeln und
Grenzen, die heute in `page-agent.js` gelten (`EVAL_RESULT_LIMIT` = 10 000
Zeichen, `undefined` ⇒ `null`, BigInt ⇒ String, Funktion ⇒ `"[function]"`,
nicht serialisierbar ⇒ `eval_result_unserializable`). Es gibt genau **eine**
Zeile zurück (einen String), und die Brücke prüft ihre Grenzen wie bisher. Was
die Seitenwelt nicht kann, ist ein Wert, den der Structured Clone nicht trägt —
deshalb reist ein String, kein Objekt.

## Fehlerpfade

| Fall | Antwort |
|---|---|
| `allowEval` aus | „Code-Auswertung ist nicht erlaubt …" (wie heute) |
| Seite verbietet Skript (CSP) | „Die Seite verbietet eigenes Skript (CSP) — Werte lassen sich mit `read` oder `inspect` holen." |
| Code wirft | `eval_failed` mit dem Fehlertext der Seite |
| Code liefert nichts | `undefined`, kein Fehler |
| Frist | `EVAL_TIMEOUT_MS` (2 000 ms, `extension/bridge.js:385`), Wächter `EVAL_GUARD_MS` (2 500 ms); Antwort `eval_timeout` |
| Ergebnis zu groß | `eval_result_too_large` (Grenze `EVAL_RESULT_LIMIT` = 10 000) |
| Ergebnis nicht serialisierbar | `eval_result_unserializable` |

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `eval_inThePageWorld_shouldSeePageVariables` | die Seitenwelt ist erreicht (`window.__bcProbe` gesetzt und gelesen) |
| `test/extension.test.js` | `eval_withoutTheSwitch_shouldRefuse` | `allowEval` bleibt Pflicht |
| `test/extension.test.js` | `eval_whenThePageForbidsScript_shouldNameTheCsp` | der CSP-Fall ist ein benannter Fehler mit deutschem Satz |
| `test/extension.test.js` | `eval_returningNothing_shouldAnswerUndefined` | `undefined` statt Fehler |
| `test/extension.test.js` | `eval_shouldReportElapsedMs` | `elapsedMs` bleibt im Vertrag |
| `test/manifest.test.js` | `manifest_shouldNotAllowUnsafeEval` | die CSP enthält **kein** `'unsafe-eval'` — die Grenze bleibt gesetzt |

## Acceptance criteria

**Kriterien 1–4 entscheidet der Umsetzer, 5–6 der Betreiber.**

1. **`eval` liefert wieder Werte.** Über MCP auf `https://example.com/`:
   `browser_eval` mit `document.querySelectorAll("p").length` ⇒ **1**
   (gemessen am 2026-11-18: die Seite hat genau einen Absatz), kein
   `eval_failed`.
2. **Seitenvariablen sind sichtbar.** Zwei Aufrufe hintereinander:
   `browser_eval` mit `window.__bcProbe = 42` setzt die Variable, ein zweiter
   Aufruf mit `window.__bcProbe` liest **42** zurück. Dass sie den zweiten
   Aufruf überlebt, ist der Beweis für die Seitenwelt — in der isolierten Welt
   wäre sie weg.
3. **Der Schalter wirkt.** Mit ausgeschaltetem `allowEval` antwortet dasselbe
   Kommando mit der Erlaubnis-Aufforderung, nicht mit einem CSP-Fehler.
4. **Die CSP bleibt clean.** `node -e "const m=require('./extension/manifest.json');
   console.log(m.content_security_policy.extension_pages.includes('unsafe-eval'))"`
   ⇒ `false`.

4b. **Alles andere bleibt isoliert.** Auf derselben Seite, auf der `eval`
    `window.__bcProbe` sieht: `browser_inspect` mit `selector: "html"` liefert
    ein Element ohne `__bcProbe`, und `browser_read` liefert Text — keiner der
    beiden Wege sieht Seitenvariablen (`injection_`-Fall im Harness: der
    `page-agent.js`-Kontext bekommt sie nicht).
5. **Der CSP-Fall kommt erklärt.** (Betreiber.) Auf einer Seite mit strenger CSP
   (z. B. `https://github.com/`) ⇒ Meldung, die „CSP" und die Alternative nennt;
   `read` auf derselben Seite funktioniert weiter. Der Fehlertext der Seite ist
   **`call to eval() blocked by CSP`** (gemessen) — die Erkennung prüft auf
   „CSP", nicht auf das Wort `Function`.
6. **Die alten Fälle bleiben grün.** `npm test` ⇒ `# fail 0`; die
   `eval_`-Fälle von vor dem Umbau sind unverändert grün, `read`/`inspect`/
   `click`/`type` unberührt.

## Dev plan

**Stufe 0 — messen, ob `world: "MAIN"` trägt** *(erledigt 2026-11-18, Ergebnis
oben: der Parameter trägt)*

Dateien: keine im Baum. Das Messinstrument ist eine **Kopie außerhalb des
Repos** (`/tmp`): extension/ kopieren, `bridge.js` dort um den `world`-Parameter
ergänzen, Test-Kopie über `web-ext` starten, gegen einen eigenen
Bridge-Prozess auf freien Ports. Wer misst: der Umsetzer; der Betreiber sieht
das Ergebnis.

Gemessen wird auf einer Seite **ohne** CSP (`example.com`) und einer **mit**
strenger CSP (`github.com`): ersteres muss einen Wert liefern, letzteres den
CSP-Fehler der Seite. Wird `world` gar nicht akzeptiert, ist die zweite Wahl aus
`## Der Weg in die Seitenwelt` dran; das Ergebnis wird in diese Spec eingetragen.

Beweis: zwei Ausgaben, eine mit Wert, eine mit dem CSP-Fehler der Seite.

**Stufe 1 — `eval` umstellen**

Dateien: `extension/page-agent.js` (der `eval`-Op), `extension/bridge.js`
(der Aufruf mit `world`), `test/extension.test.js`.

Beweis: Kriterien 1, 2, 3, 4 und die sechs Testfälle.

**Stufe 2 — Doku**

Dateien: `extension/options.html` und `extension/options.js` (der Hinweis am
`allowEval`-Schalter sagt künftig, dass der Code auch Seitenvariablen sieht;
`test/manifest.test.js` pinnt diesen Text auf das Wort „Passwortfelder" — es
bleibt im neuen Text stehen), `docs/25`, `docs/19`, `docs/45` (Amendments),
`README.md` (nur falls `docs/46` die Tabelle schon angelegt hat), `CHANGELOG.md`,
`docs/PROJECT-STATE.md`, `docs/47` auf `active`.

Beweis: Kriterien 5, 6.

## Amendments to previous spec docs

| Dokument | Abschnitt | was gilt |
|---|---|---|
| `docs/25-frame-handeln.md` (führt `browser_eval` mit `frame` ein) | `## Ziel`, `## Bekannte Lücken` | „läuft in der isolierten Welt" ist **überholt**. Neu: es läuft in der Seitenwelt, weil MV3 es anders nicht zulässt; der Schalter ist die Zustimmung |
| `docs/19-*.md` (führt die `eval`-Fehlercodes) | Fehlertabelle | `eval_timeout`, `eval_result_too_large`, `eval_result_unserializable` bekommen den neuen Weg; die Sätze bleiben |
| `docs/45-injection-naht.md` | `## Ziel` („kein Quelltext mehr") | gilt weiter für alle Werkzeuge **außer** `eval`: dort reist die Nutzlast als `func`, und der Grund steht hier |
| `README.md` | Rechtetabelle | entsteht in `docs/46`; der Satz zu `scripting` bekommt „im Seitenkontext" dazu |

## Bekannte Lücken

- **Seiten mit strenger CSP bleiben ausgeschlossen.** Das ist eine Grenze der
  Seiten, nicht unserer; die Meldung sagt es.
- **Die Seitenwelt ist mächtiger als die isolierte.** Ein Code, der
  Sitzungsdaten der Seite liest, kann sie jetzt sehen — der Schalter ist die
  einzige Grenze, und er ist opt-in.
- **`world: "MAIN"` ist ungemessen.** Stufe 0 entscheidet, ob die erste oder die
  zweite Wahl gebaut wird.

## Open questions

**Keine.** Der Betreiber hat am 2026-11-18 entschieden, dass `eval` gebraucht
wird (Hotels, Preise, Warenkorb, Transkripte) und dass die Änderung über eine
Spec läuft.

## Review

### Runde 1 — 2026-11-18, `grizzled-senior-dev`: 🤔, Zuschnitt falsch

Acht Blocker: die Zahl 6 war falsch (die Seite hat einen Absatz); das
Seitenwelt-Kriterium war ein Zirkelschluss; Stufe 0 hatte kein Messinstrument;
zwei Fahrzeuge widersprachen sich (`func` umgeht `page-agent.js`, und
`page-agent.js` kann wegen `browser.runtime` nicht in die Seitenwelt); der
Antwortvertrag hatte keinen Besitzer; die Fristen nannten den falschen Eigner
und ließen zwei Codes weg; „die alten `eval_`-Fälle bleiben grün" war unmöglich,
weil der Harness die Injektion auf `{target, files}` pinnt; und für „alles
andere bleibt isoliert" gab es keinen Fall.

**Übernommen:** Zahl auf 1 mit Messdatum; Kriterium 2 setzt und liest in zwei
Aufrufen; Stufe 0 nennt Instrument und Messseiten; **nur die Nutzlast** geht in
die Seitenwelt, `page-agent.js` bleibt isoliert; der Antwortvertrag reist als
String mit den bestehenden Grenzen und hat seinen Besitzer; Fristen und Codes
korrigiert; Kriterium 4b prüft die Isolation von `read`/`inspect`; Amendments um
`docs/19` und `docs/45` ergänzt; `options.html`/`options.js` in Stufe 2.

## Log

- **2026-11-18, Messung:** `browser_eval` scheitert unter MV3 mit
  `call to Function() blocked by CSP`, Journal `code=eval_failed`, zweimal
  reproduziert auf `https://example.com/`.
- **2026-11-18, Betreiberentscheid:** `eval` bleibt ein Werkzeug; die Spec
  beschreibt den Umzug in die Seitenwelt.
- **2026-11-18, Runde 1:** das Review hat den Zuschnitt blockiert (`🤔`); die
  zwei Wege sind jetzt einer — Nutzlast als `func` in die Seitenwelt, alles
  andere bleibt isoliert.
