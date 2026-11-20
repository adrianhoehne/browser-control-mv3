---
description: Die Texte für die AMO-Einreichung — Beschreibung, Begründung der Berechtigungen und der Absatz zu eval für das Feld „Notes to reviewers", zum Kopieren.
status: proposed
---

# Die AMO-Einreichung

Vorlage für `docs/46` Stufe 3: die vier Textfelder, die Mozilla verlangt, in der
Sprache, in der das Formular sie will (**englisch**). Das Deutsche daneben ist die
Begründung für uns.

**Stand der Regelwerke:** gelesen am 2026-11-20. *Firefox Add-on Distribution
Agreement* und *Add-on Policies* werden **zum 2026-12-01** ersetzt; beide Seiten
trugen einen entsprechenden Hinweis. Vor dem Einreichen neu lesen und diese Datei
datiert nachziehen.

## 1. Name und Zusammenfassung

```
Browser Control
```

```
Turns your own logged-in Firefox into an MCP server for your local agent. The
agent opens its own tab, reads it, clicks and types in it — and reports back
through a bridge on your machine.
```

## 2. Beschreibung (Feld „Description")

```
Browser Control lets a local agent work in the Firefox you are already logged
into. It is a tool for one operator: you run the bridge on your own machine, you
paste its address and token into the extension, and you decide which switches are
on.

WHAT IT DOES
- the agent opens a tab of its own and drives only that tab: read the text, take
  a screenshot, click, type, evaluate a snippet, follow frames
- the extension keeps one pinned bridge tab so the connection survives Firefox
  sleeping
- three switches, all off by default: password fields, code evaluation,
  screenshots

WHAT IT TRANSMITS
Page text, DOM results and — only while its own switch is on — screenshots go to
the bridge address you configured. Nothing is sent to Mozilla, to the developer
or to any third party. There is no analytics and no telemetry.

WHAT IT DOES NOT DO
- it does not read or drive tabs you opened yourself
- it does not change your search engine, your start page or your settings
- it does not fetch or execute code from any server
```

## 3. Begründung der Berechtigungen (Feld „Notes to reviewers")

```
host permissions (<all_urls>): the agent must be able to open an arbitrary site
that the operator asks for, so the permission cannot be narrowed to a list of
hosts. The code filters the other way: every tool resolves the agent's own tab and
refuses any other tab. The operator's tabs are never read.

scripting: this is the agent's only way into a page. One file (page-agent.js) is
injected, only into the agent tab, only when a tool asks for it.

tabs: used to find and manage the agent tab, and to keep the pinned bridge tab
alive.

storage: holds the bridge address, the bridge token and three switches.

webRequest: read-only observation of youtube.com/api/timedtext, to capture the
signed caption address for the transcript tool. Nothing is blocked, redirected or
modified.

Data: the extension talks to one address that the operator enters — the bridge on
their own machine, by default a loopback address. No data goes to the developer.
```

## 4. Der Absatz zu `eval` — der wichtigste

Die Policy sagt: *„Add-ons must be self-contained and not load remote code for
execution."* Der folgende Absatz erklärt, warum `eval` darunter nicht fällt. Er
gehört in dasselbe Feld, **nicht** versteckt.

```
About the "code evaluation" switch (browser_eval):

The extension can execute a JavaScript snippet that arrives with a tool call from
the operator's own local client. Please read this as a developer tool, not as a
code-loading mechanism:

- the extension contains no code that fetches a script: there is no URL field, no
  endpoint, no update channel inside the extension
- the only sender is the operator's own machine. The bridge listens on a loopback
  address by default and needs the operator's token
- the switch is off by default. With it off, every call is refused with a named
  error before anything is injected
- the snippet runs in the page, never in the extension's own context, so it cannot
  reach the extension's privileges, its storage or its token
- the same capability exists in the browser's own developer console; this
  extension only lets the operator's agent reach it

If you prefer a build without this switch for review, say so and I will submit one
— the feature is behind one option and one function.
```

## 5. Was im Formular sonst noch gefragt wird

| Feld | Antwort |
|---|---|
| Kategorie | *Web Development* |
| Lizenz | MIT (steht in `LICENSE`) |
| Preis | kostenlos |
| Einreichungsart | `unlisted` (Self-Distribution) |
| Support-Adresse | das Repository |
| Datenerhebung | keine Erhebung durch den Entwickler; Übertragung nur an die eigene Bridge, siehe Beschreibung |

## 6. Die zwei Risiken, die bleiben

| Risiko | Wirkung | Umgang |
|---|---|---|
| Der Reviewer liest `eval` als „remote code" | Ablehnung der Einreichung | Absatz 4 mitschicken; Plan B ist ein Build ohne den Schalter |
| `<all_urls>` gilt als zu weit | Rückfrage oder Ablehnung | die Filterlogik im Code beschreiben (Absatz 3), nicht nur behaupten |

## 7. Plan B — der Build ohne `eval`

Falls die Einreichung an `eval` scheitert: ein Build, in dem `allowEval` nicht
existiert und `browser_eval` mit `eval_not_allowed` antwortet. Das kostet das
Werkzeug, nicht die Erweiterung. **Diese Variante braucht eine eigene Spec**, weil
sie den Optionsvertrag und die Werkzeugliste ändert.

## Log

- **2026-11-20, gelesen:** Distribution Agreement (15 220 Zeichen) und Add-on
  Policies (17 178 Zeichen), beide von `extensionworkshop.com`, weil AMO
  automatisierte Abrufe blockt. Beide werden zum 2026-12-01 ersetzt.
