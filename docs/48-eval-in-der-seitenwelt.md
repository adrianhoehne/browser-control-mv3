---
description: browser_eval läuft in der Seitenwelt — world MAIN, die CSP-Meldung der Seite, der Optionsseite-Hinweis und die Amendments; setzt den Func-Vertrag aus docs/47 voraus.
status: proposed
---

# `browser_eval` in der Seitenwelt

Zweiter Teil der ursprünglichen `docs/47`, abgespalten nach dem **dritten**
Review-Block (2026-11-18). `docs/47-eval-vertrag.md` legt den Vertrag des `func`
fest und baut den Harness-Runner; **diese Spec macht das Verhalten sichtbar.**

**Voraussetzung:** `docs/47` ist gebaut. Ohne den Func-Runner und den Vertrag
(`args: [code, limits, want]`, Rückgabe mit `message`, ein Serialisierer) ist der
Umzug nicht messbar.

## Ziel

- **`browser_eval` arbeitet wieder**, mit demselben Vertrag wie bisher:
  `code` hinein, Ergebnis heraus, `elapsedMs`, `null` wenn der Ausdruck nichts
  liefert, benannte Fehlercodes.
- **Der Code läuft in der Seitenwelt** (`world: "MAIN"`), weil dort die CSP der
  Seite gilt und nicht unsere.
- **Der Schalter `allowEval` bleibt Pflicht** und bekommt einen ehrlichen
  Hinweis: der Code sieht ab jetzt auch Seitenvariablen.
- **Ein CSP-Verbot der Seite kommt erklärt**, nicht verschluckt.
- **Alles andere bleibt in der isolierten Welt** — `read`, `inspect`, `click`,
  `type`, `frames`, `transcript` sehen keine Seitenvariablen.

## Die Messung, auf der es ruht

Firefox 152.0.3, headless, Wegwerf-Extension in `/tmp`, 2026-11-18:

```
STEP1 world-MAIN accepted. result = [{"frameId":0,"result":"Example Domain"}]
STEP2 page variable survives = [{"frameId":0,"result":42}]
STEP3 isolated world sees __bcProbe as = [{"frameId":0,"result":"undefined"}]
STEP4 github eval result = [{"frameId":0,"result":"caught: EvalError: call to eval() blocked by CSP"}]
```

Daraus: der Parameter trägt; eine Seitenvariable überlebt zwischen zwei Aufrufen,
während die isolierte Welt sie nicht sieht; die Injektion überlebt eine strenge
CSP, blockiert wird erst ein ausdrückliches `eval`/`Function`; der Fehlertext
heißt **`call to eval() blocked by CSP`**.

## Non-goals

- **Kein `'unsafe-eval'`.** MV3 verbietet es; Firefox lädt das Manifest dann
  nicht.
- **Keine Änderung an der Server-Bridge (`bridge-rs`)** und am Protokoll.
- **Kein neues Werkzeug, keine neuen Argumente.**
- **Kein Entfernen des Schalters.** Er ist die Grenze zwischen „Werkzeuge dürfen
  die Seite bedienen" und „der Agent darf beliebigen Code ausführen".

## Die Sicherheitsfolge, ehrlich

| | vorher (MV2) | nachher |
|---|---|---|
| DOM-Zugriff | ja | ja |
| Seitenvariablen (`window.x`) | **nein** | **ja** |
| Schalter nötig | `allowEval` | `allowEval` |

Der Schalter wird damit **weiter gefasst als gedacht**. Das muss in der
Optionsseite stehen, nicht nur in der Spec.

## Fehlerpfade

| Fall | Antwort |
|---|---|
| `allowEval` aus | „Code-Auswertung ist nicht erlaubt …" (wie heute) |
| Seite verbietet Skript | „Die Seite verbietet eigenes Skript (CSP) — Werte lassen sich mit `read` oder `inspect` holen." |
| Code wirft | `eval_failed` mit dem Fehlertext der Seite |
| Code liefert nichts | `null`, kein Fehler |
| Frist | `timeoutMs` reist in `limits`, der `func` misst sie selbst |

Die CSP-Erkennung prüft auf **„CSP"**, nicht auf ein Wort wie `Function` — die
Messung zeigte `eval()`.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `injection_forEval_shouldCarryWorldMain` | die Schlüssel sind `{args, func, target, world}` |
| `test/extension.test.js` | `eval_inThePageWorld_shouldSeeThePageVariable` | Seitenvariable gesetzt und gelesen, mit zwei Welten (aus `docs/47`) |
| `test/extension.test.js` | `eval_whenThePageForbidsScript_shouldNameTheCsp` | der CSP-Fall ist ein benannter Fehler mit deutschem Satz |
| `test/extension.test.js` | `eval_withoutTheSwitch_shouldRefuseBeforeInjecting` (bestehend) | `allowEval` bleibt Pflicht |
| `test/manifest.test.js` | `manifest_shouldNotAllowUnsafeEval` | `content_security_policy.extension_pages` enthält kein `'unsafe-eval'` |
| `test/manifest.test.js` | `optionsHtml_forTheEvalSwitch_shouldNameWhatItUnlocks` (bestehend, erweitert) | der Hinweis nennt **Seitenvariablen**; die alten Wörter (`password fields`, `localStorage`, `HttpOnly`, `fetch`) bleiben |

