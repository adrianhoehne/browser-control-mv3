/**
 * The coordinator of the bridge tab, and the switch that decides whether there is one
 * (spec 42, criteria 1–5; spec 44, criteria 2, 3 and 6).
 *
 * `background.js` keeps exactly one tab on `bridge.html` alive — while the operator has
 * the extension switched on. What is tested here is that promise and its four hard cases
 * (the tab that is already there, the tab the operator closed, the tab Firefox discarded,
 * the tab that was navigated away), the two windows it must never choose or leave, and the
 * switch: off by default, one click toggles, off says goodbye before the tab goes.
 *
 * The stubs model the parts of `tabs`/`windows`/`storage`/`browserAction` the extension
 * touches, and they refuse what Firefox refuses: a `tabs.create` into a private window
 * throws, an unknown query filter throws instead of silently matching nothing, and the
 * toolbar namespace of the other manifest version throws — under MV3 `browserAction` is
 * `undefined`, and a test that silently accepted either name would pin nothing.
 *
 * The `switch_*` cases that need the page (the goodbye, the bolt) run `bridge.js` in a
 * second realm beside the coordinator, wired through one message bus and one store. The
 * socket is a stub, so the *frame order* is what they prove — not a live connection.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const COORDINATOR_SOURCE = await readFile(
  new URL("../extension/background.js", import.meta.url),
  "utf8",
);
const PROTOCOL_SOURCE = await readFile(new URL("../extension/protocol.js", import.meta.url), "utf8");
const PAGE_SOURCE = await readFile(new URL("../extension/bridge.js", import.meta.url), "utf8");

const EXTENSION_ORIGIN = "moz-extension://bridge-tab-test";
const BRIDGE_URL = `${EXTENSION_ORIGIN}/bridge.html`;
const TOKEN = "a-test-token";
const ENDPOINT = "ws://127.0.0.1:8110";
/** A store that can connect: endpoint and token. */
const CREDENTIALS = { endpoint: ENDPOINT, token: TOKEN };
/** The same store with the switch on — what a running extension has. */
const CONNECTED_SETTINGS = { ...CREDENTIALS, bridgeEnabled: true };
// The container a tab lands in inside a normal window. The bridge tab must be there:
// every other tab of the agent lives in that store too, and a container tab is
// filtered out of the status answer.
const DEFAULT_COOKIE_STORE_ID = "firefox-default";
const PRIVATE_COOKIE_STORE_ID = "firefox-private";
const FOREIGN_URL = "https://example.org/";
const FIRST_WINDOW_ID = 101;
const PRIVATE_WINDOW_ID = 201;
const ICON_ON = "icons/bridge.svg";
const ICON_OFF = "icons/bridge-off.svg";
const ICON_OFFLINE = "icons/bridge-offline.svg";

/* ---------------------------------------------------------------- stubs */

function captureConsole(lines, side) {
  const append = (level) => (...args) => lines.push({ side, level, text: args.join(" ") });
  return { log: append("log"), warn: append("warn"), error: append("error"), info: append("info") };
}

/**
 * A timer queue instead of a real clock — the reconnect backoff is a `setTimeout`, and a
 * case that let it run would either dial a socket nobody wants or keep the process alive.
 * `pendingDelays()` is the assertion: "no retry was scheduled" is a claim about the queue.
 */
function createTimerStub() {
  const scheduled = [];
  return {
    setTimeout: (callback, delayMs) => {
      scheduled.push({ callback, delayMs, cancelled: false });
      return scheduled.length;
    },
    clearTimeout: (id) => {
      const entry = scheduled[id - 1];
      if (entry !== undefined) entry.cancelled = true;
    },
    pendingDelays: () => scheduled.filter((entry) => !entry.cancelled).map((entry) => entry.delayMs),
  };
}

