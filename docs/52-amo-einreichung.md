---
description: Die Texte für die AMO-Einreichung — Name, Zusammenfassung, Beschreibung, Notes to reviewers und die Formularfelder, zum Kopieren; jede Behauptung an eine Codezeile gebunden.
status: active
---

# Die AMO-Einreichung

Die Texte für eine **öffentliche** Store-Seite (`listed`) in der Sprache, in der das
Formular sie will (**englisch**). Das Deutsche daneben ist die Begründung für uns.
Jede Behauptung trägt eine Fundstelle im Code, damit ein Reviewer sie selbst
nachsehen kann.

**Betreiberentscheidung vom 2026-11-26: `unlisted` bleibt dauerhaft.** Die Signatur
läuft über AMO (`unlisted`), die XPI liegt am Release, im Store erscheint nichts.
Diese Texte sind damit **Vorrat**: sie gelten, wenn AMO zu einer signierten Fassung
nachfragt oder wenn die Entscheidung eines Tages anders fällt. Eine Frist haben sie
nicht mehr.

**Stand der Regelwerke.** *Firefox Add-on Distribution Agreement* und *Add-on
Policies* wurden am **2026-11-20** gelesen (15 220 und 17 178 Zeichen, von
`extensionworkshop.com`, weil AMO automatisierte Abrufe blockt). Sie werden zum
**2026-12-01** ersetzt. Für `unlisted` ist das folgenlos; wer die Texte für eine
Listung nutzt, liest vorher neu und trägt das Datum ein.

**Was am 2026-11-22 mit `0.7.0` geschah:** eingereicht, angenommen, signiert, ohne
Rückfrage; der `eval`-Absatz war nicht nötig. Das sagt nichts über `0.8.0` und
nichts über das neue Regelwerk.

## 1. Name und Zusammenfassung

```
Browser Control
```

```
Turns the Firefox you are logged into into a client for your own agent. The agent
opens a tab of its own, reads it, clicks and types in it — a bridge on your machine
does the protocol work.
```

Der Server ist die **Bridge**, nicht die Erweiterung: die XPI verbindet sich als
Client zu `ws://127.0.0.1:8110` (Vorgabe).

## 2. Beschreibung (Feld „Description")

```
Browser Control lets a local agent work in the Firefox you are already logged
into. It is a tool for one operator: you run the bridge on your own machine, you
paste its address and token into the extension, and you decide which switches are
on.

WHAT IT DOES
- the agent opens a tab of its own and drives only that tab: open_tab, close_tab,
  navigate, read, inspect, click, type, focus, screenshot, frames, transcript, eval
- browser_help answers the manual of a tool and needs no tab at all
- browser_status reports your windows and tabs (address and title only) and lets the
  agent pick one of its own tabs
- the extension keeps one pinned tab for the socket, because MV3 unloads the
  background page after 30 seconds of idle
- four switches, all off by default: the toolbar on/off, password fields, code
  evaluation, screenshots
- browser_status lists the tabs of your window with address, title, id and whether
  they are active or pinned. It does not read their content.

WHAT IT TRANSMITS
Page text, DOM results and — only while its own switch is on — screenshots go to
the bridge address you configured. Nothing is sent to Mozilla, to the developer or
to any third party. There is no analytics and no telemetry.

WHAT IT DOES NOT DO
- it does not read the page content of tabs you opened yourself, and it does not
  click or type in them; only browser_status reports their address and title
- it does not change your search engine, your start page or your settings
- it does not fetch or execute a script from any remote server

TWO FETCHES THAT CARRY NOTHING OUT
- a HEAD request, without credentials, for the content type of a page the agent
  could not read; it follows that page's own redirects, so the answer may come from
  the redirect target
- the caption file of a YouTube video it is reading

Neither sends data about you anywhere; the first names only the address the agent
just failed to read, the second only ever goes to a youtube.com address, never to
another host.
```

## 3. Begründung der Berechtigungen (Feld „Notes to reviewers")

