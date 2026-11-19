/**
 * The manifest is the file that decides what the extension may do and how long its
 * background may live — and the whole point of this extension is a connection that
 * stays up.
 *
 * The history matters for reading these assertions. Spec 02 chose MV2 with
 * `persistent: true` because Firefox unloads an MV3 event page after 30 seconds of
 * idling and does not count an open WebSocket as activity. Spec 42 moved the socket out
 * of the background and into a pinned tab (`bridge.html`), which is what made the
 * persistent background unnecessary; spec 43 then switched the manifest to MV3. The
 * assertions below hold the new arrangement, one property each, and the ping-pong is
 * the point: whoever changes one of these properties has to change this file on
 * purpose.
 *
 * The frame in one sentence: `manifest_version: 3`, an event page without `persistent`,
 * `scripting` plus `host_permissions` instead of `<all_urls>` among the permissions,
 * `action` instead of `browser_action`, and `page-agent.js` as a web-accessible
 * resource because the injection loads it by file name.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MANIFEST = JSON.parse(
  await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
);

test("manifest_shouldDeclareVersionThree", () => {
  // GIVEN the manifest of an extension whose socket lives in a tab (spec 42),
  // WHEN we read the declared manifest version,
  // THEN it has to be 3. The reason MV2 was chosen for so long — the unloading event
  // page — no longer applies: the connection is in the tab, not in the background:
  assert.equal(MANIFEST.manifest_version, 3);
});

test("manifest_shouldNotClaimAPersistentBackground", () => {
  // GIVEN an MV3 manifest, where no such promise exists any more,
  // WHEN we look for the `persistent` flag,
  // THEN it must be gone — not `false`, which would read like a choice this file made.
  // `in` rather than a truthiness check, so `false` counts as a violation too: the
  // reason of spec 02 is *entailed*, not forgotten:
  assert.equal("persistent" in MANIFEST.background, false);
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

  // AND nothing is inlined: the extension CSP forbids it, and the page would come up
  // without a socket and without a word about why.
  assert.doesNotMatch(html, /<script(?![^>]*src=)/);
});

test("manifest_shouldAskForScriptingAndHostPermissions", () => {
  // GIVEN the permission set of the previous increments plus the one decision of
  // spec 34 (the operator chose to observe `api/timedtext` requests themselves on
  // 2026-11-12, after the timeline had been measured blind — M18) and the one of spec
  // 43 (`scripting`, because the injection loads a file),
  // WHEN we read it back,
  // THEN the permissions are exactly these four entries — whoever changes this does so
  // on purpose, which is what this test is for:
  assert.deepStrictEqual(MANIFEST.permissions, ["tabs", "storage", "webRequest", "scripting"]);

  // ... and `<all_urls>` moved to its own key, where MV3 keeps host permissions. Not in
  // both places: a leftover in `permissions` would ask for the same reach twice, and the
  // second line is the one that never gets a grant:
  assert.deepStrictEqual(MANIFEST.host_permissions, ["<all_urls>"]);
  assert.equal(MANIFEST.permissions.includes("<all_urls>"), false);

  // ... and nothing may block: the extension only reads addresses, and
  // `webRequestBlocking` would be a permission for a job nobody asked for (MV3 has no
  // such grant for a non-policy extension anyway):
  assert.equal(MANIFEST.permissions.includes("webRequestBlocking"), false);
});

/**
 * The one policy directive the manifest has to state itself.
 *
 * MV3's default policy for extension pages upgrades insecure requests, and that upgrade
 * reaches `ws://`: measured on 2026-11-18 with Firefox 152 and this manifest — with the
 * default policy the socket to `ws://127.0.0.1:18810` died in the TLS handshake (close
 * code `1015`) and the extension never connected. The local bridge speaks plain text, so
 * the page needs its own `extension_pages` policy without that upgrade. Pinned here
 * because the failure is silent: no log line, no error, just a bridge that never sees a
 * connection.
 */
