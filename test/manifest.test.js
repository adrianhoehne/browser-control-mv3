/**
 * The manifest is the one file where the lifetime of the background page is
 * decided, and the whole point of this extension is a connection that stays up.
 * Firefox unloads an MV3 event page after 30 seconds of idling and does not
 * count an open WebSocket as activity, so the socket dies with the page.
 *
 * Every assertion here holds one half of that decision, with exactly one test
 * per property. Whoever switches back to MV3 has to change this file on
 * purpose — that is the whole purpose of it.
 *
 * Since spec 42 the socket lives in a tab (`bridge.html`), so the second half of
 * the decision moved: the manifest still names one background script, the
 * coordinator, and the script order that matters is the one in the page.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MANIFEST = JSON.parse(
  await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
);

test("manifest_withPersistentBackgroundRequired_shouldDeclareVersionTwo", () => {
  // GIVEN the manifest of an extension that must keep its background page,
  // WHEN we read the declared manifest version,
  // THEN it has to be 2 — MV3 would unload the page after 30 seconds:
  assert.equal(MANIFEST.manifest_version, 2);
});

test("background_withPersistentRequired_shouldBeMarkedPersistent", () => {
  // GIVEN a manifest version that supports a persistent background page,
  // WHEN we read the `persistent` flag,
  // THEN it has to be exactly `true` — there is no non-persistent MV2
  // background worth having here, so `undefined` must fail as loudly as
  // `false` does:
  assert.equal(MANIFEST.background.persistent, true);
});

test("background_scripts_shouldBeTheCoordinatorAlone", () => {
  // GIVEN the coordinator, which only opens the bridge tab and knows nothing about
  // the wire protocol,
  // WHEN we read the script list,
  // THEN it is that one file. `deepStrictEqual` and not `includes`, because an
  // extra entry is a second page in the background that nobody asked for (spec 42):
  assert.deepStrictEqual(MANIFEST.background.scripts, ["background.js"]);
});

test("bridgePage_shouldLoadProtocolBeforeBridge", async () => {
  // GIVEN the page that holds the socket, which is where the two classic scripts
  // moved to,
  const html = await readFile(new URL("../extension/bridge.html", import.meta.url), "utf8");

  // WHEN we read the order it loads them in,
  const order = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1]);

  // THEN `protocol.js` has to come first: `bridge.js` reads `globalThis.BC_PROTOCOL`
  // at load and refuses to run without it. `deepStrictEqual` for the same reason as
  // the manifest case above — this is the order contract now, not a suggestion:
  assert.deepStrictEqual(order, ["protocol.js", "bridge.js"]);

  // AND nothing is inlined: the MV2 CSP would block it, and the page would come up
  // without a socket and without a word about why.
  assert.doesNotMatch(html, /<script(?![^>]*src=)/);
});

test("manifest_requestsWebRequestWithoutBlocking", () => {
  // GIVEN the permission set of the previous increments plus the one decision of
  // spec 34 (the operator chose to observe `api/timedtext` requests themselves on
  // 2026-11-12, after the timeline had been measured blind — M18),
  // WHEN we read it back,
  // THEN it has to be exactly these four entries — whoever changes this does
  // so on purpose, which is what this test is for:
  assert.deepStrictEqual(MANIFEST.permissions, ["tabs", "storage", "<all_urls>", "webRequest"]);

  // ... and nothing may block: the extension only reads addresses, and
  // `webRequestBlocking` would be a permission for a job nobody asked for:
  assert.equal(MANIFEST.permissions.includes("webRequestBlocking"), false);
});

test("manifest_underMV2_shouldNotDeclareHostPermissions", () => {
  // GIVEN an MV2 manifest,
  // WHEN we look for the MV3-only `host_permissions` key,
  // THEN it must be absent: `in` rather than a truthiness check, so an empty
  // array counts as a violation too:
  assert.equal("host_permissions" in MANIFEST, false);
});

test("browserSpecificSettings_afterTheSwitchToMV2_shouldKeepTheExtensionId", () => {
  // GIVEN the operator's stored endpoint and token, which live in
  // `storage.local` and are keyed by the extension id,
  // WHEN we read `browser_specific_settings.gecko.id`,
  // THEN it has to be the unchanged value — a new id would silently orphan the
  // token and force the operator to type it in again:
  assert.equal(MANIFEST.browser_specific_settings.gecko.id, "browser-control@bergkaese.dev");
});

/**
 * The toolbar button of spec 44: there is one, it has no popup, and it starts crossed out.
 *
 * Three separate promises, and each fails differently. A missing button is an extension
 * the operator cannot switch on; a `default_popup` swallows the click (`onClicked` never
 * fires with a popup, so the switch would be dead markup); and a `default_icon` that is not
 * the off icon would claim "on" before anything was switched on. The namespace is tied to
 * the manifest version, and not to `||`: under MV3 `browserAction` does not exist.
 */