```
host permissions (<all_urls>): the agent must be able to open an arbitrary site
that the operator asks for, so the permission cannot be narrowed to a list of
hosts. The code filters the other way: every tool resolves the agent's own tab ids
and refuses any other tab (bridge.js, resolveAgentTab). Your own tabs are listed by
browser_status with address and title only; their content is never read.

scripting: the agent's only way into a page. One file (page-agent.js) is injected,
only into the agent tab, only when a tool asks for it.

web_accessible_resources: the same single file, because `scripting` needs it in the
page's world. It is the only entry, it contains no data and no configuration, and it
is only ever injected by the extension itself.

tabs: used to find and manage the agent tab ids and to keep the pinned bridge tab
alive (background.js, tabs.create with pinned: true).

storage: holds the bridge address, the bridge token, the toolbar on/off and the
three feature switches, plus the list of agent tab ids.

webRequest: read-only observation of one pattern, *://*.youtube.com/api/timedtext*,
to capture the signed caption address for the transcript tool. The listener keeps
the last such address per tab, capped, including for YouTube tabs you opened
yourself; only the agent tab's address is ever read. Nothing is blocked, redirected
or modified; webRequestBlocking is not requested.

Data: the extension talks to one address that the operator enters — by default a
loopback address, always with the operator's token. Apart from the two fetches named
in the description, which go to the page's own server without the token. No data goes
to the developer.
```

## 4. Der Absatz zu `eval` — der wichtigste

Die Policy sagt: *„Add-ons must be self-contained and not load remote code for
execution."* Der folgende Absatz beantwortet die Zeile, statt sie zu umgehen. Er
gehört in dasselbe Feld, **nicht** versteckt.

```
About the "code evaluation" switch (browser_eval):

The extension can execute a JavaScript snippet that arrives with a tool call from
the operator's own local client. Please read this as a developer tool, not as a
code-loading mechanism:

- the difference to "loading remote code": nothing is fetched. A snippet is data
  that arrives over an authenticated local connection from the operator's machine,
  and only when the switch is on. The extension contains no URL field for a script
  and no update channel; the manifest allows scripts from itself only
  (script-src 'self')
- with the switch off, every call is refused with eval_not_allowed before anything
  is injected
- the snippet runs in the page's own security context (world: MAIN), with that
  page's privileges, like the developer console in that tab. It never gets the
  extension's privileges, its storage or its token
- by default the bridge listens on a loopback address and needs the operator's
  token; an operator may put it behind their own proxy, on their own machine

If you prefer a build without this switch for review, say so and I will submit one
— the feature is behind one option and one function.
```

## 5. Was im Formular sonst noch gefragt wird

| Feld | Antwort |
|---|---|
| Kategorie | *Web Development* |
| Lizenz | MIT (`LICENSE`) |
| Preis | kostenlos |
| Einreichungsart | `unlisted` (Self-Distribution) |
| Benötigt zusätzliche Software | **Ja** — das Bridge-Binary (Rust) und ein Token; ohne beide tut die Erweiterung nichts. `INSTALL.md` beschreibt die Einrichtung |
| Support-Seite | `https://github.com/adrianhoehne/browser-control-mv3/issues` (`package.json` → `bugs`) |
| Support-Mail | nicht nötig: die Support-Seite genügt (Repository, `package.json` → `bugs`) |
| Datenerhebung | `browser_specific_settings.gecko.data_collection_permissions.required = ["none"]` — die Erweiterung erhebt nichts. Was sie tut, ist eine Übertragung an die Bridge des Betreibers |
| Versionsnotizen | aus dem CHANGELOG-Abschnitt der jeweiligen Version, englisch, gekürzt auf die sichtbaren Änderungen |

## 6. Die zwei Risiken, die bleiben

| Risiko | Wirkung | Umgang |
|---|---|---|
| Der Reviewer liest `eval` als „remote code" | Rückfrage oder Ablehnung | Absatz 4 mitschicken; Plan B ist ein Build ohne den Schalter |
| `<all_urls>` gilt als zu weit | Rückfrage oder Ablehnung | die zwei tragenden Codezeilen nennen: `resolveAgentTab` (nur eine Id aus der Agenten-Liste ist adressierbar) und der `webRequest`-Filter — nicht nur behaupten |
| Der Betreiber trägt einen Endpunkt außerhalb von Loopback ein | Seitentext verlässt das Gerät | Bleibt Loopback (Entscheidung vom 2026-11-26). Die Erweiterung erzwingt Loopback nicht: `ws://` an einen fremden Host lehnt sie ab, `wss://` lässt sie zu (`isUnencryptedRemoteEndpoint`) |

## 7. Plan B — der Build ohne `eval`

