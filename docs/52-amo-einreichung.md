---
description: Die Texte für die AMO-Einreichung — Name, Zusammenfassung, Beschreibung, Notes to reviewers und die Formularfelder, zum Kopieren; jede Behauptung an eine Codezeile gebunden.
status: proposed
---

# Die AMO-Einreichung

Die Texte für die nächste Einreichung (`0.8.0`, unsigniert) in der Sprache, in der
das Formular sie will (**englisch**). Das Deutsche daneben ist die Begründung für
uns. Jede Behauptung trägt eine Fundstelle im Code, damit der Reviewer sie selbst
nachsehen kann.

**Gültigkeit der Regelwerke.** *Firefox Add-on Distribution Agreement* und *Add-on
Policies* wurden am **2026-11-20** gelesen (15 220 und 17 178 Zeichen, von
`extensionworkshop.com`, weil AMO automatisierte Abrufe blockt). Beide werden zum
**2026-12-01** ersetzt — diese Texte gelten deshalb für Einreichungen **bis
2026-11-30**. Danach ist ein datierter Neulesungslauf nötig, bevor sie wieder
Vorlage sind. Die Zeichenzahlen sind ein Schnappschuss der ersetzten Seiten und
taugen nach dem Stichtag nicht als Beleg.

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
- the agent opens a tab of its own and drives only that tab: status, navigate,
  read, inspect, click, type, screenshot, frames, transcript, help
- the extension keeps one pinned tab for the socket, because MV3 unloads the
  background page after 30 seconds of idle
- four switches, all off by default: the toolbar on/off, password fields, code
  evaluation, screenshots
- browser_status lists the tabs of your window with their address and title. It
  does not read their content.

WHAT IT TRANSMITS
Page text, DOM results and — only while its own switch is on — screenshots go to
the bridge address you configured. Nothing is sent to Mozilla, to the developer or
to any third party. There is no analytics and no telemetry.

WHAT IT DOES NOT DO
- it does not read the page content of tabs you opened yourself, and it does not
  click or type in them; only browser_status reports their address and title
- it does not change your search engine, your start page or your settings
- it does not fetch or execute a script from any server

TWO FETCHES THAT STAY ON THE PAGE'S OWN SERVER
- a HEAD request for the content type of the page the agent already reads
- the caption file of a YouTube video it is reading

Neither carries data anywhere; both go to the same server as the page itself.
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

tabs: used to find and manage the agent tab ids and to keep the pinned bridge tab
alive (background.js, tabs.create with pinned: true).

storage: holds the bridge address, the bridge token, the toolbar on/off and the
three feature switches, plus the list of agent tab ids.

webRequest: read-only observation of one pattern, *://*.youtube.com/api/timedtext*,
to capture the signed caption address for the transcript tool. Nothing is blocked,
redirected or modified; webRequestBlocking is not requested.

Data: the extension talks to one address that the operator enters — by default a
loopback address, always with the operator's token. No data goes to the developer.
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
| Support-Seite | `https://github.com/adrian/browser-control/issues` (`package.json`, `bugs`) |
| Support-Mail | offen, siehe `## Open questions` |
| Datenerhebung | `browser_specific_settings.gecko.data_collection_permissions.required = ["none"]` — die Erweiterung erhebt nichts. Was sie tut, ist eine Übertragung an die Bridge des Betreibers |
| Versionsnotizen | aus dem CHANGELOG-Abschnitt der jeweiligen Version, englisch, gekürzt auf die sichtbaren Änderungen |

## 6. Die zwei Risiken, die bleiben