test("manifest_shouldCarryAButtonWithoutPopup", async () => {
  // GIVEN the manifest of an extension that is either MV2 or MV3,
  const key = MANIFEST.manifest_version === 3 ? "action" : "browser_action";

  // WHEN we read the button it declares,
  const button = MANIFEST[key];

  // THEN it is there under the key of *this* version and under no other,
  assert.notEqual(button, undefined, `manifest.json must carry "${key}"`);
  assert.equal("browser_action" in MANIFEST, MANIFEST.manifest_version === 2);
  assert.equal("action" in MANIFEST, MANIFEST.manifest_version === 3);

  // ... it has no popup, because a popup is exactly what makes the click unreachable,
  assert.equal("default_popup" in button, false, "a popup would swallow the click");

  // ... its icon is the off one — off is the state of a fresh profile,
  assert.equal(button.default_icon, "icons/bridge-off.svg");

  // ... and it has a tooltip, which is where the three states are readable.
  assert.equal(typeof button.default_title, "string");
  assert.ok(button.default_title.length > 0, "the button needs a title");
});

test("manifest_shouldShipTheThreeToolbarIcons", async () => {
  // GIVEN the three states of spec 44 — off, on, on without a bridge,
  const names = ["bridge", "bridge-off", "bridge-offline"];

  // WHEN we read the files `setIcon` names at runtime,
  for (const name of names) {
    const svg = await readFile(new URL(`../extension/icons/${name}.svg`, import.meta.url), "utf8");

    // THEN each one is a real, square 32-pixel drawing: the runtime states have no
    // manifest entry, so a missing or mis-sized file would only show up as a blank or
    // crooked button in the operator's toolbar.
    assert.match(svg, /viewBox="0 0 32 32"/, `${name}.svg must be drawn on a 32×32 canvas`);
    assert.match(svg, /<path /, `${name}.svg must carry a path`);
  }
});

/**
 * The password switch of spec 07, checked without a browser.
 *
 * The checkbox, its id and the storage key are three separate literals in two
 * files, and a typo in one of them fails silently: the option saves and the
 * extension keeps refusing password fields, or the other way round. Only the
 * operator's real run (criterion 6) would show that — so the wiring is pinned here.
 */
test("optionsHtml_forThePasswordSwitch_shouldCarryACheckboxNamedAllowPasswordFields", async () => {
  // GIVEN the options page of the extension,
  const html = await readFile(new URL("../extension/options.html", import.meta.url), "utf8");

  // WHEN we look for the checkbox the spec calls for,
  const checkbox = html.match(/<input[^>]*id="allowPasswordFields"[^>]*>/);

  // THEN it has to exist, and it has to be a checkbox — a text field with that id
  // would store the wrong thing and still look right in the markup:
  assert.notEqual(checkbox, null, 'options.html must carry id="allowPasswordFields"');
  assert.match(checkbox[0], /type="checkbox"/);
  assert.match(html, /Allow password fields/, "the visible label is part of the contract");
});

test("optionsJs_forThePasswordSwitch_shouldNameTheSameKeyLiteralAsTheCheckbox", async () => {
  // GIVEN the options script, which writes the setting,
  const source = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");

  // WHEN we read the literal it stores under,
  // THEN it must be the one the bridge page reads and the one the checkbox
  // carries — the mistyped-key bug this test exists for:
  assert.match(source, /const ALLOW_PASSWORD_FIELDS = "allowPasswordFields";/);
  // Pinned at the assignment, not somewhere in the file: `.checked` also appears
  // in `loadSettings` and in `readChecked`, so a bare `/\.checked/` stayed green
  // even when the submit path stored `readFieldValue(…)` — the `"on"` bug.
  assert.match(
    source,
    /\[ALLOW_PASSWORD_FIELDS\]:\s*readChecked\(ALLOW_PASSWORD_FIELDS\)/,
    "the checkbox value must come from readChecked, not from readFieldValue",
  );
});