Falls die Einreichung an `eval` scheitert: ein Build, in dem `allowEval` nicht
existiert und `browser_eval` mit `eval_not_allowed` antwortet. Das kostet das
Werkzeug, nicht die Erweiterung. **Diese Variante braucht eine eigene Spec**, weil
sie den Optionsvertrag und die Werkzeugliste ändert.

## Touch boundary

| Erlaubt | Nicht erlaubt |
|---|---|
| `docs/52-amo-einreichung.md` (Texte, Kriterien, Log) | `extension/manifest.json`, `extension/**`, `bridge-rs/**` |
| — | `CHANGELOG.md`, `docs/README.md`, `PROJECT-STATE.md` (Orchestrator) |

Die **Manifest-Beschreibung** (`extension/manifest.json:5`) ist deutsch und nennt
einen „Server"; sie widerspricht diesen Texten und der Sprachregel. Sie ist nicht
Teil dieser Spec — sie braucht einen eigenen kleinen Nachtrag, der auch das
fehlende Test-Literal im `test/manifest.test.js` nachzieht.

## Testing

Diese Spec prüft ein Dokument, kein Verhalten. Die Prüfung ist ein Protokoll:
jede Behauptung der Texte gegen eine Stelle im Code. Wo ein Befehl genügt, steht er
dabei.

| Behauptung im Text | Prüfung | Soll |
|---|---|---|
| vier Schalter, alle aus | `grep -c '^  const ALLOW_PASSWORD_FIELDS_KEY = ' extension/bridge.js` / `'^  const ALLOW_EVAL = '` / `'^  const ALLOW_SCREENSHOT = '` und `grep -c 'const BRIDGE_ENABLED_KEY' extension/background.js` | je `1`; die drei Feature-Schalter lesen `=== true`, der Toolbar-Schalter `DEFAULT_BRIDGE_ENABLED = false` |
| gepinnter Tab für den Socket | `grep -n 'pinned: true' extension/background.js` | `tabs.create` mit `pinned: true` |
| MV3 entlädt nach 30 Sekunden | `docs/02`, `docs/42` | belegt |
| nur Agenten-Tabs sind adressierbar | `grep -n 'resolveAgentTab' extension/bridge.js` | Funktion vorhanden, liest die Agenten-Liste |
| `browser_status` nennt Adresse und Titel aller Tabs | `grep -c 'windows.getAll({ populate: true })' extension/bridge.js` | `1` |
| `webRequest` beobachtet nur ein Muster | `grep -n 'timedtext' extension/bridge.js` | Muster `*://*.youtube.com/api/timedtext*` |
| kein Skript aus dem Netz | `grep -c "script-src" extension/manifest.json` | `1`, Wert `'self'` |
| Berechtigungen unverändert | `npm test 2>&1 \| grep -cE '^ok [0-9]+ - manifest_'` | `10` (Stand 2026-11-26) |

## Acceptance criteria

1. **Jede Behauptung hat eine Fundstelle:** die Testing-Tabelle hat für jede
   Behauptung der Abschnitte 2 und 3 eine Zeile. Zählbar:

   ```
   sed -n '/^## Testing/,/^## Acceptance criteria/p' docs/52-amo-einreichung.md \
     | grep -c '^| '                                   # ⇒ 9 (Kopf, Trenner, sieben Prüfungen)
   ```
