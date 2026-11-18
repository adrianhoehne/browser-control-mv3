"use strict";

/**
 * The page agent: the shared helpers and the dispatcher, shipped as a *file* (spec 45).
 *
 * Until this increment the three helpers travelled as source text, built by
 * `pageSnippetCode` and handed to `tabs.executeScript({code})`. They now come in as
 * `{file: "page-agent.js"}` and answer by message: `{callId, op, args}` in,
 * `{callId, ok, value}` or `{callId, ok: false, error}` back out.
 *
 * It runs in the isolated world of the extension, exactly like the injected source it
 * replaces: the DOM is visible, the page's *variables* are not. That is a wall, not a
 * bug — do not reach for `window.something` here and wonder why it is `undefined`.
 *
 * The three helpers below are copied verbatim from `bridge.js`. Their comments still
 * mention `PAGE_HELPERS_CODE` and `toString()`: that is the transport this file
 * replaces, and those comments disappear together with the originals in stage 1b.
 */
(() => {
  // The first statement on purpose (spec 45, risk 2). Every injection of this file runs
  // it again, and a second `runtime.onMessage` listener would answer every call a second
  // time — the duplicate would arrive under a `callId` that already has its answer. The
  // marker sits on the page's global object, so it outlives the second run of this file.
  if (globalThis.__bcPageAgentReady === true) return;
  globalThis.__bcPageAgentReady = true;

  /**
   * Tag plus at most one distinguishing detail — never the markup.
   *
   * A module function rather than a nested one because two snippets need it:
   * `click` describes the element it touched, `type` the field it wrote into.
   * `PAGE_HELPERS_CODE` carries it into the page through `toString()`, so it may
   * touch nothing but its argument — a closure over this module's scope would not
   * survive the trip into the other realm.
   */
  function describeElement(element) {
    const tag = String(element.tagName).toLowerCase();
    const id = typeof element.id === "string" ? element.id : "";
    if (id !== "") return `${tag}#${id}`.slice(0, 120);
    const className = typeof element.className === "string" ? element.className.trim() : "";
    const firstClass = className.split(/\s+/)[0];
    if (firstClass !== "") return `${tag}.${firstClass}`.slice(0, 120);
    const href = element.getAttribute("href");
    if (typeof href === "string" && href !== "") return `${tag}[href="${href}"]`.slice(0, 120);
    const label = element.getAttribute("aria-label");
    if (typeof label === "string" && label !== "") return `${tag}[aria-label="${label}"]`.slice(0, 120);
    return tag.slice(0, 120);
  }

  /**
   * Whether the element is rendered at all: an element nobody can see is one
   * nobody can click or type into, and answering "done" for it would be the
   * silent lie this project refuses to tell.
   *
   * Shared by `click` and `type` for the same reason as `describeElement` — one
   * rule, one function, one place to change it.
   */
  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden") return false;
    if (style.display === "none") return false;
    return true;
  }

  /**
   * Whether this realm is the frame the caller addressed by a substring of its address.
   *
   * A module function like `describeElement`, and for the same reason: it travels into
   * the page inside `PAGE_HELPERS_CODE` through `toString()`, so it may close over
   * nothing of this scope. `want === null` is "the main frame" and always true.
   *
   * The comparison is the one `readPageSource` performs inline — that snippet ships
   * without the shared helpers, so the line exists there a second time; the *form* is
   * the same (folded `location.href`, `includes`), because one half of the contract may
   * not answer differently from the other (spec 24, `## Extension`).
   */
  function isAddressedFrame(want) {
    if (want === null) return true;
    return String(location.href).toLowerCase().includes(want);
  }

  /* ---------------------------------------------------------------- the ops */

  /**
   * What `op` can be asked for, by name.
   *
   * Closed on purpose: an op nobody registered is answered as such instead of being
   * guessed at, and a caller with a typo hears about it in the answer rather than in a
   * silent frame. `inventory` is the only entry until stage 1b moves the snippets over —
   * it is the self-report the frame inventory is built from (spec 45, `## Die Naht`).
   */
  const OPS = Object.freeze({
    inventory: () => ({ href: location.href, top: window.top === window }),
  });

  /**
   * The answer to one message, or `null` when the message is not a call of ours.
   *
   * A call is recognised by its integer `callId`, not by a marker field: the bridge page
   * is the only sender in this realm, and an earlier answer carries the same id as the
   * call it belongs to. Anything else stays unanswered — a listener that answered every
   * message would drown in its own echoes.
   */
  function answerOf(message) {
    if (message === null || typeof message !== "object") return null;
    if (!Number.isInteger(message.callId)) return null;
    const op = OPS[message.op];
    if (op === undefined) {
      return { callId: message.callId, ok: false, error: `unknown op: ${String(message.op)}` };
    }
    try {
      return { callId: message.callId, ok: true, value: op(message.args ?? {}) };
    } catch (error) {
      // A snippet that throws is the page's complaint, not a protocol error: pass it on
      // verbatim instead of dressing it in a code this side never decided.
      return { callId: message.callId, ok: false, error: String(error?.message ?? error) };
    }
  }

  browser.runtime.onMessage.addListener((message) => {
    const answer = answerOf(message);
    if (answer === null) return undefined;
    // Back as its own message, not as this listener's return value: the bridge page knows
    // how many frames it injected into but not their ids, so it broadcasts and every
    // frame has to speak up on its own — a return value carries one answer at most.
    void Promise.resolve(browser.runtime.sendMessage(answer)).catch(() => {
      // Nobody is listening: the bridge page is gone, and there is no answer to deliver.
    });
    // No response on this channel either — the answer already travelled as a message, and
    // a second copy here would answer the same `callId` twice.
    return undefined;
  });
})();