/** The socket of the bridge page: records what goes on the wire and when. */
function createSocketStub(url, record) {
  const listeners = new Map();
  const socket = {
    url,
    readyState: 0,
    sent: [],
    closeCalls: [],
    addEventListener: (type, listener) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    send: (raw) => {
      if (socket.readyState !== 1) throw new Error("send on a socket that is not open");
      const message = JSON.parse(raw);
      socket.sent.push(message);
      record("socket.send", { message });
    },
    close: (code) => {
      socket.closeCalls.push(code);
      socket.readyState = 3;
      record("socket.close", { code });
      emit("close");
    },
  };

  function emit(type) {
    for (const listener of listeners.get(type) ?? []) listener({ type });
  }

  /** The handshake: the connection is up. */
  socket.open = () => {
    socket.readyState = 1;
    emit("open");
  };

  /** The bridge going away, without this page asking for it. */
  socket.dropConnection = () => {
    socket.readyState = 3;
    emit("close");
  };

  return socket;
}

function createFakeBrowser({
  windows = [],
  tabs = [],
  settings = {},
  manifestVersion = 2,
} = {}) {
  const windowById = new Map(
    windows.map((window) => [
      window.id,
      { type: "normal", incognito: false, focused: false, ...window },
    ]),
  );
  const tabById = new Map(
    tabs.map((tab) => [tab.id, { pinned: false, discarded: false, ...tab }]),
  );
  const storage = { ...settings };
  const calls = [];
  const listeners = [];
  const clickListeners = [];
  const removedListeners = [];
  const updatedListeners = [];
  const startupListeners = [];
  const sockets = [];
  let nextTabId = 900;
  let nextWindowId = 500;

  // The namespace the manifest implies, and a trap on the other one: under MV3
  // `browserAction` does not exist in Firefox, so a coordinator that reached for it
  // would fail at startup rather than set a button nobody sees.
  const toolbarName = manifestVersion === 3 ? "action" : "browserAction";

  function record(side, method, args = {}) {
    calls.push({ side, method, ...args });
  }

  function callsTo(method) {
    return calls.filter((call) => call.method === method);
  }

  function toolbarCalls(name) {
    return calls.filter((call) => call.method === "setIcon" && call.namespace === name);
  }

  function requireWindow(windowId) {
    const window = windowById.get(windowId);
    assert.notEqual(window, undefined, `no window ${windowId} in the harness`);
    return window;
  }

  function cookieStoreOf(window) {
    if (window.cookieStoreId !== undefined) return window.cookieStoreId;
    return window.incognito ? PRIVATE_COOKIE_STORE_ID : DEFAULT_COOKIE_STORE_ID;
  }

  function addTab({ url, windowId, pinned = false }) {
    const window = requireWindow(windowId);
    const tab = {
      id: nextTabId,
      windowId,
      url,
      pinned,
      discarded: false,
      active: false,
      cookieStoreId: cookieStoreOf(window),
    };
    nextTabId += 1;
    tabById.set(tab.id, tab);
    return tab;
  }

  function removeTab(tabId) {
    const tab = tabById.get(tabId);
    if (tab === undefined) throw new Error(`tabs.remove: no tab ${tabId}`);
    tabById.delete(tabId);
    for (const listener of removedListeners) listener(tabId, { windowId: tab.windowId, isWindowClosing: false });
  }

  function fireUpdated(tabId, changeInfo) {
    const tab = tabById.get(tabId);
    assert.notEqual(tab, undefined, `tabs.onUpdated for an unknown tab ${tabId}`);
    for (const listener of updatedListeners) listener(tabId, changeInfo, tab);
  }

  /** What the browser does when the operator navigates the tab somewhere else. */
  function navigate(tabId, url) {
    const tab = tabById.get(tabId);
    assert.notEqual(tab, undefined, `no tab ${tabId} to navigate`);
    tab.url = url;
    fireUpdated(tabId, { url });
  }

  /** What the browser does under memory pressure: the page is unloaded. */
  function discard(tabId) {
    const tab = tabById.get(tabId);
    assert.notEqual(tab, undefined, `no tab ${tabId} to discard`);
    tab.discarded = true;
    fireUpdated(tabId, { discarded: true });
  }

  function closeWindow(windowId) {
    windowById.delete(windowId);
    const doomed = [...tabById.values()].filter((tab) => tab.windowId === windowId);
    for (const tab of doomed) tabById.delete(tab.id);
    // Firefox reports a closing window as one removal per tab, `isWindowClosing` set.
    for (const tab of doomed) {
      for (const listener of removedListeners) listener(tab.id, { windowId, isWindowClosing: true });
    }
  }

  /**
   * One extension context answering another — the way `runtime.sendMessage` behaves.
   *
   * No receiver means a rejection ("Could not establish connection"), which is the path
   * the switch-off takes when there is no page: no page, no socket, no goodbye. A
   * receiver that answers nothing resolves `undefined`.
   */
  async function sendMessage(from, message) {
    const receivers = listeners.filter((entry) => entry.side !== from);
    if (receivers.length === 0) {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    for (const { listener } of receivers) {
      const answer = await listener(message, { id: EXTENSION_ORIGIN });
      if (answer !== undefined) return answer;
    }
    return undefined;
  }

  function makeToolbar(name, side) {
    const guard = () => {
      if (name !== toolbarName) {
        throw new Error(`${name} used under manifest_version ${manifestVersion}`);
      }
    };
    return {
      setIcon: async (details) => {
        guard();
        record(side, "setIcon", { namespace: name, details });
      },
      setTitle: async (details) => {
        guard();
        record(side, "setTitle", { namespace: name, details });
      },
      onClicked: {
        addListener: (listener) => {
          guard();
          clickListeners.push(listener);
        },
      },
    };
  }

  /** The API surface one extension context sees. `side` is `"coordinator"` or `"page"`. */
  function browserFor(side) {
    return {
      storage: {
        local: {
          // The real form: an array of keys yields only the keys that are stored.
          get: async (keys) => {
            const requested = Array.isArray(keys) ? keys : Object.keys(keys ?? {});
            record(side, "storage.get", { keys: requested });
            const stored = {};
            for (const key of requested) {
              if (key in storage) stored[key] = storage[key];
            }
            return stored;
          },
          set: async (values) => {
            record(side, "storage.set", { values: { ...values } });
            Object.assign(storage, values);
          },
        },
      },
      runtime: {
        getURL: (page) => {
          record(side, "runtime.getURL", { page });
          return `${EXTENSION_ORIGIN}/${page}`;
        },
        getManifest: () => ({ version: "0.5.1", manifest_version: manifestVersion }),
        getBrowserInfo: async () => ({ name: "Firefox", version: "152.0" }),
        onMessage: {
          addListener: (listener) => {
            listeners.push({ side, listener });
          },
        },
        onStartup: {
          addListener: (listener) => {
            startupListeners.push(listener);
          },
        },
        sendMessage: (message) => sendMessage(side, message),
      },
      tabs: {
        query: async (query) => {
          record(side, "tabs.query", { query });
          const unknown = Object.keys(query).filter((key) => key !== "url");
          assert.deepEqual(unknown, [], `the harness does not know the query key(s) ${unknown}`);
          return [...tabById.values()].filter((tab) => tab.url === query.url).map((tab) => ({ ...tab }));
        },
        create: async (properties) => {
          record(side, "tabs.create", { properties });
          const window = requireWindow(properties.windowId);
          // Firefox refuses to put an extension tab into a private window unless the
          // extension was granted private-browsing access. The bridge never asks.
          if (window.incognito) throw new Error("tabs.create: private window");
          return addTab({ url: properties.url, windowId: properties.windowId, pinned: properties.pinned === true });
        },
        get: async (tabId) => {
          record(side, "tabs.get", { tabId });
          const tab = tabById.get(tabId);
          if (tab === undefined) throw new Error(`tabs.get: no tab ${tabId}`);
          return { ...tab };
        },
        remove: async (tabId) => {
          record(side, "tabs.remove", { tabId });
          removeTab(tabId);
        },
        reload: async (tabId) => {
          record(side, "tabs.reload", { tabId });
          const tab = tabById.get(tabId);
          if (tab === undefined) throw new Error(`tabs.reload: no tab ${tabId}`);
          if (tab.reloadFails === true) throw new Error("tabs.reload: discarded");
          tab.discarded = false;
        },
        onRemoved: {
          addListener: (listener) => {
            removedListeners.push(listener);
          },
        },
        onUpdated: {
          addListener: (listener) => {
            updatedListeners.push(listener);
          },
        },
      },
      windows: {
        get: async (windowId) => {
          record(side, "windows.get", { windowId });
          const window = windowById.get(windowId);
          if (window === undefined) throw new Error(`windows.get: no window ${windowId}`);
          return { ...window };
        },
        getAll: async () => {
          record(side, "windows.getAll", {});
          return [...windowById.values()].map((window) => ({ ...window }));
        },
        create: async () => {
          record(side, "windows.create", {});
          const window = { id: nextWindowId, type: "normal", incognito: false, focused: true };
          nextWindowId += 1;
          windowById.set(window.id, window);
          // A fresh Firefox window opens with one blank tab; the coordinator adds the
          // bridge tab and closes the blank one.
          const blank = addTab({ url: "about:newtab", windowId: window.id });
          return { ...window, tabs: [{ ...blank }] };
        },
      },
      // The bridge page watches `api/timedtext` requests (spec 34); the coordinator must
      // not, and `test/extension.test.js` is where that promise is pinned.
      webRequest: {
        onBeforeRequest: {
          addListener: () => {},
        },
      },
      browserAction: makeToolbar("browserAction", side),
      action: makeToolbar("action", side),
    };
  }

  return {
    calls,
    callsTo,
    toolbarCalls,
    browserFor,
    storage: () => ({ ...storage }),
    tabs: () => [...tabById.values()].map((tab) => ({ ...tab })),
    bridgeTabs: () => [...tabById.values()].filter((tab) => tab.url === BRIDGE_URL),
    windows: () => [...windowById.values()].map((window) => ({ ...window })),
    sockets,
    click: () => {
      for (const listener of clickListeners) listener({}, {});
    },
    fireStartup: () => {
      for (const listener of startupListeners) listener();
    },
    navigate,
    discard,
    closeWindow,
    removeTab,
  };
}

/** The two rounds of `setImmediate` the extension tests use for the same reason. */
async function settleAsyncWork(rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

/**
 * The coordinator alone — no page realm.
 *
 * `settings` defaults to `{ bridgeEnabled: true }`, because these cases are about the tab
 * and not about the switch: the switch is off by default (spec 44), and a case that wanted
 * "no tab" would be green for the wrong reason. The `switch_*` cases pass their own store.
 */
async function startCoordinator(options = {}) {
  const fake = createFakeBrowser({ ...options, settings: options.settings ?? CONNECTED_SETTINGS });
  const consoleLines = [];
  const sandbox = vm.createContext({
    browser: fake.browserFor("coordinator"),
    console: captureConsole(consoleLines, "coordinator"),
  });
  vm.runInNewContext(COORDINATOR_SOURCE, sandbox, { filename: "extension/background.js" });
  await settleAsyncWork(4);
  return { fake, consoleLines };
}

/**
 * The bridge page in its own realm, on the same store and the same message bus.
 *
 * Started *after* the coordinator on purpose: in Firefox the tab is created first and
 * loads the page afterwards, and a page that dials before its tab exists is a shape that
 * never occurs.
 */
function startBridgePage(fake, { timers = createTimerStub() } = {}) {
  const consoleLines = [];
  const sockets = [];
  const context = vm.createContext({
    browser: fake.browserFor("page"),
    console: captureConsole(consoleLines, "page"),
    // A class, not an object: `bridge.js` calls `new WebSocket(...)`. It keeps the
    // sockets it made so a case can open one, and records every frame with the side.
    WebSocket: class FakeWebSocket {
      constructor(url) {
        const socket = createSocketStub(url, (method, args) => fake.calls.push({ side: "page", method, ...args }));
        sockets.push(socket);
        fake.sockets.push(socket);
        return socket;
      }
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    URL,
  });
  vm.runInNewContext(PROTOCOL_SOURCE, context, { filename: "extension/protocol.js" });
  vm.runInNewContext(PAGE_SOURCE, context, { filename: "extension/bridge.js" });
  return { sockets, consoleLines, timers };
}

/** The index of the first call recorded under `method`, or `-1`. */
function indexOfCall(fake, method) {
  return fake.calls.findIndex((call) => call.method === method);
}

/** Every `setIcon` path, in the order the coordinator asked for them. */
function lastIcon(fake) {
  const icons = fake.callsTo("setIcon");
  return icons.at(-1)?.details?.path;
}

function lastTitle(fake) {
  return fake.callsTo("setTitle").at(-1)?.details?.title;
}

/* ----------------------------------------------------------------- cases */

test("bridgeTab_whenMissing_shouldBeCreatedOnce", async () => {
  // GIVEN a browser with one normal window and no bridge tab,
  // WHEN the coordinator starts,
  const { fake } = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
  });

  // THEN it clicks exactly once, with `pinned` in the same call — creating unpinned
  // and pinning afterwards would be two visible steps,
  const creations = fake.callsTo("tabs.create");
  assert.equal(creations.length, 1);
  assert.equal(creations[0].properties.url, BRIDGE_URL);
  assert.equal(creations[0].properties.pinned, true);
  assert.equal(creations[0].properties.windowId, FIRST_WINDOW_ID);

  // AND the tab exists exactly once, pinned, in the remembered window,
  const bridgeTabs = fake.bridgeTabs();
  assert.equal(bridgeTabs.length, 1);
  assert.equal(bridgeTabs[0].pinned, true);
  assert.equal(bridgeTabs[0].windowId, FIRST_WINDOW_ID);
});

test("bridgeTab_withASecondStart_shouldNotCreateASecondTab", async () => {
  // GIVEN a running coordinator with its tab,
  const { fake } = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
  });
  assert.equal(fake.bridgeTabs().length, 1);

  // WHEN the browser reports a second start (a restart of the background page is a
  // start too),
  fake.fireStartup();
  await settleAsyncWork();

  // THEN the existing tab is adopted instead of a second one being opened: two tabs
  // would be two sockets, and the bridge ends the older one with `4409`.
  assert.equal(fake.callsTo("tabs.create").length, 1);
  assert.equal(fake.bridgeTabs().length, 1);
});