## Acceptance criteria

**Kriterien 1–4 entscheidet der Umsetzer, 5–7 der Betreiber** (echter Browser,
`allowEval` in der Optionsseite).

1. **Der Aufruf trifft die Seitenwelt.** `injection_forEval_shouldCarryWorldMain` ⇒
   grün; `world: "MAIN"` steht im Aufruf.
2. **Seitenvariablen sind sichtbar.** Der erste Aufruf setzt `window.__bcProbe`.
   Der zweite liest sie zurück ⇒ der Wert kommt an.
3. **Der CSP-Fall trägt einen Namen.** `eval_whenThePageForbidsScript_shouldNameTheCsp`
   ⇒ grün, die Meldung enthält „CSP" und den Hinweis auf `read`/`inspect`.
4. **Die CSP bleibt clean.** `node -e "const m=require('./extension/manifest.json');
   console.log(m.content_security_policy.extension_pages.includes('unsafe-eval'))"`
   ⇒ `false`.
5. **`eval` liefert wieder Werte.** (Betreiber.) Über MCP auf
   `https://example.com/`: `document.querySelectorAll("p").length` ⇒ **1**
   (gemessen 2026-11-18), kein `eval_failed`.
6. **Der CSP-Fall kommt erklärt.** (Betreiber.) Auf `https://github.com/` ⇒
   Meldung mit „CSP"; `read` auf derselben Seite funktioniert weiter.
7. **Der Rest bleibt grün.** (Betreiber und Umsetzer.) `npm test` ⇒ `# fail 0`,
   `# cancelled 0`; `npm run check` ⇒ 0; `parity.sh --impl rust --check` ⇒ 7/7.

## Dev plan

**Stufe 1 — der Umzug**

Dateien: `extension/bridge.js` (Aufruf mit `world: "MAIN"`, `func` aus `docs/47`),
`test/extension.test.js` (`injection_forEval_shouldCarryWorldMain`, die zwei
Seitenwelt-Fälle), `test/manifest.test.js` (`manifest_shouldNotAllowUnsafeEval`).

Beweis: Kriterien 1, 2, 3, 4.

**Stufe 2 — Anleitung und Amendments**

Dateien: `extension/options.html`, `extension/options.js` (Hinweis am
`allowEval`-Schalter sagt, dass der Code Seitenvariablen sieht; der gepinnte Text
bleibt, `page variables` kommt dazu), `docs/25-frame-handeln.md`,
`docs/19-browser-eval.md`, `docs/45-injection-naht.md`, `CHANGELOG.md`,
`docs/PROJECT-STATE.md`, `README.md` (Rechtetabelle, falls `docs/46` sie angelegt
hat), `docs/README.md`.

Beweis: Kriterien 5, 6, 7 und `optionsHtml_forTheEvalSwitch_shouldNameWhatItUnlocks`.

## Amendments to previous spec docs

| Dokument | Abschnitt | was gilt |
|---|---|---|
| `docs/25-frame-handeln.md` | `## Ziel`, `## Bekannte Lücken` | „läuft in der isolierten Welt" ist **überholt**; neu: Seitenwelt, weil MV3 es anders nicht zulässt |
| `docs/19-browser-eval.md` | Fehlertabelle | `message` steht im Vertrag (`docs/47`), die CSP-Meldung ist neu; die Sätze bleiben |
| `README.md` | Rechtetabelle | entsteht in `docs/46`; der Satz zu `scripting` bekommt „im Seitenkontext" dazu |

## Bekannte Lücken

- **Seiten mit strenger CSP bleiben ausgeschlossen.** Das ist eine Grenze der
  Seiten, nicht unserer; die Meldung sagt es.
- **Die Seitenwelt ist mächtiger als die isolierte.** Der Schalter ist die
  einzige Grenze, und er ist opt-in.
- **Der Zwei-Welten-Harness ist eine Attrappe** (`docs/47`); die echte Grenze
  zeigt erst der Browser.

## Open questions

**Keine.**

## Review

### Runde 1 — steht aus

## Log

- **2026-11-18, Teilung:** nach dem dritten Review-Block der ursprünglichen
  `docs/47`; der Vertrag und der Harness-Runner stehen in `docs/47`.
- **2026-11-18, Betreiberentscheid:** `eval` bleibt ein Werkzeug (Hotels, Preise,
  Warenkorb, Transkripte).
