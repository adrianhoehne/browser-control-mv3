---
description: Geschlossene Shadow Roots für die Werkzeuge erreichbar machen — ein Eingriff bei document_start, hinter einem eigenen Schalter, Default aus.
status: proposed
---

# Geschlossene Schattenwurzeln

Am 2026-11-19 hat die Werkzeugkette an einer echten Aufgabe versagt:
`bahn.de` legt sein Buchungsformular in einem **geschlossenen** Shadow Root an.
`read` und `inspect` sehen den Text, aber `querySelectorAll` findet kein
Eingabefeld — es gibt keinen Selektor, den `click` oder `type` erreichen könnte.

## Ziel

- **Die Werkzeuge erreichen Seiten, die sich heute verbergen.** Nach dieser Spec
  findet `inspect` die Elemente in einem Shadow Root, und `click`/`type` können
  sie bedienen.
- **Der Eingriff ist abschaltbar und standardmäßig aus.** Ein Schalter
  `openShadowRoots` in den Optionen, gelesen bei jeder Injektion.
- **Er ist ehrlich benannt.** Wer ihn einschaltet, ändert das Verhalten fremder
  Seiten — das steht auf der Optionsseite, nicht nur in dieser Spec.

## Wie es wirkt

Eine Datei wird bei `document_start` in der **Seitenwelt** jedes Frames
registriert und ersetzt eine Methode, bevor die Seite sie benutzt:

```js
const attach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (init) {
  return attach.call(this, { ...init, mode: "open" });
};
```

Mehr nicht. Kein Ersetzen von `querySelector`, kein Auslesen, kein Melden nach
außen. Die Seite merkt nichts, außer dass ihr Schattenwurzel offen ist — was für
sie keinen Unterschied macht, weil sie ihn weiter über ihre eigene Referenz
bedient.

## Was ausdrücklich **nicht** passiert

- **Kein Eingriff in den Inhalt.** Nichts wird gelesen, gespeichert oder
  gesendet.
- **Kein Umgehen von `iframe`- oder CSP-Grenzen.** Ein verbotener Frame bleibt
  verboten.
- **Keine Wirkung auf bestehende Wurzeln.** Ein Schattenwurzel, den die Seite
  **vor** dem Einschalten anlegt, bleibt zu. Ein Neuladen der Seite schafft
  Abhilfe, und das steht auf der Optionsseite.

## Stufe 0 — vor jeder Spec-Freigabe zu messen

Drei Fragen, jede mit einem Nein als möglichem Ausgang:

1. **Trägt `browser.scripting.registerContentScripts` mit `world: "MAIN"` in
   Firefox 152?** Wenn nein, ist der Weg über `executeScript` bei
   `webNavigation.onCommitted` zu prüfen — der läuft später und könnte zu spät
   sein.
2. **Läuft die Datei wirklich vor dem Code der Seite?** Prüfstein: eine Seite,
   die im ersten Inline-Skript einen geschlossenen Wurzel anlegt.
3. **Bleibt die Seite funktionsfähig?** Prüfstein: `bahn.de` Buchungsformular
   bedienbar, `addons.mozilla.org` unverändert nicht lesbar (die CSP der Seite
   gilt weiter), eine Seite mit eigenem `attachShadow`-Aufruf ohne Fehler in der
   Konsole.

**Ohne diese drei Messungen wird nicht gebaut.**

## Risiken

| Risiko | Wirkung | Gegenmittel |
|---|---|---|
| Die Seite erwartet einen geschlossenen Wurzel | Manche Bibliotheken prüfen `mode` und ändern ihren Pfad | Ein Fall, der eine Seite mit eigenem Wurzel-Test lädt, prüft gleiches Verhalten |
| Ein Fehler in der Datei bricht jede Seite | Totalausfall statt Komfort | Die Datei ist ein `try`-umschlossener Einzeiler; ein Fehler lässt `attachShadow` unverändert |
| Der Eingriff weitet die Rechte still aus | Der Agent sieht Dinge, die er ohne Schalter nicht sieht. Das muss niemand raten | Default aus, Schalter im Optionsfeld, ein Satz auf der Optionsseite |
| Zwei Registrierungen derselben Datei | Doppeltes Überschreiben | `registerContentScripts` mit fester `id`, vorher `unregisterContentScripts` |

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `shadowOpen_whenTheSwitchIsOn_shouldReachIntoAClosedRoot` (**neu**) | die Datei wird registriert (`world: "MAIN"`, `runAt: "document_start"`, `allFrames: true`) und der Wurzel ist danach offen |
| `test/extension.test.js` | `shadowOpen_whenTheSwitchIsOff_shouldRegisterNothing` (**neu**) | ohne Schalter keine Registrierung, keine Datei |
| `test/extension.test.js` | `shadowOpen_withAnAlreadyBrokenPatch_shouldLeaveAttachShadowWorking` (**neu**) | ein Fehler in der Datei lässt die Seite heil |
| `test/options.test.js` | `optionsHtml_forShadowRoots_shouldSayWhatItTouches` (**neu**) | der Hinweis nennt fremde Seiten und das nötige Neuladen |