function extensionPagesPolicy() {
  const declared = MANIFEST.content_security_policy?.extension_pages ?? "";
  return declared.split(";").map((directive) => directive.trim());
}

test("manifest_shouldLetTheBridgePageDialAPlainWebSocket", () => {
  // GIVEN the policy of the extension pages,
  const directives = extensionPagesPolicy();

  // WHEN we read what it allows for connections,
  // THEN a plain `ws:` connection is allowed — the local bridge is `ws://127.0.0.1:8110`,
  // and a `wss:`-only policy would lock out every install that has no TLS in front of it:
  const connectSrc = directives.find((directive) => directive.startsWith("connect-src"));
  assert.notEqual(connectSrc, undefined, "the policy has to name connect-src");
  assert.match(connectSrc, /\bws:/, "a plain ws: target must stay reachable");

  // ... the upgrade is not in it, because that is the directive that broke the dial,
  assert.doesNotMatch(
    MANIFEST.content_security_policy.extension_pages,
    /upgrade-insecure-requests/,
    "the upgrade directive turns ws:// into wss:// and the bridge never sees the socket",
  );

  // ... and the MV3 floor is kept: scripts only from the package, no `unsafe-eval`.
  // Without `script-src 'self'` Firefox refuses the manifest outright.
  assert.ok(directives.includes("script-src 'self'"), "MV3 requires script-src 'self'");
});

/**
 * The file the injection loads has to be reachable for the page it is loaded into.
 *
 * Two failures, one test, and the second one is the expensive one: `page-agent.js`
 * missing means every injection is refused and every tool answers `not_readable`, while
 * `bridge.html`/`bridge.js` in the same list would make the page that carries the token
 * and the session loadable by any web page. So the promise is checked in both
 * directions.
 */
test("manifest_shouldExposeThePageAgent", () => {
  // GIVEN the MV3 form of `web_accessible_resources`: a list of resource/match pairs,
  const exposed = MANIFEST.web_accessible_resources;

  // WHEN we read what it exposes and to whom,
  // THEN it is exactly the page agent, matched against every origin — the injection
  // runs in whatever page the operator's tab shows:
  assert.deepStrictEqual(exposed, [{ resources: ["page-agent.js"], matches: ["<all_urls>"] }]);

  // ... and the bridge page stays out. It carries the operator's token and its own
  // session; a web page that could load it would read both:
  const asText = JSON.stringify(exposed);
  assert.equal(asText.includes("bridge.js"), false, "bridge.js must never be web-accessible");
  assert.equal(asText.includes("bridge.html"), false, "bridge.html must never be web-accessible");
});