/**
 * The code-evaluation switch of spec 19, pinned the way the password switch is.
 *
 * Same failure mode, higher price: the checkbox, its id and the storage key are three
 * separate literals in two files, and a typo in one of them saves the option while the
 * extension keeps refusing every `eval`.
 */
test("optionsHtml_forTheEvalSwitch_shouldCarryACheckboxNamedAllowEval", async () => {
  // GIVEN the options page of the extension,
  const html = await readFile(new URL("../extension/options.html", import.meta.url), "utf8");

  // WHEN we look for the checkbox the spec calls for,
  const checkbox = html.match(/<input[^>]*id="allowEval"[^>]*>/);

  // THEN it has to exist and to be a checkbox — `type="text"` would store `"on"`
  // and still look like a switch in the markup:
  assert.notEqual(checkbox, null, 'options.html must carry id="allowEval"');
  assert.match(checkbox[0], /type="checkbox"/);
  assert.match(html, /Allow code evaluation/, "the visible label is part of the contract");
});

/**
 * The markup of the `allowEval` box: from its own `<input>` to the submit button.
 *
 * Sliced on purpose instead of searching the whole document: the password box above
 * already carries the words “password fields” in its label, so a case that searched
 * `html` would stay green even if the new hint said nothing about what it unlocks.
 */
function allowEvalBlockOf(html) {
  const start = html.indexOf('id="allowEval"');
  assert.notEqual(start, -1, 'options.html must carry id="allowEval"');
  const end = html.indexOf("<button", start);
  assert.notEqual(end, -1, "the allowEval box has to end where the submit button begins");
  return html.slice(start, end);
}

test("optionsHtml_forTheEvalSwitch_shouldNameWhatItUnlocks", async () => {
  // GIVEN the options page, cut down to the box of the new switch,
  const html = await readFile(new URL("../extension/options.html", import.meta.url), "utf8");
  const block = allowEvalBlockOf(html);

  // WHEN we read what the hint promises,
  // THEN it has to name the reach of the code (cookies without `HttpOnly`,
  // `localStorage`, `fetch` with the profile's cookies), the fact that the page may be
  // changed, the lifted password-field lock and the frozen tab — a switch the operator
  // cannot price is not a decision:
  assert.match(block, /password fields/, "the hint must name the lifted password-field lock");
  assert.match(block, /freeze/, "the hint must name the frozen tab");
  assert.match(block, /localStorage/);
  assert.match(block, /HttpOnly/);
  assert.match(block, /fetch/);
  assert.match(block, /change/);
});

test("optionsJs_forTheEvalSwitch_shouldNameTheSameKeyLiteralAsTheCheckbox", async () => {
  // GIVEN the options script, which reads and writes the setting,
  const source = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");

  // WHEN we read the literal it stores under,
  // THEN it must be the one the bridge page reads and the one the checkbox
  // carries:
  assert.match(source, /const ALLOW_EVAL = "allowEval";/);
  // Both halves, because they fail differently: a submit path that stored
  // `readFieldValue(…)` would save `"on"`, and a load path without the key would
  // leave the box unticked (or ticked when it must not be) — pinned at the
  // assignment, the way the password case is:
  assert.match(
    source,
    /\[ALLOW_EVAL\]:\s*readChecked\(ALLOW_EVAL\)/,
    "the checkbox value must come from readChecked, not from readFieldValue",
  );
  assert.match(
    source,
    /stored\[ALLOW_EVAL\] === true/,
    "only the boolean true may tick the box",
  );
});

test("bridgeJs_forTheEvalSwitch_shouldReadTheSameKeyLiteralAsTheCheckbox", async () => {
  // GIVEN the bridge page, which is the side that refuses the call,
  const source = await readFile(
    new URL("../extension/bridge.js", import.meta.url),
    "utf8",
  );

  // WHEN we read the key it asks the store for,
  // THEN it has to be the one the options page saves under — the same literal in
  // three files, and this is the third:
  assert.match(source, /const ALLOW_EVAL = "allowEval";/);
});

