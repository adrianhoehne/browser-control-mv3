---
description: Die Erweiterung signieren (AMO, unlisted) — damit sie per Doppelklick installiert und von Firefox behalten wird; mit Schlüsselverwaltung außerhalb des Repos und einer ehrlichen Reichweiten-Dokumentation.
status: proposed
---

# Die Signierung

**Roadmap 23 und 24.** Die MV3-Migration (`docs/42`, `docs/43`, `docs/44`,
`docs/45`) ist gebaut; ohne Signatur ist sie für andere Nutzer wertlos: eine
unsignierte XPI läuft nur in `about:debugging`, und nach jedem Firefox-Neustart
ist sie weg.

**Betreiberentscheid 2026-11-18:** Einreichungsart **`unlisted`**
(Self-Distribution). Die Erweiterung wird von Mozilla signiert, erscheint aber
nicht in der AMO-Suche; der Betreiber verteilt die Datei selbst.

## Ziel

- **Eine signierte XPI**, die man per Doppelklick installiert und die Firefox
  behält — ohne `about:debugging`, ohne `xpinstall.signatures.required`.
- **Die Signatur entsteht lokal**, mit Schlüsseln, die **nie** ins Repository
  kommen.
- **Die Reichweite steht ehrlich in der Doku:** was `<all_urls>` und `scripting`
  bedeuten, was die Erweiterung lesen kann und was sie **nicht** tut.
- **Der Nachweis ist eine Installation**, nicht ein Dateiname: frische Kopie,
  Doppelklick, Neustart, verbunden.

## Non-goals

- **Kein `listed`.** Keine öffentliche AMO-Seite, keine Suche, kein Marketing.
- **Keine automatische Signierung in CI.** Die Schlüssel bleiben auf dem Rechner
  des Betreibers; ein CI-Lauf mit Secrets ist eine eigene Entscheidung.
- **Kein Store für andere Browser.**
- **Keine Änderung am Verhalten der Erweiterung.** Signiert wird, was gebaut ist.
- **Kein Auto-Update-Kanal.** Eine `unlisted`-XPI aktualisiert sich nicht selbst;
  eine neue Version installiert der Betreiber wieder per Doppelklick.

## Additional dependencies

| Abhängigkeit | Version | Lizenz | Wo |
|---|---|---|---|
| `web-ext` | **8.9.0** (gepinnt, dieselbe Version wie im E2E aus `docs/40`) | MPL-2.0 | nur zum Signieren, nicht im Produkt und nicht zur Laufzeit |

`scripts/package.sh` wirbt heute mit „No web-ext, no dependencies" — das bleibt
für den **Bau** richtig; das Signieren ist ein eigener Schritt und braucht das
Werkzeug. Der Kommentar in `package.sh` wird präzisiert.

**Freigegeben vom Betreiber am 2026-11-20.** Das Werkzeug signiert nur; es steckt
nicht im Produkt und läuft nicht zur Laufzeit.

## Was AMO verlangt

| Was | Stand heute | nötig |
|---|---|---|
| feste Add-on-ID | `browser-control-mv3@bergkaese.dev` (eigene ID, getrennt vom eingefrorenen `browser-control`) | vorhanden |
| `manifest_version` 3 | seit `docs/43` | vorhanden |
| Version | **`0.6.1`** — `0.6.0` ist der Merge-Release und bleibt unsigniert; die Signatur kommt mit `0.6.1` (Betreiberentscheid 2026-11-18) | muss je Release steigen |
| **Daten-Erklärung** | **fehlt** | siehe `## Die Daten-Erklärung` |
| Lizenz | `LICENSE`/`MIT` im Repo | im Einreichungsformular angeben |
| Zusammenfassung, Kategorie | — | im Formular, englisch |
| Begründung der Berechtigungen | in `INSTALL.md` §4/§8, nicht in `README.md` (`grep -c -i permission README.md` ⇒ 0) | eine Tabelle in `README.md`, siehe `## Die Reichweite` |

## Die Daten-Erklärung

AMO verlangt bei neuen Einreichungen eine Aussage, ob die Erweiterung Daten
sammelt. Sie sammelt **keine**: sie spricht ausschließlich mit der Bridge des
Betreibers auf `127.0.0.1` oder über einen Endpunkt, den der Betreiber selbst
einträgt, und überträgt dorthin nur, was ein Werkzeugauftrag verlangt.

Zwei mögliche Orte für diese Aussage:

1. **Im Manifest**, unter `browser_specific_settings.gecko.data_collection_permissions`
   (Firefox ≥ 140 kennt den Schlüssel).
2. **Im Einreichungsformular** von AMO, wenn der Manifest-Schlüssel in der
   Zielversion nicht greift oder anders heißt.

