/**
 * Wire protocol constants of the extension <-> bridge link.
 *
 * Classic script on purpose: a MV3 background script is not an ES module, so
 * there is no `import`/`export` here. Publishing on `globalThis` is what makes
 * the values reachable from `background.js` and from `node:vm` alike — a bare
 * `const` would stay a lexical binding and look like `undefined` to the test.
 *
 * Values must stay identical to `bridge/protocol.mjs`; `test/protocol.test.js`
 * fails when they drift apart.
 */
globalThis.BC_PROTOCOL = Object.freeze({
  VERSION: 1,
  TYPES: Object.freeze({
    HELLO: "hello",
    WELCOME: "welcome",
    REQUEST: "request",
    RESPONSE: "response",
    // The extension's farewell, sent once before it closes the socket on a
    // switch-off (spec 44). The bridge reads it and deliberately does nothing with
    // it — the sender is this increment, the reaction is roadmap 32.
    GOODBYE: "goodbye",
  }),
  // Methods the extension answers in this increment. Anything else is replied to
  // with `ok:false, code:"unsupported_method"` rather than silently ignored.
  METHODS: Object.freeze({
    STATUS: "status",
    NAVIGATE: "navigate",
    READ: "read",
    CLICK: "click",
    TYPE: "type",
    FOCUS: "focus",
    INSPECT: "inspect",
    OPEN_TAB: "open_tab",
    CLOSE_TAB: "close_tab",
    EVAL: "eval",
    SCREENSHOT: "screenshot",
    FRAMES: "frames",
    TRANSCRIPT: "transcript",
  }),
  CLOSE: Object.freeze({
    AUTH_FAILED: 4401,
    HELLO_TIMEOUT: 4408,
    REPLACED: 4409,
    PROTOCOL_ERROR: 1002,
    UNSUPPORTED_DATA: 1003,
    MESSAGE_TOO_BIG: 1009,
  }),
  MAX_MESSAGE_BYTES: 5242880,
  HELLO_TIMEOUT_MS: 5000,
  CALL_TIMEOUT_MS: 20000,
  // The budget of one injected call's answers (spec 45). Its own number, not
  // `CALL_TIMEOUT_MS`: that one is the bridge's patience with the whole tool call, and
  // a page deadline of the same length would fire together with it — the agent would
  // then see `ExtensionTimeout` instead of the tool's own answer. 5 000 ms sits under
  // every local budget (`SETTLE_GUARD_MS` 4 s, `NAVIGATE_TIMEOUT_MS` 8 s) and over a
  // normal answer that crosses frames.
  INJECTION_REPLY_TIMEOUT_MS: 5000,
  RECONNECT_BASE_MS: 1000,
  RECONNECT_MAX_MS: 30000,
  RECONNECT_JITTER_MS: 250,
});
