/**
 * The extension half that can run without Firefox: `protocol.js` and
 * `bridge.js` in a VM context whose browser APIs, WebSocket and timers are
 * stubs.
 *
 * `bridge.js` is the page of the bridge tab (spec 42); `background.js` only keeps
 * that tab alive, and is driven by `test/bridge-tab.test.js`. The stubs here are
 * the same ones the code saw when it was still the background page — the move
 * into a tab did not change a single API call.
 *
 * Tested is the wire behaviour — the `hello` frame, the answers to `status` and
 * `navigate`, the window and tab filters, the wait for a page and the reconnect
 * delays. The stubs are deliberately complete and small: everything the bridge
 * page is allowed to touch appears in `createSandbox()`, so a newly added browser
 * API fails loudly here instead of working only in Firefox.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const PROTOCOL_SOURCE = await readFile(new URL("../extension/protocol.js", import.meta.url), "utf8");
const BACKGROUND_SOURCE = await readFile(new URL("../extension/bridge.js", import.meta.url), "utf8");
// The page agent (spec 45): the file the injection really loads, run in a realm of its
// own so the dispatcher and its guard are proven against the shipped source and not
// against a stand-in.
const PAGE_AGENT_SOURCE = await readFile(
  new URL("../extension/page-agent.js", import.meta.url),
  "utf8",
);
// The one file the injection loads. Literal, because the same literal has to stand in
// `web_accessible_resources` of the manifest — otherwise every injection is refused
// (spec 43, criterion 2).
const PAGE_AGENT_FILE = "page-agent.js";
// The coordinator, for the one case that has to prove what it does *not* touch: the
// request capture belongs to the bridge page, not to the page that keeps it alive.
const COORDINATOR_SOURCE = await readFile(
  new URL("../extension/background.js", import.meta.url),
  "utf8",
);
// The options page has no DOM harness (spec 36, `## Bekannte Lücken`), so its half of
// the endpoint default is read as source text. Read once, at load: neither file changes
// while the suite runs.
const OPTIONS_SOURCE = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");

const ENDPOINT = "ws://127.0.0.1:8110";
// The bridge's defaults as literals. They used to be read from the Node bridge's config
// module, which the cut deleted (`docs/38`, stage 4b); the Rust bridge reads the same two
// values from `bridge-rs/src/config.rs`. That duplication is why the drift guard two
// tests below compares them against what the extension really dials: `docs/18` says
// where the number comes from, and changing one side alone would leave the extension
// dialling a port nobody listens on.
const BRIDGE_DEFAULT_HOST = "127.0.0.1";
const BRIDGE_DEFAULT_PORT = 8110;
// Not a usable token, and deliberately not a 32+-hex literal: the "no secrets in
// the repo" rule greps for exactly that shape.
const TOKEN = "token-from-the-options-page";
const MANIFEST_VERSION = "0.6.0";
const BROWSER_INFO = { name: "Firefox", version: "152.0.3" };

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

// The container a fresh tab lands in inside a normal window; the agent only ever
// gets tabs there.
const DEFAULT_COOKIE_STORE_ID = "firefox-default";
// The agent tab the stubs create. Not a real Firefox id — only unique among the
// fixture windows, which use 101, 102 and 201.
const CREATED_TAB_ID = 900;
const AGENT_URL = "https://example.org/";
const NAVIGATE_TIMEOUT_MS = 8000;
const TEXT_LIMIT = 20000;
// The ceiling of `read`'s `maxChars` (spec 22) — not the default, which is
// `TEXT_LIMIT`, and not the cut of `click`/`type`, which is the same number.
const READ_MAX_CHARS_LIMIT = 100000;
// The article threshold of spec 23, mirrored here for the two runs that have to be
// able to say "this page is too short to be an article". The production value is the
// one that counts — it travels into the snippet as an argument.
const ARTICLE_MIN_CHARS = 500;
// The answer budget of one injected call (spec 45). Its own number, deliberately under
// the bridge's `CALL_TIMEOUT_MS` of 20 000: a page deadline of the same length would fire
// together with the bridge's and the agent would see `ExtensionTimeout` instead of the
// tool's answer.
const INJECTION_REPLY_TIMEOUT_MS = 5000;
const URL_LIMIT = 2048;
const TITLE_LIMIT = 1024;
// The cap on the address in a `not_readable` error frame: the same number as
// `URL_LIMIT`, and its own name because it is a different promise.
const URL_DETAIL_LIMIT = 2048;

/**
 * A tiny page the default `executeScript` stub renders the injected code against.
 *
 * Invented right here, line breaks, double spaces and all: no real page content
 * belongs in this repository, and the injected code is proven against the text it
 * normalises rather than against an echo of itself.
 */
const DEFAULT_READ_PAGE = {
  url: "https://example.org/seite",
  title: "Beispielseite",
  innerText: "  Erste   Zeile  \n\n\n  Zweite Zeile\t\n",
};

/* ------------------------------------------------------------------ stubs */

/**
 * Collects scheduled callbacks instead of waiting for them.
 *
 * The backoff assertions have to read the delay *before* it fires, which is
 * impossible with real timers and a millisecond-accurate assertion.
 */
class FakeTimerClock {
  #timers = [];
  #nextId = 1;

  /**
   * Every delay this clock was ever asked to arm, in order — fired or not.
   *
   * `pendingDelays()` answers "what is still armed", which is the wrong question for a
   * timer that fires *during* the call: the encode deadline is armed once per stage and
   * disarmed again, so "one deadline per stage" is only visible in the history.
   */
  armedDelays = [];

  // Arrow field: the bridge page receives `setTimeout` detached from any
  // object, so `this` has to be bound here.
  setTimeout = (callback, delayMs) => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.armedDelays.push(delayMs);
    this.#timers.push({ id, callback, delayMs });
    return id;
  };

  clearTimeout = (id) => {
    this.#timers = this.#timers.filter((timer) => timer.id !== id);
  };

  pendingDelays() {
    return this.#timers.map((timer) => timer.delayMs);
  }

  /** Runs the oldest pending callback and returns the delay it was due with. */
  runNext() {
    const timer = this.#timers.shift();
    assert.notEqual(timer, undefined, "no timer was scheduled");
    timer.callback();
    return timer.delayMs;
  }

  /**
   * Runs the pending timer that was armed with exactly `delayMs`, wherever it sits in
   * the queue, and returns that delay.
   *
   * `runNext()` is FIFO and therefore proves whichever timer happens to be armed first.
   * A case about the HEAD deadline has to name that deadline: an expired settle guard
   * is not the answer to anything, and this method fails loudly (`no timer was armed
   * with … ms`) instead of silently proving the other timer.
   */
  runByDelay(delayMs) {
    const index = this.#timers.findIndex((timer) => timer.delayMs === delayMs);
    assert.notEqual(
      index,
      -1,
      `no timer was armed with ${delayMs} ms; pending: ${JSON.stringify(this.pendingDelays())}`,
    );
    const [timer] = this.#timers.splice(index, 1);
    timer.callback();
    return timer.delayMs;
  }
}

/**
 * The parts of `AbortController` the bridge page uses, plus test hooks.
 *
 * `signal` is an empty object: the fake `fetch` never listens to it, so the only
 * thing a case can prove about the controller is that it was created and aborted.
 * A *throwing* `abort()` is switchable because it is the accident `contentTypeOf`
 * has to survive — a teardown that throws must not turn a `null` into `read_failed`.
 */
class FakeAbortController {
  static instances = [];

  static abortThrows = false;

  static reset() {
    FakeAbortController.instances = [];
    FakeAbortController.abortThrows = false;
  }

  static latest() {
    return FakeAbortController.instances.at(-1);
  }

  signal = {};

  aborted = false;

  constructor() {
    FakeAbortController.instances.push(this);
  }

  abort() {
    this.aborted = true;
    if (FakeAbortController.abortThrows) throw new Error("this abort() was asked to fail");
  }
}

/**
 * A HEAD answer in the shape `contentTypeOf` reads: `ok` plus a `Headers`-like map.
 *
 * Omitting `contentType` omits the header, which is a case of its own — a server is
 * not obliged to say what it delivers.
 */
function headReply(ok, contentType) {
  const headers = new Map();
  if (contentType !== undefined) headers.set("content-type", contentType);
  return { ok, headers };
}

/**
 * The `fetch` the bridge page sees, with no network behind it.
 *
 * `answer` is called with `{ url, options, calls }` for every request, `calls`
 * holding this one last, and may return a reply, throw or return a promise that
 * never settles. The default **rejects**: every case that does not configure a
 * server has to end up at `contentType: null`, and a stub that answered 200 with a
 * PDF would silently change what the existing read cases prove.
 *
 * Recording happens before the answer runs, so a case can read `calls` while a
 * request is still in flight.
 */
function createHeadFetchStub(answer = rejectHeadRequest) {
  const calls = [];
  async function headFetch(url, options) {
    calls.push({ url, options });
    return answer({ url, options, calls });
  }
  headFetch.calls = calls;
  return headFetch;
}

function rejectHeadRequest() {
  throw new Error("no HEAD answer configured for this case");
}

/**
 * Rejects what the real constructor rejects before it dials.
 *
 * `new WebSocket(...)` parses its URL synchronously and throws a `SyntaxError`
 * for anything that is not a `ws:`/`wss:` URL. The invalid-endpoint case in
 * `connect()` relies on exactly that, so the fake has to throw here as well.
 */
function assertDialableUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new SyntaxError(`invalid WebSocket URL: ${url}`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new SyntaxError(`invalid WebSocket scheme: ${parsed.protocol}`);
  }
}

/**
 * The parts of `WebSocket` the bridge page uses, plus test hooks.
 *
 * `send` parses the frame immediately: the assertions then compare objects of
 * the test's own realm, which keeps `deepStrictEqual` free of the cross-realm
 * `[[Prototype]]` trap described in the spec.
 */
class FakeWebSocket {
  static instances = [];

  static latest() {
    return FakeWebSocket.instances.at(-1);
  }

  static reset() {
    FakeWebSocket.instances = [];
  }

  constructor(url) {
    assertDialableUrl(url);
    this.url = url;
    this.readyState = SOCKET_CONNECTING;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  send(text) {
    this.sent.push(JSON.parse(text));
  }

  close() {
    this.readyState = SOCKET_CLOSED;
  }

  /* -------- hooks, called by the tests -------- */

  open() {
    this.readyState = SOCKET_OPEN;
    this.#emit("open", {});
  }

  receive(message) {
    this.#emit("message", { data: JSON.stringify(message) });
  }

  /** The close that follows a failed dial as well as a real disconnect. */
  fail() {
    this.readyState = SOCKET_CLOSED;
    this.#emit("close", { code: 1006 });
  }

  #emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/**
 * The message channel of spec 45: the file a `files` injection loads, and the way back.
 *
 * `scripting.executeScript({files})` answers one `{frameId, result}` per frame and
 * `result` is `undefined` — the *length* of that answer is the number of frames it
 * reached, and the answer itself never travels this way. It comes the other way: the
 * injected page agent calls `runtime.sendMessage`, and the extension page receives it
 * on `runtime.onMessage` with `sender.frameId`. Both halves are stubbed here, once, so a
 * case only has to describe its frames.
 *
 * `frames` are the invented frames of the tab, main frame first:
 *
 * - `{href}` for a bare frame — enough for `inventory`, which reads nothing but the
 *   address and `window.top`;
 * - `{page}` for a frame whose ops have to run against a fixture. The realm is then a
 *   page realm *of that fixture* (`pageContextOf`), so the page agent sees the same
 *   document, timers and `MutationObserver` the snippet-level cases hand to injected
 *   code. Nothing else changed about the seam: the same file, the same realm per frame.
 * - `top: false` marks a child frame; `silent` keeps its listener from ever arriving.
 *
 * Three switches model the situations the seam has to survive, and every one of them is a
 * real state of the browser:
 *
 * - `answer(message, frameIndex)`: the case's own page, for the fixtures whose value is a
 *   *shape* rather than a behaviour (an unusable read result, a settle pair with a string
 *   in it). The answer is `{ value }` — a wrapper, because `undefined` already means
 *   "hands this message to the page agent", the real dispatcher, which is the default.
 *   A canned answer never runs the op, so those cases prove the caller's handling of a
 *   page's word, not the op itself. `{ silent: true }` is the frame that takes the
 *   message and answers nothing — one op can be made silent that way.
 * - `refuseSendMessage`: `tabs.sendMessage` rejects with "Could not establish
 *   connection. Receiving end does not exist.", which is what a tab without a content
 *   script says after every navigation.
 * - `holdAnswersFrom`: the named frames answer only when the case calls
 *   `flushHeldAnswers()`, which is how "the first answer does not end the collection"
 *   becomes provable instead of asserted.
 *
 * `advanceClocks: false` withholds the automatic clock run, for a case that drives the
 * page's timeline itself (see `callPageAgentOp`).
 *
 * `refuseInjectionTimes` is the browser refusing the file: the settle injection can fail
 * while the read behind it still works, and that is one counter, not a flag. `refuseInjection`
 * (a Boolean) is the page that refuses every injection, and `refuseInjectionAfter` is the
 * page that takes the first N and refuses the rest — "the click landed, the read finds a
 * PDF viewer".
 *
 * A realm is created once per frame and the file is run in it again for every injection —
 * exactly what a second `{file}` injection into the same frame does. The page agent's own
 * guard is what keeps that from being a second listener, and `listenerCount()` is what
 * reads it off.
 */
function createPageAgentChannel(config = null) {
  const frames = config?.frames ?? [];
  const heldFrameIndexes = new Set(config?.holdAnswersFrom ?? []);
  const bridgeListeners = new Set();
  // Every answer a frame sent, in arrival order: `{frameId, message}`. The wire record,
  // and the only place a duplicate answer would show up.
  const answers = [];
  // Every message the bridge handed to the frames: `{tabId, message, frameIds}`. The ops
  // are read off it, which is how a case states "the read settled before it read".
  const calls = [];
  const realms = new Map();
  // The page's own world, one per frame, built only when a `func` injection asks for it.
  const pageRealms = new Map();
  const heldAnswers = [];
  let currentTabId = null;
  // `refuseInjection` is the page that refuses every file; the counter is the one refusal
  // a two-injection tool needs (the settle wait fails, the read behind it still works).
  let remainingInjectionRefusals =
    config?.refuseInjection === true ? Number.POSITIVE_INFINITY : (config?.refuseInjectionTimes ?? 0);
  // The other end of the same switch: a page that takes the first N injections and
  // refuses every one after them. That is "the click landed, the read finds a PDF".
  let injectionsDone = 0;

  function requireConfig(what) {
    assert.notEqual(config, null, `${what} needs a page realm: pass \`pageAgent\` to createTabsStub`);
  }

  /** The realm of one frame, created on first use and kept for the tab's lifetime. */
  function realmOf(index) {
    const existing = realms.get(index);
    if (existing !== undefined) return existing;
    const frame = frames[index];
    const listeners = [];
    // A page realm, not a bare one: the ops are the code the snippets used to carry, so
    // they need the fixture surface (document, `getComputedStyle`, events, timers) the
    // snippet cases already use. The clock is virtual for the same reason it is there:
    // a `settle` op waits, and only the harness may decide when its timers fall due.
    const clock = frame.clock ?? createPageClock();
    const mutationObserver = frame.mutationObserver ?? createMutationObserverStub(clock);
    const page = frame.page ?? { url: frame.href, inFrame: frame.top === false };
    page.scheduleMutations?.(clock, mutationObserver);
    const { context } = pageContextOf(page, { clock, mutationObserver });
    context.browser = {
      runtime: {
        onMessage: {
          addListener: (listener) => {
            // A silent frame is one whose listener never arrives — see the note above.
            if (frame.silent === true) return;
            listeners.push(listener);
          },
        },
        sendMessage: (message) => {
          emit(index, message);
          // Firefox answers the sending content script with the receivers' return
          // values; the page agent ignores that answer, so `undefined` is enough.
          return Promise.resolve();
        },
      },
    };
    vm.createContext(context);
    const realm = { context, listeners, clock };
    realms.set(index, realm);
    return realm;
  }

  /** One answer on the wire, into this realm's bridge listeners with the sending frame. */
  function emit(index, answer) {
    // Through JSON, like every value that crosses a realm here: the receiver compares
    // against objects of its own realm, prototypes included.
    const delivered = JSON.parse(JSON.stringify(answer));
    answers.push({ frameId: index, message: delivered });
    for (const bridgeListener of bridgeListeners) {
      bridgeListener(delivered, { tabId: currentTabId, frameId: index });
    }
  }

  function runFileIn(index) {
    const { context } = realmOf(index);
    vm.runInContext(PAGE_AGENT_SOURCE, context, { filename: "injected:page-agent.js" });
  }

  /**
   * The page's own world: a second context for the same frame, separate from the isolated
   * one `realmOf` builds. A `func` injection runs here and nowhere else. The fixture is
   * shared — same `page`, same URL, the same DOM — the globals are not, which is the
   * whole difference the two worlds are about.
   */
  function pageRealmOf(index) {
    const existing = pageRealms.get(index);
    if (existing !== undefined) return existing;
    const frame = frames[index];
    const clock = frame.clock ?? createPageClock();
    const mutationObserver = frame.mutationObserver ?? createMutationObserverStub(clock);
    const page = frame.page ?? { url: frame.href, inFrame: frame.top === false };
    const { context } = pageContextOf(page, { clock, mutationObserver });
    vm.createContext(context);
    // The clock is kept with the realm, because the driver has to find it: without it a
    // `func` that waits for a page timer would wait for one that never falls due.
    const realm = { context, clock };
    pageRealms.set(index, realm);
    return realm;
  }

  /**
   * The `func` into the page's world through its **source**, never through the value: a
   * function handed over as a value would keep this realm's globals and the case would
   * prove the sandbox instead of the injection. `args` travel as JSON for the same
   * reason, and the result comes back the same way.
   */
  function runFuncIn(index, func, args) {
    const { context } = pageRealmOf(index);
    const pageFunction = vm.runInContext(`(${func.toString()})`, context, {
      filename: "injected:func.js",
    });
    const values = args === undefined ? [] : JSON.parse(JSON.stringify(args));
    // Awaitable, because a `func` may answer late: Firefox resolves the injection when the
    // page function's promise resolves, and the caller sees the settled value.
    return Promise.resolve(pageFunction(...values)).then((value) =>
      JSON.parse(JSON.stringify(value === undefined ? null : value)),
    );
  }

  /**
   * `scripting.executeScript({target, files})`: the file into every addressed frame, one
   * `{frameId, result}` per frame back.
   *
   * The two target shapes are asserted here, because they are one contract: `allFrames`
   * without `frameIds`, or the main frame alone as `frameIds: [0]`. The keys are pinned
   * as a whole, so an MV2 leftover (`frameId`, `allFrames` at the top level, `runAt`,
   * `matchAboutBlank`) fails here instead of being silently ignored by the next browser.
   */
  async function inject(details) {
    requireConfig("an injection of `page-agent.js`");
    // Two shapes, one pin: the file injection the ops travel on, and the `func`
    // injection of `eval` (specs 47 and 49). Whichever arrived, the keys are exactly its
    // own — an MV2 leftover fails here instead of being ignored by the next browser.
    const carriesAFunc = details.func !== undefined;
    assert.deepStrictEqual(
      Object.keys(details).sort(),
      carriesAFunc ? ["args", "func", "target", "world"] : ["files", "target"],
      carriesAFunc
        ? "a `func` injection takes `args`, `func`, `target` and `world`, nothing else"
        : "`scripting.executeScript` takes a `target` and `files`, nothing else",
    );
    if (carriesAFunc) {
      assert.equal(details.world, "MAIN", "a `func` runs in the page's own world (spec 48)");
    }
    if (carriesAFunc === false) {
      // Through this realm: `details` was built in the sandbox, and `deepStrictEqual`
      // compares prototypes. Same trap as everywhere else in this harness.
      assert.deepStrictEqual(
        inThisRealm(details.files),
        [PAGE_AGENT_FILE],
        "the one file of the page agent",
      );
    }
    const target = details.target;
    currentTabId = target.tabId;
    if (remainingInjectionRefusals > 0) {
      remainingInjectionRefusals -= 1;
      throw new Error("Missing host permission for the tab");
    }
    if (config?.refuseInjectionAfter !== undefined && injectionsDone >= config.refuseInjectionAfter) {
      throw new Error("Missing host permission for the tab");
    }
    injectionsDone += 1;
    if (target.allFrames === true) {
      assert.equal(target.frameIds, undefined, "`allFrames` and `frameIds` exclude each other");
    } else {
      assert.deepStrictEqual(
        inThisRealm(target.frameIds),
        [0],
        "without `allFrames` the injection addresses the main frame",
      );
    }
    const indexes = target.allFrames === true ? frames.map((_, index) => index) : [0];
    // The one real difference between the shapes: a `func` answers through its return
    // value, one entry per frame, and the file injection through the channel.
    if (carriesAFunc) {
      // A page function that never answers: the injection stays open until the bridge's
      // own guard ends the call. That is the subject the channel used to carry (`silent`),
      // and `executeScript` has it too — a page whose script never settles.
      if (config?.neverAnswer === true) return new Promise(() => {});
      const pending = indexes.map((index) => runFuncIn(index, details.func, details.args));
      // The page world's clock has to run while the answer is pending, or a `func` that
      // waits for a timer would wait for one this harness never lets fall due. The timer
      // belongs to the page realm, and `letPageClocksRun` reads it from there too.
      if (config?.advanceClocks !== false) await letPageClocksRun(indexes);
      const results = await Promise.all(pending);
      return results.map((result, at) => ({ frameId: indexes[at], result }));
    }
    for (const index of indexes) runFileIn(index);
    // `result` stays `undefined` for a `files` injection, exactly like Firefox: the
    // answers of the ops arrive through the channel, never as a return value (spec 45).
    return indexes.map((index) => ({ frameId: index, result: undefined }));
  }

  function invoke(listener, message, index) {
    void Promise.resolve(listener(message, { tabId: currentTabId, frameId: index }));
  }

  /**
   * The case's canned answer, or `false` when the page agent has to answer.
   *
   * The distinction is `undefined`: a case that wants to answer "nothing" marks its frame
   * `silent` instead, because a canned `undefined` would be indistinguishable from "run
   * the real op" and would silently turn a shape case into a behaviour case.
   */
  async function cannedAnswerFor(message, index) {
    if (config?.answer === undefined) return false;
    // Awaited, so a case can hold one op back: "the page has not answered yet" is a
    // promise the case resolves by hand, and the wait that follows must really start late.
    const canned = await config.answer(message, index);
    if (canned === undefined) return false;
    // `{ silent: true }` is the frame that took the message and never answered — the
    // shape only an op-level switch can produce (a whole frame is `silent` instead).
    if (canned.silent === true) return true;
    // `{ error }` is the other refusal an op can produce: a page function that threw.
    // The dispatcher would answer `ok: false`, and a shape case needs that answer
    // without a page that really throws.
    if (canned.error !== undefined) {
      emit(index, { callId: message.callId, ok: false, error: canned.error });
      return true;
    }
    emit(index, { callId: message.callId, ok: true, value: canned.value });
    return true;
  }

  /**
   * Lets the page realm's virtual clock run, so a waiting op can answer.
   *
   * A real page has an event loop; this realm has a clock the harness drives. Without
   * this, `settle` would never answer and the bridge's own watchdog would be the only
   * thing left to end the call — which would make every read case a guard case.
   *
   * The rounds exist because the answer travels through promise chains: a timer resolves
   * the op's promise, the continuation sends the answer, and a second timer may be armed
   * on the way. Three rounds cover the chains of the ops this seam carries.
   */
  async function letPageClocksRun(indexes) {
    for (let round = 0; round < 3; round += 1) {
      for (const index of indexes) {
        const clock = realms.get(index)?.clock ?? pageRealms.get(index)?.clock;
        if (clock === undefined) continue;
        // `advanceMs` is the opt-out for a case that has to see a timer the op was
        // supposed to clear: draining the clock would make "cleared" and "fired"
        // indistinguishable.
        if (config?.advanceMs === undefined) clock.advanceToQuiescence();
        else clock.advance(config.advanceMs);
      }
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  /**
   * `tabs.sendMessage(id, message, {frameId})`: to one frame, or to all of them.
   *
   * A frame in `holdAnswersFrom` keeps its answer until the case flushes it. Everything
   * else answers while this call is running, so the collection is already filled when
   * `sendMessage` resolves — the earliest a real browser could answer, too.
   */
  async function deliver(tabId, message, options) {
    requireConfig("a `sendMessage`");
    currentTabId = tabId;
    if (config.refuseSendMessage === true) {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    const indexes = options?.frameId === undefined ? [...realms.keys()] : [options.frameId];
    if (indexes.length === 0) {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    calls.push({ tabId, message: JSON.parse(JSON.stringify(message)), frameIds: [...indexes] });
    for (const index of indexes) {
      if (await cannedAnswerFor(message, index)) continue;
      for (const listener of realmOf(index).listeners) {
        if (heldFrameIndexes.has(index)) heldAnswers.push(() => invoke(listener, message, index));
        else invoke(listener, message, index);
      }
    }
    // `advanceClocks: false` is for the cases that own the clock themselves: a wait can
    // only be proven by stopping it at a named instant, and a harness that always ran it
    // to quiescence would make "the timer was cleared" indistinguishable from "it fired".
    if (config?.advanceClocks !== false) await letPageClocksRun(indexes);
  }

  /**
   * The coordinator's side of `runtime.onMessage`: one extension-internal message into the
   * page's listeners, its answer back.
   *
   * Both answer styles are modelled, because `bridge.js` uses both: the returned promise of
   * `bc:leave`, and `sendResponse` plus `true` of `bc:state?` — the form a listener has to
   * use when it answers before its own turn ends.
   */
  async function askTheBridge(message) {
    for (const listener of bridgeListeners) {
      const answer = await new Promise((resolve) => {
        const sendResponse = (response) => resolve(response);
        const returned = listener(JSON.parse(JSON.stringify(message)), { id: "coordinator" }, sendResponse);
        // `true` announces the answer on `sendResponse`; one that already came resolved
        // this promise while the listener was still running.
        if (returned !== true) resolve(returned);
      });
      if (answer !== undefined) return answer;
    }
    return undefined;
  }

  return {
    answers,
    calls,
    realms,
    inject,
    deliver,
    askTheBridge,
    addBridgeListener: (listener) => bridgeListeners.add(listener),
    /** The ops the bridge asked for, in the order it asked — settle before read, say. */
    ops: () => calls.map((call) => call.message.op),
    /** The virtual clock of every frame that has a realm — "no deadline survived", per frame. */
    pageClocks: () => [...realms.values()].map((realm) => realm.clock),
    flushHeldAnswers() {
      for (const answer of heldAnswers.splice(0)) answer();
    },
    /** How many answers arrived per `callId` — the duplicate detector of risk 2. */
    answerCounts() {
      const counts = {};
      for (const { message } of answers) {
        counts[message.callId] = (counts[message.callId] ?? 0) + 1;
      }
      return counts;
    },
    /** How many `runtime.onMessage` listeners the frames of this tab registered. */
    listenerCount() {
      let total = 0;
      for (const realm of realms.values()) total += realm.listeners.length;
      return total;
    },
  };
}

function createBrowserStub({
  settings,
  windows,
  tabs,
  calls = [],
  windowUpdateThrowsFor = [],
  windowUpdateStaleFocusFor = [],
  windowGetThrowsFor = [],
  windowFocusedAfter = {},
  storageReadFailsFor = [],
  storageWriteFailsFor = [],
  channel = null,
}) {
  const storage = { ...settings };
  const sentMessages = [];

  return {
    sentMessages,
    storage: {
      local: {
        // Mirrors the real API for the read path: an array of keys yields only
        // the keys that are actually stored. `storageReadFailsFor` names keys whose
        // read rejects, which is how the password option case gets a broken
        // `storage.local` without losing the endpoint and token of the same store.
        get: async (keys) => {
          const requested = Array.isArray(keys) ? keys : Object.keys(keys ?? {});
          if (requested.some((key) => storageReadFailsFor.includes(key))) {
            throw new Error(`storage.local refused: ${requested.join(", ")}`);
          }
          const stored = {};
          for (const key of requested) {
            if (key in storage) stored[key] = storage[key];
          }
          return stored;
        },
        set: async (values) => {
          const written = Object.keys(values ?? {});
          if (written.some((key) => storageWriteFailsFor.includes(key))) {
            throw new Error(`storage.local refused the write: ${written.join(", ")}`);
          }
          Object.assign(storage, values);
        },
        // The real API takes a key and an array of keys; the migration removes one
        // key, so the array form is the one that has to work here.
        remove: async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
        },
      },
    },
    runtime: {
      getManifest: () => ({ version: MANIFEST_VERSION }),
      getBrowserInfo: async () => BROWSER_INFO,
      // Where the page agent's answers land (spec 45). The bridge page is an extension
      // page, and a content script's `runtime.sendMessage` reaches it here, `sender`
      // included — that `sender.frameId` is how a frame names itself.
      onMessage: {
        addListener: (listener) => channel.addBridgeListener(listener),
      },
      /**
       * The other direction: the page telling the coordinator whether its socket stands
       * (spec 44). Recorded and answered with nothing — the coordinator is not part of
       * this harness, and the toolbar cases live in `test/bridge-tab.test.js`.
       */
      sendMessage: async (message) => {
        sentMessages.push(message);
        return undefined;
      },
    },
    windows: {
      getAll: async () => windows,
      /**
       * Records the request in the same `calls` list the tab stub uses and echoes
       * it back.
       *
       * No window lookup on purpose: a stub that finds a window could answer
       * `focused: true` out of its own bookkeeping and make a wrong implementation
       * look right. It mirrors what was asked, and the extension has to report that
       * value, not its intention.
       *
       * `windowUpdateStaleFocusFor` is the measured defect of spec 08: Firefox
       * answers `windows.update({focused: true})` with the state from *before* the
       * change. A stub that always echoed would make that case unwritable.
       */
      update: async (windowId, details) => {
        if (windowUpdateThrowsFor.includes(windowId)) {
          throw new Error(`invalid window id: ${windowId}`);
        }
        calls.push({ kind: "windows.update", windowId, changes: { ...details } });
        if (windowUpdateStaleFocusFor.includes(windowId)) return { id: windowId, focused: false };
        return { id: windowId, focused: details?.focused === true };
      },
      /**
       * The read that answers what *is*, not what was asked for.
       *
       * `windowGetThrowsFor` makes the read fail like a closed window does — that
       * is the half-success path of `focus`. The `focused` default of `true` keeps
       * every existing answer exactly as the echo of `update` produced it: nobody
       * called this before spec 12.
       */
      get: async (windowId) => {
        if (windowGetThrowsFor.includes(windowId)) {
          throw new Error(`invalid window id: ${windowId}`);
        }
        calls.push({ kind: "windows.get", windowId });
        return { id: windowId, focused: windowFocusedAfter[windowId] ?? true };
      },
    },
    // The observation permission of spec 34: the manifest filter decides which requests
    // arrive, so the stub hands on every event it is given (see `emitRequest`).
    webRequest: {
      onBeforeRequest: {
        addListener: (listener) => tabs.addRequestListener(listener),
      },
    },
    // The injection namespace of MV3 (spec 43): one call shape, one file. The `tabs`
    // stub owns the recording, so `scriptCalls` stays the one place a case counts.
    scripting: {
      executeScript: (details) => tabs.injectFile(details),
    },
    tabs,
  };
}

/**
 * Runs the injected snippet the way the content process would, and brings its
 * return value back into this realm.
 *
 * The round trip through JSON is not decoration: the returned object carries the
 * page realm's `Object.prototype`, which `deepStrictEqual` refuses to compare
 * against a local one — the same trap the WebSocket stub avoids.
 */
function runPageCode(code, page) {
  const { context, timers } = pageContextOf(page);
  const returned = JSON.parse(
    JSON.stringify(vm.runInNewContext(code, context, { filename: "injected:page" })),
  );
  // After the snippet returned, like a real `setTimeout(…, 0)`: the answer is already
  // on its way and the page realm keeps working.
  timers.runPending();
  return returned;
}

/**
 * The page realm one snippet runs in, plus the timers that realm was given.
 *
 * `clock` decides what the page's own timers *are*, and it is opt-in per snippet:
 * without one the realm gets the drained queue of `createPageTimers`, which is what
 * `type` needs and nothing else. A snippet that *waits* must never be given that
 * queue — its promise would never resolve, the test would end as `cancelled`, and
 * `# fail 0` would stay green on a snippet that does nothing at all.
 *
 * `MutationObserver` and `Date` come with the clock and only with it: they are the
 * two pieces a waiting snippet reads time through, and a realm without them is not
 * "a page" but the ordinary page of every other case.
 */
function pageContextOf(page, { clock = null, mutationObserver = null } = {}) {
  const timers = clock === null ? createPageTimers() : null;
  // A plain object is enough: `runInNewContext` contextualises it itself.
  // `title` and `href` are accessors on the fixture, not copies: a click that
  // changes them has to be visible to the *second* injection, and a snapshot would
  // make the "the click changed the page" case green without proof.
  const document = {
    body: bodyOf(page),
    get title() {
      return page.title;
    },
    set title(value) {
      page.title = value;
    },
    querySelector: (selector) => querySelectorIn(page, selector),
    // The read, click and type snippets never ask the document for a list, and an
    // absent method is the honest answer to that. Only the inspect realm has one —
    // together with the root element its selector builder walks up to.
    ...(page.dom === true
      ? {
          querySelectorAll: (selector) => querySelectorAllInPage(page, selector),
          documentElement: page.documentElement,
          // A text node for the one `eval` case that has to prove the second node
          // branch: it has no tag and no selector, only a `nodeType`, and a node the
          // realm does not hand out would let that branch go untested.
          createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
        }
      : {}),
    // The article realm gets the list method and the root element as well. Stage one of
    // the selection needs no more than `querySelector`, but the density stage and the
    // banner cleanup both read a list, and a realm that silently lacks the method would
    // make their cases pass for the wrong reason — with an empty list.
    ...(page.article === true
      ? {
          querySelectorAll: (selector) => querySelectorAllInArticlePage(page, selector),
          documentElement: page.documentElement,
        }
      : {}),
  };
  // The transcript realm asks the document for one element and its visibility: a
  // background tab is the one state the tool must refuse without reading the model
  // (spec 32, M4).
  if (page.transcript === true) {
    document.querySelectorAll = (selector) => querySelectorAllInTranscriptPage(page, selector);
    document.visibilityState = page.visibilityState ?? "visible";
  }
  const location = {
    get href() {
      return page.url;
    },
    set href(value) {
      page.url = value;
    },
    // The transcript snippet gates on host and path (spec 32). Derived here instead of
    // stored per fixture: every case names a URL, and a second copy of it could
    // disagree with the address the snippet reads.
    get hostname() {
      return new URL(page.url).hostname;
    },
    get pathname() {
      return new URL(page.url).pathname;
    },
  };
  // `window.top === window` is only decidable with an object graph: the outermost
  // frame's `top` *is* the window, a child's is another object. `page.inFrame` says
  // which one the snippet is looking at, and a page realm without it is the main frame
  // — that is what keeps every realm of the cases above unchanged. The visible area is
  // the one more thing a snippet reads now: `click` measures its target against it. One
  // size for every realm, so a frame measures its own box with the same numbers — the
  // harness cannot tell a small iframe from the main frame (spec 56, `## Bekannte
  // Lücken`). Nothing else of a real `window` exists here, because no snippet asks for
  // more.
  const window = {};
  window.innerWidth = 1024;
  window.innerHeight = 768;
  window.top = page.inFrame === true ? {} : window;
  // `wrappedJSObject` is the operator's own object graph behind the Xray wrapper of a
  // content script — the only place a player response lives for a snippet
  // (spec 33, M11). A page without one keeps a realm without the property, which is what
  // the model snippet's fallback is for.
  if (page.transcript === true && page.pageWindow !== undefined) {
    window.wrappedJSObject = page.pageWindow;
  }
  // `page.withoutValueSetter` is the negative case of the native setter: a page
  // realm whose input prototypes carry no `value` accessor at all. A snippet that
  // silently fell back to `element.value = …` would stay green everywhere else.
  const withValueSetter = page.withoutValueSetter !== true;
  const context = {
    document,
    location,
    window,
    getComputedStyle: (element) => computedStyleOf(element),
    Event: PageEvent,
    InputEvent: PageInputEvent,
    KeyboardEvent: PageKeyboardEvent,
    setTimeout: clock === null ? timers.setTimeout : clock.setTimeout,
    HTMLInputElement: { prototype: createValuePrototype({ withValueSetter }) },
    HTMLTextAreaElement: { prototype: createValuePrototype({ withValueSetter }) },
    ...(clock === null
      ? {}
      : {
          clearTimeout: clock.clearTimeout,
          // A stub, not a `Date`: the waiting snippet may only ask what time it is,
          // and the answer has to come from the virtual clock or `waitedMs` would
          // measure the wall clock of the test run.
          Date: { now: () => clock.now() },
          // `page.withoutMutationObserver` is the page that cannot be watched — the
          // one real page shape the wait has to survive without throwing.
          ...(mutationObserver === null || page.withoutMutationObserver === true
            ? {}
            : { MutationObserver: mutationObserver }),
        }),
    // The one page API only the transcript snippets read: the request that turns the
    // address into a track file. It stays out of every other realm, so a snippet that
    // started using it elsewhere would fail as a `ReferenceError` instead of passing
    // quietly. `performance.getEntriesByType` is gone on purpose (spec 34): the timeline
    // never held the address, so a realm that still offered it would be an invitation to
    // read it again.
    ...(page.transcript === true
      ? {
          fetch: (address) => transcriptFetchOf(page, address),
        }
      : {}),
  };
  return { context, timers };
}

/** How many timers a page snippet may chain before the harness calls it a loop. */
const PAGE_TIMER_ROUND_LIMIT = 20;

/**
 * `setTimeout` of the invented page, as a queue the harness drains.
 *
 * Real timer semantics are wrong here twice over: there is no page event loop in a
 * test, and a case has to be able to say "and then the next task happens" without
 * waiting for one. Chained timers run in the same drain — with a limit, because a
 * snippet that reschedules itself forever should fail loudly instead of hanging the
 * suite.
 */
function createPageTimers() {
  const pending = [];
  return {
    setTimeout(callback) {
      pending.push(callback);
      return pending.length;
    },
    runPending() {
      let rounds = 0;
      while (pending.length > 0) {
        rounds += 1;
        if (rounds > PAGE_TIMER_ROUND_LIMIT) {
          throw new Error("a page snippet kept scheduling timers instead of finishing");
        }
        pending.shift()();
      }
    },
  };
}

/**
 * How many timers the virtual clock may run for one snippet before the harness calls
 * it an endless page.
 *
 * Generous on purpose: a page that ticks every 100 ms until a 3 s deadline is 30
 * ticks, and every one of them is a legitimate round. The limit only exists so a
 * snippet that reschedules itself forever fails loudly instead of hanging the suite.
 */
const PAGE_CLOCK_ROUND_LIMIT = 1000;

/**
 * The virtual clock of the invented page: one number, and timers that only run when
 * the harness says so.
 *
 * A waiting snippet is a contract about *time*, so a test that used the real clock
 * could only assert ranges — 250 ms of quiet never arrive in exactly 250 ms on a
 * loaded machine. Here `now()` is a counter: the snippet sees `Date.now()`, the
 * harness decides when the next timer is due, and `waitedMs: 350` becomes an exact
 * statement instead of a flaky one.
 *
 * Ordering is `(dueAt, id)`: two timers due at the same instant run in the order they
 * were armed. That is what makes "the deadline fires before the tick that would
 * re-arm the quiet window at the same millisecond" a deterministic case.
 */
function createPageClock() {
  const timers = new Map();
  let nextId = 1;
  let nowMs = 0;
  // The limit counts *executed* timers, not rounds of one call: a snippet that chains
  // one timer per `advance` step would slip through a per-call limit, and this clock
  // is the only thing between such a snippet and a hanging suite.
  let executedTimers = 0;

  function earliestDueAt(limitMs) {
    let earliest = null;
    for (const timer of timers.values()) {
      if (limitMs !== null && timer.dueAt > limitMs) continue;
      if (
        earliest === null ||
        timer.dueAt < earliest.dueAt ||
        (timer.dueAt === earliest.dueAt && timer.id < earliest.id)
      ) {
        earliest = timer;
      }
    }
    return earliest;
  }

  function execute(timer) {
    executedTimers += 1;
    if (executedTimers > PAGE_CLOCK_ROUND_LIMIT) {
      throw new Error("a page snippet kept scheduling timers instead of finishing");
    }
    timers.delete(timer.id);
    nowMs = timer.dueAt;
    timer.callback();
  }

  function advance(ms) {
    const target = nowMs + ms;
    for (;;) {
      const timer = earliestDueAt(target);
      if (timer === null) break;
      execute(timer);
    }
    nowMs = target;
  }

  return {
    now: () => nowMs,
    setTimeout: (callback, delayMs = 0) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { id, dueAt: nowMs + delayMs, callback });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    /** Advances the clock by `ms`, running everything that falls due on the way. */
    advance,
    /** Runs the clock to the end of the snippet: step by step, until no timer is left. */
    advanceToQuiescence() {
      for (;;) {
        const next = earliestDueAt(null);
        if (next === null) return;
        advance(next.dueAt - nowMs);
      }
    },
    /** The delays still pending, in the shape the background clock reports them. */
    pendingDelays: () => [...timers.values()].map((timer) => timer.dueAt - nowMs),
  };
}

/**
 * `MutationObserver` of the invented page, driven by hand.
 *
 * A real observer reports from the page's task queue, which this harness does not
 * have; `mutate()` calls the callback synchronously instead, so a case states "and
 * then the page changed" at the moment it means. A disconnected observer hears
 * nothing — that half of the contract is exactly what the "no observer left behind"
 * assertion rides on, and a stub that kept calling would hide the leak.
 *
 * `clock` is the timeline a case places its mutations on: `mutateAfter` is the one
 * way to say "one mutation, 100 ms from now", so no case has to know how the clock
 * schedules or how an observer is reached.
 */
function createMutationObserverStub(clock) {
  const watching = new Set();

  class PageMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
      this.connected = true;
      watching.add(this);
    }

    disconnect() {
      this.connected = false;
      watching.delete(this);
    }
  }

  function mutate() {
    // Copy first: a callback may disconnect its own observer while it runs.
    for (const observer of [...watching]) observer.callback([], observer);
  }

  PageMutationObserver.mutate = mutate;
  PageMutationObserver.mutateAfter = (delayMs) => {
    clock.setTimeout(mutate, delayMs);
  };
  /**
   * How many observations are registered right now.
   *
   * A call count would be the wrong number: the contract is "nothing keeps
   * watching after the answer", and a leaked registration is exactly a count that
   * stays above zero. `mutate()` alone cannot see the leak — it iterates the
   * registered observers, so a forgotten `disconnect()` is invisible from the
   * mutations it still receives.
   */
  PageMutationObserver.connectedCount = () => watching.size;
  return PageMutationObserver;
}

/**
 * `Event` and `KeyboardEvent` of the invented page.
 *
 * Only what the injected snippets use: `type`, `key`, and the `defaultPrevented`
 * that `preventDefault()` sets. That flag carries both signals the snippets read —
 * "the page cancelled the Enter" and "the page refused the announced input" —
 * because `element.dispatchEvent` answers `false` for it, exactly like a browser
 * does.
 */
class PageEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles === true;
    this.cancelable = init.cancelable === true;
    this.defaultPrevented = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class PageKeyboardEvent extends PageEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.key = init.key ?? "";
  }
}

/**
 * The `InputEvent` of the invented page: a `PageEvent` plus the two fields that let
 * a page tell typing from pasting, dropping or deleting.
 *
 * A case can read them off the handler the page installed, which is how the
 * `inputType`/`data` of the write are pinned at all.
 */
class PageInputEvent extends PageEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.inputType = init.inputType ?? "";
    this.data = init.data ?? "";
  }
}

/**
 * The `value` accessor the input and textarea prototypes carry.
 *
 * `nativeSets` is the counter that proves the write went *through* the setter
 * instead of around it, and it writes `_value` rather than the element's own
 * `value` — which is the framework's shadow in `createTypeElement`.
 */
const NATIVE_VALUE_DESCRIPTOR = {
  configurable: true,
  get() {
    return this._value;
  },
  set(value) {
    this._value = value;
    this.nativeSets = (this.nativeSets ?? 0) + 1;
  },
};

/** A prototype with that accessor — or, for the negative case, none at all. */
function createValuePrototype({ withValueSetter }) {
  const prototype = {};
  if (withValueSetter) Object.defineProperty(prototype, "value", NATIVE_VALUE_DESCRIPTOR);
  return prototype;
}

/**
 * `document.querySelector` of the invented page.
 *
 * A selector the fixture declares unparseable throws like a real one; everything
 * else finds its element in `page.elements` or nothing at all — which is what
 * `querySelector` answers for a valid selector that matches nothing.
 */
function selectorMatchOf(page, selector) {
  if ((page.unparseableSelectors ?? []).includes(selector)) {
    throw new SyntaxError(`${JSON.stringify(selector)} is not a valid selector`);
  }
  return page.elements?.[selector] ?? null;
}

/**
 * `document.querySelector` of the invented page.
 *
 * Three realms, and the fixture says which one it wants: a read, click or type page
 * declares its elements by selector and may declare one unparseable, an inspect page
 * (`dom: true`) has a real tree and answers through `matchesSelector`, and an article
 * page (`article: true`) has a tree the article grammar understands. That third branch
 * is not decoration: without it the article page would be asked for
 * `elements["article"]`, and a *list* has no such key — stage one would find nothing on
 * every page and the fallback would look like a working selection.
 */
function querySelectorIn(page, selector) {
  if (page.dom === true) return querySelectorAllInPage(page, selector)[0] ?? null;
  if (page.article === true) return querySelectorAllInArticlePage(page, selector)[0] ?? null;
  if (page.transcript === true) return querySelectorAllInTranscriptPage(page, selector)[0] ?? null;
  return selectorMatchOf(page, selector);
}

/**
 * The two style properties the click snippet asks for, `"block"` and `"visible"`
 * unless the element says otherwise.
 */
function computedStyleOf(element) {
  return {
    display: element.display ?? "block",
    visibility: element.visibility ?? "visible",
  };
}

/**
 * One element of the invented page.
 *
 * `rect` is what `getBoundingClientRect()` reports — an all-zero rect is an element
 * without area, which the snippet has to refuse. `attributes` is what
 * `getAttribute` answers, `onClick` runs inside `click()` so a fixture can simulate
 * what the click does to the page, and `clicks` is the counter that proves a refused
 * element was never clicked.
 *
 * `scrollIntoView` is the second behaviour a click needs since spec 56: it counts the
 * call, keeps the options, and moves the rectangle into the visible area — that is what
 * scrolling a target under the fold does. `scrollBringsIntoView: false` is the page
 * where it does not help, the shape of the Amazon keyboard-shortcut menu at `x = -9966`.
 * `scrolls`/`scrollOptions` are read by cases, so a case never asserts on intent.
 */
function createClickElement({
  tagName = "A",
  id = "",
  className = "",
  attributes = {},
  rect = { x: 0, y: 0, width: 120, height: 24 },
  display,
  visibility,
  disabled = false,
  scrollBringsIntoView = true,
  onClick = () => {},
} = {}) {
  const element = {
    tagName,
    id,
    className,
    disabled,
    display,
    visibility,
    clicks: 0,
    scrolls: 0,
    scrollOptions: [],
    getBoundingClientRect: () => ({ ...rect }),
    getAttribute: (name) => attributes[name] ?? null,
    scrollIntoView(options) {
      element.scrolls += 1;
      element.scrollOptions.push(options);
      if (scrollBringsIntoView === false) return;
      // The one thing scrolling does here: the target ends up where the visible area
      // starts. The next `getBoundingClientRect()` is what the second measurement sees.
      rect.x = 0;
      rect.y = 0;
    },
    click() {
      element.clicks += 1;
      onClick();
    },
  };
  return element;
}

/**
 * The parts the invented body consists of.
 *
 * `{ script: "…" }` is inline JavaScript: text for `textContent`, invisible to the
 * rendering. `{ style: "…" }`, `{ noscript: "…" }` and `{ template: "…" }` are the
 * other three types the snippet strips. `{ text: "…" }` is text a reader would see.
 * Fixtures without `parts` keep their older shape — one text part built from
 * `textContent` or `innerText` — which is what a body without scripts looks like
 * anyway.
 */
function bodyPartsOf(page) {
  if (Array.isArray(page.parts)) return page.parts;
  return [{ text: page.textContent ?? page.innerText }];
}

/**
 * The body of the invented page, with just enough DOM for the injected snippet.
 *
 * `innerText` is whatever the fixture says, because the shape that matters here is
 * the one from the real run: nothing visible, and a `textContent` full of inline
 * JavaScript. Stripping is only allowed on the `cloneNode(true)` copy — the body
 * itself throws when something asks it for elements, so an in-place variant of the
 * fallback fails a case instead of quietly rewriting the page.
 *
 * A fixture may pass `bodyCopyCalls` (an array) to learn whether the snippet copied
 * the body at all. The copy costs a full DOM clone on the tab's main thread, and a
 * page whose `innerText` already answered must not pay for it — a case that only
 * looked at the returned text would stay green with that copy unconditional.
 * `cloneNode` stays callable without the array, so the fallback cases need no
 * boilerplate.
 */
function createBodyStub(page) {
  const entries = bodyPartsOf(page).map((part) => ({ part, removed: false }));
  const bodyCopyCalls = page.bodyCopyCalls ?? [];
  return {
    // An accessor, not a copy: the realm now outlives one injection, so a page that
    // rewrites its own text between two ops has to be readable as rewritten — that is
    // what a real document does, and a snapshot would prove the fixture.
    get innerText() {
      return page.innerText;
    },
    get textContent() {
      return remainingText(entries);
    },
    querySelectorAll() {
      throw new Error("the injected snippet must strip its copy, not the page");
    },
    cloneNode: () => {
      bodyCopyCalls.push(entries);
      return createBodyCopy(entries);
    },
  };
}

/**
 * `document.body` of the invented page.
 *
 * `innerText: null` stands for a page without a body, which is a normal case and not
 * an error. The inspect realm (`dom: true`) gets its own body: its `querySelectorAll`
 * answers, while the read body refuses on purpose. An article page (`article: true`)
 * carries its whole tree, so its body is a real article element — the one element the
 * text path aggregates over.
 */
function bodyOf(page) {
  if (page.dom === true) return createInspectBody(page);
  // `undefined` for a page that claims the article realm without a body is turned into
  // `null` here: the snippet answers an empty read, not a crash.
  if (page.article === true) return page.body ?? null;
  return page.innerText === null ? null : createBodyStub(page);
}

/**
 * The type name a part stands for — the key of `{ script: "…" }` and friends.
 *
 * Exactly one key, on purpose: a part that named two types would leave the stub
 * guessing which selector is supposed to remove it.
 */
function partTypeOf(part) {
  const types = Object.keys(part ?? {});
  if (types.length !== 1) {
    throw new Error(`a body part must name exactly one type, got: ${types.join(", ") || "none"}`);
  }
  return types[0];
}

/**
 * The type names a selector really asks for.
 *
 * Split instead of ignored: a stub that answers every selector with "the script
 * parts" stays green while the production selector loses three of its four
 * names, which is precisely the defect this stub has to catch.
 */
function selectorTypesOf(selector) {
  if (typeof selector !== "string") {
    throw new Error(`a selector must be a string, got: ${typeof selector}`);
  }
  return selector.split(",").map((name) => name.trim());
}

/** The strippable copy: every element part whose type the selector names leaves. */
function createBodyCopy(entries) {
  const copied = entries.map((entry) => ({ ...entry }));
  return {
    get textContent() {
      return remainingText(copied);
    },
    querySelectorAll: (selector) => {
      const types = selectorTypesOf(selector);
      return copied
        .filter((entry) => types.includes(partTypeOf(entry.part)))
        .map((entry) => ({
          remove: () => {
            entry.removed = true;
          },
        }));
    },
  };
}

function remainingText(entries) {
  return entries
    .filter((entry) => !entry.removed)
    .map((entry) => entry.part[partTypeOf(entry.part)] ?? "")
    .join("");
}

/* ------------------------------------------------- screenshot fixtures */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Signature (8), IHDR length and type (8), the 13-byte IHDR payload and its CRC (4).
const PNG_HEADER_BYTES = 33;

/**
 * A PNG with a real signature and a real IHDR, zero-padded to `byteCount`.
 *
 * Generated, never written as a literal: a 3 145 729-byte fixture in the source would
 * be a 4 MB diff and could contain a 32-character hex run that the secret grep of
 * `CONTRIBUTING.md` would then report. It is a picture only as far as this tool reads one —
 * signature, width, height; the pixels are zeros and no decoder would take them. That
 * is the honest limit of what the transport cases prove.
 */
function pngOf({ width, height, byteCount }) {
  assert.ok(byteCount >= PNG_HEADER_BYTES, `a PNG needs at least ${PNG_HEADER_BYTES} bytes`);
  const bytes = Buffer.alloc(byteCount);
  Buffer.from(PNG_SIGNATURE).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8); // IHDR payload length
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt8(8, 24); // bit depth
  bytes.writeUInt8(4, 25); // colour type: grey + alpha
  return bytes;
}

/** The data URL `captureTab` hands out, spelled the way Firefox spells it. */
function pngDataUrlFor({ width, height, byteCount }) {
  return `data:image/png;base64,${pngOf({ width, height, byteCount }).toString("base64")}`;
}

/**
 * The 1×1 PNG every capture answers with unless a case says otherwise.
 *
 * 68 decoded bytes travel as 92 base64 characters with **one** `=` (68 = 3·22 + 2), so
 * the `bytes: 68` of the base case also proves that `bytesOf` subtracts the padding:
 * `Math.floor(92 · 3 / 4)` alone would claim 69.
 */
const ONE_BY_ONE_PNG_DATA_URL = pngDataUrlFor({ width: 1, height: 1, byteCount: 68 });

/**
 * A base64 streak that decodes to exactly `byteCount` bytes.
 *
 * The ladder cases need pictures of 400 000 bytes and more; as literals they would be a
 * megabyte of diff, and a random 32-character hex run in there would trip the secret grep
 * of `CONTRIBUTING.md`. Generated, so the padding is honest: `Math.floor(n / 3)` full groups and
 * `AA==` / `AAA=` for the remainder — which is what makes `bytesOf` a proof and not an
 * assumption.
 */
function base64OfLength(byteCount) {
  assert.ok(byteCount >= 0, "a base64 streak cannot carry negative bytes");
  const fullGroups = Math.floor(byteCount / 3);
  const remainder = byteCount % 3;
  const tail = remainder === 0 ? "" : remainder === 1 ? "AA==" : "AAA=";
  return "AAAA".repeat(fullGroups) + tail;
}

/**
 * The magic each format puts in front, with the number of bytes it stands for.
 *
 * Both entries must span whole base64 groups — 4 characters = 3 bytes for `/9j/`, 12
 * characters = 9 bytes for `iVBORw0KGgoA` (the eight signature bytes plus the first byte
 * of the IHDR length). The alignment is the point: a magic of 11 or 7 characters ends in
 * the middle of a group, and the filler behind it then decodes one byte short, so `bytesOf`
 * would be measured against a number that is not the one the case asked for. The pair is
 * asserted in `encodedBase64Of` instead of trusted here. A picture this is only as far as
 * a signature check reads it — no decoder would take the filler.
 */
const IMAGE_MAGIC = Object.freeze({
  "image/jpeg": { base64: "/9j/", bytes: 3 },
  "image/png": { base64: "iVBORw0KGgoA", bytes: 9 },
});

/**
 * The base64 a real encoder would hand out, of exactly `byteCount` bytes and with the
 * format's magic in front.
 *
 * That way one stub answers two questions — *which* format was asked for (head pin) and
 * *how many* bytes it carries (`bytesOf`), without a second, hand-counted length next to
 * it.
 */
function encodedBase64Of(formattedType, byteCount) {
  const magic = IMAGE_MAGIC[formattedType];
  assert.notEqual(magic, undefined, `no base64 magic known for ${formattedType}`);
  // Derived, not hand-counted: the streak behind the magic is only a length proof while
  // the magic is a whole number of four-character groups and decodes to the byte count it
  // claims. Both halves were wrong once (7 characters claimed as 6 bytes), which is why
  // they are checked rather than written next to the constant.
  assert.equal(magic.base64.length % 4, 0, `the ${formattedType} magic must span whole groups`);
  assert.equal(
    Buffer.from(magic.base64, "base64").length,
    magic.bytes,
    `the ${formattedType} magic must decode to the ${magic.bytes} bytes it claims`,
  );
  assert.ok(
    byteCount >= magic.bytes,
    `a ${formattedType} of ${byteCount} bytes cannot carry its ${magic.bytes}-byte magic`,
  );
  return magic.base64 + base64OfLength(byteCount - magic.bytes);
}

/**
 * The `Image` + `document.createElement("canvas")` pair the shrinking ladder needs, made
 * programmable.
 *
 * This is the harness being the claim, not the proof, and the cases say so: `toDataURL`
 * invents the bytes, `onload` fires synchronously (no real decode, no DPI, no memory) and
 * `drawImage` draws nothing. What the cases *can* prove is which stage ran, with which
 * quality and which target size, and that `bytesOf` counts what the stage produced.
 * Whether a real JPEG of a photo-heavy viewport falls under 3 MiB is a live question.
 *
 * - `byteCounts` — one entry per `toDataURL` call, consumed in order. Running dry is an
 *   assertion, not a repeat: silently reusing the last value would hide a stage that was
 *   tried and should not have been.
 * - `sourceWidth`/`sourceHeight` — the size the fake `Image` reports for the capture.
 *   `0` is how the `naturalWidth === 0` case gets its decode with no pixels.
 * - `decodeNeverFinishes` — the switch for the deadline case: `onload` and `onerror` are
 *   never called, so only the guard can end the call.
 */
function createEncoderStub({
  byteCounts = [],
  sourceWidth = 1,
  sourceHeight = 1,
  decodeNeverFinishes = false,
} = {}) {
  const encodeCalls = [];
  // data URL → size. Filled by every canvas that hands one out, so a picture decoded a
  // second time is measured like the picture it is. Anything unknown is the capture.
  const sizesByDataUrl = new Map();
  let nextByteCount = 0;

  class FakeImage {
    onload = null;

    onerror = null;

    naturalWidth = 0;

    naturalHeight = 0;

    #src = "";

    get src() {
      return this.#src;
    }

    set src(value) {
      // The order is the code's contract, so the stub refuses the wrong one loudly: in
      // Firefox a `data:` URL that is already decoded can finish before a handler that
      // is assigned afterwards, and the call would hang until the deadline.
      assert.equal(
        typeof this.onload,
        "function",
        "`onload` must be assigned before `img.src` — otherwise a cached data URL wins the race",
      );
      assert.equal(
        typeof this.onerror,
        "function",
        "`onerror` must be assigned before `img.src` — a decode failure would go unheard",
      );
      this.#src = value;
      if (decodeNeverFinishes) return;
      const size = sizesByDataUrl.get(value) ?? { width: sourceWidth, height: sourceHeight };
      this.naturalWidth = size.width;
      this.naturalHeight = size.height;
      this.onload();
    }
  }

  function createCanvasElement() {
    const context = { drawImage: () => {} };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toDataURL: (type, quality) => {
        const byteCount = byteCounts[nextByteCount];
        assert.notEqual(
          byteCount,
          undefined,
          `toDataURL was called ${nextByteCount + 1} times but the case configured ${byteCounts.length} byte counts`,
        );
        nextByteCount += 1;
        encodeCalls.push({ type, quality, width: canvas.width, height: canvas.height });
        const dataUrl = `data:${type};base64,${encodedBase64Of(type, byteCount)}`;
        sizesByDataUrl.set(dataUrl, { width: canvas.width, height: canvas.height });
        return dataUrl;
      },
    };
    return canvas;
  }

  // A `document` with one door: anything but `createElement` throws, so a page snippet
  // that accidentally ran in the background realm keeps failing loudly here instead of
  // quietly finding a document that almost looks like the real one.
  const document = new Proxy(
    {
      createElement: (tagName) => {
        assert.equal(
          tagName,
          "canvas",
          `the bridge page has no <${tagName}> to create — only the encode canvas`,
        );
        return createCanvasElement();
      },
    },
    {
      get: (target, key) => {
        if (key in target) return target[key];
        // Symbols are not property access in any sense this page has to refuse.
        if (typeof key !== "string") return undefined;
        throw new Error(`the bridge page must not touch document.${key}`);
      },
    },
  );

  return { Image: FakeImage, document, encodeCalls };
}

/**
 * A `browser.tabs` stub with one shared tab store.
 *
 * `create`, `update` and `get` see the same truth, because the wait's post-check
 * has to see what `update` wrote and `emitUpdated` has to be able to say what the
 * tab looks like after loading. The `status` stays `loading` until a test emits
 * an update — otherwise that post-check would short-cut every wait before the
 * `complete`-by-event path was ever exercised.
 *
 * Every object that leaves this stub is built in the test's own realm: an object
 * literal from the VM context has a foreign `Object.prototype`, which
 * `deepStrictEqual` refuses to compare against a local one.
 *
 * `updateThrowsFor` names tab ids whose `update` fails as if the tab had been
 * closed between the caller's `get` and its `update` — the only way to produce
 * that window deterministically from a test. Such a tab leaves the store, the way a
 * closed one does.
 *
 * `updateKeepsStatusCompleteFor` names tab ids whose `update` — and every `get`
 * after it — keeps reporting the page from *before*, `status: "complete"` and
 * all. That is the defect a real run hit: the tab still says `complete` for the
 * old page until the new one actually starts loading, so a post-update check that
 * trusts `complete` alone answers with the previous page.
 *
 * `updateReportsAboutBlankFor` names tab ids whose `update` — and every `get`
 * after it — reports `about:blank` with the page's old title, `status: "complete"`.
 * That is what a tab shows while it is dragged into a new window, and it is the
 * state a real run answered `{"url":"about:blank","title":"(369) YouTube"}` for.
 *
 * `executeScript` replaces the `scripting.executeScript` call of the page agent — the
 * read path's injection. Every call is recorded in `scriptCalls` first, and the answer
 * is the passed function's: a case can answer with an array, with one
 * `{frameId, result}` per frame, or with a rejection. The passed function sees the MV3
 * details (`{target, files}`); a case that only wants a refusal ignores them.
 *
 * `update` has two ways through, and the one thing that tells them apart is the
 * `url` of the details: a navigation (`url` present) moves the stored page, while
 * an activation (`url` absent, i.e. `{active: true}` from `focus`) only flips the
 * `active` flag. Only the navigation path fills `updated`, so a `focus` case does
 * not leave noise in the list three existing cases compare with `deepStrictEqual`.
 * Both paths record in `calls`, which is shared with `windows.update` and
 * `windows.get` of the browser stub — that one list is what makes "exactly one
 * `windows.get`, and it happens *after* the update" a statement about order and
 * not just about counts.
 */
function createTabsStub({
  tabs = [],
  nextTabId = CREATED_TAB_ID,
  calls = [],
  updateThrowsFor = [],
  updateKeepsStatusCompleteFor = [],
  updateReportsAboutBlankFor = [],
  executeScript = null,
  captureDataUrl = ONE_BY_ONE_PNG_DATA_URL,
  captureThrowsTimes = 0,
  captureCalls = [],
  wire = [],
  pageAgent = null,
} = {}) {
  const store = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const listeners = new Set();
  const created = [];
  const updated = [];
  // The requests the page made before the extension started listening, plus every one a
  // case emits later (spec 34). They are replayed when the observer registers, because the
  // real order is "page asks first, background page loads second".
  const wireEvents = wire.map((event) => ({ ...event }));
  const wireListeners = new Set();
  // One entry per `scripting.executeScript` call: the cases prove *that* nothing was
  // injected, which only a recording can say.
  const scriptCalls = [];
  // The page agent's half of the tab (spec 45): the realms a `{file}` injection reaches
  // and the channel its answers come back on. Created always, used only by the cases that
  // hand in a `pageAgent` description — `inject` fails loudly without one instead of
  // pretending a frame answered.
  const channel = createPageAgentChannel(pageAgent);
  let nextId = nextTabId;
  // The first `captureThrowsTimes` captures fail: the counter, not a boolean, because
  // the focus fallback needs exactly "fails once, works the second time".
  let remainingCaptureFailures = captureThrowsTimes;

  function requireTab(tabId) {
    const tab = store.get(tabId);
    if (tab === undefined) throw new Error(`invalid tab id: ${tabId}`);
    return tab;
  }

  /**
   * `tabs.update(id, {active})`: no page changes, the tab store does.
   *
   * The answer is the store's own copy, so the caller reads the state it produced
   * instead of an echo of its request.
   */
  function activateTab(tabId, details) {
    const tab = requireTab(tabId);
    calls.push({ kind: "tabs.update", tabId, changes: { ...details } });
    store.set(tabId, { ...tab, active: details?.active ?? tab.active });
    return { ...store.get(tabId) };
  }

  return {
    created,
    updated,
    calls,
    scriptCalls,
    captureCalls,
    channel,
    /**
     * `scripting.executeScript({target, files})`: the page agent's way in and the only
     * one. Recorded as the details it was handed plus the tab id, which is the half most
     * cases ask about; a case's own `executeScript` replaces the channel and is how a
     * page that refuses injection is modelled.
     */
    injectFile: async (details) => {
      // Recorded as a copy of this realm: the details were built in the sandbox, and
      // `deepStrictEqual` on a sandbox object fails on the prototype, not on the value.
      scriptCalls.push({
        tabId: details?.target?.tabId,
        details: JSON.parse(JSON.stringify(details)),
      });
      if (executeScript !== null) return executeScript(details);
      return channel.inject(details);
    },
    /**
     * `tabs.sendMessage(id, message, {frameId})`: the message into the page realm(s) of
     * this tab, the answers back through `runtime.sendMessage`.
     */
    sendMessage: (tabId, message, options) => channel.deliver(tabId, message, options),
    /**
     * `tabs.captureTab(id, {format})`: the picture the cases configure, or a refusal.
     *
     * Recorded like `executeScript`, because "the switch refused before any capture" is
     * a statement about a call that must not have happened. `requireTab` after the
     * counter: a capture on a vanished tab is the browser's refusal, not a test bug.
     */
    captureTab: async (tabId, details) => {
      captureCalls.push({ tabId, details: details === undefined ? undefined : { ...details } });
      if (remainingCaptureFailures > 0) {
        remainingCaptureFailures -= 1;
        throw new Error("Unable to capture tab");
      }
      requireTab(tabId);
      return captureDataUrl;
    },
    get: async (tabId) => ({ ...requireTab(tabId) }),
    /** What Firefox does when the tab is closed: every later lookup finds nothing. */
    remove: (tabId) => {
      store.delete(tabId);
    },
    create: async ({ url, active, windowId }) => {
      created.push({ url, active, windowId });
      const tab = {
        id: nextId,
        windowId,
        active,
        pinned: false,
        url,
        title: "",
        status: "loading",
        cookieStoreId: DEFAULT_COOKIE_STORE_ID,
      };
      nextId += 1;
      store.set(tab.id, tab);
      return { ...tab };
    },
    update: async (tabId, details) => {
      // Ahead of the branch on purpose: a refusal must stay a refusal on both
      // ways, and a case that sets a wrong flag should not silently stop failing.
      if (updateThrowsFor.includes(tabId)) {
        // A closed tab is not in the store any more, and a double that keeps it there
        // would let the *next* lookup find a corpse — the prune of a replaced tab
        // would look broken while it works.
        store.delete(tabId);
        throw new Error(`invalid tab id: ${tabId}`);
      }
      if (details?.url === undefined) return activateTab(tabId, details);

      updated.push({ tabId, url: details.url });
      const tab = requireTab(tabId);
      if (updateKeepsStatusCompleteFor.includes(tabId)) {
        // The stale answer, unchanged: old URL, old title, and the `complete` of a
        // page that is on its way out.
        return { ...tab };
      }
      if (updateReportsAboutBlankFor.includes(tabId)) {
        // The shell page of a tab being moved: no URL of the requested navigation,
        // but the old title and a `complete` that belongs to nothing.
        store.set(tabId, { ...tab, url: "about:blank", status: "complete" });
        return { ...store.get(tabId) };
      }
      // Navigating away forgets the old title, exactly like a real tab.
      store.set(tabId, { ...tab, url: details.url, title: "", status: "loading" });
      return { ...store.get(tabId) };
    },
    onUpdated: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
    /**
     * Registers the `webRequest` observer and hands it the requests recorded so far.
     *
     * Replaying is the fixture's licence, not the browser's: a real tab asks for its
     * track file while the bridge page is already up. Without the replay every case
     * would have to emit its addresses *after* the load.
     */
    addRequestListener: (listener) => {
      wireListeners.add(listener);
      for (const event of wireEvents) listener({ ...event });
    },
    /**
     * One request as the browser would deliver it: `{ tabId, url }` to every listener.
     *
     * Deliberately unfiltered — Firefox applies the manifest filter before the listener
     * runs, so a stub that dropped a foreign host here would prove the stub instead of the
     * extension (spec 34, `### What could go wrong`).
     */
    emitRequest({ tabId, url }) {
      wireEvents.push({ tabId, url });
      for (const listener of [...wireListeners]) listener({ tabId, url });
    },
    /** What Firefox does per change: one event, every listener. */
    emitUpdated(tabId, changeInfo, tab) {
      const stored = store.get(tabId);
      if (stored !== undefined) {
        store.set(tabId, { ...stored, ...tab, status: changeInfo?.status ?? stored.status });
      }
      for (const listener of [...listeners]) listener(tabId, changeInfo, tab ?? store.get(tabId));
    },
    listenerCount: () => listeners.size,
    /**
     * How many request observers are registered right now.
     *
     * The count, not a flag: "the capture lives in this context" is a statement about
     * exactly one listener, and a second one would be a second answer to the same
     * question.
     */
    wireListenerCount: () => wireListeners.size,
  };
}

function captureConsole(lines) {
  const record = (level) => (...args) => {
    lines.push(`${level}: ${args.map((arg) => String(arg)).join(" ")}`);
  };
  return { log: record("log"), info: record("info"), warn: record("warn"), error: record("error") };
}

/**
 * A value read back out of the stub store, moved into this realm.
 *
 * What the bridge page writes carries *its* realm's prototypes, and
 * `deepStrictEqual` compares prototypes too — the same JSON round trip `runPageCode`
 * makes, for the same reason.
 */
function inThisRealm(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Records every `Map.prototype.set`/`delete` of the sandbox realm in `__bcMapOps`.
 *
 * `bridge.js` is an IIFE: the slot map is closure state and no assertion outside
 * the sandbox can reach it. The probe therefore has to sit *inside* the realm, on the
 * prototypes, before `background.js` loads — a patch in this realm would be a
 * different `Map` and would see nothing.
 *
 * `set` answers `this`, like the real one, so a chain still works; `delete` has to
 * keep answering its Boolean or a caller would take "not there" for "removed".
 */
const MAP_PROBE_SOURCE = `(() => {
  const operations = [];
  globalThis.__bcMapOps = operations;
  const { set, delete: remove } = Map.prototype;
  Map.prototype.set = function patchedSet(key, value) {
    // The value's shape is part of the record: a page slot has a \`finish\` (a navigation's
    // and a claimed slot's alike), a reply collection of the injection channel does not.
    // One counter for both maps would call the second one a defect.
    const slot = value !== null && typeof value === "object" && typeof value.finish === "function";
    operations.push({ map: this, op: "set", key, slot });
    set.call(this, key, value);
    return this;
  };
  Map.prototype.delete = function patchedDelete(key) {
    operations.push({ map: this, op: "delete", key });
    return remove.call(this, key);
  };
})();`;

/**
 * `Math` with a fixed `Math.random()`.
 *
 * The backoff carries 0–250 ms of jitter, so `1000/2000/4000` is only provable
 * with the random source pinned. The prototype chain keeps `min`, `floor` and
 * friends intact.
 */
function createFixedRandomMath(randomValue = 0) {
  const math = Object.create(Math);
  math.random = () => randomValue;
  return math;
}

function createSandbox({
  settings = {},
  windows = [],
  tabs = createTabsStub(),
  calls = [],
  windowUpdateThrowsFor = [],
  windowUpdateStaleFocusFor = [],
  windowGetThrowsFor = [],
  windowFocusedAfter = {},
  storageReadFailsFor = [],
  storageWriteFailsFor = [],
  headFetch = createHeadFetchStub(),
  encoder = createEncoderStub(),
} = {}) {
  const clock = new FakeTimerClock();
  const consoleLines = [];
  const browser = createBrowserStub({
    settings,
    windows,
    tabs,
    calls,
    windowUpdateThrowsFor,
    windowUpdateStaleFocusFor,
    windowGetThrowsFor,
    windowFocusedAfter,
    storageReadFailsFor,
    storageWriteFailsFor,
    channel: tabs.channel,
  });
  const sandbox = vm.createContext({
    browser,
    WebSocket: FakeWebSocket,
    // `node:vm` brings its own realm and no `URL`. Without it, `new URL(…)` in the
    // navigate path throws a `ReferenceError` that the handler would report as a
    // failed navigation — the test would fail one layer too late to be useful.
    URL,
    // The HEAD request behind `contentTypeOf`, and the controller that frees its
    // socket: without both keys in the sandbox an unreadable page would fail with a
    // `ReferenceError`, and the case would prove the stub instead of the code.
    fetch: headFetch,
    AbortController: FakeAbortController,
    // A real `atob`, not a stub: the PNG header is read out of the base64 the browser
    // produced, and a hand-written decoder in the harness would prove the decoder
    // instead of the code. Node brings one, so it only has to be handed in — the same
    // reason `URL` and `fetch` are here.
    atob,
    // The shrinking ladder decodes with an `Image` and re-encodes on a canvas. Both are
    // programmable stubs — see `createEncoderStub` for what they do and do not prove.
    Image: encoder.Image,
    document: encoder.document,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    console: captureConsole(consoleLines),
    Math: createFixedRandomMath(),
  });
  // Before anything of the extension runs: the slot map has to be visible from `set`
  // on, and `Map.prototype` is per realm.
  vm.runInContext(MAP_PROBE_SOURCE, sandbox, { filename: "test/map-probe.js" });
  return { browser, sandbox, clock, consoleLines, headFetch, encoder };
}

/**
 * Runs `protocol.js` and then `bridge.js` the way `bridge.html` lists them.
 *
 * The order matters: `bridge.js` reads `globalThis.BC_PROTOCOL` at load and
 * refuses to run without it.
 */
async function startBackground(options = {}) {
  FakeWebSocket.reset();
  FakeAbortController.reset();
  // The switch is **on** unless a case says otherwise (spec 44). The default of a fresh
  // profile is off, and a page that never dials would make every tool case below green
  // for the wrong reason; the switch itself has its own cases, and they pass the value.
  const { browser, sandbox, clock, consoleLines, headFetch, encoder } = createSandbox({
    ...options,
    settings: { bridgeEnabled: true, ...options.settings },
  });
  vm.runInNewContext(PROTOCOL_SOURCE, sandbox, { filename: "extension/protocol.js" });
  vm.runInNewContext(BACKGROUND_SOURCE, sandbox, { filename: "extension/bridge.js" });
  await settleAsyncWork();
  return { browser, clock, consoleLines, sandbox, headFetch, encoder };
}

/**
 * The keys each `Map` of the bridge page holds, recomputed from the probe.
 *
 * It answers two questions at once and refuses to answer only one: *which keys are in
 * the slot map*, and *how many maps the bridge page builds at all*. The second
 * half is the loud one — a slot map that gained a sibling would otherwise pass
 * unnoticed, so the message names the number of receivers. Scoped per case: every
 * `started` carries its own trace, and cases without slot work cannot skew a count.
 */
function slotMapKeys(started) {
  const operations = started.sandbox.__bcMapOps;
  assert.notEqual(operations, undefined, "the sandbox probe recorded no Map operation");

  // Grouped by receiver *before* the copy: identity is what tells one map from
  // another, and a copied operation has no receiver left to compare.
  const operationsPerMap = new Map();
  for (const operation of operations) {
    const group = operationsPerMap.get(operation.map) ?? [];
    group.push(operation);
    operationsPerMap.set(operation.map, group);
  }
  // The page slot map is the one that ever held a slot. The reply map of the injection
  // channel (spec 45) is a second Map and none of this helper's business — it holds
  // collections, never slots.
  const slotMaps = [...operationsPerMap.values()].filter((group) =>
    group.some((operation) => operation.slot === true),
  );
  assert.equal(
    slotMaps.length,
    1,
    `background.js must build exactly one slot map; the probe saw ${slotMaps.length}`,
  );

  return slotMaps.map((group) => {
    // The replay runs on copies from this realm: an operation that stayed a sandbox
    // object would fail `deepStrictEqual` on its prototype, whatever its fields say.
    const keys = new Map();
    const copied = inThisRealm(group.map(({ op, key }) => ({ op, key })));
    for (const { op, key } of copied) {
      if (op === "set") keys.set(key, true);
      else keys.delete(key);
    }
    return inThisRealm([...keys.keys()]);
  });
}

/**
 * Lets the bridge page's promise chains finish.
 *
 * `setImmediate` runs after the microtask queue has drained, so two rounds cover
 * even a chain of two awaits without guessing how many awaits the implementation
 * happens to use today.
 */
async function settleAsyncWork() {
  for (let round = 0; round < 2; round += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function openSocket() {
  const socket = FakeWebSocket.latest();
  assert.notEqual(socket, undefined, "the bridge page did not dial the endpoint");
  socket.open();
  await settleAsyncWork();
  return socket;
}

/* -------------------------------------------------------------- fixtures */

/**
 * Three windows, only the first of which is visible to the agent:
 * a normal window with one default-container tab and one container tab,
 * a private window, and a popup.
 *
 * The private window's tab reports `firefox-default` on purpose, so the test
 * proves the *window* filter drops it, not the tab filter.
 */
function createWindows() {
  return [
    {
      id: 1,
      focused: true,
      type: "normal",
      incognito: false,
      tabs: [
        {
          id: 101,
          active: true,
          pinned: false,
          url: "https://example.org/",
          title: "Beispiel",
          cookieStoreId: "firefox-default",
        },
        {
          id: 102,
          active: false,
          pinned: true,
          url: "https://example.net/",
          title: "Container",
          cookieStoreId: "firefox-container-1",
        },
      ],
    },
    {
      id: 2,
      focused: false,
      type: "normal",
      incognito: true,
      tabs: [
        {
          id: 201,
          active: true,
          pinned: false,
          url: "https://privat.example/",
          title: "Privat",
          cookieStoreId: "firefox-default",
        },
      ],
    },
    {
      id: 3,
      focused: false,
      type: "popup",
      incognito: false,
      tabs: [
        {
          id: 301,
          active: true,
          pinned: false,
          url: "https://popup.example/",
          title: "Popup",
          cookieStoreId: "firefox-default",
        },
      ],
    },
  ];
}

/**
 * Two windows the agent may touch, with the stored agent tab among them: window 1
 * holds the agent tab 500 *after* a foreign tab, so a mark that only ever lands on
 * the first entry of a list fails here. Tab 102 sits in a container and never
 * reaches the status answer — it is the id a stored container tab has to miss.
 *
 * Both windows are normal and not private, so the window filter keeps both.
 */
function createAgentWindows() {
  return [
    {
      id: 1,
      focused: true,
      type: "normal",
      incognito: false,
      tabs: [
        {
          id: 101,
          active: true,
          pinned: false,
          url: "https://example.org/",
          title: "Beispiel",
          cookieStoreId: "firefox-default",
        },
        {
          id: 102,
          active: false,
          pinned: true,
          url: "https://example.net/",
          title: "Container",
          cookieStoreId: "firefox-container-1",
        },
        {
          id: 500,
          active: false,
          pinned: false,
          url: "https://agent.example/",
          title: "Agent",
          cookieStoreId: "firefox-default",
        },
      ],
    },
    {
      id: 2,
      focused: false,
      type: "normal",
      incognito: false,
      tabs: [
        {
          id: 201,
          active: true,
          pinned: false,
          url: "https://zwei.example/",
          title: "Zwei",
          cookieStoreId: "firefox-default",
        },
        {
          id: 202,
          active: false,
          pinned: true,
          url: "https://drei.example/",
          title: "Drei",
          cookieStoreId: "firefox-default",
        },
      ],
    },
  ];
}

/**
 * Opens, sends `hello`, receives `welcome` and asks for `status`, id 1.
 *
 * `options` rides along next to endpoint and token, which is how a status case
 * gets a stored `agentTabId` or a store that refuses to answer. `settings` of the
 * options is merged, not replaced: the connection still needs its credentials.
 */
async function requestStatusIdOne(windows = createWindows(), options = {}) {
  await startBackground({
    ...options,
    settings: { endpoint: ENDPOINT, token: TOKEN, ...options.settings },
    windows,
  });
  const socket = await openSocket();
  socket.receive({ type: "welcome", protocol: 1, bridgeVersion: "0.1.0" });
  await settleAsyncWork();
  socket.receive({ type: "request", id: 1, method: "status", params: {} });
  await settleAsyncWork();
  return socket;
}

/** A configured, connected and welcomed extension — the state every `navigate` starts from. */
async function connectedBackground({
  settings = {},
  windows = createWindows(),
  tabs,
  calls,
  windowUpdateThrowsFor,
  windowUpdateStaleFocusFor,
  windowGetThrowsFor,
  windowFocusedAfter,
  storageReadFailsFor = [],
  storageWriteFailsFor = [],
  headFetch,
  encoder,
} = {}) {
  const started = await startBackground({
    settings: { endpoint: ENDPOINT, token: TOKEN, ...settings },
    windows,
    tabs,
    calls,
    windowUpdateThrowsFor,
    windowUpdateStaleFocusFor,
    windowGetThrowsFor,
    windowFocusedAfter,
    storageReadFailsFor,
    storageWriteFailsFor,
    headFetch,
    encoder,
  });
  const socket = await openSocket();
  socket.receive({ type: "welcome", protocol: 1, bridgeVersion: "0.1.0" });
  await settleAsyncWork();
  return { socket, ...started };
}

/**
 * A stored agent tab: background, in the default container of window 1, and
 * `loading` so a wait really has to wait for an event.
 */
function createAgentTabFixture(overrides = {}) {
  return {
    id: 500,
    windowId: 1,
    active: false,
    pinned: false,
    url: "https://before.example/",
    title: "Vorher",
    status: "loading",
    cookieStoreId: DEFAULT_COOKIE_STORE_ID,
    ...overrides,
  };
}

/**
 * Two agent tabs of the default container, `500` and `501`, and the list that holds
 * them: 500 sits at the *end*, so it is the last used one and 501 is the tab only an
 * explicit `tab` reaches.
 *
 * That is the whole point of every `…_withTab_` case: were the resolution to ignore
 * the parameter, the call would land in 500 — the same tab a `tab`-less call gets.
 * `overrides` reaches both tabs, because a read case needs `status: "complete"`.
 */
const TWO_AGENT_TABS_SETTINGS = { agentTabIds: [501, 500] };

function createTwoAgentTabs(overrides = {}) {
  return [
    createAgentTabFixture({ ...overrides, id: 500 }),
    createAgentTabFixture({ ...overrides, id: 501, url: "https://zwei.example/", title: "Zwei" }),
  ];
}

function responsesById(socket) {
  return new Map(
    socket.sent.filter((message) => message.type === "response").map((message) => [message.id, message]),
  );
}

/** Sends one `navigate` request and lets the bridge page work through it. */
async function sendNavigate(socket, id, params) {
  socket.receive({ type: "request", id, method: "navigate", params });
  await settleAsyncWork();
}

/**
 * Sends one `read` request.
 *
 * `params` defaults to `{}` and stays overridable, because "read *that* tab" is the
 * one argument this method takes.
 */
async function sendRead(socket, id, params = {}) {
  socket.receive({ type: "request", id, method: "read", params });
  await settleAsyncWork();
}

/**
 * Sends one `frames` request.
 *
 * `params` stays overridable for the same reason `read`'s does: `tab` is the one
 * argument this method takes, and "which tab" is a case of its own.
 */
async function sendFrames(socket, id, params = {}) {
  socket.receive({ type: "request", id, method: "frames", params });
  await settleAsyncWork();
}

/**
 * Sends one `focus` request.
 *
 * `params` defaults to `{}` and stays overridable, because "the caller passed an
 * argument after all" is a case of its own.
 */
async function sendFocus(socket, id, params = {}) {
  socket.receive({ type: "request", id, method: "focus", params });
  await settleAsyncWork();
}

/**
 * Sends one `open_tab` request.
 *
 * `params` stays overridable and not defaulted: "the caller forgot the URL" is a case
 * of its own, and `undefined` is one of its shapes.
 */
async function sendOpenTab(socket, id, params) {
  socket.receive({ type: "request", id, method: "open_tab", params });
  await settleAsyncWork();
}

/** Sends one `close_tab` request; `{}` means "close the last used one". */
async function sendCloseTab(socket, id, params = {}) {
  socket.receive({ type: "request", id, method: "close_tab", params });
  await settleAsyncWork();
}

/* ---------------------------------------------------------------- tests */

test("startBackground_withoutEndpointAndToken_shouldNotOpenConnection", async () => {
  // GIVEN a fresh install with an empty storage,
  const { clock, consoleLines } = await startBackground({ settings: {} });

  // WHEN the bridge page starts,
  await settleAsyncWork();

  // THEN it must neither dial nor schedule a retry — the operator has to fill in
  // the options page first, and a silent retry loop would only spam the console:
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.deepStrictEqual(clock.pendingDelays(), []);
  assert.ok(
    consoleLines.some((line) => line.includes("bc: background page started")),
    "the startup line is missing",
  );
  assert.equal(
    consoleLines.filter((line) => line.startsWith("warn:")).length,
    1,
    "the missing settings must be reported exactly once",
  );
});

test("startBackground_withEndpointButNoToken_shouldNotOpenConnection", async () => {
  // GIVEN an endpoint without a token,
  const { clock } = await startBackground({ settings: { endpoint: ENDPOINT } });

  // WHEN the bridge page starts,
  await settleAsyncWork();

  // THEN a connection without credentials would be closed by the bridge with
  // 4401 anyway, so it must not be attempted at all:
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("endpoint_withoutAStoredValue_shouldDialTheLoopbackDefault", async () => {
  // GIVEN a fresh install that has entered the token and nothing else,
  const { browser, clock, consoleLines } = await startBackground({ settings: { token: TOKEN } });

  // WHEN the bridge page starts,
  await settleAsyncWork();

  // THEN it dials the default endpoint instead of staying silent — the bridge on the
  // same machine already listens there:
  const socket = FakeWebSocket.latest();
  assert.notEqual(socket, undefined, "the default endpoint must be dialled");
  assert.equal(socket.url, ENDPOINT);
  // No warning about missing settings: nothing is missing any more.
  assert.equal(
    consoleLines.filter((line) => line.startsWith("warn:")).length,
    0,
    "nothing is missing, so nothing may be reported as missing",
  );
  assert.deepStrictEqual(clock.pendingDelays(), [], "a socket in flight needs no retry");
  // The fallback is not a stored value: the store still holds the token alone, so the
  // operator's settings stay theirs (spec 36).
  assert.deepStrictEqual(await browser.storage.local.get(["endpoint", "token"]), {
    token: TOKEN,
  });
});

/**
 * The dial address of a bridge page that has only a token — the observed value, not
 * a literal, because the two guards below compare against it.
 */
async function dialAddressWithoutAStoredEndpoint() {
  await startBackground({ settings: { token: TOKEN } });
  const socket = FakeWebSocket.latest();
  assert.notEqual(socket, undefined, "the default endpoint must be dialled");
  return socket.url;
}

test("endpoint_default_matchesTheBridgesDefaultPort", async () => {
  // GIVEN a fresh install that has entered the token and nothing else,
  const dialledAddress = await dialAddressWithoutAStoredEndpoint();

  // WHEN we read the address the bridge page dialled and the bridge's defaults,
  const dialled = new URL(dialledAddress);

  // THEN they have to be the same listener. This is the drift guard: changing one side
  // alone leaves an extension that dials a port nobody listens on.
  assert.equal(dialled.protocol, "ws:", "loopback is bare WebSocket; TLS is the Caddy path");
  assert.equal(dialled.hostname, BRIDGE_DEFAULT_HOST);
  assert.equal(dialled.port, String(BRIDGE_DEFAULT_PORT));
});

test("endpoint_default_isTheSameInOptionsAndBackground", async () => {
  // GIVEN a fresh install that has entered the token and nothing else,
  const dialledAddress = await dialAddressWithoutAStoredEndpoint();

  // WHEN we read the constant the options page shows in its field,
  const declared = OPTIONS_SOURCE.match(/const DEFAULT_ENDPOINT = "([^"]+)";/);

  // THEN it has to be the address that is actually dialled. Compared with the observed
  // `url`, never with the literal from this file: a guard against a literal would stay
  // green with two broken files.
  assert.notEqual(declared, null, "options.js must declare DEFAULT_ENDPOINT");
  assert.equal(
    declared[1],
    dialledAddress,
    "the options page would show a different endpoint than the one dialled",
  );
  // And only an empty field may become the default: a stored `wss://` address is the
  // operator's value and has to be shown as it is. Read as source text, because the
  // options page has no DOM harness.
  assert.ok(
    OPTIONS_SOURCE.includes('storedEndpoint === "" ? DEFAULT_ENDPOINT : storedEndpoint'),
    "loadSettings must fill only an empty endpoint field",
  );
});

test("endpoint_withAStoredValue_shouldDialThatValue", async () => {
  // GIVEN an endpoint behind the reverse proxy and a token,
  const storedEndpoint = "wss://bridge.example.test/browser-control/ws";
  await startBackground({ settings: { endpoint: storedEndpoint, token: TOKEN } });

  // WHEN the bridge page starts,
  await settleAsyncWork();

  // THEN the stored value is dialled. The default fills an empty field; it does not
  // correct an operator who meant something else.
  assert.equal(FakeWebSocket.latest()?.url, storedEndpoint);
});

/**
 * The dial address of a bridge page with the given endpoint and a token.
 *
 * The observed value, never a literal from this file: the guards below compare against
 * *what the page did*, so a test cannot agree with a broken implementation by sharing
 * its assumption.
 */
async function dialAddressOf(storedEndpoint) {
  await startBackground({ settings: { endpoint: storedEndpoint, token: TOKEN } });
  const socket = FakeWebSocket.latest();
  assert.notEqual(socket, undefined, "the endpoint must be dialled");
  return socket.url;
}

/**
 * The `ws://` rule: plain WebSocket only to this machine, `wss://` everywhere.
 *
 * The three loopback spellings are separate cases because they are three different
 * strings in a URL, and only the parsed host decides — `[::1]` arrives with its brackets
 * and `localhost` is a name, not an address.
 */
test("endpoint_wsOnLoopback_shouldConnect", async () => {
  // GIVEN a plain `ws://` endpoint on the loopback address the bridge binds,
  const storedEndpoint = ENDPOINT;

  // WHEN the bridge page starts,
  const dialled = await dialAddressOf(storedEndpoint);

  // THEN it dials exactly that — the local install needs no TLS:
  assert.equal(dialled, storedEndpoint);
  assert.equal(FakeWebSocket.instances.length, 1, "one endpoint, one socket");
});

test("endpoint_wsOnIpv6Loopback_shouldConnect", async () => {
  // GIVEN a plain `ws://` endpoint on the IPv6 loopback, brackets and all,
  const storedEndpoint = "ws://[::1]:8110";

  // WHEN the bridge page starts,
  const dialled = await dialAddressOf(storedEndpoint);

  // THEN the bracket form counts as this machine too:
  assert.equal(dialled, storedEndpoint);
  assert.equal(FakeWebSocket.instances.length, 1, "one endpoint, one socket");
});

test("endpoint_wsOnLocalhost_shouldConnect", async () => {
  // GIVEN a plain `ws://` endpoint spelled with the name instead of the address,
  const storedEndpoint = "ws://localhost:8110";

  // WHEN the bridge page starts,
  const dialled = await dialAddressOf(storedEndpoint);

  // THEN the name resolves to this machine as well:
  assert.equal(dialled, storedEndpoint);
  assert.equal(FakeWebSocket.instances.length, 1, "one endpoint, one socket");
});

test("endpoint_wsOnAnotherHost_shouldRefuseAndLogOnce", async () => {
  // GIVEN a plain `ws://` endpoint on a machine that is not this one, behind a path
  // so the path half of the rule is covered as well,
  const storedEndpoint = "ws://bridge.example.test:8110/browser-control/ws";
  const { clock, consoleLines } = await startBackground({
    settings: { endpoint: storedEndpoint, token: TOKEN },
  });

  // WHEN the bridge page starts,
  await settleAsyncWork();

  // THEN nothing is dialled at all — not "dialled and closed by the browser":
  assert.equal(FakeWebSocket.instances.length, 0, "an unencrypted remote dial must not happen");
  // ... and nothing is retried either. A wrong endpoint does not heal itself, so a
  // backoff loop would only repeat a message the operator has already been told.
  assert.deepStrictEqual(clock.pendingDelays(), [], "a misconfiguration is not a network error");

  // ... and the operator reads exactly one line, which names the way out:
  const refusedLines = consoleLines.filter((line) => line.includes("bc: ws:// ist nur für 127.0.0.1"));
  assert.equal(refusedLines.length, 1, "the rule must be reported exactly once");
  assert.ok(refusedLines[0].includes("wss://"), "the line must name the TLS alternative");
  assert.ok(refusedLines[0].includes("SSH-Tunnel"), "the line must name the tunnel alternative");
  // The endpoint stays out of the log: a hand-typed URL can carry credentials in its
  // authority, and this line is the one that ends up in a bug report.
  assert.equal(
    refusedLines[0].includes("bridge.example.test"),
    false,
    "the endpoint must not be logged",
  );
});

test("endpoint_wssOnAnotherHost_shouldConnect", async () => {
  // GIVEN a TLS endpoint on another machine — the Caddy path of `INSTALL.md` §9,
  const storedEndpoint = "wss://bridge.example.test/browser-control/ws";

  // WHEN the bridge page starts,
  const dialled = await dialAddressOf(storedEndpoint);

  // THEN the rule does not touch it: only the *scheme* on a non-loopback host is
  // refused, and this one is encrypted.
  assert.equal(dialled, storedEndpoint);
  assert.equal(FakeWebSocket.instances.length, 1, "one endpoint, one socket");
});

test("endpoint_wsWithPathOnLoopback_shouldConnect", async () => {
  // GIVEN a plain `ws://` endpoint on loopback with a path behind it,
  const storedEndpoint = "ws://127.0.0.1:8110/browser-control/ws";

  // WHEN the bridge page starts,
  const dialled = await dialAddressOf(storedEndpoint);

  // THEN the path is none of the rule's business — the host decides:
  assert.equal(dialled, storedEndpoint);
  assert.equal(FakeWebSocket.instances.length, 1, "one endpoint, one socket");
});

/**
 * The switch of spec 44, page side: a page that was not switched on does not dial.
 *
 * The state is written by `background.js` and tested there (criterion 2 and the click);
 * what this case pins is that the *page* obeys it — an extension that dials on load would
 * bring the socket back after every reload of the tab, switch or no switch.
 */
test("switch_withoutAStoredState_shouldNotDial", async () => {
  // GIVEN endpoint and token, and the switch off — a fresh install, or one whose store
  // lost the key,
  const { clock } = await startBackground({
    settings: { endpoint: ENDPOINT, token: TOKEN, bridgeEnabled: false },
  });

  // WHEN the bridge page loads,
  await settleAsyncWork();

  // THEN there is no socket and no retry: off means off, not "off until the first
  // backoff step".
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

/**
 * The one message the toolbar needs: whether the socket stands (spec 44, the bolt).
 *
 * The icon is the coordinator's, and the socket is the page's, so this message is the
 * only way the two can agree — a page that kept the news to itself would leave a crossed
 * or a bolted icon next to a perfectly healthy connection.
 */
test("switch_afterTheSocketOpens_shouldReportTheConnection", async () => {
  // GIVEN a switched-on extension,
  const { browser } = await startBackground({ settings: { endpoint: ENDPOINT, token: TOKEN } });

  // WHEN the socket opens,
  const socket = await openSocket();

  // THEN the page reported it — the message carries the sandbox realm's prototype, so
  // it comes back through the same JSON round trip as every other sandbox value:
  assert.deepStrictEqual(inThisRealm(browser.sentMessages.at(-1)), {
    type: "bc:connection",
    connected: true,
  });

  // ... and WHEN it goes away again, the loss is reported just as plainly.
  socket.fail();
  await settleAsyncWork();
  assert.deepStrictEqual(inThisRealm(browser.sentMessages.at(-1)), {
    type: "bc:connection",
    connected: false,
  });
});

test("state_whenAskedByTheCoordinator_shouldAnswerWithTheSocketState", async () => {
  // GIVEN a switched-on extension with an open socket,
  const tabs = createTabsStub();
  await startBackground({ settings: { endpoint: ENDPOINT, token: TOKEN }, tabs });
  const socket = await openSocket();

  // WHEN the coordinator wakes up blind and asks the page — the coordinator is an MV3
  // event page and forgets everything, the socket is the page's —
  // THEN the answer is `true`: the state the page reports, not a default,
  assert.equal(inThisRealm(await tabs.channel.askTheBridge({ type: "bc:state?" })).connected, true);

  // ... and WHEN the socket goes away again, the same question answers `false`. A page
  // that kept answering `true` would leave the bridge icon hanging over a dead socket.
  socket.fail();
  await settleAsyncWork();
  assert.equal(inThisRealm(await tabs.channel.askTheBridge({ type: "bc:state?" })).connected, false);
});

test("connect_withUnparseableEndpoint_shouldReportOnceAndScheduleReconnect", async () => {
  // GIVEN a hand-typed endpoint that is not a URL at all,
  const { clock, consoleLines } = await startBackground({
    settings: { endpoint: "not a url", token: TOKEN },
  });

  // WHEN the bridge page tries to dial,
  await settleAsyncWork();

  // THEN the synchronous `SyntaxError` of `new WebSocket(...)` must not end the
  // retry loop — nobody reads the console of a background script:
  const invalidEndpointLines = consoleLines.filter((line) => line.includes("bc: Endpunkt ungültig"));
  assert.equal(
    invalidEndpointLines.length,
    1,
    "the invalid endpoint must be reported exactly once per attempt",
  );
  assert.ok(
    invalidEndpointLines[0].includes("not a url"),
    "the line names the value the operator has to correct",
  );
  assert.equal(
    invalidEndpointLines.some((line) => line.includes(TOKEN)),
    false,
    "the token must never reach a log line",
  );
  assert.equal(FakeWebSocket.instances.length, 0, "nothing was dialled");
  assert.deepStrictEqual(clock.pendingDelays(), [1000], "a retry must be pending");
  // A stored typo stays the failure of the day: the default endpoint replaced nothing,
  // so it must not appear in the log as if it had been tried (spec 36).
  assert.equal(
    consoleLines.some((line) => line.includes(ENDPOINT)),
    false,
    "the standard endpoint must not be logged for a stored endpoint",
  );
});

test("connect_withEndpointAndToken_shouldSendHelloWithProtocolOneAndToken", async () => {
  // GIVEN a configured extension,
  await startBackground({ settings: { endpoint: ENDPOINT, token: TOKEN } });
  const socket = FakeWebSocket.latest();
  assert.equal(socket.url, ENDPOINT);

  // WHEN the WebSocket handshake completes,
  socket.open();
  await settleAsyncWork();

  // THEN the first frame is exactly the `hello` of the spec:
  assert.deepStrictEqual(socket.sent, [
    {
      type: "hello",
      protocol: 1,
      extensionVersion: MANIFEST_VERSION,
      browser: { name: BROWSER_INFO.name, version: BROWSER_INFO.version },
      token: TOKEN,
    },
  ]);
});

test("onMessage_afterWelcome_shouldAnswerStatusRequestWithTheRequestId", async () => {
  // GIVEN a connected extension that has just received `welcome`,
  await startBackground({ settings: { endpoint: ENDPOINT, token: TOKEN }, windows: createWindows() });
  const socket = await openSocket();

  // WHEN the bridge sends `welcome`,
  socket.receive({ type: "welcome", protocol: 1, bridgeVersion: "0.1.0" });
  await settleAsyncWork();

  // THEN the extension only records the connection time: the `status` request is
  // the bridge's job (`## Wire-Protokoll`, step 5), so nothing but `hello` may
  // have been sent so far:
  assert.equal(socket.sent.length, 1, "the extension must not send a request of its own");

  // WHEN the bridge then sends `request` with id 1,
  socket.receive({ type: "request", id: 1, method: "status", params: {} });
  await settleAsyncWork();
  const response = socket.sent.at(-1);

  // THEN the answer echoes that id and reports the extension's own state:
  assert.equal(response.type, "response");
  assert.equal(response.id, 1);
  assert.equal(response.ok, true);
  assert.equal(response.result.extension.version, MANIFEST_VERSION);
  assert.match(
    response.result.extension.connectedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "connectedAt must be the ISO timestamp of the `welcome`",
  );
});

test("collectStatus_withTabInMultiAccountContainer_shouldOmitThatTab", async () => {
  // GIVEN a profile with one default-container tab and one container tab,
  const socket = await requestStatusIdOne();

  // WHEN the status is collected,
  const { result } = socket.sent.at(-1);

  // THEN only the default container is left — a container tab has its own cookie
  // jar and would not be logged in:
  assert.deepStrictEqual(
    result.windows[0].tabs.map((tab) => tab.id),
    [101],
  );
});

test("collectStatus_withPrivateWindow_shouldOmitThatWindow", async () => {
  // GIVEN a normal window, a private window and a popup,
  const socket = await requestStatusIdOne();

  // WHEN the status is collected,
  const { result } = socket.sent.at(-1);

  // THEN only the normal, non-private window remains: private windows are
  // `type: "normal"` with `incognito: true`, and a popup is not a browser window
  // the agent should touch:
  assert.deepStrictEqual(
    result.windows.map((window) => window.id),
    [1],
  );
});

test("collectStatus_withTabWithoutUrl_shouldReportEmptyUrl", async () => {
  // GIVEN a tab that has no url yet, as `about:newtab` briefly does,
  const windows = [
    {
      id: 1,
      focused: true,
      type: "normal",
      incognito: false,
      tabs: [{ id: 101, active: true, pinned: false, title: "Neuer Tab", cookieStoreId: "firefox-default" }],
    },
  ];
  const socket = await requestStatusIdOne(windows);

  // WHEN the status is collected,
  const { result } = socket.sent.at(-1);

  // THEN the key exists and is empty instead of missing:
  assert.equal(result.windows[0].tabs[0].url, "");
});

/* ------------------------------------------------------ status: agent mark */

/** Every tab of the `status` answer, both windows flattened into one list. */
function statusTabs(socket) {
  return socket.sent.at(-1).result.windows.flatMap((window) => window.tabs);
}

/** The ids the answer marks as the agent's tab — one at most, if the mark is right. */
function markedTabIds(socket) {
  return statusTabs(socket)
    .filter((tab) => tab.agent === true)
    .map((tab) => tab.id);
}

test("status_withAStoredAgentTab_shouldMarkExactlyThatTab", async () => {
  // GIVEN a stored agent id that still exists in the default container — tab 500
  // sits behind a foreign tab of the same window, so "the first entry won" fails:
  const socket = await requestStatusIdOne(createAgentWindows(), { settings: { agentTabId: 500 } });

  // WHEN the status is collected,
  // THEN exactly that one tab is marked, and no other tab of either window:
  assert.deepStrictEqual(markedTabIds(socket), [500]);
});

test("status_shouldCarryTheAgentFieldOnEveryTab", async () => {
  // GIVEN a stored agent id and three tabs that belong to the operator alone,
  const socket = await requestStatusIdOne(createAgentWindows(), { settings: { agentTabId: 500 } });

  // WHEN the status is collected,
  const tabs = statusTabs(socket);

  // THEN every tab carries the field — nobody has to tell "no" apart from "not
  // asked" — and the foreign tabs say `false` instead of saying nothing:
  assert.deepStrictEqual(
    tabs.map((tab) => tab.id),
    [101, 500, 201, 202],
  );
  for (const tab of tabs) {
    assert.ok(Object.hasOwn(tab, "agent"), `tab ${tab.id} does not carry the agent field`);
    assert.equal(typeof tab.agent, "boolean", `tab ${tab.id} carries a non-boolean agent field`);
  }
});

test("status_withThreeAgentTabs_shouldMarkEachExactlyOnce", async () => {
  // GIVEN three agent tabs across two windows — 500 in window 1, 201 and 202 in
  // window 2 — and the one container tab that is never addressable:
  const socket = await requestStatusIdOne(createAgentWindows(), {
    settings: { agentTabIds: [500, 201, 202] },
  });

  // WHEN the status is collected,
  // THEN all three are marked and nothing else is: the answer used to be able to mark
  // one tab at most, which is exactly what this increment lifts. Tab 102 in the
  // container stays unmarked, as it must:
  assert.deepStrictEqual(markedTabIds(socket), [500, 201, 202]);
  assert.deepStrictEqual(
    statusTabs(socket).map((tab) => tab.id),
    [101, 500, 201, 202],
  );
});

/**
 * The bridge tab is not a page (spec 42, criteria 13 and 14).
 *
 * `background.js` opens it and `bridge.js` runs inside it — the transport of this
 * extension. No tool may see or touch it: a `read` or `close_tab` there would hand the
 * agent the extension's own socket page, and a status answer that listed it would invite
 * exactly that. Matched by url, because the url is the only mark that survives a reload.
 */
const BRIDGE_TAB_URL = "moz-extension://bridge-page-test/bridge.html";

function createBridgePageTab(overrides = {}) {
  return createAgentTabFixture({
    id: 601,
    url: BRIDGE_TAB_URL,
    title: "Browser Control — Bridge",
    pinned: true,
    ...overrides,
  });
}

test("status_shouldNotListTheBridgeTab", async () => {
  // GIVEN a window whose tabs include the extension's own bridge page — pinned, in the
  // default container, exactly as `background.js` creates it,
  const windows = [
    {
      id: 1,
      focused: true,
      type: "normal",
      incognito: false,
      tabs: [
        {
          id: 101,
          active: true,
          pinned: false,
          url: "https://example.org/",
          title: "Beispiel",
          cookieStoreId: "firefox-default",
        },
        {
          id: 601,
          active: false,
          pinned: true,
          url: BRIDGE_TAB_URL,
          title: "Browser Control — Bridge",
          cookieStoreId: "firefox-default",
        },
      ],
    },
  ];

  // WHEN the status is collected,
  const socket = await requestStatusIdOne(windows);

  // THEN the operator's tab is there and the bridge tab is not:
  assert.deepStrictEqual(statusTabs(socket).map((tab) => tab.id), [101]);

  // ... and the page is not named anywhere in the answer either — a filter that only
  // dropped the tab entry but kept its url would pass a count of ids and fail the
  // criterion (`grep -c 'bridge.html'` on the answer ⇒ 0):
  assert.equal(
    JSON.stringify(socket.sent.at(-1)).includes("bridge.html"),
    false,
    "the bridge page must not be named in the status answer",
  );
});

test("read_withTheBridgeTabId_shouldAnswerNoAgentTab", async () => {
  // GIVEN a store that names the bridge tab as an agent tab — `storage.local` is what an
  // operator with a console can edit, and the list is a hint the extension writes,
  const tabs = createTabsStub({ tabs: [createBridgePageTab({ status: "complete" })] });
  const { socket } = await connectedBackground({
    tabs,
    settings: { agentTabIds: [601] },
  });

  // WHEN the bridge reads it by name,
  await sendRead(socket, 2, { tab: 601 });

  // THEN it is `no_agent_tab` — the transport is not a page — and nothing was injected:
  assert.equal(responsesById(socket).get(2).error.code, "no_agent_tab");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("closeTab_withTheBridgeTabId_shouldAnswerNoAgentTab", async () => {
  // GIVEN the same store, where the bridge tab is the last used one,
  const tabs = createTabsStub({ tabs: [createBridgePageTab()] });
  const { socket } = await connectedBackground({
    tabs,
    settings: { agentTabIds: [601] },
  });

  // WHEN the bridge closes it,
  await sendCloseTab(socket, 2, { tab: 601 });

  // THEN it is `no_agent_tab` as well, and the tab is still open: closing it would kill
  // the connection the call arrived on.
  assert.equal(responsesById(socket).get(2).error.code, "no_agent_tab");
  assert.deepStrictEqual(tabs.calls.filter((call) => call.kind === "tabs.remove"), []);
});

/**
 * Closes a tab the way the browser does.
 *
 * Two stores, because the stubs keep them apart: `status` answers from
 * `windows.getAll`, so a tab that only left the tab stub would still be reported.
 * Deliberately not `close_tab` — the mark of a *closed* tab must be provable without
 * the increment that adds closing.
 */
function closeTabInEveryStore(windows, tabs, tabId) {
  tabs.remove(tabId);
  for (const window of windows) {
    window.tabs = window.tabs.filter((tab) => tab.id !== tabId);
  }
}

test("status_afterOneWasClosed_shouldMarkOnlyTheRemaining", async () => {
  // GIVEN three agent tabs, of which 201 has been closed by the operator in the
  // meantime:
  const windows = createAgentWindows();
  const tabs = createTabsStub({ tabs: createTwoAgentTabs() });
  const { socket, browser } = await connectedBackground({
    windows,
    tabs,
    settings: { agentTabIds: [500, 201, 202] },
  });
  closeTabInEveryStore(windows, tabs, 201);

  // WHEN the status is collected,
  await sendStatus(socket, 1);

  // THEN the closed tab is not in the answer at all, and only the two that still
  // exist carry the mark:
  assert.deepStrictEqual(
    statusTabs(socket).map((tab) => tab.id),
    [101, 500, 202],
  );
  assert.deepStrictEqual(markedTabIds(socket), [500, 202]);

  // ... and its id is still in the list: `status` does not prune. A `tabs.get` per
  // stored id would make the cheapest call of the extension the most expensive, and
  // the window list already tells the truth.
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [500, 201, 202],
  });
});

test("status_withAStaleAgentId_shouldMarkNoTab", async () => {
  // GIVEN a stored id that points at a tab the browser no longer has — the normal
  // case after a restart, because tab ids do not survive one:
  const socket = await requestStatusIdOne(createAgentWindows(), { settings: { agentTabId: 999 } });

  // WHEN the status is collected,
  const answer = socket.sent.at(-1);

  // THEN the status still comes, unmarked: a hint that points nowhere is not an
  // error, and picking a tab to mark anyway would lie to the operator:
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(
    statusTabs(socket).map((tab) => tab.id),
    [101, 500, 201, 202],
  );
  assert.deepStrictEqual(markedTabIds(socket), []);
});

test("status_withTheAgentIdInAContainerTab_shouldMarkNoTab", async () => {
  // GIVEN a stored id that points at tab 102, a tab in a multi-account container,
  const socket = await requestStatusIdOne(createAgentWindows(), { settings: { agentTabId: 102 } });

  // WHEN the status is collected,
  const windowOne = socket.sent.at(-1).result.windows.find((window) => window.id === 1);

  // THEN window 1 still reports the default-container tabs it kept, and none of
  // them is marked — without this the case would be true for the boring reason
  // that the list is empty:
  assert.deepStrictEqual(
    windowOne.tabs.map((tab) => tab.id),
    [101, 500],
  );
  assert.deepStrictEqual(
    windowOne.tabs.map((tab) => tab.agent),
    [false, false],
  );

  // ... and no other tab of the answer is marked either:
  assert.deepStrictEqual(markedTabIds(socket), []);
});

test("status_withoutAStoredAgentId_shouldMarkNoTab", async () => {
  // GIVEN an extension that has never navigated — no id in the settings at all,
  const socket = await requestStatusIdOne(createAgentWindows());

  // WHEN the status is collected,
  const tabs = statusTabs(socket);

  // THEN every tab answers `false`, and the field is still there on each of them:
  assert.deepStrictEqual(
    tabs.map((tab) => tab.agent),
    [false, false, false, false],
  );
  assert.equal(
    tabs.every((tab) => Object.hasOwn(tab, "agent")),
    true,
    "an unstored id must not turn `agent` into a missing key",
  );
});

test("status_whenTheSettingsReadFails_shouldStillAnswer", async () => {
  // GIVEN a `storage.local` that refuses to hand out the stored agent id,
  const socket = await requestStatusIdOne(createAgentWindows(), { storageReadFailsFor: ["agentTabId"] });

  // WHEN the status is collected,
  const answer = socket.sent.at(-1);

  // THEN the convenience costs the mark, not the answer: a broken store is not a
  // broken status, and the caller is not told about a setting it never asked for:
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(
    statusTabs(socket).map((tab) => tab.agent),
    [false, false, false, false],
  );
});

/* ------------------------------------------------- storage: agent tab list */

/**
 * Sends one `status` request and lets the bridge page work through it.
 *
 * The migration cases need the browser stub next to the answer, which is why they
 * build their own background instead of going through `requestStatusIdOne`.
 */
async function sendStatus(socket, id) {
  socket.receive({ type: "request", id, method: "status", params: {} });
  await settleAsyncWork();
}

test("status_withOnlyTheOldAgentTabIdKey_shouldMigrateToTheListAndDropTheOldKey", async () => {
  // GIVEN a store that still holds the single `agentTabId` of the previous
  // increment — the state every install of the update starts in:
  const { socket, browser } = await connectedBackground({
    windows: createAgentWindows(),
    settings: { agentTabId: 500 },
  });

  // WHEN the status is collected,
  await sendStatus(socket, 1);

  // THEN the old id is still the answered one, and it now lives in the list: the
  // migration rides on the first read, so no separate step can be forgotten. The
  // old key is gone — asking for both keys proves it, because a key that is there
  // comes back:
  assert.deepStrictEqual(markedTabIds(socket), [500]);
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds", "agentTabId"])), {
    agentTabIds: [500],
  });
});

test("migration_withAnEmptyListAndAValidOldId_shouldKeepTheOldId", async () => {
  // GIVEN an empty list *and* a usable old id — what an interrupted migration
  // leaves behind when its `set` threw after another write cleared the list:
  const { socket, browser } = await connectedBackground({
    windows: createAgentWindows(),
    settings: { agentTabIds: [], agentTabId: 500 },
  });

  // WHEN the status is collected,
  await sendStatus(socket, 1);

  // THEN the old id wins: an empty list is no truth to trust against it, and
  // preferring it would hand the operator's tab to a half-finished migration:
  assert.deepStrictEqual(markedTabIds(socket), [500]);
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds", "agentTabId"])), {
    agentTabIds: [500],
  });
});

test("migration_withANonEmptyListAndAValidOldId_shouldKeepTheListAndDropTheOldId", async () => {
  // GIVEN a list that already is the truth *and* a leftover old id — the state of an
  // install that carried `agentTabId` through the update and has been driven by the
  // list since:
  const { socket, browser } = await connectedBackground({
    windows: createAgentWindows(),
    settings: { agentTabIds: [501, 502], agentTabId: 500 },
  });

  // WHEN the status is collected,
  await sendStatus(socket, 1);

  // THEN the list wins: no live tab is marked, because 501 and 502 are gone while 500
  // — still open in the stub — is *not*. A migration that preferred the old id here
  // would resurrect a tab the operator has not addressed since the update:
  assert.deepStrictEqual(markedTabIds(socket), []);

  // ... and the old key goes with the same read, so no later read can pick it up
  // again. Asking for both keys at once proves it, because a key that is there comes
  // back:
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds", "agentTabId"])), {
    agentTabIds: [501, 502],
  });
});

test("migration_withANonIntegerOldValue_shouldTreatItAsAbsent", async () => {
  // GIVEN an old value that is not a tab id at all — a `"500"` left by an older
  // options page, say:
  const { socket, browser } = await connectedBackground({
    windows: createAgentWindows(),
    settings: { agentTabId: "500" },
  });

  // WHEN the status is collected,
  await sendStatus(socket, 1);

  // THEN it counts as not there: no tab is marked, and no list is invented from a
  // value the extension cannot address anyway:
  assert.deepStrictEqual(markedTabIds(socket), []);
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {});
});

test("migration_whenTheStoreWriteThrows_shouldStillAnswerWithTheOldId", async () => {
  // GIVEN a store that refuses the write of the new key,
  const { socket, browser, consoleLines } = await connectedBackground({
    windows: createAgentWindows(),
    settings: { agentTabId: 500 },
    storageWriteFailsFor: ["agentTabIds"],
  });

  // WHEN the status is collected,
  await sendStatus(socket, 1);

  // THEN this read still answers with the old id — the tab is where it was:
  assert.deepStrictEqual(markedTabIds(socket), [500]);

  // ... and the old key stays, because removing it would end every chance a later
  // read has of finding that tab again:
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds", "agentTabId"])), {
    agentTabId: 500,
  });
  assert.ok(
    consoleLines.some((line) => line.startsWith("warn: bc: Agenten-Tab-Ids nicht gespeichert")),
    "a failed migration write must be reported",
  );
});

/* -------------------------------------------------------------- navigate */

test("navigate_withoutAStoredAgentTab_shouldCreateAnInactiveTabInTheNormalWindow", async () => {
  // GIVEN a connected extension that has never navigated:
  const { socket, browser } = await connectedBackground();

  // WHEN the bridge asks for a URL,
  await sendNavigate(socket, 2, { url: AGENT_URL });

  // THEN one background tab is created, in the window the status filter allows,
  // and its id is remembered for the next call:
  assert.deepStrictEqual(browser.tabs.created, [{ url: AGENT_URL, active: false, windowId: 1 }]);
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [CREATED_TAB_ID],
  });
  assert.equal(responsesById(socket).size, 0, "nothing is answered before the page reports complete");
});

test("navigate_withAStoredLiveTab_shouldUpdateThatTabInsteadOfCreatingANewOne", async () => {
  // GIVEN a remembered agent tab that still exists in the default container,
  const tabs = createTabsStub({ tabs: [createAgentTabFixture()] });
  const { socket } = await connectedBackground({ tabs, settings: { agentTabId: 500 } });

  // WHEN the bridge asks for another URL,
  await sendNavigate(socket, 2, { url: "https://example.net/" });

  // THEN that tab is navigated — a `create` here would mean a second tab bar
  // entry per call, which is exactly the leak the stored id prevents:
  assert.deepStrictEqual(tabs.updated, [{ tabId: 500, url: "https://example.net/" }]);
  assert.deepStrictEqual(tabs.created, []);
});

test("navigate_withTab_shouldUpdateThatTab", async () => {
  // GIVEN two agent tabs, 500 the last used one and 501 the one a request can name,
  const tabs = createTabsStub({ tabs: createTwoAgentTabs() });
  const { socket } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge navigates tab 501 by name,
  await sendNavigate(socket, 2, { url: "https://example.net/", tab: 501 });

  // THEN exactly that tab is sent to the address and nothing is created: the last
  // used tab is left on its page, which is the point of addressing one at all:
  assert.deepStrictEqual(tabs.updated, [{ tabId: 501, url: "https://example.net/" }]);
  assert.deepStrictEqual(tabs.created, []);

  // ... and the answer is that tab's, once it says its page is there. Half a proof
  // would leave room for a `navigate` that moves the tab and then denies it happened.
  tabs.emitUpdated(501, { status: "complete" }, {
    id: 501,
    windowId: 1,
    url: "https://example.net/",
    title: "Netz",
    status: "complete",
  });
  await settleAsyncWork();
  assert.deepStrictEqual(responsesById(socket).get(2).result, {
    tabId: 501,
    windowId: 1,
    url: "https://example.net/",
    title: "Netz",
    complete: true,
    settled: false,
    waitedMs: 0,
  });
});

test("navigate_withTabAsAString_shouldAnswerInvalidParams", async () => {
  // GIVEN two agent tabs and a `tab` that is a string — the same mistake `read`
  // refuses, but `navigate` answers in its *own* error type:
  for (const tab of ["31", 0, -1]) {
    const tabs = createTabsStub({ tabs: createTwoAgentTabs() });
    const { socket } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

    // WHEN the bridge navigates with it,
    await sendNavigate(socket, 2, { url: AGENT_URL, tab });

    // THEN the answer is `invalid_params` — not `navigate_failed`, which is what a
    // `requestTabId` call without `NavigateError` would produce — and no tab was
    // touched:
    // Named first: without the supersede in `closeAgentTab` this would fail as a TypeError on
  // `undefined.ok` instead of saying what is wrong.
  assert.ok(responsesById(socket).has(2), "the waiting click must have been answered");
  const answer = responsesById(socket).get(2);
    assert.equal(answer.error.code, "invalid_params", `tab: ${JSON.stringify(tab)}`);
    assert.deepStrictEqual(tabs.updated, []);
    assert.deepStrictEqual(tabs.created, []);
  }
});

test("navigate_withATabThatIsNotInTheList_shouldAnswerNoAgentTab", async () => {
  // GIVEN two agent tabs and the operator's own tab 101 — alive, in the default
  // container, and no agent tab:
  const tabs = createTabsStub({
    tabs: [
      createAgentTabFixture({ id: 101, url: "https://example.org/", title: "Beispiel" }),
      ...createTwoAgentTabs(),
    ],
  });
  const { socket, browser } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge navigates that tab by name,
  await sendNavigate(socket, 2, { url: AGENT_URL, tab: 101 });

  // THEN it is `no_agent_tab` and no substitute is created — a "foreign tab" is not a
  // category the extension knows, and writing this page into the operator's tab would
  // be the worst reading of "the caller named something":
  assert.equal(responsesById(socket).get(2).error.code, "no_agent_tab");
  assert.deepStrictEqual(tabs.updated, []);
  assert.deepStrictEqual(tabs.created, []);

  // ... and the id does not sneak into the list, where `status` would mark it.
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [501, 500],
  });
});

test("navigate_withTab_whenTheUpdateFails_shouldAnswerNoAgentTabAndCreateNothing", async () => {
  // GIVEN a named tab that is gone between the lookup and the update,
  const tabs = createTabsStub({ tabs: createTwoAgentTabs(), updateThrowsFor: [501] });
  const { socket, consoleLines } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge navigates that tab,
  await sendNavigate(socket, 2, { url: AGENT_URL, tab: 501 });

  // THEN no substitute is created: a fresh tab in place of the one the caller named
  // would be a page nobody asked for. Only the path *without* a `tab` may replace a
  // vanished tab.
  assert.equal(responsesById(socket).get(2).error.code, "no_agent_tab");
  assert.deepStrictEqual(tabs.created, []);
  assert.deepStrictEqual(tabs.updated, []);

  // ... and the "a new tab is being created" warning of the other path stays silent,
  // because no tab is being created here.
  assert.equal(
    consoleLines.some((line) => line.startsWith("warn: bc: Agenten-Tab nicht aktualisiert")),
    false,
  );
});

test("navigate_withAStoredTabThatIsGone_shouldCreateANewTabAndStoreItsId", async () => {
  // GIVEN a stored id that points nowhere — the normal case after a browser
  // restart, because tab ids do not survive one:
  const tabs = createTabsStub();
  const { socket, browser } = await connectedBackground({ tabs, settings: { agentTabId: 500 } });

  // WHEN the bridge navigates,
  await sendNavigate(socket, 2, { url: AGENT_URL });

  // THEN the old id is not used to fail the call: a fresh tab is created and the
  // list follows it — the stale id falls out instead of being appended to, so a
  // list that collects corpses cannot creep up to the cap of `open_tab`:
  assert.deepStrictEqual(tabs.created, [{ url: AGENT_URL, active: false, windowId: 1 }]);
  assert.deepStrictEqual(tabs.updated, []);
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [CREATED_TAB_ID],
  });
});

test("navigate_whenTheStoredTabIsClosedBeforeTheUpdate_shouldCreateANewTabAndStoreItsId", async () => {
  // GIVEN a stored agent tab that exists while it is checked but is gone by the
  // time it is navigated — closed in the window between `get` and `update`:
  const tabs = createTabsStub({ tabs: [createAgentTabFixture()], updateThrowsFor: [500] });
  const { socket, browser, consoleLines } = await connectedBackground({ tabs, settings: { agentTabId: 500 } });

  // WHEN the bridge navigates,
  await sendNavigate(socket, 2, { url: AGENT_URL });

  // THEN the failed update ends like a stale stored id: a new tab in the chosen
  // window, and the list holds that one alone — the tab the update could no longer
  // reach is gone from the store, so the prune drops it:
  assert.deepStrictEqual(tabs.updated, []);
  assert.deepStrictEqual(tabs.created, [{ url: AGENT_URL, active: false, windowId: 1 }]);
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [CREATED_TAB_ID],
  });

  // ... and the reason is on the console: the same catch takes every other update
  // failure too, so a silent second tab would hide it for good.
  assert.ok(
    consoleLines.some((line) => line.startsWith("warn: bc: Agenten-Tab nicht aktualisiert")),
    "the failed update must be reported",
  );
});

test("navigate_withAStoredTabInAContainer_shouldUseADefaultContainerTabInstead", async () => {
  // GIVEN a stored tab that lives in a multi-account container — logged in
  // nowhere, because it has its own cookie jar:
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ cookieStoreId: "firefox-container-1" })],
  });
  const { socket, browser } = await connectedBackground({ tabs, settings: { agentTabId: 500 } });

  // WHEN the bridge navigates,
  await sendNavigate(socket, 2, { url: AGENT_URL });

  // THEN a default-container tab is created instead, and the container tab is
  // left alone — it is not addressable, so it also leaves the list:
  assert.deepStrictEqual(tabs.created, [{ url: AGENT_URL, active: false, windowId: 1 }]);
  assert.deepStrictEqual(tabs.updated, []);
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [CREATED_TAB_ID],
  });
});

test("navigate_whenTheFocusedWindowIsPrivate_shouldCreateTheTabInTheNormalWindow", async () => {
  // GIVEN a private window in front and a normal window behind it,
  const windows = [
    { id: 2, focused: true, type: "normal", incognito: true, tabs: [] },
    { id: 1, focused: false, type: "normal", incognito: false, tabs: [] },
  ];
  const { socket, browser } = await connectedBackground({ windows });

  // WHEN the bridge navigates,
  await sendNavigate(socket, 2, { url: AGENT_URL });

  // THEN the window is named explicitly, so the tab cannot land in the private
  // window — it would be invisible to `status` and be replaced on every call:
  assert.deepStrictEqual(browser.tabs.created, [{ url: AGENT_URL, active: false, windowId: 1 }]);
});

test("navigate_withOnlyPrivateWindows_shouldRefuseWithNoDefaultWindowAndCreateNoTab", async () => {
  // GIVEN a browser whose only window is private,
  const windows = [{ id: 2, focused: true, type: "normal", incognito: true, tabs: [] }];
  const { socket, browser } = await connectedBackground({ windows });

  // WHEN the bridge navigates,
  await sendNavigate(socket, 2, { url: AGENT_URL });

  // THEN the request is refused before anything is created: an agent tab in a
  // private window would be a tab the operator never agreed to.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "no_default_window");
  assert.deepStrictEqual(browser.tabs.created, []);
  assert.deepStrictEqual(browser.tabs.updated, []);
});

test("navigate_withANonHttpUrl_shouldRefuseWithInvalidUrlAndTouchNoTab", async () => {
  // GIVEN a connected extension:
  const { socket, browser } = await connectedBackground();

  // WHEN the bridge asks for something that is not a web page — including a
  // bare host, which `new URL` refuses as a relative value,
  const urls = ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hallo", "example.org/", ""];
  for (const [index, url] of urls.entries()) {
    await sendNavigate(socket, 10 + index, { url });
  }

  // THEN every one of them is refused with the documented code and sentence,
  for (const [index, url] of urls.entries()) {
    const answer = responsesById(socket).get(10 + index);
    assert.equal(answer.ok, false, `${url} must be refused`);
    assert.equal(answer.error.code, "invalid_url", `${url} must be an invalid_url`);
    assert.equal(answer.error.message, "Only http:// and https:// are allowed.");
  }

  // ... and no tab was created or navigated for any of them.
  assert.deepStrictEqual(browser.tabs.created, []);
  assert.deepStrictEqual(browser.tabs.updated, []);
});

test("navigate_withoutAUsableUrl_shouldRefuseWithInvalidParamsAndTouchNoTab", async () => {
  // GIVEN a connected extension:
  const { socket, browser } = await connectedBackground();

  // WHEN `url` is missing or is not a string,
  const params = [{}, { url: null }, { url: 42 }, { url: [AGENT_URL] }, undefined];
  for (const [index, value] of params.entries()) {
    await sendNavigate(socket, 20 + index, value);
  }

  // THEN each call is a parameter error, not a URL error — the bridge can only
  // fix the second one,
  for (let index = 0; index < params.length; index += 1) {
    assert.equal(responsesById(socket).get(20 + index).error.code, "invalid_params");
  }

  // ... and nothing in the browser changed.
  assert.deepStrictEqual(browser.tabs.created, []);
  assert.deepStrictEqual(browser.tabs.updated, []);
});

test("navigate_whenTheTabReportsComplete_shouldAnswerWithAllSevenFieldsFromTheLoadedTab", async () => {
  // GIVEN a navigation waiting for its page:
  const { socket, browser, clock } = await connectedBackground();
  await sendNavigate(socket, 2, { url: AGENT_URL });

  // WHEN the tab reports that it finished loading, with the URL a redirect left
  // behind and the title the page ended up with,
  browser.tabs.emitUpdated(CREATED_TAB_ID, { status: "complete" }, {
    id: CREATED_TAB_ID,
    windowId: 1,
    url: "https://example.org/final",
    title: "Example Domain",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN the answer carries all seven fields, and `url`/`title` come from the tab
  // after loading — otherwise every redirect would be invisible to the agent. The
  // settle pair comes from the page this very tab answers with, which says nothing
  // about its quiet here: `false`/`0` is the honest report of that.
  assert.deepStrictEqual(responsesById(socket).get(2), {
    type: "response",
    id: 2,
    ok: true,
    result: {
      tabId: CREATED_TAB_ID,
      windowId: 1,
      url: "https://example.org/final",
      title: "Example Domain",
      complete: true,
      settled: false,
      waitedMs: 0,
    },
  });
  assert.equal(browser.tabs.listenerCount(), 0, "the listener must be gone after the answer");
  assert.deepStrictEqual(clock.pendingDelays(), [], "the settle must leave no timer behind");
});

test("navigate_whenOnUpdatedFiresForAnotherTab_shouldKeepWaitingForItsOwn", async () => {
  // GIVEN a navigation waiting for its page:
  const { socket, browser } = await connectedBackground();
  await sendNavigate(socket, 2, { url: AGENT_URL });

  // WHEN another tab finishes loading — the operator's own browsing,
  browser.tabs.emitUpdated(101, { status: "complete" }, {
    id: 101,
    windowId: 1,
    url: "https://operator.example/",
    title: "Operator",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN that is not an answer: the agent's request keeps waiting, and its one
  // listener is still registered.
  assert.equal(responsesById(socket).size, 0);
  assert.equal(browser.tabs.listenerCount(), 1);
});

test("navigate_whenThePostUpdateReadStillReportsTheOldPagesComplete_shouldWaitForTheNewPageAndAnswerAllSevenFields", async () => {
  // GIVEN a stored agent tab showing a finished page, and a browser whose
  // `tabs.update` and every `tabs.get` after it keep reporting that page — the
  // defect a real run hit:
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    updateKeepsStatusCompleteFor: [500],
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: { agentTabId: 500 } });

  // WHEN the bridge navigates to another page,
  await sendNavigate(socket, 2, { url: AGENT_URL });

  // THEN the `complete` of the page that is on its way out is not the answer: the
  // call keeps waiting, with its one listener and the one 8 s timer.
  assert.equal(responsesById(socket).has(2), false, "the old page must not become the answer");
  assert.equal(tabs.listenerCount(), 1);
  assert.deepStrictEqual(clock.pendingDelays(), [NAVIGATE_TIMEOUT_MS]);

  // WHEN the new page reports that it finished loading,
  tabs.emitUpdated(500, { status: "complete" }, {
    id: 500,
    windowId: 1,
    url: AGENT_URL,
    title: "Example Domain",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN the answer carries all seven fields and the new page — the same defect
  // also dropped `windowId`:
  assert.deepStrictEqual(responsesById(socket).get(2), {
    type: "response",
    id: 2,
    ok: true,
    result: {
      tabId: 500,
      windowId: 1,
      url: AGENT_URL,
      title: "Example Domain",
      complete: true,
      settled: false,
      waitedMs: 0,
    },
  });
  assert.equal(tabs.listenerCount(), 0, "the answer must not leave a listener behind");
  assert.deepStrictEqual(clock.pendingDelays(), [], "the settle must leave no timer behind");
});

test("navigate_whenTheTabReportsAboutBlankAfterTheUpdate_shouldWaitForTheRealPageAndAnswerAllSevenFields", async () => {
  // GIVEN a stored agent tab and a browser whose `update` and every `get` after it
  // report `about:blank` with the old page's title — the state of a tab that was
  // moved into another window, which a real run answered with `complete: true`:
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    updateReportsAboutBlankFor: [500],
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: { agentTabId: 500 } });

  // WHEN the bridge navigates to another page,
  await sendNavigate(socket, 2, { url: AGENT_URL });

  // THEN the shell page is not the answer: `about:blank` and "Vorher" say nothing
  // about the requested page, so the call keeps waiting with its one listener.
  assert.equal(responsesById(socket).has(2), false, "about:blank must not become the answer");
  assert.equal(tabs.listenerCount(), 1);
  assert.deepStrictEqual(clock.pendingDelays(), [NAVIGATE_TIMEOUT_MS]);

  // WHEN the tab reports the shell page as finished — the window move completing,
  tabs.emitUpdated(500, { status: "complete" }, {
    id: 500,
    windowId: 1,
    url: "about:blank",
    title: "Vorher",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN that event is not the answer either — the same rule holds on the event
  // path, or a `complete` about nothing would still end the wait.
  assert.equal(responsesById(socket).has(2), false, "an about: event must not end the wait");
  assert.equal(tabs.listenerCount(), 1);

  // WHEN the new page finally reports itself,
  tabs.emitUpdated(500, { status: "complete" }, {
    id: 500,
    windowId: 1,
    url: AGENT_URL,
    title: "Example Domain",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN the answer carries all seven fields and the page that is really there.
  assert.deepStrictEqual(responsesById(socket).get(2), {
    type: "response",
    id: 2,
    ok: true,
    result: {
      tabId: 500,
      windowId: 1,
      url: AGENT_URL,
      title: "Example Domain",
      complete: true,
      settled: false,
      waitedMs: 0,
    },
  });
  assert.equal(tabs.listenerCount(), 0, "the answer must not leave a listener behind");
  assert.deepStrictEqual(clock.pendingDelays(), [], "the settle must leave no timer behind");
});

test("navigate_whenTheTabStaysOnAboutBlank_shouldAnswerAfterEightSecondsWithTheRequestedAddress", async () => {
  // GIVEN the same stored tab, moved into another window and never reaching the new
  // page:
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    updateReportsAboutBlankFor: [500],
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: { agentTabId: 500 } });
  await sendNavigate(socket, 2, { url: AGENT_URL });
  assert.equal(responsesById(socket).has(2), false);

  // WHEN the eight seconds pass,
  assert.equal(clock.runNext(), NAVIGATE_TIMEOUT_MS);
  await settleAsyncWork();

  // THEN the answer says `complete: false` and names the *requested* address — the
  // shell page is not a page of this navigation, and its title is not a title. No
  // settle ran either: a page that never loaded is not worth watching.
  assert.deepStrictEqual(responsesById(socket).get(2).result, {
    tabId: 500,
    windowId: 1,
    url: AGENT_URL,
    title: "",
    complete: false,
    settled: false,
    waitedMs: 0,
  });
  assert.equal(tabs.listenerCount(), 0);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("navigate_toTheAddressTheTabAlreadyShows_shouldAnswerImmediatelyWithoutNavigating", async () => {
  // GIVEN a stored agent tab that already shows the requested page — spelled
  // without the trailing slash that `new URL` normalises away — and a finished
  // load:
  const tabs = createTabsStub({
    tabs: [
      createAgentTabFixture({ url: "https://example.org", title: "Example Domain", status: "complete" }),
    ],
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: { agentTabId: 500 } });

  // WHEN the bridge navigates to that page,
  await sendNavigate(socket, 2, { url: AGENT_URL });

  // THEN the answer is there at once, with all seven fields: a `tabs.update` would
  // restart the load, and the tab would never report another `complete` for a page
  // it never left. The address is shown, so nothing is waited for: `NO_SETTLE`, and
  // no fallback — that one is `click`'s.
  assert.deepStrictEqual(responsesById(socket).get(2).result, {
    tabId: 500,
    windowId: 1,
    url: "https://example.org",
    title: "Example Domain",
    complete: true,
    settled: false,
    waitedMs: 0,
  });
  assert.deepStrictEqual(tabs.updated, [], "the page is already there — nothing to navigate");
  assert.equal(tabs.listenerCount(), 0);
  assert.deepStrictEqual(clock.pendingDelays(), [], "a navigation that never waits needs no timer");
});

test("navigate_toTheAddressTheTabAlreadyShowsWhileItIsLoading_shouldWaitLikeAnyOtherNavigation", async () => {
  // GIVEN the same address, but the tab is still loading that very page:
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ url: AGENT_URL, status: "loading" })],
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: { agentTabId: 500 } });

  // WHEN the bridge navigates to that page,
  await sendNavigate(socket, 2, { url: AGENT_URL });

  // THEN nothing is answered yet — `complete: true` would be a lie while the tab
  // is loading — and the call waits like any other, with the 8 s timer armed.
  assert.equal(responsesById(socket).has(2), false);
  assert.deepStrictEqual(tabs.updated, [{ tabId: 500, url: AGENT_URL }]);
  assert.deepStrictEqual(clock.pendingDelays(), [NAVIGATE_TIMEOUT_MS]);

  // WHEN the load finishes,
  tabs.emitUpdated(500, { status: "complete" }, {
    id: 500,
    windowId: 1,
    url: AGENT_URL,
    title: "Example Domain",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN the answer is the loaded page, with all seven fields, and the settle left
  // no timer behind.
  assert.deepStrictEqual(responsesById(socket).get(2).result, {
    tabId: 500,
    windowId: 1,
    url: AGENT_URL,
    title: "Example Domain",
    complete: true,
    settled: false,
    waitedMs: 0,
  });
  assert.equal(tabs.listenerCount(), 0);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("navigate_whenTheTabNeverCompletes_shouldAnswerAfterEightSecondsWithCompleteFalse", async () => {
  // GIVEN a navigation whose page never reports `complete`:
  const { socket, browser, clock } = await connectedBackground();
  await sendNavigate(socket, 2, { url: "https://slow.example/" });
  assert.deepStrictEqual(clock.pendingDelays(), [NAVIGATE_TIMEOUT_MS]);

  // WHEN the eight seconds pass,
  assert.equal(clock.runNext(), NAVIGATE_TIMEOUT_MS);
  await settleAsyncWork();

  // THEN the call still answers — with all seven fields, taken from what the
  // navigation knew without reading the tab again:
  assert.deepStrictEqual(responsesById(socket).get(2).result, {
    tabId: CREATED_TAB_ID,
    windowId: 1,
    url: "https://slow.example/",
    title: "",
    complete: false,
    settled: false,
    waitedMs: 0,
  });
  assert.equal(browser.tabs.listenerCount(), 0, "the timer path must remove the listener too");
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("navigate_withTwoOverlappingRequests_shouldAnswerTheFirstWithCompleteFalseAndLeaveOneListener", async () => {
  // GIVEN a navigation waiting for its page:
  const tabs = createTabsStub({ tabs: [createAgentTabFixture()] });
  const { socket, browser, clock } = await connectedBackground({ tabs, settings: { agentTabId: 500 } });
  await sendNavigate(socket, 2, { url: "https://first.example/" });
  assert.equal(tabs.listenerCount(), 1);

  // WHEN a second navigate arrives while the first one still waits,
  await sendNavigate(socket, 3, { url: "https://second.example/" });

  // THEN the first answers `complete: false` with *its own* URL. Reading the tab
  // again would hand it the second page and report it as its own result. No settle
  // follows either: a page that never loaded is not watched.
  assert.deepStrictEqual(responsesById(socket).get(2).result, {
    tabId: 500,
    windowId: 1,
    url: "https://first.example/",
    title: "",
    complete: false,
    settled: false,
    waitedMs: 0,
  });

  // ... the second keeps waiting, and exactly one listener is left — a removed
  // listener that was never removed shows up right here.
  assert.equal(responsesById(socket).has(3), false);
  assert.equal(tabs.listenerCount(), 1);

  // WHEN the second page finishes,
  browser.tabs.emitUpdated(500, { status: "complete" }, {
    id: 500,
    windowId: 1,
    url: "https://second.example/",
    title: "Second",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN the second answers with its own page and no listener is left behind.
  assert.deepStrictEqual(responsesById(socket).get(3).result, {
    tabId: 500,
    windowId: 1,
    url: "https://second.example/",
    title: "Second",
    complete: true,
    settled: false,
    waitedMs: 0,
  });
  assert.equal(tabs.listenerCount(), 0);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("navigate_inTwoDifferentTabs_shouldBothAnswerAndNeitherBeSuperseded", async () => {
  // GIVEN two agent tabs, both still loading their old page:
  const tabs = createTabsStub({ tabs: createTwoAgentTabs() });
  const started = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });
  const { socket, clock } = started;

  // WHEN a navigation is waiting in tab 501 and a second one arrives for tab 500,
  await sendNavigate(socket, 2, { url: "https://first.example/", tab: 501 });
  assert.equal(tabs.listenerCount(), 1);
  await sendNavigate(socket, 3, { url: "https://second.example/", tab: 500 });

  // THEN the first is left waiting with its own listener — a navigation in another
  // tab does not end it — and two time limits are armed:
  assert.equal(
    responsesById(socket).has(2),
    false,
    "a navigation in another tab must not answer the first one",
  );
  assert.equal(tabs.listenerCount(), 2);
  assert.deepStrictEqual(clock.pendingDelays(), [NAVIGATE_TIMEOUT_MS, NAVIGATE_TIMEOUT_MS]);

  // WHEN both pages report themselves as loaded,
  tabs.emitUpdated(501, { status: "complete" }, {
    id: 501,
    windowId: 1,
    url: "https://first.example/",
    title: "Erste",
    status: "complete",
  });
  tabs.emitUpdated(500, { status: "complete" }, {
    id: 500,
    windowId: 1,
    url: "https://second.example/",
    title: "Zweite",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN both answer `complete: true` with their own page and their own tab id, and
  // neither is a `superseded` (or `complete: false`) answer:
  const first = responsesById(socket).get(2);
  const second = responsesById(socket).get(3);
  assert.deepStrictEqual(first.result, {
    tabId: 501,
    windowId: 1,
    url: "https://first.example/",
    title: "Erste",
    complete: true,
    settled: false,
    waitedMs: 0,
  });
  assert.deepStrictEqual(second.result, {
    tabId: 500,
    windowId: 1,
    url: "https://second.example/",
    title: "Zweite",
    complete: true,
    settled: false,
    waitedMs: 0,
  });
  assert.equal("error" in first, false);
  assert.equal("error" in second, false);
  assert.equal(tabs.listenerCount(), 0, "no listener may survive its navigation");
  assert.deepStrictEqual(clock.pendingDelays(), []);

  // ... and the slot map ends empty.
  assert.deepStrictEqual(slotMapKeys(started), [[]]);
});

test("navigate_withTwoRequestsInTheSameTick_shouldCreateExactlyOneTab", async () => {
  // GIVEN a connected extension that has never navigated — its `agentTabId` is
  // empty, so both calls below would see no tab at all:
  const { socket, browser, clock } = await connectedBackground();

  // WHEN two requests arrive in the same tick, before the first one could store
  // its tab id,
  socket.receive({ type: "request", id: 2, method: "navigate", params: { url: "https://first.example/" } });
  socket.receive({ type: "request", id: 3, method: "navigate", params: { url: "https://second.example/" } });
  await settleAsyncWork();

  // THEN exactly one tab is created and the second call navigates that one: a
  // second `create` would leave an orphan tab in the operator's tab bar.
  assert.deepStrictEqual(browser.tabs.created, [
    { url: "https://first.example/", active: false, windowId: 1 },
  ]);
  assert.deepStrictEqual(browser.tabs.updated, [
    { tabId: CREATED_TAB_ID, url: "https://second.example/" },
  ]);

  // ... the first call answered `complete: false` with its own URL,
  assert.deepStrictEqual(responsesById(socket).get(2).result, {
    tabId: CREATED_TAB_ID,
    windowId: 1,
    url: "https://first.example/",
    title: "",
    complete: false,
    settled: false,
    waitedMs: 0,
  });

  // ... and exactly one wait is left for the shared tab.
  assert.equal(browser.tabs.listenerCount(), 1);

  // WHEN that tab reports its page as loaded,
  browser.tabs.emitUpdated(CREATED_TAB_ID, { status: "complete" }, {
    id: CREATED_TAB_ID,
    windowId: 1,
    url: "https://second.example/",
    title: "Second",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN the second call answers with that page, and no listener is left behind.
  assert.deepStrictEqual(responsesById(socket).get(3).result, {
    tabId: CREATED_TAB_ID,
    windowId: 1,
    url: "https://second.example/",
    title: "Second",
    complete: true,
    settled: false,
    waitedMs: 0,
  });
  assert.equal(browser.tabs.listenerCount(), 0);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("navigate_withAnInvalidUrlWhileAnotherIsRunning_shouldNotEndTheRunningOne", async () => {
  // GIVEN a navigation waiting for its page:
  const { socket, browser, clock } = await connectedBackground();
  await sendNavigate(socket, 2, { url: "https://allowed.example/" });

  // WHEN a refused request arrives — the URL check happens before the overlap is
  // resolved, because a refused call may not kill an allowed one,
  await sendNavigate(socket, 3, { url: "file:///etc/passwd" });
  assert.equal(responsesById(socket).get(3).error.code, "invalid_url");

  // THEN the first navigation is still waiting,
  assert.equal(responsesById(socket).has(2), false);
  assert.equal(browser.tabs.listenerCount(), 1);

  // ... and it still answers its own page.
  browser.tabs.emitUpdated(CREATED_TAB_ID, { status: "complete" }, {
    id: CREATED_TAB_ID,
    windowId: 1,
    url: "https://allowed.example/",
    title: "Erlaubt",
    status: "complete",
  });
  await settleAsyncWork();
  assert.equal(responsesById(socket).get(2).result.complete, true);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("navigate_shouldSettleOnlyAfterComplete", async () => {
  // GIVEN a stored agent tab that is still loading, and a page whose settle snippet
  // runs for real on the page's own clock — quiet one window after the wait starts:
  const page = { ...DEFAULT_READ_PAGE };
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture()],
    pageAgent: { frames: [{ href: page.url, page }] },
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge navigates while the page has not reported itself yet,
  await sendNavigate(socket, 2, { url: AGENT_URL });

  // THEN nothing was injected: the quiet is measured *after* the load, so a page that
  // is still loading has nothing to say about it —
  assert.deepStrictEqual(tabs.scriptCalls, []);
  assert.equal(responsesById(socket).has(2), false);
  assert.deepStrictEqual(clock.pendingDelays(), [NAVIGATE_TIMEOUT_MS]);

  // WHEN the page reports that it finished loading,
  tabs.emitUpdated(500, { status: "complete" }, {
    id: 500,
    windowId: 1,
    url: AGENT_URL,
    title: "Example Domain",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN exactly one injection ran after that event, and it was the settle op: the load
  // event is what the wait hangs off, not the request.
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(tabs.channel.ops(), ["settle"]);

  // ... and the answer carries what the wait saw — one quiet window without a single
  // mutation — with the two new fields behind `complete`:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(answer.result, {
    tabId: 500,
    windowId: 1,
    url: AGENT_URL,
    title: "Example Domain",
    complete: true,
    settled: true,
    waitedMs: QUIET_WINDOW_MS,
  });
  assert.deepStrictEqual(Object.keys(answer.result), [
    "tabId",
    "windowId",
    "url",
    "title",
    "complete",
    "settled",
    "waitedMs",
  ]);
  assert.equal(tabs.listenerCount(), 0, "the answer must not leave a listener behind");
  assert.deepStrictEqual(clock.pendingDelays(), [], "the settle must leave no timer behind");
});

test("navigate_whenTheSettleWaitIsOvertaken_shouldAnswerCompleteTrueWithoutASettle", async () => {
  // GIVEN a navigation whose page has loaded, and a settle snippet that never answers —
  // the page is busy, or the snippet sits in a throttled timer:
  const page = { ...DEFAULT_READ_PAGE };
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture()],
    pageAgent: { frames: [{ href: page.url, page, silent: true }] },
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  await sendNavigate(socket, 2, { url: AGENT_URL });
  tabs.emitUpdated(500, { status: "complete" }, {
    id: 500,
    windowId: 1,
    url: AGENT_URL,
    title: "Example Domain",
    status: "complete",
  });
  await settleAsyncWork();
  assert.equal(tabs.scriptCalls.length, 1);
  // The settle wait's watchdog is what ends a silent frame — no fallback and no idle
  // guess in this path. The frame's *injection*, not the wait, owns the later deadline:
  // it is the collection's own budget, armed for a call nobody is waiting for any more.
  assert.deepStrictEqual(clock.pendingDelays(), [SETTLE_GUARD_MS, INJECTION_REPLY_TIMEOUT_MS]);

  // WHEN a navigation takes the slot over — the one kind that waits for nothing at
  // all, because the tab already shows the address it asks for:
  await sendNavigate(socket, 3, { url: AGENT_URL });

  // THEN the first answers at once, and `complete: true` is the truth: its page did
  // load. Only the quiet it never observed is reported as none at all — a
  // `complete: false` here would tell the caller its page never arrived, and it did.
  assert.equal(
    responsesById(socket).has(2),
    true,
    "the superseded call must answer without the clock",
  );
  assert.deepStrictEqual(responsesById(socket).get(2).result, {
    tabId: 500,
    windowId: 1,
    url: AGENT_URL,
    title: "Example Domain",
    complete: true,
    settled: false,
    waitedMs: 0,
  });

  // ... and the halted wait took its watchdog with it: all that is left is the abandoned
  // injection's own deadline, which clears itself one second later instead of firing into
  // the answered call.
  assert.equal(tabs.listenerCount(), 0);
  assert.deepStrictEqual(clock.pendingDelays(), [INJECTION_REPLY_TIMEOUT_MS]);
  clock.runByDelay(INJECTION_REPLY_TIMEOUT_MS);
  await settleAsyncWork();
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

/* ------------------------------------------------------------------- read */

/** The stored agent tab a read case starts from: in the default container, id 500. */
const STORED_TAB_SETTINGS = { agentTabId: 500 };

/** The two limits the wait is a contract about, quoted like every other pin. */
const QUIET_WINDOW_MS = 250;
const SETTLE_DEADLINE_MS = 3000;
/** The extension-side watchdog: the page deadline plus a buffer for throttled timers. */
const SETTLE_GUARD_MS = 4000;
/** The ceiling on the HEAD request that enriches a `not_readable` error. */
const HEAD_DEADLINE_MS = 1500;

/** What a wait that did not happen reports — `NO_SETTLE` of the extension. */
const NO_SETTLE_RESULT = { settled: false, waitedMs: 0 };

/**
 * The read path with a page agent that answers per case.
 *
 * A read asks its two ops in order — `settle`, then `read` — and both run in the page
 * realm of `page`. The settle answer is canned by default (`NO_SETTLE_RESULT`: what the
 * extension would report if it never waited), because most read cases are about the
 * *text* and a real wait would only add `waitedMs` to every pinned answer. A case that
 * *is* about the wait drops the `settle` override and lets the op run.
 *
 * The tab is `complete` by default, because a read case is about the *page* — the two
 * cases about a still-loading tab name that status themselves.
 */
function createReadTabs({
  page = DEFAULT_READ_PAGE,
  tabs = [createAgentTabFixture({ status: "complete" })],
  settle = NO_SETTLE_RESULT,
  answer,
  pageAgent,
} = {}) {
  return createTabsStub({
    tabs,
    pageAgent: pageAgent ?? {
      frames: [{ href: page.url, page }],
      answer: answer ?? settleCannedAnswer(settle),
    },
  });
}

/**
 * The canned page of the read, click and type fixtures: the settle op answers the pair
 * the case named, everything else answers `value`.
 *
 * The settle pair is canned by default because a real wait would add `waitedMs` to every
 * pinned answer; the cases that are *about* the wait drop this and let the op run.
 */
function cannedPageAnswer(value, settle = NO_SETTLE_RESULT) {
  return (message) => (message.op === "settle" ? { value: { ...settle } } : { value });
}

/** The same, with the settle op left to the page agent (and its virtual clock). */
function settleCannedAnswer(settle = NO_SETTLE_RESULT) {
  return (message) => (message.op === "settle" ? { value: { ...settle } } : undefined);
}

/** The read case whose settle op really runs, on the page realm's virtual clock. */
function createSettlingReadTabs(page) {
  return createReadTabs({ page, pageAgent: { frames: [{ href: page.url, page }] } });
}

/**
 * The `allFrames` injection: the snippet really runs in every invented frame.
 *
 * The stub refuses a request of the wrong shape, and that refusal is half the proof of
 * this increment: `allFrames: true`, no `frameId` and `matchAboutBlank: true` are one
 * contract. A stub that answered a `frameId: 0` call would hide a tool that lists only
 * the main frame, and without `matchAboutBlank` a real `about:blank` frame never even
 * receives the snippet.
 *
 * The answer is one entry per frame in the order given, which is exactly *not* a promise
 * of the real browser — a case that wants to prove selection by content passes the
 * frames in the other order.
 */
/** One invented frame (`{href, top}`) as the page realm its snippet runs in. */
/**
 * The tabs stub whose frames answer the inventory themselves.
 *
 * Every frame is a realm of its own and reports its address and `top` by itself — the
 * list is built from those self-reports, not from an array an injection handed back.
 * The tab is `complete`: a `frames` call takes an inventory and waits for nothing, so a
 * `loading` tab is a case of its own and names that status itself.
 */
function createFramesTabs(
  frames,
  { tabs = [createAgentTabFixture({ status: "complete" })], answer, refuseInjection } = {},
) {
  return createTabsStub({ tabs, pageAgent: { frames, answer, refuseInjection } });
}

/**
 * One invented frame as the page realm a *reading* snippet runs in.
 *
 * `url` is the frame's address, so the snippet's own `location.href` decides whether it
 * is the addressed frame: the filter of spec 24 is proven against the address the
 * extension compared, not against an echo of the request.
 */
function readPageOfFrame(frame) {
  return {
    url: frame.href,
    title: frame.title ?? "",
    innerText: frame.text ?? "",
    inFrame: frame.top !== true,
  };
}

/**
 * The same two realms through the *message* channel: every page is a frame of its own,
 * main frame first, and every op is answered by the page agent inside it.
 *
 * `main first` is the order the fixture lists, not the order the browser promises — a
 * case that wants to prove selection by content passes `pages` reversed.
 */
function createFramedPageAgentTabs(pages, { tabs = [createAgentTabFixture({ status: "complete" })] } = {}) {
  return createTabsStub({
    tabs,
    pageAgent: {
      frames: pages.map((page) => ({ href: page.url, page, top: page.inFrame !== true })),
    },
  });
}

/**
 * A read across several frames: the two-op path of `read` with a `frame`.
 *
 * Every frame is its own page realm, and each has its own virtual clock — the settle op
 * really runs in all of them, so the `settled`/`waitedMs` in the answer is the pair the
 * *addressed* frame produced. The frames are given in the order the case wants them to
 * answer, which is how selection by content is proven rather than asserted.
 */
function createFramedReadTabs(frames) {
  return createFramedPageAgentTabs(frames.map(readPageOfFrame));
}

/**
 * Two frames of one page: the main frame with its own text, and a widget iframe with
 * another — the shape every `read`-with-`frame` case below addresses.
 *
 * The texts are different on purpose: an answer that came from the wrong frame is then a
 * wrong string, not a coincidence.
 */
const FRAMED_READ_PAGES = [
  { href: "https://example.org/seite", title: "Hauptseite", text: "Text des Hauptrahmens", top: true },
  {
    href: "https://widget.example.net/kalender",
    title: "Kalender",
    text: "Text des Widget-Rahmens",
    top: false,
  },
];

/**
 * A `read` against a tab that refuses injection: started, sent, and **not yet**
 * answered.
 *
 * The whole started bundle comes back because two cases need something the answer
 * alone does not carry — `headFetch.calls` to count the requests, `clock` to let a
 * deadline expire before the answer exists.
 *
 * `kindFromUrl` is a pure function and `contentTypeOf` makes a request, but the
 * background page publishes neither: the wire is the only way in, and the `read`
 * error frame is the one place both show.
 *
 * `beforeRead` runs between the start and the call, because the switches of the
 * harness that are static (`FakeAbortController.abortThrows`) are reset when the
 * background page starts.
 */
async function unreadableAddressRead(address, { headFetch, beforeRead = () => {} } = {}) {
  const tabs = createTabsStub({
    // `complete` because these cases are about what the *page* gives up, not about
    // a page that is still loading — the failure path reads the tab's state.
    tabs: [createAgentTabFixture({ url: address, status: "complete" })],
    pageAgent: { frames: [{ href: address, page: DEFAULT_READ_PAGE }], refuseInjection: true },
  });
  const started = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS, headFetch });
  beforeRead();
  await sendRead(started.socket, 2);
  return started;
}

/** The error frame of that read, for the cases whose answer arrives on its own. */
async function answerForUnreadableAddress(address, options = {}) {
  const started = await unreadableAddressRead(address, options);
  return responsesById(started.socket).get(2).error;
}

test("read_withoutAStoredAgentTab_shouldAnswerNoAgentTabAndInjectNothing", async () => {
  // GIVEN a connected extension that has never navigated — no agent tab, although
  // the operator's window has one:
  const tabs = createTabsStub({ tabs: [createAgentTabFixture()] });
  const { socket } = await connectedBackground({ tabs });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the answer is the documented code,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "no_agent_tab");

  // ... and nothing was injected: falling back to any tab would read a page the
  // agent never opened.
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("read_withAStoredTabThatIsGone_shouldAnswerNoAgentTabAndInjectNothing", async () => {
  // GIVEN a stored id that points nowhere — the normal case after a restart:
  const tabs = createTabsStub();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN it is the same answer as "never navigated", and no injection is tried
  // against a tab id that does not exist:
  assert.equal(responsesById(socket).get(2).error.code, "no_agent_tab");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("read_withAStoredTabInAContainer_shouldAnswerNoAgentTabAndInjectNothing", async () => {
  // GIVEN a stored tab in a multi-account container — logged in nowhere:
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ cookieStoreId: "firefox-container-1" })],
  });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the container is refused rather than read from a different cookie jar:
  assert.equal(responsesById(socket).get(2).error.code, "no_agent_tab");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("read_withTab_shouldReadThatTab", async () => {
  // GIVEN two agent tabs, 500 the last used one and 501 the one a request can name,
  const tabs = createReadTabs({ tabs: createTwoAgentTabs({ status: "complete" }) });
  const { socket, browser } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge reads tab 501 by name,
  await sendRead(socket, 2, { tab: 501 });

  // THEN every injection of the read went into *that* tab — the settle snippet and
  // the page snippet alike, which is why the first call is the one quoted:
  assert.equal(tabs.scriptCalls[0].tabId, 501);
  assert.equal(tabs.scriptCalls.every((call) => call.tabId === 501), true);
  assert.equal(responsesById(socket).get(2).result.tabId, 501);

  // ... and addressing it made it the last used one: the list ends with it, which is
  // what the next call without a `tab` reads.
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [500, 501],
  });
});

test("read_withoutTab_shouldReadTheLastUsedTab", async () => {
  // GIVEN the same two tabs, where 500 is the last used one,
  const tabs = createReadTabs({ tabs: createTwoAgentTabs({ status: "complete" }) });
  const { socket } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge reads without a `tab`,
  await sendRead(socket, 2);

  // THEN it gets the last used tab — the whole reason a call without `tab` stays as
  // convenient as it was with a single agent tab:
  assert.equal(tabs.scriptCalls[0].tabId, 500);
  assert.equal(responsesById(socket).get(2).result.tabId, 500);
});

test("read_whenTheLastUsedTabIsGone_shouldPruneItAndReadTheNextLiveOne", async () => {
  // GIVEN two agent tabs, 500 the last used one — and closed by the operator in the
  // meantime, which leaves 501 alive but *before* it in the list:
  const tabs = createReadTabs({ tabs: createTwoAgentTabs({ status: "complete" }) });
  const { socket, browser } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });
  tabs.remove(500);

  // WHEN the bridge reads without a `tab`,
  await sendRead(socket, 2);

  // THEN the dead id falls out and the next live one is read. Answering `no_agent_tab`
  // while another listed agent tab is alive is exactly what the spec's "stale ids fall
  // out when reading" rules out — and it is what the one-copy resolution did before:
  assert.equal(tabs.scriptCalls[0].tabId, 501);
  assert.equal(responsesById(socket).get(2).result.tabId, 501);

  // ... the list is left pruned, so the next call does not have to prune again,
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [501],
  });
});

test("read_withATabThatIsNotInTheList_shouldAnswerNoAgentTab", async () => {
  // GIVEN two agent tabs, plus the operator's own tab 101 in the default container,
  // and two ids that are not in the list: one that exists (101) and one that does
  // not (999):
  for (const tab of [101, 999]) {
    const tabs = createReadTabs({
      tabs: [
        createAgentTabFixture({ id: 101, url: "https://example.org/", title: "Beispiel", status: "complete" }),
        ...createTwoAgentTabs({ status: "complete" }),
      ],
    });
    const { socket, browser } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

    // WHEN the bridge names that tab,
    await sendRead(socket, 2, { tab });

    // THEN the answer is the documented code and nothing was injected: an existing
    // tab of the operator's is *not* an agent tab, and only ids in the list are
    // addressable — falling back to any reachable tab would read a page nobody
    // opened for the agent.
    assert.equal(responsesById(socket).get(2).error.code, "no_agent_tab", `tab: ${tab}`);
    assert.deepStrictEqual(tabs.scriptCalls, []);

    // ... and the caller's id does not become state: a tab that could not be
    // addressed must not turn up in the list, as the next `status` would mark it.
    assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
      agentTabIds: [501, 500],
    });
  }
});

test("read_withTabAsAString_shouldAnswerInvalidParams", async () => {
  // GIVEN two agent tabs and three ways to write a tab id that is none:
  for (const tab of ["31", 0, -1]) {
    const tabs = createReadTabs({ tabs: createTwoAgentTabs({ status: "complete" }) });
    const { socket } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

    // WHEN the request carries the value,
    await sendRead(socket, 2, { tab });

    // THEN it is refused as a parameter mistake — not as a missing tab, and before
    // anything is injected:
    const answer = responsesById(socket).get(2);
    assert.equal(answer.ok, false, `tab: ${JSON.stringify(tab)} must be refused`);
    assert.equal(answer.error.code, "invalid_params", `tab: ${JSON.stringify(tab)}`);
    assert.deepStrictEqual(tabs.scriptCalls, []);
  }
});

test("read_whenTheTabIsCompleteAndTheInjectionIsRefused_shouldAnswerNotReadable", async () => {
  // GIVEN a page Firefox will not inject into — `about:`, a PDF viewer, AMO:
  const tabs = createReadTabs({
    tabs: [createAgentTabFixture({ status: "complete" })],
    pageAgent: { frames: [{ href: AGENT_URL, page: DEFAULT_READ_PAGE }], refuseInjection: true },
  });
  const { socket, consoleLines } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the page is reported as unreadable and *not* as our bug — the rejection
  // text is no contract and is not parsed:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "not_readable");
  assert.ok(
    !consoleLines.some((line) => line.includes("read result without usable text")),
    "a refusal of the page is not a warning of ours",
  );
});

test("read_whenTheTabIsStillLoading_shouldAnswerPageBusy", async () => {
  // GIVEN a tab that is still loading and an injection Firefox refuses in that
  // moment — the status has to be named now that the read fixture is `complete` by
  // default:
  const tabs = createReadTabs({
    tabs: [createAgentTabFixture({ status: "loading" })],
    pageAgent: { frames: [{ href: AGENT_URL, page: DEFAULT_READ_PAGE }], refuseInjection: true },
  });
  const { socket, consoleLines } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page too early,
  await sendRead(socket, 2);

  // THEN the answer names the moment instead of the page — nothing is wrong with a
  // document that is not there yet, and a second call will get it:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "page_busy");

  // ... and the frame stays the two-field one: there is no address to name yet, and
  // `not_readable`'s fields belong to `not_readable` alone.
  assert.equal("url" in answer.error, false);
  assert.equal("kind" in answer.error, false);
  assert.equal("contentType" in answer.error, false);
  assert.ok(
    !consoleLines.some((line) => line.includes("read result without usable text")),
    "a page that is still loading is not a warning of ours",
  );
});

test("read_onAPageWithAnInternalAddress_shouldReportKindInternalAndTheAddress", async () => {
  // GIVEN the addresses of pages the browser keeps to itself — one per scheme the
  // derivation knows about:
  const addresses = [
    "about:blank",
    "about:config",
    "moz-extension://erfundene-kennung/seite.html",
    "chrome://erfundene-seite",
    "view-source:https://example.org/seite",
  ];

  for (const address of addresses) {
    // WHEN a read is refused for a tab standing on that address,
    const error = await answerForUnreadableAddress(address);

    // THEN the kind names an internal page, and the address travels along so the
    // caller can hand it to the operator instead of standing in a dead end:
    assert.equal(error.code, "not_readable", `${address} must be not_readable`);
    assert.equal(error.kind, "internal", `${address} must be internal`);
    assert.equal(error.url, address);
  }
});

test("read_onAnAddressWhosePathEndsInPdf_shouldReportKindPdfAndTheAddress", async () => {
  // GIVEN the four shapes a PDF address comes in: plain, upper case, with a query and
  // with a fragment:
  const addresses = [
    "https://example.org/preisliste.pdf",
    "https://example.org/AGB.PDF",
    "https://example.org/x.pdf?token=1",
    "https://example.org/x.pdf#page=2",
  ];

  for (const address of addresses) {
    // WHEN a read is refused for it,
    const error = await answerForUnreadableAddress(address);

    // THEN the suffix decides, whatever the case and whatever follows the path:
    assert.equal(error.kind, "pdf", `${address} must be pdf`);
    assert.equal(error.url, address);
  }
});

test("read_onAFileAddressEndingInPdf_shouldReportKindFileBecauseTheSchemeWins", async () => {
  // GIVEN a local file that happens to be a PDF — the case where two rules disagree:
  const address = "file:///tmp/a.pdf";

  // WHEN a read is refused for it,
  const error = await answerForUnreadableAddress(address);

  // THEN the scheme is decided before the suffix: it is a file, and calling it a PDF
  // would claim more than the address says:
  assert.equal(error.kind, "file");
  assert.equal(error.url, address);
});

test("read_onAnAddressWithoutAKnownSuffix_shouldReportKindUnknown", async () => {
  // GIVEN a page without a telling suffix and a JPEG — an image suffix is not a
  // promise about the content either:
  const addresses = ["https://example.org/seite", "https://example.org/bild.jpg"];

  for (const address of addresses) {
    // WHEN a read is refused for it,
    const error = await answerForUnreadableAddress(address);

    // THEN the kind says nothing is known, while the address still travels:
    assert.equal(error.kind, "unknown", `${address} must be unknown`);
    assert.equal(error.url, address);
  }
});

test("read_whenTheTabCarriesNoAddress_shouldReportNullUrlAndKindUnknown", async () => {
  // GIVEN a tab that answers with no address at all — absent, `null` and empty are the
  // three ways a browser has of saying the same thing:
  const addresses = [undefined, null, ""];

  for (const address of addresses) {
    // WHEN a read is refused for it,
    const error = await answerForUnreadableAddress(address);

    // THEN both fields say "nothing known" instead of guessing:
    assert.equal(error.kind, "unknown", `${String(address)} must be unknown`);
    assert.equal(error.url, null, `${String(address)} must have no url`);
  }
});

test("read_whenTheTabIsGoneInTheFailurePath_shouldAnswerNoAgentTab", async () => {
  // GIVEN a tab that exists for the stored-id check and is gone by the time the
  // injection is refused. `createBrowserStub` hands the tab stub over by reference,
  // so the case can make the second call fail without a new switch in the harness:
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture()],
    executeScript: async () => {
      throw new Error("Missing host permission for the tab");
    },
  });
  const workingGet = tabs.get;
  let lookups = 0;
  tabs.get = async (tabId) => {
    lookups += 1;
    // The first lookup belongs to `findDefaultContainerTab`.
    if (lookups > 1) throw new Error("No tab with id: 500");
    return workingGet(tabId);
  };
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the answer says there is no tab — the same code as "never navigated",
  // because for the caller it is the same situation: nothing to read, no address to
  // name. A silent `url: null`/`kind: "unknown"` would claim the page was seen:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "no_agent_tab");
  assert.equal("url" in answer.error, false);
  assert.equal("kind" in answer.error, false);
});

test("read_whenTheAddressIsLongerThanTheDetailLimit_shouldClassifyTheFullAddressAndCutTheUrl", async () => {
  // GIVEN an address well over the cap that still ends in `.pdf` — the cut would land
  // in the middle of the path:
  const address = `https://example.org/${"a".repeat(URL_DETAIL_LIMIT + 100)}.pdf`;
  assert.ok(address.length > URL_DETAIL_LIMIT);

  // WHEN a read is refused for it,
  const error = await answerForUnreadableAddress(address);

  // THEN the kind comes from the *full* address and is still `pdf`, while the url is
  // cut for the frame — the same cap the read answer uses, for the same frame limit:
  assert.equal(error.kind, "pdf", "the kind is derived before the cut");
  assert.equal(error.url.length, URL_DETAIL_LIMIT);
  assert.equal(error.url, address.slice(0, URL_DETAIL_LIMIT));
});

test("read_whenTheHeadAnswers200WithAType_shouldCarryTheContentType", async () => {
  // GIVEN a server that knows what it serves — the case the whole field exists for:
  // an address without a telling suffix, and a PDF behind it:
  const address = "https://example.org/download?id=7";
  const headFetch = createHeadFetchStub(() => headReply(true, "application/pdf"));

  // WHEN a read is refused for that tab — driven through the harness that hands back
  // the clock, because this case also owns the promise that no deadline is left over:
  const started = await unreadableAddressRead(address, { headFetch });

  // THEN the frame names the type the server reports, next to the address and the
  // `unknown` the address alone deserves:
  const error = responsesById(started.socket).get(2).error;
  assert.equal(error.code, "not_readable");
  assert.equal(error.kind, "unknown");
  assert.equal(error.url, address);
  assert.equal(error.contentType, "application/pdf");

  // ... and the request was the one the spec asks for: a HEAD without the operator's
  // cookies, following redirects, with a signal it can be released by:
  const [firstCall] = headFetch.calls;
  assert.equal(firstCall.url, address);
  assert.equal(firstCall.options.method, "HEAD");
  assert.equal(firstCall.options.credentials, "omit");
  assert.equal(firstCall.options.redirect, "follow");
  assert.notEqual(firstCall.options.signal, undefined, "the fetch must carry the signal");
  assert.equal(FakeAbortController.latest().aborted, true, "the socket must be released");

  // ... and the HEAD deadline is gone once the answer is out. `runByDelay` fires the
  // timer it proves, so the deadline case cannot tell a cancelled guard from an
  // expired one; only a HEAD that answered *before* its deadline can, as here.
  assert.deepStrictEqual(started.clock.pendingDelays(), [], "no deadline may outlive the answer");
});

test("read_whenTheHeadAnswers200WithoutAContentTypeHeader_shouldAnswerNull", async () => {
  // GIVEN a server that answers but says nothing about what it delivers,
  const headFetch = createHeadFetchStub(() => headReply(true));

  // WHEN a read is refused for that tab,
  const error = await answerForUnreadableAddress("https://example.org/download?id=7", { headFetch });

  // THEN the field is present and says nothing is known — a missing header is not a
  // missing field:
  assert.equal(error.code, "not_readable");
  assert.equal(error.contentType, null);
});

test("read_whenTheHeadAnswers403WithHtml_shouldAnswerNull", async () => {
  // GIVEN a protected resource that refuses the HEAD and serves its error page as
  // HTML — the type of the page, not of the document:
  const headFetch = createHeadFetchStub(() => headReply(false, "text/html"));

  // WHEN a read is refused for that tab,
  const error = await answerForUnreadableAddress("https://example.org/download?id=7", { headFetch });

  // THEN the status decides before the header is read:
  assert.equal(error.code, "not_readable");
  assert.equal(error.contentType, null);
});

test("read_whenTheHeadFailsWithANetworkError_shouldAnswerNullWithoutThrowing", async () => {
  // GIVEN a server that cannot be reached at all,
  const headFetch = createHeadFetchStub(() => {
    throw new Error("network down");
  });

  // WHEN a read is refused for that tab,
  const error = await answerForUnreadableAddress("https://example.org/download?id=7", { headFetch });

  // THEN the enrichment is best effort: still `not_readable` with `null`, never a
  // `read_failed` that would blame the extension for the network:
  assert.equal(error.code, "not_readable");
  assert.equal(error.contentType, null);
});

test("read_whenTheHeadMissesTheDeadline_shouldAnswerNullAfter1500ms", async () => {
  // GIVEN a server that never answers a HEAD at all,
  const headFetch = createHeadFetchStub(() => new Promise(() => {}));
  const started = await unreadableAddressRead("https://example.org/download?id=7", { headFetch });

  // THEN exactly one timer is armed: the settle guard is already cleared, because the
  // settle wait pays no HEAD — the read's HEAD deadline is the only thing pending,
  assert.deepStrictEqual(started.clock.pendingDelays(), [HEAD_DEADLINE_MS]);

  // WHEN the HEAD deadline expires,
  started.clock.runByDelay(HEAD_DEADLINE_MS);
  await settleAsyncWork();

  // THEN the frame answers with `null` instead of hanging on a request that never
  // comes back,
  const answer = responsesById(started.socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "not_readable");
  assert.equal(answer.error.contentType, null);

  // ... and no timer outlives the call: neither the settle guard nor the HEAD deadline
  // is left armed — both are cleared in a `finally`:
  assert.deepStrictEqual(started.clock.pendingDelays(), []);
});

test("read_onAnUnreadablePdfPage_shouldAskTheServerExactlyOnce", async () => {
  // GIVEN a page that refuses injection and a server that would answer for it — the
  // settle wait fails on the *same* page, and its rejection carries the same
  // enrichment as the read's:
  const headFetch = createHeadFetchStub(() => headReply(true, "application/pdf"));

  // WHEN a read is refused for it,
  const error = await answerForUnreadableAddress("https://example.org/preisliste.pdf", { headFetch });

  // THEN the frame names what the extension knew,
  assert.equal(error.code, "not_readable");
  assert.equal(error.kind, "pdf");
  assert.equal(error.contentType, "application/pdf");

  // ... and exactly one HEAD paid for it. The settle wait's error is thrown away, so
  // its HEAD would be a request for the bin — and it would cost up to 1,5 s *before*
  // the read it belongs to has even started:
  assert.equal(headFetch.calls.length, 1);
});

test("read_whenTheHeadAnswersWithAResponseWithoutHeaders_shouldAnswerNull", async () => {
  // GIVEN an answer that is not shaped like a response at all — no `headers` to read:
  const headFetch = createHeadFetchStub(() => ({ ok: true }));

  // WHEN a read is refused for that tab,
  const error = await answerForUnreadableAddress("https://example.org/download?id=7", { headFetch });

  // THEN reading the header fails into `null` instead of into a rejection — the same
  // `read_failed` the missing network would otherwise produce:
  assert.equal(error.code, "not_readable");
  assert.equal(error.contentType, null);
});

test("read_whenTheHeadAbortThrows_shouldAnswerNull", async () => {
  // GIVEN a page that refuses injection and a controller whose `abort()` throws — the
  // teardown accident, not a network one,
  const error = await answerForUnreadableAddress("https://example.org/download?id=7", {
    beforeRead: () => {
      FakeAbortController.abortThrows = true;
    },
  });

  // WHEN a read is refused for that tab,
  // THEN the teardown stays silent and the frame keeps its `null`:
  assert.equal(error.code, "not_readable");
  assert.equal(error.contentType, null);
});

test("read_whenTheAddressIsInternalOrAFile_shouldSendNoHeadRequest", async () => {
  // GIVEN the two kinds no server can answer for — the browser's own page and a local
  // file that even ends in `.pdf`:
  const addresses = ["about:config", "file:///tmp/a.pdf"];

  for (const address of addresses) {
    // WHEN a read is refused for it,
    const started = await unreadableAddressRead(address);

    // THEN the frame still names address and kind, and not a single request was made:
    // an `about:` page has no origin to ask and a local file has no server.
    const error = responsesById(started.socket).get(2).error;
    assert.equal(error.code, "not_readable", `${address} must be not_readable`);
    assert.equal(error.contentType, null, `${address} must have no contentType`);
    assert.equal(started.headFetch.calls.length, 0, `${address} must not cost a HEAD`);
  }
});

test("read_whenTheFailureIsNoAgentTabOrReadFailed_shouldCarryNeitherUrlNorKind", async () => {
  // GIVEN a connected extension that never navigated — `no_agent_tab`:
  const withoutTab = await connectedBackground({
    tabs: createTabsStub({ tabs: [createAgentTabFixture()] }),
  });
  await sendRead(withoutTab.socket, 2);

  // ... and a stored tab whose injection hands back nothing usable — `read_failed`:
  const withoutResult = await connectedBackground({
    tabs: createReadTabs({ answer: cannedPageAnswer(undefined) }),
    settings: STORED_TAB_SETTINGS,
  });
  await sendRead(withoutResult.socket, 2);

  // THEN both frames are the old two-field ones: the extra fields belong to
  // `not_readable` alone, and a caller may rely on that shape:
  const cases = [
    { socket: withoutTab.socket, code: "no_agent_tab" },
    { socket: withoutResult.socket, code: "read_failed" },
  ];
  for (const { socket, code } of cases) {
    const error = responsesById(socket).get(2).error;
    assert.equal(error.code, code);
    assert.equal("url" in error, false, `${code} must not carry url`);
    assert.equal("kind" in error, false, `${code} must not carry kind`);
    assert.equal("contentType" in error, false, `${code} must not carry contentType`);
  }
});

test("read_whenTheInjectionReturnsNoEntry_shouldAnswerReadFailedWithAWarningButNoContent", async () => {
  // GIVEN an injection that resolves with an empty slot instead of an object:
  const tabs = createReadTabs({ answer: cannedPageAnswer(undefined) });
  const { socket, consoleLines } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN it is our own failure, not the page's — the caller sees a different code
  // for the two on purpose,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "read_failed");

  // ... the warning names the problem and never the page,
  assert.ok(
    consoleLines.includes("warn: bc: read result without usable text"),
    `the warning is missing:\n${consoleLines.join("\n")}`,
  );
  assert.ok(
    !consoleLines.join("\n").includes(DEFAULT_READ_PAGE.innerText),
    "the page content must never reach the console",
  );
});

test("read_whenTheInjectedResultCarriesNoText_shouldAnswerReadFailed", async () => {
  // GIVEN an object that is no page result — the shape changed and nobody noticed:
  const tabs = createReadTabs({ answer: cannedPageAnswer({ url: "https://example.org/" }) });
  const { socket, consoleLines } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the missing `text` is reported as ours, with the warning that makes it
  // findable:
  assert.equal(responsesById(socket).get(2).error.code, "read_failed");
  assert.ok(consoleLines.includes("warn: bc: read result without usable text"));
});

test("read_onANormalPage_shouldAnswerUrlTitleAndTheNormalisedTextFromTheDom", async () => {
  // GIVEN a stored agent tab whose tab object still carries the *old* url and
  // title, and a page that says otherwise:
  const tabs = createReadTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN url and title come from the document — after a script-driven redirect the
  // tab object is the less accurate source — and the text is normalised: interior
  // whitespace collapsed, blank lines merged, ends trimmed. The visible text wins,
  // so `via` names `innerText`, and the wait reports that it happened without a
  // mutation to wait for:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(answer.result, {
    tabId: 500,
    url: DEFAULT_READ_PAGE.url,
    title: DEFAULT_READ_PAGE.title,
    text: "Erste Zeile\n\nZweite Zeile",
    offset: 0,
    chars: 25,
    totalChars: 25,
    truncated: false,
    via: "innerText",
    mode: "text",
    // Written out instead of spreading `NO_SETTLE_RESULT`: a pin that follows the
    // constant would notice nothing at all.
    settled: false,
    waitedMs: 0,
  });

  // ... the wait came first and the read second, so the page was asked to settle
  // before it was asked for its text,
  assert.equal(tabs.scriptCalls.length, 2);
  assert.deepStrictEqual(tabs.channel.ops(), ["settle", "read"], "the read must settle first");

  // ... and the read injection really was the file, in the main frame, at the moment
  // the page is idle:
  assert.equal(tabs.scriptCalls[1].tabId, 500);
  assert.deepStrictEqual(tabs.scriptCalls[1].details.target, { tabId: 500, frameIds: [0] });
  assert.deepStrictEqual(tabs.scriptCalls[1].details.files, [PAGE_AGENT_FILE]);
});

test("read_whenTheVisibleTextAnswers_shouldNotCopyTheBodyForTheFallback", async () => {
  // GIVEN a normal page whose `innerText` carries text, and a body that records
  // every copy the snippet asks for:
  const bodyCopyCalls = [];
  const page = { ...DEFAULT_READ_PAGE, bodyCopyCalls };
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the visible text answered, and only the answer is asserted on the side —
  // the same text would come out of a body that was copied for nothing:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.via, "innerText");
  assert.equal(answer.result.text, "Erste Zeile\n\nZweite Zeile");

  // ... and the fallback never ran: the copy is a full DOM clone plus four
  // selectors on the tab's main thread, paid for a body nobody reads.
  assert.equal(
    bodyCopyCalls.length,
    0,
    "a page whose `innerText` answered must not have its body copied for the fallback",
  );
});

test("read_withAnOverlongTitleAndUrl_shouldCapThemAtTheirLimitsInsideThePage", async () => {
  // GIVEN a page that sets a 5 000-character title and a 3 000-character URL —
  // both legal, because the page decides what they say:
  const page = {
    url: `https://example.org/${"u".repeat(3000)}`,
    title: "T".repeat(5000),
    innerText: "Zeile",
  };
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN both are cut at the documented limits — a frame over the 5 MiB message limit
  // would be closed with 1009 and the call would look like "no extension":
  const answer = responsesById(socket).get(2);
  assert.equal(answer.result.title.length, TITLE_LIMIT);
  assert.equal(answer.result.url.length, URL_LIMIT);
  assert.equal(answer.result.title, page.title.slice(0, TITLE_LIMIT));
  assert.equal(answer.result.url, page.url.slice(0, URL_LIMIT));
});

test("read_withTextOneCharacterOverTheLimit_shouldCutItAndSetTruncated", async () => {
  // GIVEN a page whose text is one character longer than the limit:
  const tabs = createReadTabs({ page: { ...DEFAULT_READ_PAGE, innerText: "a".repeat(TEXT_LIMIT + 1) } });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the text stops at the limit and says so:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.result.text.length, TEXT_LIMIT);
  assert.equal(answer.result.truncated, true);
});

test("read_withTextOfExactlyTheLimit_shouldNotSetTruncated", async () => {
  // GIVEN a page whose text fits exactly:
  const tabs = createReadTabs({ page: { ...DEFAULT_READ_PAGE, innerText: "a".repeat(TEXT_LIMIT) } });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN nothing was cut — the limit is "more than", not "at least":
  const answer = responsesById(socket).get(2);
  assert.equal(answer.result.text.length, TEXT_LIMIT);
  assert.equal(answer.result.truncated, false);
});

test("read_whenTheVisibleTextIsEmptyButTheContentIsNot_shouldFallBackToTextContent", async () => {
  // GIVEN a page that reveals its body only while it boots — the shape that gave
  // 0 characters on a full page in a real run: `innerText` respects the rendering,
  // `textContent` does not.
  const page = {
    ...DEFAULT_READ_PAGE,
    innerText: "",
    textContent: "  App-Inhalt  \n\n\nZweite Zeile  ",
  };
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the content is normalised by the same rules and `via` says where it came
  // from — a bare `text` would look like "the page is empty":
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(answer.result, {
    tabId: 500,
    url: DEFAULT_READ_PAGE.url,
    title: DEFAULT_READ_PAGE.title,
    text: "App-Inhalt\n\nZweite Zeile",
    offset: 0,
    chars: 24,
    totalChars: 24,
    truncated: false,
    via: "textContent",
    mode: "text",
    settled: false,
    waitedMs: 0,
  });
});

test("read_whenTheContentIsNothingButWhitespace_shouldStayWithTheVisibleText", async () => {
  // GIVEN a page whose visible text is empty and whose content holds nothing but
  // the whitespace between element and script remnants:
  const page = { ...DEFAULT_READ_PAGE, innerText: "", textContent: "\n\n   \t\n   \n" };
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the fallback does not fire: both sources normalise to nothing, so `via`
  // must not name a source that delivered no text.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.text, "");
  assert.equal(answer.result.via, "innerText");
});

test("read_whenTheBodyHoldsOnlyInlineScripts_shouldAnswerEmptyTextAndNameTheVisibleSource", async () => {
  // GIVEN a page that boots through inline JavaScript and shows nothing while it
  // does — the shape that answered 20 000 characters of `ytcsi.tick` calls in a
  // real run:
  const page = {
    ...DEFAULT_READ_PAGE,
    innerText: "",
    parts: [{ script: "if (window.ytcsi) {window.ytcsi.tick('bs', null, +new Date);}" }],
  };
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the script is not text: the answer is empty, and `via` does not name the
  // fallback that delivered nothing.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(answer.result, {
    tabId: 500,
    url: DEFAULT_READ_PAGE.url,
    title: DEFAULT_READ_PAGE.title,
    text: "",
    offset: 0,
    chars: 0,
    totalChars: 0,
    truncated: false,
    via: "innerText",
    mode: "text",
    settled: false,
    waitedMs: 0,
  });
});

test("read_withAScriptNextToRealText_shouldAnswerTheTextWithoutTheScript", async () => {
  // GIVEN a booting page whose body holds an inline script *and* real text — the
  // realistic YouTube shape: visible nothing, `textContent` with both:
  const page = {
    ...DEFAULT_READ_PAGE,
    innerText: "",
    parts: [
      { script: "//# sourceURL=yt-desktop-body-width.js" },
      { text: "  App-Inhalt  \n\n\nZweite Zeile  " },
    ],
  };
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the fallback still answers with the normalised text and names itself —
  // but the script is gone, not left in there as 20 000 characters of JavaScript.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(answer.result, {
    tabId: 500,
    url: DEFAULT_READ_PAGE.url,
    title: DEFAULT_READ_PAGE.title,
    text: "App-Inhalt\n\nZweite Zeile",
    offset: 0,
    chars: 24,
    totalChars: 24,
    truncated: false,
    via: "textContent",
    mode: "text",
    settled: false,
    waitedMs: 0,
  });
});

test("read_withAStyleAndANoscriptNextToRealText_shouldAnswerTheTextWithoutThem", async () => {
  // GIVEN a booting page whose body holds a stylesheet, a noscript fallback and
  // real text — the kinds of content `innerText` hides and `textContent` keeps:
  const page = {
    ...DEFAULT_READ_PAGE,
    innerText: "",
    parts: [
      { style: ".yt-desktop-body-width { width: 100%; }" },
      { noscript: "Bitte JavaScript aktivieren." },
      { text: "  App-Inhalt  \n\n\nZweite Zeile  " },
    ],
  };
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the fallback delivered the text and names itself, while neither the CSS
  // nor the noscript content is left in the answer:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(answer.result, {
    tabId: 500,
    url: DEFAULT_READ_PAGE.url,
    title: DEFAULT_READ_PAGE.title,
    text: "App-Inhalt\n\nZweite Zeile",
    offset: 0,
    chars: 24,
    totalChars: 24,
    truncated: false,
    via: "textContent",
    mode: "text",
    settled: false,
    waitedMs: 0,
  });
});

test("read_whenTheInjectedResultHasNoTextSource_shouldAnswerReadFailed", async () => {
  // GIVEN a result with a text but without `via` — our own bug, not a page that
  // refuses. The three window fields are there, so `via` is the *only* thing missing:
  const tabs = createReadTabs({
    answer: cannedPageAnswer({
      url: "https://example.org/",
      title: "Seite",
      text: "Zeile",
      offset: 0,
      chars: 5,
      totalChars: 5,
      truncated: false,
    }),
  });
  const { socket, consoleLines } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the answer is `read_failed` with the warning, because a text without a
  // named source cannot be read correctly by the caller:
  assert.equal(responsesById(socket).get(2).error.code, "read_failed");
  assert.ok(consoleLines.includes("warn: bc: read result without usable text"));
});

test("read_whenTheInjectedResultCarriesNoWindowNumbers_shouldAnswerReadFailed", async () => {
  // GIVEN a result with the four shape fields and both halves of the answer, but without
  // the three window numbers — a snippet from before spec 22, or one that was edited
  // into silence. `text`, `url` and `via` alone must no longer pass:
  const tabs = createReadTabs({
    answer: cannedPageAnswer({
      url: "https://example.org/",
      title: "Seite",
      text: "Zeile",
      truncated: false,
      via: "innerText",
    }),
  });
  const { socket, consoleLines } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN it is our own failure and not a silent answer with `offset: undefined`: the
  // caller pages with these numbers, and an absent one is not a window starting at 0.
  // The warning is the same one every unusable page result gets:
  assert.equal(responsesById(socket).get(2).error.code, "read_failed");
  assert.ok(
    consoleLines.includes("warn: bc: read result without usable text"),
    `the warning is missing:\n${consoleLines.join("\n")}`,
  );
});

test("read_whenTheOffsetOutOfRangeOutcomeCarriesNoNumbers_shouldAnswerReadFailed", async () => {
  // GIVEN a page that reports the refusal but keeps the two numbers to itself — the
  // `outcome` alone is no answer, because the sentence has nothing to put in it:
  const tabs = createReadTabs({ answer: cannedPageAnswer({ outcome: "offset_out_of_range" }) });
  const { socket, consoleLines } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for a window,
  await sendRead(socket, 2);

  // THEN it does not become `offset_out_of_range` with invented numbers: the honest
  // answer is our own `read_failed`, with the warning that makes it findable — the
  // length only ever existed in the page, and guessing it would be a second truth:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "read_failed");
  assert.ok(
    consoleLines.includes("warn: bc: read result without usable text"),
    `the warning is missing:\n${consoleLines.join("\n")}`,
  );
});

test("read_onAPageWithoutABody_shouldAnswerWithEmptyTextAndNoError", async () => {
  // GIVEN a document without a body — `about:blank` and error pages look like
  // this:
  const tabs = createReadTabs({ page: { ...DEFAULT_READ_PAGE, innerText: null } });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN an empty text is a valid answer and must not slide into `not_readable` —
  // and without a body there is nothing to fall back to either:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.text, "");
  assert.equal(answer.result.truncated, false);
  assert.equal(answer.result.via, "innerText");
});

/* -------------------------------------------------- read: window (spec 22) */

test("read_withAnInvalidWindowParameter_shouldAnswerInvalidParamsAndInjectNothing", async () => {
  // GIVEN the callers whose window cannot be honoured — a zero or too wide `maxChars`,
  // a negative or fractional `offset`, and a number that arrived as a string:
  const refused = [
    { maxChars: 0 },
    { maxChars: READ_MAX_CHARS_LIMIT + 1 },
    { maxChars: "10000" },
    { offset: -1 },
    { offset: 1.5 },
  ];

  for (const params of refused) {
    // WHEN the bridge asks for the page with that window,
    const tabs = createReadTabs();
    const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
    await sendRead(socket, 2, params);

    // THEN the caller hears about its own mistake before anything is injected: no
    // settle wait, no read — the answer cannot even depend on how the page looks.
    const answer = responsesById(socket).get(2);
    assert.equal(answer.ok, false, `${JSON.stringify(params)} must be refused`);
    assert.equal(
      answer.error.code,
      "invalid_params",
      `${JSON.stringify(params)} must answer invalid_params, got ${answer.error.code}`,
    );
    assert.deepStrictEqual(tabs.scriptCalls, [], `${JSON.stringify(params)} must inject nothing`);
  }
});

test("read_withOffsetAsAString_shouldAnswerInvalidParamsFromTheExtensionWithoutInjection", async () => {
  // GIVEN an `offset` that is a number only in spirit — the shape the bridge's own
  // type check is meant to catch, except this read went past it:
  const tabs = createReadTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2, { offset: "5" });

  // THEN the extension refuses it on its own: the type check exists on both sides, so a
  // caller that reached this one directly cannot page with a string either:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "invalid_params");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("read_withAnInvalidWindowParameterAndNoAgentTab_shouldAnswerInvalidParamsFirst", async () => {
  // GIVEN a connection that never stored an agent tab — a read would answer
  // `no_agent_tab` if it ever got that far:
  const tabs = createTabsStub({ tabs: [createAgentTabFixture()] });
  const { socket } = await connectedBackground({ tabs });

  // WHEN the bridge asks for a page with a window that cannot be honoured,
  await sendRead(socket, 2, { maxChars: 0 });

  // THEN the parameter check comes first: the caller is told what it got wrong, not
  // what the operator's tab list looks like — and nothing is injected either way:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "invalid_params");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("read_withoutAWindow_shouldAnswerTheDefaultWindowFromTheStart", async () => {
  // GIVEN the default page and a caller that asks for no window at all:
  const tabs = createReadTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the text is the whole page and the default window names itself: offset 0,
  // everything there is, nothing cut — exactly what this call answered before spec 22,
  // with three numbers a caller can page by:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.text, "Erste Zeile\n\nZweite Zeile");
  assert.equal(answer.result.offset, 0);
  assert.equal(answer.result.chars, answer.result.text.length);
  assert.equal(answer.result.totalChars, answer.result.text.length);
  assert.equal(answer.result.truncated, false);

  // ... and the field order is the wire contract: the three window fields sit between
  // `text` and `truncated`, and the settle pair stays behind `via` where spec 15 put it.
  // `mode` sits between `via` and the settle pair (spec 23) — and `root`/`fellBack` are
  // not here at all, because a text answer must not claim an article it never read.
  assert.deepStrictEqual(Object.keys(answer.result), [
    "tabId",
    "url",
    "title",
    "text",
    "offset",
    "chars",
    "totalChars",
    "truncated",
    "via",
    "mode",
    "settled",
    "waitedMs",
  ]);
});

test("read_withOffsetFiveAndMaxCharsTen_shouldAnswerExactlyThatWindow", async () => {
  // GIVEN the default page, whose normalised text is 25 characters long:
  const fullText = "Erste Zeile\n\nZweite Zeile";
  const tabs = createReadTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for ten characters, starting at the sixth,
  await sendRead(socket, 2, { offset: 5, maxChars: 10 });

  // THEN exactly that window comes back, counted in the page, and `truncated` says
  // there is more after it — so the caller knows to continue at `offset + chars`:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.text, fullText.slice(5, 15));
  assert.equal(answer.result.offset, 5);
  assert.equal(answer.result.chars, 10);
  assert.equal(answer.result.totalChars, fullText.length);
  assert.equal(answer.result.truncated, true);
});

test("read_pagedOverTwoCalls_shouldReassembleTheWholeTextWithoutAGap", async () => {
  // GIVEN a caller that asks for ten characters of a 25-character page:
  const fullText = "Erste Zeile\n\nZweite Zeile";
  const tabs = createReadTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  await sendRead(socket, 2, { offset: 0, maxChars: 10 });
  const first = responsesById(socket).get(2).result;

  // WHEN it continues at exactly the place the first answer named,
  await sendRead(socket, 3, { offset: first.offset + first.chars, maxChars: 20 });
  const second = responsesById(socket).get(3).result;

  // THEN the two windows fit together without a gap and without a repetition, and
  // their lengths add up to the `totalChars` both calls reported — the paging contract
  // of criterion 3, in full:
  assert.equal(first.chars, 10);
  assert.equal(first.text + second.text, fullText);
  assert.equal(first.chars + second.chars, first.totalChars);
  assert.equal(second.totalChars, first.totalChars);
  assert.equal(second.truncated, false);
});

test("read_withOffsetAtTheTotalLength_shouldAnswerAnEmptyWindowWithoutTruncation", async () => {
  // GIVEN a caller that has read to the end and now asks for the halt exactly there:
  const tabs = createReadTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  await sendRead(socket, 2);
  const totalChars = responsesById(socket).get(2).result.totalChars;

  // WHEN it asks again from that character on,
  await sendRead(socket, 3, { offset: totalChars });

  // THEN an empty window is a valid answer and not an error: the end of the text is
  // where a paging loop stops — the refusal starts one character later (spec 22, step 3):
  const answer = responsesById(socket).get(3);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.text, "");
  assert.equal(answer.result.chars, 0);
  assert.equal(answer.result.offset, totalChars);
  assert.equal(answer.result.totalChars, totalChars);
  assert.equal(answer.result.truncated, false);
});

test("read_withOffsetBehindTheTextEnd_shouldAnswerOffsetOutOfRangeNamingTheTotalLength", async () => {
  // GIVEN the default page, whose normalised text is 25 characters long, and a caller
  // that wants to start reading far behind its end:
  const fullText = "Erste Zeile\n\nZweite Zeile";
  const tabs = createReadTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for a window at offset 999999,
  await sendRead(socket, 2, { offset: 999999 });

  // THEN the read is refused instead of silently capped to an empty answer, and the
  // sentence names the real length — the page is the only side that knows it, so the
  // number cannot be invented here:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "offset_out_of_range");
  assert.equal(answer.error.message, `The text has ${fullText.length} characters; offset 999999 is past its end.`);
  // ... the code and the message are the whole frame: the length stands in the message,
  // not in a second field `readErrorFrame` would have to grow for:
  assert.deepStrictEqual(Object.keys(answer.error), ["code", "message"]);
  // ... and no text rides along with the refusal — a refusal is not a short answer.
  assert.equal(answer.result, undefined);
});

test("read_withMaxCharsOne_shouldAnswerASingleCharacter", async () => {
  // GIVEN the lower bound of the window — one character is a legal read:
  const tabs = createReadTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for a single character,
  await sendRead(socket, 2, { maxChars: 1 });

  // THEN one character arrives, and `totalChars` is still the length of the whole text:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.text, "E");
  assert.equal(answer.result.chars, 1);
  assert.equal(answer.result.totalChars, "Erste Zeile\n\nZweite Zeile".length);
  assert.equal(answer.result.truncated, true);
});

test("read_withMaxCharsAtTheCeiling_onALongerText_shouldAnswerThatMuchAndSetTruncated", async () => {
  // GIVEN a page whose text is longer than the largest window a caller may ask for —
  // generated, never a literal: 150 000 characters in the source would be a 150 kB diff:
  const tabs = createReadTabs({ page: { ...DEFAULT_READ_PAGE, innerText: "a".repeat(150000) } });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the ceiling,
  await sendRead(socket, 2, { maxChars: READ_MAX_CHARS_LIMIT });

  // THEN the new ceiling really carries: 100 000 characters on the wire although the
  // page holds 150 000 — and `truncated` reports the difference:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.text.length, READ_MAX_CHARS_LIMIT);
  assert.equal(answer.result.chars, READ_MAX_CHARS_LIMIT);
  assert.equal(answer.result.totalChars, 150000);
  assert.equal(answer.result.truncated, true);

  // ... and the text beyond the window never left the page: a 150 000-character answer
  // would be the difference between a read and a wall.
  assert.deepStrictEqual(tabs.channel.ops(), ["settle", "read"]);
});

test("read_onTheTextContentFallback_shouldCountTotalCharsFromTheSourceThatDeliveredTheText", async () => {
  // GIVEN a page whose visible text is empty while its content carries 24 characters
  // after normalisation — the SPA shape:
  const page = { ...DEFAULT_READ_PAGE, innerText: "", parts: [{ text: "  App-Inhalt  \n\n\nZweite Zeile  " }] };
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for five characters,
  await sendRead(socket, 2, { maxChars: 5 });

  // THEN the count comes from the source that produced the text, not from the raw DOM:
  // 24 normalised characters, of which the window takes five:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.via, "textContent");
  assert.equal(answer.result.totalChars, 24);
  assert.equal(answer.result.text, "App-I");
  assert.equal(answer.result.chars, 5);
  assert.equal(answer.result.truncated, true);
});

test("read_whenThePageReportsATooLargeTotalChars_shouldPassItThroughUnchanged", async () => {
  // GIVEN a page answer whose `totalChars` cannot be right — three characters of text,
  // seven characters counted:
  const tabs = createReadTabs({
    answer: cannedPageAnswer({
      url: "https://example.org/",
      title: "Seite",
      text: "abc",
      offset: 0,
      chars: 3,
      totalChars: 7,
      truncated: false,
      via: "innerText",
      mode: "text",
    }),
  });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the answer repeats what the page said: the page is the source of these three
  // numbers, and re-deriving them here would hide the page's mistake instead of showing
  // it — criterion 7 puts it that way on purpose.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.text, "abc");
  assert.equal(answer.result.chars, 3);
  assert.equal(answer.result.totalChars, 7);
});

test("read_withTwoDifferentOffsets_shouldAskForTwoDifferentWindows", async () => {
  // GIVEN one connection and one page:
  const tabs = createReadTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the same page is read with two different offsets,
  await sendRead(socket, 2, { offset: 0, maxChars: 10 });
  await sendRead(socket, 3, { offset: 5, maxChars: 10 });

  // THEN the two read messages carry their own window — the arguments travel with the
  // call, so a window pinned somewhere would answer the first caller's window for every
  // later one. (The settle op ran too; it is told apart by its name.)
  const reads = tabs.channel.calls.filter((call) => call.message.op === "read");
  assert.equal(reads.length, 2);
  assert.notEqual(reads[0].message.args.offset, reads[1].message.args.offset);

  // ... and what differs is only the window: every other argument is the same, the op
  // name and the frame filter included.
  assert.deepStrictEqual(reads[0].message.args, {
    offset: 0,
    maxChars: 10,
    mode: "text",
    minChars: ARTICLE_MIN_CHARS,
    urlLimit: URL_LIMIT,
    titleLimit: TITLE_LIMIT,
    want: null,
  });
  assert.deepStrictEqual(reads[1].message.args, { ...reads[0].message.args, offset: 5 });
});

/* ------------------------------------------------------ read: mode (spec 23) */

test("read_withAnInvalidMode_shouldAnswerInvalidParamsAndInjectNothing", async () => {
  // GIVEN the callers whose `mode` names nothing this extension can act on — the right
  // word in the wrong case, the wrong word entirely, the empty string, a number, and a
  // call whose mode is fine but whose window is not (the window is checked first, so it
  // has to be refused as well):
  const refused = [
    { mode: "Artikel" },
    { mode: "ARTICLE" },
    { mode: "" },
    { mode: 1 },
    { mode: "article", maxChars: 0 },
  ];

  for (const params of refused) {
    // WHEN the bridge asks for the page with that mode,
    const tabs = createReadTabs();
    const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
    await sendRead(socket, 2, params);

    // THEN the caller hears about its own mistake before anything is injected: no
    // settle wait, no read. The mode is the caller's vocabulary, not the page's, so no
    // page could ever make the answer depend on how it looks.
    const answer = responsesById(socket).get(2);
    assert.equal(answer.ok, false, `${JSON.stringify(params)} must be refused`);
    assert.equal(
      answer.error.code,
      "invalid_params",
      `${JSON.stringify(params)} must answer invalid_params, got ${answer.error.code}`,
    );
    assert.deepStrictEqual(tabs.scriptCalls, [], `${JSON.stringify(params)} must inject nothing`);
  }
});

test("read_withModeTextAndWithoutMode_shouldAnswerTheSameResult", async () => {
  // GIVEN one connection and one page:
  const tabs = createReadTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the same page is read once with the mode spelled out and once without it,
  await sendRead(socket, 2, { mode: "text" });
  await sendRead(socket, 3);
  const explicit = responsesById(socket).get(2);
  const bare = responsesById(socket).get(3);

  // THEN the two answers are the same answer: `text` is what a caller got before the
  // mode existed, and naming it may not produce anything different — same text, same
  // numbers, same source.
  assert.equal(explicit.ok, true);
  assert.equal(bare.ok, true);
  assert.deepStrictEqual(explicit.result, bare.result);

  // ... down to the absence of the two article fields, which comparing two objects
  // would not notice: `null` on both sides would compare equal. In text mode the caller
  // must see no statement about a root at all.
  for (const answer of [explicit, bare]) {
    assert.equal(answer.result.mode, "text");
    assert.equal(
      Object.hasOwn(answer.result, "root"),
      false,
      "a text answer must not carry a root",
    );
    assert.equal(
      Object.hasOwn(answer.result, "fellBack"),
      false,
      "a text answer must not carry fellBack",
    );
  }
});

test("read_inTextMode_whenThePageSetsARoot_shouldAnswerReadFailed", async () => {
  // GIVEN a page answer that is complete except for one claim it must not make: a
  // `root` in text mode, which means the injected code read a root nobody asked for:
  const tabs = createReadTabs({
    answer: cannedPageAnswer({
      url: "https://example.org/",
      title: "Seite",
      text: "Zeile",
      offset: 0,
      chars: 5,
      totalChars: 5,
      truncated: false,
      via: "innerText",
      mode: "text",
      root: "article",
    }),
  });
  const { socket, consoleLines } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN it is our own failure and not an answer: a text read that names a root cannot
  // be trusted to have read the text it says it read. The warning is the same one every
  // unusable page result gets — content-free, so it may land on the operator's console.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "read_failed");
  assert.ok(
    consoleLines.includes("warn: bc: read result without usable text"),
    `the warning is missing:\n${consoleLines.join("\n")}`,
  );
});

/* --------------------------------------------------- read: article (spec 23) */

/**
 * Invented prose long enough for stage one of the selection to count it.
 *
 * One sentence is not an article: the candidate has to reach `ARTICLE_MIN_CHARS`, and a
 * fixture that stayed under it would test the fallback while claiming to test the
 * selection.
 */
function articleProseOf(firstSentence) {
  const followingSentences = Array.from(
    { length: 12 },
    (_, index) => `Der erfundene Folgesatz ${index + 2} steht ebenfalls im Artikel.`,
  );
  return [firstSentence, ...followingSentences].join(" ");
}

test("read_inArticleMode_withAnArticleElement_shouldAnswerTheArticleTextOnly", async () => {
  // GIVEN an invented page shaped like a news page — a header, a navigation, the
  // article itself and a footer, all siblings under the body:
  const firstSentence = "Der erfundene Artikel beginnt mit diesem ersten Satz.";
  const articleText = articleProseOf(firstSentence);
  const secondParagraph = "Der erfundene zweite Absatz steht ebenfalls im Artikel.";
  const navigationText = "Erfundene Navigation: Hauptseite";
  const footerText = "Erfundene Fusszeile: Datenschutz";
  const page = createArticlePage({
    children: [
      createArticleElement({ tagName: "HEADER", text: "Erfundene Kopfzeile" }),
      createArticleElement({ tagName: "NAV", text: navigationText }),
      createArticleElement({
        tagName: "ARTICLE",
        id: "artikel",
        children: [
          createArticleElement({ tagName: "P", text: articleText }),
          createArticleElement({ tagName: "P", text: secondParagraph }),
        ],
      }),
      createArticleElement({ tagName: "FOOTER", text: footerText }),
    ],
  });
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge reads the page in article mode,
  await sendRead(socket, 2, { mode: "article" });

  // THEN the answer names the selector that hit and says it did not fall back — the
  // two fields that turn a guess into something the caller can check:
  const article = responsesById(socket).get(2);
  assert.equal(article.ok, true);
  assert.equal(article.result.mode, "article");
  assert.equal(article.result.root, "article");
  assert.equal(article.result.fellBack, false);

  // ... the text is the article's: it starts with the first sentence and carries the
  // second paragraph,
  assert.ok(
    article.result.text.startsWith(firstSentence),
    `the article must start with its first sentence, got: ${article.result.text.slice(0, 80)}`,
  );
  assert.ok(article.result.text.includes(secondParagraph));

  // ... while neither the navigation nor the footer made it in,
  assert.equal(article.result.text.includes(navigationText), false, "the navigation must stay out");
  assert.equal(article.result.text.includes(footerText), false, "the footer must stay out");

  // WHEN the same page is read in text mode,
  await sendRead(socket, 3, { mode: "text" });
  const whole = responsesById(socket).get(3);

  // THEN the chrome *is* in the text. This is the fixture checking itself: a page that
  // never had a navigation would make the two absences above true for the wrong reason.
  assert.equal(whole.ok, true);
  assert.equal(whole.result.mode, "text");
  assert.ok(whole.result.text.includes(navigationText), "the fixture must carry the navigation");
  assert.ok(whole.result.text.includes(footerText), "the fixture must carry the footer");

  // ... and the article really is the smaller part of that page.
  assert.ok(
    article.result.totalChars < whole.result.totalChars,
    `the article (${article.result.totalChars}) must be shorter than the page (${whole.result.totalChars})`,
  );
});

test("read_inArticleMode_withASemanticRootAroundTheContent_shouldDescendIntoTheInnerBlock", async () => {
  // GIVEN a page shaped like Wikipedia: no `<article>`, so `main` answers — and `main`
  // carries a hatnote block and a footer built from `<div>`s next to the content block.
  // The live run of the first version answered `main` on exactly this shape and shipped
  // 78 794 characters with "Datenschutz" fifteen times in it:
  const firstSentence = "Der erfundene Artikel beginnt mit diesem ersten Satz.";
  const articleText = articleProseOf(firstSentence);
  const hintText = "Erfundener Hinweis über diesem Artikel.";
  const footerLabels = ["Datenschutz", "Impressum", "Hauptseite"];
  const contentElement = createArticleElement({
    tagName: "DIV",
    id: "content-text",
    children: [createArticleElement({ tagName: "P", text: articleText })],
  });
  const mockup = createArticleElement({
    tagName: "MAIN",
    children: [
      createArticleElement({ tagName: "DIV", className: "hinweis", text: hintText }),
      contentElement,
      createArticleElement({
        tagName: "DIV",
        className: "vector-footer",
        children: footerLabels.map((label) =>
          createArticleElement({ tagName: "A", attributes: { href: "/wiki" }, text: label }),
        ),
      }),
    ],
  });
  const page = createArticlePage({ children: [mockup] });
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the page is read in article mode,
  await sendRead(socket, 2, { mode: "article" });
  const article = responsesById(socket).get(2);

  // THEN the answer is the content block's text and nothing else — same string, so the
  // inner block and not "`main` with its hatnote":
  assert.equal(article.ok, true);
  assert.equal(article.result.mode, "article");
  assert.equal(article.result.fellBack, false);
  assert.equal(
    article.result.text,
    articleText,
    `the inner block must be the whole text, got: ${article.result.text.slice(0, 120)}`,
  );

  // ... none of the footer labels survived, although the footer sits inside the root —
  // the descent walked past it, and the footer family would have caught it second,
  for (const label of footerLabels) {
    assert.equal(
      article.result.text.includes(label),
      false,
      `the footer link must stay out: ${label}`,
    );
  }
  assert.equal(article.result.text.includes(hintText), false, "the hatnote must stay out");

  // ... and the label still names the rule that found the root, not the depth it ended
  // at: `root` answers "which stage", the text answers "which block".
  assert.equal(article.result.root, "main");

  // ... the fixture really is the shape that defeated the selection, or the assertions
  // above would hold for the wrong reason: the inner block keeps more than four fifths
  // of its root's text, which is what makes the descent enter it.
  assert.ok(
    contentElement.innerText.length >= mockup.innerText.length * 0.8,
    `the inner block must keep at least 80 % of the root: ${contentElement.innerText.length} of ${mockup.innerText.length}`,
  );
});

test("read_inArticleMode_whenTheInnerBlockKeepsLessThanFourFifths_shouldKeepTheOuterRoot", async () => {
  // GIVEN a `main` whose text is split between two blocks of similar size — the case that
  // keeps the descent honest: neither block holds most of the root, so the root is the
  // article and not one of its halves:
  const firstSentence = "Der erfundene Artikel beginnt mit diesem ersten Satz.";
  const articleText = articleProseOf(firstSentence);
  const columnText = articleProseOf("Die erfundene Randnotiz beginnt mit diesem Satz.");
  const contentElement = createArticleElement({
    tagName: "DIV",
    id: "content-text",
    children: [createArticleElement({ tagName: "P", text: articleText })],
  });
  const columnElement = createArticleElement({
    tagName: "DIV",
    className: "randnotiz",
    children: [createArticleElement({ tagName: "P", text: columnText })],
  });
  const mockup = createArticleElement({
    tagName: "MAIN",
    children: [contentElement, columnElement],
  });
  const page = createArticlePage({ children: [mockup] });
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the page is read in article mode,
  await sendRead(socket, 2, { mode: "article" });
  const article = responsesById(socket).get(2);

  // THEN the outer root stayed, so both halves are in the text,
  assert.equal(article.ok, true);
  assert.equal(article.result.root, "main");
  assert.equal(article.result.fellBack, false);
  assert.ok(article.result.text.includes(articleText));
  assert.ok(article.result.text.includes(columnText));

  // ... because the descent only enters a block that keeps four fifths of the root —
  // the fixture checking itself, otherwise "no descent" would hold for a root whose
  // inner block the ratio never could have reached.
  assert.ok(
    contentElement.innerText.length < mockup.innerText.length * 0.8,
    `the inner block must stay below 80 % of the root: ${contentElement.innerText.length} of ${mockup.innerText.length}`,
  );
});

test("read_inArticleMode_withAFooterBuiltFromDivs_shouldLeaveItsLinksOut", async () => {
  // GIVEN an article whose footer is a `<div>` and not a `<footer>` — the shape the first
  // live run missed (Wikipedia's "Datenschutz" links) — and no inner block the descent
  // could reach, so this case is about the block list alone:
  const firstSentence = "Der erfundene Artikel beginnt mit diesem ersten Satz.";
  const articleText = articleProseOf(firstSentence);
  const footerLabels = ["Datenschutz", "Impressum"];
  const footer = createArticleElement({
    tagName: "DIV",
    // Mixed case on purpose: a block list without the ` i` flag would miss this footer,
    // and one that only knew `class="footer"` would miss it as well.
    className: "Vector-Footer-Container",
    children: footerLabels.map((label) =>
      createArticleElement({ tagName: "A", attributes: { href: "/wiki" }, text: label }),
    ),
  });
  const articleElement = createArticleElement({
    tagName: "ARTICLE",
    children: [createArticleElement({ tagName: "P", text: articleText }), footer],
  });
  const page = createArticlePage({ children: [articleElement] });
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the page is read in article mode,
  await sendRead(socket, 2, { mode: "article" });
  const article = responsesById(socket).get(2);

  // THEN the footer's links are gone and the prose stayed, so the answer is not an empty
  // root that fell back to the whole page,
  assert.equal(article.ok, true);
  assert.equal(article.result.root, "article");
  assert.equal(article.result.fellBack, false);
  for (const label of footerLabels) {
    assert.equal(
      article.result.text.includes(label),
      false,
      `the footer link must stay out: ${label}`,
    );
  }
  assert.ok(article.result.text.includes(firstSentence));

  // ... and the cleanup ran on the copy: the operator's tree still carries the footer.
  assert.equal(footer.removed, false, "the cleanup must not remove from the real page");
});

test("read_inArticleMode_withOnlyNavigation_shouldFallBackHonestly", async () => {
  // GIVEN a page that has nothing but chrome: six navigation links, ~200 characters,
  // and no element anywhere near the threshold:
  const navigationLabels = Array.from(
    { length: 6 },
    (_, index) => `Erfundener Navigationslink ${index + 1}`,
  );
  const page = createArticlePage({
    children: [
      createArticleElement({
        tagName: "NAV",
        children: navigationLabels.map((label) =>
          createArticleElement({ tagName: "A", attributes: { href: "/seite" }, text: label }),
        ),
      }),
    ],
  });
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the same page is read in article mode and in text mode,
  await sendRead(socket, 2, { mode: "article" });
  await sendRead(socket, 3, { mode: "text" });
  const article = responsesById(socket).get(2);
  const whole = responsesById(socket).get(3);

  // THEN the article mode answered with the whole page and admits it: no root, and
  // `fellBack` true — "the article is the page" is a statement, not a quiet accident.
  assert.equal(article.ok, true);
  assert.equal(article.result.mode, "article");
  assert.equal(article.result.root, null);
  assert.equal(article.result.fellBack, true);

  // ... the text is exactly the text mode's, character for character — the fallback
  // path is the old path, not a lookalike,
  assert.deepStrictEqual(article.result.text, whole.result.text);
  assert.equal(article.result.totalChars, whole.result.totalChars);

  // ... and the page really was too short to be an article, so the fallback was forced
  // rather than stumbled into: 200 characters against a threshold of 500.
  assert.ok(
    whole.result.totalChars > 150 && whole.result.totalChars < ARTICLE_MIN_CHARS,
    `the navigation page must sit under the threshold, got ${whole.result.totalChars}`,
  );
});

test("read_inArticleMode_withoutASemanticRoot_shouldTakeTheDenseBlock", async () => {
  // GIVEN a page with no `<article>`, no `<main>`, no `[role="main"]` and no `#content`:
  // a bait block over the threshold that consists of nothing but link labels, next to
  // the block a reader would call the report — paragraphs, with one link in them:
  const firstSentence = "Der erfundene Bericht beginnt mit diesem ersten Satz.";
  const denseParagraph = articleProseOf(firstSentence);
  const furtherParagraph = "Der erfundene zweite Absatz des Berichts steht ebenfalls hier.";
  const baitLabel = "Erfundener Köderlink";
  const bait = createArticleElement({
    tagName: "DIV",
    className: "teaserleiste",
    children: Array.from({ length: 20 }, (_, index) =>
      createArticleElement({
        tagName: "A",
        attributes: { href: `/koeder-${index + 1}` },
        text: `${baitLabel} ${index + 1} mit einem erfundenen Zusatz`,
      }),
    ),
  });
  const page = createArticlePage({
    children: [
      bait,
      createArticleElement({
        tagName: "DIV",
        className: "bericht",
        children: [
          createArticleElement({ tagName: "P", text: denseParagraph }),
          createArticleElement({
            tagName: "P",
            children: [
              createArticleElement({
                tagName: "A",
                attributes: { href: "/quelle" },
                text: "Erfundene Quelle",
              }),
              createArticleElement({ tagName: "SPAN", text: furtherParagraph }),
            ],
          }),
        ],
      }),
    ],
  });
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the same page is read in article mode and in text mode,
  await sendRead(socket, 2, { mode: "article" });
  await sendRead(socket, 3, { mode: "text" });
  const article = responsesById(socket).get(2);
  const whole = responsesById(socket).get(3);

  // THEN stage two answered, and the answer says that it was a heuristic rather than a
  // semantic root — the label is the caller's only way to know how much to trust it:
  assert.equal(article.ok, true);
  assert.equal(article.result.root, "density");
  assert.equal(article.result.fellBack, false);

  // ... the text is the dense block's: it starts with the report's first sentence and
  // carries the second paragraph,
  assert.ok(
    article.result.text.startsWith(firstSentence),
    `the dense block must come first, got: ${article.result.text.slice(0, 80)}`,
  );
  assert.ok(article.result.text.includes(furtherParagraph));

  // ... the bait lost, so no link label of it is left,
  assert.equal(
    article.result.text.includes(baitLabel),
    false,
    "the bait block must not win the density stage",
  );

  // ... while the text mode of the same page carries the bait. That is the fixture
  // checking itself: a page without a bait would make the absence above true for the
  // wrong reason.
  assert.equal(whole.result.text.includes(baitLabel), true, "the fixture must carry the bait");

  // ... and the bait was over the threshold, so it lost on the signals and not because it
  // was too short to be a candidate at all.
  assert.ok(
    bait.innerText.length > ARTICLE_MIN_CHARS,
    `the bait must be over the threshold, got ${bait.innerText.length}`,
  );
});

/**
 * Eight invented paragraphs: the block a reader would call the report.
 *
 * The paragraph count is the point — the score multiplies by `1 + paragraphs`, so a block
 * with the same paragraphs as its wrapper is indistinguishable to the *score* and only the
 * descent can tell them apart.
 */
function articleParagraphsOf(firstSentence) {
  return [
    articleProseOf(firstSentence),
    ...Array.from({ length: 7 }, (_, index) =>
      articleProseOf(`Der erfundene Absatz ${index + 2} des Berichts beginnt mit diesem Satz.`),
    ),
  ];
}

/**
 * The page the density stage really meets: a layout wrapper that holds the menu *and* the
 * report.
 *
 * This is the shape the first version of stage two got wrong, measured on a real page:
 * `body > div.seite > [div.menue, div.bericht]` answered `div.seite`, navigation included.
 * The wrapper is not a bug in the fixture — it is what every site ever built puts there,
 * and the score alone cannot get past it: it grows with the subtree, and the link damping
 * only shrinks it. Hence: the menu carries text *outside* its links (`menuHeading`), which
 * is what makes the wrapper score strictly higher than its own report, and hence what
 * makes this case fail on a selection that stops at the best score.
 */
function createWrappedDensityPage() {
  const firstSentence = "Der erfundene Bericht beginnt mit diesem ersten Satz.";
  const paragraphs = articleParagraphsOf(firstSentence);
  const baitLabel = "Erfundener Menülink";
  const menuHeading =
    "Erfundenes Menü dieser Seite: alle Rubriken, alle Ressorts und alle Ausgaben, " +
    "gesammelt für den Fall, dass jemand stöbern möchte. Nichts davon gehört zum " +
    "Bericht darunter, und genau das ist der Punkt dieses Testfalls.";
  const menu = createArticleElement({
    tagName: "DIV",
    className: "menue",
    text: menuHeading,
    children: Array.from({ length: 25 }, (_, index) =>
      createArticleElement({
        tagName: "A",
        attributes: { href: `/rubrik-${index + 1}` },
        text: `${baitLabel} ${index + 1} der erfundenen Ausgabe`,
      }),
    ),
  });
  const report = createArticleElement({
    tagName: "DIV",
    className: "bericht",
    children: [
      ...paragraphs.slice(0, 7).map((text) => createArticleElement({ tagName: "P", text })),
      createArticleElement({
        tagName: "P",
        children: [
          createArticleElement({
            tagName: "A",
            attributes: { href: "/quelle" },
            text: "Erfundene Quelle",
          }),
          createArticleElement({ tagName: "SPAN", text: paragraphs[7] }),
        ],
      }),
    ],
  });
  const page = createArticlePage({
    children: [
      createArticleElement({ tagName: "DIV", className: "wrapper", children: [menu, report] }),
    ],
  });
  return { page, firstSentence, menuHeading, baitLabel, report, paragraphs };
}

test("read_inArticleMode_withADenseBlockInsideALayoutWrapper_shouldTakeTheInnerBlock", async () => {
  // GIVEN a page whose report sits inside a wrapper that also holds the menu — the wrapper
  // scores higher than the report it contains, so "the best score wins" answers the wrapper:
  const { page, firstSentence, baitLabel, report, paragraphs } = createWrappedDensityPage();
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the page is read in article mode and, for the self-check, in text mode,
  await sendRead(socket, 2, { mode: "article" });
  await sendRead(socket, 3, { mode: "text" });
  const article = responsesById(socket).get(2);
  const whole = responsesById(socket).get(3);

  // THEN the inner block won, and the answer still calls it a heuristic:
  assert.equal(article.ok, true);
  assert.equal(article.result.root, "density");
  assert.equal(article.result.fellBack, false);

  // ... the text is the report's and not the wrapper's: it starts with the report's first
  // sentence and carries every paragraph of it,
  assert.ok(
    article.result.text.startsWith(firstSentence),
    `the inner block must come first, got: ${article.result.text.slice(0, 80)}`,
  );
  for (const paragraph of paragraphs) {
    assert.ok(
      article.result.text.includes(paragraph),
      `the report paragraph is missing: ${paragraph.slice(0, 40)}`,
    );
  }

  // ... no menu label is left, although the menu is inside the winning wrapper,
  assert.equal(
    article.result.text.includes(baitLabel),
    false,
    `the menu must stay out, got: ${article.result.text.slice(0, 120)}`,
  );

  // ... the report is the smaller part of the page, so the numbers say what the fields say,
  assert.ok(
    article.result.totalChars < whole.result.totalChars,
    `the report (${article.result.totalChars}) must be shorter than the page (${whole.result.totalChars})`,
  );

  // ... and the page really does carry the menu: the fixture checking itself, or the
  // absence above would be true for the wrong reason,
  assert.equal(whole.result.text.includes(baitLabel), true, "the fixture must carry the menu");

  // ... with a score margin over the report, so this case is red on a selection that stops
  // at the best score. Both blocks count eight paragraphs; the wrapper wins on the menu
  // text that sits outside its links.
  assert.equal(report.children.filter((child) => child.tagName === "P").length, 8);
});

test("read_inArticleMode_withACookieBannerInsideTheRoot_shouldLeaveTheBannerOutAndThePageUnchanged", async () => {
  // GIVEN an article whose root contains a cookie banner — the mixture of id and class a
  // real banner carries, in mixed case, so only the ` i`-flagged patterns find it:
  const articleText = articleProseOf("Der erfundene Artikel beginnt mit diesem ersten Satz.");
  const bannerText = "Erfundener Cookie-Hinweis: diese Seite verwendet Kekse.";
  const banner = createArticleElement({
    tagName: "DIV",
    id: "cookie-banner",
    className: "Cookie-Consent",
    text: bannerText,
  });
  const articleElement = createArticleElement({
    tagName: "ARTICLE",
    children: [createArticleElement({ tagName: "P", text: articleText }), banner],
  });
  const page = createArticlePage({ children: [articleElement] });
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the page is read in article mode,
  await sendRead(socket, 2, { mode: "article" });
  const article = responsesById(socket).get(2);

  // THEN the banner is not part of the article, although it sits inside the chosen root —
  // the cleanup is what removes it, not the selection,
  assert.equal(article.ok, true);
  assert.equal(article.result.root, "article");
  assert.equal(
    article.result.text.includes(bannerText),
    false,
    `the banner must stay out, got: ${article.result.text.slice(0, 120)}`,
  );

  // ... the paragraph is still there, so the case is about the banner and not about a
  // root that lost its text,
  assert.ok(article.result.text.includes(articleText));

  // ... and the operator's page was not written to: the cleanup ran on a copy, so the
  // banner still sits in the original tree, unmarked and counted.
  assert.equal(banner.removed, false, "the cleanup must not remove from the real page");
  assert.equal(articleElement.children.length, 2, "the real tree must keep both children");
});

test("read_inArticleMode_withAConsentBannerInsideTheRoot_shouldLeaveTheBannerOut", async () => {
  // GIVEN a banner that names consent and never cookie — the second family of the block
  // list, which a selector that only knew `cookie` would leave sitting in the article:
  const articleText = articleProseOf("Der erfundene Artikel beginnt mit diesem ersten Satz.");
  const bannerText = "Erfundener Zustimmungshinweis: bitte bestätigen Sie die Auswahl.";
  const page = createArticlePage({
    children: [
      createArticleElement({
        tagName: "ARTICLE",
        children: [
          createArticleElement({ tagName: "P", text: articleText }),
          createArticleElement({
            tagName: "DIV",
            className: "consent-hinweis",
            text: bannerText,
          }),
        ],
      }),
    ],
  });
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the page is read in article mode,
  await sendRead(socket, 2, { mode: "article" });
  const article = responsesById(socket).get(2);

  // THEN the consent banner is gone while the article text stays:
  assert.equal(article.ok, true);
  assert.equal(article.result.root, "article");
  assert.equal(
    article.result.text.includes(bannerText),
    false,
    `the consent banner must stay out, got: ${article.result.text.slice(0, 120)}`,
  );
  assert.ok(article.result.text.includes(articleText));
});

test("read_inArticleMode_withNavAsideAndFormInsideTheRoot_shouldLeaveThemOutAndKeepTheParagraph", async () => {
  // GIVEN the three chrome elements that a news article carries *inside* its own root —
  // the case a cleanup that only looked at siblings would miss:
  const articleText = articleProseOf("Der erfundene Artikel beginnt mit diesem ersten Satz.");
  const navigationText = "Erfundene Innennavigation: Hauptseite";
  const asideText = "Erfundene Randspalte: Das könnte dich auch interessieren";
  const formText = "Erfundene Anmeldung: E-Mail-Adresse";
  const page = createArticlePage({
    children: [
      createArticleElement({
        tagName: "ARTICLE",
        children: [
          createArticleElement({ tagName: "NAV", text: navigationText }),
          createArticleElement({ tagName: "ASIDE", text: asideText }),
          createArticleElement({ tagName: "FORM", text: formText }),
          createArticleElement({ tagName: "P", text: articleText }),
        ],
      }),
    ],
  });
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the page is read in article mode,
  await sendRead(socket, 2, { mode: "article" });
  const article = responsesById(socket).get(2);

  // THEN all three are out and the paragraph is in:
  assert.equal(article.ok, true);
  assert.equal(article.result.root, "article");
  for (const chromeText of [navigationText, asideText, formText]) {
    assert.equal(
      article.result.text.includes(chromeText),
      false,
      `the chrome inside the root must stay out: ${chromeText}`,
    );
  }
  assert.ok(article.result.text.includes(articleText));

  // ... and nothing came back from the fallback: it would have brought the chrome along.
  assert.equal(article.result.fellBack, false);
});

test("read_inArticleMode_whenTheCleanupEmptiesTheRoot_shouldFallBackHonestly", async () => {
  // GIVEN an `<article>` whose whole content is its own navigation: long enough to be
  // selected, and emptied by the cleanup:
  const navigationText = articleProseOf("Erfundene Navigation beginnt mit diesem Satz.");
  const page = createArticlePage({
    children: [
      createArticleElement({
        tagName: "ARTICLE",
        children: [createArticleElement({ tagName: "NAV", text: navigationText })],
      }),
    ],
  });
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the same page is read in article mode and in text mode,
  await sendRead(socket, 2, { mode: "article" });
  await sendRead(socket, 3, { mode: "text" });
  const article = responsesById(socket).get(2);
  const whole = responsesById(socket).get(3);

  // THEN an empty root is no root: the same honest fallback as "nothing found", instead
  // of an empty article that still claims it read one,
  assert.equal(article.ok, true);
  assert.equal(article.result.root, null);
  assert.equal(article.result.fellBack, true);

  // ... and the text is the whole page's, chrome included — the fallback path is not
  // cleaned, or `fellBack` would mean something else than "the page":
  assert.deepStrictEqual(article.result.text, whole.result.text);
  assert.ok(article.result.text.includes(navigationText));
});

test("read_inArticleMode_onAPageWithoutVisibleText_shouldFallBackToTheTextContent", async () => {
  // GIVEN a single-page app that has not laid its text out yet: the body's `innerText` is
  // empty while the paragraphs are all there for `textContent`. The paragraphs sit
  // directly in the body — the fixture's aggregated `innerText` would give a `<div>`
  // wrapper its text back, and a candidate no real SPA offers.
  const firstSentence = "Der erfundene App-Artikel beginnt mit diesem ersten Satz.";
  const articleText = articleProseOf(firstSentence);
  const secondParagraph = "Der erfundene zweite Absatz steht ebenfalls in der App.";
  const page = createArticlePage({
    withoutVisibleText: true,
    children: [
      createArticleElement({ tagName: "P", text: articleText }),
      createArticleElement({ tagName: "P", text: secondParagraph }),
    ],
  });
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the page is read in article mode,
  await sendRead(socket, 2, { mode: "article" });
  const article = responsesById(socket).get(2);

  // THEN no root is claimed: nothing visible was long enough to be selected, and the
  // honest answer says so instead of dressing an empty article up as a selection,
  assert.equal(article.ok, true);
  assert.equal(article.result.mode, "article");
  assert.equal(article.result.root, null);
  assert.equal(article.result.fellBack, true);

  // ... the text came from the second source, and `via` names it — an empty `innerText`
  // that was answered as success would be the quiet lie this case exists for,
  assert.equal(article.result.via, "textContent");

  // ... and the text is the page's, taken from the script-free body copy: both paragraphs
  // are in it, so the fallback delivered content and not an empty string.
  assert.ok(
    article.result.text.includes(firstSentence),
    `the app text must be in the fallback, got: ${article.result.text.slice(0, 80)}`,
  );
  assert.ok(article.result.text.includes(secondParagraph));
});

test("read_inArticleMode_withAWindow_shouldSliceTheFilteredText", async () => {
  // GIVEN one socket and an article page whose article and chrome both carry text:
  const firstSentence = "Der erfundene Artikel beginnt mit diesem ersten Satz.";
  const articleText = articleProseOf(firstSentence);
  const page = createArticlePage({
    children: [
      createArticleElement({ tagName: "NAV", text: "Erfundene Navigation: Hauptseite" }),
      createArticleElement({
        tagName: "ARTICLE",
        children: [createArticleElement({ tagName: "P", text: articleText })],
      }),
      createArticleElement({ tagName: "FOOTER", text: "Erfundene Fusszeile: Datenschutz" }),
    ],
  });
  const tabs = createReadTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the whole article is read first,
  await sendRead(socket, 2, { mode: "article" });
  const full = responsesById(socket).get(2);
  assert.equal(full.ok, true);

  // ... then a window on it,
  await sendRead(socket, 3, { mode: "article", offset: 10, maxChars: 20 });
  const windowed = responsesById(socket).get(3);

  // ... then a window behind its end,
  await sendRead(socket, 4, { mode: "article", offset: full.result.totalChars + 1 });
  const behind = responsesById(socket).get(4);

  // ... and finally the same page in text mode, which is a fourth call on the same
  // socket — the length comparison below needs a second number to compare against,
  await sendRead(socket, 5, { mode: "text" });
  const whole = responsesById(socket).get(5);

  // THEN the window cuts characters out of the *filtered* text: offset 10 to 30 of the
  // article, not of the page,
  assert.equal(windowed.ok, true);
  assert.equal(windowed.result.text, full.result.text.slice(10, 30));

  // ... and `totalChars` is the filtered length, so a caller can page by it,
  assert.equal(windowed.result.totalChars, full.result.text.length);

  // ... the refusal beyond the end names the number it measured, exactly like in text
  // mode: the page is the only side that knows it,
  assert.equal(behind.ok, false);
  assert.equal(behind.error.code, "offset_out_of_range");
  assert.ok(
    behind.error.message.includes(String(full.result.totalChars)),
    `the refusal must name the length, got: ${behind.error.message}`,
  );

  // ... and the two lengths belong to different texts: the chrome is what the article
  // mode left out, so the numbers cannot be the same.
  assert.notEqual(full.result.totalChars, whole.result.totalChars);
});

/* ----------------------------------------------------------------- settle */

/**
 * One op through the real dispatcher, in the page realm of `page` — and the clock stays
 * in the case's hand.
 *
 * The wait is a contract about time, so a case has to be able to stop the page's clock at
 * a named instant: `advanceClocks: false` withholds the harness's automatic run, and
 * `advanceMs` decides how far the timeline goes after the op started (again exactly
 * there, never to quiescence). The answer comes back the way it would cross the channel.
 */
async function callPageAgentOp(page, op, args, { advanceMs = null } = {}) {
  const clock = createPageClock();
  const mutationObserver = createMutationObserverStub(clock);
  page.scheduleMutations?.(clock, mutationObserver);
  const channel = createPageAgentChannel({
    frames: [{ href: page.url, page, clock, mutationObserver }],
    advanceClocks: false,
  });
  channel.inject({ target: { tabId: 500, frameIds: [0] }, files: [PAGE_AGENT_FILE] });
  await channel.deliver(500, { callId: 1, op, args }, { frameId: 0 });
  if (advanceMs === null) clock.advanceToQuiescence();
  else clock.advance(advanceMs);
  await settleAsyncWork();
  const answer = channel.answers.at(-1)?.message;
  assert.notEqual(answer, undefined, `the \`${op}\` op never answered`);
  assert.equal(answer.ok, true, `the \`${op}\` op failed: ${answer.error}`);
  return { value: answer.value, clock, mutationObserver };
}

/** The settle op of a `read` or `click`, called with the two limits the bridge sends. */
function callSettleOp(page, advanceMs = null) {
  return callPageAgentOp(
    page,
    "settle",
    { quietWindowMs: QUIET_WINDOW_MS, deadlineMs: SETTLE_DEADLINE_MS, want: null },
    { advanceMs },
  );
}

test("settlePageSource_withAMutationOneHundredMillisecondsLate_shouldReportSettledTrueAfterTheQuietWindow", async () => {
  // GIVEN a page that mutates exactly once, 100 ms after the wait started:
  const page = {
    ...DEFAULT_READ_PAGE,
    scheduleMutations: (clock, mutationObserver) => mutationObserver.mutateAfter(100),
  };

  // WHEN the page is watched,
  const { value: outcome, clock, mutationObserver } = await callSettleOp(page, 100 + QUIET_WINDOW_MS);

  // THEN quiet arrived one whole quiet window after that mutation — 100 + 250 — and
  // the answer left neither a timer nor an observer behind. The clock stops at the
  // instant the answer arrived on purpose: a drain would clear the timer map for the
  // snippet and prove nothing about `finish()`.
  assert.deepStrictEqual(outcome, { settled: true, waitedMs: 100 + QUIET_WINDOW_MS });
  assert.deepStrictEqual(clock.pendingDelays(), []);
  assert.equal(mutationObserver.connectedCount(), 0, "the observer must stop watching");
});

test("settlePageSource_onAPageThatNeverMutates_shouldReportSettledTrueAfterOneQuietWindow", async () => {
  // GIVEN a page that does not change at all while the wait runs:

  // WHEN the page is watched, and the clock runs exactly one quiet window past the
  // start — not a millisecond further, so nothing but the op's own `clearTimeout` can
  // empty the timer map,
  const { value: outcome, clock, mutationObserver } = await callSettleOp(DEFAULT_READ_PAGE, QUIET_WINDOW_MS);

  // THEN the first quiet window is the answer, not the deadline — and both timers of
  // the snippet are gone: the quiet one because it fired, the deadline one because
  // `finish()` cleared it (a forgotten `clearTimeout` leaves 3 000 − 250 behind).
  assert.deepStrictEqual(outcome, { settled: true, waitedMs: QUIET_WINDOW_MS });
  assert.deepStrictEqual(clock.pendingDelays(), []);
  assert.equal(mutationObserver.connectedCount(), 0, "the observer must stop watching");
});

test("settlePageSource_onATickingPage_shouldReportSettledFalseAfterTheDeadline", async () => {
  // GIVEN a page that mutates every 100 ms without ever stopping — the shape the
  // deadline exists for:
  const page = {
    ...DEFAULT_READ_PAGE,
    scheduleMutations: (clock, mutationObserver) => {
      const tick = () => {
        mutationObserver.mutate();
        if (clock.now() < SETTLE_DEADLINE_MS) clock.setTimeout(tick, 100);
      };
      clock.setTimeout(tick, 100);
    },
  };

  // WHEN the page is watched up to the deadline and not a millisecond beyond,
  const { value: outcome, clock, mutationObserver } = await callSettleOp(page, SETTLE_DEADLINE_MS);

  // THEN the deadline answers instead of the wait running forever: not quiet, and no
  // error — and neither the last mutation nor the finished wait left anything running,
  // the observer included (a connected one would re-arm the quiet window when the tick
  // at the deadline still arrives):
  assert.deepStrictEqual(outcome, { settled: false, waitedMs: SETTLE_DEADLINE_MS });
  assert.deepStrictEqual(clock.pendingDelays(), []);
  assert.equal(mutationObserver.connectedCount(), 0, "the observer must stop watching");
});

test("settlePageSource_inAPageWithoutMutationObserver_shouldReportNoSettleAndNotThrow", async () => {
  // GIVEN a page realm without `MutationObserver` — an embedded webview, an old
  // content process, whatever the next browser version brings:
  const page = { ...DEFAULT_READ_PAGE, withoutMutationObserver: true };

  // WHEN the page is watched,
  const { value: outcome, clock, mutationObserver } = await callSettleOp(page);

  // THEN the answer is "no statement about quiet" and not a rejection: a page that
  // cannot be watched must still be readable, and no timer is left behind — this
  // snippet never had an observer to disconnect, so the count stays zero rather than
  // proving anything on its own:
  assert.deepStrictEqual(outcome, NO_SETTLE_RESULT);
  assert.deepStrictEqual(clock.pendingDelays(), []);
  assert.equal(mutationObserver.connectedCount(), 0, "a wait that cannot watch registers nothing");
});

/* -------------------------------------------------- read waits (spec 14) */

test("read_afterAMutationWrittenOneHundredMillisecondsLate_shouldReadTheNewText", async () => {
  // GIVEN a page that shows a scaffolding first and gets its real content from a
  // mutation 100 ms later — the shape that read 398 characters on Qwant and 26 on
  // YouTube:
  const page = {
    ...DEFAULT_READ_PAGE,
    innerText: "Gerüst",
    scheduleMutations: (clock, mutationObserver) => {
      clock.setTimeout(() => {
        page.innerText = "Später geschriebener Inhalt";
        mutationObserver.mutate();
      }, 100);
    },
  };
  const tabs = createSettlingReadTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the answer says the page became quiet and carries the text the mutation
  // wrote — reading before that mutation would have answered "Gerüst":
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.settled, true);
  assert.equal(answer.result.waitedMs, 100 + QUIET_WINDOW_MS);
  assert.equal(answer.result.text, "Später geschriebener Inhalt");
  assert.equal(tabs.scriptCalls.length, 2);
});

test("read_onATickingPage_shouldAnswerSettledFalseAndReadAnyway", async () => {
  // GIVEN a page that never stops changing — the one the deadline exists for:
  const page = {
    ...DEFAULT_READ_PAGE,
    scheduleMutations: (clock, mutationObserver) => {
      const tick = () => {
        mutationObserver.mutate();
        if (clock.now() < SETTLE_DEADLINE_MS) clock.setTimeout(tick, 100);
      };
      clock.setTimeout(tick, 100);
    },
  };
  const tabs = createSettlingReadTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN it is read anyway, and the answer says the page was not quiet — no error,
  // because a page that never settles is not a failure of the read:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.settled, false);
  assert.equal(answer.result.waitedMs, SETTLE_DEADLINE_MS);
  assert.equal(answer.result.text, "Erste Zeile\n\nZweite Zeile");
});

test("read_whenTheSettleInjectionIsRefused_shouldWarnOnceAndStillRead", async () => {
  // GIVEN a page that refuses the settle snippet while the read snippet works — the
  // live shape the whole measurement in criterion 5 rides on:
  const page = DEFAULT_READ_PAGE;
  const tabs = createReadTabs({
    page,
    pageAgent: { frames: [{ href: page.url, page }], refuseInjectionTimes: 1 },
  });
  const { socket, consoleLines } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the read still happened, with the pair that means "no statement about
  // quiet" — a refused wait is not a failed read:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(
    { settled: answer.result.settled, waitedMs: answer.result.waitedMs },
    NO_SETTLE_RESULT,
  );
  assert.equal(answer.result.text, "Erste Zeile\n\nZweite Zeile");

  // ... and the fixed `bc:` line is the only trace, exactly once: without it a live
  // `waitedMs: 0` cannot be told from "the browser did not await the promise":
  const settleWarnings = consoleLines.filter(
    (line) => line === "warn: bc: settle wait not carried out",
  );
  assert.equal(
    settleWarnings.length,
    1,
    `the settle warning must appear exactly once:\n${consoleLines.join("\n")}`,
  );
});

test("read_whenTheSettleSnippetAnswersSettledAsAString_shouldReportNoSettle", async () => {
  // GIVEN a settle answer that is nearly right — a boolean that came back as a
  // string, the shape a browser that did not await the promise could produce:
  const tabs = createReadTabs({ settle: { settled: "true", waitedMs: 0 } });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page,
  await sendRead(socket, 2);

  // THEN the shape guard of `settleOutcomeOf` turns it into `NO_SETTLE` — a caller
  // must never see `settled: "true"`, and the read itself is unaffected:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(
    { settled: answer.result.settled, waitedMs: answer.result.waitedMs },
    NO_SETTLE_RESULT,
  );
  assert.equal(answer.result.text, "Erste Zeile\n\nZweite Zeile");
});

test("read_whenTheTabIsLoading_shouldNotSettleBeforeAnsweringPageBusy", async () => {
  // GIVEN a tab that reports `loading` — the one state that skips the wait, because
  // "not there yet" is the answer and three seconds of waiting would not change it:
  const tabs = createReadTabs({
    tabs: [createAgentTabFixture({ status: "loading" })],
    pageAgent: { frames: [{ href: AGENT_URL, page: DEFAULT_READ_PAGE }], refuseInjection: true },
  });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page too early,
  await sendRead(socket, 2);

  // THEN the answer is `page_busy` and exactly one injection was made — the read's,
  // not a settle attempt in front of it:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "page_busy");
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(tabs.channel.ops(), [], "a loading tab must not be asked to settle");
});

test("read_whenTheSettleSnippetNeverAnswers_shouldReadAfterTheGuard", async () => {
  // GIVEN a settle injection that never answers — the shape a background window
  // produced on 2026-10-23, where Firefox throttles the page-side deadline — while
  // the read injection works as usual:
  const page = DEFAULT_READ_PAGE;
  const tabs = createReadTabs({
    page,
    answer: (message) => (message.op === "settle" ? { silent: true } : undefined),
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the page and the settle snippet stays silent,
  await sendRead(socket, 2);

  // THEN the call is still out, and the next thing due is the extension's own watchdog —
  // the page-side deadline would have been the answer, and it is exactly the timer the
  // browser throttles. The call's own budget sits behind it (5000 > 4000), which is the
  // order the seam was built on:
  assert.equal(
    responsesById(socket).has(2),
    false,
    "the read answered although the settle snippet never did",
  );
  assert.deepStrictEqual(clock.pendingDelays(), [SETTLE_GUARD_MS, INJECTION_REPLY_TIMEOUT_MS]);

  // ... and when the watchdog fires,
  clock.runByDelay(SETTLE_GUARD_MS);
  await settleAsyncWork();

  // THEN the answer arrives, without an error and with the pair that means "no
  // statement about quiet", and the page text is there:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(
    { settled: answer.result.settled, waitedMs: answer.result.waitedMs },
    NO_SETTLE_RESULT,
  );
  assert.equal(answer.result.text, "Erste Zeile\n\nZweite Zeile");
  assert.equal(tabs.scriptCalls.length, 2, "the read injection must follow the wait");

  // ... and the watchdog left nothing armed of its own: the abandoned settle call's
  // budget is the last survivor, clears itself, and fires into an answered call at worst.
  assert.deepStrictEqual(clock.pendingDelays(), [INJECTION_REPLY_TIMEOUT_MS]);
  clock.runByDelay(INJECTION_REPLY_TIMEOUT_MS);
  await settleAsyncWork();
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

/* ------------------------------------------------------------------ click */

const CLICK_FALLBACK_MS = 300;
const DEFAULT_CLICK_SELECTOR = "a#video-title-link";

/** The shell page a tab reports while it is moved to another window — `about:blank`. */
const SHELL_PAGE_RESULT = {
  url: "about:blank",
  title: "(369) Fremdseite",
  text: "",
  offset: 0,
  chars: 0,
  totalChars: 0,
  truncated: false,
  via: "innerText",
  mode: "text",
};

/** The invented page the click cases start from — the read fixture plus one link. */
const DEFAULT_CLICK_PAGE = {
  url: "https://example.org/seite",
  title: "Beispielseite",
  innerText: "  Erste   Zeile  \n\n\n  Zweite Zeile\t\n",
};

/**
 * The invented page for one click case.
 *
 * A factory, not a constant: every case counts the `click()` calls on its own
 * element, and a shared one would carry the count over from the case before.
 * `element` replaces the default link, `overrides` replaces anything else — the
 * list of selectors the page cannot parse, above all.
 */
function createClickPage({ element, ...overrides } = {}) {
  return {
    ...DEFAULT_CLICK_PAGE,
    elements: { [DEFAULT_CLICK_SELECTOR]: element ?? createClickElement({ id: "video-title-link" }) },
    ...overrides,
  };
}

/**
 * The click path with an injection that can be steered per case.
 *
 * A click runs *three* snippets now — click, settle, read — and the fixture answers
 * the settle one with the `settle` pair (default `NO_SETTLE_RESULT`: the pair that
 * makes `click` fall back to its fixed 300 ms, which is what every case that is not
 * about the wait keeps asserting). The answer is a value and not a promise for the
 * same reason as in `createReadTabs`: `runPageCode` would hand a promise back as
 * `{}`. A case that supplies its own `executeScript` answers the marker itself —
 * injection 2 is the settle snippet, not the read.
 *
 * The tab is `complete` by default, because a click case is about the *page* — the
 * one case about a still-loading tab names that status itself.
 */
function createClickTabs({
  page = createClickPage(),
  tabs = [createAgentTabFixture({ status: "complete" })],
  settle = NO_SETTLE_RESULT,
  answer,
  pageAgent,
} = {}) {
  return createTabsStub({
    tabs,
    pageAgent: pageAgent ?? {
      frames: [{ href: page.url, page }],
      answer: answer ?? settleCannedAnswer(settle),
    },
  });
}

/** The click case whose settle op really runs, on the page realm's virtual clock. */
function createSettlingClickTabs(page) {
  return createClickTabs({ page, pageAgent: { frames: [{ href: page.url, page }] } });
}

/** Sends one `click` request and lets the bridge page work through it. */
async function sendClick(socket, id, params) {
  socket.receive({ type: "request", id, method: "click", params });
  await settleAsyncWork();
}

/**
 * One click against a page built around `element`, and the answer that came back.
 *
 * The five description cases differ only in the element, so they share the six
 * steps: build the page, connect, click, let the 300 ms pass, read the answer.
 */
async function answerForClickedElement(element) {
  const tabs = createClickTabs({ page: createClickPage({ element }) });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });
  clock.runNext();
  await settleAsyncWork();
  return responsesById(socket).get(2);
}

test("click_withoutAStoredAgentTab_shouldAnswerNoAgentTabAndInjectNothing", async () => {
  // GIVEN a connected extension that has never navigated — no agent tab, although
  // the operator's window has one:
  const tabs = createTabsStub({ tabs: [createAgentTabFixture()] });
  const { socket } = await connectedBackground({ tabs });

  // WHEN the bridge asks to click something,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN it is the same refusal as `read`, and nothing was injected: clicking in a
  // page nobody asked for would be worse than refusing:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "no_agent_tab");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("click_withTab_shouldClickInThatTab", async () => {
  // GIVEN two agent tabs, 500 the last used one and 501 the one the request names,
  const tabs = createClickTabs({ tabs: createTwoAgentTabs({ status: "complete" }) });
  const { socket, clock } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge clicks in tab 501 by name,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR, tab: 501 });
  clock.runNext();
  await settleAsyncWork();

  // THEN every injection — the click, the settle wait and the read behind it — ran in
  // that tab, and the answer says so:
  assert.equal(tabs.scriptCalls[0].tabId, 501);
  assert.equal(tabs.scriptCalls.every((call) => call.tabId === 501), true);
  assert.equal(responsesById(socket).get(2).result.tabId, 501);
});

test("click_withASelectorThePageCannotParse_shouldAnswerInvalidSelectorAndNotClick", async () => {
  // GIVEN a page whose `querySelector` refuses the selector, as a real one does:
  const element = createClickElement({ id: "video-title-link" });
  const page = createClickPage({ element, unparseableSelectors: [DEFAULT_CLICK_SELECTOR] });
  const tabs = createClickTabs({ page });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to click it,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN the answer names the selector as the problem, nothing was clicked, no
  // second injection ran and no 300 ms window was opened:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "invalid_selector");
  assert.equal(element.clicks, 0);
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("click_withAnEmptySelector_shouldAskThePageInsteadOfRefusing", async () => {
  // GIVEN a page that refuses the empty selector the way a real one does —
  // `querySelector("")` throws a `SyntaxError`:
  const page = createClickPage({ unparseableSelectors: [""] });
  const tabs = createClickTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge sends an empty selector,
  await sendClick(socket, 2, { selector: "" });

  // THEN every string reaches the page, the empty one included — only a missing or
  // non-string selector is decided in the extension:
  assert.equal(responsesById(socket).get(2).error.code, "invalid_selector");
  assert.equal(tabs.scriptCalls.length, 1);
});

test("click_withASelectorThatMatchesNothing_shouldAnswerNoMatchAndNotClick", async () => {
  // GIVEN a page whose only element sits under a different selector:
  const page = createClickPage();
  const tabs = createClickTabs({ page });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for an element nobody has,
  await sendClick(socket, 2, { selector: "a#not-there" });

  // THEN it is `no_match` — not an error of the page — and the one element that did
  // exist was not touched:
  assert.equal(responsesById(socket).get(2).error.code, "no_match");
  assert.equal(page.elements[DEFAULT_CLICK_SELECTOR].clicks, 0);
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("click_onAnElementWithoutArea_shouldAnswerNotClickableAndNotClick", async () => {
  // GIVEN an element that occupies no space — `display:none` without the style, as
  // far as `getBoundingClientRect` can tell:
  const element = createClickElement({ id: "video-title-link", rect: { width: 0, height: 0 } });
  const tabs = createClickTabs({ page: createClickPage({ element }) });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to click it,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN the refusal replaces the silent non-click: a click on nothing would run
  // `click()` for no effect and still answer "clicked":
  assert.equal(responsesById(socket).get(2).error.code, "not_clickable");
  assert.equal(element.clicks, 0);
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("click_onAnElementWithDisplayNone_shouldAnswerNotClickableAndNotClick", async () => {
  // GIVEN a laid-out element that the stylesheet hides:
  const element = createClickElement({ id: "video-title-link", display: "none" });
  const tabs = createClickTabs({ page: createClickPage({ element }) });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to click it,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN the computed style decides, not the geometry:
  assert.equal(responsesById(socket).get(2).error.code, "not_clickable");
  assert.equal(element.clicks, 0);
});

test("click_onAnElementWithVisibilityHidden_shouldAnswerNotClickableAndNotClick", async () => {
  // GIVEN a laid-out element that occupies space but is not rendered — the shape a
  // `visibility: hidden` menu entry has:
  const element = createClickElement({ id: "video-title-link", visibility: "hidden" });
  const tabs = createClickTabs({ page: createClickPage({ element }) });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to click it,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN the refusal is the rule, not the geometry: the element has area, so only
  // `visibility` can refuse it here:
  assert.equal(responsesById(socket).get(2).error.code, "not_clickable");
  assert.equal(element.clicks, 0);
});

test("click_onADisabledElement_shouldAnswerNotClickableAndNotClick", async () => {
  // GIVEN a button that is there, visible and disabled:
  const element = createClickElement({ tagName: "BUTTON", disabled: true });
  const tabs = createClickTabs({ page: createClickPage({ element }) });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to click it,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN it is refused rather than half-done:
  assert.equal(responsesById(socket).get(2).error.code, "not_clickable");
  assert.equal(element.clicks, 0);
});

test("click_onAnElementBelowTheFold_shouldScrollAndClickOnce", async () => {
  // GIVEN a link that is laid out and visible but 132 px below the visible area — the
  // ordinary "there is more page below" case, not a defect:
  const element = createClickElement({
    id: "video-title-link",
    rect: { x: 0, y: 900, width: 120, height: 24 },
  });

  // WHEN the bridge asks to click it,
  const answer = await answerForClickedElement(element);

  // THEN the page scrolled to it, exactly once, to the centre — not to the next edge:
  assert.equal(element.scrolls, 1, "a target outside the visible area must be scrolled to");
  assert.deepStrictEqual(inThisRealm(element.scrollOptions), [
    { block: "center", inline: "center", behavior: "instant" },
  ]);

  // ... and it was clicked exactly once after that, because the second measurement found
  // it in the visible area,
  assert.equal(element.clicks, 1, "the element must be clicked exactly once");
  assert.equal(answer.ok, true);
  assert.equal(answer.result.clicked, "a#video-title-link");

  // ... and the answer says that the click had to scroll first, instead of hiding it:
  assert.equal(answer.result.scrolled, true);
});

test("click_onAnElementOutsideTheViewport_shouldAnswerOffscreenAndNotClick", async () => {
  // GIVEN the element from the incident: Amazon's keyboard-shortcut menu at `x = -9966`,
  // still outside after the page scrolled — the rectangle does not move here:
  const element = createClickElement({
    id: "video-title-link",
    rect: { x: -9966, y: 385, width: 351, height: 41 },
    scrollBringsIntoView: false,
  });
  const tabs = createClickTabs({ page: createClickPage({ element }) });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to click it,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN the second measurement is the one that decides: the page did try to scroll,
  assert.equal(element.scrolls, 1, "the snippet must try the scroll before it refuses");

  // ... the target is still outside, so the answer is the fourth refusal reason,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "offscreen_after_scroll");
  assert.equal("result" in answer, false, "a refusal carries no result");

  // ... nothing was clicked, no wait was opened, and the read behind it never ran: the
  // refusal answers before the second injection,
  assert.equal(element.clicks, 0, "an unreachable target must not be clicked");
  assert.deepStrictEqual(clock.pendingDelays(), []);
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(tabs.channel.ops(), ["click"]);
});

test("click_onAnElementInTheViewport_shouldNotScroll", async () => {
  // GIVEN a link that is already where a reader can see it — the fixture default,
  // `x: 0, y: 0` in a 1024 × 768 window:
  const element = createClickElement({ id: "video-title-link" });

  // WHEN the bridge asks to click it,
  const answer = await answerForClickedElement(element);

  // THEN no scroll happened at all,
  assert.equal(element.scrolls, 0, "a visible target must not be scrolled to");
  assert.deepStrictEqual(inThisRealm(element.scrollOptions), []);

  // ... and the click did happen — `scrolled: false` is not a refusal,
  assert.equal(element.clicks, 1);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.clicked, "a#video-title-link");
  assert.equal(answer.result.scrolled, false);
});

test("click_onAVisibleElement_shouldClickOnceSettleAndRead", async () => {
  // GIVEN a visible link, and a page whose settle snippet runs for real on the page's
  // own clock — quiet one window after the click:
  const element = createClickElement({ id: "video-title-link" });
  const page = createClickPage({ element });
  const tabs = createSettlingClickTabs(page);
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to click it,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN the three ops ran in the only order that makes sense — click, settle, read:
  assert.equal(element.clicks, 1, "the element must be clicked exactly once");
  assert.equal(tabs.scriptCalls.length, 3);
  assert.deepStrictEqual(tabs.channel.ops(), ["click", "settle", "read"]);

  // ... and the wait needed no fallback: the page answered, so nothing of the old
  // fixed window was armed, and the guard left nothing behind either. An armed
  // fallback would sit here as one 300 ms timer, a survivor of the guard as 4 000.
  assert.deepStrictEqual(clock.pendingDelays(), []);

  // ... and the answer is the read result plus the click and what the wait saw, the
  // two new fields behind `via` in the documented order — `scrolled` behind `clicked`,
  // because that is where the wire contract puts it:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(answer.result, {
    tabId: 500,
    url: DEFAULT_CLICK_PAGE.url,
    title: DEFAULT_CLICK_PAGE.title,
    clicked: "a#video-title-link",
    scrolled: false,
    text: "Erste Zeile\n\nZweite Zeile",
    truncated: false,
    via: "innerText",
    settled: true,
    waitedMs: QUIET_WINDOW_MS,
  });
  assert.deepStrictEqual(Object.keys(answer.result), [
    "tabId",
    "url",
    "title",
    "clicked",
    "scrolled",
    "text",
    "truncated",
    "via",
    "settled",
    "waitedMs",
  ]);
});

test("click_shouldDeliverScrolledRightAfterClicked", async () => {
  // GIVEN a click that goes through — the shape of the answer is what this case is about:
  const element = createClickElement({ id: "video-title-link" });

  // WHEN the bridge clicks it,
  const answer = await answerForClickedElement(element);

  // THEN `scrolled` stands directly behind `clicked`: the key order of this answer is part
  // of the wire contract, and `scrolled` takes index 4, not the end of the list (`docs/56`,
  // criterion 3),
  const keys = Object.keys(answer.result);
  assert.equal(keys.indexOf("scrolled"), keys.indexOf("clicked") + 1);
  assert.equal(keys[4], "scrolled", `index 4 must be \`scrolled\`, got: ${keys[4]}`);

  // ... and it is a boolean the caller can act on, not a missing field read as `false`:
  assert.equal(typeof answer.result.scrolled, "boolean");
});

test("click_whenTheSettleSnippetReturnsNothing_shouldFallBackToTheFixedWait", async () => {
  // GIVEN a page whose settle injection runs and reports "no statement about quiet" —
  // the fixture default, and the shape a PDF viewer or an `about:` address produces:
  const page = createClickPage();
  const tabs = createClickTabs({ page });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to click it,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN the old 300 ms are made good through the slot: click and settle ran, the
  // read has not, and the fallback is the only timer left.
  assert.equal(tabs.scriptCalls.length, 2);
  assert.deepStrictEqual(tabs.channel.ops(), ["click", "settle"]);
  assert.deepStrictEqual(clock.pendingDelays(), [CLICK_FALLBACK_MS]);
  assert.equal(responsesById(socket).has(2), false);

  // WHEN the fallback is over,
  assert.equal(clock.runNext(), CLICK_FALLBACK_MS);
  await settleAsyncWork();

  // THEN the read follows, and the answer says honestly that no quiet was observed —
  // the same two values `read` reports for the same page, in a click answer:
  assert.equal(tabs.scriptCalls.length, 3);
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(
    { settled: answer.result.settled, waitedMs: answer.result.waitedMs },
    NO_SETTLE_RESULT,
  );
  assert.equal(answer.result.clicked, "a#video-title-link");
  assert.equal(answer.result.text, "Erste Zeile\n\nZweite Zeile");
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("click_whenTheSettleWaitIsOvertaken_shouldAnswerSupersededWithoutAFallback", async () => {
  // GIVEN a click whose settle injection never answers — the page is busy, or the
  // snippet sits in a throttled timer, and the background is still waiting:
  const page = createClickPage();
  const tabs = createClickTabs({
    page,
    answer: (message) => (message.op === "settle" ? { silent: true } : undefined),
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });
  assert.equal(tabs.scriptCalls.length, 2);
  // The settle wait's watchdog is what ends the silence: no fallback, because the page
  // has not said anything yet. Behind it sits the abandoned call's own budget (5000).
  assert.deepStrictEqual(clock.pendingDelays(), [SETTLE_GUARD_MS, INJECTION_REPLY_TIMEOUT_MS]);

  // WHEN a navigation takes the slot over — the one kind that waits for nothing at
  // all, because the tab already shows the address it asks for:
  await sendNavigate(socket, 3, { url: "https://before.example/" });

  // THEN the click answers promptly and says why,
  assert.equal(
    responsesById(socket).has(2),
    true,
    "the superseded call must answer without the clock",
  );
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "superseded");

  // ... the sentinel never travels in a result, so nothing of a settle pair is there,
  assert.equal("result" in answer, false);

  // ... no fallback was armed for a caller that is already answered, and the halted
  // wait took its watchdog with it: the abandoned call's deadline is all that is left,
  // and it clears itself instead of firing into the answered call.
  assert.equal(tabs.scriptCalls.length, 2, "a superseded click must not read");
  assert.deepStrictEqual(clock.pendingDelays(), [INJECTION_REPLY_TIMEOUT_MS]);
  clock.runByDelay(INJECTION_REPLY_TIMEOUT_MS);
  await settleAsyncWork();
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("click_withASlowFirstInjection_shouldArmTheWaitOnlyAfterTheClick", async () => {
  // GIVEN a page whose first injection has not answered yet — a heavy or throttled
  // page, as far as the background can tell:
  const page = createClickPage();
  let releaseClick = () => {};
  const clicked = new Promise((resolve) => {
    releaseClick = resolve;
  });
  const tabs = createClickTabs({
    page,
    // The settle op answers like the fixture's default, the read runs for real — and the
    // click is the promise the case resolves by hand, so the page really has not answered
    // yet. That is the shape a heavy or throttled page has from the outside.
    answer: (message) =>
      message.op === "settle"
        ? { value: { ...NO_SETTLE_RESULT } }
        : message.op === "click"
          ? clicked.then(() => ({ value: { outcome: "clicked", clicked: "a#video-title-link" } }))
          : undefined,
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the request arrives but the page has not been clicked yet,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN no wait is running: neither the settle wait (4 000) nor its fallback (300) — the
  // wait belongs to the click ("Warten danach"). Armed at the request instead, a slow
  // injection would eat the whole window and the read would see a page that had no
  // chance to react. All that is armed is the call's own budget for the answer it is
  // still waiting for:
  assert.deepStrictEqual(clock.pendingDelays(), [INJECTION_REPLY_TIMEOUT_MS], "the wait must not start before the click");
  assert.equal(tabs.scriptCalls.length, 1);

  // WHEN the click finally lands,
  releaseClick();
  await settleAsyncWork();

  // THEN the wait starts now — after the click, not after the request. It is the
  // fallback here, because the fixture's settle answer is `NO_SETTLE`:
  assert.deepStrictEqual(clock.pendingDelays(), [CLICK_FALLBACK_MS]);

  // ... and the read follows the wait as usual.
  assert.equal(clock.runNext(), CLICK_FALLBACK_MS);
  await settleAsyncWork();
  assert.equal(tabs.scriptCalls.length, 3);
  assert.equal(responsesById(socket).get(2).ok, true);
});

test("click_onAnElementWithAClassOnly_shouldDescribeItAsTagAndFirstClassCappedAtTheLimit", async () => {
  // GIVEN an element whose only distinguishing detail is its class list,
  // WHEN we click it,
  const answer = await answerForClickedElement(createClickElement({ className: `${"x".repeat(200)} zweite` }));

  // THEN the description stays one short line: the tag, the *first* class, and never
  // more than 120 characters — the rest would be page content in disguise:
  assert.equal(answer.result.clicked.length, 120);
  assert.equal(answer.result.clicked, `a.${"x".repeat(200)}`.slice(0, 120));
});

test("click_onAnElementWithNothingButAnHref_shouldDescribeItByThatAttribute", async () => {
  // GIVEN a link that carries neither id nor class,
  // WHEN we click it,
  const answer = await answerForClickedElement(
    createClickElement({ attributes: { href: "/watch?v=1" } }),
  );

  // THEN the attribute is the name — the raw attribute, not the absolutised URL a
  // browser would report:
  assert.equal(answer.result.clicked, 'a[href="/watch?v=1"]');
});

test("click_onAnElementWithNothingButAnAriaLabel_shouldDescribeItByThatLabel", async () => {
  // GIVEN a button with no id, no class and no href,
  // WHEN we click it,
  const answer = await answerForClickedElement(
    createClickElement({ tagName: "BUTTON", attributes: { "aria-label": "Menü öffnen" } }),
  );

  // THEN the accessibility label is the last detail before the bare tag:
  assert.equal(answer.result.clicked, 'button[aria-label="Menü öffnen"]');
});

test("click_whenTheClickDropsTheElementsIdAndClass_shouldStillDescribeItAsItWasBeforeTheClick", async () => {
  // GIVEN a link whose click re-renders it away — `id` and `class` are gone by the
  // time `click()` returns, which is what a list re-render does:
  const element = createClickElement({
    id: "video-title-link",
    className: "yt-simple-endpoint",
    onClick: () => {
      element.id = "";
      element.className = "";
    },
  });

  // WHEN we click it,
  const answer = await answerForClickedElement(element);

  // THEN the answer still names it: the description is built *before* the click, so
  // a description built afterwards would read the bare tag here and pass every
  // other case:
  assert.equal(answer.result.clicked, "a#video-title-link");
});

test("click_onAnElementWithNoDetailAtAll_shouldDescribeItByItsTagAlone", async () => {
  // GIVEN an element that says nothing about itself,
  // WHEN we click it,
  const answer = await answerForClickedElement(createClickElement());

  // THEN the tag is the whole description — lower case, as a CSS selector writes
  // it, and never the markup:
  assert.equal(answer.result.clicked, "a");
});

test("click_whenTheClickChangesTitleAndAddress_shouldAnswerTheNewStateAndTheTextAfter", async () => {
  // GIVEN a link whose click changes the page like an SPA route change — the
  // fixture writes through to the very object the second injection reads:
  const page = createClickPage();
  page.elements[DEFAULT_CLICK_SELECTOR] = createClickElement({
    id: "video-title-link",
    onClick: () => {
      page.url = "https://example.org/watch?v=1";
      page.title = "Video - Beispielseite";
    },
  });
  const tabs = createClickTabs({ page });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN we click it and the window is over,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });
  clock.runNext();
  await settleAsyncWork();

  // THEN the answer carries the *new* address and title, and the text as it stands
  // after the click:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.url, "https://example.org/watch?v=1");
  assert.equal(answer.result.title, "Video - Beispielseite");
  assert.equal(answer.result.text, "Erste Zeile\n\nZweite Zeile");
  assert.equal(answer.result.clicked, "a#video-title-link");
});

test("click_whenThePageLandsOnAnAboutAddress_shouldAnswerTheStateFromBeforeWithEmptyText", async () => {
  // GIVEN a click whose read afterwards lands on the shell page of a tab being
  // moved — `about:blank` with the old title, exactly the state a real run reported:
  const page = createClickPage();
  const tabs = createClickTabs({
    page,
    // The click runs for real; the settle pair and the read are the shell page a tab
    // reports while it is dragged into a new window.
    answer: (message) =>
      message.op === "settle"
        ? { value: { ...NO_SETTLE_RESULT } }
        : message.op === "read"
          ? { value: { ...SHELL_PAGE_RESULT } }
          : undefined,
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN we click and the fallback window is over,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });
  clock.runNext();
  await settleAsyncWork();

  // THEN `about:` is never reported as a page: the address and title from before the
  // click stand in, with an empty text — the click answer has no `complete` to carry
  // that rule the way `navigate` does — and in the same field order as any other
  // click answer, the settle pair last:
  const answer = responsesById(socket).get(2);
  assert.deepStrictEqual(answer.result, {
    tabId: 500,
    url: "https://before.example/",
    title: "Vorher",
    text: "",
    truncated: false,
    via: "innerText",
    clicked: "a#video-title-link",
    scrolled: false,
    settled: false,
    waitedMs: 0,
  });
  assert.deepStrictEqual(Object.keys(answer.result), [
    "tabId",
    "url",
    "title",
    "clicked",
    "scrolled",
    "text",
    "truncated",
    "via",
    "settled",
    "waitedMs",
  ]);
});

test("click_onATabThatOnlyShowsAnAboutAddress_shouldAnswerEmptyUrlAndTitle", async () => {
  // GIVEN an agent tab that shows nothing but `about:blank`, with an old title the
  // browser never cleared:
  const page = createClickPage();
  const tabs = createClickTabs({
    page,
    tabs: [createAgentTabFixture({ url: "about:blank", title: "(369) Fremdseite", status: "complete" })],
    answer: (message) =>
      message.op === "settle"
        ? { value: { ...NO_SETTLE_RESULT } }
        : message.op === "read"
          ? { value: { ...SHELL_PAGE_RESULT } }
          : undefined,
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the read after the click reaches `about:` again,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });
  clock.runNext();
  await settleAsyncWork();

  // THEN there is no state to fall back to: an empty URL and an empty title, rather
  // than an `about:` address dressed up as a page:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.result.url, "");
  assert.equal(answer.result.title, "");
  assert.equal(answer.result.text, "");
});

test("click_withoutASelector_shouldAnswerInvalidParamsAndInjectNothing", async () => {
  // GIVEN a stored agent tab and a page that could be clicked:
  const tabs = createClickTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the request carries no selector at all,
  await sendClick(socket, 2, {});

  // THEN it is a parameter mistake of the caller, decided before any injection:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "invalid_params");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("click_withASelectorThatIsNotAString_shouldAnswerInvalidParamsAndInjectNothing", async () => {
  // GIVEN a stored agent tab and a page that could be clicked:
  const tabs = createClickTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the selector is anything but a string — an object here:
  await sendClick(socket, 2, { selector: { css: DEFAULT_CLICK_SELECTOR } });

  // THEN it is refused in the extension, not stringified into `[object Object]` and
  // handed to the page:
  assert.equal(responsesById(socket).get(2).error.code, "invalid_params");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("click_whenTheTabIsStillLoading_shouldAnswerPageBusy", async () => {
  // GIVEN a tab that is still loading and an injection Firefox refuses in that
  // moment — no page is there to aim a selector at yet:
  const tabs = createClickTabs({
    tabs: [createAgentTabFixture({ status: "loading" })],
    pageAgent: { frames: [{ href: AGENT_URL, page: DEFAULT_READ_PAGE }], refuseInjection: true },
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to click too early,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN the answer is the same code `read` gives for the same tab — one decision
  // in `injectPageCode`, four tools,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "page_busy");

  // ... the frame stays the two-field one, and no 300 ms window was opened for a
  // page that was never there.
  assert.equal("url" in answer.error, false);
  assert.equal("kind" in answer.error, false);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("click_onATabThatReportedLoading_shouldNotSettleAndNotFallBack", async () => {
  // GIVEN a tab that reported `loading` before the click, and a page the click
  // injection still gets through to — the status and the request raced, or the tab
  // is loading a fragment rather than a document:
  const page = createClickPage();
  const tabs = createClickTabs({
    page,
    tabs: [createAgentTabFixture({ status: "loading" })],
    // Reaching the settle op at all is the wait this case rules out: the page agent has
    // no such op on this realm, so a call to it would answer `unknown op` — and the
    // assertions below would see a third op and an error instead of this answer.
    answer: (message) =>
      message.op === "settle" ? { value: { settled: "unerwartet", waitedMs: 0 } } : undefined,
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge clicks,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN nothing is armed: no settle watchdog and, above all, no 300 ms fallback —
  // the loading case must not reach the "do wait" signal of `NO_SETTLE`,
  assert.deepStrictEqual(clock.pendingDelays(), [], "a loading tab must not start a wait");

  // ... exactly two ops ran — click and read, with no settle wait between them,
  assert.equal(tabs.scriptCalls.length, 2);
  assert.deepStrictEqual(tabs.channel.ops(), ["click", "read"]);

  // ... and the answer is already there, without the clock being advanced,
  assert.equal(responsesById(socket).has(2), true, "the answer must arrive without the clock");
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);

  // ... saying honestly that no quiet was observed.
  assert.deepStrictEqual(
    { settled: answer.result.settled, waitedMs: answer.result.waitedMs },
    { settled: false, waitedMs: 0 },
  );
});

test("click_whenThePageCannotBeReadAfterTheClick_shouldAnswerNotReadableAfterClick", async () => {
  // GIVEN a page that takes the click and refuses injection afterwards — the tab was
  // navigated into a PDF viewer, say:
  const page = createClickPage();
  const tabs = createClickTabs({
    page,
    tabs: [createAgentTabFixture({ status: "complete" })],
    // The click and the settle pair answer, the read's injection is refused — the tab
    // was navigated into a viewer this extension cannot touch.
    pageAgent: {
      frames: [{ href: page.url, page }],
      refuseInjectionAfter: 2,
      answer: (message) => (message.op === "settle" ? { value: { ...NO_SETTLE_RESULT } } : undefined),
    },
  });
  const { socket, clock, consoleLines } = await connectedBackground({
    tabs,
    settings: STORED_TAB_SETTINGS,
  });

  // WHEN we click and the window is over,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });
  clock.runNext();
  await settleAsyncWork();

  // THEN the click is not reported as a failure of `read`: the code says what happened —
  // the click went through — and the sentence names the way back, so the caller does not
  // repeat the click it already made:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "not_readable_after_click");

  // ... in the pinned sentence, with both halves and the address the frame carries,
  assert.equal(
    answer.error.message,
    "The click went through, but the page it opened cannot be read: https://before.example/. Go back with browser_navigate.",
  );

  // ... and the address is a field of its own, the way `read` shapes a `not_readable` —
  // `clicked` is not: the element is gone with the page it opened.
  assert.equal(answer.error.url, "https://before.example/");
  assert.equal("clicked" in answer.error, false);
  assert.ok(
    !consoleLines.some((line) => line.includes("click result without a known outcome")),
    "a refusal of the page is not a warning of ours",
  );
});

test("click_whenThePageAfterTheClickIsUnreadable_shouldCarryTheAddressAndKind", async () => {
  // GIVEN a page that takes the click and refuses injection afterwards, in a tab whose
  // address names a PDF — the case the second injection cannot see:
  const page = createClickPage();
  const tabs = createClickTabs({
    page,
    tabs: [
      createAgentTabFixture({ url: "https://example.org/preisliste.pdf", status: "complete" }),
    ],
    pageAgent: {
      frames: [{ href: page.url, page }],
      refuseInjectionAfter: 2,
      answer: (message) => (message.op === "settle" ? { value: { ...NO_SETTLE_RESULT } } : undefined),
    },
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN we click and the window is over,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });
  clock.runNext();
  await settleAsyncWork();

  // THEN the error frame names the page the same way `read` does: there is one place
  // that enriches a `not_readable` family refusal, so both calls answer with the same
  // two fields — only the code and the sentence are the click's own:
  const error = responsesById(socket).get(2).error;
  assert.equal(error.code, "not_readable_after_click");
  assert.equal(error.url, "https://example.org/preisliste.pdf");
  assert.equal(error.kind, "pdf");
});

test("click_onATabThatIsUnreadableBeforeTheClick_shouldAnswerNotReadable", async () => {
  // GIVEN a tab that already stands on a page this extension cannot inject into —
  // `about:config`, a PDF viewer, `view-source:` — so the *first* injection is refused
  // and no click ever happens:
  const page = createClickPage();
  const tabs = createClickTabs({
    page,
    tabs: [createAgentTabFixture({ status: "complete" })],
    pageAgent: { frames: [{ href: page.url, page }], refuseInjection: true },
  });
  const { socket, consoleLines } = await connectedBackground({
    tabs,
    settings: STORED_TAB_SETTINGS,
  });

  // WHEN we click,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });
  await settleAsyncWork();

  // THEN the answer is the plain `not_readable` the page gives any call — the tab was
  // unreadable before the click, and nothing was opened by it:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "not_readable");
  assert.equal(answer.error.message, "The page gives no readable content.");

  // ... and no half of the click sentence is borrowed: neither the claim that the click
  // went through, nor the way back for a page that was never opened,
  assert.equal(answer.error.message.includes("The click went through"), false);
  assert.equal(answer.error.message.includes("browser_navigate"), false);

  // ... and nothing ran past the refused snippet: no settle, no read — the tab's own
  // address is still the answer's only evidence, and it is the one it had before.
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(tabs.channel.ops(), []);
  assert.equal(answer.error.url, "https://before.example/");
  assert.ok(
    !consoleLines.some((line) => line.includes("click result without a known outcome")),
    "a refusal of the page is not a warning of ours",
  );
});

test("click_whenTheClickedPageHasNoAddress_shouldAnswerTheShortSentence", async () => {
  // GIVEN a tab the browser reports without an address and a page that takes the click
  // and refuses the read behind it — the frame then carries `url: null`, which is the
  // case the shorter sentence exists for:
  const page = createClickPage();
  const tabs = createClickTabs({
    page,
    tabs: [createAgentTabFixture({ url: "", status: "complete" })],
    pageAgent: {
      frames: [{ href: page.url, page }],
      refuseInjectionAfter: 2,
      answer: (message) => (message.op === "settle" ? { value: { ...NO_SETTLE_RESULT } } : undefined),
    },
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN we click and the window is over,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });
  clock.runNext();
  await settleAsyncWork();

  // THEN the click is still reported as having gone through, but in the form without an
  // address — no dangling colon, and the way back is still named:
  const error = responsesById(socket).get(2).error;
  assert.equal(error.code, "not_readable_after_click");
  assert.equal(
    error.message,
    "The click went through, but the page it opened cannot be read. Go back with browser_navigate.",
  );

  // ... and the frame says "no address" the way `read` does: `url` is `null`, not empty.
  assert.equal(error.url, null);
  assert.equal(error.kind, "unknown");
  assert.equal("clicked" in error, false);
});

test("click_withTwoOverlappingRequests_shouldAnswerTheFirstWithSupersededAndInjectNoRead", async () => {
  // GIVEN a click that has already clicked and settled and is waiting out its
  // fallback 300 ms:
  const page = createClickPage();
  const tabs = createClickTabs({ page });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });
  assert.deepStrictEqual(clock.pendingDelays(), [CLICK_FALLBACK_MS]);
  assert.equal(tabs.scriptCalls.length, 2, "the click and its settle wait");

  // WHEN a second click arrives inside that window,
  await sendClick(socket, 3, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN the first answers `superseded`,
  const first = responsesById(socket).get(2);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, "superseded");

  // ... it injects no read into the page its successor is about to show — four
  // injections in total (click, settle, click, settle), not five,
  assert.equal(tabs.scriptCalls.length, 4);

  // ... and it leaves no timer behind: only the second click's window is pending.
  assert.deepStrictEqual(clock.pendingDelays(), [CLICK_FALLBACK_MS]);

  // WHEN the second window is over,
  assert.equal(clock.runNext(), CLICK_FALLBACK_MS);
  await settleAsyncWork();

  // THEN the second answers with its page, after exactly one read of its own.
  assert.equal(responsesById(socket).get(3).ok, true);
  assert.equal(tabs.scriptCalls.length, 5);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("click_inTwoDifferentTabs_shouldBothAnswerAndNeitherBeSuperseded", async () => {
  // GIVEN two agent tabs with a clickable page in both, and a click in tab 501 that
  // has clicked and settled and is waiting out its fallback 300 ms:
  const page = createClickPage();
  const tabs = createClickTabs({ page, tabs: createTwoAgentTabs({ status: "complete" }) });
  const started = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });
  const { socket, clock } = started;
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR, tab: 501 });
  assert.deepStrictEqual(clock.pendingDelays(), [CLICK_FALLBACK_MS]);

  // WHEN a second click arrives in the *other* tab,
  await sendClick(socket, 3, { selector: DEFAULT_CLICK_SELECTOR, tab: 500 });

  // THEN the first is untouched — a click in another tab is not in its way — and
  // both windows are armed side by side:
  assert.equal(
    responsesById(socket).has(2),
    false,
    "a click in another tab must not answer the first one",
  );
  assert.deepStrictEqual(clock.pendingDelays(), [CLICK_FALLBACK_MS, CLICK_FALLBACK_MS]);
  assert.equal(tabs.scriptCalls.length, 4, "two clicks and their two settle waits");

  // WHEN both windows are over,
  assert.equal(clock.runNext(), CLICK_FALLBACK_MS);
  await settleAsyncWork();
  assert.equal(clock.runNext(), CLICK_FALLBACK_MS);
  await settleAsyncWork();

  // THEN both answer `ok` with their own tab — six injections (click, settle and read
  // per tab) and no `superseded` on either:
  const first = responsesById(socket).get(2);
  const second = responsesById(socket).get(3);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal("error" in first, false, "the first click must not be superseded");
  assert.equal("error" in second, false, "the second click must not be superseded");
  assert.equal(first.result.tabId, 501);
  assert.equal(second.result.tabId, 500);
  assert.equal(tabs.scriptCalls.length, 6);
  assert.deepStrictEqual(clock.pendingDelays(), []);

  // ... and the slot map ends empty: one slot per tab, and each one released.
  assert.deepStrictEqual(slotMapKeys(started), [[]]);
});

test("click_duringARunningNavigation_shouldAnswerOkAndLetTheNavigationAnswerCompleteFalse", async () => {
  // GIVEN a navigation that is still waiting for its page:
  const page = createClickPage();
  const tabs = createClickTabs({ page });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  await sendNavigate(socket, 2, { url: "https://first.example/" });
  assert.deepStrictEqual(clock.pendingDelays(), [NAVIGATE_TIMEOUT_MS]);

  // WHEN a click arrives — it changes the page too, so it takes the slot over,
  await sendClick(socket, 3, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN the navigation answers `complete: false` with its own URL — no settle, so
  // the honest pair of a wait that never got a page — and its 8 s timer is gone,
  // because the newcomer wins,
  assert.deepStrictEqual(responsesById(socket).get(2).result, {
    tabId: 500,
    windowId: 1,
    url: "https://first.example/",
    title: "",
    complete: false,
    settled: false,
    waitedMs: 0,
  });

  // THEN the click waits for nothing either: our own navigation left the tab
  // `loading`, and a tab that reported loading before the click is not waited for —
  // no settle wait and no 300 ms window, so the answer is already there.
  assert.deepStrictEqual(clock.pendingDelays(), [], "a loading tab must not start a wait");
  assert.equal(responsesById(socket).has(3), true, "the click must answer without the clock");
  const answer = responsesById(socket).get(3);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.url, DEFAULT_CLICK_PAGE.url);
  assert.equal(answer.result.clicked, "a#video-title-link");
  // ... and it says honestly that no quiet was observed.
  assert.deepStrictEqual(
    { settled: answer.result.settled, waitedMs: answer.result.waitedMs },
    NO_SETTLE_RESULT,
  );
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("click_whenANavigationArrivesDuringTheWait_shouldAnswerSupersededAndLeaveTheNavigationWaiting", async () => {
  // GIVEN a click that has settled and is waiting out its fallback 300 ms:
  const page = createClickPage();
  const tabs = createClickTabs({ page });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });
  assert.deepStrictEqual(clock.pendingDelays(), [CLICK_FALLBACK_MS]);
  assert.equal(tabs.scriptCalls.length, 2);

  // WHEN a navigation arrives — it changes the page, so it takes the slot over,
  await sendNavigate(socket, 3, { url: "https://next.example/" });

  // THEN the click answers `superseded` and reads nothing more: the page will be
  // the navigation's, and reading it here would answer a replaced request,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "superseded");
  assert.equal(tabs.scriptCalls.length, 2);

  // ... and only the navigation's own 8 s timer is left — the click took its 300 ms
  // window with it.
  assert.deepStrictEqual(clock.pendingDelays(), [NAVIGATE_TIMEOUT_MS]);
});

test("click_whenItsTabIsClosedDuringTheWait_shouldAnswerSupersededAndLeaveNoSlot", async () => {
  // GIVEN two agent tabs and a click in tab 500 that has clicked and settled and is
  // waiting out its fallback 300 ms — the *wait*, deliberately: a call still inside
  // its click injection cannot be cancelled by the slot and would answer with that
  // injection's error instead:
  const page = createClickPage();
  const tabs = createClickTabs({ page, tabs: createTwoAgentTabs({ status: "complete" }) });
  const started = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });
  const { socket, clock } = started;
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR, tab: 500 });
  assert.deepStrictEqual(clock.pendingDelays(), [CLICK_FALLBACK_MS]);
  assert.equal(tabs.scriptCalls.length, 2, "the click and its settle — the read is still to come");

  // WHEN `close_tab` names that very tab while the click is waiting,
  await sendCloseTab(socket, 3, { tab: 500 });

  // THEN the tab is gone, so superseding its slot ends the wait and answers the
  // caller `superseded` instead of letting it read a page that no longer exists,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "superseded");

  // ... the read injection never happens,
  assert.equal(tabs.scriptCalls.length, 2, "no read into the closed tab");

  // ... no timer stays behind,
  assert.deepStrictEqual(clock.pendingDelays(), []);

  // ... and the slot is gone with the tab it belonged to.
  assert.deepStrictEqual(slotMapKeys(started), [[]]);
});

/* ------------------------------------------------------ click: frame (spec 26) */

/** The address of the widget iframe every framed click and typing case addresses. */
const WIDGET_FRAME_URL = "https://widget.example.net/kalender";

/**
 * The two realms of a click with `frame`: the main frame with its own link for the tested
 * selector, and the widget iframe with another one.
 *
 * Both frames carry an element for the same selector on purpose — that is what makes "the
 * filter is the first statement" provable: only the addressed frame may click, and the main
 * frame's link has to keep `clicks === 0`.
 *
 * `onWidgetClick` runs inside the widget's `click()` and receives the widget page. That is
 * the one hook a case needs to simulate the realistic way a click loses its frame: the
 * handler rewrites the frame's own address, so the wait that follows matches nothing.
 */
function createFramedClickPages({ onWidgetClick = () => {} } = {}) {
  // The holder exists because the handler needs the page and the page needs the element:
  // one of the two has to be reachable through a name that is filled in later.
  const widget = {};
  const widgetLink = createClickElement({ id: "termin-waehlen", onClick: () => onWidgetClick(widget.page) });
  const mainLink = createClickElement({ id: "video-title-link" });
  const mainPage = createClickPage({ element: mainLink });
  const widgetPage = {
    ...createClickPage({ element: widgetLink }),
    url: WIDGET_FRAME_URL,
    title: "Kalender",
    innerText: "Text des Widget-Rahmens",
    // A realm inside an iframe: `window.top` is another object, and the snippet's
    // `location.href` — what the filter really reads — is the widget's address.
    inFrame: true,
  };
  widget.page = widgetPage;
  return { mainLink, widgetLink, mainPage, widgetPage };
}

/** A click across the two realms of `createFramedClickPages`. */
function createFramedClickTabs(pages) {
  return createFramedPageAgentTabs([pages.mainPage, pages.widgetPage]);
}

test("click_withFrame_shouldClickInTheAddressedFrameAndLeaveTheMainFrameUntouched", async () => {
  // GIVEN a page whose main frame and widget iframe both carry a link for the same
  // selector,
  const pages = createFramedClickPages();
  const tabs = createFramedClickTabs(pages);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge clicks through the widget's address,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR, frame: "widget" });

  // THEN exactly the widget's link was clicked, and described as *itself* rather than as
  // the lookalike in the main frame,
  assert.equal(pages.widgetLink.clicks, 1, "the addressed frame must be clicked once");
  assert.equal(responsesById(socket).get(2).result.clicked, "a#termin-waehlen");

  // ... and the main frame's link saw nothing at all: the filter answered before the
  // query, so there was nothing there to click.
  assert.equal(pages.mainLink.clicks, 0, "the unaddressed frame must not be clicked");
});

test("click_withFrame_shouldWaitAndReadTheAddressedFrameAndArmNoFallback", async () => {
  // GIVEN the same two realms; the wait really runs, so every frame has its own clock,
  const pages = createFramedClickPages();
  const tabs = createFramedClickTabs(pages);
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge clicks through the widget's address,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR, frame: "widget" });

  // THEN all three ops — click, wait, page state — went to every frame, with `frameIds`
  // out of the target and the filter in every call:
  assert.equal(tabs.scriptCalls.length, 3);
  for (const call of tabs.scriptCalls) {
    assert.equal(call.details.target.allFrames, true, "a click with `frame` must address every frame");
    assert.equal(
      call.details.target.frameIds,
      undefined,
      "`allFrames` and `frameIds` exclude each other",
    );
  }
  assert.deepStrictEqual(tabs.channel.ops(), ["click", "settle", "read"], "the order is click, wait, page state");
  for (const call of tabs.channel.calls) {
    assert.equal(call.message.args.want, "widget", "every op must carry the frame filter");
  }

  // ... the answer carries the addressed frame's state and that frame's wait pair, not the
  // main frame's silence,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(inThisRealm(answer.result), {
    tabId: 500,
    url: WIDGET_FRAME_URL,
    title: "Kalender",
    clicked: "a#termin-waehlen",
    scrolled: false,
    text: "Text des Widget-Rahmens",
    truncated: false,
    via: "innerText",
    settled: true,
    waitedMs: QUIET_WINDOW_MS,
  });

  // ... and the 300 ms fallback was never armed: the wait answered, so nothing of the old
  // fixed window may sit there — and no frame kept a deadline either.
  assertNoTimerLeft(clock, tabs.channel.pageClocks());
});

test("click_onAnElementOutsideTheFrameViewport_shouldAnswerOffscreenAndNotClick", async () => {
  // GIVEN a widget iframe whose link sits outside the visible area and stays there after
  // the scroll. What this case proves is that the rule runs in the addressed frame: the
  // frame's own snippet scrolls and refuses, and the main frame is never touched (spec
  // 56, `## Ziel`, 5). It cannot show that the rule measures against the frame's window
  // rather than the main frame's — the harness gives every realm 1024 × 768, so both
  // windows are the same number (spec 56, `## Bekannte Lücken`):
  const widgetLink = createClickElement({
    id: "termin-waehlen",
    rect: { x: -9966, y: 385, width: 351, height: 41 },
    scrollBringsIntoView: false,
  });
  const widgetPage = {
    ...createClickPage({ element: widgetLink }),
    url: WIDGET_FRAME_URL,
    title: "Kalender",
    innerText: "Text des Widget-Rahmens",
    inFrame: true,
  };
  const mainLink = createClickElement({ id: "video-title-link" });
  const mainPage = createClickPage({ element: mainLink });
  const tabs = createFramedPageAgentTabs([mainPage, widgetPage]);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge clicks through the widget's address,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR, frame: "widget" });

  // THEN the addressed frame answers the fourth refusal reason, after its own scroll,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "offscreen_after_scroll");
  assert.equal(widgetLink.scrolls, 1, "the addressed frame must scroll before it refuses");

  // ... and neither frame was clicked: the refusal answers before the second injection,
  // so the main frame's lookalike was never reached either.
  assert.equal(widgetLink.clicks, 0, "an unreachable target must not be clicked");
  assert.equal(mainLink.clicks, 0, "the unaddressed frame must not be clicked");
  assert.equal(tabs.scriptCalls.length, 1);
});

test("click_whenTheAddressedFrameIsGoneBeforeTheWait_shouldAnswerFrameNotFoundInsteadOfNoSettle", async () => {
  // GIVEN a widget whose click handler rewrites the frame's own address — the frame the
  // caller addressed is not the frame the wait will find,
  const pages = createFramedClickPages({
    onWidgetClick: (widgetPage) => {
      widgetPage.url = "https://widget.example.net/anderswo";
    },
  });
  const tabs = createFramedClickTabs(pages);
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge clicks through the address the frame had,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR, frame: "kalender" });

  // THEN the click itself happened — a click that loses its frame still clicked,
  assert.equal(pages.widgetLink.clicks, 1);

  // ... and the call stopped after the wait: no page state was read for a frame nobody
  // found. Pinned first, so a miscounted injection fails with this one sentence instead
  // of a `TypeError` on the response below.
  assert.equal(tabs.scriptCalls.length, 2);

  // ... and the wait's verdict *is* the answer: every frame answered `not_the_frame`, so
  // the filter's `frame_not_found` arrives as itself. A swallowed one would come back 300 ms
  // later as an `ok` answer reporting `NO_SETTLE`, and a missing `FrameError` branch would
  // have named it `click_failed`,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false, "a swallowed FrameError would answer ok with NO_SETTLE");
  assert.equal(answer.error.code, "frame_not_found");
  assert.notEqual(answer.error.code, "click_failed");
  assert.equal(answer.error.frames, 2, "both frames answered, none matched");
  assert.equal(answer.error.message, "No frame matches the given frame.");

  // ... no fallback was armed behind it, and the 4 s guard is gone with it.
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("click_withAFrameThatMatchesTwoFrames_shouldAnswerFrameAmbiguousWithBothCandidates", async () => {
  // GIVEN two realms whose addresses both carry the substring — the main frame's address
  // rewritten onto the widget's host, so both frames answer as hits,
  const pages = createFramedClickPages();
  pages.mainPage.url = "https://widget.example.net/startseite";
  const tabs = createFramedClickTabs(pages);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge clicks through that substring,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR, frame: "widget" });

  // THEN the call is refused with both addresses, so the caller learns how to answer more
  // precisely — a click answer without a `href` would leave two `null`s here, i.e. an
  // error asking the caller to address "no frame" more precisely,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "frame_ambiguous");
  assert.equal(answer.error.message, "Several frames match the given frame.");
  assert.deepStrictEqual(inThisRealm(answer.error.candidates), [
    "https://widget.example.net/startseite",
    WIDGET_FRAME_URL,
  ]);
  assert.equal(answer.result, undefined);
});

test("click_withoutFrame_shouldAddressTheMainFrameOnly", async () => {
  // GIVEN the same two realms and a click that names no frame — the call every earlier
  // increment makes,
  const pages = createFramedClickPages();
  const tabs = createFramedClickTabs(pages);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge clicks the same selector,
  await sendClick(socket, 2, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN the three ops kept their order — `[0]` click, `[1]` wait, `[2]` page state — and
  // every one of them addressed the main frame: `frameIds: [0]`, no `allFrames`,
  assert.deepStrictEqual(tabs.channel.ops(), ["click", "settle", "read"]);
  for (const call of tabs.scriptCalls) {
    assert.deepStrictEqual(
      call.details.target.frameIds,
      [0],
      "a click without `frame` addresses the main frame",
    );
    assert.equal(call.details.target.allFrames, undefined, "and asks for exactly one frame");
  }

  // ... so the main frame's link was the one clicked, its state is the answer, and the
  // widget never heard of the call.
  assert.equal(pages.mainLink.clicks, 1);
  assert.equal(pages.widgetLink.clicks, 0);
  const answer = responsesById(socket).get(2);
  assert.equal(answer.result.url, DEFAULT_CLICK_PAGE.url);
  assert.equal(answer.result.clicked, "a#video-title-link");
  assert.equal(answer.result.settled, true);

  // ... and the page state carried no filter: a main-frame call sends `want: null`, which
  // the page reads as "the main frame" without comparing an address.
  assert.equal(tabs.channel.calls[2].message.args.want, null);
  assert.equal(tabs.channel.calls[2].message.args.offset, 0);
  assert.equal(tabs.channel.calls[2].message.args.maxChars, TEXT_LIMIT);
});

/* ------------------------------------------------------------------- type */

const TYPE_WAIT_MS = 300;
const DEFAULT_TYPE_SELECTOR = 'input[name="q"]';
// Invented values only. No real typed text belongs in this repository, and a real
// password in a fixture would be worse than one in a log line.
const DEFAULT_TYPE_TEXT = "erfundener-testwert";
const PASSWORD_TEXT = "geheim-testwert";

/** The invented page for one typing case — the read fixture plus one field. */
function createTypePage({ element, ...overrides } = {}) {
  return {
    ...DEFAULT_READ_PAGE,
    elements: { [DEFAULT_TYPE_SELECTOR]: element ?? createTypeElement({ id: "q" }) },
    ...overrides,
  };
}

/**
 * One writable field of the invented page.
 *
 * Built like `createClickElement`, plus what a field has that a link has not, and
 * shaped like a field a framework has taken over: the element carries its own
 * `value` accessor on top of the prototype's. A plain `element.value = …` lands in
 * that own accessor and counts as `plainSets`; only the prototype setter counts as
 * `nativeSets` — which is what pins the snippet to the path a framework notices.
 * Reading `element.value` gives what the field *shows*, which is the question the
 * catch-up write asks after the page had its turn.
 *
 * `events` records what reached the field — and the `focus()` call, which is not an
 * event but has to be ordered against them. A refused field can therefore prove it
 * stayed untouched instead of merely answering the right code.
 *
 * `onBeforeInput`, `onInput` and `onKeydown` are the page's own handlers: the first
 * can refuse the announced input, the second simulates a re-render, the third
 * cancels the Enter the way a page with its own submit handler does.
 */
function createTypeElement({
  tagName = "INPUT",
  id = "",
  className = "",
  attributes = {},
  rect = { width: 120, height: 24 },
  display,
  visibility,
  disabled = false,
  readOnly = false,
  type = "text",
  isContentEditable = false,
  value = "",
  textContent = "",
  form = null,
  onBeforeInput = null,
  onInput = null,
  onKeydown = null,
} = {}) {
  const element = {
    tagName,
    id,
    className,
    disabled,
    readOnly,
    type,
    isContentEditable,
    display,
    visibility,
    _value: value,
    nativeSets: 0,
    plainSets: 0,
    textContent,
    form,
    events: [],
    focusCalls: 0,
    focus() {
      element.focusCalls += 1;
      element.events.push("focus");
    },
    getBoundingClientRect: () => ({ ...rect }),
    getAttribute: (name) => attributes[name] ?? null,
    dispatchEvent(event) {
      element.events.push(event.type);
      if (event.type === "beforeinput" && onBeforeInput !== null) onBeforeInput(event);
      if (event.type === "input" && onInput !== null) onInput(event);
      if (event.type === "keydown" && onKeydown !== null) onKeydown(event);
      // A browser answers `false` when a listener called `preventDefault`, and that
      // answer is the only signal the snippet has.
      return event.defaultPrevented !== true;
    },
  };
  // The own accessor is the whole point of this stub: the prototype's `value` is
  // shadowed here, so a write that bypasses the setter is visible as `plainSets`
  // instead of hiding inside the same store.
  Object.defineProperty(element, "value", {
    configurable: true,
    get() {
      return element._value;
    },
    set(written) {
      element._value = written;
      element.plainSets += 1;
    },
  });
  return element;
}

/** A `<form>` with the one method the snippet may call, and a counter for it. */
function createFormStub() {
  const form = {
    requestSubmitCalls: 0,
    requestSubmit() {
      form.requestSubmitCalls += 1;
    },
  };
  return form;
}

/**
 * A `<form>` whose `requestSubmit` throws, counting the attempt.
 *
 * A page is free to overwrite that method — a polyfill, a framework wrapper, a
 * deliberate obstacle. The snippet wrote and pressed Enter before it got here, so
 * the throw must not escape into `not_readable`.
 */
function createThrowingFormStub() {
  const form = {
    requestSubmitCalls: 0,
    requestSubmit() {
      form.requestSubmitCalls += 1;
      throw new Error("requestSubmit is not what you think it is");
    },
  };
  return form;
}

/** The typing path with an injection that runs the real snippets against `page`. */
function createTypeTabs({ page = createTypePage(), tabs = [createAgentTabFixture()], answer, pageAgent } = {}) {
  return createTabsStub({
    tabs,
    pageAgent: pageAgent ?? { frames: [{ href: page.url, page }], answer },
  });
}

/** Sends one `type` request and lets the bridge page work through it. */
async function sendType(socket, id, params) {
  socket.receive({ type: "request", id, method: "type", params });
  await settleAsyncWork();
}

/**
 * A field that has to be refused before anything is written.
 *
 * The refusals differ only in the element, so they share the assertions that must
 * hold whatever the reason was: one injection, no write, no event, no 300 ms
 * window, and the refused code in the answer.
 */
async function answerForRefusedField(element, expectedCode) {
  const tabs = createTypeTabs({ page: createTypePage({ element }) });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });

  assert.equal(element.nativeSets, 0, "a refused field must not be written to");
  assert.deepStrictEqual(element.events, [], "a refused field must see no event");
  assert.equal(tabs.scriptCalls.length, 1, "no second injection after a refusal");
  assert.deepStrictEqual(clock.pendingDelays(), [], "a refusal opens no window");

  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, expectedCode);
  return answer;
}

/**
 * One `type` against a page built around `element`, and the answer that came back.
 *
 * Only for the cases that really type: every rejection happens before the window,
 * and `clock.runNext()` would fail on a timer that was never armed.
 */
async function answerForTypedField(element, { params, settings = {}, page: pageOverrides } = {}) {
  const page = createTypePage({ element, ...pageOverrides });
  const tabs = createTypeTabs({ page });
  const { socket, clock } = await connectedBackground({
    tabs,
    settings: { ...STORED_TAB_SETTINGS, ...settings },
  });
  await sendType(socket, 2, params ?? { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });
  clock.runNext();
  await settleAsyncWork();
  return responsesById(socket).get(2);
}

test("type_withoutAStoredAgentTab_shouldAnswerNoAgentTabAndInjectNothing", async () => {
  // GIVEN a connected extension that has never navigated, although the operator's
  // window has a tab:
  const tabs = createTabsStub({ tabs: [createAgentTabFixture()] });
  const { socket } = await connectedBackground({ tabs });

  // WHEN the bridge asks to type somewhere,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });

  // THEN it is the same refusal as `read` and `click`, and no page was touched:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "no_agent_tab");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("type_withTab_shouldTypeIntoThatTab", async () => {
  // GIVEN two agent tabs, 500 the last used one and 501 the one the request names,
  const tabs = createTypeTabs({ tabs: createTwoAgentTabs() });
  const { socket, clock } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge types into tab 501 by name,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT, tab: 501 });
  clock.runNext();
  await settleAsyncWork();

  // THEN the typing snippet and the read behind it both ran in that tab:
  assert.equal(tabs.scriptCalls[0].tabId, 501);
  assert.equal(tabs.scriptCalls.every((call) => call.tabId === 501), true);
  assert.equal(responsesById(socket).get(2).result.tabId, 501);
});

test("type_withoutASelector_shouldAnswerInvalidParamsAndInjectNothing", async () => {
  // GIVEN a stored agent tab and a page that could be typed into:
  const tabs = createTypeTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the request carries no selector at all,
  await sendType(socket, 2, { text: DEFAULT_TYPE_TEXT });

  // THEN it is a parameter mistake of the caller, decided before any injection:
  assert.equal(responsesById(socket).get(2).error.code, "invalid_params");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("type_withoutAText_shouldAnswerInvalidParamsAndInjectNothing", async () => {
  // GIVEN a stored agent tab and a page that could be typed into:
  const tabs = createTypeTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the text is missing — an empty string would be legal and means "clear",
  // a missing one does not:
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR });

  // THEN nothing is injected: a field cleared by accident is still a change on the
  // operator's page:
  assert.equal(responsesById(socket).get(2).error.code, "invalid_params");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("type_withASubmitThatIsNotABoolean_shouldAnswerInvalidParamsAndInjectNothing", async () => {
  // GIVEN a stored agent tab and a page that could be typed into:
  const tabs = createTypeTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN `submit` arrives as the string a sloppy caller sends:
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT, submit: "true" });

  // THEN it is refused here: a truthy string must never become an Enter press that
  // submits a form on the operator's page:
  assert.equal(responsesById(socket).get(2).error.code, "invalid_params");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("type_withASelectorThePageCannotParse_shouldAnswerInvalidSelectorAndWriteNothing", async () => {
  // GIVEN a page whose `querySelector` refuses the selector, as a real one does:
  const element = createTypeElement({ id: "q" });
  const page = createTypePage({ element, unparseableSelectors: [DEFAULT_TYPE_SELECTOR] });
  const tabs = createTypeTabs({ page });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to type into it,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });

  // THEN the answer names the selector as the problem, and the field is untouched:
  assert.equal(responsesById(socket).get(2).error.code, "invalid_selector");
  assert.equal(element.nativeSets, 0);
  assert.deepStrictEqual(element.events, []);
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("type_withASelectorThatMatchesNothing_shouldAnswerNoMatchAndWriteNothing", async () => {
  // GIVEN a page whose only field sits under a different selector:
  const element = createTypeElement({ id: "q" });
  const tabs = createTypeTabs({ page: createTypePage({ element }) });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for a field nobody has,
  await sendType(socket, 2, { selector: 'input[name="not-there"]', text: DEFAULT_TYPE_TEXT });

  // THEN it is `no_match` — not an error of the page — and the field that did exist
  // was not touched:
  assert.equal(responsesById(socket).get(2).error.code, "no_match");
  assert.equal(element.nativeSets, 0);
  assert.deepStrictEqual(element.events, []);
});

test("type_whenTheInjectedResultCarriesNoKnownOutcome_shouldAnswerTypeFailed", async () => {
  // GIVEN an injection that answers something the protocol does not know:
  const page = createTypePage();
  const tabs = createTypeTabs({ page, answer: () => ({ value: { outcome: "confused" } }) });
  const { socket, clock, consoleLines } = await connectedBackground({
    tabs,
    settings: STORED_TAB_SETTINGS,
  });

  // WHEN the bridge asks to type,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });

  // THEN it is our own bug and worth a warning — an unknown outcome is not a
  // refusal of the page:
  assert.equal(responsesById(socket).get(2).error.code, "type_failed");
  assert.ok(
    consoleLines.some((line) => line.includes("type result without a known outcome")),
    "an unusable result must be reported",
  );
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("type_onADiv_shouldAnswerNotTypeableAndWriteNothing", async () => {
  // GIVEN an element that is on screen but no field at all,
  // WHEN we try to type into it,
  const answer = await answerForRefusedField(createTypeElement({ tagName: "DIV" }), "not_typeable");

  // THEN the missing positive list would have let the setter write into it,
  // and the sentence names both halves of the refusal:
  assert.equal(answer.error.message, "The element is not a writable field or is disabled.");
});

test("type_onADisabledField_shouldAnswerNotTypeableAndWriteNothing", async () => {
  // GIVEN a field the page itself refuses to accept input in,
  // WHEN we try to type into it,
  // THEN it is `not_typeable` like every other unwritable field:
  await answerForRefusedField(createTypeElement({ id: "q", disabled: true }), "not_typeable");
});

test("type_onAReadOnlyField_shouldAnswerNotTypeableAndWriteNothing", async () => {
  // GIVEN a field that shows a value but takes none,
  // WHEN we try to type into it,
  // THEN it is refused before the setter runs:
  await answerForRefusedField(createTypeElement({ id: "q", readOnly: true }), "not_typeable");
});

test("type_onAHiddenField_shouldAnswerNotTypeableAndWriteNothing", async () => {
  // GIVEN a field a form keeps but nobody sees,
  // WHEN we try to type into it,
  // THEN `hidden` is not on the positive list of typeable `type` values:
  await answerForRefusedField(createTypeElement({ id: "q", type: "hidden" }), "not_typeable");
});

test("type_onAFileField_shouldAnswerNotTypeableAndWriteNothing", async () => {
  // GIVEN a file picker — the one input whose value the browser owns:
  const element = createTypeElement({ id: "q", type: "file" });

  // WHEN we try to type into it,
  // THEN it is `not_typeable` and not `read_failed`: without the check the setter
  // would throw inside the page and the answer would name the wrong problem:
  await answerForRefusedField(element, "not_typeable");
});

test("type_onACheckbox_shouldAnswerNotTypeableAndWriteNothing", async () => {
  // GIVEN a checkbox, which the non-goals of the spec put outside this increment,
  // WHEN we try to type into it,
  // THEN the positive list of `type` values refuses it — with a setter and without
  // one, this would otherwise answer "typed" for a tick nobody set:
  await answerForRefusedField(createTypeElement({ id: "q", type: "checkbox" }), "not_typeable");
});

test("type_onARadioButton_shouldAnswerNotTypeableAndWriteNothing", async () => {
  // GIVEN a radio button,
  // WHEN we try to type into it,
  // THEN it is refused like the checkbox:
  await answerForRefusedField(createTypeElement({ id: "q", type: "radio" }), "not_typeable");
});

test("type_onARangeSlider_shouldAnswerNotTypeableAndWriteNothing", async () => {
  // GIVEN a slider, whose value is a number on a scale and no text,
  // WHEN we try to type into it,
  // THEN it is refused as well:
  await answerForRefusedField(createTypeElement({ id: "q", type: "range" }), "not_typeable");
});

test("type_onAFieldWithDisplayNone_shouldAnswerNotTypeableAndWriteNothing", async () => {
  // GIVEN a laid-out field that the stylesheet hides,
  // WHEN we try to type into it,
  // THEN the visibility check is part of `isTypeable`; without it the setter would
  // fill a field nobody can see and report success:
  await answerForRefusedField(createTypeElement({ id: "q", display: "none" }), "not_typeable");
});

test("type_onAPasswordFieldWhileTheOptionIsOff_shouldAnswerPasswordNotAllowedAndTouchNothing", async () => {
  // GIVEN a password field and the default of the option — no key in storage at all,
  // WHEN the bridge asks to type the text into it,
  const element = createTypeElement({ id: "passwort", type: "password" });
  const tabs = createTypeTabs({ page: createTypePage({ element }) });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: PASSWORD_TEXT });

  // THEN nothing happens to the field — no write, no focus, no event — and the
  // sentence says where the switch is:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "password_not_allowed");
  assert.equal(
    answer.error.message,
    "Password fields are locked. Unlock them in the extension options.",
  );
  assert.equal(element.nativeSets, 0);
  assert.deepStrictEqual(element.events, []);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("type_onAPasswordFieldWhileTheOptionIsOn_shouldWriteItAndDescribeTheField", async () => {
  // GIVEN the operator has unlocked password fields in the options,
  // WHEN we type into the field,
  const element = createTypeElement({ id: "passwort", type: "password" });
  const answer = await answerForTypedField(element, { settings: { allowPasswordFields: true } });

  // THEN it is an ordinary field — and the answer still names only the element,
  // never the text that went into it:
  assert.equal(answer.ok, true);
  assert.equal(answer.result.typed, "input#passwort");
  assert.equal(element.nativeSets, 1);
  assert.equal(element._value, DEFAULT_TYPE_TEXT);
});

test("type_withAllowPasswordFieldsSwitchedBetweenTwoCalls_shouldReadTheOptionEveryTime", async () => {
  // GIVEN a password field and an extension that has just refused it,
  const element = createTypeElement({ id: "passwort", type: "password" });
  const tabs = createTypeTabs({ page: createTypePage({ element }) });
  const { socket, browser, clock } = await connectedBackground({
    tabs,
    settings: STORED_TAB_SETTINGS,
  });
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: PASSWORD_TEXT });
  assert.equal(responsesById(socket).get(2).error.code, "password_not_allowed");

  // WHEN the operator flips the option without reloading the extension,
  await browser.storage.local.set({ allowPasswordFields: true });
  await sendType(socket, 3, { selector: DEFAULT_TYPE_SELECTOR, text: PASSWORD_TEXT });
  clock.runNext();
  await settleAsyncWork();

  // THEN the very next call types: the option is read per call, not once at
  // startup — caching it would make the switch need a reload nobody expects:
  const answer = responsesById(socket).get(3);
  assert.equal(answer.ok, true);
  assert.equal(element._value, PASSWORD_TEXT);
});

test("type_withAllowPasswordFieldsSetToFalseOrATruthyString_shouldKeepPasswordFieldsLocked", async () => {
  // GIVEN a stored `false` and the `"true"` a hand-edited storage may hold,
  for (const stored of [false, "true"]) {
    // WHEN a password field is the target,
    const element = createTypeElement({ id: "passwort", type: "password" });
    const tabs = createTypeTabs({ page: createTypePage({ element }) });
    const { socket } = await connectedBackground({
      tabs,
      settings: { ...STORED_TAB_SETTINGS, allowPasswordFields: stored },
    });
    await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: PASSWORD_TEXT });

    // THEN only the boolean `true` unlocks it: a truthy string is not a decision
    // the operator made in the checkbox:
    assert.equal(
      responsesById(socket).get(2).error.code,
      "password_not_allowed",
      `allowPasswordFields: ${JSON.stringify(stored)} must stay locked`,
    );
    assert.equal(element.nativeSets, 0);
  }
});

test("type_whenTheStorageReadFails_shouldTreatPasswordFieldsAsLockedAndWarn", async () => {
  // GIVEN a `storage.local` that refuses to hand out the option — an unreadable
  // answer must never be the permissive one,
  const element = createTypeElement({ id: "passwort", type: "password" });
  const tabs = createTypeTabs({ page: createTypePage({ element }) });
  const { socket, consoleLines } = await connectedBackground({
    tabs,
    settings: STORED_TAB_SETTINGS,
    storageReadFailsFor: ["allowPasswordFields"],
  });

  // WHEN we try to type into a password field,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: PASSWORD_TEXT });

  // THEN it is locked, the field is untouched, and the operator's console says why:
  assert.equal(responsesById(socket).get(2).error.code, "password_not_allowed");
  assert.equal(element.nativeSets, 0);
  assert.deepStrictEqual(element.events, []);
  assert.ok(
    consoleLines.some((line) => line.startsWith("warn:") && line.includes("Passwort-Option")),
    "the failed option read must be reported once",
  );
});

test("type_onAnInputField_shouldWriteThroughTheNativeSetterAndFireInputAndChange", async () => {
  // GIVEN a field a framework has taken over — it carries its own `value` accessor
  // on top of the prototype's — and a starting value of its own,
  const element = createTypeElement({ id: "q", value: "vorher-eingetragen" });

  // WHEN we type into it,
  const answer = await answerForTypedField(element);

  // THEN the value went *through* the prototype setter exactly once — `nativeSets`
  // is the proof a plain `element.value = …` would fail, and it is a plain write the
  // own accessor would have counted instead:
  assert.equal(answer.ok, true);
  assert.equal(element.nativeSets, 1);
  assert.equal(element.plainSets, 0, "a bypass around the prototype setter must not happen");
  assert.equal(element._value, DEFAULT_TYPE_TEXT);
  // ... and the field was focused, the input announced, and both events a framework
  // listens to were dispatched — in that order:
  assert.deepStrictEqual(element.events, ["focus", "beforeinput", "input", "change"]);
  assert.equal(answer.result.typed, "input#q");
});

test("type_onATextarea_shouldWriteThroughItsOwnSetterAndFireInputAndChange", async () => {
  // GIVEN a textarea — its prototype is a different one, so the snippet has to pick
  // the right descriptor:
  const element = createTypeElement({ tagName: "TEXTAREA", id: "notiz", type: undefined });

  // WHEN we type into it,
  const answer = await answerForTypedField(element);

  // THEN the write arrived and the field is named as the textarea it is:
  assert.equal(answer.result.typed, "textarea#notiz");
  assert.equal(element.nativeSets, 1);
  assert.equal(element._value, DEFAULT_TYPE_TEXT);
  assert.deepStrictEqual(element.events, ["focus", "beforeinput", "input", "change"]);
});

test("type_onAContenteditableElement_shouldSetTheTextContentAndFireInput", async () => {
  // GIVEN an editable `div` — no value setter, so the snippet has to take the other
  // road:
  const element = createTypeElement({ tagName: "DIV", id: "editor", isContentEditable: true });

  // WHEN we type into it,
  const answer = await answerForTypedField(element);

  // THEN `textContent` carries the text and `input` was dispatched — `change` would
  // be a lie for a contenteditable, which has no such event:
  assert.equal(answer.result.typed, "div#editor");
  assert.equal(element.textContent, DEFAULT_TYPE_TEXT);
  assert.deepStrictEqual(element.events, ["focus", "beforeinput", "input"]);
  assert.equal(element.nativeSets, 0);
});

test("type_onAnUntouchedField_shouldFocusItAndAnnounceTheInputBeforeTheWrite", async () => {
  // GIVEN a field whose page listens for the announced input — the road some pages
  // take instead of `input`:
  const announced = [];
  const element = createTypeElement({ id: "q", onBeforeInput: (event) => announced.push(event) });

  // WHEN we type into it,
  const answer = await answerForTypedField(element);

  // THEN it was focused first, then the input was announced, then the value came and
  // the two events a framework listens to — the order is the whole point, because a
  // field without focus behaves differently and some pages refuse an unannounced
  // write:
  assert.equal(answer.ok, true);
  assert.equal(element.focusCalls, 1);
  assert.deepStrictEqual(element.events, ["focus", "beforeinput", "input", "change"]);
  assert.equal(announced.length, 1);
  assert.equal(announced[0].cancelable, true, "the page has to be able to say no to the input");
  assert.equal(announced[0].inputType, "insertText");
  assert.equal(announced[0].data, DEFAULT_TYPE_TEXT);
});

test("type_whenThePageWritesItsOwnEmptyStateBack_shouldSetTheValueAgainOnTheNextTask", async () => {
  // GIVEN a controlled field: the page keeps the value in its own state — still
  // empty, because nothing has reached the framework — and writes that state back
  // over the field in the `input` handler. That is the shape that made the real
  // search field show nothing while the submit carried the text. The write-back
  // happens once: a stub that repeated it would win the race forever, and the spec
  // pins one catch-up, not a fight.
  let writeBacks = 0;
  const element = createTypeElement({
    id: "q",
    onInput: () => {
      writeBacks += 1;
      if (writeBacks === 1) element.value = "";
    },
  });

  // WHEN we type into it,
  const answer = await answerForTypedField(element);

  // THEN the answer is the success it was, and the field shows the text anyway: the
  // catch-up in the next task saw the emptied value and wrote it a second time.
  // Without the catch-up the field would still be empty here.
  assert.equal(answer.ok, true);
  assert.equal(writeBacks, 2);
  assert.equal(element.value, DEFAULT_TYPE_TEXT);
  assert.equal(element.events.filter((type) => type === "input").length, 2);
  // ... and `change` stays the one commit of the write; a second one would tell the
  // page about a commit that never happened:
  assert.equal(element.events.filter((type) => type === "change").length, 1);
});

test("type_whenThePageAcceptsTheValue_shouldFireInputOnlyOnce", async () => {
  // GIVEN an ordinary field whose `input` handler leaves the value alone,
  const inputEvents = [];
  const element = createTypeElement({ id: "q", onInput: (event) => inputEvents.push(event) });

  // WHEN we type into it,
  const answer = await answerForTypedField(element);

  // THEN nothing is written a second time: one `input`, one `change`, no late event
  // that would restart the page's handlers for nothing:
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(element.events, ["focus", "beforeinput", "input", "change"]);
  assert.equal(element.nativeSets, 1);
  assert.equal(inputEvents.length, 1);
  assert.equal(inputEvents[0].inputType, "insertText");
  assert.equal(inputEvents[0].data, DEFAULT_TYPE_TEXT);
});

test("type_whenThePageCancelsTheBeforeinput_shouldAnswerNotTypeableAndWriteNothing", async () => {
  // GIVEN a field whose page refuses the announced input — a masked or
  // policy-protected field, say:
  const element = createTypeElement({ id: "q", onBeforeInput: (event) => event.preventDefault() });
  const tabs = createTypeTabs({ page: createTypePage({ element }) });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN we type into it,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });

  // THEN the answer is `not_typeable` — the page said no to the input — and the value
  // was not smuggled in behind its back: no setter call, no `input`, no `change`, no
  // window. The focus did happen, because it comes before the announcement.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "not_typeable");
  assert.equal(element.nativeSets, 0);
  assert.equal(element.value, "");
  assert.deepStrictEqual(element.events, ["focus", "beforeinput"]);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("type_withoutSubmit_shouldFireNoKeyEventAndAnswerSubmittedFalse", async () => {
  // GIVEN a field inside a form and no `submit` in the request,
  const form = createFormStub();
  const element = createTypeElement({ id: "q", form });

  // WHEN we type into it,
  const answer = await answerForTypedField(element);

  // THEN `submitted` is a boolean and false, nothing was pressed and no form was
  // submitted — typing is not sending:
  assert.equal(answer.result.submitted, false);
  assert.deepStrictEqual(element.events, ["focus", "beforeinput", "input", "change"]);
  assert.equal(form.requestSubmitCalls, 0);
});

test("type_withSubmitInsideAForm_shouldPressEnterAndRequestTheSubmitOnce", async () => {
  // GIVEN a field inside a form,
  const form = createFormStub();
  const element = createTypeElement({ id: "q", form });

  // WHEN we type with `submit: true`,
  const answer = await answerForTypedField(element, {
    params: { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT, submit: true },
  });

  // THEN exactly one Enter was pressed, in the three events a browser sends — and
  // `requestSubmit()` followed, because a synthetic Enter does not trigger the
  // implicit form submission on its own:
  assert.equal(answer.result.submitted, true);
  assert.deepStrictEqual(element.events, [
    "focus",
    "beforeinput",
    "input",
    "change",
    "keydown",
    "keypress",
    "keyup",
  ]);
  assert.equal(form.requestSubmitCalls, 1);
});

test("type_withSubmitOnAFieldWithoutAForm_shouldPressEnterAndRequestNoSubmit", async () => {
  // GIVEN a search field outside any form — the normal case in the wild,
  const element = createTypeElement({ id: "q" });

  // WHEN we type with `submit: true`,
  const answer = await answerForTypedField(element, {
    params: { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT, submit: true },
  });

  // THEN the Enter events are all that happens: `submitted: true` means "Enter was
  // pressed", not "the page reacted":
  assert.equal(answer.result.submitted, true);
  assert.deepStrictEqual(element.events, [
    "focus",
    "beforeinput",
    "input",
    "change",
    "keydown",
    "keypress",
    "keyup",
  ]);
});

test("type_withSubmitWhenThePageCancelsTheKeydown_shouldNotRequestASubmit", async () => {
  // GIVEN a page with its own handler that cancels the Enter — the shape that would
  // submit twice if we insisted:
  const form = createFormStub();
  const element = createTypeElement({
    id: "q",
    form,
    onKeydown: (event) => event.preventDefault(),
  });

  // WHEN we type with `submit: true`,
  const answer = await answerForTypedField(element, {
    params: { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT, submit: true },
  });

  // THEN all three Enter events were dispatched, but `requestSubmit()` stayed out of
  // it — a cancelled keydown is the page's answer, and a second submit on top of it
  // is exactly the double send this case pins:
  assert.equal(answer.result.submitted, true);
  assert.deepStrictEqual(element.events, [
    "focus",
    "beforeinput",
    "input",
    "change",
    "keydown",
    "keypress",
    "keyup",
  ]);
  assert.equal(form.requestSubmitCalls, 0);
});

test("type_withSubmitWhenRequestSubmitThrows_shouldStillAnswerOkAndSubmittedTrue", async () => {
  // GIVEN a page that replaced `requestSubmit` with something that throws,
  const form = createThrowingFormStub();
  const element = createTypeElement({ id: "q", form });

  // WHEN we type with `submit: true`,
  const answer = await answerForTypedField(element, {
    params: { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT, submit: true },
  });

  // THEN it is the success it was: the write arrived and Enter was pressed. A throw
  // in `requestSubmit` must not surface as `not_readable` — the operator would read
  // a failed *read* for a page that was just written to:
  assert.equal(answer.ok, true);
  assert.equal(answer.result.submitted, true);
  assert.equal(element._value, DEFAULT_TYPE_TEXT);
  assert.equal(form.requestSubmitCalls, 1);
});

test("type_withQuotesAndALineBreakInTheText_shouldDeliverItUnchanged", async () => {
  // GIVEN a text with the two characters that break a hand-built snippet — a double
  // quote and a line break:
  const text = 'mit "Anführung" und\nUmbruch';
  const element = createTypeElement({ id: "q" });

  // WHEN we type it,
  const answer = await answerForTypedField(element, {
    params: { selector: DEFAULT_TYPE_SELECTOR, text },
  });

  // THEN the value arrived unchanged: the request object is JSON-quoted into the
  // argument list, so neither character has to be escaped by hand:
  assert.equal(answer.ok, true);
  assert.equal(element._value, text);
});

test("type_withAnEmptyText_shouldClearTheFieldAndStillDescribeIt", async () => {
  // GIVEN a field that already holds something,
  const element = createTypeElement({ id: "q", value: "alter-wert" });

  // WHEN we type the empty string, which the spec allows on purpose,
  const answer = await answerForTypedField(element, {
    params: { selector: DEFAULT_TYPE_SELECTOR, text: "" },
  });

  // THEN the field is empty, the write went through the setter, and the answer still
  // names the field it emptied:
  assert.equal(answer.ok, true);
  assert.equal(element._value, "");
  assert.equal(element.nativeSets, 1);
  assert.equal(answer.result.typed, "input#q");
});

test("type_onAnInputWithoutAValueSetter_shouldAnswerTypeFailedWithoutFallingBack", async () => {
  // GIVEN a page realm whose input prototype carries no `value` accessor at all —
  // the negative case that a silent `element.value = …` fallback would hide:
  const element = createTypeElement({ id: "q" });
  const tabs = createTypeTabs({ page: createTypePage({ element, withoutValueSetter: true }) });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN we try to type into it,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });

  // THEN it is `type_failed` and nothing was written or dispatched: reporting success
  // for a write that never happened is the one thing this increment must not do —
  // and no window was opened, because there is nothing to wait for:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "type_failed");
  assert.equal(element.nativeSets, 0);
  assert.deepStrictEqual(element.events, []);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("type_whenAnInputHandlerDropsTheFieldsId_shouldStillDescribeItAsItWasBefore", async () => {
  // GIVEN a field whose `input` handler re-renders it away — `id` and `class` are
  // gone by the time the write returns, as a component re-render does:
  const element = createTypeElement({
    id: "q",
    className: "suchfeld",
    onInput: () => {
      element.id = "";
      element.className = "";
    },
  });

  // WHEN we type into it,
  const answer = await answerForTypedField(element);

  // THEN the answer still names it: the description is built before the write, so a
  // description built afterwards would read the bare tag here and pass every other
  // case:
  assert.equal(answer.result.typed, "input#q");
});

test("type_whenTheTabIsStillLoading_shouldAnswerPageBusy", async () => {
  // GIVEN a tab that is still loading and an injection Firefox refuses in that
  // moment:
  const tabs = createTypeTabs({
    tabs: [createAgentTabFixture({ status: "loading" })],
    pageAgent: { frames: [{ href: AGENT_URL, page: createTypePage() }], refuseInjection: true },
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to type into it too early,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });

  // THEN the answer is the same code `read` and `click` give: one decision, four
  // tools,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "page_busy");

  // ... the frame is the two-field one, and nothing waits out a window for a page
  // that was never written to.
  assert.equal("url" in answer.error, false);
  assert.equal("kind" in answer.error, false);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("type_whenThePageCannotBeReadAfterTyping_shouldPassNotReadableThrough", async () => {
  // GIVEN a page that takes the text and refuses injection afterwards — a search
  // that navigates into a PDF viewer, say:
  const page = createTypePage();
  const tabs = createTypeTabs({
    page,
    tabs: [createAgentTabFixture({ status: "complete" })],
    pageAgent: { frames: [{ href: page.url, page }], refuseInjectionAfter: 1 },
  });
  const { socket, clock, consoleLines } = await connectedBackground({
    tabs,
    settings: STORED_TAB_SETTINGS,
  });

  // WHEN we type and the window is over,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });
  clock.runNext();
  await settleAsyncWork();

  // THEN `not_readable` comes through unchanged instead of a catch-all
  // `type_failed`, and the page's refusal is not our bug:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "not_readable");
  assert.ok(
    !consoleLines.some((line) => line.includes("type result without a known outcome")),
    "a refusal of the page is not a warning of ours",
  );
});

test("type_whenThePageCannotBeReadAfterTyping_shouldCarryTheAddressAndKindOfTheTab", async () => {
  // GIVEN a page that takes the text and refuses injection afterwards, in a tab standing
  // on the browser's own settings page:
  const page = createTypePage();
  const tabs = createTypeTabs({
    page,
    tabs: [createAgentTabFixture({ url: "about:config", status: "complete" })],
    pageAgent: { frames: [{ href: page.url, page }], refuseInjectionAfter: 1 },
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN we type and the window is over,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });
  clock.runNext();
  await settleAsyncWork();

  // THEN the same two fields ride along, through the same single enricher:
  const error = responsesById(socket).get(2).error;
  assert.equal(error.code, "not_readable");
  assert.equal(error.url, "about:config");
  assert.equal(error.kind, "internal");
});

test("type_withTwoOverlappingRequests_shouldAnswerTheFirstWithSupersededAndInjectNoRead", async () => {
  // GIVEN a type that has already written and is waiting out its 300 ms:
  const page = createTypePage();
  const tabs = createTypeTabs({ page });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });
  assert.deepStrictEqual(clock.pendingDelays(), [TYPE_WAIT_MS]);
  assert.equal(tabs.scriptCalls.length, 1);

  // WHEN a second type arrives inside that window,
  await sendType(socket, 3, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });

  // THEN the first answers `superseded`,
  const first = responsesById(socket).get(2);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, "superseded");

  // ... it injects no read into the page its successor is about to change — two
  // injections in total, not three,
  assert.equal(tabs.scriptCalls.length, 2);

  // ... and it leaves no timer behind: only the second type's window is pending.
  assert.deepStrictEqual(clock.pendingDelays(), [TYPE_WAIT_MS]);

  // WHEN the second window is over,
  assert.equal(clock.runNext(), TYPE_WAIT_MS);
  await settleAsyncWork();

  // THEN the second answers with its page, after exactly one read of its own.
  assert.equal(responsesById(socket).get(3).ok, true);
  assert.equal(tabs.scriptCalls.length, 3);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("type_inTwoDifferentTabs_shouldBothAnswerAndNeitherBeSuperseded", async () => {
  // GIVEN two agent tabs and a type in tab 501 that is waiting out its 300 ms:
  const page = createTypePage();
  const tabs = createTypeTabs({ page, tabs: createTwoAgentTabs() });
  const started = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });
  const { socket, clock } = started;
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT, tab: 501 });
  assert.deepStrictEqual(clock.pendingDelays(), [TYPE_WAIT_MS]);
  assert.equal(tabs.scriptCalls.length, 1);

  // WHEN a second type arrives in the *other* tab,
  await sendType(socket, 3, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT, tab: 500 });

  // THEN the first is untouched and both windows are armed side by side:
  assert.equal(
    responsesById(socket).has(2),
    false,
    "a type in another tab must not answer the first one",
  );
  assert.deepStrictEqual(clock.pendingDelays(), [TYPE_WAIT_MS, TYPE_WAIT_MS]);
  assert.equal(tabs.scriptCalls.length, 2, "two typings and no read yet");

  // WHEN both windows are over,
  assert.equal(clock.runNext(), TYPE_WAIT_MS);
  await settleAsyncWork();
  assert.equal(clock.runNext(), TYPE_WAIT_MS);
  await settleAsyncWork();

  // THEN both answer `ok` with their own tab — four injections (type and read per
  // tab) and no `superseded` on either:
  const first = responsesById(socket).get(2);
  const second = responsesById(socket).get(3);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal("error" in first, false, "the first type must not be superseded");
  assert.equal("error" in second, false, "the second type must not be superseded");
  assert.equal(first.result.tabId, 501);
  assert.equal(second.result.tabId, 500);
  assert.equal(tabs.scriptCalls.length, 4);
  assert.deepStrictEqual(clock.pendingDelays(), []);

  // ... and the slot map ends empty.
  assert.deepStrictEqual(slotMapKeys(started), [[]]);
});

test("type_whenAClickArrivesDuringTheWait_shouldAnswerSupersededAndLeaveTheClickItsOwnTimer", async () => {
  // GIVEN a type that is waiting out its 300 ms:
  const page = createTypePage({ elements: { [DEFAULT_TYPE_SELECTOR]: createTypeElement({ id: "q" }) } });
  page.elements[DEFAULT_CLICK_SELECTOR] = createClickElement({ id: "video-title-link" });
  // The tab is `complete`, because the click that arrives below now runs its own
  // settle wait first — on a loading tab it would be answered `page_busy` instead,
  // which is a different case.
  const tabs = createTypeTabs({
    page,
    tabs: [createAgentTabFixture({ status: "complete" })],
    pageAgent: {
      frames: [{ href: page.url, page }],
      // The click that arrives below runs its own settle wait; this is the pair that
      // sends it to the fixed 300 ms, which is the timer the case is about.
      answer: (message) => (message.op === "settle" ? { value: { ...NO_SETTLE_RESULT } } : undefined),
    },
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });
  assert.deepStrictEqual(clock.pendingDelays(), [TYPE_WAIT_MS]);

  // WHEN a click arrives — it changes the page too, so it takes the slot over,
  await sendClick(socket, 3, { selector: DEFAULT_CLICK_SELECTOR });

  // THEN the type answers `superseded` and reads nothing more,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "superseded");
  // Three: the typing, the click and the click's settle wait.
  assert.equal(tabs.scriptCalls.length, 3);

  // ... and only the click's own window is left.
  assert.deepStrictEqual(clock.pendingDelays(), [CLICK_FALLBACK_MS]);
});

test("type_onAVisibleField_shouldTypeOnceWaitThreeHundredMillisecondsAndReadThePage", async () => {
  // GIVEN a visible field and a page that has nothing more to say:
  const element = createTypeElement({ id: "q" });
  const tabs = createTypeTabs({ page: createTypePage({ element }) });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to type into it,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });

  // THEN the text was written once and the answer waits out the fixed window — one
  // injection so far, one timer, none of the 8 s of a navigation:
  assert.equal(element.nativeSets, 1);
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(clock.pendingDelays(), [TYPE_WAIT_MS]);
  assert.equal(responsesById(socket).has(2), false);

  // WHEN the window is over,
  assert.equal(clock.runNext(), TYPE_WAIT_MS);
  await settleAsyncWork();

  // THEN the second injection reads the page, and the answer is that result plus
  // the description built *before* the write and the Enter flag:
  assert.equal(tabs.scriptCalls.length, 2);
  assert.equal(tabs.scriptCalls[1].tabId, 500);
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(answer.result, {
    tabId: 500,
    url: DEFAULT_READ_PAGE.url,
    title: DEFAULT_READ_PAGE.title,
    typed: "input#q",
    submitted: false,
    text: "Erste Zeile\n\nZweite Zeile",
    truncated: false,
    via: "innerText",
  });
  assert.deepStrictEqual(Object.keys(answer.result), [
    "tabId",
    "url",
    "title",
    "typed",
    "submitted",
    "text",
    "truncated",
    "via",
  ]);
});

/* ------------------------------------------------------- type: frame (spec 26) */

/**
 * The two realms of a typing with `frame`: the main frame with its own field for the
 * tested selector, and the widget iframe with another one.
 *
 * Both frames carry a field for the same selector on purpose — the filter, not the query,
 * decides which one is written into. `value` starts as `""` in both, so "the main frame was
 * not touched" is a statement about a value that would have changed.
 */
function createFramedTypePages() {
  const mainField = createTypeElement({ id: "q" });
  const widgetField = createTypeElement({ id: "widget-q" });
  return {
    mainField,
    widgetField,
    mainPage: createTypePage({ element: mainField }),
    widgetPage: {
      ...createTypePage({ element: widgetField }),
      url: WIDGET_FRAME_URL,
      title: "Kalender",
      innerText: "Text des Widget-Rahmens",
      inFrame: true,
    },
  };
}

/** A typing across the two realms of `createFramedTypePages`. */
function createFramedTypeTabs(pages) {
  return createFramedPageAgentTabs([pages.mainPage, pages.widgetPage]);
}

test("type_withFrame_shouldWriteIntoTheAddressedFrameAndLeaveTheMainFieldUntouched", async () => {
  // GIVEN a page whose main frame and widget iframe both carry a field for the same
  // selector,
  const pages = createFramedTypePages();
  const tabs = createFramedTypeTabs(pages);
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge types through the widget's address, and the typing's own 300 ms
  // wait — the background's, not the page's — is over,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT, frame: "widget" });
  clock.runNext();
  await settleAsyncWork();

  // THEN the widget's field was written once — through the setter, like every typing — and
  // described as itself,
  assert.equal(pages.widgetField.nativeSets, 1);
  assert.equal(pages.widgetField.value, DEFAULT_TYPE_TEXT);
  assert.equal(responsesById(socket).get(2).result.typed, "input#widget-q");

  // ... while the main frame's field kept its value, saw no event and was never even
  // focused: the filter returned before the lookup.
  assert.equal(pages.mainField.value, "", "the unaddressed frame must not be written into");
  assert.equal(pages.mainField.nativeSets, 0);
  assert.deepStrictEqual(pages.mainField.events, [], "the unaddressed frame must see no event");
});

test("type_withFrame_shouldAnswerTheStateOfTheAddressedFrame", async () => {
  // GIVEN the same two realms,
  const pages = createFramedTypePages();
  const tabs = createFramedTypeTabs(pages);
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge types through the widget's address and the typing's wait is over,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT, frame: "widget" });
  clock.runNext();
  await settleAsyncWork();

  // THEN both ops — typing, page state — went to every frame, `frameIds` left out,
  assert.equal(tabs.scriptCalls.length, 2);
  for (const call of tabs.scriptCalls) {
    assert.equal(call.details.target.allFrames, true, "a typing with `frame` must address every frame");
    assert.equal(
      call.details.target.frameIds,
      undefined,
      "`allFrames` and `frameIds` exclude each other",
    );
  }

  // ... and the answer carries address, title and text of that frame — not of the tab's
  // main frame, whose text differs.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(inThisRealm(answer.result), {
    tabId: 500,
    url: WIDGET_FRAME_URL,
    title: "Kalender",
    typed: "input#widget-q",
    submitted: false,
    text: "Text des Widget-Rahmens",
    truncated: false,
    via: "innerText",
  });
  assert.deepStrictEqual(clock.pendingDelays(), [], "the answered typing left no timer behind");
});

test("type_withAFrameThatMatchesNoFrame_shouldAnswerFrameNotFoundWithTheAnsweredCount", async () => {
  // GIVEN the same two realms, none of them matching,
  const pages = createFramedTypePages();
  const tabs = createFramedTypeTabs(pages);
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge types through a substring that hits nothing,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT, frame: "gibtsnicht" });

  // THEN the filter's own code answers with the number of frames that answered — no write
  // happened anywhere, and nothing waits for a page nobody addressed,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "frame_not_found");
  assert.equal(answer.error.frames, 2);
  assert.equal(answer.error.message, "No frame matches the given frame.");
  assert.equal(pages.mainField.nativeSets, 0);
  assert.equal(pages.widgetField.nativeSets, 0);
  assert.deepStrictEqual(clock.pendingDelays(), [], "a refused frame opens no window");
  assert.equal(tabs.scriptCalls.length, 1, "only the typing was injected");
});

test("type_withAFrameThatMatchesTwoFrames_shouldAnswerFrameAmbiguousWithBothCandidates", async () => {
  // GIVEN two realms whose addresses both carry the substring — the main frame's address
  // rewritten onto the widget's host, so both frames answer as hits,
  const pages = createFramedTypePages();
  pages.mainPage.url = "https://widget.example.net/startseite";
  const tabs = createFramedTypeTabs(pages);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge types through that substring,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT, frame: "widget" });

  // THEN the call is refused with both addresses, so the caller learns how to answer more
  // precisely — a typing answer without a `href` would leave two `null`s here, i.e. an
  // error asking the caller to address "no frame" more precisely. Both realms were written
  // into before that: the typing is the first statement, the choice of answer the second.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "frame_ambiguous");
  assert.equal(answer.error.message, "Several frames match the given frame.");
  assert.deepStrictEqual(inThisRealm(answer.error.candidates), [
    "https://widget.example.net/startseite",
    WIDGET_FRAME_URL,
  ]);
  assert.equal(answer.result, undefined);
});

test("type_withoutFrame_shouldAddressTheMainFrameOnly", async () => {
  // GIVEN the same two realms and a typing that names no frame,
  const pages = createFramedTypePages();
  const tabs = createFramedTypeTabs(pages);
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge types the same text,
  await sendType(socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });
  clock.runNext();
  await settleAsyncWork();

  // THEN there are exactly two ops — `[0]` typing, `[1]` page state — and both addressed
  // the main frame,
  assert.equal(tabs.scriptCalls.length, 2);
  assert.deepStrictEqual(tabs.channel.ops(), ["type", "read"]);
  for (const call of tabs.scriptCalls) {
    assert.deepStrictEqual(
      call.details.target.frameIds,
      [0],
      "a typing without `frame` addresses the main frame",
    );
    assert.equal(call.details.target.allFrames, undefined, "and asks for exactly one frame");
  }

  // ... so the main frame's field was written once, the widget's untouched, and the answer
  // is the main frame's state.
  assert.equal(pages.mainField.nativeSets, 1);
  assert.equal(pages.widgetField.nativeSets, 0);
  const answer = responsesById(socket).get(2);
  assert.equal(answer.result.url, DEFAULT_READ_PAGE.url);
  assert.equal(answer.result.typed, "input#q");
  assert.equal(answer.result.text, "Erste Zeile\n\nZweite Zeile");
});

/* ---------------------------------------------------------------- inspect */

/**
 * A real CSS form that is *not* part of the grammar this harness implements.
 *
 * `[attr*="…"]` is what a browser understands and the harness refuses; a case that
 * showed only "matches nothing" would prove the matcher discriminates when it merely
 * fails to parse.
 */
const UNSUPPORTED_SELECTOR = 'a[href*="x"]';

/**
 * One element of the invented inspect page.
 *
 * Only what an injected snippet is allowed to read: the tag, the identity hooks
 * (`id`, `class`, any other attribute), the two texts (`innerText` for a reader,
 * `textContent` for the tree), `href`, `disabled`, the rect, and the two style
 * properties the shared `isVisible` helper asks `getComputedStyle` for. `children` is
 * the tree in document order — `:nth-of-type` counts along it.
 *
 * `nodeType: 1` is what makes it an *element* for `eval`'s result mapping: without it
 * the node branch would not fire and the walk would run into the `parentElement` ring
 * every real node carries.
 *
 * `shadowRoot` is a root of its own (`createShadowRoot`) or `null` — the real DOM answers
 * `null` for an element without one, and a closed root is indistinguishable from it,
 * which is exactly the honest answer spec 27 asks for. `parentNode` is the tree link: an
 * element for a normal child, a root node at the top of a shadow tree, where
 * `parentElement` stays `null` as in the real DOM. `root` is the root node the element
 * lives in — `null` for the document tree, the `ShadowRoot` for a shadow tree.
 */
function createInspectElement({
  tagName = "DIV",
  id = "",
  className = "",
  attributes = {},
  textContent = "",
  innerText,
  href = null,
  disabled = false,
  rect = { x: 0, y: 0, width: 100, height: 20 },
  display,
  visibility,
  children = [],
  shadowRoot = null,
  parentNode = null,
  root = null,
} = {}) {
  const element = {
    nodeType: 1,
    tagName,
    id,
    className,
    href,
    disabled,
    display,
    visibility,
    textContent,
    innerText: innerText ?? textContent,
    children,
    shadowRoot,
    parentNode,
    root,
    parentElement: null,
    // `getAttribute("class")` answers a string while `className` may not (an SVG
    // element carries an object there), which is why the snippet reads the attribute.
    getAttribute: (name) => (name === "class" ? className || null : attributes[name] ?? null),
    getBoundingClientRect: () => ({ ...rect }),
  };
  // The root's `host` is the element carrying it — the back reference
  // `element.shadowRoot.host` of the real DOM, and the only way up from a root.
  if (shadowRoot !== null) shadowRoot.host = element;
  // The up-links belong to the tree, not to every fixture: `>` chains and
  // `:nth-of-type` both walk them. A light child inherits the root of its parent, so an
  // element inside a shadow tree knows that tree without being told twice.
  for (const child of children) {
    child.parentElement = element;
    child.parentNode = element;
    child.root = root;
  }
  return element;
}

/** The element's descendants in document order — what `querySelectorAll` searches. */
function descendantsOf(element) {
  return element.children.flatMap((child) => [child, ...descendantsOf(child)]);
}

/**
 * The `document.body` of an invented inspect page, built once per page.
 *
 * Unlike the read body this one answers `querySelectorAll`: the text search collects
 * its candidates exactly there, and the method goes through `matchesSelector` so that
 * a fixture cannot be searched with a selector the matcher does not really check.
 * Built once, because two bodies would break the identity the round trip depends on.
 */
function createInspectBody(page) {
  if (page.body === undefined) {
    const body = createInspectElement({ tagName: "BODY", children: page.children ?? [] });
    body.querySelectorAll = (selector) => {
      page.queries.push(selector);
      return descendantsOf(body).filter((candidate) => matchesSelector(page, candidate, selector));
    };
    page.body = body;
  }
  return page.body;
}

/**
 * One open shadow root of the invented page.
 *
 * A root is no element and has no tag, but it is the *parent node* of everything directly
 * inside it and it answers `querySelectorAll` for its own tree only — the two properties
 * an inspect snippet may rely on. The query filters this root's ordered elements through
 * `matchesSelector`, so a selector outside the matcher's grammar throws here as well
 * instead of quietly answering "nothing".
 *
 * `page` is wired in by `createInspectPage`: `matchesSelector` refuses elements outside
 * its page, and only the page knows all of them. `queries` is the log a case reads — it is
 * the proof that a query went into this tree and not into `document`.
 */
function createShadowRoot({ children = [] } = {}) {
  const root = {
    // Set by `createInspectElement`, the way `element.shadowRoot.host` answers in the DOM.
    host: null,
    children,
    page: null,
    queries: [],
    querySelectorAll(selector) {
      root.queries.push(selector);
      const elements = children.flatMap((child) => [child, ...descendantsOf(child)]);
      return elements.filter((candidate) => matchesSelector(root.page, candidate, selector));
    },
  };
  for (const child of children) {
    // `parentElement` stays `null` at a shadow edge, exactly as the real DOM reports it —
    // and `pathOf` walking up from such a node has to stop there for that reason.
    child.parentNode = root;
    child.root = root;
  }
  return root;
}

/**
 * Every element of the page in one list: the document tree and every open shadow tree
 * below it.
 *
 * `page.elements` stays the document-order list of the *document*, because that is what
 * `document.querySelectorAll` searches. This walk exists for the two consumers that need
 * the shadow trees too: the matcher's `Set` (an element inside a shadow root is on this
 * page, so a fixture mistake has to stay a *fixture* mistake) and the roots themselves,
 * which each get the page wired in on the way past.
 */
function allPageElements(page, element = page.documentElement, collected = []) {
  collected.push(element);
  if (element.shadowRoot !== null) {
    element.shadowRoot.page = page;
    for (const child of element.shadowRoot.children) allPageElements(page, child, collected);
  }
  for (const child of element.children) allPageElements(page, child, collected);
  return collected;
}

/**
 * The document roots an injected inspect snippet reads, plus the switch `runPageCode`
 * branches on.
 *
 * `dom: true` is that switch: from there on `document` has a real tree,
 * `querySelector`/`querySelectorAll` route through `matchesSelector`, and
 * `document.body` is the inspect body instead of the read one that throws on purpose.
 * `elements` is the document-order list those two methods filter, built once because
 * the tree does not change during a case.
 *
 * `queries` is the document-level counterpart of a shadow root's log: every list call a
 * snippet makes against `document` (or `document.body`) lands there, in order, so a case
 * can prove *how often* and *with what* the document was asked — and that it was not
 * asked at all when a refusal needs no query.
 */
function createInspectPage({ children = [], title = "Erfundene Abfrageseite", url = AGENT_URL } = {}) {
  const page = { dom: true, url, title, children, queries: [] };
  page.documentElement = createInspectElement({
    tagName: "HTML",
    children: [createInspectBody(page)],
  });
  page.elements = [page.documentElement, ...descendantsOf(page.documentElement)];
  // A `Set` next to the list, because `matchesSelector` is asked once per element per
  // query — and the candidate-cap case walks thousands of them. A linear lookup there
  // would make the harness quadratic and that case slow enough to prove nothing.
  page.elementSet = new Set(allPageElements(page));
  return page;
}

/**
 * The invented page the inspect cases start from, with the handles they compare
 * against.
 *
 * Every id, class and text here is invented; the arrangement is the point. Two
 * paragraphs are siblings, a span sits *between* the two `div.knopf` (so
 * `:nth-of-type` has to count by tag instead of by child position), one span carries
 * nothing to grab on at all, and one box is nested so a `>` chain has three steps.
 */
function createInspectFixture() {
  const cartLink = createInspectElement({
    tagName: "A",
    id: "warenkorb-link",
    className: "knopf knopf--wichtig",
    attributes: { "data-testid": "warenkorb-knopf" },
    innerText: "Erfundener Warenkorb",
    href: "https://example.org/warenkorb",
  });
  const firstParagraph = createInspectElement({ tagName: "P", innerText: "Erster erfundener Absatz" });
  const secondParagraph = createInspectElement({ tagName: "P", innerText: "Zweiter erfundener Absatz" });
  const firstKnopf = createInspectElement({ tagName: "DIV", className: "knopf", innerText: "Knopf eins" });
  const plainSpan = createInspectElement({ tagName: "SPAN", innerText: "Ohne id und Klasse" });
  const secondKnopf = createInspectElement({ tagName: "DIV", className: "knopf", innerText: "Knopf zwei" });
  const nestedEntry = createInspectElement({
    tagName: "SPAN",
    className: "eintrag",
    innerText: "Eintrag im Kasten",
  });
  const listBox = createInspectElement({ tagName: "DIV", className: "kasten", children: [nestedEntry] });
  const page = createInspectPage({
    title: "Erfundene Abfrageseite",
    children: [cartLink, firstParagraph, secondParagraph, firstKnopf, plainSpan, secondKnopf, listBox],
  });
  return {
    page,
    cartLink,
    firstParagraph,
    secondParagraph,
    firstKnopf,
    secondKnopf,
    plainSpan,
    nestedEntry,
    listBox,
  };
}

/**
 * The tag name in the case the grammar compares in: HTML tag names are
 * case-insensitive, so a selector builder may lower-case them.
 */
function tagNameOf(element) {
  return typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
}

/** The class list as the attribute carries it; a missing class is no list at all. */
function classNamesOf(element) {
  return (element.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter((name) => name !== "");
}

/**
 * The 1-based position among the siblings that share the tag name — what
 * `:nth-of-type(n)` counts, and not the child index.
 *
 * The edge is the interesting half: a node at the top of a shadow tree has no
 * `parentElement` (a root is no element) and still has same-tag siblings inside that
 * root, so the position is counted along `parentNode` once that node carries children.
 * An element with nothing above it — the document's own root — stays its own first.
 */
function nthOfTypeOf(element) {
  const parent = element.parentElement ?? element.parentNode ?? null;
  const siblings = parent !== null && Array.isArray(parent.children) ? parent.children : [element];
  const sameTag = siblings.filter((sibling) => tagNameOf(sibling) === tagNameOf(element));
  return sameTag.indexOf(element) + 1;
}

/** The one error the matcher throws for a form outside its grammar. */
function syntaxErrorFor(selector) {
  return new SyntaxError(`${JSON.stringify(selector)} is not a selector this harness understands`);
}

/**
 * The parts a compound selector may carry after its type selector, and nothing else.
 *
 * Written from the CSS grammar rather than from the selector builder's output: a
 * matcher that understands exactly what the builder emits grades itself, and the
 * round trip would be green for the wrong reason.
 */
const COMPOUND_PART_TOKENS = [
  { kind: "id", pattern: /^#([A-Za-z0-9_-]+)/ },
  { kind: "class", pattern: /^\.([A-Za-z0-9_-]+)/ },
  { kind: "attribute", pattern: /^\[([A-Za-z0-9_-]+)="([^"]*)"\]/ },
  { kind: "nthOfType", pattern: /^:nth-of-type\((\d+)\)/ },
];

/** A type selector: a tag name, or the universal `*`. */
const TYPE_SELECTOR_TOKEN = /^\*|^[A-Za-z][A-Za-z0-9-]*/;

/**
 * One compound selector (`div.knopf:nth-of-type(2)`), parsed into the tests it stands
 * for.
 *
 * Both halves are optional in CSS, so `#id` and `*` are compounds too. Every part is
 * kept in a list, which is why `#a#b` matches nothing instead of throwing: two
 * different ids on one element is a contradiction the grammar allows. `selector` only
 * rides along for the error message.
 */
function parseCompoundSelector(text, selector) {
  if (text === "") throw syntaxErrorFor(selector);
  const compound = { tag: null, ids: [], classes: [], attributes: [], nthOfTypes: [] };
  const type = TYPE_SELECTOR_TOKEN.exec(text);
  if (type !== null) compound.tag = type[0].toUpperCase();
  let remaining = type === null ? text : text.slice(type[0].length);
  while (remaining !== "") {
    const part = COMPOUND_PART_TOKENS.map((token) => ({
      kind: token.kind,
      match: token.pattern.exec(remaining),
    })).find((candidate) => candidate.match !== null);
    if (part === undefined) throw syntaxErrorFor(selector);
    applyCompoundPart(compound, part);
    remaining = remaining.slice(part.match[0].length);
  }
  return compound;
}

/** Files one parsed part into the compound it belongs to. */
function applyCompoundPart(compound, { kind, match }) {
  if (kind === "id") compound.ids.push(match[1]);
  else if (kind === "class") compound.classes.push(match[1]);
  else if (kind === "attribute") compound.attributes.push({ name: match[1], value: match[2] });
  else compound.nthOfTypes.push(Number(match[1]));
}

/** Does one element satisfy one compound selector? */
function matchesCompoundSelector(element, compound) {
  if (compound.tag !== null && compound.tag !== "*" && tagNameOf(element) !== compound.tag) {
    return false;
  }
  if (!compound.ids.every((id) => element.id === id)) return false;
  if (!compound.classes.every((className) => classNamesOf(element).includes(className))) return false;
  if (!compound.attributes.every((attribute) => element.getAttribute(attribute.name) === attribute.value)) {
    return false;
  }
  return compound.nthOfTypes.every((nthOfType) => nthOfTypeOf(element) === nthOfType);
}

/**
 * The chain test: the last compound has to hold for `element`, every earlier one for
 * one of its ancestors.
 */
function matchesChainFrom(element, chain, index) {
  if (!matchesCompoundSelector(element, chain[index])) return false;
  if (index === 0) return true;
  return element.parentElement !== null && matchesChainFrom(element.parentElement, chain, index - 1);
}

/**
 * Does `element` match `selector`?
 *
 * Splitting on `>` is the whole syntax tree, because the grammar under test is a
 * chain of compound selectors joined by child combinators. Everything a browser
 * understands beyond that — `a[href*="x"]`, `div span`, `:not(…)` — throws instead of
 * answering "no match": a matcher that silently ignores what it does not understand
 * would pass its own negative cases without discriminating anything.
 *
 * The element has to belong to `page`; anything else is a fixture mistake and gets
 * said out loud rather than reported as "no match".
 */
function matchesSelector(page, element, selector) {
  if (!page.elementSet.has(element)) {
    throw new Error("the element is not part of this page — a fixture mistake, not a selector");
  }
  const chain = selector.split(">").map((part) => parseCompoundSelector(part.trim(), selector));
  return matchesChainFrom(element, chain, chain.length - 1);
}

/**
 * `document.querySelectorAll` of the inspect page: the whole document, in order.
 *
 * Every call is logged on the page, because "the document was asked once, with the whole
 * selector" is a claim of its own — and one no answer object can carry.
 */
function querySelectorAllInPage(page, selector) {
  page.queries.push(selector);
  return page.elements.filter((element) => matchesSelector(page, element, selector));
}

/**
 * Sends one `inspect` request and lets the bridge page work through it.
 *
 * Unused until stage 2b, and that is deliberate: the harness is complete before the
 * behaviour it measures exists.
 */
async function sendInspect(socket, id, params) {
  socket.receive({ type: "request", id, method: "inspect", params });
  await settleAsyncWork();
}

/**
 * Sends one `eval` request and lets the bridge page work through it.
 *
 * `params` stays overridable and not defaulted, because "the caller forgot `code`" is
 * a case of its own and `{}` is one of its shapes.
 */
async function sendEval(socket, id, params) {
  socket.receive({ type: "request", id, method: "eval", params });
  await settleAsyncWork();
}

test("matchesSelector_withAUniversalSelector_shouldMatchEveryElement", () => {
  // GIVEN the invented page,
  const { page, cartLink } = createInspectFixture();

  // WHEN every element of the document is asked about `*`,
  const matched = querySelectorAllInPage(page, "*");

  // THEN nothing is filtered out — background elements included, which is the only
  // thing `*` promises:
  assert.equal(matchesSelector(page, cartLink, "*"), true);
  assert.equal(matchesSelector(page, page.documentElement, "*"), true);
  assert.equal(matched.length, page.elements.length);
});

test("matchesSelector_withATagSelector_shouldMatchOnlyThatTagName", () => {
  // GIVEN a link and a div,
  const { page, cartLink, firstKnopf } = createInspectFixture();

  // WHEN a tag name is asked,
  // THEN only that tag answers, and the case does not matter — the builder is free to
  // lower-case what the DOM reports upper-case:
  assert.equal(matchesSelector(page, cartLink, "a"), true);
  assert.equal(matchesSelector(page, cartLink, "A"), true);
  assert.equal(matchesSelector(page, cartLink, "div"), false);
  assert.equal(matchesSelector(page, firstKnopf, "div"), true);
});

test("matchesSelector_withAnIdSelector_shouldMatchOnlyTheElementCarryingIt", () => {
  // GIVEN one element with an id and one without,
  const { page, cartLink, firstKnopf } = createInspectFixture();

  // WHEN that id is asked,
  // THEN it names one element, and the element without an id stays out:
  assert.equal(matchesSelector(page, cartLink, "#warenkorb-link"), true);
  assert.equal(matchesSelector(page, firstKnopf, "#warenkorb-link"), false);
});

test("matchesSelector_withTwoClassSelectors_shouldRequireBothClasses", () => {
  // GIVEN a link with the classes `knopf` and `knopf--wichtig`,
  const { page, cartLink, firstKnopf } = createInspectFixture();

  // WHEN two classes are asked,
  // THEN both have to be there — the second one is not decoration:
  assert.equal(matchesSelector(page, cartLink, ".knopf.knopf--wichtig"), true);
  assert.equal(matchesSelector(page, cartLink, ".knopf.knopf--still"), false);

  // ... and one class alone also matches the plain div that carries it, which is what
  // makes `tag.c1.c2` a candidate that still needs its uniqueness check.
  assert.equal(matchesSelector(page, firstKnopf, ".knopf"), true);
  assert.equal(matchesSelector(page, firstKnopf, ".knopf.knopf--wichtig"), false);
});

test("matchesSelector_withAnAttributeSelector_shouldMatchTheExactValue", () => {
  // GIVEN a link carrying `data-testid="warenkorb-knopf"`,
  const { page, cartLink, firstKnopf } = createInspectFixture();

  // WHEN that attribute is asked with its value,
  // THEN the value has to be equal, not merely present:
  assert.equal(matchesSelector(page, cartLink, '[data-testid="warenkorb-knopf"]'), true);
  assert.equal(matchesSelector(page, cartLink, '[data-testid="anderer-knopf"]'), false);
  assert.equal(matchesSelector(page, firstKnopf, '[data-testid="warenkorb-knopf"]'), false);
});

test("matchesSelector_withNthOfType_shouldCountSiblingsOfTheSameTag", () => {
  // GIVEN a span between the two `div.knopf` and the second paragraph as the body's
  // third child,
  const { page, firstParagraph, secondParagraph, firstKnopf, secondKnopf } = createInspectFixture();

  // WHEN `:nth-of-type` counts,
  // THEN it counts by tag among the siblings and not by child position — a child-index
  // implementation would call the second paragraph the second `p` only by luck:
  assert.equal(matchesSelector(page, firstParagraph, "p:nth-of-type(1)"), true);
  assert.equal(matchesSelector(page, secondParagraph, "p:nth-of-type(2)"), true);
  assert.equal(matchesSelector(page, firstKnopf, "div:nth-of-type(1)"), true);
  assert.equal(matchesSelector(page, secondKnopf, "div:nth-of-type(2)"), true);

  // ... and counting by child position would find the second div at `4`, which is
  // exactly the answer this matcher must not give:
  assert.equal(matchesSelector(page, secondKnopf, "div:nth-of-type(4)"), false);
});

test("matchesSelector_withAChainOfChildCombinators_shouldMatchTheWholePath", () => {
  // GIVEN a span.eintrag nested one box deep inside the body,
  const { page, nestedEntry, plainSpan } = createInspectFixture();

  // WHEN the whole path is asked for,
  // THEN every step has to hold, the third div included:
  assert.equal(matchesSelector(page, nestedEntry, "html > body > div:nth-of-type(3) > span.eintrag"), true);

  // ... a wrong ancestor at any step defeats the chain, and so does a chain that stops
  // too early for an element that sits one level deeper:
  assert.equal(matchesSelector(page, nestedEntry, "html > body > div:nth-of-type(1) > span.eintrag"), false);
  assert.equal(matchesSelector(page, plainSpan, "html > body > div:nth-of-type(3) > span.eintrag"), false);
  assert.equal(matchesSelector(page, nestedEntry, "body > span.eintrag"), false);
});

test("matchesSelector_withAWrongCandidateInSupportedGrammar_shouldMatchNothing", () => {
  // GIVEN a candidate of the right grammar that names the wrong element,
  const { page, cartLink, firstParagraph, secondParagraph } = createInspectFixture();

  // WHEN every element of the page is asked about `a#andere-id`,
  const hits = querySelectorAllInPage(page, "a#andere-id");

  // THEN nothing matches: the matcher compares the id instead of waving a
  // syntactically valid selector through.
  assert.deepStrictEqual(hits, []);
  assert.equal(matchesSelector(page, cartLink, "a#andere-id"), false);

  // ... and the same control with siblings: `p:nth-of-type(1)` is the first paragraph
  // and must not answer for the second one.
  assert.equal(matchesSelector(page, firstParagraph, "p:nth-of-type(1)"), true);
  assert.equal(matchesSelector(page, secondParagraph, "p:nth-of-type(1)"), false);
});

test("matchesSelector_withTwoIdenticalSiblings_shouldMatchBothAndThereforeBeAmbiguous", () => {
  // GIVEN two sibling `div.knopf` with nothing to tell them apart,
  const { page, firstKnopf, secondKnopf } = createInspectFixture();

  // WHEN `div.knopf` is asked,
  // THEN both match — so no caller may treat that selector as "the one element", and
  // the builder has to fall through to its path form:
  assert.equal(matchesSelector(page, firstKnopf, "div.knopf"), true);
  assert.equal(matchesSelector(page, secondKnopf, "div.knopf"), true);
  assert.deepStrictEqual(querySelectorAllInPage(page, "div.knopf"), [firstKnopf, secondKnopf]);

  // ... and `querySelector` answers the first of them, like a browser does.
  assert.equal(querySelectorIn(page, "div.knopf"), firstKnopf);
});

test("matchesSelector_withAnUnsupportedForm_shouldThrowSyntaxError", () => {
  // GIVEN a link,
  const { page, cartLink } = createInspectFixture();

  // WHEN a real CSS form outside this grammar arrives,
  // THEN it throws instead of answering "no match": the two are not the same thing,
  // and a matcher that confused them would pass its own negative cases.
  assert.throws(() => matchesSelector(page, cartLink, UNSUPPORTED_SELECTOR), SyntaxError);

  // ... and the same goes for a descendant combinator and for the empty selector a
  // caller can send by accident.
  assert.throws(() => matchesSelector(page, cartLink, "div a"), SyntaxError);
  assert.throws(() => matchesSelector(page, cartLink, ""), SyntaxError);
});

test("createInspectPage_shouldExposeTheRootsAndABodyThatAnswersQuerySelectorAll", () => {
  // GIVEN the invented page,
  const { page, firstKnopf, secondKnopf, plainSpan } = createInspectFixture();

  // WHEN the document roots are asked what `runPageCode` branches on,
  // THEN the marker, the title and the root element are there,
  assert.equal(page.dom, true);
  assert.equal(page.title, "Erfundene Abfrageseite");
  assert.equal(page.documentElement.tagName, "HTML");
  assert.equal(matchesSelector(page, page.documentElement, "html"), true);

  // ... `document.body` is the one inspect body and not a fresh copy per injection,
  assert.equal(createInspectBody(page), page.body);

  // ... and that body answers `querySelectorAll` in document order instead of throwing
  // like the read body does on purpose:
  assert.deepStrictEqual(page.body.querySelectorAll("div.knopf"), [firstKnopf, secondKnopf]);
  assert.equal(page.body.querySelectorAll("p:nth-of-type(3)").length, 0);
  assert.equal(page.body.querySelectorAll("*").includes(plainSpan), true);
  assert.equal(page.body.querySelectorAll("*").length, 8);
});

test("createInspectPage_shouldRouteBothQueryMethodsThroughTheMatcher", () => {
  // GIVEN the invented page,
  const { page } = createInspectFixture();

  // WHEN a snippet asks the document the way the inspect snippet will,
  const answer = runPageCode(
    `(() => ({
      first: document.querySelector("p:nth-of-type(1)").innerText,
      second: document.querySelector("p:nth-of-type(2)").innerText,
      knopf: document.querySelector("div.knopf:nth-of-type(2)")?.innerText ?? null,
      knopfCount: document.querySelectorAll("div.knopf").length,
      missing: document.querySelector("a#andere-id"),
    }))()`,
    page,
  );

  // THEN both methods answer from the same matcher, `querySelector` with the first
  // hit and `null` for a valid selector that matches nothing:
  assert.deepStrictEqual(answer, {
    first: "Erster erfundener Absatz",
    second: "Zweiter erfundener Absatz",
    knopf: "Knopf zwei",
    knopfCount: 2,
    missing: null,
  });

  // ... and a form outside the grammar throws inside the page realm too, which is what
  // `invalid_selector` will be built on.
  assert.throws(
    () => runPageCode(`(() => document.querySelectorAll(${JSON.stringify(UNSUPPORTED_SELECTOR)}))()`, page),
    SyntaxError,
  );
});

/**
 * The invented page of the shadow cases: one card whose content lives in an open shadow
 * tree, next to a button the document really carries.
 *
 * The two trees hold the *same* tag and class on purpose — "the document sees it" and
 * "the root sees it" have to be distinguishable by more than the selector: the texts
 * differ, and so does the answer of each query.
 */
function createShadowInspectFixture() {
  const firstCardButton = createInspectElement({
    tagName: "BUTTON",
    className: "knopf",
    innerText: "Knopf im Schatten",
  });
  const secondCardButton = createInspectElement({
    tagName: "BUTTON",
    className: "knopf",
    innerText: "Zweiter Knopf im Schatten",
  });
  const card = createInspectElement({
    tagName: "MY-CARD",
    id: "karte",
    shadowRoot: createShadowRoot({ children: [firstCardButton, secondCardButton] }),
  });
  const documentButton = createInspectElement({
    tagName: "BUTTON",
    id: "draussen",
    innerText: "Knopf im Dokument",
  });
  const page = createInspectPage({ children: [card, documentButton] });
  return { page, card, firstCardButton, secondCardButton, documentButton };
}

test("createInspectPage_withAShadowRoot_shouldKeepItsElementsOutOfTheDocumentQuery", () => {
  // GIVEN a page whose card carries two buttons in its open shadow tree:
  const { page, card, firstCardButton, secondCardButton, documentButton } = createShadowInspectFixture();

  // WHEN the document is searched the way `document.querySelectorAll` searches it,
  const documentButtons = querySelectorAllInPage(page, "button");

  // THEN the host is part of the document and its content is not — the exact gap
  // `>>>` exists for:
  assert.deepStrictEqual(documentButtons, [documentButton]);
  assert.equal(querySelectorAllInPage(page, "my-card").length, 1);
  assert.equal(page.elements.includes(firstCardButton), false);
  assert.equal(page.elements.includes(secondCardButton), false);

  // ... the elements are still known to the page, so asking a root about its own content
  // is no fixture mistake and the matcher answers instead of throwing,
  assert.equal(page.elementSet.has(firstCardButton), true);
  assert.equal(page.elementSet.has(secondCardButton), true);

  // ... and the root belongs to the card that carries it.
  assert.equal(card.shadowRoot.host, card);
  assert.equal(firstCardButton.root, card.shadowRoot);
  assert.equal(firstCardButton.parentElement, null);
  assert.equal(firstCardButton.parentNode, card.shadowRoot);
});

test("createInspectPage_withAShadowRoot_shouldAnswerPerRootInOrder", () => {
  // GIVEN the same two trees, each with its own log:
  const { page, card, firstCardButton, secondCardButton, documentButton } = createShadowInspectFixture();
  assert.deepStrictEqual(page.queries, []);

  // WHEN the shadow root is asked the way the piercing snippet will ask it,
  const hits = card.shadowRoot.querySelectorAll("button.knopf");

  // THEN it answers its own elements in its own order, and nothing from the document:
  assert.deepStrictEqual(hits, [firstCardButton, secondCardButton]);
  assert.equal(hits.includes(documentButton), false);

  // ... the query was logged on that root and on no other,
  assert.deepStrictEqual(card.shadowRoot.queries, ["button.knopf"]);
  assert.deepStrictEqual(page.queries, []);

  // ... and `:nth-of-type` counts along the root instead of calling every sibling "the
  // first": the second button really is the second of its type in this tree,
  assert.equal(nthOfTypeOf(firstCardButton), 1);
  assert.equal(nthOfTypeOf(secondCardButton), 2);
});

/* -------------------------------------------------- article fixtures */

/**
 * The tags whose text a reader does not see.
 *
 * Invisible in `innerText`, present in `textContent` — that split is the whole reason
 * this fixture exists in two text flavours: the read snippet falls back to
 * `textContent` when `innerText` answers nothing, and a fixture that hid its script text
 * from both would make that fallback unprovable.
 */
const ARTICLE_INVISIBLE_TAG_NAMES = new Set(["SCRIPT", "STYLE", "NOSCRIPT"]);

/**
 * One element of the invented article page.
 *
 * Unlike `createInspectElement`, this one *aggregates*: `innerText` and `textContent`
 * are getters over the subtree, so "the selected root's text" is a statement about the
 * tree rather than about a string a fixture handed over. `innerText` joins its blocks
 * with a newline — a browser would give whatever whitespace the source had, and this
 * tree has no source — and skips removed and non-text children, which is what a reader
 * would see. `textContent` concatenates without a separator and carries the script
 * text: exactly the difference the `via` rule of the read snippet depends on.
 *
 * `removed` is the mark `remove()` leaves behind, and a clone starts with fresh ones.
 * That is what makes "the page stayed unchanged" checkable at all: the cleanup runs on
 * a copy, so the original tree keeps its marks untouched.
 */
function createArticleElement({
  tagName = "DIV",
  id = "",
  className = "",
  attributes = {},
  text = "",
  children = [],
  withoutVisibleText = false,
} = {}) {
  const ownTagName = String(tagName).toUpperCase();
  const element = {
    tagName: ownTagName,
    id,
    className,
    children,
    removed: false,
    // `withoutVisibleText` is the single-page app of spec 23: rendered nothing, full of
    // text once script has run. `innerText` answers nothing, `textContent` answers
    // everything — that split is what the read snippet's `via` fallback has to survive.
    get innerText() {
      if (element.removed || withoutVisibleText) return "";
      if (ARTICLE_INVISIBLE_TAG_NAMES.has(ownTagName)) return "";
      return [text, ...children.map((child) => child.innerText)]
        .filter((block) => block.trim() !== "")
        .join("\n");
    },
    get textContent() {
      if (element.removed) return "";
      return [text, ...children.map((child) => child.textContent)].join("");
    },
    // `class` and `id` are attributes too, and the banner patterns read them as such
    // (`[class*="cookie" i]` is an attribute selector, not a class selector).
    getAttribute(name) {
      if (attributes[name] !== undefined) return attributes[name];
      if (name === "class") return className === "" ? null : className;
      if (name === "id") return id === "" ? null : id;
      return null;
    },
    remove() {
      element.removed = true;
    },
    // `Node.contains`, the one way to ask "is this inside that" — the density descent
    // peels a wrapper back to its content with it, and a fixture without it would make
    // the descent find nothing on every page.
    contains(other) {
      return other === element || articleDescendantsOf(element).includes(other);
    },
    cloneNode(deep) {
      // Only the deep copy is modelled: it is the one the snippet asks for, and a silent
      // shallow answer would look like a copy while proving nothing about cleanup.
      if (deep !== true) throw new Error("the article fixture only models cloneNode(true)");
      return createArticleElement({
        tagName: ownTagName,
        id,
        className,
        attributes,
        text,
        children: children.map((child) => child.cloneNode(true)),
        withoutVisibleText,
      });
    },
    querySelectorAll: (selector) =>
      articleDescendantsOf(element).filter((candidate) => matchesArticleSelector(candidate, selector)),
  };
  return element;
}

/**
 * The element's descendants in document order, removed ones excluded.
 *
 * A real `remove()` detaches the node, so a later query no longer finds it. This tree
 * only marks, hence the skip — a cleanup that removed a banner twice would otherwise
 * look like it had removed two banners.
 */
function articleDescendantsOf(element) {
  return element.children
    .filter((child) => !child.removed)
    .flatMap((child) => [child, ...articleDescendantsOf(child)]);
}

/**
 * An invented article page: a real tree, one body to aggregate over, and the switch
 * `pageContextOf` branches on.
 *
 * `article: true` is that switch. `elements` is the document-order list the document's
 * two query methods filter, built once because the tree does not change during a case —
 * and the copy the cleanup works on is a separate tree anyway.
 *
 * `withoutVisibleText` makes the body of the page a single-page app: it renders nothing,
 * so its `innerText` is empty while the paragraph text is all still there for
 * `textContent`. Only the body gets it — a page that had lost the text itself would be a
 * different case (and a broken one).
 */
function createArticlePage({
  children = [],
  title = "Erfundene Artikelseite",
  url = AGENT_URL,
  withoutVisibleText = false,
} = {}) {
  const page = { article: true, url, title };
  page.body = createArticleElement({ tagName: "BODY", children, withoutVisibleText });
  page.documentElement = createArticleElement({ tagName: "HTML", children: [page.body] });
  page.elements = [page.documentElement, ...articleDescendantsOf(page.documentElement)];
  return page;
}

/** `document.querySelectorAll` of the invented article page: the whole tree, in order. */
function querySelectorAllInArticlePage(page, selector) {
  return page.elements.filter((element) => matchesArticleSelector(element, selector));
}

/**
 * The attribute forms the article grammar knows: presence, `=`, and `*=`, the last two
 * with the optional ` i`. Everything else throws in the caller.
 */
const ARTICLE_ATTRIBUTE_PATTERN = /^([A-Za-z0-9_:.-]+)(?:(\*?)=\s*"([^"]*)"\s*([iI])?)?$/;

/**
 * One compound of the article grammar: a type selector followed by any number of
 * `#id`, `.class` and attribute parts, in any order — no combinators, no `*`, no
 * pseudo-classes.
 *
 * Written from the selector list the production code emits, and *not* from a matcher
 * that understands whatever it is handed: a selector outside this grammar has to throw,
 * or a cleanup selector that lost three of its six families would still answer "nothing
 * matched" and pass.
 */
function articleSelectorPartOf(rawPart, selector) {
  const compound = { tagName: null, id: null, classNames: [], attributes: [] };
  let rest = rawPart.trim();
  const tagName = /^[A-Za-z][A-Za-z0-9-]*/.exec(rest);
  if (tagName !== null) {
    compound.tagName = tagName[0].toUpperCase();
    rest = rest.slice(tagName[0].length);
  }
  while (rest !== "") {
    const id = /^#([A-Za-z0-9_-]+)/.exec(rest);
    if (id !== null) {
      compound.id = id[1];
      rest = rest.slice(id[0].length);
      continue;
    }
    const className = /^\.([A-Za-z0-9_-]+)/.exec(rest);
    if (className !== null) {
      compound.classNames.push(className[1]);
      rest = rest.slice(className[0].length);
      continue;
    }
    const bracket = /^\[([^\]]*)\]/.exec(rest);
    if (bracket !== null) {
      const attribute = ARTICLE_ATTRIBUTE_PATTERN.exec(bracket[1].trim());
      if (attribute === null) throw syntaxErrorFor(selector);
      compound.attributes.push({
        name: attribute[1],
        operator: attribute[2] ?? null,
        value: attribute[3] ?? null,
        ignoreCase: attribute[4] !== undefined,
      });
      rest = rest.slice(bracket[0].length);
      continue;
    }
    throw syntaxErrorFor(selector);
  }
  const isEmpty =
    compound.tagName === null &&
    compound.id === null &&
    compound.classNames.length === 0 &&
    compound.attributes.length === 0;
  if (isEmpty) throw syntaxErrorFor(selector);
  return compound;
}

/** Does `element` name every class of the compound? */
function articleClassNamesOf(element) {
  return (element.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter((name) => name !== "");
}

/** One attribute part, with the ` i` flag really applied only when it was written. */
function articleMatchesAttribute(element, { name, operator, value, ignoreCase }) {
  const actual = element.getAttribute(name);
  if (actual === null) return false;
  if (operator === null) return true;
  const comparable = (text) => (ignoreCase ? String(text).toLowerCase() : String(text));
  if (operator === "=") return comparable(actual) === comparable(value);
  return comparable(actual).includes(comparable(value));
}

/** Does `element` match one compound of the article grammar? */
function articleMatchesPart(element, part) {
  if (part.tagName !== null && String(element.tagName).toUpperCase() !== part.tagName) return false;
  if (part.id !== null && element.id !== part.id) return false;
  if (!part.classNames.every((name) => articleClassNamesOf(element).includes(name))) return false;
  return part.attributes.every((attribute) => articleMatchesAttribute(element, attribute));
}

/**
 * Does `element` match `selector` in the article grammar?
 *
 * The comma list is the whole syntax tree: a compound lists what has to hold *together*
 * (`article#artikel.dicht`), the commas what may hold *instead* — which is exactly the
 * shape of the banner selector.
 */
function matchesArticleSelector(element, selector) {
  const parts = selector.split(",").map((part) => articleSelectorPartOf(part, selector));
  return parts.some((part) => articleMatchesPart(element, part));
}

/* ------------------------------------------------------- inspect: product */

// The two limits the cases below pin: the cap on examined candidates, and the cut on
// every page string.
const INSPECT_CANDIDATE_LIMIT = 5000;
const INSPECT_TEXT_LIMIT = 200;

/**
 * The inspect path with an injection that runs the real op against `page`.
 *
 * The realm is the page realm of that fixture (`pageContextOf`), reached through the
 * message channel of spec 45 — the same road every production caller takes. `answer`
 * is for the cases whose value is a *shape* instead of a behaviour, and
 * `refuseInjection` for the page the browser will not load the file into.
 */
function createInspectTabs({
  page = createInspectFixture().page,
  tabs = [createAgentTabFixture()],
  answer,
  refuseInjection,
} = {}) {
  return createTabsStub({
    tabs,
    pageAgent: { frames: [{ href: page.url, page }], answer, refuseInjection },
  });
}

/** The delivered elements of an answered `inspect` request, or a loud failure. */
function inspectElementsOf(socket, id) {
  const answer = responsesById(socket).get(id);
  assert.equal(answer.ok, true, `inspect ${id} was refused: ${JSON.stringify(answer.error)}`);
  return answer.result.elements;
}

test("inspect_withoutSelectorAndText_shouldAnswerInvalidParamsAndInjectNothing", async () => {
  // GIVEN a connected extension with a stored agent tab:
  const tabs = createInspectTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for elements without naming a filter,
  await sendInspect(socket, 2, {});

  // THEN it is refused before anything is injected — "list every element of the page"
  // is not a question this tool answers by accident,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "invalid_params");

  // ... and the same holds when no parameter object arrives at all.
  await sendInspect(socket, 3, undefined);
  assert.equal(responsesById(socket).get(3).error.code, "invalid_params");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("inspect_withAnOutOfRangeLimitOrAWrongType_shouldAnswerInvalidParamsAndInjectNothing", async () => {
  // GIVEN a connected extension and the refusals of the parameter table:
  const tabs = createInspectTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  const refused = [
    { text: "eintrag", limit: 0 },
    { text: "eintrag", limit: 201 },
    { text: "eintrag", limit: 2.5 },
    { text: "eintrag", limit: "5" },
    { text: "eintrag", includeHidden: "ja" },
    { selector: 42 },
  ];

  // WHEN each of them arrives — numbered from 2, so the answer stays attributable:
  let id = 2;
  for (const params of refused) {
    await sendInspect(socket, id, params);
    const answer = responsesById(socket).get(id);

    // THEN every one is `invalid_params`, named by its own case:
    assert.equal(answer.ok, false, `${JSON.stringify(params)} must be refused`);
    assert.equal(answer.error.code, "invalid_params", JSON.stringify(params));
    id += 1;
  }

  // ... and none of them reached the page.
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("inspect_withASelectorOnTheLink_shouldAnswerEveryFieldOfTheContract", async () => {
  // GIVEN the invented page and a selector that names its one link:
  const { page } = createInspectFixture();
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for that element,
  await sendInspect(socket, 2, { selector: "a#warenkorb-link" });

  // THEN the answer carries the six result fields and the eleven element fields, each
  // with the value the invented page really has:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(answer.result, {
    tabId: 500,
    url: AGENT_URL,
    title: "Erfundene Abfrageseite",
    count: 1,
    truncated: false,
    elements: [
      {
        index: 0,
        selector: "a#warenkorb-link",
        tag: "a",
        id: "warenkorb-link",
        classes: ["knopf", "knopf--wichtig"],
        text: "Erfundener Warenkorb",
        href: "https://example.org/warenkorb",
        ariaLabel: null,
        visible: true,
        disabled: false,
        rect: { x: 0, y: 0, width: 100, height: 20 },
      },
    ],
  });

  // ... and it came from exactly one injection, in the main frame, when the page is
  // idle — the same two fields a read records.
  assert.equal(tabs.scriptCalls.length, 1);
  assert.equal(tabs.scriptCalls[0].tabId, 500);
  assert.deepStrictEqual(tabs.scriptCalls[0].details.target, { tabId: 500, frameIds: [0] });
  assert.deepStrictEqual(tabs.scriptCalls[0].details.files, [PAGE_AGENT_FILE]);
});

test("inspect_withoutIdAndWithoutHref_shouldDeliverNullInsteadOfAnEmptyString", async () => {
  // GIVEN the span that carries no identity hook at all, a link whose markup has no
  // `href`, and the link that does have an id — the real DOM answers `""` for both
  // missing properties, never `null`, which is what makes a bare type check useless:
  const { cartLink, plainSpan } = createInspectFixture();
  assert.equal(plainSpan.id, "", "the fixture must model the DOM, which answers an empty string");
  const hrefLessLink = createInspectElement({ tagName: "A", innerText: "Ohne Ziel", href: "" });
  const page = createInspectPage({ children: [cartLink, plainSpan, hrefLessLink] });
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN everything on that page is listed,
  await sendInspect(socket, 2, { text: "", limit: 200 });

  // THEN a missing id and a missing link arrive as `null` — not as `""`, which would
  // make "a link whose id is not null" match every delivered element:
  const delivered = inspectElementsOf(socket, 2);
  assert.equal(delivered.length, 3);
  assert.deepStrictEqual(
    delivered.map((entry) => entry.tag),
    ["a", "span", "a"],
  );
  assert.deepStrictEqual(
    delivered.map((entry) => entry.id),
    ["warenkorb-link", null, null],
  );
  assert.deepStrictEqual(
    delivered.map((entry) => entry.href),
    ["https://example.org/warenkorb", null, null],
  );
});

test("inspect_deliveredSelectors_shouldEachRoundTripToTheirOwnElement", async () => {
  // GIVEN the invented page, in document order, with the element that carries nothing
  // to grab on at all — no id, no class, no `data-testid`, one span between two divs:
  const { page, cartLink, firstParagraph, secondParagraph, firstKnopf, plainSpan, secondKnopf, listBox, nestedEntry } =
    createInspectFixture();
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN everything is listed — an empty text filter matches every element, and the
  // limit is wide enough to deliver the whole page,
  await sendInspect(socket, 2, { text: "", limit: 200 });

  // THEN every delivered selector finds exactly its own element again — the round trip
  // is the whole point of the field, and `deepStrictEqual` on the handle is the identity
  // of the element, not its description:
  const delivered = inspectElementsOf(socket, 2);
  const expected = [
    cartLink,
    firstParagraph,
    secondParagraph,
    firstKnopf,
    plainSpan,
    secondKnopf,
    listBox,
    nestedEntry,
  ];
  assert.equal(delivered.length, expected.length);
  for (const [position, element] of expected.entries()) {
    assert.equal(querySelectorIn(page, delivered[position].selector), element, delivered[position].selector);
  }

  // ... the ambiguous siblings fell through to the path instead of claiming `div.knopf`,
  // and the element without any identity hook is a path of `:nth-of-type` steps:
  assert.equal(delivered[3].selector, "html > body > div:nth-of-type(1)");
  assert.equal(delivered[4].selector, "html > body > span:nth-of-type(1)");
  assert.equal(delivered[1].selector, "html > body > p:nth-of-type(1)");
  assert.equal(delivered[7].selector, "span.eintrag");
});

test("inspect_withTextSearch_shouldFindTheSameElementCaseInsensitively", async () => {
  // GIVEN the invented page and a search text in the other case than the page uses:
  const { page, cartLink } = createInspectFixture();
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge searches for `ERFUNDENER WARENKORB` while the page says
  // `Erfundener Warenkorb`,
  await sendInspect(socket, 2, { text: "ERFUNDENER WARENKORB" });

  // THEN the same element comes back as through the selector — and the selector is the
  // one a caller can hand to `click`:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.count, 1);
  assert.equal(answer.result.truncated, false);
  assert.equal(answer.result.elements.length, 1);
  assert.equal(answer.result.elements[0].text, cartLink.innerText);
  assert.equal(answer.result.elements[0].selector, "a#warenkorb-link");
});

test("inspect_withALimit_shouldCutTheElementsAndSetTruncated", async () => {
  // GIVEN the invented page, in which three elements carry the same word — the link
  // and both paragraphs — and a caller that asks for one of them:
  const { page } = createInspectFixture();
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the search says `limit: 1` while three elements match `erfundener` — the link
  // and both paragraphs,
  await sendInspect(socket, 2, { text: "erfundener", limit: 1 });

  // THEN one element is delivered, `count` still says three (it counts before the cut)
  // and `truncated` says there was more:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.count, 3);
  assert.equal(answer.result.truncated, true);
  assert.equal(answer.result.elements.length, 1);
  assert.equal(answer.result.elements[0].index, 0);
});

test("inspect_withMoreCandidatesThanTheCap_shouldStopAtTheCapAndSetTruncated", async () => {
  // GIVEN a page with one candidate more than the cap allows to examine — five
  // thousand are examined, the rest never is:
  const children = [];
  for (let position = 0; position <= INSPECT_CANDIDATE_LIMIT; position += 1) {
    children.push(createInspectElement({ tagName: "P", innerText: `Erfundener Eintrag ${position}` }));
  }
  const page = createInspectPage({ children });
  const tabs = createInspectTabs({ page });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the selector path asks for everything (the document, `<html>` included, holds
  // 5002 elements),
  await sendInspect(socket, 2, { selector: "*", limit: 2 });

  // THEN it stops at the cap and says so — `count` is a lower bound from here on:
  const bySelector = responsesById(socket).get(2).result;
  assert.equal(bySelector.count, INSPECT_CANDIDATE_LIMIT);
  assert.equal(bySelector.truncated, true);
  assert.equal(bySelector.elements.length, 2);

  // ... and the text path caps the same way, with the same number: the cap counts
  // examined candidates, not hits per path.
  await sendInspect(socket, 3, { text: "erfundener eintrag", limit: 2 });
  const byText = responsesById(socket).get(3).result;
  assert.equal(byText.count, INSPECT_CANDIDATE_LIMIT);
  assert.equal(byText.truncated, true);
  assert.equal(byText.elements.length, 2);

  // ... the cap is a second reason for `truncated`, on its own: one single hit is
  // delivered in full here, and the answer must still say that more was there because
  // the last candidates were never examined.
  await sendInspect(socket, 4, { text: "erfundener eintrag 4999", limit: 200 });
  const singleHit = responsesById(socket).get(4).result;
  assert.equal(singleHit.count, 1);
  assert.equal(singleHit.elements.length, 1);
  assert.equal(singleHit.truncated, true);

  // ... and no request left a timer behind: the cap bounds the work, it does not
  // schedule anything.
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("inspect_withTextOverTwoHundredCharacters_shouldCutAndFlattenNewlines", async () => {
  // GIVEN an element whose visible text is longer than the cut and carries a line
  // break, plus an id, a link and a label of the same length:
  const longValue = `erfunden-${"x".repeat(INSPECT_TEXT_LIMIT + 60)}`;
  const innerText = `Erfundene Zeile\n${longValue}`;
  const element = createInspectElement({
    tagName: "P",
    id: longValue,
    innerText,
    href: `https://example.org/${longValue}`,
    attributes: { "aria-label": longValue },
  });
  const page = createInspectPage({ children: [element] });
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge searches for the first line of that text,
  await sendInspect(socket, 2, { text: "erfundene zeile" });

  // THEN the delivered strings are cut to 200 characters, and the line break is a space
  // before the cut — the answer is one line per field, not a paragraph:
  const [delivered] = inspectElementsOf(socket, 2);
  assert.equal(delivered.text, innerText.replace("\n", " ").slice(0, INSPECT_TEXT_LIMIT));
  assert.equal(delivered.text.length, INSPECT_TEXT_LIMIT);
  assert.equal(delivered.text.includes("\n"), false);
  assert.equal(delivered.id.length, INSPECT_TEXT_LIMIT);
  assert.equal(delivered.href.length, INSPECT_TEXT_LIMIT);
  assert.equal(delivered.ariaLabel.length, INSPECT_TEXT_LIMIT);
});

test("inspect_withAnEmptySelector_shouldAnswerInvalidSelector", async () => {
  // GIVEN the invented page, whose `querySelectorAll` throws for the empty selector like
  // a browser does,
  const { page } = createInspectFixture();
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge sends an empty selector,
  await sendInspect(socket, 2, { selector: "" });

  // THEN every string reaches the page, the empty one included — the page decides what
  // it means, and it decided "invalid":
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "invalid_selector");
  assert.equal(tabs.scriptCalls.length, 1);
});

/* ------------------------------------------------- inspect: `>>>` jumps */


test("inspect_withAPiercingSelectorInAnAttributeValue_shouldNotSplit", async () => {
  // GIVEN the invented page and a selector whose only `>>>` sits inside an attribute
  // value — one selector, and no jump at all,
  const { page } = createInspectFixture();
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge inspects it,
  await sendInspect(socket, 2, { selector: '[title="a>>>b"]' });

  // THEN the document was asked exactly once, with the whole string — not twice, with
  // `[title="a` and `b"]`:
  assert.deepStrictEqual(page.queries, ['[title="a>>>b"]']);

  // ... and the answer is the refusal the harness matcher gives for a form outside its
  // grammar. Spelled out on purpose: this case is about *which* string reached the page,
  // and the fake matcher knows no attribute-value form at all — a real page would answer
  // its (empty) hit list here.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "invalid_selector");
  assert.equal(answer.error.message, "The selector is invalid.");
  assert.equal(answer.result, undefined);
});

test("inspect_withAChainOfEmptySegments_shouldAnswerInvalidSelector", async () => {
  // GIVEN the three ways to write a jump with no selector on one of its sides:
  const { page } = createInspectFixture();
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  const refused = [">>> b", "a >>> ", "a >>> >>> b"];

  // WHEN each of them arrives,
  let id = 2;
  for (const selector of refused) {
    await sendInspect(socket, id, { selector });

    // THEN it is a refusal and not an empty hit list, named by its own case:
    const answer = responsesById(socket).get(id);
    assert.equal(answer.ok, false, `${JSON.stringify(selector)} must be refused`);
    assert.equal(answer.error.code, "invalid_selector", JSON.stringify(selector));
    assert.equal(answer.result, undefined, JSON.stringify(selector));
    id += 1;
  }

  // ... and the page was never searched: the split fails before the first query.
  assert.deepStrictEqual(page.queries, []);
});

test("inspect_withACombinatorLeftOfTheJump_shouldAnswerInvalidSelector", async () => {
  // GIVEN a jump whose left side is a descendant combinator or a group — selectors the
  // browser understands and the whitelist does not,
  const { page } = createInspectFixture();
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  const refused = ["div span >>> b", "a, b >>> c"];

  // WHEN each of them arrives,
  let id = 2;
  for (const selector of refused) {
    await sendInspect(socket, id, { selector });

    // THEN the whole chain is refused instead of being silently narrowed to its leftmost
    // simple part:
    const answer = responsesById(socket).get(id);
    assert.equal(answer.ok, false, `${JSON.stringify(selector)} must be refused`);
    assert.equal(answer.error.code, "invalid_selector", JSON.stringify(selector));
    id += 1;
  }

  // ... and no search happened, for the same reason as above.
  assert.deepStrictEqual(page.queries, []);
});

test("inspect_withACombinatorRightOfTheJump_shouldAnswerInvalidSelector", async () => {
  // GIVEN a jump whose right side is a descendant combinator,
  const { page } = createInspectFixture();
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge inspects it,
  await sendInspect(socket, 2, { selector: "my-card >>> div span" });

  // THEN it is refused as well: the right side of a jump is one simple selector, exactly
  // like the left one — the operator's decision of 2026-10-29, not an oversight,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "invalid_selector");

  // ... and the page was not asked: a combinator on either side falls before the query.
  assert.deepStrictEqual(page.queries, []);
});

test("inspect_withAPiercingSelectorAndAFrame_shouldAnswerNotTheFrame", async () => {
  // GIVEN the two frames of spec 25 and a selector that jumps,
  const { tabs } = createFramedInspectTabs(createFramedInspectPages());
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge inspects the widget through that selector,
  await sendInspect(socket, 2, { selector: "my-card >>> button", frame: "widget" });

  // THEN the frame nobody addressed answers the marker and asks nothing — the frame gate
  // is the first statement of the *jumping* op too, not only of the plain one,
  assert.deepStrictEqual(inThisRealm(tabs.channel.answers[0].message.value), {
    outcome: "not_the_frame",
    href: AGENT_URL,
  });

  // ... and the answer is the addressed frame's own, not the tab's.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.url, "https://widget.example.net/kalender");
  assert.equal(answer.result.count, 0);
  assert.deepStrictEqual(inThisRealm(answer.result.elements), []);
});


/* ----------------------------------- inspect: the walk through shadow trees */

/**
 * One `<my-card>` whose content lives in its own tree.
 *
 * `open: false` builds the host without a tree, which is exactly what a script sees for
 * `mode: "closed"` — and what it sees for a host whose definition has not run yet. The
 * two are indistinguishable from the inside, and both mean "no hit", never an error.
 * Every case built on the closed shape has its open twin next to it: a case that would
 * also pass on a snippet that walks nowhere proves nothing.
 */
function createShadowCard({ id = "karte", open = true, children = [] } = {}) {
  return createInspectElement({
    tagName: "MY-CARD",
    id,
    shadowRoot: open ? createShadowRoot({ children }) : null,
  });
}

test("inspect_withAPiercingSelector_shouldReachTheButtonInsideTheOpenShadowRoot", async () => {
  // GIVEN a card whose only button sits in its open shadow tree, and no button in the
  // document at all — what the document answers is therefore not a coincidence:
  const button = createInspectElement({ tagName: "BUTTON", innerText: "Knopf im Schatten" });
  const card = createShadowCard({ children: [button] });
  const page = createInspectPage({ children: [card] });
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge jumps into that tree,
  await sendInspect(socket, 2, { selector: "my-card >>> button" });

  // THEN the button comes back with its own tag and its own text,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.count, 1);
  assert.equal(answer.result.truncated, false);
  assert.deepStrictEqual(
    answer.result.elements.map((entry) => [entry.tag, entry.text]),
    [["button", "Knopf im Schatten"]],
  );

  // ... the first segment went to the document and the second to the tree, never the
  // other way round,
  assert.equal(page.queries[0], "my-card");
  assert.equal(page.queries.includes("button"), false, "the document never sees the second segment");
  assert.equal(card.shadowRoot.queries[0], "button");

  // ... and the returned selector names both sides of the jump, so a caller can hand it
  // straight back.
  assert.equal(answer.result.elements[0].selector, "my-card#karte >>> button:nth-of-type(1)");
});

test("inspect_withoutAPiercingSelector_shouldNotSeeIt", async () => {
  // GIVEN the same card with the same button in its open shadow tree:
  const button = createInspectElement({ tagName: "BUTTON", innerText: "Knopf im Schatten" });
  const card = createShadowCard({ children: [button] });
  const page = createInspectPage({ children: [card] });
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks without a jump,
  await sendInspect(socket, 2, { selector: "button" });

  // THEN the answer is empty and no error — `document.querySelectorAll` does not look
  // into a shadow tree, and without the syntax nothing changes:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.count, 0);
  assert.equal(answer.result.truncated, false);
  assert.deepStrictEqual(answer.result.elements, []);

  // ... and the tree was not asked anything, which is the half an empty list alone
  // cannot prove.
  assert.deepStrictEqual(card.shadowRoot.queries, []);
});

test("inspect_withThreeJumps_shouldAnswerTheEndpointOfTheThird", async () => {
  // GIVEN a card whose tree holds a second component, whose own tree holds the button —
  // two jumps deep, so a walk that stopped after one would answer nothing:
  const deepButton = createInspectElement({ tagName: "BUTTON", innerText: "Tiefer Knopf" });
  const innerPart = createInspectElement({
    tagName: "INNER-PART",
    shadowRoot: createShadowRoot({ children: [deepButton] }),
  });
  const card = createShadowCard({ children: [innerPart] });
  const page = createInspectPage({ children: [card] });
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge jumps twice,
  await sendInspect(socket, 2, { selector: "my-card >>> inner-part >>> button" });

  // THEN the endpoint of the third segment comes back,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.count, 1);
  assert.deepStrictEqual(
    answer.result.elements.map((entry) => [entry.tag, entry.text]),
    [["button", "Tiefer Knopf"]],
  );

  // ... the selector carries both jumps, one host chain in front of the local part,
  assert.equal(
    answer.result.elements[0].selector,
    "my-card#karte >>> inner-part:nth-of-type(1) >>> button:nth-of-type(1)",
  );

  // ... and every jump was asked of the tree that owns it, in order.
  assert.deepStrictEqual(card.shadowRoot.queries, ["inner-part", "inner-part:nth-of-type(1)"]);
  assert.deepStrictEqual(innerPart.shadowRoot.queries, ["button", "button:nth-of-type(1)"]);
});

test("inspect_withAClosedShadowRoot_shouldAnswerCountZero", async () => {
  // GIVEN a card whose content is in a tree no script may enter — `mode: "closed"` looks
  // exactly like a host without a tree,
  const button = createInspectElement({ tagName: "BUTTON", innerText: "Knopf im Schatten" });
  const closedCard = createShadowCard({ open: false, children: [button] });
  const closedPage = createInspectPage({ children: [closedCard] });
  const closedTabs = createInspectTabs({ page: closedPage });
  const closedSession = await connectedBackground({ tabs: closedTabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge jumps at it,
  await sendInspect(closedSession.socket, 2, { selector: "my-card >>> button" });

  // THEN there is no hit and no error — the honest answer is "not reachable", and the
  // reason (closed, or not upgraded yet) is not reportable:
  const closed = responsesById(closedSession.socket).get(2);
  assert.equal(closed.ok, true);
  assert.equal(closed.result.count, 0);
  assert.equal(closed.result.truncated, false);
  assert.deepStrictEqual(closed.result.elements, []);

  // ... and the open twin of the very same card answers the button, so this case is not
  // green on a snippet that never walks anywhere:
  const openButton = createInspectElement({ tagName: "BUTTON", innerText: "Knopf im Schatten" });
  const openCard = createShadowCard({ open: true, children: [openButton] });
  const openPage = createInspectPage({ children: [openCard] });
  const openTabs = createInspectTabs({ page: openPage });
  const openSession = await connectedBackground({ tabs: openTabs, settings: STORED_TAB_SETTINGS });
  await sendInspect(openSession.socket, 2, { selector: "my-card >>> button" });
  const open = responsesById(openSession.socket).get(2);
  assert.equal(open.result.count, 1);
  assert.equal(open.result.elements[0].text, "Knopf im Schatten");
});

test("inspect_withAnElementWithoutAShadowRootInTheMiddle_shouldAnswerCountZero", async () => {
  // GIVEN a jump whose middle element carries no tree at all — a wrapper inside the
  // card's root, one level above the button:
  const button = createInspectElement({ tagName: "BUTTON", innerText: "Tiefer Knopf" });
  const middle = createInspectElement({ tagName: "DIV", id: "mitte" });
  const card = createShadowCard({ children: [middle] });
  const page = createInspectPage({ children: [card] });
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for a button behind it,
  await sendInspect(socket, 2, { selector: "my-card >>> div >>> button" });

  // THEN this path ends without a hit and without an error,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.count, 0);
  assert.deepStrictEqual(answer.result.elements, []);

  // ... and it ended before any endpoint was described: the only selector built is the
  // host's, and not one for a path that leads nowhere.
  assert.deepStrictEqual(page.queries, ["my-card", "my-card#karte"]);

  // ... while the twin with an open tree on that same middle element finds the button.
  const openButton = createInspectElement({ tagName: "BUTTON", innerText: "Tiefer Knopf" });
  const openMiddle = createInspectElement({
    tagName: "DIV",
    id: "mitte",
    shadowRoot: createShadowRoot({ children: [openButton] }),
  });
  const openCard = createShadowCard({ children: [openMiddle] });
  const openPage = createInspectPage({ children: [openCard] });
  const openTabs = createInspectTabs({ page: openPage });
  const openSession = await connectedBackground({ tabs: openTabs, settings: STORED_TAB_SETTINGS });
  await sendInspect(openSession.socket, 2, { selector: "my-card >>> div >>> button" });
  const open = responsesById(openSession.socket).get(2);
  assert.equal(open.result.count, 1);
  assert.equal(open.result.elements[0].text, "Tiefer Knopf");
});

test("inspect_withTwoCards_shouldAnswerBothButtonsInExpansionOrder", async () => {
  // GIVEN two cards, each with one button in its own tree,
  const firstCardButton = createInspectElement({ tagName: "BUTTON", innerText: "Karte-1-Knopf" });
  const secondCardButton = createInspectElement({ tagName: "BUTTON", innerText: "Karte-2-Knopf" });
  const firstCard = createShadowCard({ id: "karte-1", children: [firstCardButton] });
  const secondCard = createShadowCard({ id: "karte-2", children: [secondCardButton] });
  const page = createInspectPage({ children: [firstCard, secondCard] });
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge jumps at both of them,
  await sendInspect(socket, 2, { selector: "my-card >>> button" });

  // THEN the answer is a set, not a single hit — one endpoint per host, in the order the
  // hosts were found:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.count, 2);
  assert.deepStrictEqual(
    answer.result.elements.map((entry) => entry.text),
    ["Karte-1-Knopf", "Karte-2-Knopf"],
  );

  // ... and `limit` cuts the delivery while `count` keeps the truth, as everywhere else.
  await sendInspect(socket, 3, { selector: "my-card >>> button", limit: 1 });
  const limited = responsesById(socket).get(3).result;
  assert.equal(limited.count, 2);
  assert.equal(limited.elements.length, 1);
  assert.equal(limited.truncated, true);

  // GIVEN two buttons in the first tree and one in the second,
  const twoThenOne = [
    createInspectElement({ tagName: "BUTTON", innerText: "A-1" }),
    createInspectElement({ tagName: "BUTTON", innerText: "A-2" }),
  ];
  const oneEntry = createInspectElement({ tagName: "BUTTON", innerText: "B-1" });
  const fanOutPage = createInspectPage({
    children: [
      createShadowCard({ id: "karte-a", children: twoThenOne }),
      createShadowCard({ id: "karte-b", children: [oneEntry] }),
    ],
  });
  const fanOutTabs = createInspectTabs({ page: fanOutPage });
  const fanOutSession = await connectedBackground({ tabs: fanOutTabs, settings: STORED_TAB_SETTINGS });

  // WHEN the same jump is asked,
  await sendInspect(fanOutSession.socket, 2, { selector: "my-card >>> button" });

  // THEN the order is the expansion order of the hosts, each tree in its own order: the
  // two of the first tree before the one of the second, not interleaved.
  assert.deepStrictEqual(
    responsesById(fanOutSession.socket)
      .get(2)
      .result.elements.map((entry) => entry.text),
    ["A-1", "A-2", "B-1"],
  );
});

test("inspect_withTwoEqualSiblingsInOneRoot_shouldAnswerNthOfTypeTwo", async () => {
  // GIVEN two siblings in one tree that nothing tells apart but their position — the
  // case in which a position counted from `parentElement` would call both of them the
  // first:
  const firstButton = createInspectElement({ tagName: "BUTTON", className: "knopf", innerText: "Erster Knopf" });
  const secondButton = createInspectElement({ tagName: "BUTTON", className: "knopf", innerText: "Zweiter Knopf" });
  const card = createShadowCard({ children: [firstButton, secondButton] });
  const page = createInspectPage({ children: [card] });
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for both of them,
  await sendInspect(socket, 2, { selector: "my-card >>> button" });

  // THEN each one is named by its own position in that tree:
  const answer = responsesById(socket).get(2).result;
  assert.deepStrictEqual(
    answer.elements.map((entry) => entry.selector),
    ["my-card#karte >>> button:nth-of-type(1)", "my-card#karte >>> button:nth-of-type(2)"],
  );

  // ... the two names differ, which is the whole point, and the second one finds the
  // second element again instead of the first, while the class form alone would have
  // been ambiguous:
  await sendInspect(socket, 3, { selector: answer.elements[1].selector });
  const again = responsesById(socket).get(3).result;
  assert.equal(again.count, 1);
  assert.equal(again.elements[0].text, "Zweiter Knopf");
});

test("inspect_withAFanOutPastTheCap_shouldAnswerTruncated", async () => {
  // GIVEN one host whose tree holds one element more than the cap allows to examine,
  // each of them with an id so that the delivered two need no positional search:
  const buttons = [];
  for (let position = 0; position <= INSPECT_CANDIDATE_LIMIT; position += 1) {
    buttons.push(createInspectElement({ tagName: "BUTTON", id: `knopf-${position}`, innerText: `Knopf ${position}` }));
  }
  const page = createInspectPage({ children: [createShadowCard({ children: buttons })] });
  const tabs = createInspectTabs({ page });
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the jump meets that fan-out,
  await sendInspect(socket, 2, { selector: "my-card >>> button", limit: 2 });

  // THEN the cap stops the walk and says so — `count` is a lower bound from here on:
  const byHits = responsesById(socket).get(2).result;
  assert.equal(byHits.count, INSPECT_CANDIDATE_LIMIT);
  assert.equal(byHits.truncated, true);
  assert.equal(byHits.elements.length, 2);

  // ... and no request left a timer behind: the cap bounds the work, it schedules none.
  assert.deepStrictEqual(clock.pendingDelays(), []);

  // GIVEN a jump whose *middle* stage fans out past the cap — five thousand and one
  // wrappers in one tree, none of which carries a tree of its own:
  const wrappers = [];
  for (let position = 0; position <= INSPECT_CANDIDATE_LIMIT; position += 1) {
    wrappers.push(createInspectElement({ tagName: "DIV", className: "zeile" }));
  }
  const deepPage = createInspectPage({ children: [createShadowCard({ children: wrappers })] });
  const deepTabs = createInspectTabs({ page: deepPage });
  const deepSession = await connectedBackground({ tabs: deepTabs, settings: STORED_TAB_SETTINGS });

  // WHEN the chain asks one step further than the cap may carry,
  await sendInspect(deepSession.socket, 2, { selector: "my-card >>> div.zeile >>> button" });

  // THEN the cap holds on the intermediate stage as well: nothing was delivered, and the
  // answer still says that more was there instead of pretending to be complete.
  const betweenStages = responsesById(deepSession.socket).get(2).result;
  assert.equal(betweenStages.count, 0);
  assert.equal(betweenStages.truncated, true);
  assert.deepStrictEqual(betweenStages.elements, []);

  // ... and the dropped endpoints cost nothing: the only selector built is the one for
  // the container, not one for any of the five thousand that were never delivered.
  assert.deepStrictEqual(deepPage.queries, ["my-card", "my-card#karte"]);
});

test("inspect_withTheSelectorOfAShadowHit_shouldFindTheSameElementAgain", async () => {
  // GIVEN two identical siblings one level down in an open tree — visible from that tree
  // and from nowhere else, which is what separates a root-checked candidate from a
  // document-checked one:
  const firstButton = createInspectElement({ tagName: "BUTTON", className: "knopf", innerText: "Erster Knopf" });
  const secondButton = createInspectElement({ tagName: "BUTTON", className: "knopf", innerText: "Zweiter Knopf" });
  const wrap = createInspectElement({ tagName: "DIV", className: "leiste", children: [firstButton, secondButton] });
  const card = createShadowCard({ children: [wrap] });
  const page = createInspectPage({ children: [card] });
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge jumps in and asks for the buttons,
  await sendInspect(socket, 2, { selector: "my-card >>> button" });

  // THEN the second one is named by a selector that is a chain of simple selectors, so a
  // jump can carry it again,
  const first = responsesById(socket).get(2).result;
  assert.equal(first.count, 2);
  const selector = first.elements[1].selector;
  assert.equal(selector, "my-card#karte >>> button:nth-of-type(2)");

  // ... and handed back it finds the very same element. Against the document, every
  // candidate is invisible from here and the builder would have fallen back to a `>`
  // path, which `inspect` refuses as a segment of a chain.
  await sendInspect(socket, 3, { selector });
  const again = responsesById(socket).get(3);
  assert.equal(again.ok, true);
  assert.equal(again.result.count, 1);
  assert.equal(again.result.elements[0].text, "Zweiter Knopf");
  assert.equal(again.result.elements[0].selector, selector);
});

test("inspect_withAShadowHit_shouldDeliverTheSameFieldSetAsADocumentHit", async () => {
  // GIVEN a document button and a shadow button on the same page, so both paths answer
  // from one page and one snippet version:
  const shadowButton = createInspectElement({ tagName: "BUTTON", innerText: "Knopf im Schatten" });
  const card = createShadowCard({ children: [shadowButton] });
  const documentButton = createInspectElement({ tagName: "BUTTON", id: "draussen", innerText: "Knopf im Dokument" });
  const page = createInspectPage({ children: [card, documentButton] });
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN both hits are asked for,
  await sendInspect(socket, 2, { selector: "button#draussen" });
  await sendInspect(socket, 3, { selector: "my-card >>> button" });

  // THEN the delivered field sets are identical — the shadow snippet carries a copy of
  // the delivery tail, and this is the brake on the two copies drifting apart:
  const fromDocument = responsesById(socket).get(2).result.elements[0];
  const fromShadow = responsesById(socket).get(3).result.elements[0];
  assert.deepStrictEqual(Object.keys(fromShadow), Object.keys(fromDocument));
  assert.equal(Object.keys(fromShadow).length, 11);
});

test("inspect_withAnEmptyText_shouldMatchEveryElementAndBeCutByTheLimit", async () => {
  // GIVEN the invented page with its eight body descendants:
  const { page } = createInspectFixture();
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the text filter is the empty string — set, and therefore a filter that matches
  // everything,
  await sendInspect(socket, 2, { text: "", limit: 2 });

  // THEN every candidate is a hit, and the limit cuts the delivery while `count` keeps
  // the truth:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.count, 8);
  assert.equal(answer.result.elements.length, 2);
  assert.equal(answer.result.truncated, true);
});

test("inspect_withoutIncludeHidden_shouldOmitTheInvisibleElementAndNameItWithTheOption", async () => {
  // GIVEN a page with a visible and an invisible paragraph — the second one is
  // `display: none` and therefore out of `count`:
  const visibleEntry = createInspectElement({ tagName: "P", innerText: "Sichtbarer Eintrag" });
  const hiddenEntry = createInspectElement({ tagName: "P", innerText: "Versteckter Eintrag", display: "none" });
  const page = createInspectPage({ children: [visibleEntry, hiddenEntry] });
  const tabs = createInspectTabs({ page });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge searches with the default,
  await sendInspect(socket, 2, { text: "eintrag" });

  // THEN the invisible element is not counted — the visibility filter comes first:
  const withoutHidden = responsesById(socket).get(2).result;
  assert.equal(withoutHidden.count, 1);
  assert.equal(withoutHidden.elements.length, 1);
  assert.equal(withoutHidden.elements[0].visible, true);

  // ... and with the option it appears, marked as what it is:
  await sendInspect(socket, 3, { text: "eintrag", includeHidden: true });
  const withHidden = responsesById(socket).get(3).result;
  assert.equal(withHidden.count, 2);
  assert.deepStrictEqual(
    withHidden.elements.map((entry) => entry.visible),
    [true, false],
  );
});

test("inspect_withAnUnusableResultShape_shouldAnswerInspectFailedWithoutPageContent", async () => {
  // GIVEN injections that resolve with shapes no caller can read — an empty slot, a
  // result without `count`, and a `elements` that is not a list:
  const shapes = [
    [undefined],
    [{ outcome: "ok", url: AGENT_URL, title: "Erfundene Abfrageseite" }],
    [{ outcome: "ok", url: AGENT_URL, title: "Erfundene Abfrageseite", count: 0, elements: "keine Liste" }],
  ];
  let injection = 0;
  const tabs = createInspectTabs({ answer: () => ({ value: shapes[injection++] }) });
  const { socket, consoleLines } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN each of them comes back,
  let id = 2;
  for (let index = 0; index < shapes.length; index += 1) {
    await sendInspect(socket, id, { text: "eintrag" });

    // THEN it is our own bug and not the page's, with the warning that makes it findable:
    const answer = responsesById(socket).get(id);
    assert.equal(answer.ok, false);
    assert.equal(answer.error.code, "inspect_failed");
    id += 1;
  }
  assert.ok(
    consoleLines.includes("warn: bc: inspect result without usable elements"),
    `the warning is missing:\n${consoleLines.join("\n")}`,
  );
});

test("inspect_whenTheSnippetThrows_shouldAnswerNotReadable", async () => {
  // GIVEN a page whose document refuses one of the fields the snippet reads, so the
  // snippet throws inside the page realm — a rejection of `executeScript`:
  const page = createInspectFixture().page;
  Object.defineProperty(page, "title", {
    get() {
      throw new Error("Erfundener Seitenfehler");
    },
  });
  const tabs = createInspectTabs({ page, tabs: [createAgentTabFixture({ status: "complete" })] });
  const { socket, consoleLines } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for elements,
  await sendInspect(socket, 2, { text: "eintrag" });

  // THEN it is `not_readable` — `injectPageCode` decides that for a tab that is not
  // loading, and `inspect_failed` stays reserved for a shape we cannot read,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "not_readable");

  // ... and no warning of ours fires for a page that failed its own snippet.
  assert.ok(
    !consoleLines.some((line) => line.includes("inspect result without usable elements")),
    "a refusal of the page is not a warning of ours",
  );
});

test("inspect_whenTheTabIsStillLoading_shouldAnswerPageBusy", async () => {
  // GIVEN a tab that is still loading and an injection Firefox refuses in that
  // moment:
  const tabs = createInspectTabs({
    tabs: [createAgentTabFixture({ status: "loading" })],
    refuseInjection: true,
  });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for elements too early,
  await sendInspect(socket, 2, { text: "eintrag" });

  // THEN the fourth tool answers the same code as the other three — the decision
  // lives in `injectPageCode`, not in the request handler,
  const error = responsesById(socket).get(2).error;
  assert.equal(error.code, "page_busy");

  // ... and the frame carries no address or kind: those fields belong to
  // `not_readable`, and there is nothing to describe yet.
  assert.equal("url" in error, false);
  assert.equal("kind" in error, false);
});

test("inspect_whenTheInjectionIsRefusedByTheBrowser_shouldAnswerNotReadable", async () => {
  // GIVEN a page Firefox will not inject into — `about:`, a PDF viewer, AMO:
  const tabs = createInspectTabs({
    tabs: [createAgentTabFixture({ status: "complete" })],
    refuseInjection: true,
  });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for elements,
  await sendInspect(socket, 2, { text: "eintrag" });

  // THEN it is the same code `read` answers for that page — nothing was listed, and that
  // is not our bug:
  assert.equal(responsesById(socket).get(2).error.code, "not_readable");
});

test("inspect_whenTheInjectionIsRefusedByTheBrowser_shouldCarryTheAddressAndKindOfTheTab", async () => {
  // GIVEN a page nobody can inject into, in a tab whose address names a PDF:
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ url: "https://example.org/agb.pdf", status: "complete" })],
    pageAgent: { frames: [{ href: "https://example.org/agb.pdf" }], refuseInjection: true },
  });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for elements,
  await sendInspect(socket, 2, { text: "eintrag" });

  // THEN the second error mapper builds the same frame as the first: one enricher, one
  // shape, whichever call reaches it:
  const error = responsesById(socket).get(2).error;
  assert.equal(error.code, "not_readable");
  assert.equal(error.url, "https://example.org/agb.pdf");
  assert.equal(error.kind, "pdf");
});

test("inspect_withoutAStoredAgentTab_shouldAnswerNoAgentTabAndInjectNothing", async () => {
  // GIVEN a connected extension that has never navigated — no agent tab, although the
  // operator's window has one:
  const tabs = createTabsStub({ tabs: [createAgentTabFixture()] });
  const { socket } = await connectedBackground({ tabs });

  // WHEN the bridge asks for elements,
  await sendInspect(socket, 2, { text: "eintrag" });

  // THEN there is no page to list, and nothing is injected:
  assert.equal(responsesById(socket).get(2).error.code, "no_agent_tab");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("inspect_withTab_shouldInspectThatTab", async () => {
  // GIVEN two agent tabs, 500 the last used one and 501 the one the request names,
  const tabs = createInspectTabs({ tabs: createTwoAgentTabs() });
  const { socket } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge lists the elements of tab 501 by name,
  await sendInspect(socket, 2, { text: "eintrag", tab: 501 });

  // THEN the one injection of the call ran there, and the answer names it:
  assert.equal(tabs.scriptCalls[0].tabId, 501);
  assert.equal(responsesById(socket).get(2).result.tabId, 501);
});

test("inspect_onANormalPage_shouldInjectExactlyOnceAndStartNoTimer", async () => {
  // GIVEN a normal inspect case:
  const tabs = createInspectTabs();
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the elements are listed,
  await sendInspect(socket, 2, { text: "eintrag" });

  // THEN one injection did the whole job — no second read, no slot and no wait, because
  // `inspect` changes nothing on the page,
  assert.equal(tabs.scriptCalls.length, 1);
  assert.equal(responsesById(socket).get(2).ok, true);

  // ... and no timer was started and no listener left behind.
  assert.deepStrictEqual(clock.pendingDelays(), []);
  assert.equal(tabs.listenerCount(), 0);
});

test("click_andType_travelAsOpsAndCarryNoCode", async () => {
  // GIVEN one click and one typing, each against its invented page:
  const clickTabs = createClickTabs();
  const click = await connectedBackground({ tabs: clickTabs, settings: STORED_TAB_SETTINGS });
  await sendClick(click.socket, 2, { selector: DEFAULT_CLICK_SELECTOR });
  click.clock.runNext();
  await settleAsyncWork();

  const typeTabs = createTypeTabs();
  const type = await connectedBackground({ tabs: typeTabs, settings: STORED_TAB_SETTINGS });
  await sendType(type.socket, 2, { selector: DEFAULT_TYPE_SELECTOR, text: DEFAULT_TYPE_TEXT });
  type.clock.runNext();
  await settleAsyncWork();

  // THEN every injection of both tools loaded the file and nothing else — no source
  // text rides on the wire any more (spec 45, criterion 1):
  for (const call of [...clickTabs.scriptCalls, ...typeTabs.scriptCalls]) {
    assert.deepStrictEqual(call.details.files, [PAGE_AGENT_FILE]);
    assert.deepStrictEqual(
      Object.keys(call.details).sort(),
      ["files", "target"],
      "no snippet source may be injected any more",
    );
  }

  // ... the click sent its selector and the frame filter, and nothing else,
  assert.deepStrictEqual(inThisRealm(clickTabs.channel.calls[0].message), {
    callId: clickTabs.channel.calls[0].message.callId,
    op: "click",
    args: { selector: DEFAULT_CLICK_SELECTOR, want: null },
  });

  // ... the typing sent the whole request as plain JSON plus the filter, the password
  // switch included, so the page needs no message of its own for it,
  assert.deepStrictEqual(inThisRealm(typeTabs.channel.calls[0].message.args), {
    request: {
      selector: DEFAULT_TYPE_SELECTOR,
      text: DEFAULT_TYPE_TEXT,
      submit: false,
      allowPasswordFields: false,
    },
    want: null,
  });

  // ... and the selector builder of `inspect` is in neither op — it belongs to that
  // tool's own snippet and would be dead weight in the page agent's click and type.
  for (const call of [...clickTabs.channel.calls, ...typeTabs.channel.calls]) {
    assert.equal(JSON.stringify(call.message.args).includes("selectorForElement"), false);
  }
});

/* ------------------------------------------------------------------ focus */

/**
 * One `focus` case: the shared call list and a stub holding the stored agent tab.
 *
 * The array is handed to the tab stub *and* to `connectedBackground`, which is what
 * makes `tabs.update`, `windows.update` and `windows.get` land in one list — only
 * that proves the order the spec pins.
 */
function createFocusFixture(options = {}) {
  const calls = [];
  const tabs = createTabsStub({
    calls,
    tabs: [createAgentTabFixture()],
    // A navigation waits through the settle op, and this stub is what a page says about
    // its own quiet: the pair that means "no statement" keeps every pinned answer here
    // unchanged.
    pageAgent: { frames: [{ href: AGENT_URL, page: DEFAULT_READ_PAGE }], answer: settleCannedAnswer() },
    ...options,
  });
  return { calls, tabs };
}

test("focus_withoutAStoredAgentTab_shouldAnswerNoAgentTabAndUpdateNothing", async () => {
  // GIVEN a connected extension that has never navigated — no stored id, although
  // the operator's window has a tab:
  const calls = [];
  const tabs = createTabsStub({ calls, tabs: [createAgentTabFixture()] });
  const { socket } = await connectedBackground({ tabs, calls });

  // WHEN the bridge asks to bring the agent tab forward,
  await sendFocus(socket, 2);

  // THEN there is no agent tab at all,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "no_agent_tab");

  // ... and nothing was brought forward: picking any tab would show the operator a
  // page the agent never opened.
  assert.deepStrictEqual(tabs.calls, []);
});

test("focus_withAStoredTabThatIsGone_shouldAnswerNoAgentTabAndUpdateNothing", async () => {
  // GIVEN a stored id that points nowhere — the normal case after a restart:
  const calls = [];
  const tabs = createTabsStub({ calls });
  const { socket } = await connectedBackground({ tabs, calls, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to bring it forward,
  await sendFocus(socket, 2);

  // THEN it is the same answer as "never navigated", and neither call is tried
  // against an id that does not exist:
  assert.equal(responsesById(socket).get(2).error.code, "no_agent_tab");
  assert.deepStrictEqual(tabs.calls, []);
});

test("focus_withAStoredTabInAContainer_shouldAnswerNoAgentTabAndUpdateNothing", async () => {
  // GIVEN a stored tab in a multi-account container — logged in nowhere:
  const calls = [];
  const tabs = createTabsStub({
    calls,
    tabs: [createAgentTabFixture({ cookieStoreId: "firefox-container-1" })],
  });
  const { socket } = await connectedBackground({ tabs, calls, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to bring it forward,
  await sendFocus(socket, 2);

  // THEN the container is refused instead of being put in front of the operator:
  assert.equal(responsesById(socket).get(2).error.code, "no_agent_tab");
  assert.deepStrictEqual(tabs.calls, []);
});

test("focus_withTab_shouldFocusThatTab", async () => {
  // GIVEN two agent tabs in two windows: 500 is the last used one and lives in
  // window 1, 501 lives in window 2 and is reachable only by name:
  const calls = [];
  const tabs = createTabsStub({
    calls,
    tabs: [
      createAgentTabFixture(),
      createAgentTabFixture({ id: 501, windowId: 2, url: "https://zwei.example/", title: "Zwei" }),
    ],
  });
  const { socket } = await connectedBackground({ tabs, calls, settings: TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge brings tab 501 forward by name,
  await sendFocus(socket, 2, { tab: 501 });

  // THEN that tab comes forward and *its* window with it — the last used tab would
  // have been 500 in window 1, and focusing the wrong window is the whole risk here:
  assert.deepStrictEqual(tabs.calls, [
    { kind: "tabs.update", tabId: 501, changes: { active: true } },
    { kind: "windows.update", windowId: 2, changes: { focused: true } },
    { kind: "windows.get", windowId: 2 },
  ]);

  // ... and the answer describes that tab, not the last used one.
  assert.equal(responsesById(socket).get(2).result.tabId, 501);
  assert.equal(responsesById(socket).get(2).result.windowId, 2);
});

test("focus_onANormalTab_shouldActivateTheTabBeforeFocusingItsWindow", async () => {
  // GIVEN a stored agent tab in window 1, and one call list both stubs write into:
  const { calls, tabs } = createFocusFixture();
  const { socket } = await connectedBackground({ tabs, calls, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to bring it forward,
  await sendFocus(socket, 2);

  // THEN the tab comes first and the window second, with exactly these arguments —
  // the other order focuses a window that still shows a different tab:
  assert.deepStrictEqual(tabs.calls, [
    { kind: "tabs.update", tabId: 500, changes: { active: true } },
    { kind: "windows.update", windowId: 1, changes: { focused: true } },
    { kind: "windows.get", windowId: 1 },
  ]);

  // ... and the answer reports both successes, taken from the two return values:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(answer.result, {
    tabId: 500,
    windowId: 1,
    url: "https://before.example/",
    title: "Vorher",
    active: true,
    focused: true,
  });
});

/**
 * The finding that closed spec 08: `windows.update` reports the focus from *before*
 * the change, so an answer built from it says "not focused" for a window that is.
 * The read after the update is what makes the answer true.
 */
test("focus_whenTheWindowUpdateReportsTheOldFocusAndTheReadReportsTheNew_shouldAnswerFocusedTrue", async () => {
  // GIVEN a window whose update answers the old state (`false`) while the read
  // afterwards says it is in front now:
  const { calls, tabs } = createFocusFixture();
  const { socket } = await connectedBackground({
    tabs,
    calls,
    settings: STORED_TAB_SETTINGS,
    windowUpdateStaleFocusFor: [1],
    windowFocusedAfter: { 1: true },
  });

  // WHEN the bridge asks to bring the tab forward,
  await sendFocus(socket, 2);

  // THEN the answer says what is, not what the update echoed:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.focused, true);

  // ... and the read happened last, exactly once: one entry per call, the `get`
  // behind the update. A loop or a read before the update would change this list.
  assert.deepStrictEqual(tabs.calls, [
    { kind: "tabs.update", tabId: 500, changes: { active: true } },
    { kind: "windows.update", windowId: 1, changes: { focused: true } },
    { kind: "windows.get", windowId: 1 },
  ]);
});

/**
 * The case that separates `??` from `||`: an explicit `false` from the read is an
 * answer, not a missing one. With `||` — or with a hardcoded `true` — this goes red.
 */
test("focus_whenTheFocusReadReportsNoFocus_shouldAnswerFocusedFalse", async () => {
  // GIVEN a window whose update echoes the request (`true`) although the read
  // afterwards says the window did not come to the front:
  const { calls, tabs } = createFocusFixture();
  const { socket } = await connectedBackground({
    tabs,
    calls,
    settings: STORED_TAB_SETTINGS,
    windowFocusedAfter: { 1: false },
  });

  // WHEN the bridge asks to bring the tab forward,
  await sendFocus(socket, 2);

  // THEN the read wins, even though it is the pessimistic answer,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.focused, false);

  // ... and it was really asked: the update's `true` is not what answered here.
  assert.deepStrictEqual(tabs.calls, [
    { kind: "tabs.update", tabId: 500, changes: { active: true } },
    { kind: "windows.update", windowId: 1, changes: { focused: true } },
    { kind: "windows.get", windowId: 1 },
  ]);
});

test("focus_whenTheFocusReadThrows_shouldKeepTheUpdateAnswer", async () => {
  // GIVEN a read that fails although the update went through and answered the old
  // state (`false`):
  const { calls, tabs } = createFocusFixture();
  const { socket } = await connectedBackground({
    tabs,
    calls,
    settings: STORED_TAB_SETTINGS,
    windowUpdateStaleFocusFor: [1],
    windowGetThrowsFor: [1],
  });

  // WHEN the bridge asks to bring the tab forward,
  await sendFocus(socket, 2);

  // THEN the failed read is not a failure of the call — the update's answer is the
  // weakest remaining claim, and it is reported as such:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.active, true);
  assert.equal(answer.result.focused, false);

  // ... and the throwing read left no entry: the stub records only reads that
  // returned.
  assert.deepStrictEqual(tabs.calls, [
    { kind: "tabs.update", tabId: 500, changes: { active: true } },
    { kind: "windows.update", windowId: 1, changes: { focused: true } },
  ]);
});

test("focus_whenTheWindowUpdateFails_shouldStillAnswerTheActivatedTab", async () => {
  // GIVEN a window that is gone between the two calls — the operator closed it:
  const { calls, tabs } = createFocusFixture();
  const { socket } = await connectedBackground({
    tabs,
    calls,
    settings: STORED_TAB_SETTINGS,
    windowUpdateThrowsFor: [1],
  });

  // WHEN the bridge asks to bring the tab forward,
  await sendFocus(socket, 2);

  // THEN the half success is a success and is reported as one,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.active, true);
  assert.equal(answer.result.focused, false);

  // ... and the tab really was brought forward: `focus_failed` would deny a
  // success that already happened.
  assert.deepStrictEqual(tabs.calls, [
    { kind: "tabs.update", tabId: 500, changes: { active: true } },
  ]);
});

test("focus_whenTheTabUpdateThrows_shouldAnswerFocusFailed", async () => {
  // GIVEN a tab that vanishes between the lookup and the update,
  const { calls, tabs } = createFocusFixture({ updateThrowsFor: [500] });
  const { socket } = await connectedBackground({ tabs, calls, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks to bring it forward,
  await sendFocus(socket, 2);

  // THEN this is the one failure the call reports,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "focus_failed");

  // ... and no window was focused for a tab that never came forward.
  assert.deepStrictEqual(tabs.calls, []);
});

test("focus_withAnUnexpectedParameter_shouldAnswerInvalidParamsAndUpdateNothing", async () => {
  // GIVEN a stored agent tab and a caller that passes an argument anyway:
  const { calls, tabs } = createFocusFixture();
  const { socket } = await connectedBackground({ tabs, calls, settings: STORED_TAB_SETTINGS });

  // WHEN the request carries `{tabId: 101}` — the one thing `focus` must not take
  // is a target other than the agent tab,
  await sendFocus(socket, 2, { tabId: 101 });

  // THEN it is refused before any tab is resolved,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "invalid_params");

  // ... with the English sentence from `docs/54`, without a German umlaut — the
  // extension's refusals travel in `error.message`, and the German log lines stay
  // German because they go to the operator's console,
  assert.equal(answer.error.message, "focus takes no parameters besides tab.");
  assert.equal(/[äöüß]/u.test(answer.error.message), false);

  // ... and nothing moved.
  assert.deepStrictEqual(tabs.calls, []);
});

/**
 * The order is contract, not taste: a caller that handed in a target hears about
 * its mistake even when there is no stored tab to fall back on.
 */
test("focus_withAnUnexpectedParameterAndNoStoredAgentTab_shouldAnswerInvalidParamsBeforeResolvingTheTab", async () => {
  // GIVEN an extension that has never navigated — no stored agent tab at all —
  // although the operator's window has a tab:
  const calls = [];
  const tabs = createTabsStub({ calls, tabs: [createAgentTabFixture()] });
  const { socket } = await connectedBackground({ tabs, calls });

  // WHEN the request carries `{tabId: 101}`,
  await sendFocus(socket, 2, { tabId: 101 });

  // THEN the parameter check wins over the tab lookup: `invalid_params`, not
  // `no_agent_tab`. Swapping the two steps turns this case red.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "invalid_params");

  // ... and neither `tabs.update` nor `windows.update` was called, because the
  // request never got as far as resolving a tab.
  assert.deepStrictEqual(tabs.calls, []);
});

test("focus_whileANavigationIsWaiting_shouldAnswerAndLeaveTheNavigationAlone", async () => {
  // GIVEN a navigation of tab 500 waiting for its page:
  const { calls, tabs } = createFocusFixture();
  const { socket } = await connectedBackground({ tabs, calls, settings: STORED_TAB_SETTINGS });
  await sendNavigate(socket, 2, { url: "https://allowed.example/" });
  assert.equal(responsesById(socket).has(2), false);
  assert.equal(tabs.listenerCount(), 1);

  // WHEN `focus` arrives while it waits,
  await sendFocus(socket, 3);

  // THEN `focus` answers straight away — it takes no slot, so nothing here has to
  // wait — and the navigation is still waiting:
  assert.equal(responsesById(socket).get(3).ok, true);
  assert.equal(responsesById(socket).has(2), false);
  assert.equal(tabs.listenerCount(), 1);

  // ... and the tab event a real `focus` triggers changes nothing either, because
  // it carries no `status`: a wait that trusted every update would end here.
  tabs.emitUpdated(500, { active: true });
  await settleAsyncWork();
  assert.equal(responsesById(socket).has(2), false);
  assert.equal(tabs.listenerCount(), 1);

  // WHEN the page of the navigation really is loaded,
  tabs.emitUpdated(500, { status: "complete" }, {
    id: 500,
    windowId: 1,
    url: "https://allowed.example/",
    title: "Erlaubt",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN it answers its own result — no `superseded`, and the settle pair of a page
  // that said nothing about its quiet.
  assert.deepStrictEqual(responsesById(socket).get(2).result, {
    tabId: 500,
    windowId: 1,
    url: "https://allowed.example/",
    title: "Erlaubt",
    complete: true,
    settled: false,
    waitedMs: 0,
  });

  // ... and the only injection of the whole case is the navigation's own settle op:
  // `focus` injects nothing at all.
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(tabs.channel.ops(), ["settle"]);
});

test("focus_onANormalTab_shouldInjectNothingAndStartNoTimer", async () => {
  // GIVEN a normal focus case,
  const { calls, tabs } = createFocusFixture();
  const { socket, clock } = await connectedBackground({ tabs, calls, settings: STORED_TAB_SETTINGS });

  // WHEN the tab is brought forward,
  await sendFocus(socket, 2);

  // THEN no page code ran at all: `focus` does not read, click or type,
  assert.deepStrictEqual(tabs.scriptCalls, []);

  // ... no timer was started (the chain is plain `await`, there is nothing to
  // wait for), and no listener was left on the tab.
  assert.deepStrictEqual(clock.pendingDelays(), []);
  assert.equal(tabs.listenerCount(), 0);
});

/* --------------------------------------------------- open_tab / close_tab */

/**
 * The list of the five agent tabs that fill the cap — the state `open_tab` has to
 * refuse from, and the state two simultaneous calls may not overshoot.
 *
 * Ids above the fixture's 500/501 on purpose: five *live* tabs are what the check has
 * to count, and reusing the two-tab fixture would make "four" and "five" look alike.
 */
const AGENT_TAB_LIMIT = 5;

function createAgentTabIds(count, firstId = 500) {
  return Array.from({ length: count }, (unused, index) => firstId + index);
}

/** `count` live agent tabs of the default container, plus the list that holds them. */
function createAgentTabStub(count) {
  const agentTabIds = createAgentTabIds(count);
  const tabs = createTabsStub({ tabs: agentTabIds.map((id) => createAgentTabFixture({ id })) });
  return { tabs, agentTabIds, settings: { agentTabIds } };
}

test("openTab_shouldCreateAnAgentTabAndAnswerTabIdUrlTitle", async () => {
  // GIVEN a connected extension that has no agent tab at all,
  const tabs = createTabsStub();
  const { socket, browser, clock } = await connectedBackground({ tabs });

  // WHEN the bridge opens one,
  await sendOpenTab(socket, 2, { url: AGENT_URL });

  // THEN the tab is created in the agent's window and in the background — the operator
  // keeps reading the page they are on,
  assert.deepStrictEqual(tabs.created, [{ url: AGENT_URL, active: false, windowId: 1 }]);

  // ... and the call does *not* answer yet: it waits for the page, so the `read` that
  // follows on an `open_tab` does not have to pay `page_busy` for the tab this very
  // call opened.
  assert.equal(responsesById(socket).has(2), false);
  assert.deepStrictEqual(clock.pendingDelays(), [NAVIGATE_TIMEOUT_MS]);

  // WHEN the page reports itself loaded, with the title a redirect left behind,
  tabs.emitUpdated(CREATED_TAB_ID, { status: "complete" }, {
    id: CREATED_TAB_ID,
    windowId: 1,
    url: "https://example.org/final",
    title: "Example Domain",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN the answer is exactly the three fields the wire protocol promises — no
  // `windowId`, no `complete`: a fourth field would be a shape no caller agreed to,
  assert.deepStrictEqual(responsesById(socket).get(2), {
    type: "response",
    id: 2,
    ok: true,
    result: { tabId: CREATED_TAB_ID, url: "https://example.org/final", title: "Example Domain" },
  });

  // ... the new tab is the list's last and only entry, which is what makes it the tab
  // every call without a `tab` addresses from now on,
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [CREATED_TAB_ID],
  });

  // ... and nothing is left listening or waiting.
  assert.equal(tabs.listenerCount(), 0);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("openTab_asTheSixthTab_shouldAnswerTooManyTabsAndCreateNothing", async () => {
  // GIVEN five agent tabs — the cap — and five live ones, so the prune has nothing to
  // clean up:
  const { tabs, settings } = createAgentTabStub(AGENT_TAB_LIMIT);
  const { socket, browser } = await connectedBackground({ tabs, settings });

  // WHEN the bridge tries to open a sixth,
  await sendOpenTab(socket, 2, { url: AGENT_URL });

  // THEN the answer is the code the spec adds for exactly this case,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "too_many_tabs");

  // ... carrying the sentence word for word: the bridge maps the code back to its
  // own copy of this text, and asserting it here is what keeps the two copies from
  // drifting apart without a red test.
  assert.equal(answer.error.message, "Five agent tabs are already open — close one first.");

  // ... and nothing was created: the refusal is a decision, not a tab that gets
  // discarded afterwards,
  assert.deepStrictEqual(tabs.created, []);

  // ... the list is exactly the one it was.
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: settings.agentTabIds,
  });
});

test("openTab_afterTheBrowserRestart_shouldPruneTheDeadIdsAndCreateATab", async () => {
  // GIVEN five stored ids whose tabs are all gone — the normal state after a browser
  // restart, because tab ids do not survive one:
  const tabs = createTabsStub();
  const { socket, browser } = await connectedBackground({
    tabs,
    settings: { agentTabIds: createAgentTabIds(AGENT_TAB_LIMIT) },
  });

  // WHEN the bridge opens a tab,
  await sendOpenTab(socket, 2, { url: AGENT_URL });

  // THEN it is created instead of refused: the cap counts what is alive, and five
  // corpse ids would otherwise block opening a tab for ever,
  assert.deepStrictEqual(tabs.created, [{ url: AGENT_URL, active: false, windowId: 1 }]);
  assert.equal(responsesById(socket).has(2), false, "the call waits for its page");

  // ... and the list holds the new tab alone, with every dead id dropped.
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [CREATED_TAB_ID],
  });
});

test("openTab_withoutUrl_shouldAnswerInvalidParams", async () => {
  // GIVEN a connected extension without an agent tab:
  const tabs = createTabsStub();
  const { socket } = await connectedBackground({ tabs });

  // WHEN the URL is missing or is not a string,
  const params = [{}, { url: null }, { url: 42 }, { url: [AGENT_URL] }, undefined];
  for (const [index, value] of params.entries()) {
    await sendOpenTab(socket, 20 + index, value);
  }

  // THEN every call is a parameter error — the same decision `navigate` makes, in this
  // method's own error type,
  for (let index = 0; index < params.length; index += 1) {
    assert.equal(responsesById(socket).get(20 + index).error.code, "invalid_params");
  }

  // ... and no tab was created for any of them.
  assert.deepStrictEqual(tabs.created, []);
});

test("openTab_withAnFtpUrl_shouldAnswerInvalidUrl", async () => {
  // GIVEN a connected extension,
  const tabs = createTabsStub();
  const { socket } = await connectedBackground({ tabs });

  // WHEN the bridge asks for an `ftp:` address — `http(s)` only, as for `navigate`,
  await sendOpenTab(socket, 2, { url: "ftp://example.org/datei" });

  // THEN it is `invalid_url` and not `invalid_params`: the caller can fix a URL, and
  // the code is the one the existing `navigate` check already answers with,
  assert.equal(responsesById(socket).get(2).error.code, "invalid_url");
  assert.deepStrictEqual(tabs.created, []);
});

test("openTab_twiceAtOnceAtFourTabs_shouldCreateExactlyFiveAndAnswerTooManyTabsOnce", async () => {
  // GIVEN four live agent tabs — one below the cap — and two calls that arrive in the
  // same tick, before the first has finished its check:
  const { tabs, settings } = createAgentTabStub(AGENT_TAB_LIMIT - 1);
  const { socket, browser, clock } = await connectedBackground({ tabs, settings });

  // WHEN both calls are in flight at the same time,
  socket.receive({ type: "request", id: 2, method: "open_tab", params: { url: AGENT_URL } });
  socket.receive({ type: "request", id: 3, method: "open_tab", params: { url: AGENT_URL } });
  await settleAsyncWork();

  // THEN exactly one tab is created: check-and-create is one queue entry, so the second
  // call sees the result of the first instead of the four tabs it read itself,
  assert.equal(tabs.created.length, 1, "a sixth tab must never be created");

  // ... the second call is the one that is refused,
  assert.equal(responsesById(socket).get(3).error.code, "too_many_tabs");

  // ... and the list holds five ids, the four old ones plus the new one.
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [...settings.agentTabIds, CREATED_TAB_ID],
  });

  // WHEN the one created page reports itself loaded,
  tabs.emitUpdated(CREATED_TAB_ID, { status: "complete" }, {
    id: CREATED_TAB_ID,
    windowId: 1,
    url: AGENT_URL,
    title: "Example Domain",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN the allowed call answers with that tab, and no timer is left behind.
  assert.equal(responsesById(socket).get(2).result.tabId, CREATED_TAB_ID);
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("clickAndOpenTabAtOnce_shouldNotLoseEitherListChange", async () => {
  // GIVEN two agent tabs where the click names the *older* one — so its mark reorders
  // the list — and a click page that settles without a fallback window:
  const tabs = createClickTabs({
    tabs: createTwoAgentTabs({ status: "complete" }),
    settle: { settled: true, waitedMs: 120 },
  });
  const { socket, browser } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

  // WHEN a click in tab 501 and an `open_tab` are in flight at the same time,
  socket.receive({ type: "request", id: 2, method: "click", params: { selector: DEFAULT_CLICK_SELECTOR, tab: 501 } });
  socket.receive({ type: "request", id: 3, method: "open_tab", params: { url: AGENT_URL } });
  await settleAsyncWork();
  tabs.emitUpdated(CREATED_TAB_ID, { status: "complete" }, {
    id: CREATED_TAB_ID,
    windowId: 1,
    url: AGENT_URL,
    title: "Example Domain",
    status: "complete",
  });
  await settleAsyncWork();

  // THEN both list changes survived: the click's order (501 last) *and* the new tab.
  // Two read-modify-write pairs on `agentTabIds` overlap here, and `enqueueTabStore` is
  // the only thing that serialises them — dropping the queue from either path leaves a
  // window in which one write overwrites the other's read, and the agent then addresses
  // a tab it no longer expects. [500, 501] would be the lost open, [501, 500, 900] the
  // lost click.
  assert.equal(responsesById(socket).get(2).ok, true, "the click must still succeed");
  assert.equal(responsesById(socket).get(3).ok, true, "the open must still succeed");
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [500, 501, CREATED_TAB_ID],
  });
});

test("closeTab_withTab_shouldCloseAndShrinkTheList", async () => {
  // GIVEN two agent tabs, 500 the last used one and 501 the one a request can name:
  const tabs = createTabsStub({ tabs: createTwoAgentTabs() });
  const { socket, browser } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge closes tab 501 by name,
  await sendCloseTab(socket, 2, { tab: 501 });

  // THEN the answer names that tab and says it is gone,
  assert.deepStrictEqual(responsesById(socket).get(2), {
    type: "response",
    id: 2,
    ok: true,
    result: { tabId: 501, closed: true },
  });

  // ... the tab is really closed — a later lookup finds nothing, the way Firefox
  // behaves,
  await assert.rejects(tabs.get(501));
  assert.equal((await tabs.get(500)).id, 500, "the other tab must survive");

  // ... and the list shrank to the remaining tab.
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [500],
  });
});

test("closeTab_withoutTab_shouldCloseTheLastUsedAndMoveToThePrevious", async () => {
  // GIVEN two readable agent tabs and the list [501, 500] — 500 is the last used one:
  const tabs = createReadTabs({ tabs: createTwoAgentTabs({ status: "complete" }) });
  const { socket, browser } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge closes without a `tab`,
  await sendCloseTab(socket, 2);

  // THEN the last used tab is the one that went away — and the answer can only have
  // come from the resolution, because the request named no id at all,
  assert.deepStrictEqual(responsesById(socket).get(2).result, { tabId: 500, closed: true });
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: [501],
  });

  // ... and the entry before it moved up: the next call without a `tab` reads 501.
  await sendRead(socket, 3);
  assert.equal(tabs.scriptCalls[0].tabId, 501);
  assert.equal(responsesById(socket).get(3).result.tabId, 501);
});

test("closeTab_withAnUnknownTab_shouldAnswerNoAgentTabAndRemoveNothing", async () => {
  // GIVEN two agent tabs and an id that is nobody's,
  const tabs = createTabsStub({ tabs: createTwoAgentTabs() });
  const { socket, browser } = await connectedBackground({ tabs, settings: TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge closes that id,
  await sendCloseTab(socket, 2, { tab: 999 });

  // THEN it is `no_agent_tab`,
  assert.equal(responsesById(socket).get(2).error.code, "no_agent_tab");

  // ... nothing was closed — an id outside the list is not a tab of ours to remove,
  assert.equal((await tabs.get(500)).id, 500);
  assert.equal((await tabs.get(501)).id, 501);

  // ... and the list is untouched.
  assert.deepStrictEqual(inThisRealm(await browser.storage.local.get(["agentTabIds"])), {
    agentTabIds: TWO_AGENT_TABS_SETTINGS.agentTabIds,
  });
});

/* -------------------------------------------------------------------- eval */

/**
 * The switch of spec 19 is off unless the operator turned it on, so a case that
 * wants to reach the page has to store it — a naked `{ allowEval: true }` would drop
 * the agent tab along with it and answer `no_agent_tab` for the wrong reason.
 */
const EVAL_ENABLED_SETTINGS = { ...STORED_TAB_SETTINGS, allowEval: true };

test("eval_whenTheSwitchIsOff_shouldRefuseWithoutInjecting", async () => {
  // GIVEN a complete agent tab and a store that carries no switch — the default, off,
  const tabs = createTabsStub({ tabs: [createAgentTabFixture({ status: "complete" })] });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  const injectionsBefore = tabs.scriptCalls.length;

  // WHEN the bridge evaluates code in the agent tab,
  await sendEval(socket, 2, { code: "return document.title" });

  // THEN the operator's decision answers, not the page,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "eval_not_allowed");
  assert.match(answer.error.message, /Code evaluation/);

  // ... and `executeScript` was not called at all: the switch protects the page, it
  // does not merely decorate the answer. The count, not the wording, is the proof.
  assert.equal(injectionsBefore, 0);
  assert.equal(tabs.scriptCalls.length, injectionsBefore);
});

test("eval_whenTheSwitchHoldsTheStringTrue_shouldRefuseWithoutInjecting", async () => {
  // GIVEN a store whose `allowEval` is the string `"true"` — what a hand-edited
  // storage or a careless import leaves behind,
  const tabs = createTabsStub({ tabs: [createAgentTabFixture({ status: "complete" })] });
  const { socket } = await connectedBackground({
    tabs,
    settings: { ...STORED_TAB_SETTINGS, allowEval: "true" },
  });

  // WHEN the bridge evaluates code,
  await sendEval(socket, 2, { code: "return document.title" });

  // THEN only the boolean opens the page: the string is no decision, so it stays
  // `eval_not_allowed` and nothing is injected —
  assert.equal(responsesById(socket).get(2).error.code, "eval_not_allowed");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("eval_whenTheSwitchIsOffAndTheCodeIsEmpty_shouldAnswerEvalNotAllowed", async () => {
  // GIVEN the switch off and a request that is wrong in a second way as well,
  const tabs = createTabsStub({ tabs: [createAgentTabFixture({ status: "complete" })] });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge sends it,
  await sendEval(socket, 2, { code: "" });

  // THEN the order of the contract holds: the switch answers before a single
  // parameter is sorted, so the caller hears about the decision that blocks it,
  assert.equal(responsesById(socket).get(2).error.code, "eval_not_allowed");

  // ... and nothing was injected.
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("eval_whenTheCodeIsMissingOrTooLong_shouldAnswerInvalidParams", async () => {
  // GIVEN the switch on and a complete agent tab, so this case is about the code and
  // not about a refused call,
  const tabs = createTabsStub({ tabs: [createAgentTabFixture({ status: "complete" })] });
  const { socket } = await connectedBackground({ tabs, settings: EVAL_ENABLED_SETTINGS });

  // WHEN the caller forgets the code and, in a second call, sends one character past
  // the limit,
  await sendEval(socket, 2, {});
  await sendEval(socket, 3, { code: "x".repeat(20001) });

  // THEN both are `invalid_params`: nothing to run is a caller mistake, and the limit
  // is the frame guard of this increment,
  assert.equal(responsesById(socket).get(2).error.code, "invalid_params");
  assert.equal(responsesById(socket).get(3).error.code, "invalid_params");

  // ... decided before the tab was even resolved, so nothing left this process.
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("eval_withoutAnAgentTab_shouldAnswerNoAgentTab", async () => {
  // GIVEN the switch on and a connected extension that never navigated — no agent tab,
  // although the operator's window has one. The settings carry the switch alone on
  // purpose: this case *is* the missing tab,
  const tabs = createTabsStub({ tabs: [createAgentTabFixture()] });
  const { socket } = await connectedBackground({ tabs, settings: { allowEval: true } });

  // WHEN the bridge evaluates code,
  await sendEval(socket, 2, { code: "return document.title" });

  // THEN there is no page to run anything in, and nothing is injected:
  assert.equal(responsesById(socket).get(2).error.code, "no_agent_tab");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("eval_whenTheTabIsStillLoading_shouldAnswerPageBusy", async () => {
  // GIVEN a tab that is still loading and an injection Firefox refuses in that moment,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "loading" })],
    executeScript: async () => {
      throw new Error("Missing host permission for the tab");
    },
  });
  const { socket } = await connectedBackground({ tabs, settings: EVAL_ENABLED_SETTINGS });

  // WHEN the bridge evaluates code too early,
  await sendEval(socket, 2, { code: "return document.title" });

  // THEN the tab's verdict arrives instead of `eval_failed` — the `ReadError` line in
  // `evalErrorFor` is what makes it so, and without it this would be a code of ours,
  const error = responsesById(socket).get(2).error;
  assert.equal(error.code, "page_busy");

  // ... and the frame carries no address or kind: those fields belong to
  // `not_readable`, and there is nothing to describe yet.
  assert.equal("url" in error, false);
  assert.equal("kind" in error, false);
});

test("eval_whenThePageIsInternal_shouldAnswerNotReadableWithKindAndUrl", async () => {
  // GIVEN a page Firefox never injects into, in a tab standing on the browser's own
  // settings page,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ url: "about:config", status: "complete" })],
    executeScript: async () => {
      throw new Error("Missing host permission for the tab");
    },
  });
  const { socket } = await connectedBackground({ tabs, settings: EVAL_ENABLED_SETTINGS });

  // WHEN the bridge evaluates code there,
  await sendEval(socket, 2, { code: "return document.title" });

  // THEN the fourth tool builds the same frame as the other three: one enricher, one
  // shape, whichever call reaches it,
  const error = responsesById(socket).get(2).error;
  assert.equal(error.code, "not_readable");
  assert.equal(error.kind, "internal");
  assert.equal(error.url, "about:config");

  // ... and it is not our failure: the injection was attempted exactly once and not
  // retried into a second failure of ours.
  assert.equal(tabs.scriptCalls.length, 1);
});

/* ------------------------------------------------- eval: out of the page */

/**
 * The extension's own deadline for `eval`, quoted from `background.js`.
 *
 * `EVAL_TIMEOUT_MS` (2 000) plus 500 ms of air for a throttled page timer. It lives
 * inside the bridge page's IIFE and no assertion outside the sandbox can read it,
 * so this pin is the number the guard case names.
 */
const EVAL_GUARD_MS = 2500;

/** The two limits of the result mapping, quoted like every other pin. */
const EVAL_RESULT_LIMIT = 10000;
const EVAL_MESSAGE_LIMIT = 500;

/**
 * The two candidate tabs of the `tab` cases, plus the switch.
 *
 * `TWO_AGENT_TABS_SETTINGS` puts 500 at the end of the list, so it is the last used one
 * and 501 is the tab only an explicit `tab` reaches — without that second candidate, a
 * call that ignored its `tab` and one that honoured it would look the same.
 */
const EVAL_TWO_AGENT_TABS_SETTINGS = { ...TWO_AGENT_TABS_SETTINGS, allowEval: true };

/**
 * The `eval` path, with the page realm of `page` behind the message channel.
 *
 * A factory and not a `page`, because `eval` is the one tool whose op *waits*: the frame
 * gets a virtual clock of its own, and the case can state afterwards that none of them
 * kept a timer.
 *
 * `advanceMs` reaches that clock: omitted drains it, a number stops it at that instant
 * on every round the harness runs — the only way a case can still see a timer the op had
 * to clear. `refuseInjection` is for the page the browser will not load the file into.
 *
 * `agentTabs` replaces the single fixture when the case needs more than one candidate:
 * "the last used one" is a claim that needs a second tab to be *not* it.
 */
function evaluatingTabs(page = DEFAULT_READ_PAGE, { advanceMs = null, agentTabs, refuseInjection } = {}) {
  const pageClock = createPageClock();
  const pageClocks = [pageClock];
  const tabs = createTabsStub({
    // `complete`, because an eval case is about the code and not about a tab that is
    // still loading — the three cases about a refused injection name theirs.
    tabs: agentTabs ?? [createAgentTabFixture({ status: "complete" })],
    pageAgent: {
      frames: [{ href: page.url, page, clock: pageClock }],
      advanceMs: advanceMs === null ? undefined : advanceMs,
      refuseInjection,
    },
  });
  return { tabs, pageClocks };
}

/** One `eval` call that really runs, with its answer and both clocks. */
async function evalOnce(params, page = DEFAULT_READ_PAGE, { advanceMs = null } = {}) {
  const { tabs, pageClocks } = evaluatingTabs(page, { advanceMs });
  const started = await connectedBackground({ tabs, settings: EVAL_ENABLED_SETTINGS });
  await sendEval(started.socket, 2, params);
  return {
    ...started,
    tabs,
    pageClocks,
    answer: responsesById(started.socket).get(2),
  };
}

/**
 * No timer may outlive a call — neither the extension's guard nor a page deadline.
 *
 * Stated once and called from every case that runs code: a guard that survives its
 * call keeps the bridge page busy, and a page timer that survives its deadline is
 * the throttling the guard exists for, just in the other realm.
 */
function assertNoTimerLeft(clock, pageClocks) {
  assert.deepStrictEqual(clock.pendingDelays(), []);
  for (const pageClock of pageClocks) assert.deepStrictEqual(pageClock.pendingDelays(), []);
}

test("eval_withTab_shouldEvaluateInThatTab", async () => {
  // GIVEN two agent tabs, 500 the last used one and 501 the tab only an explicit `tab`
  // reaches,
  const { tabs, pageClocks } = evaluatingTabs(DEFAULT_READ_PAGE, {
    agentTabs: createTwoAgentTabs({ status: "complete" }),
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: EVAL_TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge evaluates code in 501,
  await sendEval(socket, 2, { code: "return 1", tab: 501 });

  // THEN the code ran there: 500 sits at the end of the list, so a resolution that
  // ignored the parameter would have injected into 500 and looked just as green,
  assert.equal(tabs.scriptCalls[0].tabId, 501);
  assert.equal(responsesById(socket).get(2).result.tabId, 501);

  // ... and it went to the main frame of that tab: `frameIds: [0]` without `allFrames`,
  // the same target a `read` without `frame` records (criterion 1 of spec 25),
  assert.deepStrictEqual(tabs.scriptCalls[0].details.target, { tabId: 501, frameIds: [0] });

  // ... the injected code really ran there (and 500 was not touched on the way),
  assert.equal(tabs.scriptCalls.length, 1);

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withoutATab_shouldAddressTheLastUsedAgentTab", async () => {
  // GIVEN the same two agent tabs, where 500 is the last used one,
  const { tabs, pageClocks } = evaluatingTabs(DEFAULT_READ_PAGE, {
    agentTabs: createTwoAgentTabs({ status: "complete" }),
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: EVAL_TWO_AGENT_TABS_SETTINGS });

  // WHEN the bridge evaluates without a `tab`,
  await sendEval(socket, 2, { code: "return 1" });

  // THEN it is the last used tab that is addressed — the same rule `read`, `click` and
  // `inspect` follow, which is the whole reason a call without `tab` stays as
  // convenient here as it was with a single agent tab:
  assert.equal(tabs.scriptCalls[0].tabId, 500);
  assert.equal(responsesById(socket).get(2).result.tabId, 500);

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withReturnDocumentTitle_shouldAnswerTheTitle", async () => {
  // GIVEN the switch on and a complete agent tab standing on a page with a title,
  // WHEN the bridge evaluates `return document.title`,
  const { answer, tabs, clock, pageClocks } = await evalOnce({ code: "return document.title" });

  // THEN the answer is the page's title, together with where it came from — the
  // ordinary case of the contract,
  assert.equal(answer.ok, true);
  assert.equal(answer.result.result, DEFAULT_READ_PAGE.title);
  assert.equal(answer.result.url, DEFAULT_READ_PAGE.url);
  assert.equal(answer.result.title, DEFAULT_READ_PAGE.title);
  assert.equal(answer.result.tabId, 500);

  // ... and `elapsedMs` is a measurement and not a word: a whole number of
  // milliseconds that cannot be negative,
  assert.equal(Number.isInteger(answer.result.elapsedMs), true);
  assert.equal(answer.result.elapsedMs >= 0, true);

  // ... the channel never carried it: `eval` answers through the injection itself, so no
  // message was sent and no frame had to speak (specs 47 and 49),
  assert.deepStrictEqual(tabs.channel.calls, []);
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(Object.keys(tabs.scriptCalls[0].details.target).sort(), ["frameIds", "tabId"]);

  // ... and nothing stayed armed on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("injection_forEval_shouldCarryWorldMain", async () => {
  // GIVEN the switch on and a complete agent tab,
  const { tabs } = await evalOnce({ code: "return 1" });

  // WHEN the bridge evaluated the code,
  // THEN the injection carried exactly three things: the arguments, the function and the
  // target. Checked on the pin in `inject` — `tabs.scriptCalls` is no witness, because the
  // stub records `JSON.parse(JSON.stringify(details))` and a function does not survive
  // that (specs 47 and 49),
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(
    Object.keys(tabs.scriptCalls[0].details).sort(),
    ["args", "target", "world"],
  );
  // ... and in the page's own world: the isolated one blocks `new Function` with the
  // extension's CSP, which is what kept `eval` dead under MV3 (spec 48),
  assert.equal(tabs.scriptCalls[0].details.world, "MAIN");
  // ... the function travelled as its source, so the injection's `func` is a real value
  // at the moment it is handed over — the recording just cannot show it,
  assert.equal(tabs.scriptCalls[0].details.func, undefined, "the recording cannot keep a function");
  // ... and the arguments are the code, the five limits and the frame filter,
  assert.equal(tabs.scriptCalls[0].details.args.length, 3);
  assert.equal(tabs.scriptCalls[0].details.args[0], "return 1");
  assert.deepStrictEqual(Object.keys(tabs.scriptCalls[0].details.args[1]).sort(), [
    "classLimit",
    "messageLimit",
    "resultLimit",
    "timeoutMs",
    "valueLimit",
  ]);
  assert.equal(tabs.scriptCalls[0].details.args[2], null, "no `frame` is the main frame");
});

test("eval_withTopLevelAwait_shouldAnswerTheResolvedValue", async () => {
  // GIVEN the switch on and code that awaits at its top level — the shape every API call
  // against the page itself needs (spec 50),
  const { answer } = await evalOnce(
    { code: "const v = await Promise.resolve(7);\nreturn v;" },
    DEFAULT_READ_PAGE,
    { advanceMs: 10 },
  );

  // THEN it runs, and the awaited value is the answer,
  assert.equal(answer.ok, true);
  assert.equal(answer.result.result, 7);
});

test("eval_withTopLevelAwaitThatRejects_shouldAnswerEvalFailed", async () => {
  // GIVEN code whose awaited value rejects,
  const { answer } = await evalOnce(
    { code: "await Promise.reject(new Error('kein Zugriff'));" },
    DEFAULT_READ_PAGE,
    { advanceMs: 10 },
  );

  // THEN the page's words travel as `eval_failed`, exactly like a throw,
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "eval_failed");
  assert.match(answer.error.message, /kein Zugriff/);
});

test("eval_withMultiLineCodeAndReturn_shouldAnswer42", async () => {
  // GIVEN the switch on and a code that is statements, not an expression — the shape
  // a function *body* allows,
  // WHEN the bridge evaluates it,
  const { answer, clock, pageClocks } = await evalOnce({
    code: ["const a = 6;", "const b = 7;", "return a * b;"].join("\n"),
  });

  // THEN the `return` answers, which is the whole difference between a body and an
  // expression:
  assert.equal(answer.ok, true);
  assert.equal(answer.result.result, 42);

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withoutAReturn_shouldAnswerNull", async () => {
  // GIVEN a code with no `return` at all,
  // WHEN the bridge evaluates it,
  const { answer, clock, pageClocks } = await evalOnce({ code: "document.title" });

  // THEN the result is `null` and not the title: there is no implicit return value,
  // and a field that is missing would be a different statement than `null`,
  assert.equal(answer.ok, true);
  assert.equal("result" in answer.result, true);
  assert.equal(answer.result.result, null);

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_whenTheCodeThrows_shouldAnswerEvalFailedWithTheMessageAndNoStack", async () => {
  // GIVEN a code that throws, the way a caller's own probe would,
  // WHEN the bridge evaluates it,
  const { answer, clock, pageClocks } = await evalOnce({ code: "throw new Error('probe')" });

  // THEN the failure is the code's and not the page's: `eval_failed`, with the
  // message the page threw,
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "eval_failed");
  assert.equal(answer.error.message, "probe");

  // ... and no stack: the frames would name our injection, and that is our side,
  // not the caller's.
  assert.equal(answer.error.message.includes("at "), false);
  assert.equal(answer.error.message.includes("\n"), false);

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withASyntaxError_shouldAnswerEvalFailed", async () => {
  // GIVEN a code that does not even parse — the function is never built,
  // WHEN the bridge evaluates it,
  const { answer, clock, pageClocks } = await evalOnce({ code: "return (" });

  // THEN it is the same failure as a throw: for the caller, building and running are
  // one event, and the parser's message is the page's answer,
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "eval_failed");
  assert.equal(typeof answer.error.message, "string");
  assert.equal(answer.error.message.length > 0, true);
  assert.equal(answer.error.message.includes("\n"), false, "a stack must not travel");

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withAPromiseThatResolvesAfter50ms_shouldAnswerTheValue", async () => {
  // GIVEN a code that answers through a promise 50 ms from now,
  // WHEN the bridge evaluates it and the page clock stops 10 ms after the answer
  // instead of running dry — so the 2 000 ms deadline timer is still armed at the
  // moment the harness looks,
  const { answer, clock, pageClocks } = await evalOnce(
    { code: "return new Promise((resolve) => setTimeout(() => resolve(42), 50))" },
    DEFAULT_READ_PAGE,
    { advanceMs: 60 },
  );

  // THEN the promise is awaited and its value is the answer, not the promise object:
  assert.equal(answer.ok, true);
  assert.equal(answer.result.result, 42);

  // ... and the deadline timer is gone although nobody drained the clock: 1 940 ms of
  // it were still to come, and only `withinDeadline`'s `clearTimeout` can have removed
  // them. (After `advanceToQuiescence` this assertion would hold either way, so it
  // proves nothing — that is what `advanceMs` is for.)
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withAPromisePastTheDeadline_shouldAnswerEvalTimeout", async () => {
  // GIVEN a code whose promise settles long after the deadline — 3 000 ms against
  // 2 000 — so the page-side timer is the one that answers,
  // WHEN the bridge evaluates it,
  const { answer, clock, pageClocks } = await evalOnce({
    code: "return new Promise((resolve) => setTimeout(() => resolve(1), 3000))",
  });

  // THEN the answer is `eval_timeout`, and not a value nobody waited for,
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "eval_timeout");

  // ... and the page's own timer was disarmed on the way out: the harness drained the
  // clock, so an untouched timer map is the only thing this can prove — the pending
  // one is the 3 000 ms timer the *code* armed, which no snippet may cancel.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_whenThePageNeverAnswers_shouldAnswerEvalTimeoutThroughTheGuard", async () => {
  // GIVEN a frame that takes the file but never answers — the shape a throttled page
  // timer leaves behind in a window nobody focuses,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    pageAgent: {
      frames: [{ href: DEFAULT_READ_PAGE.url }, { href: "https://widget.example.net/kalender" }],
      // The shape a throttled page leaves behind, now on the injection itself: the `func`
      // never settles, so `executeScript` never answers.
      neverAnswer: true,
    },
  });
  const { socket, clock } = await connectedBackground({ tabs, settings: EVAL_ENABLED_SETTINGS });

  // WHEN the bridge evaluates code and time is let past the extension's own deadline —
  // not the page's, which never fires here,
  await sendEval(socket, 2, { code: "return 1" });
  assert.equal(responsesById(socket).has(2), false, "no answer may exist before the guard fires");
  clock.runByDelay(EVAL_GUARD_MS);
  await settleAsyncWork();

  // THEN `eval_timeout` arrives from the extension. Without `EVAL_GUARD_MS` this case
  // would sit here until the hub gave up after `CALL_TIMEOUT_MS` and the caller would
  // read `ExtensionTimeout` instead of the truth,
  assert.equal(responsesById(socket).get(2).error.code, "eval_timeout");

  // ... and the same holds with a `frame`: the guard answers *no* answer from *any*
  // frame, and the frame selection behind it would have read that silence as
  // `frame_not_found` — a wrong cause for a call that only ran out of time,
  await sendEval(socket, 3, { code: "return 1", frame: "widget" });
  clock.runByDelay(EVAL_GUARD_MS);
  await settleAsyncWork();
  assert.equal(responsesById(socket).get(3).error.code, "eval_timeout");

  // ... and the guard took its own timer with it. No reply budget is left armed: with no
  // channel there is no collection waiting for a frame that never spoke,
  assert.deepStrictEqual(clock.pendingDelays(), []);
  // ... and a call that ran out of time cannot be answered afterwards,
  await settleAsyncWork();
  assert.equal(responsesById(socket).get(2).error.code, "eval_timeout");
  assert.equal(responsesById(socket).get(3).error.code, "eval_timeout");
});

test("eval_inParallelInTheSameTab_shouldAnswerBoth", async () => {
  // GIVEN one agent tab and two calls that arrive in the same tick,
  const { tabs, pageClocks } = evaluatingTabs();
  const started = await connectedBackground({ tabs, settings: EVAL_ENABLED_SETTINGS });

  // WHEN the bridge sends both before the first answer exists,
  started.socket.receive({ type: "request", id: 2, method: "eval", params: { code: "return 1" } });
  started.socket.receive({ type: "request", id: 3, method: "eval", params: { code: "return 2" } });
  await settleAsyncWork();

  // THEN both are answered: `eval` knows no slot, so neither call replaces the other
  // and neither is a `superseded`,
  const answers = responsesById(started.socket);
  assert.equal(answers.get(2).ok, true);
  assert.equal(answers.get(3).ok, true);
  assert.equal(answers.get(2).result.result, 1);
  assert.equal(answers.get(3).result.result, 2);

  // ... and the slot map never heard of this tab — the record a `click` or a `navigate`
  // leaves is not there, because a code whose effects nobody knows gets no window.
  const mapKeys = inThisRealm(started.sandbox.__bcMapOps.map(({ key }) => key));
  assert.deepStrictEqual(mapKeys.filter((key) => key === 500), []);
  assertNoTimerLeft(started.clock, pageClocks);
});

test("eval_withUndefinedFunctionAndBigIntResults_shouldMapThemAsDocumented", async () => {
  // GIVEN one connected extension and three codes, each producing a value JSON cannot
  // carry as it is,
  const { tabs, pageClocks } = evaluatingTabs();
  const { socket, clock } = await connectedBackground({ tabs, settings: EVAL_ENABLED_SETTINGS });

  // WHEN the bridge runs them in turn,
  await sendEval(socket, 2, { code: "return undefined" });
  await sendEval(socket, 3, { code: "return () => 1" });
  await sendEval(socket, 4, { code: "return 10n" });

  // THEN each is mapped as the contract says — `undefined` is `null`, a function and a
  // `BigInt` are strings the caller can read instead of an empty answer,
  const answers = responsesById(socket);
  assert.equal(answers.get(2).ok, true);
  assert.equal(answers.get(2).result.result, null);
  assert.equal(answers.get(3).result.result, "[function]");
  assert.equal(answers.get(4).result.result, "10");

  // ... and no call left a timer behind, on either side.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withAnUndefinedField_shouldKeepTheKeyWithNull", async () => {
  // GIVEN a code whose result carries an `undefined` *field*,
  // WHEN the bridge evaluates it,
  const { answer, clock, pageClocks } = await evalOnce({ code: "return { a: undefined }" });

  // THEN the key survives with `null`: `JSON.stringify` alone would drop it, and a
  // missing field says something else than a field that is `null`,
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(inThisRealm(answer.result.result), { a: null });
  assert.deepStrictEqual(inThisRealm(Object.keys(answer.result.result)), ["a"]);

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withACircularResult_shouldAnswerEvalResultUnserializable", async () => {
  // GIVEN a result that points at itself,
  // WHEN the bridge evaluates it,
  const { answer, clock, pageClocks } = await evalOnce({ code: "const loop = {}; loop.self = loop; return loop;" });

  // THEN the refusal names the reason instead of half a JSON or an empty answer:
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "eval_result_unserializable");

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withAResultOfExactlyTenThousandJsonCharacters_shouldAnswerOk", async () => {
  // GIVEN a result whose JSON is exactly 10 000 characters. `JSON.stringify` of a
  // string adds the two quotes, so 9 998 x's are exactly at the limit — the boundary
  // case, not one character past it,
  const { answer, clock, pageClocks } = await evalOnce({ code: `return "x".repeat(${EVAL_RESULT_LIMIT - 2})` });

  // THEN the answer is `ok` and the result is the string itself, untouched:
  assert.equal(answer.ok, true);
  assert.equal(answer.result.result.length, EVAL_RESULT_LIMIT - 2);
  assert.equal(JSON.stringify(answer.result.result).length, EVAL_RESULT_LIMIT);

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withAResultOfTenThousandAndOneJsonCharacters_shouldAnswerTooLarge", async () => {
  // GIVEN one character more than the limit allows,
  const { answer, clock, pageClocks } = await evalOnce({ code: `return "x".repeat(${EVAL_RESULT_LIMIT - 1})` });

  // THEN the result is refused, not cut: a half JSON is no answer, and a cut one would
  // make the caller believe the page said something shorter,
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "eval_result_too_large");
  assert.equal("result" in answer, false);

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withAThrownMessageOf600Characters_shouldCutItAt500", async () => {
  // GIVEN a code throwing a message six hundred characters long,
  // WHEN the bridge evaluates it,
  const { answer, clock, pageClocks } = await evalOnce({ code: "throw new Error('y'.repeat(600))" });

  // THEN the message is cut at the documented limit and still readable:
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "eval_failed");
  assert.equal(answer.error.message.length, EVAL_MESSAGE_LIMIT);
  assert.equal(answer.error.message.startsWith("yyy"), true);

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withADomNodeResult_shouldAnswerTheSelectorOfThatElement", async () => {
  // GIVEN a page with a real tree and a link that carries an id,
  const { page } = createInspectFixture();

  // WHEN the code hands that element back,
  const { answer, clock, pageClocks } = await evalOnce({ code: 'return document.querySelector("#warenkorb-link")' }, page);

  // THEN the answer is the node form of the contract, with the selector a caller can
  // hand straight back to `click` — and `tag` spelled like the selector spells it,
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(inThisRealm(answer.result.result), {
    kind: "node",
    tag: "a",
    selector: "a#warenkorb-link",
  });

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withATextNodeResult_shouldAnswerKindNodeAndNodeType", async () => {
  // GIVEN a page with a real tree and a text node — a node with no tag and no selector,
  const { page } = createInspectFixture();

  // WHEN the code hands that node back,
  const { answer, clock, pageClocks } = await evalOnce({ code: 'return document.createTextNode("x")' }, page);

  // THEN the second node branch answers with `kind` and `nodeType` and nothing else:
  // its content is one `.textContent` away in a second call, and an empty object here
  // would look like a silent non-answer,
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(inThisRealm(answer.result.result), { kind: "node", nodeType: 3 });

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

/* ----------------------------------------------------------------- reconnect */

test("onMessage_withUnknownMethod_shouldReplyUnsupportedMethod", async () => {
  // GIVEN a connected extension,
  await startBackground({ settings: { endpoint: ENDPOINT, token: TOKEN }, windows: [] });
  const socket = await openSocket();
  socket.receive({ type: "welcome", protocol: 1, bridgeVersion: "0.1.0" });
  await settleAsyncWork();

  // WHEN the bridge asks for a method this increment does not implement — since
  // increment 7 that is nothing real any more, so the case uses a name that never
  // will be (`focus` and friends are simply later increments),
  socket.receive({ type: "request", id: 7, method: "no_such_method", params: {} });
  await settleAsyncWork();

  // THEN the reply is a refusal that names the reason, not silence:
  assert.deepStrictEqual(socket.sent.at(-1), {
    type: "response",
    id: 7,
    ok: false,
    error: { code: "unsupported_method", message: "unsupported method: no_such_method" },
  });
});

test("reconnect_afterEachCloseWithoutWelcome_shouldBackOffExponentially", async () => {
  // GIVEN a configured extension that never gets a `welcome`,
  const { clock } = await startBackground({ settings: { endpoint: ENDPOINT, token: TOKEN } });
  const firstSocket = FakeWebSocket.latest();

  // WHEN the connection closes three times in a row,
  const delays = [];
  let currentSocket = firstSocket;
  for (let round = 0; round < 3; round += 1) {
    currentSocket.fail();
    // One settle before the clock: the retry is armed after the page has asked the store
    // whether the switch is still on (spec 44), so the timer exists one microtask later
    // than the close.
    await settleAsyncWork();
    delays.push(clock.runNext());
    await settleAsyncWork();
    currentSocket = FakeWebSocket.latest();
  }

  // THEN the delays follow `min(30 s, 1 s · 2^(n−1))`; the jitter is pinned to
  // zero by the sandbox's `Math`:
  assert.deepStrictEqual(delays, [1000, 2000, 4000]);
});

test("reconnect_afterWelcome_shouldResetBackoffToTheFirstDelay", async () => {
  // GIVEN a connection that already failed twice,
  const { clock } = await startBackground({ settings: { endpoint: ENDPOINT, token: TOKEN } });
  FakeWebSocket.latest().fail();
  // The switch is consulted before the retry is armed (spec 44), hence the settle.
  await settleAsyncWork();
  clock.runNext();
  await settleAsyncWork();
  FakeWebSocket.latest().fail();
  await settleAsyncWork();
  clock.runNext();
  await settleAsyncWork();

  // WHEN the next attempt is greeted with `welcome` and closes afterwards,
  const socket = await openSocket();
  socket.receive({ type: "welcome", protocol: 1, bridgeVersion: "0.1.0" });
  await settleAsyncWork();
  socket.fail();

  // THEN the attempt counter starts over — a bridge restart must not cost the
  // operator the last backoff step:
  await settleAsyncWork();
  assert.equal(clock.runNext(), 1000);
});


/* -------------------------------------------------------------- screenshot */

/**
 * The switch of spec 20 is off unless the operator turned it on, so a case that wants a
 * picture has to store it. Same shape as `EVAL_ENABLED_SETTINGS` and for the same
 * reason: a naked `{ allowScreenshot: true }` would drop the agent tab along with it
 * and answer `no_agent_tab` for the wrong reason.
 */
const SCREENSHOT_ENABLED_SETTINGS = { ...STORED_TAB_SETTINGS, allowScreenshot: true };

/**
 * The deadline the extension puts around one rung of the shrinking ladder.
 *
 * Spelled out here instead of read out of `background.js`: the number is part of the
 * contract (`## Risiken`), and a case that imported it could never notice a changed value.
 */
const SCREENSHOT_ENCODE_TIMEOUT_MS = 3000;

/** Sends one `screenshot` request; `{}` means "the last used agent tab". */
async function sendScreenshot(socket, id, params = {}) {
  socket.receive({ type: "request", id, method: "screenshot", params });
  await settleAsyncWork();
}

/** A data URL around an arbitrary base64 streak — for the pictures that are none. */
function dataUrlOf(base64) {
  return `data:image/png;base64,${base64}`;
}

/*
 * The encoder stub's two branches are not equally travelled: the ladder only ever asks
 * for `image/jpeg` today, so its PNG branch has no case behind it and would be inherited
 * silently by part 2. Hence this one direct case — it is about the harness, and it says
 * so. `iVBORw0KGgo` alone would not do: eleven characters end in the middle of a group,
 * the filler behind them decodes one byte short, and the length proof would rest on a
 * number nobody checked.
 */
test("encodedBase64Of_forThePngBranch_shouldDecodeToTheByteCountItWasAskedFor", () => {
  // GIVEN the format no screenshot case encodes today but Teil 2 will,
  // WHEN the stub describes a 68-byte PNG,
  const base64 = encodedBase64Of("image/png", 68);
  const decoded = Buffer.from(base64, "base64");

  // THEN the signature really leads the streak — the head pin of the format is intact,
  assert.deepStrictEqual([...decoded.subarray(0, PNG_SIGNATURE.length)], PNG_SIGNATURE);

  // ... the streak is a whole number of four-character groups, so nothing behind the
  // magic is shifted out of alignment,
  assert.equal(base64.length % 4, 0);

  // ... and it decodes to exactly the 68 bytes the case asked for. The seven-character
  // `iVBORw0` that stood here read as 6 bytes and decoded a 68-byte streak to 67; a
  // length proof that is off by one is worse than none.
  assert.equal(decoded.length, 68);
});

test("screenshot_withAStoredAgentTab_shouldAnswerThePngWithItsHeader", async () => {
  // GIVEN a complete agent tab and a capture that answers the 68-byte 1×1 PNG,
  const tabs = createTabsStub({ tabs: [createAgentTabFixture({ status: "complete" })] });
  const { socket, clock, encoder } = await connectedBackground({
    tabs,
    settings: SCREENSHOT_ENABLED_SETTINGS,
  });

  // WHEN the bridge asks for a picture,
  await sendScreenshot(socket, 2);

  // THEN the transport answers with the picture and with the four fields that describe
  // it — the header is read, not guessed:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.tabId, 500);
  assert.equal(answer.result.format, "png");
  assert.equal(answer.result.scaled, false);
  assert.equal(answer.result.bytes, 68);
  assert.equal(answer.result.width, 1);
  assert.equal(answer.result.height, 1);

  // ... the base64 part without its `data:` prefix, byte for byte what the stub handed
  // out — a prefix left on would make `bytesOf` count header text as picture,
  assert.equal(
    answer.result.base64,
    ONE_BY_ONE_PNG_DATA_URL.slice("data:image/png;base64,".length),
  );

  // ... the tab was asked for a PNG exactly once, the window stayed alone and no focus
  // grab happened,
  assert.deepStrictEqual(inThisRealm(tabs.captureCalls), [
    { tabId: 500, details: { format: "png" } },
  ]);
  assert.equal(answer.result.activated, false);
  assert.deepStrictEqual(tabs.calls, []);

  // ... and nothing was injected: a picture needs no `executeScript` (criterion 6).
  assert.deepStrictEqual(tabs.scriptCalls, []);

  // ... and stage 0 was never encoded: the capture fits, so the ladder only measured it
  // and no deadline was ever armed,
  assert.deepStrictEqual(encoder.encodeCalls, []);
  assert.deepStrictEqual(clock.pendingDelays(), []);
  assert.equal(clock.armedDelays.filter((delay) => delay === SCREENSHOT_ENCODE_TIMEOUT_MS).length, 0);
});

test("screenshot_withAPictureOfExactlyTheLimit_shouldAnswerOk", async () => {
  // GIVEN a capture whose PNG is exactly 3 145 728 decoded bytes,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    captureDataUrl: pngDataUrlFor({ width: 1600, height: 900, byteCount: 3145728 }),
  });
  const { socket } = await connectedBackground({ tabs, settings: SCREENSHOT_ENABLED_SETTINGS });

  // WHEN the bridge asks for it,
  await sendScreenshot(socket, 2);

  // THEN the limit is inclusive: the picture travels as it was taken, in PNG,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.bytes, 3145728);
  assert.equal(answer.result.format, "png");
  assert.equal(answer.result.scaled, false);
  assert.equal(answer.result.width, 1600);
  assert.equal(answer.result.height, 900);
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_withAPictureOneByteOverTheLimit_shouldShrinkToTheFirstStage", async () => {
  // GIVEN a capture one byte past the limit that stage 1 brings down to exactly the
  // limit — the boundary of criterion 1, seen from the ladder's side,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    captureDataUrl: pngDataUrlFor({ width: 1600, height: 900, byteCount: 3145729 }),
  });
  const { socket, clock, encoder } = await connectedBackground({
    tabs,
    settings: SCREENSHOT_ENABLED_SETTINGS,
    encoder: createEncoderStub({ byteCounts: [3145728], sourceWidth: 1600, sourceHeight: 900 }),
  });

  // WHEN the bridge asks for it,
  await sendScreenshot(socket, 2);

  // THEN one byte decides: the picture travels, but no longer as the capture — stage 1
  // re-encoded it, and the limit is inclusive on the result too,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.bytes, 3145728);
  assert.equal(answer.result.format, "jpeg");
  assert.equal(answer.result.scaled, true);
  assert.equal(answer.result.width, 1600);
  assert.equal(answer.result.height, 900);

  // ... exactly one encoding was needed, and it is the q = 0.75 rung,
  assert.equal(encoder.encodeCalls.length, 1);
  assert.equal(encoder.encodeCalls[0].quality, 0.75);
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_whenTheFirstStageFits_shouldAnswerTheJpegItEncoded", async () => {
  // GIVEN a 1600 × 900 capture of 3 300 000 bytes and an encoder whose first answer
  // fits,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    captureDataUrl: pngDataUrlFor({ width: 1600, height: 900, byteCount: 3300000 }),
  });
  const { socket, clock, encoder } = await connectedBackground({
    tabs,
    settings: SCREENSHOT_ENABLED_SETTINGS,
    encoder: createEncoderStub({ byteCounts: [3000000], sourceWidth: 1600, sourceHeight: 900 }),
  });

  // WHEN the bridge asks for it,
  await sendScreenshot(socket, 2);

  // THEN the answer describes the encoded picture, not the capture beside it: `jpeg`,
  // `scaled: true`, 3 000 000 bytes and the JPEG's own magic in front (criterion 3),
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.format, "jpeg");
  assert.equal(answer.result.scaled, true);
  assert.equal(answer.result.bytes, 3000000);
  assert.equal(answer.result.base64.startsWith("/9j/"), true, "the base64 must be the JPEG");
  assert.equal(answer.result.base64.startsWith("iVBORw0"), false);

  // ... with the dimensions of a *stage-1* picture: the longer edge was already inside
  // 1600, so it stays — and `scaled` is therefore no synonym for "fewer pixels",
  assert.equal(answer.result.width, 1600);
  assert.equal(answer.result.height, 900);

  // ... exactly one encoding ran, the first rung with quality 0.75,
  assert.equal(encoder.encodeCalls.length, 1);
  assert.equal(encoder.encodeCalls[0].type, "image/jpeg");
  assert.equal(encoder.encodeCalls[0].quality, 0.75);
  assert.equal(encoder.encodeCalls[0].width, 1600);

  // ... and its deadline was disarmed again: one rung, one 3 000 ms guard, nothing left
  // pending,
  assert.deepStrictEqual(clock.pendingDelays(), []);
  assert.equal(
    clock.armedDelays.filter((delay) => delay === SCREENSHOT_ENCODE_TIMEOUT_MS).length,
    encoder.encodeCalls.length,
  );

  // ... and nothing was injected, re-encoding included: the ladder works on a picture,
  // never on the page (criterion 6).
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_whenOnlyTheSecondStageFits_shouldAnswerWithQualityHalf", async () => {
  // GIVEN a capture of 3 300 000 bytes whose first re-encode is still too large,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    captureDataUrl: pngDataUrlFor({ width: 1600, height: 900, byteCount: 3300000 }),
  });
  const { socket, clock, encoder } = await connectedBackground({
    tabs,
    settings: SCREENSHOT_ENABLED_SETTINGS,
    encoder: createEncoderStub({
      byteCounts: [3300000, 2500000],
      sourceWidth: 1600,
      sourceHeight: 900,
    }),
  });

  // WHEN the bridge asks for it,
  await sendScreenshot(socket, 2);

  // THEN the second rung answered — the ladder really walks on, it does not stop at the
  // first attempt that failed,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.format, "jpeg");
  assert.equal(answer.result.bytes, 2500000);
  assert.equal(encoder.encodeCalls.length, 2);
  assert.equal(encoder.encodeCalls[1].quality, 0.5);

  // ... and both guards were armed and cleared,
  assert.deepStrictEqual(clock.pendingDelays(), []);
  assert.equal(
    clock.armedDelays.filter((delay) => delay === SCREENSHOT_ENCODE_TIMEOUT_MS).length,
    encoder.encodeCalls.length,
  );

  // ... and the second rung injected nothing either (criterion 6).
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_whenOnlyTheThirdStageFits_shouldScaleDownToTwelveHundred", async () => {
  // GIVEN a capture of 3 300 000 bytes that only the pixel-reducing rung brings under
  // the limit,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    captureDataUrl: pngDataUrlFor({ width: 1600, height: 900, byteCount: 3300000 }),
  });
  const { socket, clock, encoder } = await connectedBackground({
    tabs,
    settings: SCREENSHOT_ENABLED_SETTINGS,
    encoder: createEncoderStub({
      byteCounts: [3300000, 3200000, 3100000],
      sourceWidth: 1600,
      sourceHeight: 900,
    }),
  });

  // WHEN the bridge asks for it,
  await sendScreenshot(socket, 2);

  // THEN stage 3 drew the picture at 1200 × 675 — the longer edge capped, the ratio kept
  // — with q = 0.6,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(encoder.encodeCalls.length, 3);
  assert.equal(encoder.encodeCalls[2].width, 1200);
  assert.equal(encoder.encodeCalls[2].height, 675);
  assert.equal(encoder.encodeCalls[2].quality, 0.6);

  // ... and the answer reports the size it delivered, not the capture's,
  assert.equal(answer.result.width, 1200);
  assert.equal(answer.result.height, 675);
  assert.equal(answer.result.bytes, 3100000);
  assert.equal(answer.result.format, "jpeg");
  assert.deepStrictEqual(clock.pendingDelays(), []);

  // ... and the rung that changed the pixels still changed nothing on the page
  // (criterion 6).
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_whenEveryStageIsTooLarge_shouldNameTheLastStageNumbers", async () => {
  // GIVEN a capture that no rung brings under the limit,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    captureDataUrl: pngDataUrlFor({ width: 1600, height: 900, byteCount: 3300000 }),
  });
  const { socket, clock, encoder } = await connectedBackground({
    tabs,
    settings: SCREENSHOT_ENABLED_SETTINGS,
    encoder: createEncoderStub({
      byteCounts: [3300000, 3250000, 3200000],
      sourceWidth: 1600,
      sourceHeight: 900,
    }),
  });

  // WHEN the bridge asks for it,
  await sendScreenshot(socket, 2);

  // THEN the refusal is actionable: it names the bytes and the size of the *last* rung,
  // so the caller can judge whether another tab would help (criterion 4),
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "screenshot_too_large");
  assert.match(answer.error.message, /too large even after scaling down/);
  assert.match(answer.error.message, /3200000/);
  assert.match(answer.error.message, /1200 × 675/);
  assert.match(answer.error.message, /3145728/);

  // ... every rung was tried exactly once, and the interim wording of the unshrunk
  // branch is gone,
  assert.equal(encoder.encodeCalls.length, 3);
  assert.equal(/Das Bild ist zu groß/.test(answer.error.message), false);
  assert.deepStrictEqual(clock.pendingDelays(), []);

  // ... and a refusal is no reason to reach for the page either (criterion 6).
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_withAPictureAlreadyInsideTheStageEdge_shouldNotEnlargeIt", async () => {
  // GIVEN a capture smaller than every rung's edge — 800 × 450,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    captureDataUrl: pngDataUrlFor({ width: 800, height: 450, byteCount: 3300000 }),
  });
  const { socket, encoder } = await connectedBackground({
    tabs,
    settings: SCREENSHOT_ENABLED_SETTINGS,
    encoder: createEncoderStub({ byteCounts: [3000000], sourceWidth: 800, sourceHeight: 450 }),
  });

  // WHEN the bridge asks for it,
  await sendScreenshot(socket, 2);

  // THEN the canvas keeps the capture's size: enlarging to 1600 would add bytes and no
  // detail,
  assert.equal(encoder.encodeCalls.length, 1);
  assert.equal(encoder.encodeCalls[0].width, 800);
  assert.equal(encoder.encodeCalls[0].height, 450);
  assert.equal(responsesById(socket).get(2).result.width, 800);

  // ... and no injection was needed to keep the size (criterion 6).
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_whenTheDecodedPictureHasNoPixels_shouldAnswerScreenshotFailed", async () => {
  // GIVEN a capture the fake decoder answers with 0 × 0 — the shape a failed decode
  // leaves behind, from which a canvas would produce `"data:,"`,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    captureDataUrl: pngDataUrlFor({ width: 1600, height: 900, byteCount: 3300000 }),
  });
  const { socket, encoder } = await connectedBackground({
    tabs,
    settings: SCREENSHOT_ENABLED_SETTINGS,
    encoder: createEncoderStub({ byteCounts: [], sourceWidth: 0, sourceHeight: 0 }),
  });

  // WHEN the bridge asks for it,
  await sendScreenshot(socket, 2);

  // THEN the guard answers instead of the ladder: an empty picture would report
  // `bytes: 0` and claim it fits,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "screenshot_failed");

  // ... and no canvas was ever asked for bytes.
  assert.deepStrictEqual(encoder.encodeCalls, []);

  // ... and the guard answered without touching the page (criterion 6).
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_whenTheDecodingNeverFinishes_shouldAnswerScreenshotFailedOnTheDeadline", async () => {
  // GIVEN a capture whose decode never comes back — the shape of a hung `Image`,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    captureDataUrl: pngDataUrlFor({ width: 1600, height: 900, byteCount: 3300000 }),
  });
  const { socket, clock } = await connectedBackground({
    tabs,
    settings: SCREENSHOT_ENABLED_SETTINGS,
    encoder: createEncoderStub({ byteCounts: [3000000], decodeNeverFinishes: true }),
  });

  // WHEN the bridge asks for a picture and the stage deadline is let past,
  await sendScreenshot(socket, 2);
  assert.equal(
    responsesById(socket).has(2),
    false,
    "no answer may exist before the encode deadline fires",
  );
  clock.runByDelay(SCREENSHOT_ENCODE_TIMEOUT_MS);
  await settleAsyncWork();

  // THEN the call ends instead of waiting forever, and the guard took its timer with it,
  assert.equal(responsesById(socket).get(2).error.code, "screenshot_failed");
  assert.deepStrictEqual(clock.pendingDelays(), []);

  // ... and the rung that ran out of time injected nothing (criterion 6).
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_whenTheSwitchIsOff_shouldRefuseWithoutCapturing", async () => {
  // GIVEN a complete agent tab and a store that carries no switch — the default, off,
  const tabs = createTabsStub({ tabs: [createAgentTabFixture({ status: "complete" })] });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for a picture,
  await sendScreenshot(socket, 2);

  // THEN the operator's decision answers, not the browser,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "screenshot_not_allowed");
  assert.match(answer.error.message, /Screenshots/);

  // ... and `captureTab` was not called at all: the switch protects the tab, it does
  // not merely decorate the answer. The count, not the wording, is the proof,
  assert.equal(tabs.captureCalls.length, 0);
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_whenTheOptionReadFails_shouldTreatTheSwitchAsOffAndWarn", async () => {
  // GIVEN a `storage.local` that refuses to hand out the switch — an unreadable answer
  // must never be the permissive one, exactly as with `allowPasswordFields`,
  const tabs = createTabsStub({ tabs: [createAgentTabFixture({ status: "complete" })] });
  const { socket, consoleLines } = await connectedBackground({
    tabs,
    settings: SCREENSHOT_ENABLED_SETTINGS,
    storageReadFailsFor: ["allowScreenshot"],
  });

  // WHEN the bridge asks for a picture,
  await sendScreenshot(socket, 2);

  // THEN the broken read counts as "off": the refusal, no capture, and the operator's
  // console says why the picture did not happen,
  assert.equal(responsesById(socket).get(2).error.code, "screenshot_not_allowed");
  assert.equal(tabs.captureCalls.length, 0);
  assert.deepStrictEqual(tabs.scriptCalls, []);
  assert.ok(
    consoleLines.some((line) => line.startsWith("warn:") && line.includes("Bildschirmfotos")),
    "the failed option read must be reported once",
  );
});

test("screenshot_withTabAsAString_shouldAnswerInvalidParamsWithoutCapturing", async () => {
  // GIVEN the switch on and a complete agent tab, so this case is about the argument,
  const tabs = createTabsStub({ tabs: [createAgentTabFixture({ status: "complete" })] });
  const { socket } = await connectedBackground({ tabs, settings: SCREENSHOT_ENABLED_SETTINGS });

  // WHEN the caller sends a tab id as a string,
  await sendScreenshot(socket, 2, { tab: "500" });

  // THEN the inherited addressing rule answers — one `invalid_params`, checked before
  // anything is photographed,
  assert.equal(responsesById(socket).get(2).error.code, "invalid_params");
  assert.equal(tabs.captureCalls.length, 0);
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_withATabThatIsNotInTheList_shouldAnswerNoAgentTabWithoutCapturing", async () => {
  // GIVEN the switch on and a live tab of the operator's own that is not the agent's,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" }), createAgentTabFixture({ id: 999 })],
  });
  const { socket } = await connectedBackground({ tabs, settings: SCREENSHOT_ENABLED_SETTINGS });

  // WHEN the caller names that tab,
  await sendScreenshot(socket, 2, { tab: 999 });

  // THEN it is `no_agent_tab` — never a picture of a tab nobody opened for the agent,
  assert.equal(responsesById(socket).get(2).error.code, "no_agent_tab");
  assert.equal(tabs.captureCalls.length, 0);
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_whenTheFirstCaptureFails_shouldActivateTheTabAndAnswerOk", async () => {
  // GIVEN an agent tab in the back and a capture that fails once — the shape of a
  // window group where Firefox photographs only the active tab,
  const calls = [];
  const tabs = createTabsStub({
    calls,
    tabs: [createAgentTabFixture({ status: "complete", active: false })],
    captureThrowsTimes: 1,
  });
  const { socket } = await connectedBackground({
    tabs,
    calls,
    settings: SCREENSHOT_ENABLED_SETTINGS,
  });

  // WHEN the bridge asks for a picture,
  await sendScreenshot(socket, 2);

  // THEN the second attempt answers, and the answer says the tab had to come forward,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.activated, true);
  assert.equal(answer.result.bytes, 68);

  // ... exactly two captures were tried,
  assert.equal(tabs.captureCalls.length, 2);

  // ... and exactly one focus grab happened, with `active: true` and nothing else —
  // the window stays where it is,
  assert.deepStrictEqual(inThisRealm(tabs.calls), [
    { kind: "tabs.update", tabId: 500, changes: { active: true } },
  ]);
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_whenTheFirstCaptureFailsOnAnActiveTab_shouldAnswerWithoutFocusing", async () => {
  // GIVEN the agent tab already in front and a capture that fails once,
  const calls = [];
  const tabs = createTabsStub({
    calls,
    tabs: [createAgentTabFixture({ status: "complete", active: true })],
    captureThrowsTimes: 1,
  });
  const { socket } = await connectedBackground({
    tabs,
    calls,
    settings: SCREENSHOT_ENABLED_SETTINGS,
  });

  // WHEN the bridge asks for a picture,
  await sendScreenshot(socket, 2);

  // THEN the second attempt still runs, and it answers,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(tabs.captureCalls.length, 2);

  // ... but `activated` is `false` and no `tabs.update` was sent: a focus grab on a tab
  // that is already in front would have no effect and would still be a change,
  assert.equal(answer.result.activated, false);
  assert.deepStrictEqual(inThisRealm(tabs.calls), []);
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_whenBothCapturesFail_shouldAnswerScreenshotFailedWithoutStack", async () => {
  // GIVEN a capture that fails twice — a page Firefox cannot photograph at all,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    captureThrowsTimes: 2,
  });
  const { socket } = await connectedBackground({ tabs, settings: SCREENSHOT_ENABLED_SETTINGS });

  // WHEN the bridge asks for a picture,
  await sendScreenshot(socket, 2);

  // THEN the browser's own message travels, cut and without a stack,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "screenshot_failed");
  assert.equal(answer.error.message, "Unable to capture tab");
  assert.equal(answer.error.message.includes("\n"), false, "a stack must not travel");

  // ... both attempts were made, and nothing was injected.
  assert.equal(tabs.captureCalls.length, 2);
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_withAPictureTooShortForAHeader_shouldAnswerScreenshotFailed", async () => {
  // GIVEN a data URL of 16 base64 characters — 12 decoded bytes and no PNG header,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    captureDataUrl: dataUrlOf(Buffer.alloc(12).toString("base64")),
  });
  const { socket } = await connectedBackground({ tabs, settings: SCREENSHOT_ENABLED_SETTINGS });

  // WHEN the bridge asks for a picture,
  await sendScreenshot(socket, 2);

  // THEN no answer invents dimensions: `0 × 0` would be a silent non-answer, so the
  // missing header is a refusal,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "screenshot_failed");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("screenshot_withAPictureOfFortyBytesWithoutSignature_shouldAnswerScreenshotFailed", async () => {
  // GIVEN a streak long enough for a header whose bytes simply are no PNG signature,
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    captureDataUrl: dataUrlOf(Buffer.alloc(40, 0x41).toString("base64")),
  });
  const { socket } = await connectedBackground({ tabs, settings: SCREENSHOT_ENABLED_SETTINGS });

  // WHEN the bridge asks for a picture,
  await sendScreenshot(socket, 2);

  // THEN the signature check answers, not the length: 40 bytes of `A` are long enough
  // and still no image,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "screenshot_failed");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

/* ----------------------------------------------------------------- frames */

test("frames_withThreeFrames_shouldListEveryAddressAndMarkTheMainFrame", async () => {
  // GIVEN an agent tab whose page holds two more frames — one of them an empty one,
  // which only `matchAboutBlank` reaches at all:
  const tabs = createFramesTabs([
    { href: "https://example.org/", top: true },
    { href: "https://widget.example.net/kalender", top: false },
    { href: "about:blank", top: false },
  ]);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the list,
  await sendFrames(socket, 2);

  // THEN every frame is named with its own address, the outermost one is marked with
  // `top: true`, and `count` is the number of entries — all of it in the order the
  // injection answered, which is the one thing this call does *not* promise:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(inThisRealm(answer.result), {
    tabId: 500,
    url: "https://before.example/",
    count: 3,
    frames: [
      { href: "https://example.org/", top: true },
      { href: "https://widget.example.net/kalender", top: false },
      { href: "about:blank", top: false },
    ],
  });

  // ... and it was exactly one injection: a list waits for no page, so a settle
  // snippet in front of it would only cost time.
  assert.equal(tabs.scriptCalls.length, 1);

  // ... and that one injection has the shape the whole tool depends on: every frame,
  // `about:blank` included, and *no* `frameIds` — the two exclude each other in
  // `scripting.executeScript`. Pinned as the whole target plus the file list, so a
  // mutation run without one of the parts fails with a readable diff instead of a list of
  // "the page saw only the main frame".
  assert.deepStrictEqual(tabs.scriptCalls[0].details.target, { tabId: 500, allFrames: true });
  assert.deepStrictEqual(tabs.scriptCalls[0].details.files, [PAGE_AGENT_FILE]);
});

test("frames_withAnEmptyEntry_shouldNotShiftTheFilter", async () => {
  // GIVEN a frame list whose middle entry hands back no address — a frame the browser
  // reported without a usable `href`, so the caller could not address it either:
  const tabs = createFramesTabs([
    { href: "https://example.org/", top: true },
    { href: 42, top: false },
    { href: "https://widget.example.net/", top: false },
  ]);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the list,
  await sendFrames(socket, 2);

  // THEN the entry is out of the list *and* out of the count — `count` and `frames`
  // may never name two different numbers under one word:
  const result = inThisRealm(responsesById(socket).get(2).result);
  assert.equal(result.count, 2);
  assert.deepStrictEqual(result.frames, [
    { href: "https://example.org/", top: true },
    { href: "https://widget.example.net/", top: false },
  ]);
});

test("frames_withoutAStoredAgentTab_shouldAnswerNoAgentTabAndInjectNothing", async () => {
  // GIVEN a connected extension that has never navigated — no agent tab, although the
  // operator's window has one:
  const tabs = createFramesTabs([]);
  const { socket } = await connectedBackground({ tabs });

  // WHEN the bridge asks for the frames,
  await sendFrames(socket, 2);

  // THEN it is the code `read` answers — and nothing was injected into a tab nobody
  // opened for the agent:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "no_agent_tab");
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("frames_whenTheTabIsStillLoading_shouldAnswerPageBusyLikeRead", async () => {
  // GIVEN a tab that reports `loading`, so the injection is refused before there is a
  // page to inventory:
  const tabs = createFramesTabs([{ href: AGENT_URL, top: true }], {
    tabs: [createAgentTabFixture({ status: "loading" })],
    refuseInjection: true,
  });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the frames,
  await sendFrames(socket, 2);

  // THEN the refusal speaks about the moment — the code the bridge turns into "try
  // again in a moment" — and not about a page that has nothing to give:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "page_busy");
});

test("frames_whenThePageRefusesInjection_shouldAnswerNotReadableWithTheReadFrame", async () => {
  // GIVEN a page the extension may not inject into — the browser's own settings page:
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ url: "about:preferences", status: "complete" })],
    pageAgent: { frames: [{ href: "about:preferences" }], refuseInjection: true },
  });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the frames,
  await sendFrames(socket, 2);

  // THEN it is `read`'s error frame, `details` included: the address and the kind are
  // what the bridge's sentence needs, and `frames` must not grow a second version of
  // that sentence:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "not_readable");
  assert.equal(answer.error.url, "about:preferences");
  assert.equal(answer.error.kind, "internal");
});

test("frames_whenASelfReportIsUnusable_shouldAnswerFramesFailedInsteadOfAnEmptyList", async () => {
  // GIVEN a frame whose report cannot be read — a value that is not an object, which is
  // our own bug and never a page without frames:
  const tabs = createFramesTabs([{ href: AGENT_URL, top: true }], {
    answer: () => ({ value: "kein Bericht" }),
  });
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the list,
  await sendFrames(socket, 2);

  // THEN the answer is `frames_failed`, not a well-formed inventory with `count: 0`:
  // "there are no frames" and "nobody can read the answer" are two different facts, and
  // an empty list would hand the caller the wrong one — with `ok: true` on top.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "frames_failed");
  assert.equal(answer.result, undefined);
});

test("frames_inventory_shouldComeFromSelfReports", async () => {
  // GIVEN two frames with addresses of their own — the main frame and a widget:
  const tabs = createFramesTabs([
    { href: AGENT_URL, top: true },
    { href: "https://widget.example.net/kalender", top: false },
  ]);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the list,
  await sendFrames(socket, 2);

  // THEN the call was a broadcast of one `inventory` op — no payload, because a frame
  // answers about itself and the bridge only collects:
  assert.deepStrictEqual(tabs.channel.ops(), ["inventory"]);
  assert.deepStrictEqual(tabs.channel.calls[0].message.args, {});
  assert.deepStrictEqual(tabs.channel.calls[0].frameIds, [0, 1]);

  // ... and the list is the frames' own words, each answer carrying the frame id the
  // sender added — the extension never asked a frame for its id:
  assert.deepStrictEqual(
    tabs.channel.answers.map((answer) => answer.frameId),
    [0, 1],
  );
  const result = inThisRealm(responsesById(socket).get(2).result);
  assert.equal(result.count, 2);
  assert.deepStrictEqual(result.frames, [
    { href: AGENT_URL, top: true },
    { href: "https://widget.example.net/kalender", top: false },
  ]);
});

/* ------------------------------------------------------- read: frame (spec 24) */

test("read_withoutFrame_shouldInjectIntoTheMainFrameOnly", async () => {
  // GIVEN a normal page and a read that names no frame — the call every earlier
  // increment makes:
  const tabs = createReadTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge reads with a window,
  await sendRead(socket, 2, { offset: 0, maxChars: 10 });

  // THEN the answer is unchanged in shape,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.text, "Erste Zeil");

  // ... and both injections really went to the main frame: `frameIds: [0]`, no
  // `allFrames` — criterion 1 of spec 24, during the increment that opened the frames.
  assert.equal(tabs.scriptCalls.length, 2);
  for (const call of tabs.scriptCalls) {
    assert.deepStrictEqual(
      call.details.target.frameIds,
      [0],
      "a read without `frame` addresses the main frame",
    );
    assert.equal(call.details.target.allFrames, undefined, "and asks for exactly one frame");
  }

  // ... and the read call carries no filter: `want: null` is the main frame, and the page
  // compares no address for it.
  assert.deepStrictEqual(inThisRealm(tabs.channel.calls[1].message.args), {
    offset: 0,
    maxChars: 10,
    mode: "text",
    minChars: ARTICLE_MIN_CHARS,
    urlLimit: URL_LIMIT,
    titleLimit: TITLE_LIMIT,
    want: null,
  });
});

test("read_withFrame_shouldAnswerTheTextOfTheAddressedFrame", async () => {
  // GIVEN a page with a widget iframe whose text differs from the main frame's,
  const tabs = createFramedReadTabs(FRAMED_READ_PAGES);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge reads through the substring of the widget's address,
  await sendRead(socket, 2, { frame: "widget" });

  // THEN every field comes from that frame — address, title and text — and the wait
  // reports the pair the addressed frame produced, not the main frame's silence:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(inThisRealm(answer.result), {
    tabId: 500,
    url: "https://widget.example.net/kalender",
    title: "Kalender",
    text: "Text des Widget-Rahmens",
    offset: 0,
    chars: 23,
    totalChars: 23,
    truncated: false,
    via: "innerText",
    mode: "text",
    settled: true,
    waitedMs: QUIET_WINDOW_MS,
  });

  // ... and exactly two injections happened, both of them into every frame.
  assert.equal(tabs.scriptCalls.length, 2);
});

test("read_withFrameAndTheFramesAnsweringInTheOtherOrder_shouldStillAnswerThatFrame", async () => {
  // GIVEN the same two frames, handed back by the browser in the reverse order — the
  // one thing `executeScript` does not promise:
  const tabs = createFramedReadTabs([...FRAMED_READ_PAGES].reverse());
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge reads through the same substring,
  await sendRead(socket, 2, { frame: "widget" });

  // THEN the same frame answers. Position decides nothing here: the answer that counts
  // is the one whose own address matched, which is why the filter travels into the page.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.text, "Text des Widget-Rahmens");
  assert.equal(answer.result.url, "https://widget.example.net/kalender");
  assert.notEqual(answer.result.text, "Text des Hauptrahmens", "the main frame must not answer");
});

test("read_withAFrameThatMatchesNoFrame_shouldAnswerFrameNotFoundWithTheAnsweredCount", async () => {
  // GIVEN two frames, neither of them matching,
  const tabs = createFramedReadTabs(FRAMED_READ_PAGES);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge reads through a substring that hits nothing,
  await sendRead(socket, 2, { frame: "gibtsnicht" });

  // THEN the filter's own code answers, with the number of frames that *answered* —
  // both of them, so the caller can tell a wrong substring from a page whose embeds
  // never came back. No text, no `read_failed`:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "frame_not_found");
  assert.equal(answer.error.frames, 2);
  assert.equal(answer.error.message, "No frame matches the given frame.");
  assert.equal(answer.result, undefined);
});

test("read_withAFrameThatMatchesTwoFrames_shouldAnswerFrameAmbiguousWithTheCandidates", async () => {
  // GIVEN two frames that share their address — two embeds of the same widget,
  const tabs = createFramedReadTabs([
    { href: "https://widget.example.net/kalender", title: "Oben", text: "Oben", top: false },
    { href: "https://widget.example.net/kalender", title: "Unten", text: "Unten", top: false },
  ]);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge reads through a substring both of them match,
  await sendRead(socket, 2, { frame: "kalender" });

  // THEN the call is refused with the colliding addresses, so the caller learns how to
  // answer more precisely instead of receiving one of the two frames' texts:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "frame_ambiguous");
  assert.deepStrictEqual(inThisRealm(answer.error.candidates), [
    "https://widget.example.net/kalender",
    "https://widget.example.net/kalender",
  ]);
  assert.equal(answer.result, undefined);
});

test("read_withAnInvalidFrame_shouldAnswerInvalidParamsAndInjectNothing", async () => {
  // GIVEN the values the extension cannot act on — the empty string, which `includes`
  // would turn into \"the first frame that answers\", and a number, which is no substring
  // at all:
  const refused = [{ frame: 16 }, { frame: "" }, { frame: 3 }];
  const tabs = createReadTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge reads with one of them,
  for (const params of refused) {
    const id = 2 + refused.indexOf(params);
    await sendRead(socket, id, params);

    // THEN the refusal is our own `invalid_params` with the sentence that names the
    // parameter — and nothing was injected for a request that could not be answered:
    const answer = responsesById(socket).get(id);
    assert.equal(answer.ok, false, `${JSON.stringify(params)} must be refused`);
    assert.equal(answer.error.code, "invalid_params");
    assert.equal(answer.error.message, "frame must be a string.");
  }
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("read_withAnInvalidFrameAndAnInvalidWindow_shouldAnswerTheWindowFirst", async () => {
  // GIVEN a call that is wrong twice — `maxChars: 0` and `frame: 3`:
  const tabs = createReadTabs();
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge reads with both,
  await sendRead(socket, 2, { maxChars: 0, frame: 3 });

  // THEN the window is named: the frame check runs *after* the argument check, so the
  // caller hears about the mistake it can fix without a browser — and the frames are not
  // consulted for a request that never got that far.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "invalid_params");
  assert.equal(answer.error.message, `maxChars must be an integer from 1 to ${READ_MAX_CHARS_LIMIT}.`);
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("read_withFrame_shouldSettleInTheAddressedFrameWithTheSameFilter", async () => {
  // GIVEN a page with a widget iframe; every frame has its own clock, and the wait
  // really runs in all of them,
  const tabs = createFramedReadTabs(FRAMED_READ_PAGES);
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge reads through the widget's substring,
  await sendRead(socket, 2, { offset: 0, maxChars: 10, frame: "widget" });

  // THEN the wait ran in every frame, with the filter in its message:
  assert.equal(tabs.scriptCalls.length, 2);
  assert.deepStrictEqual(tabs.channel.ops(), ["settle", "read"], "the read must settle first");
  const settleShape = { ...tabs.scriptCalls[0].details };
  assert.deepStrictEqual(settleShape.target, { tabId: 500, allFrames: true });
  assert.deepStrictEqual(settleShape.files, [PAGE_AGENT_FILE]);
  assert.equal(tabs.channel.calls[0].message.args.want, "widget");

  // ... the read itself equally so, with the filter in its own message — the proving
  // half of "no silent return to the main frame":
  assert.deepStrictEqual({ ...tabs.scriptCalls[1].details }, settleShape);
  assert.deepStrictEqual(inThisRealm(tabs.channel.calls[1].message.args), {
    offset: 0,
    maxChars: 10,
    mode: "text",
    minChars: ARTICLE_MIN_CHARS,
    urlLimit: URL_LIMIT,
    titleLimit: TITLE_LIMIT,
    want: "widget",
  });

  // ... and the answer carries the wait of the addressed frame, not `NO_SETTLE`: a
  // settle wait that stayed in the main frame would find nothing to select and report
  // the silence of a frame nobody asked about.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.result.settled, true);
  assert.equal(answer.result.waitedMs, QUIET_WINDOW_MS);

  // ... and neither frame kept a timer armed: the settle ran in both realms, so both
  // deadlines have to be disarmed — a single clock would hide the frame that leaked.
  const pageClocks = tabs.channel.pageClocks();
  assert.equal(pageClocks.length, 2);
  assertNoTimerLeft(clock, pageClocks);
});

/* ------------------------------------------------------ inspect: frame (spec 25) */

/**
 * The two frames of an `inspect`-with-`frame` case: the invented query page in the main
 * frame, and a widget frame whose one link the main frame does not carry.
 *
 * Ids, texts and addresses differ on purpose — an answer from the wrong frame is then a
 * wrong string, not a coincidence.
 */
function createFramedInspectPages() {
  const calendarLink = createInspectElement({
    tagName: "A",
    id: "kalender-termin",
    innerText: "Erfundener Termin",
    href: "https://widget.example.net/kalender/termin",
  });
  return [
    createInspectFixture().page,
    createInspectPage({
      url: "https://widget.example.net/kalender",
      title: "Kalender",
      children: [calendarLink],
    }),
  ];
}

/**
 * The framed inspect path through the message channel: every frame answers for itself.
 *
 * `tabs.channel.answers` is the wire record — `{frameId, message}` in arrival order —
 * and it is what proves "the filter is the first statement": the frame nobody addressed
 * answers the marker, the addressed one answers its query.
 */
function createFramedInspectTabs(pages) {
  return { tabs: createFramedPageAgentTabs(pages) };
}

test("inspect_withFrame_shouldAnswerTheElementsOfTheAddressedFrame", async () => {
  // GIVEN a page whose widget iframe holds a link the main frame does not have,
  const { tabs } = createFramedInspectTabs(createFramedInspectPages());
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge inspects through the substring of the widget's address,
  await sendInspect(socket, 2, { selector: "a", frame: "widget" });

  // THEN address, title and the one element come from that frame — the answer is honest
  // about where it read, instead of naming the tab,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.url, "https://widget.example.net/kalender");
  assert.equal(answer.result.title, "Kalender");
  assert.equal(answer.result.count, 1);
  assert.deepStrictEqual(
    inThisRealm(answer.result.elements.map((element) => element.id)),
    ["kalender-termin"],
  );

  // ... and the single injection really addressed every frame: without the switch the
  // widget would never have answered at all,
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(tabs.scriptCalls[0].details.target.allFrames, true);
  assert.equal(tabs.scriptCalls[0].details.target.frameIds, undefined);
  assert.deepStrictEqual(tabs.scriptCalls[0].details.files, [PAGE_AGENT_FILE]);

  // ... and the substring travelled to the page, where the filter compares it,
  assert.equal(tabs.channel.calls[0].message.args.want, "widget");
});

test("inspect_withFrameAndTheFramesAnsweringInTheOtherOrder_shouldStillAnswerThatFrame", async () => {
  // GIVEN the same two frames, handed back in the reverse order — the one thing
  // `executeScript` does not promise:
  const { tabs } = createFramedInspectTabs([...createFramedInspectPages()].reverse());
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge inspects through the same substring,
  await sendInspect(socket, 2, { selector: "a", frame: "widget" });

  // THEN the same frame answers: position decides nothing, the answer that counts is the
  // one whose own address matched.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.url, "https://widget.example.net/kalender");
  assert.deepStrictEqual(
    inThisRealm(answer.result.elements.map((element) => element.id)),
    ["kalender-termin"],
  );
});

test("inspect_withFrame_shouldLeaveTheUnaddressedFrameUnqueried", async () => {
  // GIVEN a page whose main frame throws the moment anybody asks it for a list — the
  // proof that the filter runs *first* and is no cleanup afterwards,
  const [main, widget] = createFramedInspectPages();
  createInspectBody(main).querySelectorAll = () => {
    throw new Error("the unaddressed frame must not be queried");
  };
  const { tabs } = createFramedInspectTabs([main, widget]);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge inspects the widget's text,
  await sendInspect(socket, 2, { text: "termin", frame: "widget" });

  // THEN the widget answered its query,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true, `the main frame must not answer: ${JSON.stringify(answer.error)}`);
  assert.equal(answer.result.count, 1);

  // ... and the main frame answered nothing but the marker: no query, no `invalid_selector`
  // from the throwing stub, no count.
  assert.deepStrictEqual(inThisRealm(tabs.channel.answers[0].message.value), {
    outcome: "not_the_frame",
    href: AGENT_URL,
  });
});

test("inspect_withoutFrame_shouldInjectIntoTheMainFrameOnly", async () => {
  // GIVEN the same two frames and an inspect that names none of them,
  const { tabs } = createFramedInspectTabs(createFramedInspectPages());
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge inspects the page,
  await sendInspect(socket, 2, { selector: "a#warenkorb-link" });

  // THEN the main frame answers — the call every earlier increment makes stays exactly
  // as it was,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.url, AGENT_URL);

  // ... and the injection addressed exactly one frame: `frameIds: [0]`, no `allFrames`
  // — criterion 1 of spec 25, during the increment that opened the frames,
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(
    tabs.scriptCalls[0].details.target.frameIds,
    [0],
    "inspect without `frame` addresses the main frame",
  );
  assert.equal(tabs.scriptCalls[0].details.target.allFrames, undefined, "and asks for exactly one frame");

  // ... and the call carries `null` as its filter, the main-frame answer of
  // `isAddressedFrame` — one shape for both callers instead of two requests.
  assert.equal(tabs.channel.calls[0].message.args.want, null);
  assert.equal(tabs.channel.calls[0].frameIds.length, 1, "one frame, and it is the main one");
});

test("inspect_withAFrameThatMatchesNoFrame_shouldAnswerFrameNotFoundWithTheAnsweredCount", async () => {
  // GIVEN two frames, neither of them matching,
  const { tabs } = createFramedInspectTabs(createFramedInspectPages());
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge inspects through a substring that hits nothing,
  await sendInspect(socket, 2, { selector: "a", frame: "gibtsnicht" });

  // THEN the filter's own code answers, with the number of frames that *answered* — both
  // of them, so the caller can tell a wrong substring from a page whose embeds never came
  // back. No element list, no `inspect_failed`:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "frame_not_found");
  assert.equal(answer.error.frames, 2);
  assert.equal(answer.error.message, "No frame matches the given frame.");
  assert.equal(answer.result, undefined);
});

test("inspect_withAFrameThatMatchesTwoFrames_shouldAnswerFrameAmbiguousWithTheCandidates", async () => {
  // GIVEN two frames that share their address — two embeds of the same widget,
  const calendarLink = createInspectElement({ tagName: "A", id: "termin-oben", innerText: "Oben" });
  const otherLink = createInspectElement({ tagName: "A", id: "termin-unten", innerText: "Unten" });
  const sharedAddress = "https://widget.example.net/kalender";
  const { tabs } = createFramedInspectTabs([
    createInspectPage({ url: sharedAddress, children: [calendarLink] }),
    createInspectPage({ url: sharedAddress, children: [otherLink] }),
  ]);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge inspects through a substring both of them match,
  await sendInspect(socket, 2, { selector: "a", frame: "kalender" });

  // THEN the call is refused with the colliding addresses, so the caller learns how to
  // answer more precisely instead of receiving one of the two frames' lists:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "frame_ambiguous");
  assert.equal(answer.error.message, "Several frames match the given frame.");
  assert.deepStrictEqual(inThisRealm(answer.error.candidates), [sharedAddress, sharedAddress]);
  assert.equal(answer.result, undefined);
});

test("inspect_withAnInvalidFrame_shouldAnswerInvalidParamsAndInjectNothing", async () => {
  // GIVEN the values the extension cannot act on — a number, which is no substring at
  // all, `null`, which is not the "absent" the parameter means, and the empty string,
  // which `includes` would turn into "the first frame that answers":
  const refused = [{ selector: "a", frame: 3 }, { selector: "a", frame: null }, { selector: "a", frame: "" }];
  const { tabs } = createFramedInspectTabs(createFramedInspectPages());
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge inspects with one of them,
  let id = 2;
  for (const params of refused) {
    await sendInspect(socket, id, params);

    // THEN the refusal is our own `invalid_params` with the sentence that names the
    // parameter,
    const answer = responsesById(socket).get(id);
    assert.equal(answer.ok, false, `${JSON.stringify(params)} must be refused`);
    assert.equal(answer.error.code, "invalid_params", JSON.stringify(params));
    assert.equal(answer.error.message, "frame must be a string.");
    id += 1;
  }

  // ... and nothing was injected for a request that could not be answered.
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

/* --------------------------------------------------------- eval: frame (spec 25) */

/**
 * The framed eval path: every frame waits on its own virtual clock (the page deadline),
 * so every answer comes with its own timer map.
 *
 * The clocks go back to the case because `assertNoTimerLeft` has to see *every* frame: a
 * deadline that stayed armed in a frame nobody addressed is exactly the leak a single
 * clock would hide. The frames arrive in the order `pages` lists them, which is the order
 * the harness lets them answer — the browser promises no order, and no case here relies
 * on one.
 */
function createFramedEvalTabs(pages) {
  const pageClocks = pages.map(() => createPageClock());
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    pageAgent: {
      frames: pages.map((page, index) => ({
        href: page.url,
        page,
        clock: pageClocks[index],
        top: page.inFrame !== true,
      })),
    },
  });
  return { tabs, pageClocks };
}

/**
 * The two frames of an eval case, as the realm each snippet runs in: the read realm of
 * the frame, whose `location.href` and `document.title` are the frame's own.
 */
function createFramedEvalPages() {
  return FRAMED_READ_PAGES.map(readPageOfFrame);
}

test("eval_withFrame_shouldRunTheCodeInTheAddressedFrame", async () => {
  // GIVEN a page whose widget iframe carries its own title, and the switch on,
  const { tabs, pageClocks } = createFramedEvalTabs(createFramedEvalPages());
  const { socket, clock } = await connectedBackground({ tabs, settings: EVAL_ENABLED_SETTINGS });

  // WHEN the bridge evaluates through the substring of the widget's address,
  await sendEval(socket, 2, { code: "return document.title", frame: "widget" });

  // THEN the code ran in that frame and the answer names it — address, title and value,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.result, "Kalender");
  assert.equal(answer.result.url, "https://widget.example.net/kalender");
  assert.equal(answer.result.title, "Kalender");

  // ... the injection really addressed every frame, so both realms were asked,
  assert.equal(tabs.scriptCalls.length, 1);
  assert.equal(tabs.scriptCalls[0].details.target.allFrames, true);
  assert.equal(tabs.scriptCalls[0].details.target.frameIds, undefined);
  // ... and the filter travels in the injection's own arguments: `eval` takes no channel
  // any more (specs 47 and 49), so `details.files` is gone and `want` rides in `args`.
  assert.equal(tabs.scriptCalls[0].details.files, undefined);
  assert.deepStrictEqual(tabs.scriptCalls[0].details.args.slice(2), ["widget"]);
  assert.deepStrictEqual(tabs.channel.calls, []);

  // ... both frame clocks were seen and both are empty: the deadline timer of the frame
  // that answered and of the one that only said `not_the_frame`.
  assert.equal(pageClocks.length, 2);
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withAFrameThatMatchesNoFrame_shouldAnswerFrameNotFound", async () => {
  // GIVEN two frames, neither of them matching,
  const { tabs, pageClocks } = createFramedEvalTabs(createFramedEvalPages());
  const { socket, clock } = await connectedBackground({ tabs, settings: EVAL_ENABLED_SETTINGS });

  // WHEN the bridge evaluates through a substring that hits nothing,
  await sendEval(socket, 2, { code: "return 1", frame: "gibtsnicht" });

  // THEN the filter's verdict answers, with the number of frames that answered — and not
  // `eval_failed`, which would blame the code for a frame nobody addressed,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "frame_not_found");
  assert.equal(answer.error.frames, 2);
  assert.equal(answer.result, undefined);

  // ... and no timer outlived the call, on either side of the wire.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withFrame_shouldNotRunTheCodeInTheUnaddressedFrame", async () => {
  // GIVEN two frames whose titles differ, the main frame's and the widget's,
  const pages = createFramedEvalPages();
  const { tabs, pageClocks } = createFramedEvalTabs(pages);
  const { socket, clock } = await connectedBackground({ tabs, settings: EVAL_ENABLED_SETTINGS });

  // WHEN the bridge runs code that writes the title, addressed to the widget,
  await sendEval(socket, 2, { code: "document.title = 'geaendert'; return 1", frame: "widget" });

  // THEN it ran in that frame — the answer comes from there and the write landed,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.result, 1);
  assert.equal(pages[1].title, "geaendert", "the addressed frame must carry the write");

  // ... and in *that* frame only. This is the case the whole filter exists for: a frame
  // nobody addressed runs no code at all, so a call meant for the widget cannot change
  // the main page. `__probe` would prove nothing here — `pageContextOf` rebuilds `window`
  // per snippet — so the write goes through `document.title`, whose accessor writes back
  // onto the page object.
  assert.equal(pages[0].title, "Hauptseite", "the unaddressed frame must be untouched");

  // ... and both realms are quiet afterwards.
  assertNoTimerLeft(clock, pageClocks);
});

test("eval_withTwoFramesThatBothThrow_shouldAnswerFrameAmbiguousWithBothAddresses", async () => {
  // GIVEN two frames that share their address — two embeds of the same widget — and a
  // page on which the code will throw in both of them,
  const pages = [
    { href: "https://widget.example.net/kalender", title: "Oben", text: "", top: false },
    { href: "https://widget.example.net/kalender", title: "Unten", text: "", top: false },
  ].map(readPageOfFrame);
  const { tabs, pageClocks } = createFramedEvalTabs(pages);
  const { socket, clock } = await connectedBackground({ tabs, settings: EVAL_ENABLED_SETTINGS });

  // WHEN the bridge evaluates through the substring both of them match,
  await sendEval(socket, 2, { code: "throw new Error('boem')", frame: "kalender" });

  // THEN the ambiguity answers, and both candidates carry their address: a refusal is an
  // answer like any other, so it says where it came from — two `null`s would leave the
  // caller with the unusable advice to address "no frame" more precisely. Both frames
  // threw, so nothing here was `not_the_frame` and both count as hits.
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "frame_ambiguous");
  assert.deepStrictEqual(inThisRealm(answer.error.candidates), [
    "https://widget.example.net/kalender",
    "https://widget.example.net/kalender",
  ]);

  // ... and the throwing realms left no timer behind either.
  assertNoTimerLeft(clock, pageClocks);
});

/* ------------------------------------------------------------- transcript */

/** The markers the four transcript snippets carry — the same trick `settle` uses. */
/**
 * An array-like object with no `map`, no `filter` and no iterator.
 *
 * That is what an Xray wrapper of a page array hands out (spec 33, M11), and it is the
 * whole reason the model snippet copies field by field: a snippet that reached for an
 * array method on a page object would work on this side of the wrapper and fail in the
 * operator's profile. Here it fails in the test instead.
 */
function arrayLikeOf(items) {
  const list = { length: items.length };
  for (const [index, item] of items.entries()) list[index] = item;
  return list;
}

/**
 * One `captionTracks` entry as the player response carries it.
 *
 * The name is `{simpleText}` because that is how YouTube writes it; `kind` is derived from
 * the `vssId` prefix, because both say the same thing (M1) and a case that declared two
 * different truths would be a case about the fixture.
 */
function createCaptionTrack({ languageCode, vssId = languageCode, name = languageCode }) {
  return {
    languageCode,
    vssId,
    name: { simpleText: name },
    kind: String(vssId).startsWith("a.") ? "asr" : "",
  };
}

/**
 * The plain name of a track: what the model snippet hands out and what the menu lists.
 *
 * `createCaptionTrack` keeps the response's `{simpleText}` shape, because that is what the
 * page carries; every fixture that needs the *text* goes through here instead of assuming
 * which shape it is.
 */
function captionTextOf(track) {
  return typeof track.name === "string" ? track.name : track.name.simpleText;
}

/** One `audioTracks` entry: the id, and the caption index this track belongs to. */
function createAudioTrack({ audioTrackId, defaultCaptionTrackIndex }) {
  return { audioTrackId, defaultCaptionTrackIndex };
}

/** The original audio track as M2 measured it: no `.3` suffix, pointing at the original. */
function createOriginalAudioTrack(defaultCaptionTrackIndex) {
  return createAudioTrack({ audioTrackId: "en-US.4", defaultCaptionTrackIndex });
}

/** A translated audio track: named after its language, with the `.3` suffix of M2. */
function createTranslationAudioTrack({ languageCode, defaultCaptionTrackIndex }) {
  return createAudioTrack({ audioTrackId: `${languageCode}.3`, defaultCaptionTrackIndex });
}

/** The player response behind the model, in the shape YouTube really ships. */
function createPlayerResponse({ captionTracks = [], audioTracks = [] } = {}) {
  return {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: arrayLikeOf(captionTracks),
        audioTracks: arrayLikeOf(audioTracks),
      },
    },
  };
}

/**
 * The response at a dotted path inside the operator's object graph.
 *
 * A loop, not a chain of literals: the candidate list of the model snippet is a list of
 * exactly such paths, and a case that puts the response somewhere else is the case that
 * proves the list is walked in order.
 */
function windowWithResponseAt(path, response) {
  const window = {};
  const parts = path.split(".");
  let current = window;
  for (const part of parts.slice(0, -1)) {
    current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = response;
  return window;
}

/** One JSON3 event: the start in milliseconds and the pieces of its text. */
function createJson3Event(tStartMs, pieces) {
  return { tStartMs, dDurationMs: 2000, segs: pieces.map((utf8) => ({ utf8 })) };
}

/**
 * One signed `api/timedtext` address of a track, as the player would have requested it.
 *
 * The signature is a placeholder and deliberately not a 32+-hex streak: this file is grepped
 * for secrets, and a plausible-looking one would turn that grep red.
 */
function transcriptResourceOf(track, expire) {
  return (
    `https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&lang=${track.languageCode}` +
    `${track.kind === "asr" ? "&kind=asr" : ""}&expire=${expire}&signature=platzhalter`
  );
}

/**
 * The tab every transcript case runs in. Explicit, because the wire is keyed by tab id and
 * the page fixture has to name the same one the tab stub holds (spec 34).
 */
const TRANSCRIPT_TAB_ID = 500;

/**
 * The bridge page's wait for the wire after a jump (spec 34), driven by the cases.
 *
 * The 3000 is a copy of `TRANSCRIPT_CAPTION_DEADLINE_MS` in `extension/background.js`, and
 * that is deliberate: the cases fire the deadline by name, and a helper that imported the
 * number out of the source would be a helper that agrees with whatever it finds there. If
 * the production number moves, `sendTranscriptAfterTheDeadline` fails loudly with "no timer
 * was armed with 3000 ms" instead of quietly firing some other deadline.
 */
const TRANSCRIPT_CAPTION_DEADLINE_MS = 3000;

/**
 * The requests of every track of a page, in track order, as the observer would hear them
 * (M1, M13).
 *
 * The `expire` counts up with the track: the last request of a language is the one with
 * the freshest signature, and a case that wants an older one names it itself.
 */
function createTranscriptWire(tabId, captionTracks) {
  return captionTracks.map((track, index) => ({
    tabId,
    url: transcriptResourceOf(track, index + 1),
  }));
}

/**
 * The one timeline of the invented page: track clicks, menu toggles and playhead writes in
 * one array.
 *
 * Two separate arrays cannot show the order the restore promises — pick, jump, put the track
 * back, put the playhead back — because swapping the last two steps leaves both of them
 * unchanged. `clicks()` and `writes()` are views on this array, so every case that only counts
 * still reads what it always read, and the case that cares about the order reads `events`.
 *
 * The settings button lands in it as well (`menu:open` / `menu:close`): whether a popup was
 * toggled *between* two picks is the only place where "the tool reopened the menu it just
 * closed" can be seen — the popup's state at the end of a run is the same in both cases.
 */
function createEventLog() {
  const events = [];
  const CLICK = "click:";
  const WRITE = "write:";
  const MENU = "menu:";
  return {
    events,
    recordClick(text) {
      events.push(`${CLICK}${text}`);
    },
    recordWrite(value) {
      events.push(`${WRITE}${value}`);
    },
    recordMenu(opened) {
      events.push(`${MENU}${opened ? "open" : "close"}`);
    },
    clicks() {
      return events.filter((event) => event.startsWith(CLICK)).map((event) => event.slice(CLICK.length));
    },
    writes() {
      return events
        .filter((event) => event.startsWith(WRITE))
        .map((event) => Number(event.slice(WRITE.length)));
    },
  };
}

/**
 * The `<video>` of the invented watch page, with every write to `currentTime` recorded.
 *
 * A plain property cannot show a write that changes nothing, and the whole contract of the
 * restore is *which* writes happen in *which* order: `[start + 1, start]` (criterion 6).
 * `onWrite` is where a case says what the player does after a jump — it fetches the file of
 * the track it is on (M17), and that is what makes an index pick fail loudly instead of
 * quietly answering another language. The writes land in the page's `log`, so their order
 * against a track click stays readable.
 */
function createPageVideo({
  currentTime = 19.1,
  duration = 600,
  onWrite = () => {},
  log = createEventLog(),
} = {}) {
  const video = {
    get writes() {
      return log.writes();
    },
    duration,
    get currentTime() {
      return currentTime;
    },
    set currentTime(value) {
      log.recordWrite(value);
      currentTime = value;
      onWrite(value);
    },
  };
  return video;
}

/** The two entries a track list carries besides the tracks themselves (M16: 33 = 31 + 2). */
const MENU_OFF_TEXT = "Aus";
const MENU_TRANSLATE_TEXT = "Automatisch übersetzen";

/**
 * One row of the player's top-level settings menu: a localized label and a value.
 *
 * `content` is a function when the value follows the page state — the row of the running
 * track shows the track that is running, which is how it is updated after a pick.
 */
function createMenuRow({ label, content, onClick = () => {} }) {
  const contentElement = {
    get innerText() {
      return typeof content === "function" ? content() : content;
    },
  };
  const row = {
    innerText: label,
    clicks: 0,
    getAttribute: () => null,
    querySelector: (selector) => (selector === ".ytp-menuitem-content" ? contentElement : null),
    click() {
      row.clicks += 1;
      onClick();
    },
  };
  return row;
}

/**
 * One entry of the track list: the language name, and the player's `aria-checked` mark.
 *
 * The mark is read off `state.checked` — the entry object, not its text — so two entries
 * with the same name stay two entries. A click is a pick: the player marks it, shows it in
 * the settings row and closes the popup. `clicksTakeEffect` is how a case models a click the
 * list does not answer — the mark stays where it was, which is exactly what a re-rendered
 * menu or a disabled row looks like.
 *
 * `generation` is which opening of the popup built this node, and `checkedOnlyWhenOpen` is the
 * page that shows the mark only on the nodes of the popup that is open now: a node from an
 * earlier opening answers `null` instead of a mark. That is the shape a re-rendered list has,
 * and the one a read of a stale node must not mistake for "the pick did not take effect".
 *
 * `throwOnRestoreClick` lets the restore click of a run throw (the page loses its list
 * mid-click): the click reached the page, so it is logged, and the menu closes before the
 * error travels — the playhead write after it is what such a case is about.
 */
function createMenuEntry({ text, state, generation = 0 }) {
  const entry = {
    innerText: text,
    text,
    generation,
    clicks: 0,
    getAttribute: (name) => {
      if (name !== "aria-checked") return null;
      if (!state.checkedOnlyWhenOpen) return state.checked === entry ? "true" : "false";
      // Only the list that is on screen answers a mark, and only on the nodes this opening
      // built: a node of a closed popup and a node of an earlier opening both answer nothing.
      const onScreen = state.open && state.panel === "tracks";
      if (!onScreen || entry.generation !== state.generation) return null;
      return state.checked === entry ? "true" : "false";
    },
    querySelector: () => null,
    click() {
      entry.clicks += 1;
      state.log.recordClick(text);
      // The one click that puts back what the page started with is the restore's: anything
      // else is a pick, and the page answers it or not.
      const isRestoreClick =
        state.throwOnRestoreClick &&
        state.initialCheckedText !== null &&
        text === state.initialCheckedText &&
        (state.checked === null || state.checked.text !== text);
      if (isRestoreClick) {
        state.open = false;
        state.panel = null;
        throw new Error("the track list went away mid-click");
      }
      if (state.clicksTakeEffect) {
        state.checked = entry;
        state.contentName = text;
      }
      state.open = false;
      state.panel = null;
    },
  };
  return entry;
}

/**
 * The player's settings popup of the invented watch page (spec 33, M16/M5).
 *
 * `entryTexts` is the order the *menu* lists the tracks in, and in the cases that matter it
 * is deliberately not the order of the model: a pick by position would then land on another
 * track and the case would go red. `contentName` is the value of the row that opens the
 * track list — it has to be one of the names the model carries, because that value is the
 * only anchor this tool has (M16). `checkedText` is the entry the popup marks as running.
 *
 * Every click lands in the page's `log` (`createEventLog`), which is the only place where a
 * click and a playhead write can be seen in the order they happened.
 *
 * The off state keeps a track name in the row and the off entry checked. M16 measured the
 * row with a track selected; that the row keeps the last track's name while captions are off
 * is the shape this fixture *assumes*, because the anchor would otherwise be unfindable in
 * that state.
 *
 * `menuOpen` is the state the operator leaves the popup in: closed in the normal case, open
 * when they opened it themselves. The settings button toggles that state on every click, the
 * way the page does, so a case can read afterwards whether the tool left the popup as it found
 * it (`isOpen`).
 *
 * `checkedOnlyWhenOpen` models the page that rebuilds its track list on every opening: the
 * entries of the open panel are fresh nodes, the previous ones keep answering `null` for the
 * mark. `throwOnRestoreClick` makes the click that puts the page's first mark back throw.
 */
function createPlayerMenu({
  entryTexts,
  contentName = null,
  checkedText = null,
  rowLabel = "Sprachen",
  extraRows = [],
  log = createEventLog(),
  clicksTakeEffect = true,
  menuOpen = false,
  checkedOnlyWhenOpen = false,
  throwOnRestoreClick = false,
} = {}) {
  const state = {
    open: menuOpen,
    panel: menuOpen ? "top" : null,
    contentName,
    checked: null,
    initialCheckedText: null,
    generation: 0,
    entries: [],
    log,
    clicksTakeEffect,
    checkedOnlyWhenOpen,
    throwOnRestoreClick,
  };
  // One generation per opening of the track list: the entries a read collects live exactly as
  // long as the popup that built them. The mark is the page's state, so it follows the text
  // into the next generation — the nodes change, the pick does not.
  function buildEntries() {
    state.generation += 1;
    state.entries = entryTexts.map((text) =>
      createMenuEntry({ text, state, generation: state.generation }),
    );
    const checkedName = state.checked === null ? null : state.checked.text;
    state.checked =
      checkedName === null ? null : (state.entries.find((entry) => entry.text === checkedName) ?? null);
  }
  buildEntries();
  state.checked = state.entries.find((entry) => entry.text === checkedText) ?? null;
  state.initialCheckedText = state.checked === null ? null : state.checked.text;
  if (state.contentName === null) {
    state.contentName = state.checked === null ? "" : state.checked.text;
  }

  const rows = [
    createMenuRow({
      label: "Qualität",
      content: "Auto",
      onClick: () => {
        state.open = true;
        state.panel = "quality";
      },
    }),
    createMenuRow({
      label: rowLabel,
      content: () => state.contentName,
      onClick: () => {
        state.open = true;
        state.panel = "tracks";
        // Only the page that rebuilds its list answers a new opening with new nodes; every
        // other case keeps the nodes it handed out, exactly like a static list.
        if (state.checkedOnlyWhenOpen) buildEntries();
      },
    }),
    createMenuRow({ label: "Anmerkungen", content: MENU_OFF_TEXT }),
    ...extraRows.map((row) => createMenuRow({ label: row.label, content: () => row.content })),
  ];
  const settingsButton = {
    innerText: "",
    clicks: 0,
    click() {
      settingsButton.clicks += 1;
      if (state.open) {
        state.open = false;
        state.panel = null;
        log.recordMenu(false);
        return;
      }
      state.open = true;
      state.panel = "top";
      log.recordMenu(true);
    },
  };
  const panelOf = (items) => ({
    querySelectorAll: (selector) => (selector === ".ytp-menuitem" ? items : []),
    querySelector: () => null,
  });
  const topPanel = panelOf(rows);
  const tracksPanel = {
    querySelectorAll: (selector) => (selector === ".ytp-menuitem" ? state.entries : []),
    querySelector: () => null,
  };
  const otherPanel = panelOf([]);

  return {
    settingsButton,
    entryTexts: entryTexts.slice(),
    /** The clicked entry texts, in order — a view on the page's one event log. */
    get entryClicks() {
      return log.clicks();
    },
    checkedText: () => (state.checked === null ? "" : state.checked.text),
    contentName: () => state.contentName,
    isOpen: () => state.open,
    /** Every `.ytp-menuitem` on screen: the rows, and the open panel's entries. */
    items() {
      if (!state.open) return [];
      if (state.panel === "tracks") return [...rows, ...state.entries];
      return rows;
    },
    /** The panels, deepest last — the order the snippet relies on to find the open one. */
    panels() {
      if (!state.open) return [];
      if (state.panel === "tracks") return [topPanel, tracksPanel];
      if (state.panel === "quality") return [topPanel, otherPanel];
      return [topPanel];
    },
  };
}

/** How the track file of one track is keyed: uploaded `<lang>`, automatic `<lang>/asr`. */
function cuesKeyOf(track) {
  return track.kind === "asr" ? `${track.languageCode}/asr` : track.languageCode;
}

/**
 * The watch page the transcript snippets run in: the operator's object graph, the requests
 * its player made, the track files and the player.
 *
 * The model lists are array-like on purpose (`arrayLikeOf`), `wire` holds the
 * `api/timedtext` requests of this tab as the extension's observer will hear them
 * (`{ tabId, url }`, spec 34), `cues` are the track files keyed like the address, and
 * `fetched` collects what the snippet actually asked for — the handle a case reads when it
 * has to say *which* address was taken. `staleExpiries` names the `expire` values whose
 * signature has run out: those addresses answer 404, the way a file that is gone does.
 *
 * `playerMenu` is absent unless a case needs the settings popup. Without it any query for a
 * menu selector is an error (`querySelectorAllInTranscriptPage`), which is what keeps a
 * snippet from reading a menu the case did not model: every case whose track file is already
 * there never touches the player at all.
 */
function createTranscriptPage({
  url = "https://www.youtube.com/watch?v=aaaaaaaaaaa",
  visibilityState = "visible",
  rendered = true,
  pageWindow = {},
  wire = [],
  cues = {},
  staleExpiries = [],
  playerMenu,
  video = createPageVideo(),
} = {}) {
  return {
    transcript: true,
    url,
    title: "Ein Video",
    visibilityState,
    rendered: rendered ? { tagName: "YTD-WATCH-FLEXY" } : null,
    pageWindow,
    wire,
    cues,
    staleExpiries,
    playerMenu,
    video,
    fetched: [],
  };
}

/**
 * `document.querySelectorAll` of the invented watch page.
 *
 * The gate's one element, the player and its settings popup exist; everything else the
 * snippets read comes from `performance`, `window.wrappedJSObject` or the track file. An
 * unknown selector is an error, not an empty list — a fixture that answered `[]` to
 * everything would let a renamed production selector pass as "the page is not there".
 */
function querySelectorAllInTranscriptPage(page, selector) {
  if (selector === "ytd-watch-flexy") return page.rendered === null ? [] : [page.rendered];
  if (page.playerMenu !== undefined && page.playerMenu !== null) {
    if (selector === ".ytp-settings-button") return [page.playerMenu.settingsButton];
    if (selector === ".ytp-menuitem") return page.playerMenu.items();
    if (selector === ".ytp-panel-menu") return page.playerMenu.panels();
  }
  if (selector === "video") return page.video === undefined ? [] : [page.video];
  throw new Error(`the transcript page fixture does not know the selector ${JSON.stringify(selector)}`);
}

/**
 * `fetch` of the invented watch page, and the only request the transcript snippet makes.
 *
 * The track file is looked up by the two properties the snippet reads off the address —
 * the language and the kind — so a case cannot hand out a track the snippet did not ask
 * for. An address with nothing behind it is a 404, the way an expired signature answers —
 * and so is every address whose `expire` a case declared stale.
 */
function transcriptFetchOf(page, address) {
  page.fetched.push(address);
  const url = new URL(address);
  const expire = url.searchParams.get("expire") ?? "";
  const language = url.searchParams.get("lang") ?? "";
  const key = (url.searchParams.get("kind") ?? "") === "asr" ? `${language}/asr` : language;
  const events = page.cues[key];
  if (events === undefined || page.staleExpiries.includes(expire)) {
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ events }) });
}

/**
 * A watch page whose player response sits at `responsePath`, with a track file per
 * language in `texts`, and one observed request per caption track.
 *
 * `captionTracks` takes the entries of `createCaptionTrack`, not their raw fields: those
 * entries are what the response carries, and wrapping them twice would make the fixture
 * answer a name no case wrote. `texts` is keyed like the track file — `<lang>` or
 * `<lang>/asr` — and falls back to the plain language, so a case with one track per
 * language stays short.
 */
function createTranscriptModelPage({
  captionTracks = [],
  audioTracks = [],
  texts = {},
  url,
  visibilityState,
  rendered,
  responsePath = "ytplayer.bootstrapPlayerResponse",
} = {}) {
  const cues = {};
  for (const track of captionTracks) {
    const key = cuesKeyOf(track);
    const text = texts[key] ?? texts[track.languageCode];
    if (text === undefined) continue;
    cues[key] = [createJson3Event(4000, [text])];
  }
  return createTranscriptPage({
    url,
    visibilityState,
    rendered,
    pageWindow: windowWithResponseAt(
      responsePath,
      createPlayerResponse({ captionTracks, audioTracks }),
    ),
    wire: createTranscriptWire(TRANSCRIPT_TAB_ID, captionTracks),
    cues,
  });
}

/**
 * The transcript path through the message channel, on one clock.
 *
 * The page realm is the fixture's, and its clock is the one the case gets back: every op
 * of a call runs in that realm, so the injections of one call share one timeline and a
 * case can read that timeline (`clock.now()`) afterwards. The caption op is the async one
 * — its `fetch` resolves in the same realm.
 *
 * The page's `wire` becomes the tab's request wire *before* the bridge page loads
 * (`createTabsStub`), and `page.emitRequest` is the page's handle on it afterwards: the
 * player of a jump asks again, and that request reaches the observer the same way a real
 * one does (spec 34).
 */
function createTranscriptTabs(page, { clock = createPageClock() } = {}) {
  page.tabId = TRANSCRIPT_TAB_ID;
  const tabs = createTabsStub({
    wire: page.wire,
    tabs: [createAgentTabFixture({ id: TRANSCRIPT_TAB_ID, status: "complete", url: page.url })],
    pageAgent: { frames: [{ href: page.url, page, clock }] },
  });
  page.emitRequest = (event) => tabs.emitRequest(event);
  return { tabs, clock };
}

/**
 * Sends one `transcript` request and waits for its answer.
 *
 * The shared two-round settle is not enough here: the transcript path steps a virtual
 * clock tick by tick inside the page realm, and every tick is a real task. The loop
 * therefore waits for the response itself and fails loudly when it never comes.
 */
/** Keeps pumping the event loop until the transcript call of `id` has answered. */
async function awaitTranscriptAnswer(socket, id) {
  for (let round = 0; round < 1000; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (responsesById(socket).has(id)) break;
  }
  await settleAsyncWork();
  assert.equal(responsesById(socket).has(id), true, "the transcript call never answered");
}

async function sendTranscript(socket, id, params = {}) {
  socket.receive({ type: "request", id, method: "transcript", params });
  await awaitTranscriptAnswer(socket, id);
}

/**
 * Sends one `transcript` request whose path waits for a wire event that never comes, and
 * lets every deadline of that wait expire.
 *
 * `sendTranscript` is not enough here and deliberately stays as it is: the wait lives in the
 * background page and is armed with a `setTimeout` of the sandbox clock, which the harness
 * only fires when a case says so. Draining that clock inside the shared helper would race
 * the deadline against the injection — it could fire while the jump is still running, and a
 * success case would end as `no_address`. So the cases that expect no event drive the timer
 * themselves, one deadline at a time, until the call answers (spec 34).
 */
async function sendTranscriptAfterTheDeadline(socket, id, clock, params = {}) {
  socket.receive({ type: "request", id, method: "transcript", params });
  for (let round = 0; round < 1000; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (responsesById(socket).has(id)) break;
    while (clock.pendingDelays().includes(TRANSCRIPT_CAPTION_DEADLINE_MS)) {
      clock.runByDelay(TRANSCRIPT_CAPTION_DEADLINE_MS);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  await settleAsyncWork();
  assert.equal(responsesById(socket).has(id), true, "the transcript call never answered");
}

/**
 * Sends one `transcript` request and returns at the instant the call waits for the wire.
 *
 * The cases that let an event arrive *during* a wait need exactly that instant. Before it,
 * the wait does not exist and the event would be answered by the look-first; after it, an
 * event either answers the wait or is missed, and a case could not tell the two apart from
 * the outside. The deadline timer is the only signal there is: it is armed in the same turn
 * the waiter is registered, so "a 3000 ms timer is pending" means "the call is waiting".
 * A mutation that never arms the timer fails here with a sentence instead of hanging.
 */
async function sendTranscriptAndWaitForTheWire(socket, id, clock, params = {}) {
  socket.receive({ type: "request", id, method: "transcript", params });
  for (let round = 0; round < 1000; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (clock.pendingDelays().includes(TRANSCRIPT_CAPTION_DEADLINE_MS)) return;
    assert.equal(
      responsesById(socket).has(id),
      false,
      "the call answered without ever waiting for the wire",
    );
  }
  assert.fail("the call never armed its wait for the wire");
}

/**
 * The coordinator, alone in a context where `webRequest` is not even a key.
 *
 * The counting getter is the case, not a decoration: `background.js` only keeps the bridge
 * tab alive, so one read of that permission means the capture moved back into the page
 * that must not have it (spec 42, criterion 12). The referee is deliberately loud — it
 * throws — because a coordinator that reaches for it would otherwise swallow the mistake
 * in `reconcileAndReport`.
 *
 * The stub is as small as `background.js` allows: one normal window, one tab to create.
 * It answers the shape of every call the coordinator makes and nothing more, so a new
 * browser API in the coordinator fails here instead of working only in Firefox.
 *
 * `manifestVersion` is the one thing a case varies, and both toolbar namespaces are in
 * the stub so that the choice is observable: the coordinator has to call the one the
 * manifest version names, and a wrong pick would otherwise only show up as a toolbar
 * button that never answers a click (spec 43, criterion 3). The recorded calls live in
 * `toolbar`.
 */
async function startCoordinatorWithoutWebRequest({ manifestVersion = 3 } = {}) {
  const created = [];
  const reads = { webRequest: 0 };
  // One record per namespace, same shape for both: what was set and how often somebody
  // registered for the click. Counted instead of ignored, because "the right one was
  // used" and "both were used" must not look alike.
  const toolbar = { action: newToolbarRecord(), browserAction: newToolbarRecord() };
  const browser = {
    runtime: {
      getURL: (path) => `moz-extension://coordinator/${path}`,
      // The coordinator reads the manifest version to pick `browserAction` or `action`
      // (spec 44), and it listens to the page's report about the socket.
      getManifest: () => ({ version: MANIFEST_VERSION, manifest_version: manifestVersion }),
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      sendMessage: async () => undefined,
    },
    // The switch is on, so the coordinator does its own job here; what this case is about
    // is the *permission* it must not touch.
    storage: {
      local: {
        get: async () => ({ bridgeEnabled: true }),
        set: async () => {},
      },
    },
    action: toolbarNamespaceFor(toolbar.action),
    browserAction: toolbarNamespaceFor(toolbar.browserAction),
    windows: {
      get: async () => {
        throw new Error("no such window");
      },
      getAll: async () => [{ id: 101, type: "normal", incognito: false, focused: true }],
      create: async () => ({ id: 500, tabs: [] }),
    },
    tabs: {
      query: async () => [],
      create: async ({ url, pinned, windowId }) => {
        const tab = { id: 901, url, pinned, windowId, cookieStoreId: DEFAULT_COOKIE_STORE_ID };
        created.push(tab);
        return { ...tab };
      },
      get: async () => {
        throw new Error("no such tab");
      },
      remove: async () => {},
      reload: async () => {},
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
  };
  Object.defineProperty(browser, "webRequest", {
    get() {
      reads.webRequest += 1;
      throw new Error("background.js reached for webRequest");
    },
  });
  const sandbox = vm.createContext({ browser, console: captureConsole([]) });
  vm.runInNewContext(COORDINATOR_SOURCE, sandbox, { filename: "extension/background.js" });
  await settleAsyncWork();
  return { reads, created, toolbar };
}

/** An empty record for one toolbar namespace: icon paths, titles, click registrations. */
function newToolbarRecord() {
  return { icons: [], titles: [], clickListeners: 0 };
}

/**
 * One toolbar namespace as the coordinator sees it, recording into `record`.
 *
 * Defined as a function on purpose, once per namespace: a shared closure would record
 * both namespaces into the same list and make the wrong pick look right.
 */
function toolbarNamespaceFor(record) {
  return {
    setIcon: async ({ path }) => {
      record.icons.push(path);
    },
    setTitle: async ({ title }) => {
      record.titles.push(title);
    },
    onClicked: {
      addListener: () => {
        record.clickListeners += 1;
      },
    },
  };
}

/**
 * A watch page whose settings popup lists the tracks but whose player has not fetched the
 * target's file: the shape that needs the menu and the jump (spec 33, M16/M17).
 *
 * `wire` is empty unless a case passes some, so the first look for the target's address finds
 * nothing and the slow path is the one under test. The jump makes the player fetch the file
 * of the track it is *on* and emits that request on the wire — which is why a pick by
 * position fails here instead of passing by luck: it lands on another track, the target's
 * request never appears, and the call runs into its deadline (spec 34).
 *
 * Two page properties are open to a case, because they are exactly the two ways a request
 * can be the wrong one: `page.tabId` says *whose* request the player emits (a foreign tab),
 * and `page.wireAddressOf` says *which* address (a foreign host).
 *
 * `entryTexts` defaults to the off entry, one entry per track in model order, and the
 * auto-translate entry — `captionTracks.length + 2` entries, the count the tool checks
 * against (M16). A case that needs another order, a `>>` entry or a second row passes it in;
 * `clicksTakeEffect` models a list that does not answer its own clicks, `checkedOnlyWhenOpen`
 * one that hands out the mark only on the nodes of the popup that is open right now, and
 * `throwOnRestoreClick` a page whose restore click throws.
 */
function createTranscriptMenuPage({
  captionTracks = [],
  audioTracks = [],
  texts = {},
  entryTexts = null,
  contentName = null,
  checkedText = null,
  extraRows = [],
  wire = [],
  staleExpiries = [],
  currentTime = 19.1,
  clicksTakeEffect = true,
  menuOpen = false,
  checkedOnlyWhenOpen = false,
  throwOnRestoreClick = false,
} = {}) {
  const cues = {};
  for (const track of captionTracks) {
    const key = cuesKeyOf(track);
    const text = texts[key] ?? texts[track.languageCode];
    if (text === undefined) continue;
    cues[key] = [createJson3Event(4000, [text])];
  }
  const trackNames = captionTracks.map(captionTextOf);
  // The row shows the running track. With captions off it keeps the last track's name — the
  // fixture's assumption about that state (M16 measured the row with a track selected);
  // without it the anchor would be unfindable exactly when the tool has to turn captions on.
  const shownName = contentName ?? (trackNames.includes(checkedText) ? checkedText : trackNames[0]);
  // One log for the whole page: a click and a playhead write only show their order there.
  const log = createEventLog();
  const page = createTranscriptPage({
    pageWindow: windowWithResponseAt(
      "ytplayer.bootstrapPlayerResponse",
      createPlayerResponse({ captionTracks, audioTracks }),
    ),
    wire,
    cues,
    staleExpiries,
    playerMenu: createPlayerMenu({
      entryTexts: entryTexts ?? [MENU_OFF_TEXT, ...trackNames, MENU_TRANSLATE_TEXT],
      contentName: shownName,
      checkedText,
      extraRows,
      log,
      clicksTakeEffect,
      menuOpen,
      checkedOnlyWhenOpen,
      throwOnRestoreClick,
    }),
  });
  let fetchedOnJump = 0;
  // The address the player asks for on a jump. A case replaces it to model a request that
  // is not a track file at all.
  page.wireAddressOf = (track, expire) => transcriptResourceOf(track, expire);
  page.video = createPageVideo({
    currentTime,
    log,
    onWrite: () => {
      const name = page.playerMenu.checkedText();
      const track = captionTracks.find((entry) => captionTextOf(entry) === name);
      if (track === undefined) return;
      fetchedOnJump += 1;
      // A fresh signature: the player asks again, and the younger request is the one the
      // observer keeps (the wire holds the last request of a language, spec 34).
      page.emitRequest({
        tabId: page.tabId,
        url: page.wireAddressOf(track, 100 + fetchedOnJump),
      });
    },
  });
  page.events = log.events;
  return page;
}

/** The three cues most of the window cases page through, with their lengths. */
function createThreeTranscriptCues() {
  return [
    createJson3Event(4000, ["erste zeile"]),
    createJson3Event(6000, ["zweite zeile"]),
    createJson3Event(3723000, ["dritte zeile"]),
  ];
}

/**
 * A watch page with an English original whose track file the player already fetched.
 *
 * `cues` replaces the file, `audioTracks` the audio tracks when a case needs a second
 * original. The page is the shortest way to a call that reaches the window.
 */
function createTranscriptCuePage({ cues = createThreeTranscriptCues(), audioTracks = null } = {}) {
  const page = createTranscriptModelPage({
    captionTracks: [createCaptionTrack({ languageCode: "en" })],
    audioTracks: audioTracks ?? [createOriginalAudioTrack(0)],
  });
  page.cues = { en: cues };
  return page;
}

test("transcript_segments_withThreeSegments", async () => {
  // GIVEN a watch page whose English original carries three cues — 4 s, 6 s and 3723 s,
  // the last one to prove the hour form,
  const page = createTranscriptCuePage();
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the bridge asks for the transcript,
  await sendTranscript(socket, 2);

  // THEN the answer is exactly the eight fields of the contract, the three language fields
  // first — behind twenty thousand characters of text nobody would read them (spec 33):
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(Object.keys(answer.result), [
    "requestedLanguage",
    "deliveredLanguage",
    "source",
    "segments",
    "totalChars",
    "chars",
    "offset",
    "truncated",
  ]);

  // ... the request named the measured container, and both language fields say `en`: the
  // requested one comes from the model, the delivered one from the address (M13),
  assert.equal(answer.result.requestedLanguage, "en");
  assert.equal(answer.result.deliveredLanguage, "en");
  assert.equal(answer.result.source, "ytplayer.bootstrapPlayerResponse");

  // ... and every cue carries its start as seconds *and* as the displayed string,
  assert.deepStrictEqual(inThisRealm(answer.result.segments), [
    { time: 4, timeText: "0:04", text: "erste zeile" },
    { time: 6, timeText: "0:06", text: "zweite zeile" },
    { time: 3723, timeText: "1:02:03", text: "dritte zeile" },
  ]);
});

test("transcript_segments_joinsWithSingleSpace", async () => {
  // GIVEN three cues of four characters each,
  const page = createTranscriptCuePage({
    cues: [
      createJson3Event(0, ["eins"]),
      createJson3Event(1000, ["zwei"]),
      createJson3Event(2000, ["drei"]),
    ],
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the whole transcript is read,
  await sendTranscript(socket, 2);

  // THEN the connector is one space: 4 + 1 + 4 + 1 + 4 = 14, for both numbers that count
  // a length, and no separator was invented twice,
  const result = responsesById(socket).get(2).result;
  assert.equal(result.totalChars, 14);
  assert.equal(result.chars, 14);
  assert.equal(inThisRealm(result.segments).map((segment) => segment.text).join(" ").length, 14);
  assert.equal(result.truncated, false);
});

test("transcript_segments_surroundingWhitespace_shouldBeTrimmed", async () => {
  // GIVEN a cue whose text carries the blank runs the track file writes around its pieces
  // (MIN-6),
  const page = createTranscriptCuePage({ cues: [createJson3Event(4000, ["\n  Das ist eine Drei.  \n"])] });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the transcript is read,
  await sendTranscript(socket, 2);

  // THEN the text is trimmed: a leading newline would otherwise land in the answer *and*
  // be counted in `chars`/`totalChars`,
  const result = responsesById(socket).get(2).result;
  const segment = inThisRealm(result.segments)[0];
  assert.equal(segment.timeText, "0:04");
  assert.equal(segment.time, 4);
  assert.equal(segment.text, "Das ist eine Drei.");
  assert.equal(result.totalChars, 18);
});

test("transcript_segments_windowStartsMidSegment_shouldKeepTheSegmentWhole", async () => {
  // GIVEN the three eleven/twelve-character cues (37 characters with both connectors),
  const page = createTranscriptCuePage();
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the window starts five characters into the first cue and is only ten wide,
  await sendTranscript(socket, 2, { offset: 5, maxChars: 10 });

  // THEN both cues the window touches travel *whole* — half a cue would make its stamp a
  // lie — so `chars` (11 + 1 + 12) exceeds `maxChars` on purpose,
  const result = responsesById(socket).get(2).result;
  assert.deepStrictEqual(inThisRealm(result.segments).map((segment) => segment.text), [
    "erste zeile",
    "zweite zeile",
  ]);
  assert.equal(result.chars, 24);
  assert.ok(result.chars > 10, "a whole cue may push the window past maxChars");
  assert.equal(result.totalChars, 37);
  assert.equal(result.offset, 5);

  // ... and there is more text after the last delivered cue.
  assert.equal(result.truncated, true);
});

test("transcript_segments_atTheExactEnd_shouldAnswerEmpty", async () => {
  // GIVEN the same 37-character transcript,
  const page = createTranscriptCuePage();
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the offset sits exactly on the end,
  await sendTranscript(socket, 2, { offset: 37 });

  // THEN this is the halt of a paging loop and not a mistake: an empty window with the
  // full length, nothing left to read, and the language fields still answered,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(inThisRealm(answer.result), {
    requestedLanguage: "en",
    deliveredLanguage: "en",
    source: "ytplayer.bootstrapPlayerResponse",
    segments: [],
    totalChars: 37,
    chars: 0,
    offset: 37,
    truncated: false,
  });
});

test("transcript_segments_offsetBeyondText_shouldFailWithTotalChars", async () => {
  // GIVEN the same transcript,
  const page = createTranscriptCuePage();
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the offset is one character behind the end,
  await sendTranscript(socket, 2, { offset: 38 });

  // THEN the refusal names the length, because that is the number the caller corrects its
  // next attempt with,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "offset_out_of_range");
  assert.ok(answer.error.message.includes("37"), `the message must name 37: ${answer.error.message}`);
  assert.ok(answer.error.message.includes("38"), `the message must name 38: ${answer.error.message}`);
});

test("transcript_params_outOfRange_shouldFail", async () => {
  // GIVEN a page that would answer fine,
  const page = createTranscriptCuePage();
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN three windows outside the contract are asked for,
  await sendTranscript(socket, 2, { maxChars: 0 });
  await sendTranscript(socket, 3, { maxChars: 100001 });
  await sendTranscript(socket, 4, { offset: -1 });

  // THEN every one is the caller's own mistake,
  const answers = responsesById(socket);
  assert.equal(answers.get(2).error.code, "invalid_params");
  assert.equal(answers.get(3).error.code, "invalid_params");
  assert.equal(answers.get(4).error.code, "invalid_params");

  // ... and nothing was injected for a request that could not be answered anyway.
  assert.deepStrictEqual(tabs.scriptCalls, []);
});

test("transcript_segments_midSegmentOffset_shouldStillReachTheEnd", async () => {
  // GIVEN the same transcript, and a window that starts inside the first cue (spec 32,
  // R3-1) and ends inside the third,
  const page = createTranscriptCuePage();
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the first page is read,
  await sendTranscript(socket, 2, { offset: 5, maxChars: 13 });

  // THEN `chars` counts the five characters before the window as well — 24, while
  // `offset + chars` would be 29 and point *into* the third cue,
  const first = responsesById(socket).get(2).result;
  assert.deepStrictEqual(inThisRealm(first.segments).map((segment) => segment.text), [
    "erste zeile",
    "zweite zeile",
  ]);
  assert.equal(first.chars, 24);
  assert.equal(first.truncated, true);

  // WHEN the next read starts at the end of the *delivered* cue, not at `offset + chars`,
  await sendTranscript(socket, 3, { offset: 24 });

  // THEN the rest arrives whole: nothing was lost between the two pages.
  const second = responsesById(socket).get(3).result;
  assert.deepStrictEqual(inThisRealm(second.segments).map((segment) => segment.text), [
    "dritte zeile",
  ]);
  assert.equal(second.chars, 12);
  assert.equal(second.truncated, false);
});

test("transcript_trackForOriginalAudio", async () => {
  // GIVEN a video with an English original and a German translation, and two audio tracks:
  // the German one points at the German track, the one without the `.3` suffix at the
  // English original — that is what the page really ships (M2),
  const page = createTranscriptModelPage({
    captionTracks: [
      createCaptionTrack({ languageCode: "en" }),
      createCaptionTrack({ languageCode: "de" }),
    ],
    audioTracks: [
      createTranslationAudioTrack({ languageCode: "de", defaultCaptionTrackIndex: 1 }),
      createOriginalAudioTrack(0),
    ],
    texts: { en: "This is a 3.", de: "Das ist eine Drei." },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the original audio track decided: the English track was read, not the German one
  // the page suggests on a German interface (M14),
  const result = responsesById(socket).get(2).result;
  assert.equal(result.requestedLanguage, "en");
  assert.equal(result.deliveredLanguage, "en");
  assert.deepStrictEqual(inThisRealm(result.segments), [
    { time: 4, timeText: "0:04", text: "This is a 3." },
  ]);

  // ... and the one request went to the uploaded English track, never to a `.3` one.
  assert.equal(page.fetched.length, 1);
  assert.equal(page.fetched[0].includes("lang=en"), true);
  assert.equal(page.fetched[0].includes("lang=de"), false);
});

test("transcript_trackForOriginalAudio_withOriginalAtAnotherIndex", async () => {
  // GIVEN the same two tracks in the other order: the original audio track last, and the
  // caption tracks swapped, which is the shape the second measurement of M3 showed,
  const page = createTranscriptModelPage({
    captionTracks: [
      createCaptionTrack({ languageCode: "de" }),
      createCaptionTrack({ languageCode: "en" }),
    ],
    audioTracks: [
      createTranslationAudioTrack({ languageCode: "de", defaultCaptionTrackIndex: 0 }),
      createOriginalAudioTrack(1),
    ],
    texts: { en: "This is a 3.", de: "Das ist eine Drei." },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the answer is the same as with the original on the first position: the id decides,
  // the position does not,
  const result = responsesById(socket).get(2).result;
  assert.equal(result.requestedLanguage, "en");
  assert.equal(inThisRealm(result.segments)[0].text, "This is a 3.");
});

test("transcript_trackForOriginalAudio_withASingleTrackWithoutId", async () => {
  // GIVEN the shape measured on `bbbbbbbbbbb` (2026-11-12): exactly one audio track, its
  // `audioTrackId` missing entirely, and the video's own track an automatic Japanese one,
  const page = createTranscriptModelPage({
    captionTracks: [createCaptionTrack({ languageCode: "ja", vssId: "a.ja" })],
    audioTracks: [createAudioTrack({ defaultCaptionTrackIndex: 0 })],
    texts: { ja: "これは三です。" },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the one track *is* the original — nothing to tell apart, no id needed — and the
  // Japanese track it points at is read instead of the call failing,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true, `must not fail: ${answer.error?.message}`);
  assert.equal(answer.result.requestedLanguage, "ja");
  assert.equal(answer.result.deliveredLanguage, "ja");
  assert.deepStrictEqual(inThisRealm(answer.result.segments), [
    { time: 4, timeText: "0:04", text: "これは三です。" },
  ]);
});

test("transcript_languageForTrack_withASingleCaptionTrackAndNoIndex", async () => {
  // GIVEN the second shape measured on `bbbbbbbbbbb` (2026-11-12): exactly one audio track
  // that names no caption index at all, and one automatic Japanese track,
  const page = createTranscriptModelPage({
    captionTracks: [createCaptionTrack({ languageCode: "ja", vssId: "a.ja" })],
    audioTracks: [createAudioTrack({})],
    texts: { ja: "これは三です。" },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the one track is the original even though nothing points at it — with a single
  // track there is nothing to choose, so the missing index decides nothing,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true, `must not fail: ${answer.error?.message}`);
  assert.equal(answer.result.requestedLanguage, "ja");
  assert.equal(answer.result.deliveredLanguage, "ja");
  assert.deepStrictEqual(inThisRealm(answer.result.segments), [
    { time: 4, timeText: "0:04", text: "これは三です。" },
  ]);
});

test("transcript_languageForTrack_withTwoTracksOfTheSameLanguageAndNoIndex", async () => {
  // GIVEN the shape measured on `ccccccccccc` (2026-11-12): no caption index on the audio
  // track, and two Japanese tracks — an uploaded one and an automatic one,
  const page = createTranscriptModelPage({
    captionTracks: [
      createCaptionTrack({ languageCode: "ja", name: "Japanisch" }),
      createCaptionTrack({ languageCode: "ja", vssId: "a.ja", name: "Japanisch (automatisch)" }),
    ],
    audioTracks: [createOriginalAudioTrack()],
    texts: { ja: "これは手動です。", "ja/asr": "これは自動です。" },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the uploaded track is read, not the automatic one: both carry the same language,
  // so the operator's ranking decides even though nothing points at either of them,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true, `must not fail: ${answer.error?.message}`);
  assert.equal(answer.result.requestedLanguage, "ja");
  assert.equal(answer.result.deliveredLanguage, "ja");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "これは手動です。");

  // ... and the address read carries no `kind=asr`, which is the file of the automatic one.
  assert.equal(page.fetched.length, 1);
  assert.equal(page.fetched[0].includes("kind=asr"), false, page.fetched[0]);
});

test("transcript_languageForTrack_withTwoManualTracksAndNoIndex_shouldFail", async () => {
  // GIVEN no caption index on the audio track and two *uploaded* Japanese tracks — one
  // language, but no ranking left and nobody who names one of them,
  const page = createTranscriptModelPage({
    captionTracks: [
      createCaptionTrack({ languageCode: "ja", name: "Japanisch" }),
      createCaptionTrack({ languageCode: "ja", vssId: "ja-GB", name: "Japanisch (GB)" }),
    ],
    audioTracks: [createOriginalAudioTrack()],
    texts: { ja: "これは手動です。" },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN it refuses and names both candidates instead of picking the first, which would
  // look like a result,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes("Japanisch (ja)"), `must name both: ${answer.error.message}`);
  assert.ok(answer.error.message.includes("Japanisch (GB)"), `must name both: ${answer.error.message}`);

  // ... and the refusal came before the reading snippet, so nothing was fetched.
  assert.equal(tabs.scriptCalls.length, 2);
  assert.deepStrictEqual(page.fetched, []);
});

test("transcript_trackForOriginalAudio_withTwoCandidates_shouldFail", async () => {
  // GIVEN two audio tracks without the `.3` suffix — the page handed out two originals,
  const page = createTranscriptModelPage({
    captionTracks: [createCaptionTrack({ languageCode: "en" })],
    audioTracks: [
      createOriginalAudioTrack(0),
      createAudioTrack({ audioTrackId: "en-GB.4", defaultCaptionTrackIndex: 0 }),
    ],
    texts: { en: "This is a 3." },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN it refuses with a named error that carries both ids instead of picking one
  // silently,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes("en-US.4"), `must name en-US.4: ${answer.error.message}`);
  assert.ok(answer.error.message.includes("en-GB.4"), `must name en-GB.4: ${answer.error.message}`);

  // ... and the abort came before the reading snippet: two injections, nothing fetched.
  assert.equal(tabs.scriptCalls.length, 2);
  assert.deepStrictEqual(page.fetched, []);
});

test("transcript_languageForTrack_withEnglishOriginal", async () => {
  // GIVEN a video whose original is English (index 1 of four tracks) and whose caption
  // list carries a *second* uploaded English track. Without that second track the case
  // guards nothing: with one English track, "the original is `en`" and the fallback
  // "exactly one English track" give the same answer, so the `en` branch of the rule could
  // be deleted and this case stayed green. Here the fallback sees two uploaded English
  // tracks and has to refuse — only the `en` branch answers,
  const page = createTranscriptModelPage({
    captionTracks: [
      createCaptionTrack({ languageCode: "ja" }),
      createCaptionTrack({ languageCode: "en" }),
      createCaptionTrack({ languageCode: "de" }),
      createCaptionTrack({ languageCode: "en", vssId: "en-GB", name: "Englisch (GB)" }),
    ],
    audioTracks: [
      createTranslationAudioTrack({ languageCode: "ja", defaultCaptionTrackIndex: 0 }),
      createOriginalAudioTrack(1),
      createTranslationAudioTrack({ languageCode: "de", defaultCaptionTrackIndex: 2 }),
    ],
    texts: { en: "This is a 3.", ja: "これは三です。", de: "Das ist eine Drei." },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the original is English and therefore the track that counts — the other English
  // track is not a choice, it is a second candidate the fallback would have refused,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true, JSON.stringify(answer.error));
  assert.equal(answer.result.requestedLanguage, "en");
  assert.equal(answer.result.deliveredLanguage, "en");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a 3.");
});

test("transcript_languageForTrack_withGermanOriginal", async () => {
  // GIVEN a video whose original is German,
  const page = createTranscriptModelPage({
    captionTracks: [
      createCaptionTrack({ languageCode: "de" }),
      createCaptionTrack({ languageCode: "en" }),
    ],
    audioTracks: [
      createOriginalAudioTrack(0),
      createTranslationAudioTrack({ languageCode: "en", defaultCaptionTrackIndex: 1 }),
    ],
    texts: { de: "Das ist eine Drei.", en: "This is a 3." },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN German counts like English does: the original stays,
  const result = responsesById(socket).get(2).result;
  assert.equal(result.requestedLanguage, "de");
  assert.equal(inThisRealm(result.segments)[0].text, "Das ist eine Drei.");
});

test("transcript_languageForTrack_withJapaneseOriginalAndEnglishTrack", async () => {
  // GIVEN a Japanese video with one uploaded English track — the operator's rule says the
  // English translation is read then (2026-11-11),
  const page = createTranscriptModelPage({
    captionTracks: [
      createCaptionTrack({ languageCode: "ja", vssId: "a.ja" }),
      createCaptionTrack({ languageCode: "en", name: "Englisch" }),
    ],
    audioTracks: [
      createOriginalAudioTrack(0),
      createTranslationAudioTrack({ languageCode: "en", defaultCaptionTrackIndex: 1 }),
    ],
    texts: { ja: "これは三です。", en: "This is a 3." },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the English track is requested *and* delivered, so the caller sees which language
  // it got instead of guessing from the text,
  const result = responsesById(socket).get(2).result;
  assert.equal(result.requestedLanguage, "en");
  assert.equal(result.deliveredLanguage, "en");
  assert.equal(inThisRealm(result.segments)[0].text, "This is a 3.");
});

test("transcript_languageForTrack_withTwoEnglishTracks", async () => {
  // GIVEN a Japanese video with an uploaded and an automatic English track — the uploaded
  // one wins, because two automatic transcripts would be two guesses,
  const page = createTranscriptModelPage({
    captionTracks: [
      createCaptionTrack({ languageCode: "ja", vssId: "a.ja" }),
      createCaptionTrack({ languageCode: "en", name: "Englisch" }),
      createCaptionTrack({ languageCode: "en", vssId: "a.en", name: "Englisch (automatisch)" }),
    ],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { "en": "This is a 3.", "en/asr": "This is a three.", ja: "これは三です。" },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the uploaded English track was read — its text, not the automatic one's,
  const uploaded = responsesById(socket).get(2).result;
  assert.equal(uploaded.requestedLanguage, "en");
  assert.equal(inThisRealm(uploaded.segments)[0].text, "This is a 3.");

  // GIVEN two *uploaded* English tracks, which is no choice at all,
  const ambiguousPage = createTranscriptModelPage({
    captionTracks: [
      createCaptionTrack({ languageCode: "ja", vssId: "a.ja" }),
      createCaptionTrack({ languageCode: "en", name: "Englisch" }),
      createCaptionTrack({ languageCode: "en", vssId: "en-GB", name: "Englisch (GB)" }),
    ],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
  });
  const ambiguous = createTranscriptTabs(ambiguousPage);
  const ambiguousStarted = await connectedBackground({
    tabs: ambiguous.tabs,
    settings: STORED_TAB_SETTINGS,
  });

  // WHEN the tool is called there,
  await sendTranscript(ambiguousStarted.socket, 2);

  // THEN it refuses and names both candidates, and nothing was fetched.
  const answer = responsesById(ambiguousStarted.socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes("Englisch"), `must name the candidates: ${answer.error.message}`);
  assert.ok(answer.error.message.includes("Englisch (GB)"), `must name both: ${answer.error.message}`);
  assert.deepStrictEqual(ambiguousPage.fetched, []);
});

test("transcript_languageForTrack_withoutEnglishTrack", async () => {
  // GIVEN a Japanese video with no English track at all,
  const page = createTranscriptModelPage({
    captionTracks: [
      createCaptionTrack({ languageCode: "ja", vssId: "a.ja" }),
      createCaptionTrack({ languageCode: "fr" }),
    ],
    audioTracks: [
      createOriginalAudioTrack(0),
      createTranslationAudioTrack({ languageCode: "fr", defaultCaptionTrackIndex: 1 }),
    ],
    texts: { ja: "これは三です。", fr: "C'est un trois." },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the original is read and its language is named — no error, and no invented
  // English text,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.requestedLanguage, "ja");
  assert.equal(answer.result.deliveredLanguage, "ja");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "これは三です。");
});

test("transcript_captionUrl_picksTheMatchingLanguage", async () => {
  // GIVEN the observed requests of a watch page: the page itself, an address without `lang`,
  // a German track and two English ones — the second English one is the younger request,
  const page = createTranscriptModelPage({
    captionTracks: [createCaptionTrack({ languageCode: "en" })],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3.", de: "Das ist eine Drei." },
  });
  page.wire = [
    { tabId: TRANSCRIPT_TAB_ID, url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" },
    {
      tabId: TRANSCRIPT_TAB_ID,
      url: "https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&tlang=de",
    },
    {
      tabId: TRANSCRIPT_TAB_ID,
      url: "https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&lang=de&signature=platzhalter",
    },
    {
      tabId: TRANSCRIPT_TAB_ID,
      url: "https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&lang=en&expire=7&signature=platzhalter",
    },
    {
      tabId: TRANSCRIPT_TAB_ID,
      url: "https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&lang=en&expire=8&signature=platzhalter",
    },
  ];
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN exactly one address was fetched, and it is the last English one: an address
  // without `lang` names no track at all, and the wire keeps the latest request of a
  // language,
  assert.equal(page.fetched.length, 1);
  assert.equal(page.fetched[0].includes("expire=8"), true, page.fetched[0]);
  assert.equal(page.fetched[0].includes("expire=7"), false, page.fetched[0]);
  assert.equal(responsesById(socket).get(2).ok, true);
});

test("transcript_captionUrl_withoutMatch_shouldFail", async () => {
  // GIVEN a watch page whose player re-fetches the English track on every jump but has no
  // English file behind the address — the request is on the wire, the file answers 404,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const german = createCaptionTrack({ languageCode: "de", name: "Deutsch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english, german],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { de: "Das ist eine Drei." },
    checkedText: "Englisch",
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN it is a named failure naming the language it looked for — and there is no fallback
  // to the panel, whose text would be the wrong language (M14),
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes('"en"'), `must name the language: ${answer.error.message}`);

  // ... the one repetition the contract allows really happened — two reads, both against a
  // file that is not there — and then the call gave up,
  assert.equal(page.fetched.length, 2);

  // ... the message carries no address: it is a session credential and must not travel, not
  // even inside an error (M13),
  assert.equal(answer.error.message.includes("http"), false, answer.error.message);

  // ... and the player was put back: two jumps of one second each, then the position it had.
  assert.deepStrictEqual(page.video.writes, [20.1, 21.1, 19.1]);
});

test("transcript_captionUrl_matchesTheKind", async () => {
  // GIVEN an English original with an uploaded and an automatic English track — both
  // addresses carry `lang=en`, so only the kind tells them apart (M1),
  const page = createTranscriptModelPage({
    captionTracks: [
      createCaptionTrack({ languageCode: "en", name: "Englisch" }),
      createCaptionTrack({ languageCode: "en", vssId: "a.en", name: "Englisch (automatisch)" }),
    ],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3.", "en/asr": "This is a three." },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the uploaded track's file was read, not the automatic one that sits last in the
  // list,
  const result = responsesById(socket).get(2).result;
  assert.equal(inThisRealm(result.segments)[0].text, "This is a 3.");
  assert.equal(page.fetched.length, 1);
  assert.equal(page.fetched[0].includes("kind=asr"), false, page.fetched[0]);

  // ... and the request really asked for JSON3, exactly once.
  assert.equal(page.fetched[0].split("fmt=json3").length - 1, 1, page.fetched[0]);
});

test("transcript_captionUrl_doesNotLeakIntoTheAnswer", async () => {
  // GIVEN a watch page whose signed address the wire recorded,
  const page = createTranscriptModelPage({
    captionTracks: [createCaptionTrack({ languageCode: "en" })],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the answer is complete,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.requestedLanguage, "en");

  // ... and not one byte of the address is in it: no scheme, no endpoint, no signature.
  // The address is a credential for the operator's session, so a single field carrying it
  // would be the leak this whole design avoids.
  const json = JSON.stringify(answer.result);
  assert.equal(json.includes("http"), false, json);
  assert.equal(json.includes("timedtext"), false, json);
  assert.equal(json.includes("signature"), false, json);
});

test("transcript_captionUrl_skipsTranslatedAddresses", async () => {
  // GIVEN an English original whose wire ends with a *translated* request — with
  // auto-translate on the player writes `…&lang=en&tlang=de`, so the youngest English
  // address would hand out German text while its `lang` still says English,
  const page = createTranscriptModelPage({
    captionTracks: [createCaptionTrack({ languageCode: "en" })],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3.", de: "Das ist eine Drei." },
  });
  page.wire = [
    {
      tabId: TRANSCRIPT_TAB_ID,
      url: "https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&lang=en&expire=1&signature=platzhalter",
    },
    {
      tabId: TRANSCRIPT_TAB_ID,
      url: "https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&lang=en&tlang=de&expire=2&signature=platzhalter",
    },
  ];
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the untranslated address was read and the delivered language is the one the file
  // really carries — a divergence between `requestedLanguage` and `deliveredLanguage`
  // would be an error, not a quiet answer (## Ziel),
  const answer = responsesById(socket).get(2);
  assert.equal(page.fetched.length, 1);
  assert.equal(page.fetched[0].includes("tlang"), false, page.fetched[0]);
  assert.equal(page.fetched[0].includes("expire=1"), true, page.fetched[0]);
  assert.equal(answer.result.deliveredLanguage, "en");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a 3.");
});

/*
 * The wire of spec 34: the extension observes the `api/timedtext` requests itself, because the
 * page's resource timeline was measured blind for them (M18). What is pinned here is the
 * storage rule (one entry per language mark, the latest one, capped) and that the reading side
 * takes its address from there and from nowhere else.
 */
test("transcript_captionWire_recordsTheAddress", async () => {
  // GIVEN a watch page whose original is the *automatic* English track, and whose request the
  // wire heard before the call — `lang` and `kind` are the two marks it is filed under,
  const automatic = createCaptionTrack({
    languageCode: "en",
    vssId: "a.en",
    name: "Englisch (automatisch)",
  });
  const page = createTranscriptModelPage({
    captionTracks: [automatic],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { "en/asr": "This is a three." },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the answer names the language the entry carries, and the file behind the automatic
  // address was read: only `kind=asr` tells the two English tracks apart at their addresses
  // (M1), so a lookup that ignored the kind would have taken the upload,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.requestedLanguage, "en");
  assert.equal(answer.result.deliveredLanguage, "en");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a three.");
  assert.equal(page.fetched.length, 1);
  assert.equal(page.fetched[0].includes("kind=asr"), true, page.fetched[0]);
});

test("transcript_captionWire_ignoresOtherHosts", async () => {
  // GIVEN a player that asks for its track file on another host — `youtube.com` is the one
  // host the wire accepts,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    contentName: "Englisch",
    checkedText: "Englisch",
  });
  page.wireAddressOf = (track, expire) =>
    transcriptResourceOf(track, expire).replace("https://www.youtube.com", "https://example.com");
  const { tabs } = createTranscriptTabs(page);
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called and the jump is the only request that arrives,
  await sendTranscriptAfterTheDeadline(socket, 2, clock);

  // THEN the foreign address never became an answer — it was not even fetched — and the call
  // fails under the name this situation has,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes('"en"'), answer.error.message);
  assert.deepStrictEqual(page.fetched, []);
});

test("transcript_captionWire_ignoresOtherTabs", async () => {
  // GIVEN a request that arrives for another tab — one of the operator's own, as far as the
  // wire can tell — while the call addresses the agent tab,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    contentName: "Englisch",
    checkedText: "Englisch",
  });
  const { tabs } = createTranscriptTabs(page);
  page.tabId = 101;
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called and the player's request is filed under tab 101,
  await sendTranscriptAfterTheDeadline(socket, 2, clock);

  // THEN nothing of it reaches an answer for tab 500, and the run really did jump — otherwise
  // there was no request to file in the first place,
  assert.ok(page.video.writes.length > 0, "the run has to jump, or nothing was observed");
  assert.deepStrictEqual(page.fetched, []);
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
});

test("transcript_captionWire_keepsTheLatestPerLanguage", async () => {
  // GIVEN two English requests of one tab, the younger one with the fresher signature,
  const english = createCaptionTrack({ languageCode: "en" });
  const page = createTranscriptModelPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
  });
  page.wire = [
    { tabId: TRANSCRIPT_TAB_ID, url: transcriptResourceOf(english, 1) },
    { tabId: TRANSCRIPT_TAB_ID, url: transcriptResourceOf(english, 2) },
  ];
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the younger one was read: an older signature is the one that answers 404 (M13),
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(page.fetched.length, 1);
  assert.equal(page.fetched[0].includes("expire=2"), true, page.fetched[0]);
  assert.equal(page.fetched[0].includes("expire=1"), false, page.fetched[0]);
});

test("transcript_captionWire_forgetsTheOldestLanguage", async () => {
  // GIVEN an English request and eight more languages behind it — one more language than the
  // wire keeps per tab,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    contentName: "Englisch",
    checkedText: "Englisch",
  });
  const others = ["de", "fr", "es", "it", "pt", "nl", "sv", "pl"];
  page.wire = [
    { tabId: TRANSCRIPT_TAB_ID, url: transcriptResourceOf(english, 1) },
    ...others.map((languageCode, index) => ({
      tabId: TRANSCRIPT_TAB_ID,
      url: transcriptResourceOf(createCaptionTrack({ languageCode }), 10 + index),
    })),
  ];
  const { tabs } = createTranscriptTabs(page);
  // The player of this page does not ask again after a jump: a fresh English request of its own
  // would hide exactly the cap this case is about.
  page.emitRequest = () => {};
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscriptAfterTheDeadline(socket, 2, clock);

  // THEN the English address is gone — nine languages, eight places — and the call says so
  // instead of reading a language nobody asked for,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes('"en"'), answer.error.message);
  assert.deepStrictEqual(page.fetched, []);
});

test("transcript_captionWire_resolvesOnALaterEvent", async () => {
  // GIVEN a watch page whose player asks for its file only *after* the jump came back — the
  // fixture's own jump request is switched off, so the wire is empty when the call reaches
  // the menu and the wait is the only thing that can still answer it,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    contentName: "Englisch",
    checkedText: "Englisch",
  });
  const { tabs } = createTranscriptTabs(page);
  // After `createTranscriptTabs` on purpose: that is where the fixture gets its handle on
  // the wire, and a player that stays silent has to be asked for it afterwards.
  page.emitRequest = () => {};
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called, jumps, and the request arrives while the call is waiting,
  await sendTranscriptAndWaitForTheWire(socket, 2, clock);
  const address = transcriptResourceOf(english, 100);
  tabs.emitRequest({ tabId: TRANSCRIPT_TAB_ID, url: address });
  await awaitTranscriptAnswer(socket, 2);

  // THEN the event the wait was armed for is the answer: its address was fetched and the
  // jump was not repeated — a wait that never resolved would have spent the one repetition
  // the contract allows, and the playhead would read [20.1, 21.1, 19.1],
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.deliveredLanguage, "en");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a 3.");
  assert.equal(page.fetched.length, 1);
  assert.equal(page.fetched[0].includes("expire=100"), true, page.fetched[0]);
  assert.deepStrictEqual(page.video.writes, [20.1, 19.1]);
});

test("transcript_captionWire_ignoresForeignEventsWhileWaiting", async () => {
  // GIVEN a watch page with a German track next to the English one, and a player that asks
  // for its files only after the jump,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const german = createCaptionTrack({ languageCode: "de", name: "Deutsch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english, german],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3.", de: "Das ist eine Drei." },
    contentName: "Englisch",
    checkedText: "Englisch",
  });
  const { tabs } = createTranscriptTabs(page);
  // After `createTranscriptTabs`, like the other case: the fixture only becomes silent once
  // it has its handle on the wire.
  page.emitRequest = () => {};
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called and the German request arrives while the call waits for the
  // English one — the player writes its other tracks first, 50 ms ahead of the target,
  await sendTranscriptAndWaitForTheWire(socket, 2, clock);
  tabs.emitRequest({ tabId: TRANSCRIPT_TAB_ID, url: transcriptResourceOf(german, 200) });
  // The gap between the two requests is a turn of this loop, not 50 ms of the background
  // clock: that clock only runs when a case fires it, and firing it would end the wait.
  await settleAsyncWork();
  const address = transcriptResourceOf(english, 100);
  tabs.emitRequest({ tabId: TRANSCRIPT_TAB_ID, url: address });
  await awaitTranscriptAnswer(socket, 2);

  // THEN the German event settled nothing, and the English one answered the wait: no
  // repetition, and the German file was never fetched,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.deliveredLanguage, "en");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a 3.");
  assert.equal(page.fetched.length, 1);
  assert.equal(page.fetched[0].includes("lang=en"), true, page.fetched[0]);
  assert.equal(page.fetched[0].includes("lang=de"), false, page.fetched[0]);
  assert.deepStrictEqual(page.video.writes, [20.1, 19.1]);
});

test("transcript_captionWire_withoutAnEvent_shouldFail", async () => {
  // GIVEN a watch page whose player never asks for the file — no request before the call and
  // none after the jump,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    contentName: "Englisch",
    checkedText: "Englisch",
  });
  const { tabs } = createTranscriptTabs(page);
  page.emitRequest = () => {};
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called and both deadlines run out,
  await sendTranscriptAfterTheDeadline(socket, 2, clock);

  // THEN it is the named failure of this situation — the language it looked for, no panel text
  // that would look like an answer, and nothing fetched,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes("track file"), answer.error.message);
  assert.ok(answer.error.message.includes('"en"'), answer.error.message);
  assert.deepStrictEqual(page.fetched, []);

  // ... the one repetition the contract allows took its two jumps, and then the call gave up
  // and put the playhead back,
  assert.deepStrictEqual(page.video.writes, [20.1, 21.1, 19.1]);
});

test("transcript_captionWire_readsTheAddress", async () => {
  // GIVEN a watch page whose English request the wire recorded,
  const page = createTranscriptCuePage();
  const address = page.wire[0].url;
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the answer is complete,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.deliveredLanguage, "en");

  // ... and the reading call carried the observed address as its argument: the page is
  // never asked for one, and the timeline it used to read is not even part of its realm,
  const reading = tabs.channel.calls[2].message;
  assert.equal(reading.op, "transcriptCaption");
  assert.equal(reading.args.request.address, address, "the address has to travel as an argument");
  assert.equal(
    JSON.stringify(reading.args).includes("getEntriesByType"),
    false,
    "the op must not look one up",
  );
});

/**
 * The capture and the wait live in one context: the bridge page (spec 42, criterion 12).
 *
 * The two halves are one case on purpose, because either half alone is satisfied by a
 * broken arrangement. A coordinator without a listener proves nothing while the listener
 * sits in a page the coordinator keeps alive, and a listener in the bridge page proves
 * nothing while a second one still runs in the coordinator. What decides it is the pair:
 * the page that holds the tab holds the observation too.
 *
 * The proof is a real one — a request is fired into the listener that this context
 * registered, and the wait this context armed is the thing that resolves. No file is read
 * as text and no name is assumed: a listener that never resolves a waiting call would make
 * this case end in the deadline instead of an answer.
 */
test("transcript_captureAndWaiter_shouldLiveInTheSameContext", async () => {
  // GIVEN the coordinator, loaded on its own in a context whose `browser` has no
  // `webRequest` at all,
  const coordinator = await startCoordinatorWithoutWebRequest();

  // THEN it never reaches for that permission, and it still did its own job — the second
  // assertion is what keeps the first from being green on a file that loaded nothing,
  assert.equal(coordinator.reads.webRequest, 0, "the coordinator must not observe requests");
  assert.equal(coordinator.created.length, 1);
  assert.equal(coordinator.created[0].pinned, true);

  // GIVEN a watch page whose player asks for its track file only after the jump,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    contentName: "Englisch",
    checkedText: "Englisch",
  });
  const { tabs } = createTranscriptTabs(page);
  // After `createTranscriptTabs`: the silence is only possible once the fixture has its
  // handle on the wire. A request of its own would hide the wait this case is about.
  page.emitRequest = () => {};
  const { socket, clock } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // ... and the bridge page is the one and only context that observes: exactly one
  // listener, registered by the code that also arms the wait,
  assert.equal(tabs.wireListenerCount(), 1, "the capture has to have exactly one home");

  // WHEN the call waits for the wire and the player's request arrives on that listener,
  await sendTranscriptAndWaitForTheWire(socket, 2, clock);
  tabs.emitRequest({ tabId: TRANSCRIPT_TAB_ID, url: transcriptResourceOf(english, 100) });
  await awaitTranscriptAnswer(socket, 2);

  // THEN the wait of this context was settled by the listener of this context: the answer
  // carries the arriving address, the deadline never had to end it, and no second look
  // found it anywhere else,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.deliveredLanguage, "en");
  assert.equal(page.fetched.length, 1);
  assert.equal(page.fetched[0].includes("expire=100"), true, page.fetched[0]);
  assert.equal(clock.pendingDelays().includes(TRANSCRIPT_CAPTION_DEADLINE_MS), false);
});

/**
 * The toolbar namespace moves with the manifest version, and nothing else does.
 *
 * Under MV3 the button lives in `browser.action`; `browser.browserAction` is not an alias
 * there, it is simply absent. The coordinator would then set an icon nobody sees and
 * register a click nobody can make — silently, because both calls are in a `try` that
 * only warns. So the stub carries both namespaces, and this case proves that exactly one
 * of them is used, the one the manifest version names (spec 43, criterion 3).
 */
test("action_namespace_shouldFollowTheManifestVersion", async () => {
  // GIVEN a manifest version and a browser that offers both namespaces,
  for (const [manifestVersion, used, unused] of [
    [3, "action", "browserAction"],
    [2, "browserAction", "action"],
  ]) {
    // WHEN the coordinator starts and applies the state of the toolbar,
    const coordinator = await startCoordinatorWithoutWebRequest({ manifestVersion });

    // THEN the namespace of *this* version got the icon, the title and the click
    // listener — the icon is the offline one, because the switch is on and no socket has
    // reported yet,
    assert.deepStrictEqual(
      coordinator.toolbar[used].icons,
      ["icons/bridge-offline.svg"],
      `manifest ${manifestVersion} must set the icon through ${used}`,
    );
    assert.equal(coordinator.toolbar[used].titles.length, 1, `and the title through ${used}`);
    assert.equal(
      coordinator.toolbar[used].clickListeners,
      1,
      `and the click through ${used}`,
    );

    // ... and the other one was never touched: one namespace, not both, not `||`.
    assert.deepStrictEqual(
      coordinator.toolbar[unused],
      newToolbarRecord(),
      `manifest ${manifestVersion} must not touch ${unused}`,
    );
  }
});

/**
 * A tab that is gone is no address, not even for an entry the wire still holds (spec 42,
 * criterion 12).
 *
 * The ghost is the whole point: the wire keeps what it heard per tab id, and nothing prunes
 * it when a tab closes. Answering from that entry would be a success for a page that no
 * longer exists — and in the new arrangement it is the one failure mode the move could
 * introduce, because the entry is recorded by the context that owns the tab.
 */
test("transcript_capture_whenTheTabGoesAway_shouldNotResolveWithAGhostEntry", async () => {
  // GIVEN a watch page whose English request the wire already recorded, and whose tab the
  // operator closes before the call,
  const page = createTranscriptCuePage();
  const ghostAddress = page.wire[0].url;
  // One entry, and it is the one the wire replays when the observer registers: the case is
  // only worth something while the ghost really is on the wire,
  assert.equal(page.wire.length, 1);
  const { tabs } = createTranscriptTabs(page);
  tabs.remove(TRANSCRIPT_TAB_ID);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the entry is not an answer: the named failure of a call without a tab, no
  // injection into a dead tab, nothing fetched, and no address in the answer,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "no_agent_tab");
  assert.equal(tabs.scriptCalls.length, 0);
  assert.deepStrictEqual(page.fetched, []);
  assert.equal(JSON.stringify(answer).includes(ghostAddress), false);
});

test("transcript_cues_parseJson3", async () => {
  // GIVEN a JSON3 file with the shapes YouTube writes: two pieces in one cue, a marker
  // without `segs`, a cue with an empty piece, and one after an hour,
  const page = createTranscriptCuePage({
    cues: [
      { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: "erste" }, { utf8: "zeile" }] },
      { tStartMs: 6000 },
      { tStartMs: 6200, segs: [{ utf8: "" }] },
      { tStartMs: 3723000, dDurationMs: 2000, segs: [{ utf8: "dritte" }] },
    ],
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN `tStartMs` became `time` and `timeText`, the pieces became the text, and the two
  // events without text are no segments at all,
  const result = responsesById(socket).get(2).result;
  assert.deepStrictEqual(inThisRealm(result.segments), [
    { time: 4, timeText: "0:04", text: "erste zeile" },
    { time: 3723, timeText: "1:02:03", text: "dritte" },
  ]);
  assert.equal(result.totalChars, 18);
});

test("transcript_cues_doNotGlueLatinWords", async () => {
  // GIVEN a track without a single space inside its pieces — the `ja` shape of M15 — and a
  // second cue whose runs are a tab and two no-break spaces rather than ASCII spaces,
  const page = createTranscriptCuePage({
    cues: [
      { tStartMs: 0, segs: [{ utf8: "Japanisch" }, { utf8: "lernen" }, { utf8: "für" }] },
      { tStartMs: 5000, segs: [{ utf8: "drei\t" }, { utf8: "\u00a0\u00a0Wörter" }] },
    ],
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the pieces are joined with one space — a parser that concatenated them would glue
  // the latin words of a space-free track — and the runs are folded whatever blank they
  // consist of, so no tab and no no-break space reaches `chars` or `totalChars`,
  const result = responsesById(socket).get(2).result;
  const texts = inThisRealm(result.segments).map((segment) => segment.text);
  assert.deepStrictEqual(texts, ["Japanisch lernen für", "drei Wörter"]);
  assert.equal(result.totalChars, 20 + 1 + 11);
});

test("transcript_model_worksWithArrayLikePageObjects", async () => {
  // GIVEN the model behind `window.wrappedJSObject`, with array-like track lists that carry
  // no `map`/`filter`/iterator — the shape an Xray wrapper hands out (M11),
  const page = createTranscriptModelPage({
    captionTracks: [createCaptionTrack({ languageCode: "en" })],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
  });
  assert.equal(typeof page.pageWindow.ytplayer.bootstrapPlayerResponse.captions
    .playerCaptionsTracklistRenderer.captionTracks.map, "undefined");
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the model was read anyway: index loops and field copies answer where an array
  // method would have thrown,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.source, "ytplayer.bootstrapPlayerResponse");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a 3.");

  // ... and the player was not touched: this stage reads, it does not seek (that is the
  // menu and restore stage).
  assert.equal(page.video.currentTime, 19.1);
});

test("transcript_model_fallsThroughTheCandidates", async () => {
  // GIVEN a page whose measured container holds a string that is not JSON, and whose
  // fourth candidate holds the whole response as a JSON string (M11: the string case was
  // never measured),
  const response = createPlayerResponse({
    captionTracks: [createCaptionTrack({ languageCode: "en" })],
    audioTracks: [createOriginalAudioTrack(0)],
  });
  const pageWindow = windowWithResponseAt(
    "ytplayer.config.args.player_response",
    JSON.stringify(response),
  );
  pageWindow.ytplayer.bootstrapPlayerResponse = "{kein JSON";
  const page = createTranscriptPage({
    pageWindow,
    wire: createTranscriptWire(TRANSCRIPT_TAB_ID, [createCaptionTrack({ languageCode: "en" })]),
    cues: { en: [createJson3Event(4000, ["This is a 3."])] },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the list was walked in order, the string was parsed, and the answer names the
  // container that actually answered,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.source, "ytplayer.config.args.player_response");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a 3.");
});

test("transcript_model_withoutCaptionTrack_shouldFailNoPanel", async () => {
  // GIVEN a player response without any `captionTracks` — a video with no subtitle track,
  const page = createTranscriptPage({
    pageWindow: { ytplayer: { bootstrapPlayerResponse: { captions: {} } } },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN it keeps the code that has always meant "this video has no transcript" — the
  // panel is gone from this tool, the code is not,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "no_transcript_panel");

  // ... and the reading snippet never ran: two injections, nothing fetched.
  assert.equal(tabs.scriptCalls.length, 2);
  assert.deepStrictEqual(page.fetched, []);
});

test("transcript_model_keepsPositionsWithAHoleInTheCaptionList", async () => {
  // GIVEN a caption list with a hole at its first position and an original audio track
  // that points at index 1 — the German track *behind* the hole,
  const german = createCaptionTrack({ languageCode: "de", name: "Deutsch" });
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptPage({
    pageWindow: windowWithResponseAt(
      "ytplayer.bootstrapPlayerResponse",
      createPlayerResponse({
        captionTracks: [null, german, english],
        audioTracks: [createOriginalAudioTrack(1)],
      }),
    ),
    wire: createTranscriptWire(TRANSCRIPT_TAB_ID, [german, english]),
    cues: {
      de: [createJson3Event(4000, ["Das ist eine Drei."])],
      en: [createJson3Event(4000, ["This is a 3."])],
    },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN index 1 is still the German track: the copy keeps the position of every entry and
  // turns the hole into a placeholder. A copy that dropped the hole would slide English
  // onto index 1 and answer `en` over German text — the wrong answer that looks healthy,
  const result = responsesById(socket).get(2).result;
  assert.equal(result.requestedLanguage, "de");
  assert.equal(result.deliveredLanguage, "de");
  assert.equal(inThisRealm(result.segments)[0].text, "Das ist eine Drei.");
  assert.equal(page.fetched.length, 1);
  assert.equal(page.fetched[0].includes("lang=de"), true, page.fetched[0]);
});

test("transcript_model_holeAtTheOriginalIndex_shouldFail", async () => {
  // GIVEN the hole exactly where the original audio track points (index 1),
  const german = createCaptionTrack({ languageCode: "de", name: "Deutsch" });
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptPage({
    pageWindow: windowWithResponseAt(
      "ytplayer.bootstrapPlayerResponse",
      createPlayerResponse({
        captionTracks: [german, null, english],
        audioTracks: [createOriginalAudioTrack(1)],
      }),
    ),
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the placeholder fails where a track is used, with the named error an index past
  // the list already gets — no invented language and nothing read. Sliding English onto
  // that position instead would answer `en` here, which is the silent wrong answer M1 is
  // about,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes("original track"), answer.error.message);
  assert.equal(tabs.scriptCalls.length, 2);
  assert.deepStrictEqual(page.fetched, []);
});

test("transcript_inABackgroundTab_shouldFailWithNeedsFocus", async () => {
  // GIVEN a watch page the browser has not rendered — no `ytd-watch-flexy`, and the
  // document says the tab is hidden (M4),
  const hiddenPage = createTranscriptModelPage({
    rendered: false,
    visibilityState: "hidden",
    captionTracks: [createCaptionTrack({ languageCode: "en" })],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
  });
  const hidden = createTranscriptTabs(hiddenPage);
  const hiddenStarted = await connectedBackground({
    tabs: hidden.tabs,
    settings: STORED_TAB_SETTINGS,
  });

  // WHEN the tool is called,
  await sendTranscript(hiddenStarted.socket, 2);

  // THEN it names the foreground instead of reading a model that is not there,
  const hiddenAnswer = responsesById(hiddenStarted.socket).get(2);
  assert.equal(hiddenAnswer.ok, false);
  assert.equal(hiddenAnswer.error.code, "transcript_needs_focus");
  assert.ok(hiddenAnswer.error.message.includes("browser_focus"));
  assert.ok(hiddenAnswer.error.message.includes("visibilityState"));

  // ... it waited for nothing and read nothing: one injection, no page timer, and no
  // background timer either,
  assert.equal(hidden.tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(hiddenPage.fetched, []);
  assert.equal(hidden.clock.now(), 0);
  assert.deepStrictEqual(hiddenStarted.clock.pendingDelays(), []);

  // GIVEN the other half of the counter-check: a *visible* tab that is still hydrating,
  const hydratingPage = createTranscriptModelPage({ rendered: false, visibilityState: "visible" });
  const hydrating = createTranscriptTabs(hydratingPage);
  const hydratingStarted = await connectedBackground({
    tabs: hydrating.tabs,
    settings: STORED_TAB_SETTINGS,
  });

  // WHEN the tool is called there,
  await sendTranscript(hydratingStarted.socket, 2);

  // THEN the sentence says a second focus would not help — that is what keeps the agent
  // out of a focus loop it cannot win.
  const hydratingAnswer = responsesById(hydratingStarted.socket).get(2);
  assert.equal(hydratingAnswer.error.code, "transcript_needs_focus");
  assert.ok(hydratingAnswer.error.message.includes("Another browser_focus does not help"));
});

test("transcript_onANonYouTubePage_shouldFail", async () => {
  // GIVEN a page outside youtube.com — the advice to focus would be a false instruction
  // there (spec 32, R3-5),
  const page = createTranscriptModelPage({
    url: "https://example.com/seite",
    captionTracks: [createCaptionTrack({ languageCode: "en" })],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN it is `transcript_failed`, with the address shape it does read,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.equal(answer.error.code === "transcript_needs_focus", false);
  assert.ok(answer.error.message.includes("YouTube watch pages"));

  // ... and the model was never read: the gate is the first and only injection.
  assert.equal(tabs.scriptCalls.length, 1);
  assert.deepStrictEqual(page.fetched, []);
});

/*
 * The two host traps of R3-5, each in its own call: `notyoutube.com` only *ends* in
 * youtube.com, so a bare suffix test would have let it through, and `m.youtube.com` is
 * refused on purpose because it carries a different DOM. Both must stay `transcript_failed`
 * — the advice to focus would be a false instruction on either.
 */
test("transcript_onLookalikeHosts_shouldStillFail", async () => {
  const hosts = [
    "https://notyoutube.com/watch?v=aaaaaaaaaaa",
    "https://m.youtube.com/watch?v=aaaaaaaaaaa",
  ];

  for (const [index, url] of hosts.entries()) {
    // GIVEN a watch-shaped page on that host, with a model that would answer elsewhere,
    const page = createTranscriptModelPage({
      url,
      captionTracks: [createCaptionTrack({ languageCode: "en" })],
      audioTracks: [createOriginalAudioTrack(0)],
      texts: { en: "This is a 3." },
    });
    const { tabs } = createTranscriptTabs(page);
    const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

    // WHEN the tool is called,
    await sendTranscript(socket, 2 + index);

    // THEN it is refused as a non-YouTube page, and nothing was read or fetched,
    const answer = responsesById(socket).get(2 + index);
    assert.equal(answer.ok, false, `host ${url} must be refused`);
    assert.equal(answer.error.code, "transcript_failed", `host ${url}`);
    assert.equal(tabs.scriptCalls.length, 1, `host ${url}`);
    assert.deepStrictEqual(page.fetched, [], `host ${url}`);
  }
});

/*
 * The track menu, the jump and the restore (spec 33, stage 3).
 *
 * The rule under test is one rule in one place: pick the target track in the menu when the
 * player is not on it, jump when the target's request is not on the wire, and put
 * track and playhead back afterwards. Every case here starts from a page whose player lists
 * the tracks but has not fetched the target's file, except the two that exist to prove the
 * tool does *nothing* in that case.
 */
test("transcript_menuEntry_exactNameMatch", async () => {
  // GIVEN a page whose menu lists German before English while the model lists English
  // before German — the order is swapped on purpose, because an index pick would then land
  // on "Deutsch" and look healthy,
  const german = createCaptionTrack({ languageCode: "de", name: "Deutsch" });
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [german, english],
    audioTracks: [createOriginalAudioTrack(1)],
    texts: { en: "This is a 3.", de: "Das ist eine Drei." },
    entryTexts: [MENU_OFF_TEXT, "Deutsch", "Englisch", MENU_TRANSLATE_TEXT],
    contentName: "Deutsch",
    checkedText: "Deutsch",
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the English entry was picked by its exact text, not by its position: the target is
  // index 1 in the model and index 2 in the menu,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.requestedLanguage, "en");
  assert.equal(answer.result.deliveredLanguage, "en");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a 3.");
  assert.equal([german, english].findIndex((track) => track === english), 1, "the model order");
  assert.equal(page.playerMenu.entryTexts.indexOf("Englisch"), 2, "the menu order");
  assert.deepStrictEqual(page.playerMenu.entryClicks, ["Englisch", "Deutsch"]);

  // ... the player fetched exactly one file — the English one — and the position went back.
  assert.equal(page.fetched.length, 1);
  assert.equal(page.fetched[0].includes("lang=en"), true, page.fetched[0]);
  assert.deepStrictEqual(page.video.writes, [20.1, 19.1]);
});

test("transcript_menuEntry_ignoresTranslateEntries", async () => {
  // GIVEN a track list in which one entry is a translation pair — the shape auto-translate
  // creates (M5): "Japanisch (automatisch erzeugt) >> Englisch" carries the target's name as
  // a substring, so a substring comparison would find two matches,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const japanese = createCaptionTrack({
    languageCode: "ja",
    vssId: "a.ja",
    name: "Japanisch (automatisch erzeugt)",
  });
  const pairText = "Japanisch (automatisch erzeugt) >> Englisch";
  const page = createTranscriptMenuPage({
    captionTracks: [english, japanese],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3.", "ja/asr": "Japanisch" },
    // ... and the list carries both tracks, the two fixed entries and the pair: `captionTracks
    // + 3`, because a pair entry counts as one more (measured 2026-11-12 on `bbbbbbbbbbb`),
    entryTexts: [
      MENU_OFF_TEXT,
      "Englisch",
      "Japanisch (automatisch erzeugt)",
      MENU_TRANSLATE_TEXT,
      pairText,
    ],
    contentName: "Englisch",
    checkedText: MENU_OFF_TEXT,
  });
  // ... and the pair entry really carries the target's name, which is the whole point: the
  // case is only sharp while the substring is there to be found,
  assert.equal(pairText.includes(captionTextOf(english)), true, "the pair carries the target's name");
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN it succeeded, and it picked the *one* entry whose text is the name — a comparison
  // that accepted a substring would have found two entries and refused as ambiguous,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.requestedLanguage, "en");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a 3.");
  assert.equal(answer.result.deliveredLanguage, "en");

  // ... the clicked entries are the plain one and the one that was marked before — no entry
  // of a translation pair ever is: it names a language pair, not a track (M9),
  assert.deepStrictEqual(page.playerMenu.entryClicks, ["Englisch", MENU_OFF_TEXT]);
  assert.equal(page.playerMenu.entryClicks.includes(pairText), false);
});

test("transcript_menuEntry_withoutMatch_shouldFail", async () => {
  // GIVEN a track list with no entry for the target track — the German track is there, the
  // English one the model names is not,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    entryTexts: [MENU_OFF_TEXT, "Deutsch", MENU_TRANSLATE_TEXT],
    checkedText: MENU_OFF_TEXT,
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN it is a named failure that names the track it looked for and the entries it saw,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes('"Englisch"'), answer.error.message);
  assert.ok(answer.error.message.includes("Deutsch"), answer.error.message);

  // ... no entry was clicked, nothing was fetched, the playhead was not touched, and the menu
  // the tool opened is closed again,
  assert.deepStrictEqual(page.playerMenu.entryClicks, []);
  assert.deepStrictEqual(page.video.writes, []);
  assert.deepStrictEqual(page.fetched, []);
  assert.equal(page.playerMenu.isOpen(), false);
});

test("transcript_menuEntry_withTwoMatches_shouldFail", async () => {
  // GIVEN a track list that carries the target's name twice,
  const tracks = [
    createCaptionTrack({ languageCode: "en", name: "Englisch" }),
    createCaptionTrack({ languageCode: "de", name: "Deutsch" }),
    createCaptionTrack({ languageCode: "fr", name: "Französisch" }),
  ];
  const page = createTranscriptMenuPage({
    captionTracks: tracks,
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    entryTexts: [MENU_OFF_TEXT, "Englisch", "Deutsch", "Englisch", MENU_TRANSLATE_TEXT],
    checkedText: MENU_OFF_TEXT,
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN it refuses instead of clicking the first of the two: two entries with one name are
  // two different tracks, and picking one would be a guess,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes("not unambiguous"), answer.error.message);
  assert.deepStrictEqual(page.playerMenu.entryClicks, []);
  assert.deepStrictEqual(page.video.writes, []);
});

test("transcript_menuSetDidNotTakeEffect_shouldFail", async () => {
  // GIVEN a track list whose clicks the player does not answer — the mark stays on the entry
  // it was on, which is what a re-rendered or a disabled row looks like,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    checkedText: MENU_OFF_TEXT,
    clicksTakeEffect: false,
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN it fails at the pick and names the track, instead of waiting out its two deadlines
  // for a file the player will never fetch and blaming the page for it (review m6),
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes('"Englisch"'), answer.error.message);
  assert.ok(answer.error.message.includes("not set"), answer.error.message);

  // ... nothing was fetched and the playhead was never touched, but the pick that did happen
  // was put back: the entry that was marked before is marked again (review m5).
  assert.deepStrictEqual(page.fetched, []);
  assert.deepStrictEqual(page.video.writes, []);
  assert.deepStrictEqual(page.playerMenu.entryClicks, ["Englisch", MENU_OFF_TEXT]);
});

test("transcript_menuCheckedOnlyWhenOpen_shouldStillSucceed", async () => {
  // GIVEN a track list that is rebuilt on every opening and hands out its mark only on the
  // nodes of the popup that is open right now — the nodes the pick was read from answer
  // `null` once the click closed the popup, because they are not on screen any more,
  const german = createCaptionTrack({ languageCode: "de", name: "Deutsch" });
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [german, english],
    audioTracks: [createOriginalAudioTrack(1)],
    texts: { en: "This is a 3.", de: "Das ist eine Drei." },
    entryTexts: [MENU_OFF_TEXT, "Deutsch", "Englisch", MENU_TRANSLATE_TEXT],
    contentName: "Deutsch",
    checkedText: "Deutsch",
    checkedOnlyWhenOpen: true,
  });
  // ... and the fixture really is that page: the mark is readable only on the nodes of the
  // list that is on screen, and an older node answers nothing,
  page.playerMenu.settingsButton.click();
  const settingsRows = page.playerMenu.items();
  settingsRows[1].click();
  const shownEntries = page.playerMenu.items().slice(settingsRows.length);
  assert.equal(
    shownEntries.some((item) => item.getAttribute("aria-checked") === "true"),
    true,
    "the open list shows the mark",
  );
  page.playerMenu.settingsButton.click();
  assert.equal(
    shownEntries.every((item) => item.getAttribute("aria-checked") === null),
    true,
    "the nodes of the closed popup answer no mark",
  );
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the pick is not reported as "did not take effect": the second look happens in the
  // freshly built list, and the run goes through,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true, answer.error?.message);
  assert.equal(answer.result.requestedLanguage, "en");
  assert.equal(answer.result.deliveredLanguage, "en");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a 3.");

  // ... the track went there and came back, the playhead went forward and came back, and the
  // popup the run opened is closed again.
  assert.deepStrictEqual(page.playerMenu.entryClicks, ["Englisch", "Deutsch"]);
  assert.deepStrictEqual(page.video.writes, [20.1, 19.1]);
  assert.equal(page.playerMenu.checkedText(), "Deutsch");
  assert.equal(page.playerMenu.isOpen(), false);
});

test("transcript_captionRow_foundByTheModelCount", async () => {
  // GIVEN a page with a decoy row whose *label* is a language name while its value is not,
  // and a menu that lists `captionTracks.length + 2` entries — the count M16 measured,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const german = createCaptionTrack({ languageCode: "de", name: "Deutsch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english, german],
    audioTracks: [createOriginalAudioTrack(1)],
    texts: { en: "This is a 3.", de: "Das ist eine Drei." },
    checkedText: "Deutsch",
    extraRows: [{ label: "Englisch", content: "Auto" }],
  });
  assert.equal(page.playerMenu.entryTexts.length, 4, "two tracks plus the two extra entries");
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the row was found by the *value* the model knows — not by the row whose label
  // happens to be a language name — and its entry count was the one the model predicts,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.requestedLanguage, "de");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "Das ist eine Drei.");
  assert.equal(page.playerMenu.settingsButton.clicks > 0, true, "the menu was opened");

  // ... the running track needed no click, the playhead went forward and came back, and the
  // menu the tool opened is closed again.
  assert.deepStrictEqual(page.playerMenu.entryClicks, []);
  assert.deepStrictEqual(page.video.writes, [20.1, 19.1]);
  assert.equal(page.playerMenu.isOpen(), false);
});

test("transcript_captionRow_ambiguous_shouldFail", async () => {
  // GIVEN two rows whose value is a name from the model — the player menu and, say, a second
  // one a page reshape left behind,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    checkedText: "Englisch",
    extraRows: [{ label: "Sprachen (alt)", content: "Englisch" }],
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN it refuses rather than opening one of the two, and nothing was clicked or moved,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes("Several rows"), answer.error.message);
  assert.deepStrictEqual(page.playerMenu.entryClicks, []);
  assert.deepStrictEqual(page.video.writes, []);
});

test("transcript_captionRow_absent_shouldFail", async () => {
  // GIVEN a settings menu without a single row whose value is a track name,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    contentName: MENU_OFF_TEXT,
    checkedText: MENU_OFF_TEXT,
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN it names the row it could not find, and it stops there: three injections — gate,
  // model, menu — because the wire carried no address for the target, so no reading injection
  // was ever made,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes("was not found"), answer.error.message);
  assert.equal(tabs.scriptCalls.length, 3);
  assert.deepStrictEqual(page.video.writes, []);
  assert.deepStrictEqual(page.playerMenu.entryClicks, []);
});

test("transcript_captionRow_noCandidate_shouldAnswerAnEmptyListAsNone", async () => {
  // GIVEN a menu that lists no entry carrying a language name, so the candidate list
  // the page hands back is empty,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    entryTexts: ["", "", ""],
    contentName: "Englisch",
    checkedText: "Englisch",
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the empty list reads `none` — an empty list used to be spelled `keine`, the one
  // German word that could still reach the caller inside an English sentence:
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.equal(
    answer.error.message,
    'The menu entry "Englisch" was not found (entries: none).',
  );
  assert.deepStrictEqual(page.playerMenu.entryClicks, []);
});

test("transcript_captionRow_miscount_shouldFail", async () => {
  // GIVEN a track list with one entry more than the model predicts — the shape behind
  // "Automatisch übersetzen hat einen Eintrag mehr": the model carries one track, so the
  // list should carry three entries (the track, "Aus", "Automatisch übersetzen", M16),
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    entryTexts: [MENU_OFF_TEXT, "Englisch", MENU_TRANSLATE_TEXT, "Deutsch"],
    checkedText: MENU_OFF_TEXT,
  });
  assert.equal(page.playerMenu.entryTexts.length, 4, "one more entry than the model predicts");
  // ... and the extra entry carries no `>>` marker: a pair entry would make the counter-check
  // expect one more and turn this into a different case — the refusal of a list that is off
  // by one for another reason.
  assert.equal(
    page.playerMenu.entryTexts.some((text) => text.includes(">>")),
    false,
    "no pair entry, so the count check has nothing to allow for",
  );
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the counter-check refuses the list and names both numbers — a list this shape is
  // not the track list the model describes, and clicking in it would be a guess,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes("4 entries instead of 3"), answer.error.message);

  // ... and nothing was clicked, fetched or moved: the refusal comes before the pick,
  assert.deepStrictEqual(page.playerMenu.entryClicks, []);
  assert.deepStrictEqual(page.video.writes, []);
  assert.deepStrictEqual(page.fetched, []);
  assert.equal(page.playerMenu.isOpen(), false);
});

test("transcript_captionRow_withATranslatedSuffix_stillFindsTheRow", async () => {
  // GIVEN a row that shows the auto-translated pair while the model names only the track —
  // "Japanisch (automatisch erzeugt) >> Englisch" against "Japanisch (automatisch erzeugt)",
  // the shape measured on 2026-11-12 (`bbbbbbbbbbb`) with auto-translation on,
  const japaneseName = "Japanisch (automatisch erzeugt)";
  const japanese = createCaptionTrack({ languageCode: "ja", vssId: "a.ja", name: japaneseName });
  const page = createTranscriptMenuPage({
    captionTracks: [japanese],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { ja: "Das ist eine Drei." },
    contentName: `${japaneseName} >> Englisch`,
    checkedText: japaneseName,
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the row is found — the comparison of the row's value drops the pair suffix — and the
  // run goes through instead of ending in the refusal of a missing row,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true, answer.error?.message);
  assert.equal(answer.result.requestedLanguage, "ja");
  assert.equal(answer.result.deliveredLanguage, "ja");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "Das ist eine Drei.");

  // ... the running track needed no click, the playhead went forward and came back, and the
  // popup the tool opened is closed again.
  assert.deepStrictEqual(page.playerMenu.entryClicks, []);
  assert.deepStrictEqual(page.video.writes, [20.1, 19.1]);
  assert.equal(page.playerMenu.isOpen(), false);
});

test("transcript_captionRow_withAPairEntry_countsOneMore", async () => {
  // GIVEN the plain row and a track list that holds one entry per track plus "Aus",
  // "Automatisch übersetzen" and the pair entry the auto-translation adds — four entries for
  // one track, the count measured on 2026-11-12 (`bbbbbbbbbbb`),
  const japaneseName = "Japanisch (automatisch erzeugt)";
  const japanese = createCaptionTrack({ languageCode: "ja", vssId: "a.ja", name: japaneseName });
  const page = createTranscriptMenuPage({
    captionTracks: [japanese],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { ja: "Das ist eine Drei." },
    entryTexts: [MENU_OFF_TEXT, japaneseName, MENU_TRANSLATE_TEXT, `${japaneseName} >> Englisch`],
    checkedText: japaneseName,
  });
  assert.equal(page.playerMenu.entryTexts.length, 4, "one track plus three entries");
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the counter-check counts the pair entry as one more and lets the list through
  // instead of refusing it as a list of the wrong size,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true, answer.error?.message);
  assert.equal(answer.result.requestedLanguage, "ja");
  assert.equal(answer.result.deliveredLanguage, "ja");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "Das ist eine Drei.");

  // ... nothing was picked, because the player was on the target already, and the playhead
  // went forward and came back.
  assert.deepStrictEqual(page.playerMenu.entryClicks, []);
  assert.deepStrictEqual(page.video.writes, [20.1, 19.1]);
  assert.equal(page.playerMenu.isOpen(), false);
});

test("transcript_captionRow_miscountWithAPairEntry_namesTheRealCount", async () => {
  // GIVEN a track list that holds a pair entry *and* one entry too many on top of it — the
  // shape where the plain count and the pair-adjusted count differ,
  const japaneseName = "Japanisch (automatisch erzeugt)";
  const japanese = createCaptionTrack({ languageCode: "ja", vssId: "a.ja", name: japaneseName });
  const page = createTranscriptMenuPage({
    captionTracks: [japanese],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { ja: "Das ist eine Drei." },
    entryTexts: [
      MENU_OFF_TEXT,
      japaneseName,
      MENU_TRANSLATE_TEXT,
      `${japaneseName} >> Englisch`,
      "Deutsch",
    ],
    checkedText: japaneseName,
  });
  assert.equal(page.playerMenu.entryTexts.length, 5, "one track, three fixed entries, one pair entry");
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the refusal names the count the check actually wanted — three from the model plus one
  // for the pair entry — and not the bare model count, which would read "statt 3" here,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "transcript_failed");
  assert.ok(answer.error.message.includes("5 entries instead of 4"), answer.error.message);

  // ... and the refusal still comes before the pick: nothing was clicked, fetched or moved,
  assert.deepStrictEqual(page.playerMenu.entryClicks, []);
  assert.deepStrictEqual(page.video.writes, []);
  assert.deepStrictEqual(page.fetched, []);
  assert.equal(page.playerMenu.isOpen(), false);
});

test("transcript_seekRestoresPosition", async () => {
  // GIVEN a page whose player is already on the target track but has not fetched its file,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    checkedText: "Englisch",
    currentTime: 19.1,
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN exactly two writes to the playhead happened, in this order: one second forward, and
  // then back to where it was — the exact sequence, because a case that only checked the
  // final value would pass on a tool that never jumped,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(page.video.writes, [19.1 + 1, 19.1]);
  assert.equal(page.video.currentTime, 19.1);

  // ... and the track needed no click, because the player was on it already.
  assert.deepStrictEqual(page.playerMenu.entryClicks, []);
});

test("transcript_trackRestoredAfterReading", async () => {
  // GIVEN a page whose original is English while the operator is watching with the German
  // track selected — the M4 situation,
  const german = createCaptionTrack({ languageCode: "de", name: "Deutsch" });
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [german, english],
    audioTracks: [createOriginalAudioTrack(1)],
    texts: { en: "This is a 3.", de: "Das ist eine Drei." },
    contentName: "Deutsch",
    checkedText: "Deutsch",
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // ... the target track was picked and the previous one put back — in this order, so the
  // operator ends up where they were,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a 3.");
  assert.equal(page.playerMenu.checkedText(), "Deutsch");

  // ... and the *interleaving* is the contract: pick, jump, put the track back, put the
  // playhead back. One log for clicks and writes, because two arrays cannot tell this order
  // from the one with the last two steps swapped — and that swapped order is exactly what
  // leaves the operator with a moved playhead (criterion 6).
  assert.deepStrictEqual(page.events, [
    "menu:open",
    "menu:close",
    "menu:open",
    "click:Englisch",
    "write:20.1",
    "menu:open",
    "click:Deutsch",
    "write:19.1",
  ]);
  assert.equal(page.video.currentTime, 19.1);
});

test("transcript_positionRestoredEvenWhenTheTrackRestoreThrows", async () => {
  // GIVEN a page whose operator is on the German track while the original is English, and
  // whose track list goes away mid-click: the restore's click is where that shows,
  const german = createCaptionTrack({ languageCode: "de", name: "Deutsch" });
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [german, english],
    audioTracks: [createOriginalAudioTrack(1)],
    texts: { en: "This is a 3.", de: "Das ist eine Drei." },
    contentName: "Deutsch",
    checkedText: "Deutsch",
    throwOnRestoreClick: true,
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the reading itself is not touched by the failed cleanup: the answer stands, and the
  // error of the restore never replaces it,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true, answer.error?.message);
  assert.equal(answer.result.requestedLanguage, "en");
  assert.equal(answer.result.deliveredLanguage, "en");
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a 3.");

  // ... and the playhead came back all the same: the restore click threw, the write after it
  // did not. The last write is the position the run started from — the exact reason the
  // playhead write sits in the `finally` and not after the track click,
  assert.deepStrictEqual(page.playerMenu.entryClicks, ["Englisch", "Deutsch"]);
  assert.deepStrictEqual(page.video.writes, [20.1, 19.1]);
  assert.equal(page.video.writes[page.video.writes.length - 1], 19.1, "the start position");
  assert.equal(page.video.currentTime, 19.1);
});

test("transcript_captionsWereOff_shouldTurnThemOffAgain", async () => {
  // GIVEN a page whose captions are off — the off entry is the marked one,
  const german = createCaptionTrack({ languageCode: "de", name: "Deutsch" });
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [german, english],
    audioTracks: [createOriginalAudioTrack(1)],
    texts: { en: "This is a 3.", de: "Das ist eine Drei." },
    contentName: "Deutsch",
    checkedText: MENU_OFF_TEXT,
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the off entry was picked again at the end — the remembered name is put back exactly
  // as it was read, and "off" is a name like any other,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(page.playerMenu.entryClicks, ["Englisch", MENU_OFF_TEXT]);
  assert.equal(page.playerMenu.checkedText(), MENU_OFF_TEXT);
  assert.deepStrictEqual(page.video.writes, [20.1, 19.1]);
});

test("transcript_captionEntryAlreadyPresent_shouldNotSeek", async () => {
  // GIVEN a page whose player has already fetched the target's file — the running track is
  // the target, and its address sits on the wire,
  const german = createCaptionTrack({ languageCode: "de", name: "Deutsch" });
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [german, english],
    audioTracks: [createOriginalAudioTrack(1)],
    texts: { en: "This is a 3.", de: "Das ist eine Drei." },
    wire: createTranscriptWire(TRANSCRIPT_TAB_ID, [german, english]),
    contentName: "Englisch",
    checkedText: "Englisch",
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN it read the file without touching the player at all: no jump, no menu, no click —
  // the file was there, and a jump would only be a flicker for the operator,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a 3.");
  assert.deepStrictEqual(page.video.writes, []);
  assert.equal(page.playerMenu.settingsButton.clicks, 0);
  assert.deepStrictEqual(page.playerMenu.entryClicks, []);
  assert.equal(tabs.scriptCalls.length, 3);
});

test("transcript_staleAddress_shouldSeekAndRetry", async () => {
  // GIVEN a page whose wire carries an English address whose signature has run out:
  // the entry is there, the file behind it answers 404 (M13: the lifetime is unmeasured),
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const stale = transcriptResourceOf(english, 1);
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    wire: [{ tabId: TRANSCRIPT_TAB_ID, url: stale }],
    staleExpiries: ["1"],
    checkedText: "Englisch",
  });
  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN the call was repeated once: the stale file failed, the jump made the player fetch a
  // fresh address, and the younger entry is the one that answered,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(inThisRealm(answer.result.segments)[0].text, "This is a 3.");
  assert.equal(page.fetched.length, 2);
  assert.equal(page.fetched[0].includes("expire=1&"), true, page.fetched[0]);
  assert.equal(page.fetched[1].includes("expire=101&"), true, page.fetched[1]);

  // ... and the position went back after the one jump.
  assert.deepStrictEqual(page.video.writes, [20.1, 19.1]);
});

/*
 * The menu state is left as it was found (review m4). The settings button toggles the popup,
 * so a click on it after an entry click — the page closes the popup by itself — does not
 * close anything: it *opens* the menu again, and the operator ends up with a settings menu
 * that was closed before the call.
 */
test("transcript_menuLeftClosedAfterSet", async () => {
  // GIVEN a page whose operator has the menu closed and an older track running, so the call
  // has to pick a track and put that older one back,
  const german = createCaptionTrack({ languageCode: "de", name: "Deutsch" });
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [german, english],
    audioTracks: [createOriginalAudioTrack(1)],
    texts: { en: "This is a 3.", de: "Das ist eine Drei." },
    contentName: "Deutsch",
    checkedText: "Deutsch",
  });
  assert.equal(page.playerMenu.isOpen(), false, "the menu starts closed");

  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN both picks happened,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.deepStrictEqual(page.playerMenu.entryClicks, ["Englisch", "Deutsch"]);

  // ... and the menu is closed afterwards, as it was before. The timeline is the proof: the
  // popup is opened and closed for the reading, opened again for the pick — and after that
  // pick the page closes it by itself, so no `menu:open` may stand between the two pick
  // clicks. A blind second click on the button would reopen it there, and the restore would
  // have to work in a popup this run left open,
  assert.equal(page.playerMenu.isOpen(), false, "the menu must be closed after the call");
  assert.deepStrictEqual(page.events, [
    "menu:open",
    "menu:close",
    "menu:open",
    "click:Englisch",
    "write:20.1",
    "menu:open",
    "click:Deutsch",
    "write:19.1",
  ]);
});

test("transcript_menuStaysOpenWhenItWasOpen", async () => {
  // GIVEN a page whose operator opened the settings menu themselves, and whose player is
  // already on the target track without having fetched its file — the call reads the menu
  // and never clicks an entry,
  const english = createCaptionTrack({ languageCode: "en", name: "Englisch" });
  const page = createTranscriptMenuPage({
    captionTracks: [english],
    audioTracks: [createOriginalAudioTrack(0)],
    texts: { en: "This is a 3." },
    checkedText: "Englisch",
    menuOpen: true,
  });
  assert.equal(page.playerMenu.isOpen(), true, "the menu starts open");

  const { tabs } = createTranscriptTabs(page);
  const { socket } = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });

  // WHEN the tool is called,
  await sendTranscript(socket, 2);

  // THEN it read the track and jumped for the file,
  const answer = responsesById(socket).get(2);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.deliveredLanguage, "en");
  assert.deepStrictEqual(page.video.writes, [20.1, 19.1]);

  // ... and it left the operator's popup where it was: closing it would remove something
  // this run did not open, so the settings button was not clicked at all.
  assert.equal(page.playerMenu.isOpen(), true, "the menu the operator opened stays open");
  assert.equal(page.playerMenu.settingsButton.clicks, 0);
  assert.deepStrictEqual(page.playerMenu.entryClicks, []);
});

/* ---------------------------------------------- spec 45: the injection seam */

/**
 * A started extension whose tab carries the agent channel — driven through a tool.
 *
 * The four cases below are about the channel itself. Since stage 1b every tool takes
 * exactly that road, so none of them needs a hook into `bridge.js`: the single-frame
 * cases go through `inspect`, and the broadcast case addresses a frame.
 */
async function injectionStarted(pageAgent) {
  const tabs = createTabsStub({
    tabs: [createAgentTabFixture({ status: "complete" })],
    pageAgent,
  });
  const started = await connectedBackground({ tabs, settings: STORED_TAB_SETTINGS });
  return { tabs, ...started };
}

test("inject_withAFunc_shouldRunItInThePageWorldRealm", async () => {
  // GIVEN a tab with one main frame, injected the ordinary way — so the isolated world
  // of that frame exists and has run the page agent,
  const page = { ...DEFAULT_READ_PAGE };
  const tabs = createTabsStub({ pageAgent: { frames: [{ href: page.url, page, top: true }] } });
  await tabs.injectFile({ files: [PAGE_AGENT_FILE], target: { tabId: 500, frameIds: [0] } });

  // WHEN a `func` writes a variable onto the page's global and reads it back,
  const [first] = await tabs.injectFile({
    args: [],
    world: "MAIN",
    func: function () {
      globalThis.__bcProbe = 42;
      return globalThis.__bcProbe;
    },
    target: { tabId: 500, frameIds: [0] },
  });

  // THEN it ran, and the answer is its return value — one entry per frame, like
  // `executeScript` answers a `func`,
  assert.equal(first.frameId, 0);
  assert.equal(first.result, 42);

  // ... the variable stayed in the page's world, so the next injection still reads it,
  const [second] = await tabs.injectFile({
    args: [],
    world: "MAIN",
    func: function () {
      return globalThis.__bcProbe;
    },
    target: { tabId: 500, frameIds: [0] },
  });
  assert.equal(second.result, 42);

  // ... and the isolated world of the same frame does not see it, so the two realms are
  // really two — the claim every later case about the page world rests on,
  assert.equal(
    vm.runInContext("typeof globalThis.__bcProbe", tabs.channel.realms.get(0).context),
    "undefined",
  );
});

test("inject_withAFuncThatAnswersAPromise_shouldAnswerTheResolvedValue", async () => {
  // GIVEN a tab with one main frame whose page timers the harness drives,
  const page = { ...DEFAULT_READ_PAGE };
  const tabs = createTabsStub({
    pageAgent: { frames: [{ href: page.url, page, top: true }], advanceMs: 50 },
  });

  // WHEN a `func` answers a promise that resolves on a 50 ms page timer,
  const [entry] = await tabs.injectFile({
    args: [25],
    world: "MAIN",
    func: function (delayMs) {
      return new Promise((resolve) => {
        setTimeout(() => resolve(`after ${delayMs}`), delayMs);
      });
    },
    target: { tabId: 500, frameIds: [0] },
  });

  // THEN the injection waited for it and answered the settled value — not `{}`, not the
  // pending promise, which is what a JSON round-trip on the return value would give,
  assert.equal(entry.frameId, 0);
  assert.equal(entry.result, "after 25");
});

test("injection_whenAFrameStaysSilent_shouldRejectAtTheDeadline", async () => {
  // GIVEN one frame that takes the file but never answers — the frame mid-navigation:
  const { tabs, socket, clock } = await injectionStarted({ frames: [{ href: AGENT_URL, silent: true }] });

  // WHEN the bridge inspects that frame,
  await sendInspect(socket, 2, { text: "eintrag" });

  // THEN nothing is decided yet: no answer is silence, and silence is the deadline's job,
  assert.deepStrictEqual(clock.pendingDelays(), [INJECTION_REPLY_TIMEOUT_MS]);
  assert.equal(responsesById(socket).has(2), false, "the call must wait for the deadline, not answer early");

  // ... and that deadline is 5 000 ms — its own budget, under the bridge's 20 000, so the
  // agent reads the tool's answer instead of `ExtensionTimeout`:
  clock.runByDelay(INJECTION_REPLY_TIMEOUT_MS);
  await settleAsyncWork();
  assert.equal(responsesById(socket).get(2).error.code, "not_readable");
  assert.deepStrictEqual(clock.pendingDelays(), [], "the deadline must not survive its call");

  // ... and the frame was asked exactly once — a retry would only cost another budget.
  assert.equal(tabs.channel.calls.length, 1);
});

test("injection_whenSendMessageIsRejected_shouldAnswerNotReadable", async () => {
  // GIVEN a channel that refuses the message — "Receiving end does not exist", the normal
  // state of every frame right after a navigation:
  const { socket, clock } = await injectionStarted({
    frames: [{ href: AGENT_URL }],
    refuseSendMessage: true,
  });

  // WHEN the bridge inspects that frame,
  await sendInspect(socket, 2, { text: "eintrag" });

  // THEN the refusal is neither a crash nor a timeout — it is a page that cannot be read,
  assert.equal(responsesById(socket).get(2).error.code, "not_readable");

  // ... and nothing waited for an answer nobody could give:
  assert.deepStrictEqual(clock.pendingDelays(), []);
});

test("injection_withTwoCallIds_shouldAnswerEachCallerOnce", async () => {
  // GIVEN one frame and two calls opened before either answer exists — the second
  // injection loads the same file into the same frame again (risk 2):
  const page = createInspectFixture().page;
  const { tabs, socket } = await injectionStarted({ frames: [{ href: page.url, page }] });

  // WHEN both ask at once,
  socket.receive({ type: "request", id: 2, method: "inspect", params: { selector: "a#warenkorb-link" } });
  socket.receive({ type: "request", id: 3, method: "inspect", params: { selector: "a#warenkorb-link" } });
  await settleAsyncWork();

  // THEN each call carries its own id and got its own answer — the assignment is by
  // `callId`, never by the order the answers happen to arrive in,
  assert.deepStrictEqual(Object.keys(tabs.channel.answerCounts()), ["1", "2"]);
  assert.equal(responsesById(socket).get(2).ok, true);
  assert.equal(responsesById(socket).get(3).ok, true);

  // ... and the frame answered exactly once per id. A second dispatcher — the file run
  // twice without the guard — would answer every call twice, and the first caller would
  // read a duplicate it never asked for:
  assert.deepStrictEqual(tabs.channel.answerCounts(), { 1: 1, 2: 1 });
  assert.equal(tabs.channel.listenerCount(), 1, "the guard must keep it at one listener");
});

test("injection_withTwoFrames_shouldCollectBothAnswers", async () => {
  // GIVEN a main frame and a child with an address of its own, and a child that answers
  // only when the case lets it answer:
  const pages = createFramedInspectPages();
  const { tabs, socket, clock } = await injectionStarted({
    frames: pages.map((page, index) => ({ href: page.url, page, top: index === 0 })),
    holdAnswersFrom: [1],
  });

  // WHEN the bridge inspects through the child's address,
  await sendInspect(socket, 2, { text: "termin", frame: "widget" });

  // THEN the first answer does not end the collection: the deadline is still armed and
  // the call is still open, because `frame_ambiguous` and the frame filter of spec 24
  // need every frame's word,
  assert.deepStrictEqual(clock.pendingDelays(), [INJECTION_REPLY_TIMEOUT_MS]);
  assert.equal(responsesById(socket).has(2), false, "one answer out of two must not end the call");

  // ... until the second frame speaks too,
  tabs.channel.flushHeldAnswers();
  await settleAsyncWork();

  // THEN both answers are on the wire, each naming the frame that said it and its own
  // address — the frame count of the injection is what the collection expected, not a
  // guess:
  assert.deepStrictEqual(
    tabs.channel.answers.map((answer) => answer.frameId),
    [0, 1],
  );
  assert.deepStrictEqual(
    tabs.channel.answers.map((answer) => answer.message.value.href),
    [AGENT_URL, "https://widget.example.net/kalender"],
  );
  assert.equal(responsesById(socket).get(2).ok, true);

  // ... and the deadline that guarded the wait is gone with it:
  assert.deepStrictEqual(clock.pendingDelays(), []);
});