test("bridgeTab_withTwoConcurrentStarts_shouldStillCreateOne", async () => {
  // GIVEN a running coordinator whose tab is gone — the state in which two callers
  // both see "no tab" and both want to make one,
  const { fake } = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
  });
  const [bridgeTab] = fake.bridgeTabs();
  const creationsBefore = fake.callsTo("tabs.create").length;

  // WHEN the removal and a start fire back to back, in the same tick — `query` and
  // `create` are not atomic, so without the guard each would count nothing and both
  // would create,
  fake.removeTab(bridgeTab.id);
  fake.fireStartup();
  await settleAsyncWork();

  // THEN exactly one new tab was created: two would be two sockets, and the bridge
  // ends the older one with `4409`,
  assert.equal(fake.callsTo("tabs.create").length, creationsBefore + 1);

  // AND one bridge tab is left behind, not two.
  assert.equal(fake.bridgeTabs().length, 1);
});

test("bridgeTab_whenClosedByTheOperator_shouldComeBack", async () => {
  // GIVEN a running coordinator with its tab,
  const { fake } = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
  });
  const [bridgeTab] = fake.bridgeTabs();

  // WHEN the operator closes that tab,
  fake.removeTab(bridgeTab.id);
  await settleAsyncWork();

  // THEN a new one is created in the same window, again pinned,
  const creations = fake.callsTo("tabs.create");
  assert.equal(creations.length, 2);
  assert.equal(creations[1].properties.url, BRIDGE_URL);
  assert.equal(creations[1].properties.pinned, true);
  assert.equal(creations[1].properties.windowId, FIRST_WINDOW_ID);

  // AND exactly one bridge tab is left behind.
  assert.equal(fake.bridgeTabs().length, 1);
});

