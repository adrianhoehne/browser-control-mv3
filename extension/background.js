"use strict";

/**
 * Coordinator of the browser-control extension: keeps exactly one bridge tab alive.
 *
 * The socket, the settings, the tab store and the tools live in `bridge.js`, which
 * runs inside `bridge.html` (spec 42). That page can be reloaded or discarded, and
 * either way it comes back on its own; what it cannot do is exist without being
 * opened. That is all this file does: open it once, and open it again when it is
 * gone.
 *
 * Deliberately stateless beyond two ids. No socket, no backoff, no timer: a
 * coordinator that reconnects on its own would be the mistake of spec 02 again,
 * only with the reconnect living in the wrong context. If this page dies, the
 * bridge tab keeps its connection and nothing is lost.
 *
 * A classic script, not a module — the manifest lists it in `background.scripts`.
 */
(() => {
  const BRIDGE_PAGE = "bridge.html";
  // Firefox's default container. The bridge tab must not live in a container: it
  // would disappear from `isDefaultContainerTab` in the status answer, and the
  // operator's container selection is theirs, not ours.
  const DEFAULT_COOKIE_STORE_ID = "firefox-default";
  const NORMAL_WINDOW_TYPE = "normal";
  const BRIDGE_TAB_CREATE_FAILED_LOG_LINE =
    "bc: Brücken-Tab ließ sich nicht anlegen, neuer Versuch in einem neuen Fenster";
  const BRIDGE_TAB_RELOAD_FAILED_LOG_LINE =
    "bc: Brücken-Tab ließ sich nicht neu laden und wird ersetzt";
  const BRIDGE_TAB_CONTAINER_LOG_LINE = "bc: Brücken-Tab landete in einem Container:";
  const BRIDGE_TAB_FAILED_LOG_LINE = "bc: Brücken-Tab konnte nicht hergestellt werden";

  // The window the bridge tab was last seen in. The next one goes where the last
  // one was, so the operator finds it where they left it. Null until the first
  // reconcile and after a browser restart — neither is a loss, the fallback below
  // is a window the operator can see.
  let rememberedWindowId = null;
  // The tab this coordinator created or adopted. Two uses: to notice that *our* tab
  // was closed, and to find it again after it was navigated away — a `query` by URL
  // cannot see it any more, and without the id the dead tab would stay.
  let bridgeTabId = null;
  // Single-flight. `query` and `create` are not atomic, so `runtime.onStartup` and
  // `tabs.onRemoved` can arrive together; without this guard each would create its
  // own tab, and two tabs mean two sockets — the second one kicks the first with
  // `4409`. One in-flight reconcile is shared, not queued: a second caller wants
  // the tab that is being made right now, not another one.
  let inFlight = null;

  function bridgeUrl() {
    return browser.runtime.getURL(BRIDGE_PAGE);
  }

  /**
   * Makes sure a bridge tab exists — the one entry point of this file.
   *
   * Answers a promise that never rejects: the callers are event listeners, and an
   * unhandled rejection in a background page is a console nobody reads.
   */
  function ensureBridgeTab() {
    if (inFlight === null) {
      inFlight = reconcileAndReport().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  async function reconcileAndReport() {
    try {
      await reconcile();
    } catch (error) {
      console.error(BRIDGE_TAB_FAILED_LOG_LINE, error);
    }
  }

  async function reconcile() {
    const open = asArray(await browser.tabs.query({ url: bridgeUrl() }))[0];
    const found = open ?? (await replaceTabThatLeftTheBridge());
    if (found === null || found === undefined) {
      await createBridgeTab();
      return;
    }
    adopt(found);
  }

  function adopt(tab) {
    bridgeTabId = tab.id;
    if (Number.isInteger(tab.windowId)) rememberedWindowId = tab.windowId;
  }

  /**
   * The tab we made last, if it is still around under a foreign URL.
   *
   * Three answers from one look: `null` when there is nothing to work with, the tab
   * itself when it is on `bridge.html` after all (a reload that finished between the
   * query and this line — adopting it beats a second tab), and otherwise it is
   * closed and `null` answered. A pinned tab the operator navigated away from is
   * dead weight next to the new one, and it stays visible forever.
   */
  async function replaceTabThatLeftTheBridge() {
    if (bridgeTabId === null) return null;
    const previousId = bridgeTabId;
    bridgeTabId = null;
    const tab = await tabOrNull(previousId);
    if (tab === null) return null;
    if (tab.url === bridgeUrl()) return tab;
    await closeQuietly(previousId);
    return null;
  }

  async function tabOrNull(tabId) {
    try {
      return await browser.tabs.get(tabId);
    } catch {
      // Tab ids do not survive a browser restart, and the operator may have closed
      // it a moment ago. Either way: nothing to adopt, nothing to close.
      return null;
    }
  }

  async function closeQuietly(tabId) {
    try {
      await browser.tabs.remove(tabId);
    } catch {
      // Already gone — the operator was faster, and that is a fine end state.
    }
  }

  async function createBridgeTab() {
    let target = await targetWindow();
    let tab;
    try {
      tab = await createPinnedBridgeTab(target.id);
    } catch (error) {
      // A window can close between `windows.get` and `tabs.create`. One retry in a
      // fresh window beats a bridge that stays away until the next tab removal.
      console.warn(BRIDGE_TAB_CREATE_FAILED_LOG_LINE, error);
      target = await newWindow();
      tab = await createPinnedBridgeTab(target.id);
    }
    adopt(tab);
    // `windows.create` opens with a blank tab; a fresh window should cost one tab.
    if (target.blankTabId !== null && target.blankTabId !== tab.id) {
      await closeQuietly(target.blankTabId);
    }
    // Not fatal, and not worth closing a working tab over. It should not happen at
    // all: `tabs.create` without `cookieStoreId` uses the window's default store.
    if (tab.cookieStoreId !== undefined && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID) {
      console.warn(BRIDGE_TAB_CONTAINER_LOG_LINE, tab.cookieStoreId);
    }
  }

  /**
   * One `tabs.create`, `pinned` in the same call.
   *
   * Creating unpinned and pinning afterwards would be two visible steps with a tab
   * the operator can close in between — and the pin is the whole point: a pinned tab
   * stays visible and is less likely to be discarded.
   */
  function createPinnedBridgeTab(windowId) {
    return browser.tabs.create({ url: bridgeUrl(), pinned: true, windowId });
  }

  /**
   * The window the bridge tab belongs in, as `{ id, blankTabId }`.
   *
   * `blankTabId` is the leftover of a window this call had to invent, and `null`
   * for a window that already existed. Passed along instead of returned separately
   * because only the caller knows whether its `tabs.create` succeeded.
   */
  async function targetWindow() {
    const remembered = await rememberedWindowOrNull();
    if (remembered !== null) return { id: remembered, blankTabId: null };
    // No remembered window (first start, browser restart) or the window is gone:
    // take one the operator can see, and only invent a window when there is none.
    const visible = await lastFocusedNormalWindowId();
    if (visible !== null) return { id: visible, blankTabId: null };
    return newWindow();
  }

  /**
   * The remembered window, if it is still there and not a private one.
   *
   * A private window is not an address: the extension runs there only with
   * `incognito: "split"`/`"spanning"`, and a bridge tab in it would be invisible to
   * the agent's own window list. It counts as gone.
   */
  async function rememberedWindowOrNull() {
    if (rememberedWindowId === null) return null;
    const remembered = rememberedWindowId;
    let window;
    try {
      window = await browser.windows.get(remembered);
    } catch {
      return null;
    }
    return window !== null && !window.incognito ? remembered : null;
  }

  /** The focused normal window, else the first normal window, else `null`. */
  async function lastFocusedNormalWindowId() {
    const normal = asArray(await browser.windows.getAll()).filter(isNormalWindow);
    const window = normal.find((candidate) => candidate.focused === true) ?? normal[0];
    return window?.id ?? null;
  }

  function isNormalWindow(window) {
    // Private windows are `type: "normal"` in Firefox too and only differ by
    // `incognito` — the same check the bridge page makes for the status answer.
    return window.type === NORMAL_WINDOW_TYPE && !window.incognito;
  }

  /**
   * A brand-new window, plus the blank tab it opens with.
   *
   * The bridge tab is *not* created here: it still comes from `tabs.create` with
   * `pinned`, never from `windows.create({url})` plus an update — see
   * `createPinnedBridgeTab`. That leaves one blank tab behind for the caller to
   * close, which is the price of a tab that is never visible unpinned.
   */
  async function newWindow() {
    const window = await browser.windows.create();
    const blankTabId = window?.tabs?.[0]?.id;
    return { id: window.id, blankTabId: Number.isInteger(blankTabId) ? blankTabId : null };
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  async function reloadBridgeTab(tabId) {
    try {
      await browser.tabs.reload(tabId);
    } catch (error) {
      // A tab that refuses to come back is not a tab we can use. Closing it lets
      // `tabs.onRemoved` build a new one instead of leaving a dead pinned tab.
      console.warn(BRIDGE_TAB_RELOAD_FAILED_LOG_LINE, error);
      await closeQuietly(tabId);
    }
  }

  browser.tabs.onRemoved.addListener((tabId) => {
    // Only *our* tab is a decision. Any other tab closing says nothing about the
    // bridge, and a `query` per closed tab would be a lot of nothing.
    if (tabId !== bridgeTabId) return;
    bridgeTabId = null;
    void ensureBridgeTab();
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== bridgeTabId) return;
    if (changeInfo?.discarded === true) {
      // Discarded means unloaded, socket gone. The reload re-runs `bridge.js`, and
      // its reconnect belongs to that page, not to this one.
      void reloadBridgeTab(tabId);
      return;
    }
    if (typeof changeInfo?.url === "string" && changeInfo.url !== bridgeUrl()) {
      // Navigated away: the tab is no longer findable by URL. `reconcile` closes it
      // and opens the successor.
      void ensureBridgeTab();
    }
  });

  browser.runtime.onStartup.addListener(() => {
    void ensureBridgeTab();
  });

  // The first need: an extension that was just installed or reloaded gets no
  // `onStartup`, and a coordinator that only waits for events would leave the
  // operator without a tab until the next browser restart.
  void ensureBridgeTab();
})();
