---
description: Der Schalter in der Symbolleiste — drei Icons (Brücke, gelber Blitz, überkreuzt), Vorgabe aus, und ein goodbye an die Bridge, bevor der Tab verschwindet.
status: proposed
---

# Der Schalter

**Roadmap-Zeile 32 und der Betreiberwunsch vom 2026-11-17.** Die Erweiterung
bekommt ein Icon in der Symbolleiste und einen Ein-/Ausschalter. Aus heißt: kein
Socket, kein Tab. An heißt: ein Tab, ein Socket — und wenn die Bridge fehlt, ein
gelber Blitz statt eines Kreuzes.

**Warum das eine eigene Spec ist:** nichts davon fasst ein MV3-Feature an.
`browser_action`, `browserAction.setIcon`, `onClicked` und `storage.local` gibt
es unter MV2 genauso. Diese Spec läuft **parallel** zu `docs/42`/`docs/43` und
braucht keine von beiden — nur den Brücken-Tab, den `docs/42` baut.

## Ziel

- **Drei Zustände, drei Icons:**

  | Zustand | Icon | Tab | Socket |
  |---|---|---|---|
  | `off` (**Vorgabe**) | Brücke, rot überkreuzt | keiner | keiner |
  | `on` | Brücke | einer | verbunden |
  | `on`, Bridge nicht erreichbar | **gelber Blitz** | einer | keiner, Backoff im Tab |

- **Ein Klick schaltet.** Kein Popup — mit Popup feuert `onClicked` nicht, der
  Klick wäre wirkungslos.
- **Ausschalten sagt Servus:** `goodbye` senden, Socket mit `1000` schließen, Tab
  schließen, `off` speichern. Ohne offenen Socket entfällt `goodbye`.
- **`off` überlebt den Browser-Neustart** (`storage.local`); ohne gespeicherten
  Wert gilt `off`.
- **Die Anleitung bekommt einen Schritt:** Icon anklicken, sonst ist die
  Erweiterung nach der Installation bewusst aus.

## Non-goals

- **Kein `about:addons`-Disable abfangen.** Firefox entlädt die Erweiterung,
  bevor ihr Code laufen kann. Wer dort deaktiviert, räumt den Tab selbst auf —
  das steht in der Anleitung.
- **Kein Klingeln beim Agenten.** `browser_status` bekommt **kein** Feld „aus";
  die Antwortform ist eingefroren (siehe Risiken).
- **Kein Bildschirmfoto, keine Töne, keine Benachrichtigung.**
- **Kein Verhalten an der Bridge.** `goodbye` wird empfangen und ignoriert.

## Das Inventar (aus dem Code gelesen, 2026-11-17)

| Was | Stand |
|---|---|
| `extension/manifest.json` | **kein** `browser_action` / `action` — es gibt heute kein Icon |
| Einstellungen | `browser.storage.local` mit `endpoint`, `token`, `allowPasswordFields`, `allowEval`, `allowScreenshot` |
| Socket | im Brücken-Tab (nach `docs/42`) |
| Reconnect | `onSocketClosed` ruft **bedingungslos** `scheduleReconnect` (6988–6995) |
| `hub.rs` | verwirft jede Nachricht, die nicht `type: "response"` ist — ohne Logzeile, ohne Close (583–587) |
| Protokollkonstanten | `protocol_constants_matchTheExtension` vergleicht die **komplette** Liste zwischen `extension/protocol.js` und `bridge-rs/src/protocol.rs` |

## Der Zustand

- **Gespeichert** in `storage.local` unter einem eigenen Schlüssel (`bridgeEnabled`),
  nicht in der Optionsseite sichtbar.
- **Gelesen** beim Start des Brücken-Tabs: `off` ⇒ kein Socket, kein Backoff.
  Ein Klick auf `off` muss den Reconnect-Timer **abbrechen** — sonst entsteht
  genau der Loop, den man ausschalten wollte.
- **Geschrieben** beim Klick, vor dem Schließen des Tabs.

## `goodbye` auf der Leitung

`{"type":"goodbye"}` — gesendet, bevor die Erweiterung den Socket schließt.
**Die Bridge ändert kein Verhalten:** `hub.rs` verwirft unbekannte Typen ohne
Logzeile und ohne Close — mit der Begründung, die im Code steht: *„Only the first
message has a spec-defined failure mode; inventing a second close path here
would close connections for no documented reason."*

