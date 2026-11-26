---
description: Die Erweiterung signieren (AMO, unlisted) — damit sie per Doppelklick installiert und von Firefox behalten wird; mit Schlüsselverwaltung außerhalb des Repos und einer ehrlichen Reichweiten-Dokumentation.
status: active
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
| Version | **`0.7.0`** — `0.6.0` bleibt unsigniert, `0.6.1` war die erste signierte Fassung; `0.7.0` bringt das vierzehnte Werkzeug `browser_help` (`docs/53`) und die englischen Texte (`docs/54`, `docs/55`) | muss je Release steigen |
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
| `storage` | lokale Einstellungen | Endpunkt, Token, vier Schalter (Toolbar, Passwortfelder, Code-Auswertung, Screenshots) — **Stand 2026-11-26:** `docs/44` hat den Toolbar-Schalter ergänzt; die Zeile nannte bis dahin drei |
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
| `test/manifest.test.js` | `manifest_shouldDeclareNoDataCollection` | die Daten-Erklärung steht im Manifest: `required: ["none"]`, `optional: []`, und kein loser Schlüssel daneben. **Stand 2026-11-26:** der Fall fehlte, obwohl er hier stand; er ist jetzt da (`test/manifest.test.js`) |
| `test/manifest.test.js` | **`browserSpecificSettings_shouldKeepTheExtensionId`** (existiert schon, `test/manifest.test.js:158`) | ohne feste ID keine Signatur über Versionen hinweg |
| `scripts/sign.sh` | `sign_withoutAmoEnv_shouldExitOneAndNameThePath` | die Signatur scheitert laut, nicht still |

## Acceptance criteria

1. **Das Manifest trägt die Daten-Erklärung.**
   `node -p "JSON.stringify(require('./extension/manifest.json').browser_specific_settings.gecko.data_collection_permissions)"`
   ⇒ `{"required":["none"],"optional":[]}`. **Gemessen am 2026-11-20:** mit dieser
   Form hat Firefox 152 die Erweiterung geladen und verbunden (`extension
   connected`, Version 0.6.1, nach einem sauberen `disconnected reason=1000`).
2. **Die Reichweite steht in `README.md`.** `grep -c 'host_permissions\|<all_urls>'
   README.md` ⇒ **≥ 1**, mit der Tabelle aus `## Die Reichweite`.
3. **Die Schlüssel sind nicht im Repo — nur ihre Namen.** Erlaubt ist, dass
   `scripts/sign.sh` die **Variablennamen** liest; verboten sind Werte.
   `git grep -nE '[0-9a-f]{32,}' -- . ':(exclude)bridge-rs/Cargo.lock'` ⇒ keine
   Ausgabe (dieselbe Prüfung wie in `CONTRIBUTING.md`), und
   `grep -c 'amo.env' .gitignore` ⇒ **1**.
4. **Die Signatur läuft durch.** (Betreiber.) `scripts/sign.sh` ⇒ Exit 0 und
   `ls -1 dist/signed/*.xpi | wc -l` ⇒ **1**.
5. **Die Installation hält.** (Betreiber.)

   **Teil eins ist automatisiert und gemessen (2026-11-20).** Ein Wegwerfprofil,
   die signierte XPI unter `extensions/browser-control-mv3@bergkaese.dev.xpi`,
   zwei Voreinstellungen, 25 Sekunden headless — danach steht in
   `extensions.json`:

   ```
   {"version": "0.6.1", "active": true, "userDisabled": false,
    "signedState": 2, "location": "app-profile"}
   ```

   `signedState: 2` ist „gültig signiert". Die Gegenprobe mit der **unsignierten**
   XPI im selben Aufbau: der Eintrag fehlt ganz — Firefox lädt sie nicht.

   ```
   user_pref("extensions.autoDisableScopes", 0);
   user_pref("extensions.enabledScopes", 15);
   ```

   Ohne die zwei Zeilen bleibt `active: false, userDisabled: true`: ein von Hand
   ins Profil gelegtes XPI wartet auf einen Klick, den es headless nicht gibt.
   **Teil zwei bleibt beim Betreiber:** Doppelklick auf die Datei, Neustart,
   Brücken-Tab, `extension connected` — erledigt am 2026-11-20, siehe `## Log`.

   **Der Beweis ist als Skript festgehalten:**
   `scripts/verify-signature.sh dist/signed/<datei>.xpi` lädt die Datei in ein
   Wegwerfprofil, liest `signedState` und endet mit 0 nur bei `2`. Gegenprobe mit
   der unsignierten XPI: `signedState absent`, Exit 1.

   **Warum es nicht in `npm test` steht:** das signierte Artefakt liegt in
   `dist/signed/`, ist ignoriert und entsteht bei AMO — die CI hätte nichts zu
   prüfen. Ein Fall, der dort überspringen müsste, bräche die Regel „keine
   übersprungenen Fälle" aus dem falschen Grund. Die zwei geprüften Fälle in
   `test/package.test.js` decken den Aufruf ab (fehlende Datei, fehlendes
   Argument), nicht das Browserverhalten. Frisches Firefox-Profil, XPI
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

**Stufe 0 — die Form der Daten-Erklärung messen** ✅ erledigt 2026-11-20

Gesetzt: `browser_specific_settings.gecko.data_collection_permissions =
{"required": ["none"], "optional": []}`. XPI gebaut, in Firefox 152 geladen: die
Erweiterung lädt und verbindet (`extension connected`, Version 0.6.1), also nimmt
Firefox den Schlüssel an. Die Sichtprüfung in `about:addons` bleibt beim Betreiber.

Beweis: Kriterium 1.

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

### Auslieferung — 2026-11-20

