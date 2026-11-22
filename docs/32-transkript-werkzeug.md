---
description: Das dreizehnte Werkzeug browser_transcript liest das Transkript des YouTube-Video-Tabs als Segmente mit Zeitstempeln — mit offset/maxChars wie browser_read; die Wahl der Sprachspur ist Teil 2.
status: active
---

# `browser_transcript`, Teil 1: das Transkript lesen

Das dreizehnte MCP-Werkzeug: es öffnet das Transkript-Panel des Video-Tabs und
gibt **Segmente** zurück, je mit Zeitstempel und Text — statt eines Textbandes
mit Zeitstempeln darin.

**Diese Spec ist der erste von zwei Teilen.** Sie entstand am 2026-11-12 durch
**Teilung** der gemeinsamen Fassung, nachdem das Spec-Gate sie in der dritten
Runde blockiert hatte (`CONTRIBUTING.md`, Schritt 4: „Nach dem dritten Block ist die
Spec zu groß … Nicht durchwinken"). Der zweite Teil ist
`docs/33-spurwahl.md`.

**Die Naht ist „lesen" gegen „die richtige Spur erzwingen".** Teil 1 liest,
was das Panel zeigt; Teil 2 setzt die Spur. Der Grund für diesen Schnitt steht
in den Messungen: das Lesen ist **gemessen und sicher** (M1–M3), die Spurwahl
ist **nicht belegt** (Teil 2, M7/M8). Fällt Teil 2 durch, steht dieses Werkzeug
trotzdem.

## Ziel

- **`browser_transcript` liefert Segmente**, nicht ein Textband: je Segment ein
  Zeitstempel und ein Text. Das ist der Unterschied zwischen „Transkript" und
  „Seite mit Transkript".
- **Drei Aufrufe statt fünf.** Heute braucht der Agent `navigate` → `focus` →
  `click #expand` → `click` Transkript-Knopf → `read` (`docs/31`, M1). Das
  Werkzeug übernimmt die letzten **drei**.
- **Der Tab muss gerendert sein — und das sagt das Werkzeug.** Eine Seite, die
  nie im Vordergrund war, rendert YouTube nicht (M4), also gibt es kein Panel.
  Das Werkzeug **aktiviert nichts selbst** (Entscheidung des Betreibers vom
  2026-11-12: „Agent fokussiert vorher"); es antwortet stattdessen
  `transcript_needs_focus` mit dem Hinweis auf `browser_focus`. **Die
  Bedingung ist „nicht gerendert", nicht „im Hintergrund"** — ein Tab, der
  einmal im Vordergrund war, behält seine Segmente auch im Hintergrund
  (live gemessen, siehe `## Messlauf`).
- **Die Antwort ist blätterbar** wie bei `browser_read`: `offset` und
  `maxChars` zählen **Zeichen über die verketteten Segmenttexte**, mit Default,
  Deckel und einem ehrlichen `truncated` (`docs/22`).
- **Das Werkzeug öffnet das Panel selbst** und wartet auf dessen Bereitschaft —
  **nicht** auf `settled`, denn das sagt auf YouTube nichts
  (`docs/31`, M6; hier M4). Den Vordergrund stellt der **Agent** her.
- **Kein Produktcode außerhalb der Werkzeug-Dateien.** Keine neue
  Berechtigung, keine Abhängigkeit, kein Token.

## Non-goals

- **Keine Spurwahl.** Welcher Spur die Antwort gilt, entscheidet
  **`docs/33-spurwahl.md`**; dieses Werkzeug setzt keine Spur und wählt keine
  Sprache. **Nachgetragen 2026-11-12:** gelesen wird nicht mehr das Panel,
  sondern die Spurendatei des Players (`docs/33`, M13) — das Panel trägt die
  Sprache seiner Ladung (M14), nicht die der Spur.
- **Keine Kapitel, kein Bild.** Kapitel sind in `docs/31` beobachtet, aber
  nicht gemessen; Bild ist dort ausdrücklich nicht entschieden.
- **Kein API-Client und keine geratene Adresse.** `docs/31`, M4 und M5 haben
  gezeigt: `timedtext` antwortet HTTP 200 mit **0 Bytes**, wenn die Adresse
  nicht die des Players ist (es fehlt die Signatur), und innertube
  `get_transcript` mit HTTP 400. **Nachgetragen 2026-11-12:** gelesen wird die
  **signierte** Adresse, die der Player selbst geholt hat (`docs/33`, M13) —
  keine selbst gebaute Anfrage, kein Token, kein Key.
- **Keine anderen Video-Hosts.** Nur youtube.com, nur die Watch-Seite.
- **Kein YouTube-Token, kein API-Key.** Ein Token wäre ein Geheimnis im Repo.
- **Kein Log-Eintrag für dieses Werkzeug** — wie `browser_frames` bekommt es
  **keinen** `#reportResult`-Zweig und **keinen** `DEBUG_WHITELIST`-Eintrag in
  `bridge/hub.mjs` (M6). Ein textfreier Logzeilen-Zweig wäre eine eigene
  Entscheidung; hier ist er **nicht** gebaut.
- **Keine anderen Sprachen als die angezeigte.** Die Übersetzungsfunktion
  („Automatisch übersetzen") ist Teil 2 und dort **nicht** gebaut.

## Die Messungen

Alle am 2026-11-11/12, live, im Firefox-Profil des Betreibers (YouTube
Premium, deutsche Oberfläche `hl=de`, angemeldet). Wenn eine Messung aus
`docs/31` übernommen ist, steht das dabei; „erneut gemessen" heißt: am
2026-11-12 noch einmal gefahren, mit demselben Ergebnis.

### M1 — Der Weg zum Panel funktioniert, in fünf Schritten

*Beleg: `browser_navigate`, `browser_focus`, `browser_click`, `browser_read`
auf `v=<video-en>`, 2026-11-11/12.*

| Schritt | Aufruf | Beobachtung |
|---|---|---|
| 1 | `browser_navigate` → `https://www.youtube.com/watch?v=<video-en>` | Tab, Titel „But what is a neural network? \| Deep learning chapter 1" |
| 2 | `browser_focus` | **ohne diesen Schritt bleibt die Seite leer** (M4) |
| 3 | `browser_click` auf `tp-yt-paper-button#expand` | Beschreibung klappt auf |
| 4 | `browser_click` auf den Transkript-Knopf | Transkript-Panel öffnet |
| 5 | Segmente lesen | 133 Segmente |

**Der Transkript-Knopf ist sprachabhängig.** Sein `aria-label` lautet
`"Transkript anzeigen"` — deutsch, weil die Oberfläche deutsch ist. Stabil ist
der Elementname des Vaters:
`ytd-video-description-transcript-section-renderer` → `div#button-container`
→ `yt-button-shape` → `button.ytSpecButtonShapeNextHost`. **Der Selektor zielt
auf den Vater, nicht auf das `aria-label`.**

**Die Sichtbarkeitsfalle** (`docs/31`, M8): es gibt **zwei** Knoten
`ytd-video-description-transcript-section-renderer`, und der Knopf ist vor dem
Aufklappen unsichtbar. Das Snippet prüft die Sichtbarkeit
(`getClientRects().length`) und nimmt den sichtbaren.

### M2 — Die Segmente haben eine klare Struktur

*Beleg: `browser_eval` auf `v=<video-en>`, 2026-11-11/12.*

```html
<transcript-segment-view-model class="ytwTranscriptSegmentViewModelHost">
  <div class="ytwTranscriptSegmentViewModelTimestamp">0:04</div>
  <div class="ytwTranscriptSegmentViewModelTimestampA11yLabel">4 Sekunden</div>
  <span role="text">Das ist eine Drei.</span>
</transcript-segment-view-model>
```

- **Zeitstempel**: der erste Div (`0:04`; ab einer Stunde `1:02:03` — `time`
  ist dann die Zahl **3723**, `timeText` behält die Anzeige).
- **Text**: das `span[role="text"]`.
- **Die A11y-Zeile** („4 Sekunden") ist die ausgeschriebene Form — **kein
  Transkripttext**, sie gehört nicht in die Antwort.
- 133 Segmente beim ein englisches Erklärvideo-Video, **19 645 Zeichen** reiner Segmenttext.
  Verkettet mit dem Verbinder (ein Leerzeichen) sind es
  **19 645 + 132 = 19 777 Zeichen** — das ist `totalChars` (Kriterium 3).
- Die ersten drei Segmente wörtlich:
  ```
  0:04  Das ist eine Drei.
  0:06  Sie ist schlampig geschrieben und mit einer extrem niedrigen
        Auflösung von 28x28 Pixeln gerendert, aber dein Gehirn hat keine
        Probleme, sie als eine 3 zu erkennen.
  0:14  Es ist doch verrückt, wie einfach unser Gehirn das macht, oder?
  ```

### M3 — Welche Sprache das Panel zeigt, entscheidet YouTube

*Beleg: `browser_read`, `browser_eval`, Player-Einstellungen auf
`v=<video-en>` und `v=<video-ja>`, 2026-11-11.*

Beim **englischen** Video (Original: Englisch) zeigte das Panel **deutschen**
Text („Das ist eine Drei."), obwohl der Player „Untertitel: Englisch" meldete.
Beim **japanischen** Video zeigte es **japanischen** Text.

**Das ist YouTubes automatische Übersetzung, kein Fehler** — der Titel des
englischen Videos war ebenfalls übersetzt („Aber was ist ein neuronales
Netz?"). Für Teil 1 heißt das: **die Antwort ist in der Sprache, die YouTube
gewählt hat**, und das Werkzeug weiß nicht, welche (M5). Genau deshalb gibt es
Teil 2. Teil 1 sagt dazu **nichts** — es liefert keine Sprachangabe und
behauptet keine.

### M4 — Die Seite hydriert spät, `settled` lügt

*Beleg: `browser_read` und `browser_focus` auf `v=<video-en>`, 2026-11-11;
übernommen aus `docs/31`, M6.*

Ein **Hintergrund-Tab** zeigt auf derselben URL nur **12 Zeichen**
(„0:00 / 18:40"), `ytd-watch-flexy` fehlt. `browser_read` meldete dabei
**`settled: true`** nach 2 812 ms. `docs/14:193` sagt es längst: „Ruhe ist
nicht Fertigkeit."

**Folge für das Werkzeug:** es prüft zuerst, ob die Seite überhaupt
gerendert ist (`ytd-watch-flexy` vorhanden). Ist sie es **nicht**, antwortet es
`transcript_needs_focus` — kein Warten, kein Klick. Danach prüft es die
**Panel-Bereitschaft** selbst — **5 s** Frist, dann `no_transcript_panel`. Die 5 s sind eine **gewählte**
Frist, keine gemessene Obergrenze: der Panel-Aufbau ist ein eigener Vorgang,
und das Ruhe-Budget aus `docs/14` gilt der Seite, nicht dem Panel.

### M5 — Die API-Wege tragen nicht (erneut gemessen)

*Beleg: `browser_eval` mit `fetch` auf `v=<video-en>` und `v=<video-ja>`,
2026-11-12.*

| Weg | Ergebnis |
|---|---|
| `fetch(baseUrl)` aus `captionTracks[i].baseUrl` | **HTTP 200, 0 Bytes** (`text/html`) — für `de`, `en`, `en/asr`, mit `&fmt=json3`, `&fmt=srv3`, `&fmt=vtt`, mit und ohne `credentials` |
| innertube `POST /youtubei/v1/get_transcript` | **HTTP 400 `FAILED_PRECONDITION`** (drei Varianten) |

**Die gelieferte Sprache ist im DOM nicht feststellbar:** weder
`transcript-segment-view-model` noch seine Elternkette noch das Panel noch
`ytInitialData.engagementPanels` tragen ein `lang`-, `data-lang`- oder
`content-language`-Attribut (`panel.outerHTML.indexOf('lang=')` ⇒ **−1**).

### M6 — `bridge/hub.mjs` schreibt für eine Methode ohne Zweig nichts

*Beleg: Code gelesen, `bridge/hub.mjs:796` und `:835`–`:837`.*

`browser_frames` hat **keinen** `#reportResult`-Zweig und **keinen**
`DEBUG_WHITELIST`-Eintrag — es steht im Log nicht. Genau so soll
`browser_transcript` sein: **kein Log**. Ein Debug-Block würde den
Transkripttext ins Journal schreiben (die Hygieneregel aus `docs/28`), und ein
eigener textfreier Zweig wäre eine eigene Entscheidung, die diese Spec **nicht**
trifft.

## Testing

**Nachgetragen 2026-11-12:** die acht Zeilen, die das Öffnen und Lesen des
**Panels** prüften (Renderer, Knopf, `#expand`, Panel schon offen), sind mit
`docs/33`, Stufe 1 entfallen — das Werkzeug liest die Spurendatei und öffnet
das Panel nicht mehr. Fenster-, Gate- und Werkzeugfälle gelten unverändert
weiter.

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `transcript_segments_withThreeSegments` | Zeitstempel und Text werden **getrennt** gelesen; die A11y-Zeile fehlt im Text (M2) |
| `test/extension.test.js` | `transcript_segments_joinsWithSingleSpace` | der Verbinder ist **ein Leerzeichen**; `chars`/`totalChars` sind reproduzierbar |
| `test/extension.test.js` | `transcript_model_withoutCaptionTrack_shouldFailNoPanel` | der Fehlerfall „kein Transkript" (`no_transcript_panel`) — nach `docs/33` Stufe 1 heißt das: keine Untertitelspur im Modell |
| `test/extension.test.js` | `transcript_segments_offsetBeyondText_shouldFailWithTotalChars` | `offset` hinter dem Textende ⇒ `offset_out_of_range` mit `totalChars` (`docs/22`) |
| `test/extension.test.js` | `transcript_inABackgroundTab_shouldFailWithNeedsFocus` | ohne gerenderte Seite ⇒ `transcript_needs_focus`, **kein** Klick und **kein** 5-s-Warten (M4) |
| `test/extension.test.js` | `transcript_segments_windowStartsMidSegment_shouldKeepTheSegmentWhole` | ein Segment, das nur teilweise im Fenster liegt, wird **ganz** geliefert — sonst lügt sein Zeitstempel |
| `test/extension.test.js` | `transcript_segments_atTheExactEnd_shouldAnswerEmpty` | `offset === totalChars` ist **gültig** (`text: ""`, `chars: 0`, `truncated: false` — `docs/22`) |
| `test/extension.test.js` | `transcript_params_outOfRange_shouldFail` | `maxChars: 0`, `maxChars: 100001`, `offset: -1` ⇒ `invalid_params` |
| `test/extension.test.js` | `transcript_segments_surroundingWhitespace_shouldBeTrimmed` | `text` und `timeText` werden getrimmt; `chars`/`totalChars` rechnen mit den getrimmten Werten |
| `test/extension.test.js` | `transcript_onLookalikeHosts_shouldStillFail` | `notyoutube.com` und `m.youtube.com` werden abgelehnt |
| `test/extension.test.js` | `transcript_onANonYouTubePage_shouldFail` | auf `example.com` ⇒ `transcript_failed`, **nicht** `transcript_needs_focus` (keine falsche Anweisung) |
| `test/mcp.test.js` | `mcp_toolsList_shouldOfferExactlyTheThirteenToolsOfTheContract` (umbenannt aus `…TwelveTools…`) und `tools.length` = **13** | das Werkzeug ist das dreizehnte |
| `test/mcp.test.js` | `mcp_toolsCallBrowserTranscript_withAConnectedExtension_shouldReturnTheFieldsAsIndentedJsonText` | der Aufruf kommt durch und liefert die Felder |
| `test/mcp.test.js` | `mcp_toolsCallBrowserTranscript_whenThePanelIsMissing_shouldReturnTheNoTranscriptSentence` | der Fehlercode bekommt seinen **eigenen deutschen Satz** |
| `test/mcp.test.js` | `browser_transcript` Schema-Pin: `tab`, `offset`, `maxChars`, `additionalProperties:false` | die Parametermenge steht fest |
| `test/mcp.test.js` | je ein Fall je Fehlercode (`transcript_failed`, `no_transcript_panel`, `offset_out_of_range`) | jeder Code bekommt einen **eigenen deutschen Satz** (der `extensionFailureText`-Zweig) |
| `test/http-mcp.test.js` | `TOOL_COUNT = 13` und das Namensarray | auch über den Dienst sind es dreizehn |
| `test/protocol.test.js` | `transcript` in der Methodenliste, **beide** Kopien | die neue Methode ist im Drahtprotokoll |
| `test/mcp.test.js` | der positionsgebundene Pin `tools[11].name` bleibt unverändert | das Anhängen verschiebt nichts |
| `npm test` | `# fail 0`, `# cancelled 0`, `# skipped 0` | nichts ist kaputt (unter Linux) |
| `grep -c 'transcript' bridge/hub.mjs` | ⇒ **0** | kein Log-Zweig, kein Debug-Block (M6) |
| **live (Betreiber)** | Kriterium 9: `aircAruvnKk` → ein Aufruf liefert Segmente mit Zeitstempeln | der Weg aus M1 trägt end-to-end |

**Keine neue Testdatei.** Die Fälle kommen in die bestehenden
`test/extension.test.js`, `test/mcp.test.js`, `test/http-mcp.test.js` und
`test/protocol.test.js`.

## Acceptance criteria

**Jedes Kriterium nennt einen Befehl, der eine eindeutige Antwort liefert.**

1. **Das Werkzeug existiert und ist das dreizehnte.** Beweis:
   `grep -c 'ExactlyTheThirteenTools' test/mcp.test.js` ⇒ **1** (der Fall ist
   aus `…TwelveTools…` **umbenannt**, sonst behauptet ein Testname das
   Gegenteil); `grep -c 'TOOL_COUNT = 13' test/http-mcp.test.js` ⇒ **1**;
   `grep -c 'tools.length, 13' test/mcp.test.js` ⇒ **1**;
   `grep -c 'mcp_toolsCallBrowserTranscript' test/mcp.test.js` ⇒ **≥ 2**;
   `npm test` grün. Die Werkzeugzahl steigt von 12 auf 13 — die betroffenen
   Stellen sind in `## Amendments to previous spec docs` aufgezählt.
2. **Die Antwort sind Segmente.** `{ segments: [{ time, timeText, text }],
   totalChars, chars, offset, truncated }`. `time` ist die **Anzahl Sekunden**
   (Zahl), `timeText` die Anzeige („0:04"), `text` der Segmenttext. Die
   **A11y-Zeile** („4 Sekunden") ist **nicht** Teil des Textes. **`source`
   steht nicht in dieser Antwort** — den gibt es erst in Teil 2, wo es etwas
   zu nennen gibt (den getroffenen Container). Beweis:
   `grep -c 'transcript_segments_withThreeSegments' test/extension.test.js` ⇒
   **1**; `grep -c 'timeText' extension/background.js` ⇒ **≥ 1**;
   `npm test` grün.
3. **Blättern wie bei `read`, und `segments` ist das Fenster.** `offset`
   (Default **0**, `minimum: 0`), `maxChars` (Default **20 000**, Bereich
   **1 … 100 000**), gezählt **Zeichen über die verketteten Segmenttexte**,
   Verbinder **ein Leerzeichen** (`segments.map(s => s.text).join(" ")`).
   **`segments` enthält genau die Segmente, deren Text im Fenster liegt** —
   nicht alle. Ein Segment, das **nur teilweise** im Fenster liegt, wird
   **ganz** geliefert; sein Zeitstempel gehört zu seinem ganzen Text, eine
   halbe Lieferung wäre eine falsche Auskunft. `chars` ist die Länge der so
   gelieferten Texte **inklusive der Verbinder-Leerzeichen** (wie
   `totalChars`); sie kann `maxChars` **überschreiten**, wenn ein Segment
   ganz geliefert wird — das ist gewollt.
   **`truncated` hängt am Ende des letzten gelieferten Segments, nicht an
   `offset + chars`:** liegt `offset` **mitten** in einem Segment, zählt
   `chars` auch den Teil **vor** `offset` mit, und `offset + chars` läge hinter
   dem wirklich gelieferten Ende — der Rest ginge verloren. Deshalb:
   `truncated` ist `endLast < totalChars`, wobei `endLast` das Ende des
   letzten gelieferten Segments im verketteten Text ist; der **nächste
   `offset`** ist `endLast` (nicht `offset + chars`, nicht `totalChars`).
   Beweis: `transcript_segments_midSegmentOffset_shouldStillReachTheEnd`.
   `offset === totalChars` ist **gültig** (leeres Ergebnis, `chars: 0`,
   `truncated: false`); `offset` dahinter ⇒ `offset_out_of_range` **mit
   `totalChars`** (`docs/22`). Geschnitten wird **im Schnipsel**
   (`extension/background.js`), wie `readPageSource` es tut — nicht in der
   Bridge. Beweis:
   `grep -c 'transcript_segments_joinsWithSingleSpace'
   test/extension.test.js` ⇒ **1**;
   `grep -c 'transcript_segments_windowStartsMidSegment_shouldKeepTheSegmentWhole'
   test/extension.test.js` ⇒ **1**;
   `grep -c 'transcript_segments_atTheExactEnd_shouldAnswerEmpty'
   test/extension.test.js` ⇒ **1**;
   `grep -c 'transcript_segments_offsetBeyondText_shouldFailWithTotalChars'
   test/extension.test.js` ⇒ **1**;
   `grep -c 'transcript_params_outOfRange_shouldFail'
   test/extension.test.js` ⇒ **1**; `npm test` grün.
4. **Das Öffnen des Panels ist entfallen — ersetzt durch `docs/33`, Stufe 1.**
   *Bis 2026-11-12 klickte das Werkzeug `#expand` und den Transkript-Knopf;
   seither liest es die Spurendatei.* Was bleibt: die Seite muss eine
   **YouTube-Watch-Seite** sein, sonst antwortet das Werkzeug
   `transcript_failed`. Beweis:
   `grep -c 'transcript_onANonYouTubePage_shouldFail'
   test/extension.test.js` ⇒ **1**;
   `grep -c 'transcript_onLookalikeHosts_shouldStillFail'
   test/extension.test.js` ⇒ **1**; `npm test` grün.
5. **Kein `settled` — und ein Vordergrund-Gate** (auf einer YouTube-Watch-
   Seite). Ohne gerenderte Seite antwortet das Werkzeug
   `transcript_needs_focus` und tut nichts; der Satz nennt
   `document.visibilityState` als Gegenprobe, damit der Agent nicht in eine
   Fokus-Schleife läuft. *Die eigene Bereitschaftsprüfung für das Panel ist mit
   `docs/33`, Stufe 1 entfallen.* Beweis:
   `grep -c 'transcript_inABackgroundTab_shouldFailWithNeedsFocus'
   test/extension.test.js` ⇒ **1**; `npm test` grün.
6. **Fehlt die Untertitelspur, ist der Fehler benannt.** `no_transcript_panel`,
   wenn das Datenmodell keine `captionTracks` trägt; der Name stammt aus der
   Panel-Zeit, die Bedeutung ist seit `docs/33`, Stufe 1 „keine Untertitelspur".
   Beweis: `grep -c 'transcript_model_withoutCaptionTrack_shouldFailNoPanel'
   test/extension.test.js` ⇒ **1**; `npm test` grün.
7. **Die Parametermenge steht fest.** `tab` (optional, wie bei `read`),
   `offset`, `maxChars`; `additionalProperties:false`. Beweis: der Schema-Pin
   in `test/mcp.test.js` (der Fall `mcp_toolsCallBrowserTranscript_…` aus
   Kriterium 1, Stufe 3) und
   `grep -c 'BROWSER_TRANSCRIPT' bridge/mcp.mjs` ⇒ **≥ 3** (`TOOLS`,
   `UNEXPECTED_ARGUMENTS`, `TRANSCRIPT_ARGUMENTS`, der `switch`,
   `transcriptTool`, `failureTextFor` — **nicht** `TOOL_TEXTS`: dessen
   Schlüssel sind die Fehlercodes); `npm test` grün.
8. **Kein Log, kein Debug-Block.** Beweis:
   `grep -c 'transcript' bridge/hub.mjs` ⇒ **0**;
   `git diff -- bridge/hub.mjs` ⇒ **leer**; `git status --porcelain` ⇒ kein
   Eintrag für `bridge/hub.mjs`. (M6: das Werkzeug steht im Log **nicht** —
   und der Transkripttext darf dort nie landen, `docs/28`.)
9. **LIVE (Betreiber): das Transkript kommt an.** Auf `v=<video-en>`
   **nach** `browser_focus` liefert `browser_transcript` **mindestens drei
   Segmente** mit Zeitstempel und Text. Die ersten drei lauten laut M2
   „Das ist eine Drei.", „Sie ist schlampig geschrieben …" und „Es ist doch
   verrückt …" — der Live-Lauf bestätigt sie oder zeigt, dass sich der Text
   geändert hat (er kann schwanken, die Struktur nicht). Beweis: die ersten
   drei Segmente des Werkzeugaufrufs, wörtlich notiert.
10. **Kein Produktcode außerhalb der Grenze.** Beweis — **im Arbeitsbaum,
    vor dem Commit**: `git status --porcelain` ⇒ nur Einträge unter
    `bridge/mcp.mjs`, `bridge/protocol.mjs`, `extension/protocol.js`,
    `extension/background.js`, `test/...`, `docs/`; keine neue Berechtigung
    (`git diff -- extension/manifest.json` ⇒ leer); keine neue Abhängigkeit
    (`git diff -- package.json` ⇒ leer).
11. **Kein Geheimnis.** Beweis:
    `git grep --untracked -nE '[0-9a-f]{32,}' -- .` ⇒ keine Ausgabe, Exit 1.

**Ausnahme mit Datum (2026-11-12).** Kriterium 9 ist nur im echten Profil des
Betreibers messbar (Extension-Reload, dann ein Aufruf in einer pi-Sitzung). Es
wird **nach** dem Commit gemessen — die Ausnahme aus `CONTRIBUTING.md`, `## Acceptance`
(2026-10-23). Die Kriterien 1–8, 10 und 11 laufen **vor** dem Commit. Fällt
Kriterium 9 rot aus, wird **vorwärts** korrigiert und die rote Zeile steht in
`## Bekannte Lücken`.

## Dev plan

**Befund vor dem Bau** (aus den Dateien gelesen, nicht geschätzt):

- **Die Erweiterung liest heute kein Seiten-JSON.** `extension/background.js:2157`
  (`readPageSource`) liest DOM-Text, `:3691` (`inspectPageSource`) liest
  Element-Attribute. Für dieses Werkzeug genügt **DOM-Lesen** — der Panel-Text
  steht im Dokument, kein `wrappedJSObject` nötig (das braucht erst Teil 2 für
  die Caption-Daten).
- **Die Fehlerform des Hauses:** je Werkzeug eine Fehlerklasse mit `code`
  (`ReadError` `:1641`, `FramesError` `:5296`), ein Mapper `…ErrorFor(error)`,
  ein eigener Code und ein **eigener englischer Satz in `extensionFailureText`**
  (`bridge/mcp.mjs:1331`) — ohne den Zweig fallen die Codes auf den
  `status`-Satz und nennen die falsche Handlung.
- **Die Werkzeugtabelle wächst nur am Ende.** `TOOLS` (`bridge/mcp.mjs:63`) ist
  positionsgepinnt („Appended, never inserted", `:255`); `browser_transcript`
  wird **Position 13** (Index 12).
- **Die Protokollmethode steht doppelt:** `bridge/protocol.mjs:20` und
  `extension/protocol.js`; `test/protocol.test.js:212` vergleicht beide
  Objekte vollständig.
- **Die Werkzeugzählung ist an fünf Stellen gepinnt:** Namensarray,
  `tools.length` (`test/mcp.test.js:969`), der positionsgebundene
  `tools[11].name` (`:1181`), `TOOL_COUNT` (`test/http-mcp.test.js:51`) und
  das Namensarray dort. Sie gehört in **eine** Stufe.
- **`bridge/hub.mjs` wird nicht angefasst** (M6) — `frames` ist der Beleg,
  dass ein Werkzeug ohne Logzeile funktioniert.

1. **Protokoll, Fehlerklasse, Drahtpfad.** Dateien `bridge/protocol.mjs`,
   `extension/protocol.js`, `extension/background.js`,
   `test/protocol.test.js`, `test/extension.test.js`.
   - `METHODS.TRANSCRIPT = "transcript"` in **beiden** Kopien; ein Fall nach
     dem Muster
     `extensionAndBridgeProtocols_methodsFrames_shouldBothSpellItOutLiterally`.
   - `class TranscriptError extends Error` (Code + `message`, Muster
     `FramesError`), die Codes `TRANSCRIPT_FAILED_CODE = "transcript_failed"`,
     `NO_TRANSCRIPT_PANEL_CODE = "no_transcript_panel"` und
     `NEEDS_FOCUS_CODE = "transcript_needs_focus"`;
     `transcriptErrorFor(error)`; `answerTranscript(target, request)`; der
     Zweig in `answerRequest` **vor** dem `unsupported_method`-Fall (`:669`).
   - **Der `offset`-Fall nutzt den bestehenden Code** `offset_out_of_range`
     (`extension/background.js:106`, `docs/22`) — kein zweiter Name für
     dieselbe Sache.
   Proof: `node --test --test-reporter=tap --test-name-pattern
   extensionAndBridgeProtocols_methodsTranscript test/protocol.test.js |
   grep -c '^ok [0-9]* - extensionAndBridgeProtocols_methodsTranscript'` ⇒
   **1** (der **Name** muss im Muster stehen: `grep -c '^ok [0-9]* - '`
   zählt bei null Treffern die Dateizeile `ok 1 - test/protocol.test.js` mit
   und wäre heute schon grün);
   `npm test` ⇒ `# fail 0`, `# cancelled 0`.

2. **Das Panel öffnen und die Segmente lesen — zurückgebaut in `docs/33`.**
   *Der Schritt bleibt als Geschichte stehen; `docs/33`, Stufe 1 hat den
   Panel-Weg durch die Spurendatei ersetzt.* Dateien
   `extension/background.js`, `test/extension.test.js`.
   - Ein Snippet `transcriptPanelSource(cfg)` nach dem Muster
     `readPageSource` (`:2157`), gebaut über `pageSnippetCode`:
     **`tp-yt-paper-button#expand` nur klicken, wenn der Transkript-Knopf noch
     nicht sichtbar ist** — `#expand` ist der „mehr/weniger"-**Umschalter**,
     ein zweiter Klick klappt die Beschreibung **zu** und macht den Renderer
     unsichtbar. Beim Blättern (`offset: 20000`) wäre das der sichere Weg in
     ein falsches `no_transcript_panel`. Dann den Transkript-Knopf **über den
     Strukturanker** — die Kette aus M1, vollständig:
     `ytd-video-description-transcript-section-renderer` →
     `div#button-container` → `yt-button-shape` →
     `button.ytSpecButtonShapeNextHost` — bei **zwei** Renderern den
     **sichtbaren** (`getClientRects().length`, M1).
   - **Ist das Panel schon offen (Segmente im DOM), wird gar nichts
     geklickt** — nur gelesen. Beim Blättern (`offset: 20000`) ist das der
     Normalfall; ein Klick auf den Transkript-Knopf könnte ihn zumachen, und
     nach 5 s käme ein falsches `no_transcript_panel`.
   - **Vor allem anderen die beiden Gates, in dieser Reihenfolge:**
     1. **Ist das überhaupt eine YouTube-Watch-Seite?**
        (`location.hostname === "youtube.com"` **oder**
        `endsWith(".youtube.com")` **und** der Pfad ist `/watch`) — sonst
        `transcript_failed` mit dem Hinweis, dass das Werkzeug nur
        YouTube-Watch-Seiten liest. **Kein Suffix-Vergleich:** `notyoutube.com`
        endet auch auf `youtube.com`; und `m.youtube.com` hat ein anderes DOM
        und wird bewusst abgelehnt. **Nicht**
        `transcript_needs_focus`: auf `example.com` wäre der Hinweis auf
        `browser_focus` eine falsche Anweisung und schickte den Agenten in
        eine Schleife.
     2. **Ist die Seite gerendert?** (`ytd-watch-flexy` vorhanden) — sonst
        `transcript_needs_focus`, **ohne** Klick und **ohne** die 5-s-Frist
        (M4).
   - Ein zweites Snippet `transcriptSegmentsSource(cfg)`: die Elemente
     `transcript-segment-view-model` einsammeln, je Element den Zeitstempel
     aus `.ytwTranscriptSegmentViewModelTimestamp` und den Text aus
     `span[role="text"]`; die A11y-Zeile
     (`.ytwTranscriptSegmentViewModelTimestampA11yLabel`) wird **gar nicht
     gelesen** (M2) — sie steht nur als Kommentar neben `TEXT_SELECTOR`, damit
     niemand sie versehentlich mitnimmt.
   - **Die Bereitschaftsprüfung ist eigen:** bis zu **5 s** auf mindestens ein
     Segment warten; danach `no_transcript_panel`. **Kein** `settled`
     (M4).
   - Der Verbinder der Segmenttexte ist **ein Leerzeichen**; geschnitten wird
     **im Schnipsel** (wie `readPageSource`, nicht in der Bridge), Default
     20 000, Deckel 100 000. **`segments` ist das Fenster**: nur Segmente,
     deren Text im Fenster liegt; ein Segment, das **nur teilweise** hineinragt,
     wird **ganz** geliefert. `truncated` ist `offset + chars < totalChars`;
     `offset === totalChars` ⇒ leeres Ergebnis; `offset` dahinter ⇒
     `offset_out_of_range` mit `totalChars`; `maxChars` außerhalb 1…100 000
     oder `offset` negativ ⇒ `invalid_params`.
   - **Die neuen Fälle — es sind **achtzehn** (der Lauf meldet **19**
     `transcript_`-Tests; der neunzehnte ist der Platzhalter aus Stufe 1, den
     Stufe 2 ersetzt), und die Proofs zählen sie:**
     `transcript_segments_withThreeSegments`,
     `transcript_segments_joinsWithSingleSpace`,
     `transcript_segments_windowStartsMidSegment_shouldKeepTheSegmentWhole`,
     `transcript_segments_atTheExactEnd_shouldAnswerEmpty`,
     `transcript_segments_midSegmentOffset_shouldStillReachTheEnd`,
     `transcript_segments_surroundingWhitespace_shouldBeTrimmed`,
     `transcript_segments_withoutPanel_shouldFail`,
     `transcript_segments_offsetBeyondText_shouldFailWithTotalChars`,
     `transcript_params_outOfRange_shouldFail`,
     `transcript_panelVisible_shouldPickTheVisibleRenderer`,
     `transcript_panelAlreadyOpen_shouldNotCollapseTheDescription`,
     `transcript_expandNotClickedWhenTheButtonIsVisible_shouldLeaveTheToggleAlone`,
     `transcript_collapsedDescription_shouldClickExpandOnce`,
     `transcript_collapsedDescription_shouldWaitForTheRevealedButton`,
     `transcript_readsPanelAfterOpening_shouldNotWaitForSettled`,
     `transcript_inABackgroundTab_shouldFailWithNeedsFocus`,
     `transcript_onANonYouTubePage_shouldFail`,
     `transcript_onLookalikeHosts_shouldStillFail`,
     `transcript_buttonMissing_shouldFailWithNoPanel`.
   Proof: `node --test --test-reporter=tap --test-name-pattern transcript_segments
   test/extension.test.js | grep -c '^ok [0-9]* - transcript_segments'` ⇒ **≥ 6**
   (das **Flag vor die Datei** — Node 22 ignoriert es dahinter; und die
   **Trefferzahl** festnageln, weil ein leerer Lauf `1..0` und `# fail 0`
   liefert und damit vakuum-grün ist);
   `node --test --test-reporter=tap --test-name-pattern
   'transcript_(panelVisible|readsPanel|inABackgroundTab|buttonMissing|panelAlreadyOpen|onANonYouTubePage)'
   test/extension.test.js | grep -cE
   '^ok [0-9]+ - transcript_(panelVisible|readsPanel|inABackgroundTab|buttonMissing|panelAlreadyOpen|onANonYouTubePage)'
   ` ⇒ **≥ 6** (wieder der **Name** im Muster — ohne ihn zählt die Dateizeile
   `ok 1 - test/extension.test.js` mit);
   `npm test` ⇒ `# fail 0`, `# cancelled 0`.

3. **Das Werkzeug in der Bridge.** Dateien `bridge/mcp.mjs`,
   `test/fixtures/fake-extension.mjs`, `test/mcp.test.js`,
   `test/http-mcp.test.js`, `extension/background.js`.
   - `BROWSER_TRANSCRIPT`; der `TOOLS`-Eintrag **angehängt** (Position 13);
     `additionalProperties:false`; `offset` (Default 0, `minimum: 0`) und
     `maxChars` (Default 20 000, `minimum: 1`, `maximum: 100000`) wie bei
     `readTool` (`:740`: die Bridge prüft die **Typen**, die Bereiche die
     Extension); `UNEXPECTED_ARGUMENTS[BROWSER_TRANSCRIPT]`.
   - `TOOL_TEXTS` mit je einem deutschen Satz je Code — auch für
     `offset_out_of_range` — und ein **`extensionFailureText`-Zweig für
     `BROWSER_TRANSCRIPT`** (der Fallthrough auf `STATUS_EXTENSION_FAILED`
     steht in `bridge/mcp.mjs:1416`).
   - `test/fixtures/fake-extension.mjs`: `TRANSCRIPT_RESULT`,
     `transcriptResponse`, `BC_TEST_TRANSCRIPT_ANSWER`, `answers.transcript`,
     der `case "transcript"` in `responseFor`.
   - `test/mcp.test.js`: Namensarray + `tools.length` 12 → 13 + Schema-Pin +
     `tools/call`-Fall + je ein Fall je Fehlercode; `test/http-mcp.test.js`:
     `TOOL_COUNT` 12 → 13 und dessen Namensarray. **Der Fallname
     `mcp_toolsList_shouldOfferExactlyTheTwelveToolsOfTheContract` wird in
     `…ExactlyTheThirteenToolsOfTheContract` umbenannt** — sonst behauptet ein
     Testname das Gegenteil.
   - **Die `description` des Werkzeugs nennt die Defaults** wie bei `read`
     („`offset` — Default 0", „`maxChars` — Default 20 000, höchstens
     100 000") und den Hinweis, dass der Tab im Vordergrund sein muss
     (`browser_focus`). Der Agent erfährt die Vorgaben nur von dort.
   - **Kein `bridge/hub.mjs`-Zweig, kein `DEBUG_WHITELIST`-Eintrag** (M6).
   Proof: `grep -c 'transcript' bridge/hub.mjs` ⇒ **0**;
   `node --test --test-reporter=tap --test-name-pattern BrowserTranscript
   test/mcp.test.js | grep -c '^ok [0-9]* - mcp_toolsCallBrowserTranscript'`
   ⇒ **≥ 2** (die Hauskonvention ist `mcp_toolsCallBrowser…` — ein Muster
   `browser_transcript` träfe **keinen** Fall; und ohne den Namen im Grep
   zählt die Dateizeile mit);
   `npm test; echo $?` ⇒ 0 mit `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` ⇒ 0.

4. **Live-Messung und Abschluss (Betreiber + Orchestrator).** Kriterium 9 auf
   `v=<video-en>`: die ersten drei Segmente wörtlich notieren. Danach die
   Nachziehung der Doku aus `## Amendments`, `## Bekannte Lücken`
   fortschreiben, Prosa beschreibend, `status: active`, `## Amendments`
   entfernen, `## Open questions` auflösen, `docs/README.md`,
   `docs/ROADMAP.md` und `docs/PROJECT-STATE.md` pflegen, **committen**.
   Proof: `grep -n '^status:' docs/32-transkript-werkzeug.md` ⇒
   `status: active`; `grep -c '^## Amendments'
   docs/32-transkript-werkzeug.md` ⇒ **0** (der **Anker `^## `** ist nötig:
   ohne ihn zählt die Befehlszeile sich selbst und wird nie 0).

### What could go wrong

- **Die Segmentstruktur ist Web-Innenleben.** `.ytwTranscriptSegmentViewModelTimestamp`
  und `span[role="text"]` können morgen anders heißen (M2, Stand 2026-11-12).
  Der Fehlerfall wäre „0 Segmente" ⇒ `no_transcript_panel` nach 5 s.
- **Die Bereitschaftsprüfung ist eine Zahl, die man raten könnte.** 5 s sind
  gewählt, nicht gemessen (M4). Zu kurz ⇒ falsch-rot bei einem langsamen
  Panel; zu lang ⇒ der Aufruf hängt. Der Fall ist im Test gepinnt, die Zahl
  ist im Live-Lauf zu bestätigen.
- **Das Panel zeigt eine Übersetzung** (M3) — Teil 1 nimmt das hin. Wer die
  Antwort für „das Original" hält, irrt; deshalb nennt Teil 1 **keine**
  Sprache und behauptet keine.
- **Die A11y-Zeile ist eine Falle.** Sie steht direkt neben dem Zeitstempel
  und enthält die ausgeschriebene Zeit. Wer `textContent` des ganzen Segments
  nimmt, bekommt „0:044 SekundenDas ist eine Drei." — genau der Bandwurm, den
  `docs/31` als Artikelmodus-Fehler beschreibt.
- **Die 10 000-Zeichen-Grenze gilt nur für `browser_eval`**
  (`EVAL_RESULT_LIMIT`, `extension/background.js:304`) — dieses Werkzeug läuft
  **nicht** über `eval`; seine Grenze ist der `maxChars`-Deckel.
- **Die Werkzeugzählung ist an fünf Stellen gepinnt** — sie gehört in **eine**
  Stufe, sonst wird ein Fall grün und der andere rot.
- **Der deutsche `aria-label`** ist kein Vertrag. Der Selektor zielt auf den
  Strukturanker; ein `grep` auf „Transkript anzeigen" im Produktivcode wäre ein
  Befund.

### Wer macht welche Stufe

**Stufen 1–3: der Umsetzer**, nur `bridge/`, `extension/` und `test/`. Er
fasst **keine** `docs/`-Datei an — die Nachziehung der Werkzeugzahl ist
**Orchestrator-Arbeit** (Stufe 4), weil `CONTRIBUTING.md` dem Umsetzer das Ändern
einer Spec verbietet. Er committet nie.

**Stufe 4: der Orchestrator**, inklusive der Live-Messung, der Nachziehung der
fünf Stellen, der Abschlussprüfung und des Commits.

### Ordering and dependencies

1 → 2 → 3 → 4, jede Stufe für sich grün; keine Stufe braucht eine spätere.
Stufe 1 legt Protokoll und Fehlerklasse an, die Stufe 2 und 3 benutzen. Stufe 2
liest die Segmente, Stufe 3 stellt sie als Werkzeug bereit. Stufe 4 zuletzt,
weil sie den Ist-Zustand beschreibt und `status: active` setzt.

### What the next increment inherits

`docs/33-spurwahl.md` (Teil 2) erbt:

- **Die Route (M1):** `focus` → `expand` → Transkript-Knopf über den
  Strukturanker → Panel → Segmente; bei zwei Renderern den sichtbaren.
- **Das Segmentmodell (M2):** Zeit im ersten Div, Text im `span[role="text"]`,
  A11y-Zeile nicht.
- **Die Bereitschaftsprüfung (M4):** eigen, 5 s, **nicht** `settled`.
- **Die Sackgassen (M5):** Caption-Datei leer, innertube 400, keine
  Sprachangabe im DOM.
- **Den Fehlercode-Satz:** `transcript_failed`, `no_transcript_panel`,
  `transcript_needs_focus`, `offset_out_of_range` — Teil 2 ergänzt **keine**
  neuen Codes für dieselbe Sache.
- **Das dreizehnte Werkzeug** und seine Parametermenge; Teil 2 erweitert die
  Antwort um Sprachfelder, nicht um ein zweites Werkzeug.

## Messlauf

**Diese Zahlen beschreiben den Panel-Weg**, den `docs/33` (Stufe 1) ersetzt
hat. Sie bleiben stehen, weil die Fensterlogik unverändert ist und weil der
Satz „33 Segmente, 19 777 Zeichen" der Vergleichspunkt für den neuen Weg ist.

**Kriterium 9, gemessen am 2026-11-12** im Firefox-Profil des Betreibers
(Extension neu geladen, Bridge-Dienst neu gestartet, Aufruf über `POST /mcp`):

| Aufruf | Ergebnis |
|---|---|
| `browser_transcript({tab: 7})` auf `v=<video-en>` | 133 Segmente; die ersten drei wörtlich: „Das ist eine Drei." (0:04), „Sie ist schlampig geschrieben …" (0:06), „Es ist doch verrückt …" (0:14) — **wie M2 vorhergesagt** |
| `totalChars` | **19 777** — exakt 19 645 Zeichen Segmenttext + 132 Verbinder |
| `{offset: 19777}` (genau am Ende) | `segments: []`, `chars: 0`, `truncated: false` |
| `{offset: 19800}` (dahinter) | Fehler „Der `offset` liegt hinter dem Ende des Textes: Der Text hat 19777 Zeichen; offset 19800 liegt dahinter." (so die Antwort damals; englisch seit `docs/54`) |
| `{maxChars: 0}` | Fehler „Der Parameter ist ungültig: maxChars muss eine ganze Zahl von 1 bis 100000 sein." (so die Antwort damals; englisch seit `docs/54`) |
| Tab 7 **im Hintergrund** (nach `browser_focus` auf einen anderen Tab) | **liefert weiter Segmente** — die Seite war einmal gerendert und behält sie |
| `{tab: 8}` auf `example.org` | Fehler „Das Transkript ließ sich nicht lesen — nur YouTube-Watch-Seiten haben eines." (so die Antwort damals; englisch seit `docs/54`) |

**Zwei Dinge, die der Lauf zeigt und die vorher nur behauptet waren:**

1. **Die Sprache ist Deutsch** — für ein englisches Video. Ursache, gemessen am
   2026-11-12: die Transkript-`params` tragen die **Oberflächensprache** (`de`,
   aus `hl=de`) und werden beim Laden der Seite eingebacken — weder die
   Untertitelspur noch „Automatisch übersetzen“ noch ein Reload ändern das
   (`docs/33`, `## Messlauf`). Teil 1 gibt keine Sprache an und behauptet
   keine; das war die richtige Entscheidung.
2. **Das Vordergrund-Gate greift auf „nicht gerendert", nicht auf
   „Hintergrund".** Ein einmal gerenderter Tab funktioniert auch im
   Hintergrund — besser als die Spec versprach. Der Wortlaut in `## Ziel` und
   Stufe 2 ist entsprechend präzisiert; der Unit-Fall bleibt gültig (er bildet
   die nie gerenderte Seite ab).

## Risiken

- **Die Segmentstruktur ist Web-Innenleben** (M2). Fällt sie, fällt das
  Werkzeug — der Fehlerfall ist benannt, die Ursache nicht behebbar.
- **Die Bereitschaftsprüfung ist eine gewählte Zahl** (M4), keine gemessene.
- **Die Antwort ist in der Sprache, die YouTube gewählt hat** (M3). Teil 1
  sagt das nicht — es behauptet aber auch keine Sprache. Wer die Antwort
  falsch liest, irrt; deshalb ist die Sprachfrage **Teil 2**.

## Touch boundary

- **Anfassen:** `bridge/mcp.mjs`, `bridge/protocol.mjs`,
  `extension/protocol.js`, `extension/background.js`,
  `test/extension.test.js`, `test/mcp.test.js`, `test/http-mcp.test.js`,
  `test/protocol.test.js`, `test/fixtures/fake-extension.mjs`, `docs/05`,
  `docs/09`, `docs/20`, `docs/24` (nur die drei `TOOL_COUNT`-Zeilen),
  `docs/PROJECT-STATE.md`, `docs/README.md`, `docs/ROADMAP.md`, diese Spec.
- **Nicht anfassen:** `bridge/hub.mjs` (M6: kein Log-Zweig),
  `bridge/http-transport.mjs`, `bridge/websocket.mjs`, `bridge/config.mjs`,
  `bridge/port-owner.mjs`, `extension/manifest.json` (**keine neue
  Berechtigung**), `extension/options.html`, `extension/options.js`,
  `test/http-transport.test.js`, `test/bridge.test.js`,
  `test/deploy.test.js`, `scripts/check.mjs`, `package.json`, `INSTALL.md`,
  `docs/33-spurwahl.md` (Teil 2, eigene Spec).
- Keine neue Abhängigkeit, kein Token, kein Geheimnis.

## Bekannte Lücken

Stand 2026-11-12, **nach** der Umsetzung (Stufen 1–3 gebaut, Code-Review
`✅`):

- **Das Panel liefert die Sprache der Oberflächensprache, nicht die
  Originalspur — live gemessen am 2026-11-12.** Bei deutscher Oberfläche
  liefert `browser_transcript` für ein englisches Video deutschen Text, auch
  bei angehakter englischer Untertitelspur, auch nach einem Neuladen der
  Seite, auch bei gewählter Thai-Spur. Die Ursache steht in `docs/33`, M14.
  Teil 2 ist auf die **Spurendatei** umgeschnitten (`docs/33`, M13) und noch
  nicht gebaut: die `api/timedtext`-Adresse, die der Player selbst holt,
  liefert die ganze Spur mit Zeitstempeln (286 Cues `en`, 413 Cues `ja`).
  Bis dahin darf niemand die Antwort als Original auffassen — sie nennt auch
  keine Sprache.
- **Die Sprache der Antwort ist unbekannt.** Das DOM trägt kein Sprachfeld
  (M5), und Teil 1 fragt nicht danach. Teil 2 ist der Ort dafür.
- **Die Bereitschaftsprüfung ist eine gewählte Frist** (5 s), keine gemessene.
  Der Live-Lauf bestätigt sie oder nicht.
- **Nicht gemessen: ein Video ohne jedes Transkript.** Dass der Fehlerfall
  `no_transcript_panel` dann greift, ist logisch, nicht gemessen.
- **Nicht gemessen: mehrere Transkript-Panels in mehreren Tabs** gleichzeitig.
- **Nicht gemessen: Altersbeschränkung, private und regionsgesperrte Videos,
  Live-Streams, Shorts, Werbung, Netzwerk-Timeouts.**
- **Ein Fenster, das genau in einen Verbinder fällt** (`maxChars: 1`, `offset`
  auf dem Leerzeichen), liefert `segments: []` mit `truncated: true` und ohne
  Zahl zum Weiterrücken — der Aufrufer dreht sich im Kreis (Code-Review,
  2026-11-12). **Follow-up**, nicht blockierend.
- **`transcript_failed` reicht `details.message` nicht durch.**
  `transcript_needs_focus` tut es, für `transcript_failed` fällt die Ursache
  weg (Code-Review, 2026-11-12). **Follow-up**, nicht blockierend.

## Open questions

**Keine offenen.** Eine Vorentscheidung ist bereits gefallen:

1. **Eine textfreie Logzeile? — NEIN** (2026-11-12, mit der Spec). Wie
   `browser_frames` (M6) steht das Werkzeug nicht im Log. Eine Zeile
   `transcript tab=… segments=… chars=…` wäre möglich, verlangt aber einen
   `#reportResult`-Zweig in `bridge/hub.mjs` — ein Eingriff in eine Datei, die
   heute bewusst still ist. Das wäre eine eigene Spec.

## Review

### Runden 1–3 der gemeinsamen Fassung, 2026-11-11/12

Die gemeinsame Fassung („das Werkzeug und die Spur") wurde **dreimal**
blockiert: Runde 1 `🔧` mit 12 Blockern (M1–M12), Runde 2 `🔧` mit 8 (A1–A8),
Runde 3 `🔧` mit 8 (Major 1–8). Nach `CONTRIBUTING.md` Schritt 4 ist sie damit zu
groß und wird **geteilt**; je Befund steht eine Zeile in `## Log`.

Was diese Teilung erledigt (die Blocker, die den Leseteil betrafen):

| Blocker | Erledigt durch |
|---|---|
| Major 1 — Stufen-Nummerierung sprang (1 → 3) | Die Stufen sind neu numeriert 1–4, durchgehend, ohne Unterpunkt-Stufen |
| Major 2 — Kriterium 13 verlangte `hub.mjs` unangetastet **und** eine Logzeile | **Kein Log** für dieses Werkzeug (wie `browser_frames`); der Widerspruch ist weg |
| Major 3 — Fehlercode zweimal verschieden | **Ein** Name: `offset_out_of_range` (aus `docs/22`), kein zweiter |
| Major 4 — `source` stand in Teil 1 ohne Bedeutung | `source` ist **aus Teil 1 entfernt**; es gehört zu Teil 2, wo es den Container nennt |
| Major 5/6 — Stufen pinnten ihre Fälle nicht | Jede Stufe hat **ihren eigenen** Fallnamen-Proof |

**Was in Teil 2 bleibt:** die Spurwahl samt M7/M8 (die Kernannahme), M10
(gelieferte Sprache), M11 (Container-Kandidaten) und `source`.

### Runde 1 dieser Spec, 2026-11-12 — `🔧 Fix these`, Blocker: ja (MA-1–MA-7)

Der Reviewer hat alle zitierten Stellen nachgeschlagen und die Proof-Befehle
ausgeführt. Sieben Blocker, alle behoben:

- **MA-1:** der **Fokus-Schritt** fehlte im Werkzeug, obwohl die eigene Route
  ihn als Pflicht nennt. Entschieden vom Betreiber (2026-11-12): der **Agent**
  fokussiert vorher; das Werkzeug aktiviert **nichts** selbst und antwortet auf
  einem Hintergrund-Tab `transcript_needs_focus`. Das Ziel heißt jetzt „drei
  Aufrufe statt fünf" (vorher behauptete es „einer").
- **MA-2:** der Segmentvertrag sagte nicht, ob `segments` gefenstert ist.
  Festgelegt: **`segments` ist das Fenster**; ein Segment, das nur teilweise
  hineinragt, wird **ganz** geliefert (sonst lügt sein Zeitstempel);
  geschnitten wird **im Schnipsel**, nicht in der Bridge.
- **MA-3:** `source` stand in Teil 1 ohne Bedeutung und ohne Test.
  **Entfernt** — Teil 2 führt es ein.
- **MA-4:** der zweite Stufe-2-Proof war mit den vorgeschriebenen Testnamen
  **unerfüllbar** (`transcript_panel` trifft
  `transcript_readsPanelAfterOpening…` nicht), und `grep -c '^ok'` zählte bei
  null Treffern die Dateizeile mit. Behoben: Muster
  `transcript_(panelVisible|readsPanel|inABackgroundTab|buttonMissing)` und
  `grep -c '^ok [0-9]* - '`.
- **MA-5:** der Stufe-3-Proof suchte `browser_transcript` in
  `test/mcp.test.js` — die Hauskonvention heißt `mcp_toolsCallBrowser…`, das
  Muster hätte **keinen** Fall getroffen. Behoben: die Fälle sind benannt, der
  Proof greppt `BrowserTranscript`.
- **MA-6:** die Amendments-Tabelle zeigte auf **falsche Zeilen**
  (`:132`/`:215`/`:307` statt `:149`/`:232`/`:324`) — die Nummern waren durch
  einen eigenen Edit verschoben. Behoben: alle Nummern neu bestimmt, plus der
  Hinweis, dass sie für den Stand vom 2026-11-12 gelten.
- **MA-7:** `docs/24-frames.md` behauptet dreimal `TOOL_COUNT = 12` und stand
  in der Touch boundary unter „nicht anfassen" — die Lüge wäre dauerhaft.
  Behoben: drei Amendment-Zeilen, `docs/24` in die Boundary, und die
  Umbenennung von `…ExactlyTheTwelveTools…` in Kriterium 1.

**Übernommen: alle sieben.** Dazu die Minor-Befunde: der überflüssige
`TimestampA11yLabel`-Grep (durch den Test ersetzt), der Sichtbarkeits-Grep auf
**≥ 1** statt ≥ 2 (Verhalten prüft der Test), `totalChars` = **19 777**
(19 645 + 132 Verbinder — die alte Zahl war die Summe ohne Verbinder), drei
wörtliche Segmente in M2 (Teil 2 verglich sich mit „den ersten drei", die es
nicht gab), `offset === totalChars` als **gültiger** Fall, die Bereichsprüfung
für `offset`/`maxChars`, die vier Sprünge der Selektor-Kette (konsistent in M1
und Stufe 2), der fehlende Knopf ⇒ `no_transcript_panel`, „Das Snippet" statt
„Der Snippet", die Logzeilen-Frage als **entschieden** statt als Frage, der
Stufe-1-Proof auf den **neuen** Protokollfall, und die `description` des
Werkzeugs nennt die Defaults (wie `read`).

### Runde 2 dieser Spec, 2026-11-12 — `🔧 Fix these`, Blocker: ja (MAJ-1–MAJ-6)

- **MAJ-1:** der Stufe-1-Proof war vakuum-grün (`grep -c '^ok [0-9]* - '`
  zählt bei null Treffern die Dateizeile). Jetzt steht der **Fallname** im
  Muster.
- **MAJ-2:** Stufe 2 nannte sechs Fälle, ihre Proofs brauchten zehn. Jetzt
  sind alle Fälle ausgeschrieben und **gezählt**.
- **MAJ-3:** der Stufe-4-Proof konnte nie 0 werden — die Befehlszeile zählt
  sich selbst. Jetzt `grep -c '^## Amendments'` mit Anker.
- **MAJ-4:** `docs/33` sagte noch, `source` stehe in Teil 1. Korrigiert.
- **MAJ-5:** `#expand` ist ein Umschalter — ein zweiter Aufruf klappt die
  Beschreibung zu. Jetzt wird nur geklickt, wenn der Knopf nicht sichtbar ist.
- **MAJ-6:** auf einer Nicht-YouTube-Seite kam `transcript_needs_focus`
  (falsche Anweisung). Jetzt erst Host/Pfad prüfen ⇒ `transcript_failed`.

**Übernommen: alle sechs.**

### Runde 3 dieser Spec, 2026-11-12 — `🔧 Fix these`, Blocker: ja (R3-1–R3-5)

- **R3-1:** `truncated` und der nächste `offset` hingen an `offset + chars` —
  bei einem Fensterstart **mitten** im Segment zählt `chars` auch den Teil
  davor mit, der Rest ginge verloren. Jetzt hängen beide am **Ende des letzten
  gelieferten Segments** (`endLast`), plus der Fall
  `transcript_segments_midSegmentOffset_shouldStillReachTheEnd`.
- **R3-2:** Stufe 2 sagte „zehn", listete zwölf und ließ
  `transcript_onANonYouTubePage_shouldFail` weg — Kriterium 4 wäre nicht
  erfüllbar gewesen. Jetzt dreizehn, und der zweite Proof zählt sechs.
- **R3-3:** Runde 2 fehlte im `## Review` und der `## Log` schwieg zu
  MAJ-1–MAJ-6. Nachgetragen.
- **R3-4:** bei **offenem** Panel wurde der Transkript-Knopf trotzdem
  geklickt (Umschalter-Verdacht) — beim Blättern ein sicheres falsches
  `no_transcript_panel`. Jetzt: offen ⇒ **gar nicht klicken**.
- **R3-5:** `endsWith("youtube.com")` hätte `notyoutube.com` durchgelassen.
  Jetzt exakter Host bzw. `.youtube.com`; `m.youtube.com` bewusst abgelehnt.

**Übernommen: alle fünf.**

## Log

Je Befund eine Zeile (aus `CONTRIBUTING.md`, Schritt 4).

- **Runden 1–3 der gemeinsamen Fassung: durch Teilung erledigt** — die
  Blockerbefunde stehen im `## Review` oben; was den Leseteil betraf, ist dort
  mit seinem Fix benannt, der Rest ist in `docs/33-spurwahl.md`.
- **MA-1–MA-7: übernommen** (Review-Runde 1 dieser Spec) — alle sieben
  Blocker, siehe `## Review`.
- **MAJ-1–MAJ-6: übernommen** (Review-Runde 2) — alle sechs, siehe `## Review`.
- **R3-1–R3-5: übernommen** (Review-Runde 3) — alle fünf, siehe `## Review`.
- **Kriterium 9 live gemessen und grün** (2026-11-12, Betreiberprofil): Segmente
  mit Zeitstempeln, `totalChars` = 19 777 wie vorhergesagt, die Randfälle
  (`offset` am Ende, dahinter, `maxChars: 0`) und die beiden Gates verhalten
  sich wie spezifiziert. Details in `## Messlauf`.
- **Der Sprachbefund aus dem Messlauf bestätigt Teil 2:** das englische Video
  liefert **deutschen** Text — YouTubes Übersetzung. Genau dafür gibt es
  `docs/33-spurwahl.md`.
- **Wortlaut nachgezogen** (2026-11-12, nach dem Messlauf): die Bedingung des
  Vordergrund-Gates ist „Seite nicht gerendert", nicht „Tab im Hintergrund".
  Ein einmal gerenderter Tab funktioniert auch im Hintergrund. Die Spec sagt
  das jetzt so; das Verhalten ist besser als das Versprechen, nicht schlechter.
- **Minor-Befunde der Runde 1: übernommen** — `totalChars` 19 777, drei
  wörtliche Segmente in M2, `offset === totalChars` gültig, Bereichsprüfung,
  vier Sprünge, fehlender Knopf, „Das Snippet", Logfrage entschieden,
  Stufe-1-Proof auf den neuen Fall, `description` mit Defaults.
- **Der Betreiber hat den Fokus entschieden** (2026-11-12): der Agent ruft
  `browser_focus` vorher; das Werkzeug aktiviert nichts selbst und antwortet
  `transcript_needs_focus`.
- **Teilung (2026-11-12):** nach dem dritten Block in Teil 1 (diese Spec,
  Lesen) und Teil 2 (`docs/33-spurwahl.md`, Spurwahl) geteilt. Der Betreiber
  hat die Naht bestätigt („Lesen zuerst, Spurwahl danach"). Grund: das Lesen
  ist gemessen (M1–M3), die Spurwahl nicht (Teil 2, M7/M8).
- **Die Betreiberregel aus `docs/31`** („Originalspur, außer sie ist nicht
  englisch oder deutsch, dann die englische Übersetzung") ist **Teil 2**; Teil 1
  enthält keinen Satz dazu.