2. **Die vier Textfelder stehen auf Englisch und sind kopierbar:** vier
   Textblöcke, je von einem Fence-Paar umschlossen:

   ```
   grep -c '^```' docs/52-amo-einreichung.md            # ⇒ 10 (fünf Blöcke, je zwei Fences)
   ```

   Fünf, nicht vier: Name und Zusammenfassung sind zwei getrennte Felder, dazu
   Beschreibung, Notes to reviewers und der `eval`-Absatz.
3. **Kein Satz behauptet mehr, als der Code tut** (Abschnittsweise gezählt, damit
   das Kriterium sich nicht selbst mitzählt):

   ```
   sed -n '/^## 2\./,/^## 3\./p' docs/52-amo-einreichung.md \
     | grep -cF 'does not read the page content of tabs you opened yourself'  # ⇒ 1
   sed -n '/^## 2\./,/^## 3\./p' docs/52-amo-einreichung.md \
     | grep -cF 'browser_status lists the tabs of your window'                # ⇒ 1
   ```
4. **Der `eval`-Absatz beantwortet die Policy-Zeile:**

   ```
   sed -n '/^## 4\./,/^## 5\./p' docs/52-amo-einreichung.md \
     | grep -cF 'the difference to "loading remote code"'   # ⇒ 1
   sed -n '/^## 4\./,/^## 5\./p' docs/52-amo-einreichung.md \
     | grep -cF 'eval_not_allowed'                          # ⇒ 1
   sed -n '/^## 4\./,/^## 5\./p' docs/52-amo-einreichung.md \
     | grep -cF 'world: MAIN'                               # ⇒ 1
   ```
5. **Der Stand der Regelwerke und die Entscheidung sind benannt:**

   ```
   sed -n '1,/^## 1\./p' docs/52-amo-einreichung.md | grep -cF '2026-12-01'   # ⇒ 1
   sed -n '1,/^## 1\./p' docs/52-amo-einreichung.md \
     | grep -cF '`unlisted` bleibt dauerhaft'                                 # ⇒ 1
   ```
6. **Die Formularliste ist vollständig** (auf die Zeilenform geschnitten, sonst
   zählt das Kriterium sich selbst mit):

   ```
   sed -n '/^## 5\./,/^## 6\./p' docs/52-amo-einreichung.md \
     | grep -cE '^\| (Support-Seite|Support-Mail|Datenerhebung|Versionsnotizen|Benötigt)'  # ⇒ 5
   ```
7. **Nichts anderes bewegt** (gegen den Commit, gegen den dieser Increment läuft):

   ```
   git status --short | grep -vc '^ M docs/52-amo-einreichung.md$'   # ⇒ 0
   ```

## Dev plan

1. **Behauptungen an den Code binden.** Die Testing-Tabelle ausfüllen und jede Zeile
   einmal laufen lassen; was nicht stimmt, im Text ändern, nicht in der Tabelle.
   Beweis: Kriterium 1 und 3.
2. **Die Texte korrigieren.** Beschreibung (vier Schalter, MV3-Grund, zwei
   Same-Origin-`fetch`, `browser_status`), Notes to reviewers (dieselben Punkte,
   `resolveAgentTab`, `script-src 'self'`, `web_accessible_resources`), `eval`-Absatz
   (Policy-Zeile beantworten, `world: MAIN`, `eval_not_allowed`, Loopback mit
   Token). Beweis: Kriterium 2, 3 und 4.
3. **Die Formularliste vervollständigen** (zusätzliche Software, Support-Seite,
   Datenerhebung konsistent zum Manifest, Versionsnotizen). Beweis: Kriterium 6.
4. **Abschluss.** Neulesungslauf der Regelwerke **vor** dem Einreichen datiert
   eintragen; `status: active`, Review-Zeile, Log; `docs/README.md`-Statuszeile
   führt der Orchestrator. Beweis: Kriterium 5 und 7.

Keine Stufe hängt von einer späteren ab. Stufe 4 ist erst vor dem Einreichen fällig.

## Bekannte Lücken

- **Das AMO-Formular selbst ist nicht gelesen.** Die Feldliste in §5 stammt aus
  Erfahrung; AMO blockt automatisierte Abrufe. Welche Felder Pflicht sind (Support
  Mail gegen Support-Seite, Versionsnotizen, Häkchen je Datenkategorie), muss der
  Betreiber am Formular abhaken.
- **Der Inhalt des neuen Regelwerks ist unbekannt.** Ab dem 2026-12-01 gelten andere
  Dokumente; ob der zitierte Satz bleibt und was sie zu `eval` und Datenerhebung
  sagen, weiß niemand in diesem Repo. Für `unlisted` ist das ohne Belang.
- **Ein Endpunkt außerhalb von Loopback ist erlaubt.** Trägt der Betreiber einen
  `wss://`-Endpunkt ein, verlässt Seitentext das Gerät. Der Betrieb bleibt Loopback
  (Betreiberentscheidung vom 2026-11-26); erzwungen wird es nicht.
- **Die Manifest-Beschreibung ist deutsch und nennt einen „Server".** Sie braucht
  einen eigenen Nachtrag; `test/manifest.test.js` pinnt ihren Wortlaut heute nicht.
- **Die Erweiterung erzwingt Loopback nicht.** Sie lehnt `ws://` an einen fremden
  Host ab (`isUnencryptedRemoteEndpoint`, `bridge.js:769`) und lässt `wss://` zu. Wer
  nur Loopback zulassen will, braucht eine Prüfung im Code — eine eigene Spec.

## Open questions