test("bridgeTab_whenDiscarded_shouldBeReloaded", async () => {
  // GIVEN a running coordinator whose tab Firefox unloaded under memory pressure,
  const { fake } = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
  });
  const [bridgeTab] = fake.bridgeTabs();

  // WHEN `changeInfo.discarded` arrives,
  fake.discard(bridgeTab.id);
  await settleAsyncWork();

  // THEN the tab is reloaded — the socket's reconnect belongs to the page, so the
  // reload is the whole recovery — and no second tab is opened,
  assert.deepEqual(
    fake.callsTo("tabs.reload").map((call) => call.tabId),
    [bridgeTab.id],
  );
  assert.equal(fake.callsTo("tabs.create").length, 1);
  assert.equal(fake.bridgeTabs().length, 1);
  assert.equal(fake.bridgeTabs()[0].discarded, false);
});

test("bridgeTab_afterANavigationAway_shouldBeReplaced", async () => {
  // GIVEN a running coordinator with its tab,
  const { fake } = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
  });
  const [bridgeTab] = fake.bridgeTabs();

  // WHEN the tab is navigated to a foreign page — `tabs.query({url})` cannot find it
  // any more, although it still exists,
  fake.navigate(bridgeTab.id, FOREIGN_URL);
  await settleAsyncWork();

  // THEN the foreign tab is closed and a successor is created, pinned,
  assert.equal(fake.tabs().some((tab) => tab.id === bridgeTab.id), false);
  assert.equal(fake.bridgeTabs().length, 1);
  assert.equal(fake.bridgeTabs()[0].pinned, true);
  assert.equal(fake.bridgeTabs()[0].windowId, FIRST_WINDOW_ID);
  assert.equal(fake.callsTo("tabs.create").length, 2);
});

