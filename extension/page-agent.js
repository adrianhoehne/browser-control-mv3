"use strict";

/**
 * The page agent: the shared helpers and the dispatcher, shipped as a *file* (spec 45).
 *
 * Until this increment the tool snippets travelled as source text, built by
 * `pageSnippetCode` and handed to `tabs.executeScript({code})`. They now come in as
 * `{file: "page-agent.js"}` and answer by message: `{callId, op, args}` in,
 * `{callId, ok, value}` or `{callId, ok: false, error}` back out.
 *
 * It runs in the isolated world of the extension, exactly like the injected source it
 * replaces: the DOM is visible, the page's *variables* are not. That is a wall, not a
 * bug — do not reach for `window.something` here and wonder why it is `undefined`.
 *
 * Every op receives one flat argument object, and every field of it has crossed a
 * message channel: plain JSON only, no functions and no DOM nodes. That is not a style
 * rule but the transport — a function in `args` arrives as `undefined` on this side.
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
   * Shared by `click` and `type`: one describes the element it touched, the other the
   * field it wrote into, and one rule is better than two.
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
   * `want === null` is "the main frame" and always true. The comparison is the one
   * `readPageSource` performs inline — that function ships with its own copy, because
   * the filter has to be the first statement there and the two must answer the same
   * (spec 24, `## Extension`).
   */
  function isAddressedFrame(want) {
    if (want === null) return true;
    return String(location.href).toLowerCase().includes(want);
  }

  /* ------------------------------------------------------------------ read */

  /**
   * Normalises the page and cuts the window out of it — inside the page.
   *
   * It slices where the text is: only the page ever holds the whole article, so the
   * requested window travels and the rest never does. That is what makes the answer
   * cheap and `totalChars` possible at all — the extension cannot count a text it never
   * saw.
   *
   * `mode` is the one branch this op has. Anything but `"article"` takes the text path,
   * which is the path every earlier caller has always taken — line for line, down to the
   * `via` rule. Article mode walks the three stages of spec 23 in order: a semantic
   * root, then the density heuristic, then the honest fallback; the text then comes from
   * the cleaned copy of that root instead of the body — same `via` rule, same window.
   */
  function readPageSource(offset, maxChars, mode, minChars, urlLimit, titleLimit, want) {
    // The frame filter of spec 24, and the first statement on purpose: a frame that is
    // not meant answers the marker and does nothing else — no selection, no copy, no
    // read. `typeof` instead of `!== null`, because the main-frame payload does not carry
    // the argument at all (see `readPageCode`), and `includes(undefined)` would search
    // for the word "undefined" in every address.
    if (typeof want === "string" && !String(location.href).toLowerCase().includes(want)) {
      return { outcome: "not_the_frame", href: String(location.href).slice(0, urlLimit) };
    }
    // The hit's own address, attached by every answer below: with the filter on, the
    // extension needs the address of a hit for its `frame_ambiguous` candidates, and
    // this realm is the only one that knows it. Without a filter the field stays out —
    // the main-frame answer is a contract of its own.
    function frameFieldsOf() {
      return typeof want === "string" ? { href: String(location.href).slice(0, urlLimit) } : {};
    }
    // Nested on purpose: only what this function closes over travels to the page.
    function normalise(raw) {
      return raw
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
        .join("\n")
        .replace(/\n{2,}/g, "\n\n")
        .trim();
    }

    // Nested like `normalise`: the page realm has no module scope to close over.
    // The copy is the whole point — stripping the script tags from the real body
    // would be a write on the operator's page, and a read must not change it.
    function withoutNonTextElements(source) {
      const copy = source.cloneNode(true);
      copy.querySelectorAll("script,style,noscript").forEach((element) => element.remove());
      return copy;
    }

    // The `via` rule, in one place because both modes obey it: `innerText` respects the
    // rendering, and a single-page app that only reveals its body while booting hands out
    // nothing from it (YouTube returned 0 characters in a real run, on a page that was
    // full). `textContent` is the fallback, and it also carries what is invisible — hence
    // `via`. `fallbackOf` is where the two modes differ, and it is lazy: the second source
    // is only read when the first one answered nothing, because reading it costs a full
    // string build (and, for the body, a DOM clone) on the tab's main thread.
    // Both sources are normalised before they are compared: a `textContent` of nothing but
    // whitespace does not count, or `via` would name a source that delivered no text.
    function textOf(element, fallbackOf) {
      const visible = normalise(element === null ? "" : String(element.innerText ?? ""));
      if (visible !== "") return { text: visible, via: "innerText" };
      const content = normalise(element === null ? "" : String(fallbackOf(element) ?? ""));
      // Two empty sources are no reason to name the second one.
      return { text: content, via: content === "" ? "innerText" : "textContent" };
    }

    // The whole body still carries its inline JavaScript, so its `textContent` is read
    // from a stripped copy: on YouTube the bootstrap filled the whole 20 000 characters
    // with `ytcsi.tick` calls, and reading the body itself would answer script.
    function strippedTextContentOf(element) {
      return withoutNonTextElements(element).textContent;
    }
    // The article copy is stripped already — `withoutChrome` drops scripts, styles and
    // the rest of the chrome — so a second clone would change nothing and cost the tab's
    // main thread.
    function ownTextContentOf(element) {
      return element.textContent;
    }

    // The cleanup of the chosen root (spec 23): the page chrome inside it. `nav`, `header`,
    // `footer`, `aside` and `form` are chrome wherever they sit — and so is the *footer
    // family*, because plenty of sites build their footer from `<div>`s (measured on
    // Wikipedia: the "Datenschutz" links sat in `div`s that carry `footer` in the class,
    // and fifteen of them reached the article text). The same holds for anything whose
    // id, class or label looks like a cookie or consent banner. A block list, not a
    // whitelist: a banner that names none of those words stays — guessing "this looks
    // like consent" from the text would be worse than leaving it in.
    // The selector is a literal in this function and not a module constant: this op is
    // one of the page functions the snippets used to carry, and a local literal keeps it
    // readable on its own. The quoting is mandatory: the attribute selectors carry the
    // ` i` flag.
    function withoutChrome(root) {
      const CHROME_SELECTOR =
        "nav, header, footer, aside, form, script, style, noscript, iframe, " +
        '[role="contentinfo" i], [class*="footer" i], [id*="footer" i], ' +
        '[id*="cookie" i], [class*="cookie" i], [aria-label*="cookie" i], ' +
        '[id*="consent" i], [class*="consent" i], [aria-label*="consent" i]';
      // On a copy, like the non-text stripping above: removing the banner from the
      // operator's page would be a write, and a read must not change what it reads.
      const copy = root.cloneNode(true);
      copy.querySelectorAll(CHROME_SELECTOR).forEach((element) => element.remove());
      return copy;
    }

    // The one text measurement of the selection: `innerText`, normalised, so no two
    // stages can disagree about how long a block is.
    function textCharsIn(element) {
      return normalise(String(element.innerText ?? "")).length;
    }

    // The descent both stages share, and the reason it is one implementation: stage two
    // needed it first, stage one needs it for the same shape one level up. A container
    // that merely *wraps* the article beats the article at this score nearly always: text
    // amount and paragraph count both grow with the subtree, and the link damping can
    // only shrink the product. Measured on `body > div.seite > [div.menue,
    // div.bericht]`, the wrapper won and the navigation came along. And a semantic root
    // is no proof of a clean article either: Wikipedia has no `<article>`, so `main`
    // hits, and `main` carries the page footer (78 794 characters, "Datenschutz"
    // fifteen times).
    // So the best candidate is only the entry point: while a descendant still holds most
    // of it, the article is further in and the ancestor is the page around it. Below 1 on
    // purpose — a wrapper's heading and byline are no reason to hand back the whole page,
    // and a descendant that keeps 80 % is not the wrapper's equal, it is its content.
    const INNER_BLOCK_RATIO = 0.8;
    function closestInnerCandidate(outer, candidates) {
      let inner = null;
      for (const candidate of candidates) {
        if (candidate.element === outer.element) continue;
        // `contains` and not a parent chain: the page realm has no other way to ask, and
        // it is the one DOM method that answers exactly this question.
        if (!outer.element.contains(candidate.element)) continue;
        if (candidate.score < outer.score * INNER_BLOCK_RATIO) continue;
        // The best of the close ones, so a sidebar next to the article cannot pull the
        // descent sideways into itself.
        if (inner !== null && candidate.score <= inner.score) continue;
        inner = candidate;
      }
      return inner;
    }
    function innermostOf(candidate, candidates) {
      let current = candidate;
      for (;;) {
        const inner = closestInnerCandidate(current, candidates);
        // Every step goes strictly deeper (`closestInnerCandidate` skips the element it
        // was given), so the loop ends at the innermost block that keeps up.
        if (inner === null) return current;
        current = inner;
      }
    }

    // The blocks the descent may enter: `div` and `section` are the generic containers a
    // page puts around a body of text. Anything narrower than that (`<p>`, a table cell)
    // *is* text, and a root made of it would be a paragraph, not an article.
    function textBlocksIn(root) {
      const blocks = [];
      for (const element of root.querySelectorAll("div, section")) {
        blocks.push({ element, score: textCharsIn(element) });
      }
      return blocks;
    }

    // Stage one of the selection (spec 23): the semantic roots, in the order the
    // contract names them, and with the selector that hit as the label — the label is
    // what the caller reads in `root`. The threshold is what makes this a *selection*
    // rather than a lookup: taking the first element that merely exists would turn a
    // page's 40-character `main` teaser into "the article". A candidate that is too
    // short is passed over, so the next selector still gets its turn.
    // The label keeps naming the selector that hit even after the descent: it answers
    // "which rule found this", and the descent belongs to that rule, not to a second one.
    // The descent scores by text length and not by `densityScoreOf`, because the rule is
    // already decided here — a paragraph-heavy sidebar inside `main` must not outrank the
    // content block this stage was after.
    const ARTICLE_ROOT_SELECTORS = [
      ["article", "article"],
      ["main", "main"],
      ['[role="main"]', '[role="main"]'],
      ["#content", "#content"],
      ["#main", "#main"],
    ];
    function articleRoot(minimumChars) {
      for (const [selector, label] of ARTICLE_ROOT_SELECTORS) {
        const element = document.querySelector(selector);
        if (element === null) continue;
        const textChars = textCharsIn(element);
        if (textChars < minimumChars) continue;
        const innermost = innermostOf({ element, score: textChars }, textBlocksIn(element));
        return { element: innermost.element, label };
      }
      return null;
    }

    // Stage two (spec 23): no semantic root was long enough, so the densest block wins.
    // Three signals, multiplied, because each one alone is fooled: the raw text length
    // crowns a sidebar of link labels, the paragraph count crowns a list of teasers,
    // and the link density alone crowns one short paragraph. The formula is not the
    // contract — the winner is, and `root: "density"` tells the caller it was a guess.
    function linkCharsIn(element) {
      let sum = 0;
      // A loop, not `reduce`: `querySelectorAll` answers a `NodeList` in the page.
      element.querySelectorAll("a").forEach((link) => {
        sum += textCharsIn(link);
      });
      return sum;
    }
    function densityScoreOf(element, textChars) {
      const linkDensity = textChars === 0 ? 0 : Math.min(1, linkCharsIn(element) / textChars);
      const paragraphs = element.querySelectorAll("p").length;
      // `1 +` and not the bare count: a block of prose without any `<p>` (a news site
      // that wraps sentences in `<br>`) is still a candidate, it just ranks below one
      // that has paragraphs.
      return textChars * (1 - linkDensity) * (1 + paragraphs);
    }
    function densityRoot(minimumChars) {
      const candidates = [];
      for (const element of document.querySelectorAll("div, section")) {
        const textChars = textCharsIn(element);
        // The same threshold as stage one, so the two stages cannot disagree about what
        // "long enough to be an article" means.
        if (textChars < minimumChars) continue;
        candidates.push({ element, label: "density", score: densityScoreOf(element, textChars) });
      }
      let best = null;
      for (const candidate of candidates) {
        // Strictly greater, so a tie keeps the earlier candidate: document order is a
        // stable answer. The outermost of two ties is then peeled back to the inner one
        // by the descent below.
        if (best !== null && candidate.score <= best.score) continue;
        best = candidate;
      }
      return best === null ? null : innermostOf(best, candidates);
    }

    const body = document.body;
    // The selection, and the one place the two modes differ: `null` means "read the
    // body" — either because the caller asked for the whole page or because no stage
    // found something worth calling an article. The second case is not an error: it is
    // the honest fallback, and the answer below says so out loud.
    const chosen = mode === "article" ? (articleRoot(minChars) ?? densityRoot(minChars)) : null;
    // The cleanup of stage three can empty a root completely — an `<article>` that held
    // nothing but its `<nav>`. That is the very same "nothing worth reading" the two
    // selection stages answer with, so it gets the same fallback: an empty article that
    // still claims a root would be the most dishonest answer of all.
    const article = chosen === null ? null : textOf(withoutChrome(chosen.element), ownTextContentOf);
    const foundArticle = article !== null && article.text !== "";
    // The fallback reads the body *uncleaned*: `fellBack: true` means "the whole page",
    // chrome included, and stripping the navigation here would turn the honest fallback
    // into a second, quieter selection.
    const answer = foundArticle ? article : textOf(body, strippedTextContentOf);
    const text = answer.text;
    const via = answer.via;
    // `offset` counts characters of the *normalised* text, so it is applied here and
    // nowhere else: a caller that normalised differently is the one case this cannot
    // serve, and that is why the spec says so out loud.
    const totalChars = text.length;
    const from = offset;
    // A window that starts behind the end is refused, not capped to nothing: "empty"
    // and "you asked for a place that does not exist" are two different answers, and
    // only the second can carry the length the caller needs to correct itself.
    // The code is spelled out rather than taken from a module constant of `bridge.js`:
    // the two files are on opposite sides of the channel, and the page's word for this
    // answer is fixed here. Exactly *at* the end stays valid — that is the halt of a
    // paging loop, one character further is the mistake.
    if (offset > totalChars) {
      return { outcome: "offset_out_of_range", offset, totalChars, ...frameFieldsOf() };
    }
    const slice = text.slice(from, from + maxChars);
    return {
      // From the DOM, not from the tab object: after a redirect started by script
      // the tab is the less accurate source of both.
      url: String(location.href).slice(0, urlLimit),
      title: String(document.title).slice(0, titleLimit),
      text: slice,
      // Passed through, not recomputed on the other side: this realm is the only one
      // that knows the whole text, and re-deriving the three numbers from `slice`
      // would turn "more text after this" into "the answer was short".
      offset: from,
      chars: slice.length,
      totalChars,
      // Not `totalChars > maxChars`: that would report "more to come" for a window
      // that already ends *at* the text's end, and the paging loop of a caller would
      // never terminate. `offset + chars` is exactly where the next read starts.
      truncated: from + slice.length < totalChars,
      via,
      mode,
      // The text is either the chosen root's (article mode that found one) or the whole
      // page's — `root: null` with `fellBack: true` says which, so the caller does not
      // have to compare lengths to find out what it got.
      ...(mode === "article"
        ? { root: foundArticle ? chosen.label : null, fellBack: !foundArticle }
        : {}),
      ...frameFieldsOf(),
    };
  }

  /* ---------------------------------------------------------------- settle */

  /**
   * Waits, inside the page, until the DOM has been quiet for `quietWindowMs` — or
   * gives up at `deadlineMs` and says so.
   *
   * A page that mutates forever is not an error: the deadline answers `settled: false`
   * and the read happens anyway — a half-loaded page read honestly beats a call that
   * hangs.
   *
   * A page without `MutationObserver`, or one that refuses to be observed, cannot be
   * watched at all. That is not a failure of the read either: the same "no statement
   * about quiet" pair comes back and the read goes ahead.
   */
  async function settlePageSource(quietWindowMs, deadlineMs, want) {
    // The frame filter of spec 24, and the first statement on purpose: a frame that is
    // not meant does nothing at all — no observer, no timer, no wait. It only answers the
    // marker, because a frame that said `not_the_frame` is dropped by content and never
    // needs an address.
    if (typeof want === "string" && !String(location.href).toLowerCase().includes(want)) {
      return { outcome: "not_the_frame" };
    }
    // The address of a frame that *did* answer, for exactly the reason `readPageSource`
    // attaches it: the shared `frameTargetOf` builds the `frame_ambiguous` candidates out
    // of this field. Since spec 26 lets this very wait be the injection that raises that
    // error, a href-less answer here would turn the advice into "null, null".
    function frameFieldsOf() {
      return typeof want === "string" ? { href: String(location.href) } : {};
    }
    const start = Date.now();
    return new Promise((resolve) => {
      let quietTimer = null;
      let deadlineTimer = null;
      let observer = null;

      function finish(settled) {
        if (quietTimer !== null) clearTimeout(quietTimer);
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
        quietTimer = null;
        deadlineTimer = null;
        // Nothing keeps watching after the answer: a leftover observer would hold on
        // to the document of a wait nobody reads any more.
        if (observer !== null) observer.disconnect();
        observer = null;
        resolve({ settled, waitedMs: Math.round(Date.now() - start), ...frameFieldsOf() });
      }

      try {
        observer = new MutationObserver(() => {
          // Every mutation restarts the quiet window. The deadline keeps running —
          // that is the whole point of having one.
          if (quietTimer !== null) clearTimeout(quietTimer);
          quietTimer = setTimeout(() => finish(true), quietWindowMs);
        });
        observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      } catch {
        // No `disconnect()` here on purpose: a constructor that threw holds no
        // registration, and an `observe()` that threw registered nothing.
        resolve({ settled: false, waitedMs: 0, ...frameFieldsOf() });
        return;
      }

      quietTimer = setTimeout(() => finish(true), quietWindowMs);
      deadlineTimer = setTimeout(() => finish(false), deadlineMs);
    });
  }

  /* ----------------------------------------------------------------- click */

  /**
   * The click itself, inside the page.
   *
   * Synchronous on purpose: the 300 ms wait belongs to the background, and this op is
   * answered the moment the click was dispatched. `args` is the only thing that crossed
   * the channel — `selector` plus the frame filter, nothing else.
   */
  function clickPageSource(selector, want) {
    // The frame filter of spec 26, and the first statement on purpose: a frame that is not
    // meant answers the marker and does nothing else — no query, no description, no click.
    // `href` is what `frameTargetOf`'s candidates are made of, and this realm is the only
    // one that knows it.
    if (!isAddressedFrame(want)) {
      return { outcome: "not_the_frame", href: String(location.href) };
    }
    // The address of a frame that *did* answer, for exactly the reason `readPageSource`
    // attaches it: `frameTargetOf` builds the `frame_ambiguous` candidates out of this
    // field. Two frames that both match the substring both answer here, so an answer
    // without a href would turn the advice into "null, null".
    function frameFieldsOf() {
      return typeof want === "string" ? { href: String(location.href) } : {};
    }
    let element;
    try {
      element = document.querySelector(selector);
    } catch (error) {
      // `querySelector` throws a `SyntaxError` for a selector it cannot parse — the
      // empty string included. Nothing was clicked.
      return { outcome: "invalid_selector", ...frameFieldsOf() };
    }
    if (element === null || element === undefined) return { outcome: "no_match", ...frameFieldsOf() };
    if (!isVisible(element) || element.disabled === true) {
      return { outcome: "not_clickable", ...frameFieldsOf() };
    }

    // Described *before* the click: a re-render may drop `id` and `class` the
    // moment the click runs, and the answer would describe nothing.
    const clicked = describeElement(element);
    element.click();
    return { outcome: "clicked", clicked, ...frameFieldsOf() };
  }

  /* ------------------------------------------------------------------ type */

  /**
   * The typing itself, inside the page.
   *
   * One argument object instead of four: one boundary to read. The order of the checks
   * is the order of the spec — an unknown selector, a missing element, a field that
   * cannot be written, the password lock — and only then a description and the write.
   */
  function typePageSource(request, want) {
    // The frame filter of spec 26, and the first statement on purpose: a frame that is not
    // meant answers the marker and does nothing else — no field looked up, no text
    // written, no Enter pressed. `href` is what `frameTargetOf`'s candidates are made of,
    // and this realm is the only one that knows it.
    if (!isAddressedFrame(want)) {
      return { outcome: "not_the_frame", href: String(location.href) };
    }
    // The address of a frame that *did* answer — the field `frameTargetOf` builds its
    // `frame_ambiguous` candidates from, attached for the same reason `readPageSource`
    // attaches it.
    function frameFieldsOf() {
      return typeof want === "string" ? { href: String(location.href) } : {};
    }
    // A page-side literal, not a constant of this module: only what this function
    // closes over survives the trip into the page.
    const TYPEABLE_INPUT_TYPES = ["text", "search", "email", "url", "tel", "password", "number"];

    /** `""` for an input without a `type` attribute, which a browser reads as text. */
    function typeAttributeOf(element) {
      return typeof element.type === "string" ? element.type.trim().toLowerCase() : "";
    }

    /**
     * Only fields a human could type into.
     *
     * The positive list of `type` values is the point: without it the setter would
     * write into a checkbox and report success, while the non-goals of the spec say
     * exactly that it must not. `hidden` and `file` fall out of that list as well;
     * `disabled` and `readOnly` are separate properties and are checked separately.
     */
    function isTypeable(element) {
      if (!isVisible(element)) return false;
      if (element.disabled === true || element.readOnly === true) return false;
      if (element.isContentEditable === true) return true;
      const tag = String(element.tagName).toUpperCase();
      if (tag === "TEXTAREA") return true;
      if (tag !== "INPUT") return false;
      const type = typeAttributeOf(element);
      return type === "" || TYPEABLE_INPUT_TYPES.includes(type);
    }

    /**
     * `beforeinput` or `input`, shaped the way a browser sends it.
     *
     * `InputEvent` is what a page with a typing listener reads — `inputType` and
     * `data` tell typing from pasting or deleting. A realm without that constructor
     * still gets a bubbling `Event`; the two fields are then absent, which costs a
     * nicety and not the write. `false` when a handler cancelled the event, which
     * for `beforeinput` is the page refusing the input.
     */
    function dispatchEditEvent(element, type, text) {
      const EventType = typeof InputEvent === "function" ? InputEvent : Event;
      const event = new EventType(type, {
        bubbles: true,
        cancelable: type === "beforeinput",
        inputType: "insertText",
        data: text,
      });
      return element.dispatchEvent(event) !== false;
    }

    /**
     * The setter that the framework listens to, or `null` where the realm has none.
     *
     * Split from the write so that a field nothing can be written into is refused
     * *before* the page is told that text is arriving — announcing an input and then
     * not delivering it is a lie a page may react to.
     */
    function nativeValueSetter(element) {
      const prototype =
        String(element.tagName).toUpperCase() === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor === undefined || typeof descriptor.set !== "function") return null;
      return descriptor.set;
    }

    /** Whether this element can be written at all: editable elements always, fields only via the setter. */
    function isWritable(element) {
      return element.isContentEditable === true || nativeValueSetter(element) !== null;
    }

    /**
     * The value itself, without a single event — the one place a write happens.
     *
     * The field goes through the prototype's value setter, because that is the value
     * a framework listens to. A plain `element.value = …` only reaches the
     * framework's own copy of the value (the React shadow) and no framework ever
     * sees a change — the exact bug this detour exists for. `false` when there is no
     * such setter: no silent fallback, which would make every typing case pass
     * without one.
     */
    function writeValue(element, text) {
      if (element.isContentEditable === true) {
        element.textContent = text;
        return true;
      }
      const setter = nativeValueSetter(element);
      if (setter === null) return false;
      setter.call(element, text);
      return true;
    }

    /**
     * What the field shows right now.
     *
     * Not a detail of the setter but the question the catch-up below asks: a page
     * that keeps the text in its own state puts that state back over the write, and
     * only this read can tell whether it did.
     */
    function shownValue(element) {
      return element.isContentEditable === true ? element.textContent : element.value;
    }

    /**
     * The value plus the events a framework listens to.
     *
     * `change` only for a field: an editable `div` has no such event, and faking one
     * would make a page's commit handler run on something that cannot commit.
     */
    function setNativeValue(element, text) {
      if (!writeValue(element, text)) return false;
      dispatchEditEvent(element, "input", text);
      if (element.isContentEditable !== true) {
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    }

    /**
     * The countermeasure for controlled fields, in the page's next task.
     *
     * A page that keeps the value in its own state (React and friends) writes that
     * state back over our write in the `input` handler: the submit still carries the
     * text, but the field shows nothing — a search field that looks empty while the
     * results arrive. So we look again once and write a second time, and only when
     * the page really took the value back: a second `input` on an untouched field
     * would restart the page's handlers for nothing.
     */
    function reassertTextOnNextTask(element, text) {
      setTimeout(() => {
        if (shownValue(element) === text) return;
        if (!writeValue(element, text)) return;
        dispatchEditEvent(element, "input", text);
      }, 0);
    }

    /**
     * The whole write, in the order the spec pins it.
     *
     * Returns the refusal code, or `null` when the text arrived. The focus comes
     * first because a field without focus behaves differently and some pages render
     * their value only while focused; `beforeinput` comes before the value because
     * some pages listen to it instead of `input`. A cancelled `beforeinput` is a page
     * refusing the input — the value must not be smuggled in behind its back.
     */
    function writeTypedText(element, text) {
      if (!isWritable(element)) return "type_failed";
      element.focus();
      if (!dispatchEditEvent(element, "beforeinput", text)) return "not_typeable";
      if (!setNativeValue(element, text)) return "type_failed";
      reassertTextOnNextTask(element, text);
      return null;
    }

    /**
     * Exactly one Enter — the only key press this increment knows — and the
     * implicit form submit a synthetic Enter does not trigger on its own.
     *
     * `dispatchEvent` answers `false` when a handler called `preventDefault`: a
     * page that handled the Enter itself must not get a second submit on top.
     * Returns whether Enter was pressed at all, which is what `submitted` reports —
     * not whether the page reacted to it.
     */
    function pressEnter(element, submit) {
      if (submit !== true) return false;
      const enterEvent = (type) => new KeyboardEvent(type, { key: "Enter", bubbles: true, cancelable: true });
      const cancelled = element.dispatchEvent(enterEvent("keydown")) === false;
      element.dispatchEvent(enterEvent("keypress"));
      element.dispatchEvent(enterEvent("keyup"));
      const form = element.form;
      if (!cancelled && form && typeof form.requestSubmit === "function") {
        // A page may replace `requestSubmit` with something that throws. The write
        // and the Enter already happened, so a throw here must not travel out as
        // `not_readable` — that would report a failed read for a page this call
        // just typed into. `submitted: true` stays true, because it reports the
        // Enter, not the page's reaction to it.
        try {
          form.requestSubmit();
        } catch {
          // Intentionally swallowed: see above, the typing already succeeded.
        }
      }
      return true;
    }

    let element;
    try {
      element = document.querySelector(request.selector);
    } catch (error) {
      // An unparsable selector — the empty string included — is the caller's
      // mistake, and nothing was written anywhere.
      return { outcome: "invalid_selector", ...frameFieldsOf() };
    }
    if (element === null || element === undefined) return { outcome: "no_match", ...frameFieldsOf() };
    if (!isTypeable(element)) return { outcome: "not_typeable", ...frameFieldsOf() };
    if (typeAttributeOf(element) === "password" && request.allowPasswordFields !== true) {
      return { outcome: "password_not_allowed", ...frameFieldsOf() };
    }

    // Described *before* the write: an `input` handler may drop `id` and `class`,
    // and the answer would then describe something that no longer exists.
    const typed = describeElement(element);
    const refusal = writeTypedText(element, request.text);
    if (refusal !== null) return { outcome: refusal, ...frameFieldsOf() };
    return { outcome: "typed", typed, submitted: pressEnter(element, request.submit), ...frameFieldsOf() };
  }

  /* ------------------------------------------------------------------- ops */

  /**
   * What `op` can be asked for, by name.
   *
   * Closed on purpose: an op nobody registered is answered as such instead of being
   * guessed at, and a caller with a typo hears about it in the answer rather than in a
   * silent frame.
   *
   * Each op unpacks its own argument object and calls the page function with the
   * positional arguments that function has always taken — the bodies are the ones the
   * snippets carried, unchanged. `inventory` takes no argument: it is the self-report
   * the frame inventory is built from (spec 45, `## Die Naht`).
   */
  const OPS = Object.freeze({
    inventory: () => ({ href: location.href, top: window.top === window }),
    read: (args) =>
      readPageSource(
        args.offset,
        args.maxChars,
        args.mode,
        args.minChars,
        args.urlLimit,
        args.titleLimit,
        args.want ?? null,
      ),
    settle: (args) => settlePageSource(args.quietWindowMs, args.deadlineMs, args.want ?? null),
    click: (args) => clickPageSource(args.selector, args.want ?? null),
    type: (args) => typePageSource(args.request, args.want ?? null),
  });

  /**
   * The answer to one message, or `null` when the message is not a call of ours.
   *
   * A call is recognised by its integer `callId`, not by a marker field: the bridge page
   * is the only sender in this realm, and an earlier answer carries the same id as the
   * call it belongs to. Anything else stays unanswered — a listener that answered every
   * message would drown in its own echoes.
   *
   * `async` because two ops answer a promise, not a value: `settle` waits for the page
   * to be quiet, and a promise cannot cross the channel. The `await` also puts a
   * rejection where it belongs — into the `catch` below, not into an unhandled chain.
   */
  async function answerOf(message) {
    if (message === null || typeof message !== "object") return null;
    if (!Number.isInteger(message.callId)) return null;
    const op = OPS[message.op];
    if (op === undefined) {
      return { callId: message.callId, ok: false, error: `unknown op: ${String(message.op)}` };
    }
    try {
      return { callId: message.callId, ok: true, value: await op(message.args ?? {}) };
    } catch (error) {
      // An op that throws is the page's complaint, not a protocol error: pass it on
      // verbatim instead of dressing it in a code this side never decided.
      return { callId: message.callId, ok: false, error: String(error?.message ?? error) };
    }
  }

  browser.runtime.onMessage.addListener((message) => {
    // Back as its own message, not as this listener's return value: the bridge page knows
    // how many frames it injected into but not their ids, so it broadcasts and every
    // frame has to speak up on its own — a return value carries one answer at most.
    void answerOf(message).then((answer) => {
      if (answer === null) return undefined;
      return browser.runtime.sendMessage(answer).catch(() => {
        // Nobody is listening: the bridge page is gone, and there is no answer to deliver.
      });
    });
    // No response on this channel either — the answer travels as its own message, and a
    // second copy here would answer the same `callId` twice.
    return undefined;
  });
})();