| Risiko | Wirkung | Umgang |
|---|---|---|
| Der Reviewer liest `eval` als „remote code" | Rückfrage oder Ablehnung | Absatz 4 mitschicken; Plan B ist ein Build ohne den Schalter |
| `<all_urls>` gilt als zu weit | Rückfrage oder Ablehnung | die zwei tragenden Codezeilen nennen: `resolveAgentTab` (nur eine Id aus der Agenten-Liste ist adressierbar) und der `webRequest`-Filter — nicht nur behaupten |
| Der Betreiber trägt einen Endpunkt außerhalb von Loopback ein | Seitentext verlässt das Gerät, „none" ist nicht mehr die ganze Wahrheit | Betreiberentscheidung: bleibt die Erweiterung auf Loopback beschränkt, oder sagt die Erklärung „an die Adresse, die der Betreiber einträgt" |

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
| vier Schalter, alle aus | `grep -n 'allowPasswordFields\|allowEval\|allowScreenshot' extension/bridge.js \| head -3` und `grep -n 'bridgeEnabled' extension/background.js \| head -2` | je ein Treffer, Default `=== true` gelesen |
| gepinnter Tab für den Socket | `grep -n 'pinned: true' extension/background.js` | `tabs.create` mit `pinned: true` |
| MV3 entlädt nach 30 Sekunden | `docs/02`, `docs/42` | belegt |
| nur Agenten-Tabs sind adressierbar | `grep -n 'resolveAgentTab' extension/bridge.js` | Funktion vorhanden, liest die Agenten-Liste |
| `browser_status` nennt Adresse und Titel aller Tabs | `grep -n 'windows.getAll' extension/bridge.js` | ein Treffer, `populate: true` |
| `webRequest` beobachtet nur ein Muster | `grep -n 'timedtext' extension/bridge.js` | Muster `*://*.youtube.com/api/timedtext*` |
| kein Skript aus dem Netz | `grep -c "script-src" extension/manifest.json` | `1`, Wert `'self'` |
| Berechtigungen unverändert | `npm test 2>&1 \| grep -cE '^ok [0-9]+ - manifest_'` | so viele Fälle wie heute, keiner rot |

## Acceptance criteria

1. **Jede Behauptung hat eine Fundstelle:** die Testing-Tabelle ist vollständig, und
   jede Zeile ist mit dem genannten Befehl geprüft.
2. **Die vier Textfelder stehen auf Englisch und sind kopierbar:** Name,
   Zusammenfassung, Beschreibung und Notes to reviewers stehen je in einem
   Codeblock, ohne deutschen Fließtext darin.
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
5. **Das Regelwerk-Fenster ist entscheidbar:**
   `grep -cF 'bis 2026-11-30' docs/52-amo-einreichung.md` ⇒ `1`, und
   `grep -cF '2026-12-01' docs/52-amo-einreichung.md` ⇒ mindestens `1`.
6. **Die Formularliste ist vollständig:** `grep -cF 'Benötigt zusätzliche Software'
   docs/52-amo-einreichung.md` ⇒ `1`, ebenso für `Support-Seite`, `Datenerhebung`
   und `Versionsnotizen`.
7. **Nichts anderes bewegt:** `git status --short` nennt nur diese Spec (und
   `docs/README.md`, das der Orchestrator führt).

## Dev plan

1. **Behauptungen an den Code binden.** Die Testing-Tabelle ausfüllen und jede Zeile
   einmal laufen lassen; was nicht stimmt, im Text ändern, nicht in der Tabelle.
   Beweis: Kriterium 1 und 3.
2. **Die Texte korrigieren.** Beschreibung (vier Schalter, MV3-Grund, zwei
   Same-Origin-`fetch`, `browser_status`), Notes to reviewers (dieselben Punkte,
   `resolveAgentTab`, `script-src 'self'`, `web_public_resources`), `eval`-Absatz
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
  sagen, weiß niemand in diesem Repo.
- **Ein Endpunkt außerhalb von Loopback ist erlaubt.** Trägt der Betreiber einen
  ein, verlässt Seitentext das Gerät. Die Erklärung muss das sagen, und das ist eine
  Betreiberentscheidung (siehe `## Open questions`).
- **Die Manifest-Beschreibung ist deutsch und nennt einen „Server".** Sie braucht
  einen eigenen Nachtrag; `test/manifest.test.js` pinnt ihren Wortlaut heute nicht.

## Open questions

1. **Support-Mail:** soll eine Adresse ins Formular, oder genügt die Support-Seite?
2. **Loopback:** bleibt die Erweiterung auf Loopback beschränkt (dann ist
   „none" eindeutig), oder bleibt jeder Endpunkt erlaubt (dann sagt die Erklärung
   „an die Adresse, die du einträgst")?

## Review

| Runde | Datum | Urteil | Kernpunkte |
|---|---|---|---|
| 1 | 2026-11-26 | `nicht bestanden` | „does not read or drive tabs you opened yourself" ist falsch (`browser_status` meldet Adresse und Titel aller Tabs); drei Pflichtabschnitte fehlten; der Zweck widersprach `docs/46` (`0.7.0` ist durch); das Regelwerk-Fenster war Prosa statt Kriterium; der vierte Schalter (Toolbar) fehlte; „survives Firefox sleeping" war der falsche Grund; zwei Same-Origin-`fetch` fehlten; Manifest-Beschreibung unerwähnt |
| 2 | 2026-11-26 | im Review | Befunde eingearbeitet, siehe Log |

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
  Das Regelwerk-Fenster ist ein Kriterium mit Stichtag.
