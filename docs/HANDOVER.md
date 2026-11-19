
## 2026-11-19 — `docs/49` bauen (offen)

Die Spec ist shipbar (`docs/49-func-vertrag-und-umzug.md`, 5 Runden). Der Bau
ist die größte Änderung seit der MV3-Migration und in dieser Reihenfolge zu tun:

1. **Der `func` in `extension/bridge.js`.** Eigenständig, reist per `toString`,
   trägt eigene Kopien von `serialize` (heute `page-agent.js:1462`),
   `selectorForElement` (`:1179`), `isAddressedFrame` (`:72`), `messageOf`,
   `isThenable`, `withinDeadline`. Frame-Filter als **erste** Anweisung.
   `args: [code, limits, want]`, `limits` mit fünf Feldern.
   Zwischenstand: die Funktion darf ungenutzt hinzugefügt werden — Tests bleiben
   grün, der Baum bleibt heil.
2. **Der Aufruf.** `:3597` wird ein **direkter** `injectScript`-Aufruf
   (`:2464`) mit `{args, func, target}`; **nicht** `askPageAgent` (`:2528`),
   weil das immer den Kanal nimmt. `frameTargetOf` bekommt die `result` je Frame.
3. **Löschen in `extension/page-agent.js`:** `eval`-Op (`:2278`),
   `evalPageSource` (`:1432`), `serialize` (`:1462`), `isThenable` (`:1507`),
   `withinDeadline` (`:1519`). Auf der Brückenseite wird `evalPageRequest`
   (`bridge.js:3684`) arbeitslos.
4. **Die 23 Kanal-Fälle** in `test/extension.test.js` auf den `func`-Zweig.
5. **Wächter-Fall** `:12286` auf `neverAnswer` (`test:559`) umstellen, weil
   `silent` und die zwei `INJECTION_REPLY_TIMEOUT_MS` (`:12321`, `:12325`) mit
   dem Kanal fallen.

Kriterien: `docs/49` `## Acceptance criteria` 1–5. Zeilenstand: nach `cbe5eb0`.

## 2026-11-19 — Werkzeugtest auf echten Seiten (Ergebnis)

**Was trägt.** Amazon.de (`/s?k=…`): `navigate` + `eval` liefern 10 Treffer mit
Namen und Preis in einem Aufruf. MediaMarkt (`/de/search.html?query=…`): dito,
Preise teils hinter „Tiefstpreis" verborgen. Geizhals: `read` liefert die
Trefferliste als Text, `eval` mit `product`-Selektor findet **0** Elemente — der
Selektor stimmt nicht (Nachtrag nötig, falls Geizhals gebraucht wird).

**Was nicht trägt — und warum.**

1. **bahn.de Buchungsformular: geschlossene Shadow Roots.** `read` und `inspect`
   sehen den Text („Start", „Ziel", „Suchen"), aber `querySelectorAll` im
   Seitenkontext findet **kein** Eingabefeld (577 Elemente, keins davon das
   Formular), und `inspect` liefert keinen Selektor, den `click`/`type` erreichen
   könnte. Ein Formular in einem geschlossenen Shadow Root ist für dieses
   Werkzeug nicht bedienbar.
2. **`/web/api/angebote/fahrplan` (POST): 403 `OPS_BLOCKED`.** Der Bot-Schutz
   greift, auch mit `origin`, `referer`, `accept-language` und
   `x-correlation-id`. Die Ortsauflösung (`/web/api/reiseloesung/orte`, GET)
   funktioniert dagegen: Mannheim Hbf `L=8000244`, Lübeck Hbf `L=8000237`.
3. **`reiseauskunft.bahn.de`**: `page_not_readable` (Weiterleitung).
   **Trainline-SEO-Seite**: 404.

**Folge — korrigiert am selben Tag:** die Preise **sind** ermittelbar, sobald
die Ergebnisseite einmal gerendert ist. Der Blocker betrifft nur die
**Eingabe**, nicht das **Lesen**.

- Einmal von Hand gesucht (Mannheim Hbf → Lübeck Hbf, 10.12.2026), danach liest
  das Werkzeug die Liste vollständig: `.verbindung-list__result-item` ist im
  Seitenkontext **erreichbar** (5 Karten), je Karte Abfahrt, Ankunft, Dauer,
  Umstiege und „ab"-Preis.
- Das **URL-Format der App** steht damit fest; es trägt `soid`/`zoid` (die
  Stations-IDs), `soei`/`zoei` (EVA-Nummern), `hd` (Zeitstempel der Anfrage) und
  `s=true`. Ein selbstgebauter Deeplink mit nur `so`/`zo` fällt auf „heute"
  zurück — deshalb braucht es das volle Format.
- Der Formular-Teil bleibt zu: das Eingabefeld liegt in einem **geschlossenen**
  Shadow Root, also gibt es keinen Selektor für `click`/`type`. Ein Mensch klickt
  einmal, danach ist alles maschinell lesbar.

**Nebenbefund für `docs/19`:** `eval` läuft in einer Funktion ohne `async`, also
ist `await` auf oberster Ebene ein Fehler („await is only valid in async
functions"). Ein `return (async () => { … })()` trägt, weil das Werkzeug ein
Promise als Ergebnis annimmt. Das gehört in den Hinweis auf der Optionsseite und
in `docs/19`.