test("bridgeTab_shouldNeverUseAPrivateWindow", async () => {
  // GIVEN nothing but a private window — "the last used window" can be one,
  const { fake } = await startCoordinator({
    windows: [{ id: PRIVATE_WINDOW_ID, incognito: true, focused: true }],
  });

  // WHEN the coordinator needs a window,
  // THEN it opens a normal one instead of putting the tab next to the operator's
  // private browsing,
  assert.equal(fake.callsTo("windows.create").length, 1);
  const creations = fake.callsTo("tabs.create");
  assert.equal(creations.length, 1);
  assert.notEqual(creations[0].properties.windowId, PRIVATE_WINDOW_ID);

  // AND the tab it made is a normal tab in a normal window.
  const [window] = fake.windows().filter((candidate) => candidate.id === creations[0].properties.windowId);
  assert.equal(window.incognito, false);
  assert.equal(fake.bridgeTabs().length, 1);
});

test("bridgeTab_shouldNeverLandInAContainer", async () => {
  // GIVEN a normal window, the only one there is,
  const { fake } = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
  });

  // WHEN the tab is created,
  const [creation] = fake.callsTo("tabs.create");

  // THEN it lands in the default container — and the coordinator did not pick a
  // store itself, which is the only way to end up in a container by accident,
  assert.equal("cookieStoreId" in creation.properties, false);
  assert.equal(fake.bridgeTabs()[0].cookieStoreId, DEFAULT_COOKIE_STORE_ID);
});