**Welcher Ort gilt, wird gemessen, nicht geraten** — in **Stufe 0**, vor jedem
anderen Schritt: Manifest-Schlüssel in der dokumentierten Form setzen, XPI bauen,
in Firefox 152 laden, `about:addons` → Berechtigungen prüfen. Die gemessene Form
wird in Kriterium 1 als **Literal** eingetragen.

## Die Reichweite (Roadmap 24)

Eine signierte Auslieferung ist nur ehrlich, wenn dasteht, was die Erweiterung
**kann**:

| Berechtigung | was sie erlaubt | was die Erweiterung damit tut |
|---|---|---|
| `<all_urls>` (`host_permissions`) | Zugriff auf jede Seite, die der Betreiber öffnet | liest und bedient nur den **Agenten-Tab**, nie die Tabs des Betreibers; Filter im Code |
| `scripting` | Code in Seiten ausführen | nur `page-agent.js`, nur im Agenten-Tab, nur auf Anforderung eines Werkzeugs |
| `tabs` | Tab-Liste, Fokus, Schließen | Agenten-Tab verwalten, Brücken-Tab instand halten |
| `storage` | lokale Einstellungen | Endpunkt, Token, drei Schalter |
| `webRequest` | Anfragen **beobachten** | nur `youtube.com/api/timedtext`, um die signierte Untertitel-Adresse mitzuschneiden; blockiert nichts |

Diese Tabelle kommt in `README.md` (englisch), und `INSTALL.md` verweist darauf.
Der Satz, der zählt: **die Erweiterung liest keine Seite, die der Agent nicht
selbst geöffnet hat.**

## Der Ablauf

**Einmalig, Betreiber:**

1. Mozilla-Konto anlegen (AMO-Developer-Hub).
2. API-Schlüssel erzeugen (JWT issuer + secret).
3. Beide in `~/.config/browser-control/amo.env` legen (`chmod 600`), nicht ins
   Repo. Die Datei steht in `.gitignore`.

**Je Release:**

```
node scripts/package.sh                     # dist/browser-control-<v>.xpi (unsigniert)
web-ext sign --channel=unlisted \
  --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET" \
  --artifacts-dir dist/signed \
  --source-dir extension
```

Das signierte Artefakt heißt `browser_control-<v>-an+fx.xpi` (AMO vergibt den
Namen) und kommt **nicht** ins Repo.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/manifest.test.js` | `manifest_shouldDeclareNoDataCollection` | die Daten-Erklärung steht im Manifest (Schlüssel und Form nach der Messung) |
| `test/manifest.test.js` | **`browserSpecificSettings_shouldKeepTheExtensionId`** (existiert schon, `test/manifest.test.js:158`) | ohne feste ID keine Signatur über Versionen hinweg |
| `scripts/sign.sh` | `sign_withoutAmoEnv_shouldExitOneAndNameThePath` | die Signatur scheitert laut, nicht still |

## Acceptance criteria

1. **Das Manifest trägt die Daten-Erklärung.** `node -e "const m=require('./extension/manifest.json');
   console.log(JSON.stringify(m.browser_specific_settings.gecko.data_collection_permissions))"`
   ⇒ **das Literal, das Stufe 0 gemessen hat** (es wird hier eingetragen, sobald
   es vorliegt; bis dahin ist dieses Kriterium nicht entscheidbar und die Spec
   bleibt `proposed`).
2. **Die Reichweite steht in `README.md`.** `grep -c 'host_permissions\|<all_urls>'
   README.md` ⇒ **≥ 1**, mit der Tabelle aus `## Die Reichweite`.
3. **Die Schlüssel sind nicht im Repo — nur ihre Namen.** Erlaubt ist, dass
   `scripts/sign.sh` die **Variablennamen** liest; verboten sind Werte.
   `git grep -nE '[0-9a-f]{32,}' -- . ':(exclude)bridge-rs/Cargo.lock'` ⇒ keine
   Ausgabe (dieselbe Prüfung wie in `CONTRIBUTING.md`), und
   `grep -c 'amo.env' .gitignore` ⇒ **1**.
4. **Die Signatur läuft durch.** (Betreiber.) `scripts/sign.sh` ⇒ Exit 0 und
   `ls -1 dist/signed/*.xpi | wc -l` ⇒ **1**.
5. **Die Installation hält.** (Betreiber.) Frisches Firefox-Profil, XPI
   doppelklicken, installieren, Firefox beenden und starten ⇒ die Erweiterung ist
   **noch da**, der Brücken-Tab erscheint, die Bridge loggt `extension
   connected`. Damit ist Kriterium 11 aus `docs/42` erstmals messbar.
6. **Die Anleitung nennt den Doppelklick.** `grep -c 'about:debugging'
   docs/portable/FIREFOX.md` ⇒ **0**. Ein Rückfall-Absatz für unsignierte Dateien
   wäre ein eigenes Kriterium mit eigener Zahl — heute steht die Zeichenkette
   dreimal drin (`:12`, `:16`, `:26`), und `test/bundle/bundle.test.js` pinnt
   die Zahl der numerierten Schritte (≥ 9), also wird der Text mitgeprüft.
