/**
 * The coordinator of the bridge tab, without Firefox (spec 42, criteria 1–5).
 *
 * `background.js` only keeps exactly one tab on `bridge.html` alive. What is tested
 * here is that promise and its four hard cases: the tab that is already there, the
 * tab the operator closed, the tab Firefox discarded, and the tab that was navigated
 * away — plus the two windows it must never choose (a private one) and never leave
 * (a container).
 *
 * The stubs model the parts of `tabs`/`windows` the coordinator touches, and they
 * refuse what Firefox refuses: a `tabs.create` into a private window throws, and an
 * unknown query filter throws instead of silently matching nothing.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const COORDINATOR_SOURCE = await readFile(
  new URL("../extension/background.js", import.meta.url),
  "utf8",
);

const EXTENSION_ORIGIN = "moz-extension://bridge-tab-test";
const BRIDGE_URL = `${EXTENSION_ORIGIN}/bridge.html`;
// The container a tab lands in inside a normal window. The bridge tab must be there:
// every other tab of the agent lives in that store too, and a container tab is
// filtered out of the status answer.
const DEFAULT_COOKIE_STORE_ID = "firefox-default";
const PRIVATE_COOKIE_STORE_ID = "firefox-private";
const FOREIGN_URL = "https://example.org/";
const FIRST_WINDOW_ID = 101;
const PRIVATE_WINDOW_ID = 201;

/* ---------------------------------------------------------------- stubs */

function createFakeBrowser({ windows = [], tabs = [] } = {}) {
  const windowById = new Map(
    windows.map((window) => [
      window.id,
      { type: "normal", incognito: false, focused: false, ...window },
    ]),
  );
  const tabById = new Map(
    tabs.map((tab) => [tab.id, { pinned: false, discarded: false, ...tab }]),
  );
  const calls = [];
  const removedListeners = [];
  const updatedListeners = [];
  const startupListeners = [];
  let nextTabId = 900;
  let nextWindowId = 500;

  function record(method, args) {
    calls.push({ method, args });
  }

  function callsTo(method) {
    return calls.filter((call) => call.method === method);
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

  const browser = {
    runtime: {
      getURL: (page) => {
        record("runtime.getURL", { page });
        return `${EXTENSION_ORIGIN}/${page}`;
      },
      onStartup: {
        addListener: (listener) => {
          startupListeners.push(listener);
        },
      },
    },
    tabs: {
      query: async (query) => {
        record("tabs.query", query);
        const unknown = Object.keys(query).filter((key) => key !== "url");
        assert.deepEqual(unknown, [], `the harness does not know the query key(s) ${unknown}`);
        return [...tabById.values()].filter((tab) => tab.url === query.url).map((tab) => ({ ...tab }));
      },
      create: async (properties) => {
        record("tabs.create", properties);
        const window = requireWindow(properties.windowId);
        // Firefox refuses to put an extension tab into a private window unless the
        // extension was granted private-browsing access. The bridge never asks.
        if (window.incognito) throw new Error("tabs.create: private window");
        return addTab({ url: properties.url, windowId: properties.windowId, pinned: properties.pinned === true });
      },
      get: async (tabId) => {
        record("tabs.get", { tabId });
        const tab = tabById.get(tabId);
        if (tab === undefined) throw new Error(`tabs.get: no tab ${tabId}`);
        return { ...tab };
      },
      remove: async (tabId) => {
        record("tabs.remove", { tabId });
        removeTab(tabId);
      },
      reload: async (tabId) => {
        record("tabs.reload", { tabId });
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
        record("windows.get", { windowId });
        const window = windowById.get(windowId);
        if (window === undefined) throw new Error(`windows.get: no window ${windowId}`);
        return { ...window };
      },
      getAll: async () => {
        record("windows.getAll", {});
        return [...windowById.values()].map((window) => ({ ...window }));
      },
      create: async () => {
        record("windows.create", {});
        const window = { id: nextWindowId, type: "normal", incognito: false, focused: true };
        nextWindowId += 1;
        windowById.set(window.id, window);
        // A fresh Firefox window opens with one blank tab; the coordinator adds the
        // bridge tab and closes the blank one.
        const blank = addTab({ url: "about:newtab", windowId: window.id });
        return { ...window, tabs: [{ ...blank }] };
      },
    },
  };

  return {
    browser,
    calls,
    callsTo,
    tabs: () => [...tabById.values()].map((tab) => ({ ...tab })),
    bridgeTabs: () => [...tabById.values()].filter((tab) => tab.url === BRIDGE_URL),
    windows: () => [...windowById.values()].map((window) => ({ ...window })),
    fireStartup: () => {
      for (const listener of startupListeners) listener();
    },
    navigate,
    discard,
    closeWindow,
    removeTab,
  };
}

function captureConsole(lines) {
  const append = (level) => (...args) => lines.push({ level, text: args.join(" ") });
  return { log: append("log"), warn: append("warn"), error: append("error"), info: append("info") };
}

/** The two rounds of `setImmediate` the extension tests use for the same reason. */
async function settleAsyncWork() {
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function startCoordinator(options = {}) {
  const fake = createFakeBrowser(options);
  const consoleLines = [];
  const sandbox = vm.createContext({
    browser: fake.browser,
    console: captureConsole(consoleLines),
  });
  vm.runInNewContext(COORDINATOR_SOURCE, sandbox, { filename: "extension/background.js" });
  await settleAsyncWork();
  return { fake, consoleLines };
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
  assert.equal(creations[0].args.url, BRIDGE_URL);
  assert.equal(creations[0].args.pinned, true);
  assert.equal(creations[0].args.windowId, FIRST_WINDOW_ID);

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
  assert.equal(creations[1].args.url, BRIDGE_URL);
  assert.equal(creations[1].args.pinned, true);
  assert.equal(creations[1].args.windowId, FIRST_WINDOW_ID);

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
    fake.callsTo("tabs.reload").map((call) => call.args.tabId),
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
  assert.notEqual(creations[0].args.windowId, PRIVATE_WINDOW_ID);

  // AND the tab it made is a normal tab in a normal window.
  const [window] = fake.windows().filter((candidate) => candidate.id === creations[0].args.windowId);
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
  assert.equal("cookieStoreId" in creation.args, false);
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
  assert.equal(creations[1].args.windowId, windowsCreated.id);
  assert.equal(creations[1].args.pinned, true);

  // AND the blank tab the new window opened with is gone, so a fresh window costs
  // exactly one tab.
  assert.deepEqual(
    fake.tabs().map((tab) => tab.url),
    [BRIDGE_URL],
  );
});