test("bridgeTab_whenTheWindowIsGone_shouldOpenANewOne", async () => {
  // GIVEN a coordinator whose tab lived in window 101,
  const { fake } = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
  });
  assert.equal(fake.bridgeTabs().length, 1);

  // WHEN that whole window disappears (the operator closed it), taking the tab with
  // it — Firefox reports that as a removal of the tab,
  fake.closeWindow(FIRST_WINDOW_ID);
  await settleAsyncWork();

  // THEN the remembered window is dropped instead of being dialled again, and a new
  // window is opened for the tab,
  assert.equal(fake.callsTo("windows.create").length, 1);
  const [windowsCreated] = fake.windows();
  const creations = fake.callsTo("tabs.create");
  // One from the first start in window 101, one from the replacement.
  assert.equal(creations.length, 2);
  assert.equal(creations[1].properties.windowId, windowsCreated.id);
  assert.equal(creations[1].properties.pinned, true);

  // AND the blank tab the new window opened with is gone, so a fresh window costs
  // exactly one tab.
  assert.deepEqual(
    fake.tabs().map((tab) => tab.url),
    [BRIDGE_URL],
  );
});

/* ------------------------------------------------------------ the switch */

test("switch_onAFreshProfile_shouldBeOff", async () => {
  // GIVEN a fresh profile: a normal window and a store without `bridgeEnabled`,
  const fake = createFakeBrowser({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
    settings: CREDENTIALS,
  });
  const sandbox = vm.createContext({
    browser: fake.browserFor("coordinator"),
    console: captureConsole([], "coordinator"),
  });
  vm.runInNewContext(COORDINATOR_SOURCE, sandbox, { filename: "extension/background.js" });
  await settleAsyncWork(4);
  // ... and a page, which is what a tab would have loaded,
  const page = startBridgePage(fake);
  await settleAsyncWork(4);

  // WHEN nothing was clicked,
  // THEN no tab was created and no socket was dialled — the page refuses on its own,
  assert.equal(fake.callsTo("tabs.create").length, 0);
  assert.equal(page.sockets.length, 0);

  // AND nothing was written: "absent" is the default, not a value someone stored,
  assert.equal("bridgeEnabled" in fake.storage(), false);

  // AND the icon is the crossed-out bridge with the "off" tooltip.
  assert.equal(lastIcon(fake), ICON_OFF);
  assert.match(lastTitle(fake), /aus/);
});