test("browserSpecificSettings_shouldKeepTheExtensionId", () => {
  // GIVEN the operator's stored endpoint and token, which live in
  // `storage.local` and are keyed by the extension id,
  // WHEN we read `browser_specific_settings.gecko.id`,
  // THEN it has to be the unchanged value — a new id would silently orphan the
  // token and force the operator to type it in again:
  assert.equal(MANIFEST.browser_specific_settings.gecko.id, "browser-control-mv3@bergkaese.dev");
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

/**
 * The three runtime states of the toolbar button (spec 44), under the names
 * `extension/background.js` passes to `setIcon`.
 */
const TOOLBAR_ICON_NAMES = ["bridge", "bridge-off", "bridge-offline"];

/**
 * An SVG without its comments.
 *
 * The checks below are about attributes, not about prose: these icons document the very
 * bug they must not repeat, and a raw text search would find the words in the comment and
 * call the icon stroked. `[\s\S]*?` rather than `.` keeps a multi-line comment in one piece.
 */
function withoutXmlComments(svg) {
  return svg.replace(/<!--[\s\S]*?-->/g, "");
}

function readIcon(name) {
  return readFile(new URL(`../extension/icons/${name}.svg`, import.meta.url), "utf8");
}

test("manifest_shouldShipTheThreeToolbarIcons", async () => {
  // GIVEN the three states of spec 44 — off, on, on without a bridge,
  // WHEN we read the files `setIcon` names at runtime,
  for (const name of TOOLBAR_ICON_NAMES) {
    const svg = await readIcon(name);

    // THEN each one is a real, square 32-pixel drawing: the runtime states have no
    // manifest entry, so a missing or mis-sized file would only show up as a blank or
    // crooked button in the operator's toolbar.
    assert.match(svg, /viewBox="0 0 32 32"/, `${name}.svg must be drawn on a 32×32 canvas`);
    assert.match(svg, /<path /, `${name}.svg must carry a path`);
  }
});

/**
 * The drawing rule the toolbar icons have to follow, and the reason it is a test.
 *
 * Firefox resolves `context-fill` for an action icon through the `fill` property only —
 * the browser does not put `stroke` into `-moz-context-properties`. The icons shipped
 * once as `fill="none"` plus `stroke="context-fill"`, and the result was a bridge that
 * painted in neither theme: only the red cross and the yellow bolt were visible, and in
 * the plain "connected" state the button was empty. Nothing about that fails a build, so
 * the shape rule is pinned here as text — the files are three paths and a rect each.
 */
test("manifest_shouldNotStrokeIconsWithContextFill", async () => {
  // GIVEN the three toolbar icons, which are small enough to read as text,
  for (const name of TOOLBAR_ICON_NAMES) {
    const svg = await readIcon(name);

    // WHEN we look for a stroked context colour in the markup,
    // THEN there is none: `stroke="context-fill"` resolves to nothing in the toolbar,
    // so every stroke using it is invisible — the exact blank-icon bug this test holds:
    assert.doesNotMatch(
      withoutXmlComments(svg),
      /stroke="context-fill"/,
      `${name}.svg must not draw with stroke="context-fill"; Firefox only maps context-fill to fill`,
    );
  }
});

test("manifest_shouldGiveEveryIconAContextFill", async () => {
  // GIVEN the same three icons, which must still follow the theme rather than fight it,
  for (const name of TOOLBAR_ICON_NAMES) {
    const svg = await readIcon(name);

    // WHEN we look for the bridge's paint,
    // THEN it is `fill="context-fill"` — a hard colour here would vanish on one of the two
    // theme backgrounds, which is why the bridge may not simply hard-code black or white:
    assert.match(
      withoutXmlComments(svg),
      /fill="context-fill"/,
      `${name}.svg must paint the bridge with fill="context-fill"`,
    );
  }
});

test("manifest_shouldShipAFavicon", async () => {
  // GIVEN the bridge page, which is an ordinary tab and therefore gets an ordinary
  // favicon — a tab favicon never receives `context-fill` from the browser,
  const html = await readFile(new URL("../extension/bridge.html", import.meta.url), "utf8");
  const faviconUrl = new URL("../extension/icons/favicon.svg", import.meta.url);

  // WHEN we read the icon the page points at,
  // THEN it names a file of its own,
  assert.match(
    html,
    /<link rel="icon" href="icons\/favicon\.svg"/,
    "bridge.html must carry its own favicon, not the toolbar icon",
  );

  // ... that file is shipped,
  await assert.doesNotReject(readFile(faviconUrl, "utf8"), "icons/favicon.svg must exist");
  const favicon = await readFile(faviconUrl, "utf8");

  // ... it is drawn on the same canvas as the toolbar icons, and it carries a fixed
  // colour, because `context-fill` would leave the tab blank — the second half of the
  // bug this test holds:
  assert.match(favicon, /viewBox="0 0 32 32"/, "favicon.svg must be drawn on a 32×32 canvas");
  assert.doesNotMatch(
    withoutXmlComments(favicon),
    /context-fill/,
    "a tab favicon cannot resolve context-fill",
  );
  assert.match(favicon, /fill="#[0-9a-fA-F]{6}"/, "a favicon needs a hard colour");
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
