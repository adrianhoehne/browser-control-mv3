"use strict";

/**
 * Coordinator of the browser-control extension: keeps exactly one bridge tab alive —
 * if, and only if, the operator switched the extension on.
 *
 * The socket, the settings, the tab store and the tools live in `bridge.js`, which
 * runs inside `bridge.html` (spec 42). That page can be reloaded or discarded, and
 * either way it comes back on its own; what it cannot do is exist without being
 * opened. That is all this file does: open it once while the switch says `on`, and
 * open it again when it is gone.
 *
 * Deliberately stateless beyond three ids and two flags. No socket, no backoff, no
 * timer: a coordinator that reconnects on its own would be the mistake of spec 02
 * again, only with the reconnect living in the wrong context. If this page dies, the
 * bridge tab keeps its connection and nothing is lost.
 *
 * A classic script, not a module — the manifest lists it in `background.scripts`.
 */
(() => {
  const BRIDGE_PAGE = "bridge.html";
  // The operator's switch from spec 44. Off is the state of a fresh profile: an
  // extension that dials the moment it is installed is a surprise, and the toolbar
  // icon is where the operator says yes.
  const BRIDGE_ENABLED_KEY = "bridgeEnabled";
  // The same literal stands in `bridge.js`, which decides about the socket. Two files
  // need it because the coordinator decides before any page exists; the E2E seam
  // patches both and counts them, so the copies cannot drift apart unnoticed.
  const DEFAULT_BRIDGE_ENABLED = false;
  // The three states, one icon each. Names, not sizes: `setIcon` takes the file, and
  // the manifest's `default_icon` is the off one because that is the start state.
  const ICON_ON = "icons/bridge.svg";
  const ICON_OFF = "icons/bridge-off.svg";
  const ICON_OFFLINE = "icons/bridge-offline.svg";
  const TITLE_ON = "Browser Control — verbunden";
  const TITLE_OFF = "Browser Control — aus";
  const TITLE_OFFLINE = "Browser Control — an, keine Verbindung zur Bridge";
  // The extension-internal channel to the bridge page. Not wire protocol: neither
  // frame ever reaches the bridge.
  const LEAVE_MESSAGE = "bc:leave";
  const CONNECTION_MESSAGE = "bc:connection";
  // Firefox's default container. The bridge tab must not live in a container: it
  // would disappear from `isDefaultContainerTab` in the status answer, and the
  // operator's container selection is theirs, not ours.
  const DEFAULT_COOKIE_STORE_ID = "firefox-default";
  const NORMAL_WINDOW_TYPE = "normal";
  const MV3_MANIFEST_VERSION = 3;
  const BRIDGE_TAB_CREATE_FAILED_LOG_LINE =
    "bc: Brücken-Tab ließ sich nicht anlegen, neuer Versuch in einem neuen Fenster";
  const BRIDGE_TAB_RELOAD_FAILED_LOG_LINE =
    "bc: Brücken-Tab ließ sich nicht neu laden und wird ersetzt";
  const BRIDGE_TAB_CONTAINER_LOG_LINE = "bc: Brücken-Tab landete in einem Container:";
  const BRIDGE_TAB_FAILED_LOG_LINE = "bc: Brücken-Tab konnte nicht hergestellt werden";
  const STATE_READ_FAILED_LOG_LINE = "bc: Schalterzustand nicht lesbar";
  const STATE_WRITE_FAILED_LOG_LINE = "bc: Schalterzustand nicht gespeichert";
  const TOOLBAR_FAILED_LOG_LINE = "bc: Symbolleiste ließ sich nicht ändern";
  const SWITCH_FAILED_LOG_LINE = "bc: Umschalten fehlgeschlagen";

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
  // The switch as this page knows it, and whether the page reports a socket. Both
  // flags exist for the icon; the truth about the socket stays in the tab.
  let enabled = DEFAULT_BRIDGE_ENABLED;
  let connected = false;
  // One switch at a time: two clicks in the same turn would otherwise both read the
  // state from before the first one and repeat its transition.
  let switchTail = Promise.resolve();

  function bridgeUrl() {
    return browser.runtime.getURL(BRIDGE_PAGE);
  }

  /* ------------------------------------------------------------- the switch */

  /**
   * The toolbar namespace, chosen by the manifest version.
   *
   * Under MV2 the button lives in `browser.browserAction`, under MV3 in
   * `browser.action` — the renamed object, with no alias left behind. Picking by
   * `manifest_version` and not by `browserAction || action` keeps this file honest
   * under both: an MV3 manifest would otherwise silently keep setting a button nobody
   * sees.
   */
  function toolbarOf(manifest) {
    return manifest.manifest_version === MV3_MANIFEST_VERSION ? browser.action : browser.browserAction;
  }

  /**
   * The stored switch, default `off`.
   *
   * An unreadable store answers with what this page already believes instead of a
   * guess: `off` on a fresh profile, and whatever the operator last chose otherwise.
   */
  async function readEnabled() {
    try {
      const stored = await browser.storage.local.get([BRIDGE_ENABLED_KEY]);
      const storedState = stored?.[BRIDGE_ENABLED_KEY];
      return typeof storedState === "boolean" ? storedState : DEFAULT_BRIDGE_ENABLED;
    } catch (error) {
      console.warn(STATE_READ_FAILED_LOG_LINE, error);
      return enabled;
    }
  }

  async function writeEnabled(value) {
    try {
      await browser.storage.local.set({ [BRIDGE_ENABLED_KEY]: value });
    } catch (error) {
      // The tab is already gone and the in-memory state already changed; the next
      // start reads the old value and opens the tab again. Worth a warning, not a throw.
      console.warn(STATE_WRITE_FAILED_LOG_LINE, error);
    }
  }

  /**
   * One click, one transition — off becomes on, on becomes off.
   *
   * The state is read fresh on every click and the clicks are chained, so a second
   * click during a running `goodbye` sees the result of the first one instead of
   * repeating it. Without the read this handler would not switch at all; without the
   * chain two fast clicks would both start the same transition.
   */
  function onToolbarClicked() {
    switchTail = switchTail.then(switchFromCurrentState).catch((error) => {
      console.error(SWITCH_FAILED_LOG_LINE, error);
    });
    return switchTail;
  }

  async function switchFromCurrentState() {
    if (await readEnabled()) {
      await switchOff();
      return;
    }
    await switchOn();
  }

  async function switchOn() {
    enabled = true;
    // The state first: the page reads it on load, and a tab opened before the write
    // would come up believing it is off.
    await writeEnabled(true);
    await ensureBridgeTab();
    await applyToolbar();
  }

  /**
   * Off in the order of spec 44: goodbye, `close 1000`, tab away, then the state.
   *
   * `enabled` flips before the first `await` on purpose — the tab we are closing
   * reports its removal, and a coordinator that still believed in `on` would build a
   * new one in that instant.
   */
  async function switchOff() {
    enabled = false;
    connected = false;
    await tellThePageGoodbye();
    await closeBridgeTab();
    await writeEnabled(false);
    await applyToolbar();
  }

  /**
   * The page's own goodbye, awaited.
   *
   * The tab must not disappear before the page has sent the frame and closed its
   * socket: a closed tab takes both with it, and the bridge would log a dropped
   * connection instead of the end of a session. A page that is not there answers with
   * a rejection, and that is not a failure — there was nothing to say goodbye to.
   */
  async function tellThePageGoodbye() {
    try {
      await browser.runtime.sendMessage({ type: LEAVE_MESSAGE });
    } catch {
      // No receiver: no page, so no socket, so no goodbye.
    }
  }

  /**
   * Icon and tooltip from the two flags. One call per change, not per second — the
   * bolt hangs on the connection state, and that changes when the socket does.
   */
  async function applyToolbar() {
    const icon = !enabled ? ICON_OFF : connected ? ICON_ON : ICON_OFFLINE;
    const title = !enabled ? TITLE_OFF : connected ? TITLE_ON : TITLE_OFFLINE;
    try {
      const toolbar = toolbarOf(browser.runtime.getManifest());
      await toolbar.setIcon({ path: icon });
      await toolbar.setTitle({ title });
    } catch (error) {
      // An icon that cannot be set is a nuisance; a bridge that does not run is a
      // failure. So: warn, keep going.
      console.warn(TOOLBAR_FAILED_LOG_LINE, error);
    }
  }

  /** The state on startup: read, then either build the tab or make sure there is none. */
  async function start() {
    enabled = (await readEnabled()) === true;
    if (enabled) {
      await ensureBridgeTab();
    } else {
      // A tab can outlive the switch that opened it (an extension reload while the
      // store was reset). Off means off, so it goes.
      await closeBridgeTab();
    }
    await applyToolbar();
  }

  /* ------------------------------------------------------------ the tab */

  /**
   * Makes sure a bridge tab exists — the one entry point of this file.
   *
   * A switch that is off answers an already-settled promise: the listeners below are
   * woken by events that say nothing about the operator's wish.
   *
   * Answers a promise that never rejects: the callers are event listeners, and an
   * unhandled rejection in a background page is a console nobody reads.
   */
  function ensureBridgeTab() {
    if (!enabled) return Promise.resolve();
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

  /**
   * Closes every tab this coordinator would adopt.
   *
   * Both sources of truth, because they see different tabs: the query by url finds one
   * this page did not create (a previous run of the extension), the remembered id finds
   * one that was navigated away — the query cannot see that one any more.
   */
  async function closeBridgeTab() {
    const tabIds = new Set();
    for (const tab of asArray(await browser.tabs.query({ url: bridgeUrl() }))) {
      tabIds.add(tab.id);
    }
    if (bridgeTabId !== null) tabIds.add(bridgeTabId);
    bridgeTabId = null;
    for (const tabId of tabIds) {
      await closeQuietly(tabId);
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

  /* --------------------------------------------------------- the listeners */

  browser.tabs.onRemoved.addListener((tabId) => {
    // Only *our* tab is a decision. Any other tab closing says nothing about the
    // bridge, and a `query` per closed tab would be a lot of nothing.
    if (tabId !== bridgeTabId) return;
    bridgeTabId = null;
    // The socket lived in that tab, so it is gone with it. Saying so keeps the icon
    // honest while the successor loads — and `ensureBridgeTab` stays quiet when the
    // operator is the one who closed the tab on purpose.
    connected = false;
    void applyToolbar();
    void ensureBridgeTab();
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== bridgeTabId) return;
    if (changeInfo?.discarded === true) {
      // Discarded means unloaded, socket gone. The reload re-runs `bridge.js`, and
      // its reconnect belongs to that page, not to this one.
      if (!enabled) return;
      void reloadBridgeTab(tabId);
      return;
    }
    if (typeof changeInfo?.url === "string" && changeInfo.url !== bridgeUrl()) {
      // Navigated away: the tab is no longer findable by URL. `reconcile` closes it
      // and opens the successor.
      void ensureBridgeTab();
    }
  });

  /**
   * The bridge page's report about its socket, which is what the bolt in the toolbar
   * is for. Everything else on this channel is ignored — the injection seam of spec 45
   * has its own listener in the page itself.
   */
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== CONNECTION_MESSAGE) return undefined;
    const next = message.connected === true;
    if (next === connected) return undefined;
    connected = next;
    void applyToolbar();
    return undefined;
  });

  toolbarOf(browser.runtime.getManifest()).onClicked.addListener(() => {
    void onToolbarClicked();
  });

  browser.runtime.onStartup.addListener(() => {
    void start();
  });

  // The first need: an extension that was just installed or reloaded gets no
  // `onStartup`, and a coordinator that only waits for events would leave the
  // operator without a tab until the next browser restart.
  void start();
})();