test("switch_whenClickedOn_shouldOpenTheTabAndConnect", async () => {
  // GIVEN a fresh profile, started and switched off,
  const fake = createFakeBrowser({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
    settings: CREDENTIALS,
  });
  const sandbox = vm.createContext({
    browser: fake.browserFor("coordinator"),
    console: captureConsole([], "coordinator"),
  });
  vm.runInNewContext(COORDINATOR_SOURCE, sandbox, { filename: "extension/background.js" });
  await settleAsyncWork(4);
  assert.equal(fake.bridgeTabs().length, 0);

  // WHEN the operator clicks the icon,
  fake.click();
  await settleAsyncWork(4);

  // THEN the state is stored first — the page reads it on load, and a tab opened
  // before the write would come up believing it is off,
  const writeIndex = fake.calls.findIndex(
    (call) => call.method === "storage.set" && call.values.bridgeEnabled === true,
  );
  assert.notEqual(writeIndex, -1, "the switch did not store `bridgeEnabled: true`");
  assert.ok(writeIndex < indexOfCall(fake, "tabs.create"), "the tab came before the state");

  // ... and exactly one pinned tab exists, in the visible window,
  const creations = fake.callsTo("tabs.create");
  assert.equal(creations.length, 1);
  assert.equal(creations[0].properties.url, BRIDGE_URL);
  assert.equal(creations[0].properties.pinned, true);
  assert.equal(fake.bridgeTabs().length, 1);

  // AND the icon says "on, but not connected yet": the bolt, not the bridge.
  assert.equal(lastIcon(fake), ICON_OFFLINE);

  // WHEN that tab loads the page and the socket opens,
  const page = startBridgePage(fake);
  await settleAsyncWork(4);
  assert.equal(page.sockets.length, 1);
  page.sockets[0].open();
  await settleAsyncWork(4);

  // THEN the icon is the bridge, because the page reported the connection.
  assert.equal(lastIcon(fake), ICON_ON);
});

test("switch_whenTheBridgeIsUnreachable_shouldShowTheBolt", async () => {
  // GIVEN a switched-on extension with a page that has not reached the bridge yet,
  const start = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
  });
  const page = startBridgePage(start.fake);
  await settleAsyncWork(4);
  assert.equal(page.sockets.length, 1);

  // WHEN the socket never opens,
  // THEN the icon is the yellow bolt — an on extension without a connection,
  assert.equal(lastIcon(start.fake), ICON_OFFLINE);
  assert.match(lastTitle(start.fake), /keine Verbindung/);

  // ... and WHEN the socket opens, the bridge icon comes back without a second click.
  page.sockets[0].open();
  await settleAsyncWork(4);
  assert.equal(lastIcon(start.fake), ICON_ON);
});