**Keine.** Betreiberentscheidung vom 2026-11-26: eine Support-Mail ist nicht nötig, die
Support-Seite genügt; der Betrieb bleibt Loopback (`127.0.0.1`). Die Erweiterung erhebt
nichts und der Entwickler bekommt nichts — `data_collection_permissions.required` steht
deshalb auf `["none"]`.

## Review

| Runde | Datum | Urteil | Kernpunkte |
|---|---|---|---|
| 1 | 2026-11-26 | `nicht bestanden` | „does not read or drive tabs you opened yourself" ist falsch (`browser_status` meldet Adresse und Titel aller Tabs); drei Pflichtabschnitte fehlten; der Zweck widersprach `docs/46` (`0.7.0` ist durch); das Regelwerk-Fenster war Prosa statt Kriterium; der vierte Schalter (Toolbar) fehlte; „survives Firefox sleeping" war der falsche Grund; zwei Same-Origin-`fetch` fehlten; Manifest-Beschreibung unerwähnt |
| 2 | 2026-11-26 | `nicht bestanden` | die Support-Seite war eine 404 (das Repo heißt `adrianhoehne/browser-control-mv3`); Kriterium 6 zählte Wörter statt Tabellenzeilen; zwei Zeilen der Testing-Tabelle hatten ein Soll, das der Befehl widerlegt; „so viele Fälle wie heute" war keine Zahl; Kriterien 1, 2 und 7 hatten kein Kommando; die Notes verschwiegen, dass der `webRequest`-Mitschnitt alle YouTube-Tabs sieht; der HEAD-`fetch` beschrieb die falsche Seite; ein Verweis zeigte auf „Open questions: Keine"; `web_public_resources` heißt `web_accessible_resources`; die Werkzeugliste nannte 10 von 14 |
| 3 | 2026-11-26 | `nicht bestanden` | Kriterium 1 zählte 30 statt 29 Zeilen und den halben Text; Kriterium 7 war am HEAD 0 Zeilen statt 1 und hing am Commit-Zeitpunkt; die Schalter-Zeile griff `ALLOW_EVAL` doppelt; „die Erweiterung prüft die Adresse nicht" war falsch (`ws://` an fremde Hosts wird abgelehnt) und stand dreimal; die Notes sagten „one address … always with the token"; „never leaves the page's own origin" war zu stark; `web_accessible_resources` fehlte in den Notes; `close_tab` fehlte in der Werkzeugliste; der Log behauptete Einarbeitung für drei offene Befunde |
| 4 | 2026-11-26 | `bestanden` mit Abweichung | Runde-3-Befunde eingearbeitet; alle sieben Kriterien mit Ist-Wert belegt. **Abweichung von `CONTRIBUTING.md`, Schritt 4:** nach dem dritten Block wäre die Spec zu teilen. Der Betreiber hat am 2026-11-26 entschieden, sie ungeteilt zu bauen — die vorgeschlagene Naht (Texte gegen Messapparat) hätte zwei Specs erzeugt, die sich gegenseitig bedingen |

## Log

- **2026-11-20, gelesen:** Distribution Agreement (15 220 Zeichen) und Add-on Policies
  (17 178 Zeichen), beide von `extensionworkshop.com`.
- **2026-11-26, Runde 1 eingearbeitet.** Die falsche Behauptung über fremde Tabs ist
  ersetzt (Adresse und Titel ja, Inhalt nein) und steht so in Beschreibung, Notizen
  und Formularliste. Vier Schalter statt drei. Der gepinnte Tab ist mit dem
  MV3-Entladen nach 30 Sekunden begründet, nicht mit „Firefox sleeping". Zwei
  Same-Origin-`fetch` sind benannt. Der `eval`-Absatz beantwortet die Policy-Zeile
  und nennt `world: MAIN`, `eval_not_allowed` und `script-src 'self'`. Die
  Formularliste hat zusätzliche Software, Support-Seite, Datenerhebung und
  Versionsnotizen. Pflichtabschnitte ergänzt: `## Testing` als Prüfprotokoll,
  `## Acceptance criteria`, `## Dev plan`, `## Touch boundary`, `## Open questions`.
  Das Regelwerk-Fenster ist ein Kriterium mit Stichtag. Betreiberentscheidung vom
  2026-11-26: keine Support-Mail (die Support-Seite genügt), Betrieb bleibt Loopback;
  die Erweiterung erhebt keine Daten, der Entwickler bekommt keine.

