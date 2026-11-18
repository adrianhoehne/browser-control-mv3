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
auch `document.title` braucht einen `Function`-Aufruf.

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

**Erste Wahl:** `browser.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args: [code] })`.
Der Code wird als Argument übergeben und im Seitenkontext ausgewertet
(`eval` beziehungsweise `Function` dort). Firefox kennt den `world`-Parameter
seit Version 128; die Zielversion ist 152.

**Ob das trägt, wird gemessen, nicht angenommen** (Stufe 0 unten): ein Aufruf auf
einer Seite ohne CSP muss ein Ergebnis liefern, und ein Aufruf auf einer Seite mit
strenger CSP muss den CSP-Fehler der **Seite** melden (nicht unserer).

**Zweite Wahl, falls `world` nicht greift:** ein `<script>`-Element mit dem Code
als Text in die Seite hängen und das Ergebnis über eine globale Variable und ein
`CustomEvent` zurückholen. Nachteil: Seiten mit `script-src` ohne `'unsafe-inline'`
blockieren es, also dieselbe Grenze wie bei `eval` in der Seitenwelt auch.

**Was in keinem Fall geht:** die Auswertung in der isolierten Welt. Dort bleibt
`Function` gesperrt.

## Fehlerpfade

| Fall | Antwort |
|---|---|
| `allowEval` aus | „Code-Auswertung ist nicht erlaubt …" (wie heute) |
| Seite verbietet Skript (CSP) | „Die Seite verbietet eigenes Skript (CSP) — Werte lassen sich mit `read` oder `inspect` holen." |
| Code wirft | `eval_failed` mit dem Fehlertext der Seite |
| Code liefert nichts | `undefined`, kein Fehler |
| Frist | wie heute (`BC_CALL_TIMEOUT_MS` der Bridge) |

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
   `browser_eval` mit `document.querySelectorAll("p").length` ⇒ **6** (die
   mehrsprachige IANA-Seite), kein `eval_failed`.
2. **Seitenvariablen sind sichtbar.** Auf einer Seite mit gesetztem
   `window.__bcProbe` liefert `browser_eval` mit `window.__bcProbe` den Wert —
   das ist der Unterschied zur isolierten Welt.
3. **Der Schalter wirkt.** Mit ausgeschaltetem `allowEval` antwortet dasselbe
   Kommando mit der Erlaubnis-Aufforderung, nicht mit einem CSP-Fehler.
4. **Die CSP bleibt clean.** `node -e "const m=require('./extension/manifest.json');
   console.log(m.content_security_policy.extension_pages.includes('unsafe-eval'))"`
   ⇒ `false`.
5. **Der CSP-Fall kommt erklärt.** (Betreiber.) Auf einer Seite mit strenger CSP
   (z. B. `https://github.com/`) ⇒ Meldung, die „CSP" und die Alternative nennt;
   `read` auf derselben Seite funktioniert weiter.
6. **Die alten Fälle bleiben grün.** `npm test` ⇒ `# fail 0`; die
   `eval_`-Fälle von vor dem Umbau sind unverändert grün, `read`/`inspect`/
   `click`/`type` unberührt.

## Dev plan

**Stufe 0 — messen, ob `world: "MAIN"` trägt**

Dateien: keine. Ein Aufruf gegen den laufenden Dienst auf einer Seite ohne CSP
und einer mit CSP; notieren, was zurückkommt. Wenn `world` nicht akzeptiert wird
(Fehler „unknown property" oder ähnlich), ist die zweite Wahl aus
`## Der Weg in die Seitenwelt` dran — und diese Spec bekommt das Ergebnis.

Beweis: zwei Ausgaben, eine mit Wert, eine mit dem CSP-Fehler der Seite.

**Stufe 1 — `eval` umstellen**

Dateien: `extension/page-agent.js` (der `eval`-Op), `extension/bridge.js`
(der Aufruf mit `world`), `test/extension.test.js`.

Beweis: Kriterien 1, 2, 3, 4 und die sechs Testfälle.

**Stufe 2 — Doku**

Dateien: `docs/25` (Amendment: `eval` ist nicht mehr isoliert, Begründung),
`README.md` (Rechtetabelle: was `allowEval` jetzt erlaubt), `CHANGELOG.md`,
`docs/PROJECT-STATE.md`, `docs/47` auf `active`.

Beweis: Kriterien 5, 6.

## Amendments to previous spec docs

| Dokument | Abschnitt | was gilt |
|---|---|---|
| `docs/25-frame-handeln.md` (führt `browser_eval` mit `frame` ein) | `## Ziel`, `## Bekannte Lücken` | „läuft in der isolierten Welt" ist **überholt**. Neu: es läuft in der Seitenwelt, weil MV3 es anders nicht zulässt; der Schalter ist die Zustimmung |
| `README.md` | Rechtetabelle | der Satz zu `scripting` bekommt „im Seitenkontext" dazu |

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

### Runde 1 — steht aus

## Log

- **2026-11-18, Messung:** `browser_eval` scheitert unter MV3 mit
  `call to Function() blocked by CSP`, Journal `code=eval_failed`, zweimal
  reproduziert auf `https://example.com/`.
- **2026-11-18, Betreiberentscheid:** `eval` bleibt ein Werkzeug; die Spec
  beschreibt den Umzug in die Seitenwelt.