test("switch_whenClickedOff_shouldSendGoodbyeThenClose", async () => {
  // GIVEN a switched-on, connected extension,
  const start = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
  });
  const page = startBridgePage(start.fake);
  await settleAsyncWork(4);
  const [socket] = page.sockets;
  socket.open();
  await settleAsyncWork(4);
  assert.equal(lastIcon(start.fake), ICON_ON);

  // WHEN the operator clicks the icon to switch off,
  start.fake.click();
  await settleAsyncWork(6);

  // THEN the frame order is the contract of spec 44: `goodbye` on the wire, then the
  // close with 1000 — the code the bridge logs as "on purpose" —, then the tab goes,
  // and only then is `off` stored. A close before the frame would drop the goodbye,
  // and a tab closed before the page answered would drop both.
  const goodbyeIndex = start.fake.calls.findIndex(
    (call) => call.method === "socket.send" && call.message.type === "goodbye",
  );
  const closeIndex = start.fake.calls.findIndex(
    (call) => call.method === "socket.close" && call.code === 1000,
  );
  const removeIndex = indexOfCall(start.fake, "tabs.remove");
  const writeIndex = start.fake.calls.findIndex(
    (call) => call.method === "storage.set" && call.values.bridgeEnabled === false,
  );
  for (const [name, index] of [
    ["goodbye", goodbyeIndex],
    ["close(1000)", closeIndex],
    ["tabs.remove", removeIndex],
    ["storage.set(false)", writeIndex],
  ]) {
    assert.notEqual(index, -1, `the switch-off never did ${name}`);
  }
  assert.ok(goodbyeIndex < closeIndex, "the close came before the goodbye");
  assert.ok(closeIndex < removeIndex, "the tab went before the socket was closed");
  assert.ok(removeIndex < writeIndex, "the state was written before the tab was gone");

  // AND the socket really is closed, the tab gone and the icon crossed out.
  assert.deepEqual(socket.closeCalls, [1000]);
  assert.equal(start.fake.bridgeTabs().length, 0);
  assert.equal(start.fake.storage().bridgeEnabled, false);
  assert.equal(lastIcon(start.fake), ICON_OFF);
});

test("switch_whenClickedOff_withoutASocket_shouldNotSayGoodbye", async () => {
  // GIVEN a switched-on extension whose page never reached the bridge — no socket,
  const start = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
  });
  const page = startBridgePage(start.fake);
  await settleAsyncWork(4);
  assert.equal(page.sockets.length, 1);

  // WHEN the operator clicks off,
  start.fake.click();
  await settleAsyncWork(6);

  // THEN nothing was said and nothing was closed (the stub socket would throw on a
  // send), and the tab and the state are still handled.
  assert.deepEqual(
    start.fake.calls.filter((call) => call.method === "socket.send"),
    [],
  );
  assert.equal(start.fake.bridgeTabs().length, 0);
  assert.equal(start.fake.storage().bridgeEnabled, false);
});

test("switch_whenOff_shouldNotReconnect", async () => {
  // GIVEN a connected extension whose socket the bridge then drops,
  const start = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
  });
  const page = startBridgePage(start.fake);
  await settleAsyncWork(4);
  const [socket] = page.sockets;
  socket.open();
  await settleAsyncWork(4);

  // ... with the switch turned off behind the page's back (an operator who wrote the
  // store, or a second context that got there first),
  await start.fake.browserFor("coordinator").storage.local.set({ bridgeEnabled: false });

  // WHEN the connection is lost,
  socket.dropConnection();
  await settleAsyncWork(6);

  // THEN no retry is scheduled — the loop this switch exists to end — and no second
  // socket was dialled.
  assert.deepEqual(page.timers.pendingDelays(), []);
  assert.equal(page.sockets.length, 1);
  assert.equal(start.fake.storage().bridgeEnabled, false);
});

test("action_namespace_shouldFollowTheManifestVersion", async () => {
  // GIVEN two coordinators with the same job under two manifests — MV2, where the
  // button is `browserAction`, and MV3, where it is `action`,
  const underMV2 = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
    manifestVersion: 2,
  });
  const underMV3 = await startCoordinator({
    windows: [{ id: FIRST_WINDOW_ID, focused: true }],
    manifestVersion: 3,
  });

  // WHEN each of them sets its icon,
  // THEN each used exactly the namespace its manifest names — and the other one was
  // never touched. Both namespaces exist in this harness, so "whichever is there"
  // would pass one of the two runs and fail the other:
  assert.equal(underMV2.fake.toolbarCalls("browserAction").length > 0, true);
  assert.deepEqual(underMV2.fake.toolbarCalls("action"), []);
  assert.equal(underMV3.fake.toolbarCalls("action").length > 0, true);
  assert.deepEqual(underMV3.fake.toolbarCalls("browserAction"), []);

  // AND one click switches under either manifest.
  underMV3.fake.click();
  await settleAsyncWork(4);
  assert.equal(underMV3.fake.storage().bridgeEnabled, false);
});