## Acceptance criteria

**1–4 entscheidet der Umsetzer, 5–6 der Betreiber.**

1. **Registriert.** Der Fall prüft `id`, `matches: ["<all_urls>"]`,
   `runAt: "document_start"`, `world: "MAIN"`, `allFrames: true`.
2. **Abschaltbar.** Ohne Schalter findet keine Registrierung statt
   (`registerContentScripts` ⇒ 0 Aufrufe).
3. **Heil bei Fehler.** Der dritte Fall läuft grün.
4. **Die Suite bleibt grün.** `npm test` ⇒ `# fail 0`, `# cancelled 0`,
   `# skipped 0`; `npm run check` ⇒ 0.
5. **(Betreiber) `bahn.de` bedienbar:** Formular ausfüllen, Suche auslösen,
   Treffer lesen — der Fall, der am 2026-11-19 scheiterte.
6. **(Betreiber) Nichts anderes kaputt:** `addons.mozilla.org` antwortet weiter
   `page_not_readable`, und drei beliebige Seiten laden ohne Konsolenfehler.

## Dev plan

**Stufe 1 — die Datei und die Registrierung**

Dateien: `extension/shadow-open.js` (neu, der Einzeiler mit `try`),
`extension/manifest.json` (nichts — die Registrierung ist programmatisch),
`extension/bridge.js` (Registrierung beim Start, abhängig vom Schalter),
`extension/options.html`, `extension/options.js` (der Schalter),
`test/extension.test.js` (drei Fälle), `test/options.test.js` (ein Fall).

Beweis: Kriterien 1–4.

**Stufe 2 — Anleitung und Messung**

Dateien: `INSTALL.md` (Abschnitt „Firefox permissions" um den Schalter ergänzen),
`docs/45-injection-naht.md` (datiertes Amendment: die Naht hat jetzt zwei
Richtungen), `docs/PROJECT-STATE.md`.

Beweis: Kriterien 5, 6.

## Amendments to previous spec docs

| Dokument | Abschnitt | was gilt |
|---|---|---|
| `docs/45-injection-naht.md` | `## Die Naht` | neben dem `func` je Aufruf gibt es jetzt eine **dauerhafte** Injektion bei `document_start`, hinter einem Schalter |
| `docs/09-dom-abfrage.md` | `## Bekannte Lücken` | „geschlossene Shadow Roots sind nicht erreichbar" gilt nur noch ohne den Schalter |
| `INSTALL.md` | `## Firefox permissions` | der Schalter steht dort mit seiner Wirkung und dem nötigen Neuladen |

## Bekannte Lücken

- **Bestehende Wurzeln bleiben zu.** Nur was nach dem Einschalten entsteht, ist
  offen; ein Neuladen der Seite ist Pflicht und steht auf der Optionsseite.
- **`about:`-Seiten und AMO bleiben ausgeschlossen.** Der Schalter öffnet
  Schattenwurzeln, nicht Firefos eigene Grenzen.
- **Die drei Stufe-0-Messungen sind Pflicht.** Ohne sie ist unklar, ob die Datei
  früh genug läuft — und eine zu späte Datei ist schlimmer als keine, weil sie
  den Schalter wirkungslos macht, ohne dass es jemand merkt.

## Open questions

1. **`registerContentScripts` mit `world: "MAIN"`** — in Firefox 152 messbar, aber
   ungemessen. Fällt die Antwort nein aus, braucht die Spec einen anderen Weg
   (Manifest-`content_scripts` mit `world`, oder `executeScript` bei
   `onCommitted` mit dem Preis, zu spät zu sein).

## Review

### Runde 1 — steht aus

## Log

- **2026-11-19, Messung:** `bahn.de` legt das Buchungsformular in einem
  geschlossenen Shadow Root an; `read`/`inspect` sehen den Text,
  `querySelectorAll` findet 577 Elemente und **kein** Eingabefeld. Der Agent
  konnte die Suche nicht auslösen; erst nach einer Suche von Hand war die
  Trefferliste lesbar.