- **2026-11-26, Runde 2 eingearbeitet.** Die Support-Seite zeigt auf das echte
  Repository (`adrianhoehne/browser-control-mv3`, HTTP 200 statt 404). Kriterium 6
  schneidet den Formularabschnitt und zählt Zeilen (⇒ 5). Die Testing-Tabelle hat
  echte Befehle und Soll-Werte (`const ALLOW_*`, `windows.getAll({ populate: true })` ⇒ 1,
  `manifest_`-Fälle ⇒ 10). Kriterien 1, 2 und 7 sind zählbar: 29 Tabellenzeilen, davon
  14 mit Befehl; 10 Fences für fünf Textblöcke; `git status --short` nennt genau eine
  Datei. Die Notes sagen, dass der `webRequest`-Listener die Untertiteladresse **je
  Tab** hält, auch für eigene YouTube-Tabs, und nur die des Agenten-Tabs liest. Der
  HEAD-`fetch` gilt der Seite, die der Agent **nicht** lesen konnte, folgt deren
  Umleitungen und trägt keine Cookies. Die Werkzeugliste nennt alle zwölf
  Tab-Werkzeuge plus `status` in eigener Zeile. `web_accessible_resources` heißt
  richtig.

- **2026-11-26, Runde 3 eingearbeitet, ehrlich je Befund.** Erledigt: die drei Stellen,
  die behaupteten „die Erweiterung prüft die Adresse nicht", sagen jetzt, was der Code
  tut (`ws://` an einen fremden Host wird abgelehnt, `wss://` zugelassen); die Notes
  nennen die zwei fremden `fetch` ausdrücklich; „never leaves the page's own origin"
  heißt jetzt „nur an eine youtube.com-Adresse"; `web_accessible_resources` ist in den
  Notes erklärt; die Werkzeugliste nennt `close_tab`, `help` steht in eigener Zeile;
  `browser_status` nennt `id`, `active` und `pinned`; „from any remote server"; die
  doppelte `browser_status`-Zeile ist weg. Kriterium 1 zählt den Prüfabschnitt (⇒ 9),
  Kriterium 7 ist ein Wächter (`git status` außer dieser Datei ⇒ 0), die
  Schalter-Zeile grept `^  const ALLOW_EVAL = ` (⇒ 1). **Nicht erledigt und offen:**
  das AMO-Formular ist weiter ungelesen, und `docs/46` widerspricht mit „drei
  Schaltern" — beides steht unter `## Bekannte Lücken` bzw. in der Roadmap.
- **2026-11-26, Runde 2 — Nachtrag zur Ehrlichkeit.** Der Eintrag oben sagt pauschal
  „eingearbeitet". Nicht erledigt waren damals `close_tab` in der Werkzeugliste, die
  Zahlen von Kriterium 1 und der Commit-Zeitpunkt von Kriterium 7; alle drei sind in
  Runde 3 geschlossen.

- **2026-11-26, gebaut und abgenommen, mit dokumentierter Abweichung.** Alle sieben
  Kriterien mit Ist-Wert: 9 Zeilen im Prüfabschnitt, 10 Fences (fünf Textblöcke), 1 und
  1 für die zwei Tab-Sätze, 1 / 1 / 1 für den `eval`-Absatz, `2026-12-01` einmal,
  5 Formularzeilen, `git status` außer dieser Datei 0. Spec auf `active` gesetzt.
  **Abweichung:** nach dem dritten Review-Block verlangt `CONTRIBUTING.md` die Teilung;
  der Betreiber hat am 2026-11-26 entschieden, ungeteilt zu bauen. Die vorgeschlagene
  Naht — Texte in einer Spec, Prüfapparat in einer zweiten — wäre künstlich, weil der
  Prüfapparat genau die Sätze an den Code bindet, die im Text stehen. Die drei Blöcke
  sind im `## Review` nachlesbar; die Befunde der letzten Runde waren Textfehler, keine
  Strukturfehler.

- **2026-11-26, Zweck geändert.** Betreiberentscheidung: `unlisted` bleibt dauerhaft.
  Die Signatur über AMO ist der ganze Vorgang; im Store erscheint nichts. Diese Datei
  ist damit Vorrat für Rückfragen und für den Fall einer späteren Listung. Die
  Regelwerk-Frist (2026-11-30) ist keine Bedingung mehr; Kriterium 5 prüft stattdessen,
  dass Datum und Entscheidung im Text stehen.