7. **Der Rest bleibt grün.** `npm test` ⇒ `# fail 0`; `npm run test:bundle` ⇒
   `# fail 0` (der Fall pinnt `FIREFOX.md` auf mindestens neun Schritte);
   `npm run check` ⇒ 0; `scripts/parity.sh --impl rust --check` ⇒ 7/7 (die
   Bridge ist unberührt).

## Dev plan

**Stufe 0 — die Form der Daten-Erklärung messen**

Dateien: keine. Manifest-Schlüssel in der dokumentierten Form setzen, XPI bauen,
in Firefox 152 laden, `about:addons` → Berechtigungen prüfen. Das Ergebnis wird
in Kriterium 1 als Literal eingetragen.

Beweis: Kriterium 1 mit dem gemessenen Literal; `about:addons` zeigt die
Erklärung.

**Stufe 1 — Manifest, Version und Doku**

Dateien: `extension/manifest.json` (Daten-Erklärung, **Version `0.6.1`**),
`package.json` (Version), `test/extension.test.js` (`MANIFEST_VERSION`, heute
`0.6.0`), `test/manifest.test.js`, `README.md` (Reichweiten-Tabelle),
`INSTALL.md` (Verweis), `docs/24`…`docs/34` nur falls sie die Reichweite falsch
darstellen.

Beweis: Kriterien 1, 2, 6.

**Stufe 2 — `scripts/sign.sh`**

Dateien: `scripts/sign.sh` (neu), `.gitignore` (`amo.env`, `dist/signed/`),
`test/package.test.js`.

Das Skript liest `~/.config/browser-control/amo.env`, prüft, dass die Variablen
da sind, baut vorher die unsignierte XPI und ruft `web-ext sign --channel=unlisted`.
Fehlt eine Variable: Exit 1 mit dem Pfad der Datei in der Meldung.

Beweis: Kriterien 3, 4.

**Stufe 3 — Signieren, installieren, nachweisen**

Dateien: keine Produktdateien; `docs/46` bekommt die Messwerte,
`docs/PROJECT-STATE.md` den Stand, `CHANGELOG.md` den Eintrag.

Beweis: Kriterien 4, 5, und danach der Nachtrag „Kriterium 11 aus `docs/42`
erfüllt".

## Bekannte Lücken

- **`unlisted` aktualisiert sich nicht selbst.** Jede neue Version installiert
  der Nutzer per Doppelklick. Das steht in der Anleitung.
- **Das Review kann dauern.** Bei `<all_urls>` und `scripting` prüft Mozilla
  vielleicht von Hand; die Wartezeit ist nicht planbar.
- **Die exakte Form der Daten-Erklärung ist ungemessen.** Sie wird beim Bauen
  ermittelt und nachgetragen.

### Stufe 2 gebaut — 2026-11-20

`scripts/sign.sh` liest `~/.config/browser-control/amo.env`, bricht mit Exit 1 und
dem **Pfad** ab, wenn die Datei oder eine der beiden Variablen fehlt, baut die
unsignierte XPI über `scripts/package.sh` und ruft `web-ext sign
--channel=unlisted`. `--dry-run` baut und stoppt, **ohne** AMO zu kontaktieren.

Geprüft: `sign_withoutAmoEnv_shouldExitOneAndNameThePath` (`test/package.test.js`)
⇒ grün; Trockenlauf mit Attrappe ⇒ `built dist/browser-control-0.6.1.xpi
(unsigned)` und Exit 0.

## Open questions

1. **Darf `web-ext` als Signierwerkzeug dazukommen** (8.9.0, MPL-2.0, nur zum
   Signieren)? Ohne die Freigabe bleibt diese Spec `proposed`.
2. **Wo entstehen die API-Schlüssel, und wer bewahrt sie?** Der Betreiber. Ohne
   sie ist Stufe 3 nicht ausführbar.

## Review

### Runde 1 — steht aus

## Log

- **2026-11-18, Betreiberentscheid:** Einreichungsart **`unlisted`**.
- **2026-11-18, Betreiberentscheid: verschoben.** Die Signierung wartet, bis der
  Betrieb wieder vollständig funktioniert — `browser_eval` ist unter MV3 tot
  (`docs/47`), und das Icon zeigt falsche Zustände. Signiert wird erst, wenn
  beides behoben und gemessen ist; eine signierte Version mit kaputtem Werkzeug
  wäre die falsche Unterschrift.
- **2026-11-18, Vorgeschichte:** `docs/42`–`docs/45` liefern MV3 als
  Voraussetzung; `INSTALL.md` nennt die Signierung bisher als offenen Punkt.
