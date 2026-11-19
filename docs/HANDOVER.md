
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