/**
 * The screenshot switch of spec 20, pinned the way the two switches before it are.
 *
 * Same failure mode as `allowPasswordFields`/`allowEval`, and the price is a picture:
 * the checkbox, its id and the storage key are three separate literals in two files,
 * and a typo in one of them saves the option while the extension keeps refusing every
 * `screenshot`.
 */
test("optionsHtml_forTheScreenshotSwitch_shouldCarryACheckboxNamedAllowScreenshot", async () => {
  // GIVEN the options page of the extension,
  const html = await readFile(new URL("../extension/options.html", import.meta.url), "utf8");

  // WHEN we look for the checkbox the spec calls for,
  const checkbox = html.match(/<input[^>]*id="allowScreenshot"[^>]*>/);

  // THEN it has to exist and to be a checkbox — a text field with that id would store
  // `"on"` and still look like a switch in the markup:
  assert.notEqual(checkbox, null, 'options.html must carry id="allowScreenshot"');
  assert.match(checkbox[0], /type="checkbox"/);
  assert.match(html, /Allow screenshots/, "the visible label is part of the contract");
});

/**
 * The markup of the `allowScreenshot` box: from its own `<input>` to the submit button.
 *
 * Sliced for the same reason as `allowEvalBlockOf`: the boxes above already carry
 * words a case might look for by accident, so a search over the whole document would
 * stay green even if this hint said nothing about what the switch exposes.
 */
function allowScreenshotBlockOf(html) {
  const start = html.indexOf('id="allowScreenshot"');
  assert.notEqual(start, -1, 'options.html must carry id="allowScreenshot"');
  const end = html.indexOf("<button", start);
  assert.notEqual(end, -1, "the allowScreenshot box has to end where the submit button begins");
  return html.slice(start, end);
}

test("optionsHtml_forTheScreenshotSwitch_shouldNameWhatItExposes", async () => {
  // GIVEN the options page, cut down to the box of the new switch,
  const html = await readFile(new URL("../extension/options.html", import.meta.url), "utf8");
  const block = allowScreenshotBlockOf(html);

  // WHEN we read what the hint promises,
  // THEN it has to name the picture itself, the logged-in profile and the mailbox —
  // a switch the operator cannot price is not a decision, and "a screenshot" alone
  // does not say that the operator's inbox may be in it:
  assert.match(block, /image/, "the hint must name the pictures it allows");
  assert.match(block, /profile/, "the hint must name the profile whose data shows up");
  assert.match(block, /mailbox/, "the hint must name the mailbox as one example");
});

test("optionsJs_forTheScreenshotSwitch_shouldNameTheSameKeyLiteralAsTheCheckbox", async () => {
  // GIVEN the options script, which reads and writes the setting,
  const source = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");

  // WHEN we read the literal it stores under,
  // THEN it must be the one the bridge page reads and the one the checkbox
  // carries — both halves, because they fail differently: a submit path that stored
  // `readFieldValue(…)` would save `"on"`, and a load path without the key would
  // leave the box unticked (or ticked when it must not be):
  assert.match(source, /const ALLOW_SCREENSHOT = "allowScreenshot";/);
  assert.match(
    source,
    /\[ALLOW_SCREENSHOT\]:\s*readChecked\(ALLOW_SCREENSHOT\)/,
    "the checkbox value must come from readChecked, not from readFieldValue",
  );
  assert.match(
    source,
    /stored\[ALLOW_SCREENSHOT\] === true/,
    "only the boolean true may tick the box",
  );
});

test("bridgeJs_forTheScreenshotSwitch_shouldReadTheSameKeyLiteralAsTheCheckbox", async () => {
  // GIVEN the bridge page, which is the side that refuses the call,
  const source = await readFile(
    new URL("../extension/bridge.js", import.meta.url),
    "utf8",
  );

  // WHEN we read the key it asks the store for,
  // THEN it has to be the one the options page saves under — the same literal in
  // three files, and this is the third:
  assert.match(source, /const ALLOW_SCREENSHOT = "allowScreenshot";/);
});