Die signierte XPI hängt am GitHub-Release `v0.6.1` als
`browser-control-0.6.1.xpi` (130 235 Bytes). **Der Name ohne AMOs Hash ist
zulässig:** die Signatur liegt in `META-INF/cose.sig` und deckt den Inhalt, nicht
den Dateinamen — gemessen durch Umbenennen und anschließendes
`scripts/verify-signature.sh` (`signedState 2`).

**Die portablen Zips trugen vorher die unsignierte XPI** (116 780 Bytes), weil die
CI sie vor der Signatur baut. Beide sind ersetzt und neu hochgeladen; das
heruntergeladene Linux-Zip enthält jetzt die signierte Datei (130 235 Bytes), und
ein Auspacken und Prüfen ergibt `signedState 2`. Das Binary behält sein `x`-Recht.

`scripts/release-sign.sh <tag> [--fix-zips]` hält den Ablauf fest: Version gegen
Tag prüfen, signieren, Signatur prüfen, hochladen, optional die Zips
instandsetzen. **Die Reihenfolge ist die Botschaft:** erst prüfen, dann
veröffentlichen — ein Downloader vertraut dem Namen.

**Nichts davon berührt git.** Das Artefakt lebt in `dist/` (ignoriert) und am
Release.

### Stufe 3 — signiert, 2026-11-20

`./scripts/sign.sh` hat `0.6.1` hochgeladen; AMO hat angenommen und
`dist/signed/43cfbddadfa944fca519-0.6.1.xpi` zurückgegeben (130 235 Bytes, mit
`META-INF/cose.sig`). **Der `eval`-Absatz aus `docs/52` war nicht nötig** — es gab
keine Rückfrage.

Der Beweis lief ohne Docker und ohne VM: Firefox 152.0.3 liegt lokal, ein
Wegwerfprofil genügt (siehe Kriterium 5).

## Open questions

1. **Darf `web-ext` als Signierwerkzeug dazukommen** (8.9.0, MPL-2.0, nur zum
   Signieren)? Ohne die Freigabe bleibt diese Spec `proposed`.
2. **Wo entstehen die API-Schlüssel, und wer bewahrt sie?** Der Betreiber. Ohne
   sie ist Stufe 3 nicht ausführbar.

## Review

### Runde 1 — steht aus

## Log

- **2026-11-20, Stufe 3 — signiert, installiert, benutzt.** `./scripts/sign.sh` lud
  `0.6.1` hoch; AMO nahm an und gab `43cfbddadfa944fca519-0.6.1.xpi` zurück.
  Doppelklick im echten Profil (bigdelli), **keine Warnung**, Neustart überlebt.
  Danach gegen den Dienst: `open_tab`, `read` (`settled: true`), `eval` mit
  Seitenvariable (`window.innerWidth` ⇒ 1920), `eval` mit `await` ⇒ 42,
  `close_tab`. Die Verbindung ist `extension connected peer=127.0.0.1` über
  `ws://` (unverschlüsselt, weil Loopback — die Regel aus `docs/36`).
  **Ein Befund, der in `INSTALL.md` gehört:** wer die temporäre Fassung vorher
  entfernt, verliert Endpunkt und Token — das Entfernen nimmt den Speicher mit.

- **2026-11-18, Betreiberentscheid:** Einreichungsart **`unlisted`**.
- **2026-11-18, Betreiberentscheid: verschoben.** Die Signierung wartet, bis der
  Betrieb wieder vollständig funktioniert — `browser_eval` ist unter MV3 tot
  (`docs/47`), und das Icon zeigt falsche Zustände. Signiert wird erst, wenn
  beides behoben und gemessen ist; eine signierte Version mit kaputtem Werkzeug
  wäre die falsche Unterschrift.
- **2026-11-18, Vorgeschichte:** `docs/42`–`docs/45` liefern MV3 als
  Voraussetzung; `INSTALL.md` nennt die Signierung bisher als offenen Punkt.
- **2026-11-22, `0.7.0` signiert und ausgeliefert.** `scripts/release-sign.sh v0.7.0
  --fix-zips` lud `0.7.0` hoch; AMO nahm an. Firefox 152.0.3 im Wegwerfprofil meldet
  `signedState 2` (`active=true`, `version=0.7.0`). Das XPI misst **129 687 Bytes**,
  sha256 `c2641…` — der volle Wert steht **nicht** im Repo, weil der Secret-`grep` aus
  `CONTRIBUTING.md` jede 32-hex-Zeichenkette als Verdacht meldet; er steht beim
  Betreiber. Beide portablen Zips tragen dasselbe XPI (gleicher Hash). Der Schlusssatz des Skripts
  prüfte die Assets ohne `--repo` und lief damit gegen `origin` (das eingefrorene
  Repo, „release not found"); er hat `--repo` jetzt.

- **2026-11-26, `0.8.0` signiert und ausgeliefert.** Der erste Tag-Lauf
  (`45890537557`) fiel im Windows-`clippy`: `free_ports` in
  `bridge-rs/tests/bridge.rs` wird nur von einem `#[cfg(unix)]`-Fall gebraucht und war
  auf dem Windows-Target toter Code — behoben in `2f53ba7` (`#[cfg(unix)]`), Tag
  verschoben. Der zweite Lauf (`45890811558`) war grün: zwei Zips am Release.
  `scripts/release-sign.sh v0.8.0 --fix-zips` lud `browser-control-0.8.0.xpi` hoch
  (140 233 Bytes, `sha256 3a97d122c28621ba…`), Firefox 152.0.3 im Wegwerfprofil meldet
  `signedState 2` (`active=true`, `version=0.8.0`), und beide Zips tragen jetzt die
  signierte XPI.