**Zwei Zeilen müssen trotzdem geschrieben werden:** der Typ in
`extension/protocol.js` **und** in `bridge-rs/src/protocol.rs`, weil
`protocol_constants_matchTheExtension` die komplette Liste vergleicht („a
constant that exists on one side only is a difference too"). Ohne beide Seiten
wird CI rot.

Was später mit der Nachricht geschehen soll, ist **Roadmap 32 („Handle Good
Bye")** und heute offen. Diese Spec liefert nur den Absender.

## Risiken

1. **Der Reconnect-Loop.** `onSocketClosed` plant heute unbedingt neu. Ohne
   expliziten Abbruch bei `off` verbindet die Erweiterung nach dem Ausschalten
   weiter — sichtbar nur im Bridge-Log.
2. **Ein laufender Auftrag beim Ausschalten.** Der Socket fällt mitten im
   Auftrag; die Bridge bricht ihn mit `ExtensionUnavailable` ab
   (`reject_all_pending`). Das ist richtig, gehört aber in die Anleitung.
3. **`browser_status` kann „aus" nicht melden.** Die Antwortform ist
   eingefroren (`scripts/parity/expected/2-tools.txt`, `--record` verweigert).
   Der Agent sieht denselben Satz wie bei „Firefox zu". Wer das ändern will,
   braucht ein neues Werkzeug (additiv) oder ein Artefakt-Amendment — beides ist
   **nicht** Teil dieser Spec.
4. **Ein Icon, das lügt.** Ohne den Blitz sähe „Bridge tot" aus wie „alles gut".
   Deshalb drei Icons, nicht zwei.
5. **`setIcon` bei jedem Zustandswechsel** ist ein Aufruf pro Wechsel, nicht pro
   Sekunde; der Blitz hängt am Verbindungszustand, nicht an einem Timer.

## Touch boundary

**Erlaubt:** `extension/icons/{bridge,bridge-off,bridge-offline}.svg` (neu),
`extension/manifest.json` (Action-Block), `extension/bridge.js` (Zustand, Icons,
`goodbye`), `extension/background.js` (Icon beim Start setzen),
`extension/protocol.js`, `bridge-rs/src/protocol.rs` (eine Konstante),
`test/bridge-tab.test.js`, `test/manifest.test.js`, `test/protocol.rs`
(Rust-Seite ist automatisch mitgeprüft), `scripts/e2e/build-test-extension.mjs`
(dritter Anker), `docs/40`, `docs/portable/FIREFOX.md`, `docs/41`, `docs/44`,
`docs/ROADMAP.md`, `docs/README.md`, `docs/PROJECT-STATE.md`, `CHANGELOG.md`.

**Nicht:** `bridge-rs/src/hub.rs` (kein Verhalten), `test/fixtures/**`,
`scripts/parity/**`, `extension/options.*`, `deploy/**`.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/manifest.test.js` | `manifest_shouldCarryAButtonWithoutPopup` | Action-Block vorhanden (je Manifest-Version der richtige Schlüssel), **kein** `default_popup`, drei `default_icon`-Pfade existieren als Datei |
| `test/bridge-tab.test.js` | `switch_onAFreshProfile_shouldBeOff` | ohne gespeicherten Wert gilt `off`: kein Tab, kein Socket |
| `test/bridge-tab.test.js` | `switch_whenClickedOn_shouldOpenTheTabAndConnect` | Klick erzeugt Tab, `on`, Icon Brücke |
| `test/bridge-tab.test.js` | `switch_whenClickedOff_shouldSendGoodbyeThenClose` | **Frame-Reihenfolge**: `goodbye` gesendet, danach `close(1000)`, dann Tab zu, dann `off` gespeichert |
| `test/bridge-tab.test.js` | `switch_whenOff_shouldNotReconnect` | `onSocketClosed` plant bei `off` **keinen** Reconnect |
| `test/bridge-tab.test.js` | `switch_whenTheBridgeIsUnreachable_shouldShowTheBolt` | `on` ohne Verbindung ⇒ Blitz; Verbindung da ⇒ Brücke |
| `test/ci/e2e.test.js` | der dritte Anker: Zustand `on` | der E2E setzt `on`, sonst verbindet die Test-Kopie nie |

## Acceptance criteria

**Kriterien 1–4 entscheidet der Umsetzer, 5–9 der Betreiber.**

1. **Das Icon ist da und hat kein Popup.** `node -e "const m=require('./extension/manifest.json');
   const a=m.browser_action||m.action; console.log(Boolean(a), Boolean(a.default_popup),
   Object.keys(a.default_icon).length)"` ⇒ `true false 3`; die drei Dateien
   existieren (`test -f extension/icons/bridge-offline.svg` ⇒ 0).
2. **Die Vorgabe ist `aus`.** Frisches Profil ohne gespeicherten Wert ⇒
   `switch_onAFreshProfile_shouldBeOff` grün; kein Brücken-Tab.
3. **Die Reihenfolge beim Ausschalten stimmt.** `switch_whenClickedOff_shouldSendGoodbyeThenClose`
   ⇒ grün; im Stub ist `goodbye` vor `close(1000)` auf der Leitung.
4. **Die Konstante steht auf beiden Seiten.** `cargo test --manifest-path
   bridge-rs/Cargo.toml --test protocol` ⇒ grün;
   `grep -c GOODBYE extension/protocol.js` ⇒ **1**, `grep -c GOODBYE
   bridge-rs/src/protocol.rs` ⇒ **1**.
5. **Ein Klick schaltet an, ein Klick schaltet aus.** (Betreiber.) Klick bei
   `off` ⇒ Tab entsteht, Bridge loggt `extension connected`, Icon ist die
   Brücke. Klick bei `on` ⇒ Bridge loggt `extension disconnected` mit
   `reason=1000`, der Tab ist weg, das Icon ist überkreuzt.
6. **Der Blitz erscheint ohne Bridge.** (Betreiber.) Bei `on` die Bridge
   stoppen ⇒ gelber Blitz binnen **5 s**; Bridge starten ⇒ Brücke zurück, ohne
   Klick.
7. **`off` überlebt den Neustart.** (Betreiber.) Ausschalten, Firefox beenden
   und starten ⇒ kein Tab, kein Socket, überkreuztes Icon.
8. **`off` verbindet nicht weiter.** (Betreiber.) Nach dem Ausschalten **60 s**
   warten ⇒ keine neue `extension connected`-Zeile im Bridge-Log.
9. **Die Anleitung führt zum Icon.** `grep -c 'icon' docs/portable/FIREFOX.md`
   ⇒ **≥ 1**, und der Schritt steht **vor** dem Eintragen des Tokens
   (`grep -n`-Vergleich).

## Dev plan

**Stufe 1 — Icons und Action-Block**

Dateien: `extension/icons/bridge.svg`, `extension/icons/bridge-off.svg`,
`extension/icons/bridge-offline.svg`, `extension/manifest.json`,
`test/manifest.test.js`.

Beweis: Kriterium 1. Die SVGs sind schlicht: eine Brücke (zwei Pfeiler, ein
Bogen), dieselbe Brücke mit rotem Kreuz, dieselbe Brücke mit gelbem Blitz.

**Stufe 2 — Zustand und Klick**

Dateien: `extension/bridge.js`, `extension/background.js`,
`test/bridge-tab.test.js`.

Beweis: Kriterien 2, 3, 5, 6, 7, 8.

**Stufe 3 — `goodbye` und die Konstante**

Dateien: `extension/protocol.js`, `bridge-rs/src/protocol.rs`,
`test/ci/e2e.test.js` (dritter Anker), `scripts/e2e/build-test-extension.mjs`.

Beweis: Kriterium 3 mit der Frame-Reihenfolge, Kriterium 4, und
`node scripts/e2e/build-test-extension.mjs --self-check --source extension`
⇒ `seams ok: endpoint=1 token=1 state=1`.

**Stufe 4 — Doku**

Dateien: `docs/portable/FIREFOX.md`, `docs/41-anleitungen.md`,
`docs/ROADMAP.md` (Zeile 32 verweist auf diese Spec), `docs/PROJECT-STATE.md`,
`CHANGELOG.md`.

Beweis: Kriterium 9.

## Bekannte Lücken

- **Der Icon-Klick lässt sich nicht automatisieren.** `web-ext` klickt nichts;
  die Schaltlogik wird im Stub-Harness geprüft, das echte Klicken bleibt eine
  Betreiber-Messung (Kriterien 5–8).
- **Die SVGs sind Handarbeit.** Ob sie in 16 px lesbar sind, entscheidet das
  Auge, kein Test.
- **`about:addons`-Disable räumt niemand auf.** Steht als Satz in der Anleitung.

## Open questions

**Keine.** Am 2026-11-17 entschieden: drei Icons, Vorgabe `aus`, Tab im zuletzt
benutzten Fenster, bei fehlendem Fenster ein neues, `goodbye` vor dem Schließen,
`off` in `storage.local`.

## Review

### Runde 1 — steht aus

## Log

- **2026-11-17, Betreiberentscheid:** Icon in der Symbolleiste, drei Zustände
  über drei Icons, Vorgabe `aus`.
- **2026-11-17, Betreiberentscheid:** Beim Ausschalten sendet die Erweiterung
  `goodbye`; die Bridge empfängt und ignoriert es. Behandlung später (Roadmap 32).
- **2026-11-17, Betreiberentscheid:** wer über `about:addons` deaktiviert, räumt
  den Tab selbst auf.
- **2026-11-17, Abspaltung:** war Stufe 4 der gemeinsamen MV3-Spec; der Schalter
  ist nicht MV3-abhängig und wurde deshalb eine eigene Spec.
