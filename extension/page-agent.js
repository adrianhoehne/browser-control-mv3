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
   * Whether the rectangle overlaps the visible area of this realm.
   *
   * The area is the one of the frame the op runs in: `window.innerWidth` inside an
   * iframe is the iframe's own box, not the main frame's (spec 56, `## Ziel`, 5).
   * `isVisible` says whether an element is rendered at all; this says whether it is
   * anywhere a reader could see — the Amazon keyboard-shortcut menu at `x = -9966`
   * passes the first check and fails this one.
   *
   * Only `click` uses it. `type` has the same blind spot on purpose: typing into a
   * field nobody can see is its own increment (spec 56, `## Non-goals`).
   */
  function intersectsViewport(rect) {
    return (
      rect.x + rect.width > 0 &&
      rect.y + rect.height > 0 &&
      rect.x < window.innerWidth &&
      rect.y < window.innerHeight
    );
  }

  /**
   * Brings an element into the visible area — if it is not there already.
   *
   * Answers whether it scrolled, which is the same as "it was outside before": the
   * caller reports that as `scrolled`, and measures again afterwards. A target under
   * the fold is an ordinary case, so it is scrolled to and clicked; one that stays
   * outside is refused with its own code instead of being clicked blind.
   */
  function scrollIntoViewIfNeeded(element) {
    if (intersectsViewport(element.getBoundingClientRect())) return false;
    // `behavior: "instant"` is mandatory, not taste: without it the computed
    // `scroll-behavior` of the page applies, and on `html{scroll-behavior:smooth}` the
    // scroll animates past the measurement — the second measurement would read the old
    // position and refuse a target under the fold (spec 56, `## Ziel`, 1).
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
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
   *
   * The order is the contract: `isVisible` and `disabled` first (the three old reasons,
   * `not_clickable`), then the position. A target outside the visible area is scrolled
   * to the centre and measured again; one that stays outside is refused with its own
   * code, and the answer of a click that did happen says whether it had to scroll.
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

    // The position, and only *after* the two refusals above: an element without area
    // is `not_clickable`, it is not something to scroll to (spec 56, criterion 4).
    const scrolled = scrollIntoViewIfNeeded(element);
    // Measured again, because the scroll may or may not have helped: a target that
    // stays outside after it would be clicked blind, and "clicked" would be the lie
    // this refusal exists to avoid.
    if (!intersectsViewport(element.getBoundingClientRect())) {
      return { outcome: "offscreen_after_scroll", ...frameFieldsOf() };
    }

    // Described *before* the click: a re-render may drop `id` and `class` the
    // moment the click runs, and the answer would describe nothing.
    const clicked = describeElement(element);
    element.click();
    return { outcome: "clicked", clicked, scrolled, ...frameFieldsOf() };
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

  /* -------------------------------------------------------------- inspect */

  /**
   * The query itself, inside the page.
   *
   * Synchronous, and every limit arrives as an argument: this op answers one request,
   * and a constant of this module would be a second place to keep the bridge's
   * `INSPECT_CANDIDATE_LIMIT` up to date. Two costs are split on purpose — `innerText`
   * (layout) runs once per examined candidate, which the candidate cap bounds, while the
   * selector builder runs only for what is delivered, which `limit` bounds.
   */
  function inspectPageSource(request, want) {
    // The frame filter of spec 25, and the first statement on purpose: a frame that is
    // not meant answers the marker and does nothing else — no query, no text search, no
    // selector built. `href` is what `frameTargetOf`'s candidates are made of, and this
    // realm is the only one that knows it.
    if (!isAddressedFrame(want)) {
      return { outcome: "not_the_frame", href: String(location.href) };
    }
    // Nested on purpose: only what this function closes over travels to the page.
    function cappedString(raw, limit) {
      if (typeof raw !== "string") return null;
      // Newlines become spaces *before* the cut: an element's text is a line in the
      // answer, not a paragraph.
      return raw.replace(/\r\n?|\n/g, " ").slice(0, limit);
    }

    /** `innerText` of a real element is a string; a stub may be less polite. */
    function textOf(element) {
      const raw = element.innerText;
      return typeof raw === "string" ? raw : "";
    }

    // `getAttribute`, never `className`: an SVG element carries an object there and
    // the field would be `{}`.
    function classesOf(element) {
      const className = element.getAttribute("class");
      if (typeof className !== "string") return [];
      return className
        .split(/\s+/)
        .filter((name) => name !== "")
        .slice(0, request.classLimit);
    }

    // `Math.round` per value, pixels, origin in the top left corner of the viewport:
    // where the element is *now*, not where the document thinks it is.
    function rectOf(element) {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }

    /**
     * An identity hook as the contract wants it: the string, or `null` when absent.
     *
     * Both `Element.id` and `HTMLAnchorElement.href` answer `""` when the markup has
     * none — never `null` — so a bare type check would hand out an empty string and
     * make "has an id" true for every element on the page. `describeElement` reads an
     * empty id as absent for exactly this reason.
     */
    function identityOf(value) {
      return typeof value === "string" && value !== "" ? value : null;
    }

    /** One delivered element: the eleven documented fields, and nothing else. */
    function described(candidate, index) {
      // An id and a link are properties, not attributes: `getAttribute("href")`
      // answers the raw markup, while the property is what a caller wants to open.
      const id = identityOf(candidate.id);
      const href = identityOf(candidate.href);
      return {
        // The position in *this* array — not a handle. `selector` is the handle, and
        // the one `click` and `type` accept.
        index,
        selector: selectorForElement(candidate, request.textLimit, request.classLimit),
        tag: String(candidate.tagName).toLowerCase(),
        id: cappedString(id, request.textLimit),
        classes: classesOf(candidate),
        text: cappedString(textOf(candidate), request.textLimit),
        href: cappedString(href, request.textLimit),
        ariaLabel: cappedString(candidate.getAttribute("aria-label"), request.textLimit),
        visible: isVisible(candidate),
        // `=== true`, not truthiness: an attribute or a stub may say `"true"`.
        disabled: candidate.disabled === true,
        rect: rectOf(candidate),
      };
    }

    const body = document.body;
    let candidates;
    try {
      // A selector means "these elements", a text search means "every element" — and
      // only the selector path can fail here, because `querySelectorAll` throws a
      // `SyntaxError` for anything it cannot parse, the empty string included.
      candidates =
        request.selector !== null
          ? Array.from(document.querySelectorAll(request.selector))
          : body === null
            ? []
            : Array.from(body.querySelectorAll("*"));
    } catch (error) {
      return { outcome: "invalid_selector" };
    }

    // The cap is reached when there were more candidates than it allows to examine.
    // `count` then stops being the truth and becomes a lower bound.
    let truncated = candidates.length > request.candidateLimit;
    const examined = Math.min(candidates.length, request.candidateLimit);
    const needle = request.text === null ? null : request.text.toLowerCase();
    const elements = [];
    let count = 0;

    for (let position = 0; position < examined; position += 1) {
      const candidate = candidates[position];
      // Visibility before the text filter: `count` is the number of hits after the
      // visibility filter, so an invisible element must not even be counted.
      if (!request.includeHidden && !isVisible(candidate)) continue;
      // `innerText` is the authoritative comparison, and no `textContent` prefilter
      // sits in front of it: `innerText` folds whitespace and skips what is invisible,
      // so a substring test on the tree text would silently drop hits. It would also
      // break `text: ""`, which matches everything on purpose.
      if (needle !== null && textOf(candidate).toLowerCase().indexOf(needle) === -1) continue;
      count += 1;
      // The expensive part runs only for what is delivered: `count` may be 5000 while
      // `limit` asks for two.
      if (elements.length < request.limit) elements.push(described(candidate, elements.length));
    }

    return {
      outcome: "ok",
      // From the DOM, not from the tab object: after a script-driven redirect the tab
      // is the less accurate source of both.
      url: String(location.href),
      title: String(document.title),
      count,
      truncated: truncated || count > elements.length,
      elements,
      // The hit's own address, for the `frame_ambiguous` candidates of the extension.
      // Dropped by `inspectResultOf` — the wire result is a contract of its own.
      href: String(location.href),
    };
  }

  /**
   * The `>>>` jumps of a selector, or `null` when one of the segments is empty.
   *
   * A function of its own, and it closes over nothing: it reads its argument and
   * answers `null` or a list, so both callers below can rely on it being pure.
   *
   * Counting quotes is the whole parser. `[title="a>>>b"]` is one selector and
   * `a >>> b` is two; whether a segment is a *usable* selector is not decided here — the
   * whitelist `isSimpleSelector` answers that.
   *
   * Each segment is trimmed exactly once, because that trimming is what the whitelist
   * sees: `my-card >>> button`, the spelling of the whole spec, has to pass with its
   * spaces around the jump. `null` instead of a throw, because a thrown op would reach
   * the caller as `not_readable` and not as the refusal it is.
   */
  function splitPiercingSelector(selector) {
    const segments = [];
    let segment = "";
    let quote = "";
    for (let index = 0; index < selector.length; index += 1) {
      const character = selector[index];
      if (quote !== "") {
        segment += character;
        // An escaped character never closes the quote — `[title="a\">>>b"]` stays one
        // selector, and what the escape means is the page's business, not ours.
        if (character === "\\" && index + 1 < selector.length) {
          index += 1;
          segment += selector[index];
        } else if (character === quote) {
          quote = "";
        }
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        segment += character;
        continue;
      }
      if (character === ">" && selector[index + 1] === ">" && selector[index + 2] === ">") {
        segments.push(segment.trim());
        segment = "";
        index += 2;
        continue;
      }
      segment += character;
    }
    segments.push(segment.trim());
    // `>>> b`, `a >>> ` and `a >>> >>> b` are the same mistake: a jump needs a selector on
    // both of its sides.
    return segments.indexOf("") === -1 ? segments : null;
  }

  /**
   * Whether one segment of a `>>>` chain is a selector the jump may carry.
   *
   * The whitelist is the alternative to a second CSS parser (spec 27, `## Ziel`): a type,
   * `#id`, `.class`, `[attr]`, `[attr="value"]`, `[attr='value']` and `:nth-of-type(n)`,
   * in any order after an optional type — and nothing else. The loop has to consume the
   * segment completely, so a descendant combinator, a group, a pseudo-element or a
   * universal selector is refused instead of being read as a prefix of something valid.
   *
   * No closure, like `splitPiercingSelector`: the patterns are built per call. They are
   * six lines of local knowledge, and a shared list would be one more name to keep.
   */
  function isSimpleSelector(segment) {
    const parts = [
      /^#[A-Za-z0-9_-]+/,
      /^\.[A-Za-z0-9_-]+/,
      /^\[[A-Za-z_][A-Za-z0-9_-]*\]/,
      /^\[[A-Za-z_][A-Za-z0-9_-]*="[^"]*"\]/,
      /^\[[A-Za-z_][A-Za-z0-9_-]*='[^']*'\]/,
      /^:nth-of-type\([0-9]+\)/,
    ];
    const type = /^[A-Za-z][A-Za-z0-9_-]*/.exec(segment);
    let remaining = type === null ? segment : segment.slice(type[0].length);
    // A type and nothing else is a simple selector; the empty segment is not.
    if (remaining === "") return type !== null;
    while (remaining !== "") {
      const part = parts.map((pattern) => pattern.exec(remaining)).find((match) => match !== null);
      if (part === undefined) return false;
      remaining = remaining.slice(part[0].length);
    }
    return true;
  }

  /**
   * The `>>>` query: it decides *inside the page* what a jump means.
   *
   * A function of its own instead of a branch in `inspectPageSource`: only the page can
   * tell whether a jump lands in a shadow tree, and a `>>>` that never left its quotes
   * is one plain selector. Which of the two runs is `inspectAnswerFor`'s call; this one
   * falls back to the plain query for the one-segment case instead of answering it a
   * second time.
   *
   * The frame filter comes first, exactly as in the plain function: a frame nobody
   * addressed answers the marker and asks nothing — `frameTargetOf` builds its candidates
   * from that `href`.
   */
  function inspectShadowPageSource(request, want) {
    if (!isAddressedFrame(want)) {
      return { outcome: "not_the_frame", href: String(location.href) };
    }
    const segments = splitPiercingSelector(request.selector);
    if (segments === null) return { outcome: "invalid_selector" };
    // A `>>>` that never left its quotes is one plain selector, and the plain query
    // already knows how to answer it — a copy of that query here would drift from it.
    if (segments.length === 1) return inspectPageSource(request, want);
    // Both sides of every jump are one simple selector, and that is decided *before* the
    // first query: the harness matcher throws for what the whitelist refuses, so a search
    // first would be red here and green on a real page — and the refusal would name the
    // wrong reason.
    if (!segments.every((segment) => isSimpleSelector(segment))) {
      return { outcome: "invalid_selector" };
    }

    // The delivery tail of `inspectPageSource`, copied on purpose and not shared: the
    // shadow copy takes the selector as an argument while the plain one builds it, so a
    // shared helper would have to carry both shapes. The two copies are kept honest by a
    // case that compares the delivered field sets of a shadow hit and a document hit —
    // whoever calls that case superfluous should read this comment before deleting it.
    function cappedString(raw, limit) {
      if (typeof raw !== "string") return null;
      // Newlines become spaces *before* the cut: an element's text is a line in the
      // answer, not a paragraph.
      return raw.replace(/\r\n?|\n/g, " ").slice(0, limit);
    }

    /** `innerText` of a real element is a string; a stub may be less polite. */
    function textOf(element) {
      const raw = element.innerText;
      return typeof raw === "string" ? raw : "";
    }

    // `getAttribute`, never `className`: an SVG element carries an object there and
    // the field would be `{}`.
    function classesOf(element) {
      const className = element.getAttribute("class");
      if (typeof className !== "string") return [];
      return className
        .split(/\s+/)
        .filter((name) => name !== "")
        .slice(0, request.classLimit);
    }

    // `Math.round` per value, pixels, origin in the top left corner of the viewport:
    // where the element is *now*, not where the document thinks it is.
    function rectOf(element) {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }

    /**
     * An identity hook as the contract wants it: the string, or `null` when absent.
     *
     * Both `Element.id` and `HTMLAnchorElement.href` answer `""` when the markup has
     * none — never `null` — so a bare type check would hand out an empty string and
     * make "has an id" true for every element on the page.
     */
    function identityOf(value) {
      return typeof value === "string" && value !== "" ? value : null;
    }

    /**
     * One delivered element: the eleven documented fields, and nothing else.
     *
     * The one field this copy takes as an argument instead of computing it is
     * `selector`: in a shadow tree the walk knows the host chain, and the builder of the
     * document tree would hand out a path the document cannot resolve.
     */
    function described(candidate, index, selector) {
      const id = identityOf(candidate.id);
      const href = identityOf(candidate.href);
      return {
        index,
        selector,
        tag: String(candidate.tagName).toLowerCase(),
        id: cappedString(id, request.textLimit),
        classes: classesOf(candidate),
        text: cappedString(textOf(candidate), request.textLimit),
        href: cappedString(href, request.textLimit),
        ariaLabel: cappedString(candidate.getAttribute("aria-label"), request.textLimit),
        visible: isVisible(candidate),
        disabled: candidate.disabled === true,
        rect: rectOf(candidate),
      };
    }

    /** How many hits one stage may hold — endpoints and intermediate steps alike. */
    const cap = request.candidateLimit;

    /**
     * The full selector of one endpoint: its own, with its host chain in front of it.
     *
     * The document case is `selectorForElement`, untouched — a second builder for the
     * document tree would be a second answer to a question that already has one. Only
     * inside a root does the other builder apply, because there the document is the
     * wrong place to check a candidate against. The host's own prefix came from exactly
     * this rule, one jump further up.
     */
    function selectorOf(endpoint) {
      if (endpoint.prefix === "") {
        return selectorForElement(endpoint.element, request.textLimit, request.classLimit);
      }
      const local = shadowSelectorForElement(
        endpoint.element,
        endpoint.root,
        request.textLimit,
        request.classLimit,
      );
      return `${endpoint.prefix} >>> ${local}`;
    }

    let truncated = false;
    let endpoints;
    try {
      // Stage one is the document's own query, exactly as the plain query asks it. The
      // selector passed the whitelist, so this is not expected to throw — the catch is
      // there for the same reason it is there in the plain query, because a page may
      // refuse a string a whitelist thought was fine (`#1abc`).
      const hosts = Array.from(document.querySelectorAll(segments[0]));
      truncated = hosts.length > cap;
      endpoints = hosts.slice(0, cap).map((element) => ({ element, root: document, prefix: "" }));
    } catch (error) {
      return { outcome: "invalid_selector" };
    }

    // One stage per jump: every endpoint of the previous stage is a host, and its open
    // root is asked the next segment. The order is the expansion order — the endpoints
    // of the previous stage in their own order, each root in its own order — which is
    // deterministic and testable; it is not the order of the shadow-including tree.
    for (let stage = 1; stage < segments.length; stage += 1) {
      const level = [];
      // A stage that had to drop a hit stops the walk: `truncated` is set by then, and
      // the hosts nobody reached would only cost a query whose answer is not read.
      let overflowed = false;
      for (const endpoint of endpoints) {
        // A closed root and an element that was never upgraded answer `null` alike: the
        // page cannot see in, this path ends without a hit *and* without an error, and
        // the difference between the two is not ours to invent.
        const shadowRoot = endpoint.element.shadowRoot;
        if (shadowRoot === null || shadowRoot === undefined) continue;
        const prefix = selectorOf(endpoint);
        let found;
        try {
          found = Array.from(shadowRoot.querySelectorAll(segments[stage]));
        } catch (error) {
          // The same refusal as the plain query's: a string the page will not parse is
          // `invalid_selector`, whichever tree it was aimed at. The whitelist makes this
          // unlikely — and "unlikely" is not "never" on somebody else's page.
          return { outcome: "invalid_selector" };
        }
        for (const element of found) {
          if (level.length >= cap) {
            overflowed = true;
            break;
          }
          level.push({ element, root: shadowRoot, prefix });
        }
        if (overflowed) break;
      }
      if (overflowed) truncated = true;
      endpoints = level;
    }

    const needle = request.text === null ? null : request.text.toLowerCase();
    const elements = [];
    let count = 0;

    for (const endpoint of endpoints) {
      const candidate = endpoint.element;
      // The same two filters as the plain query, in the same order: visibility first,
      // because `count` is the number of hits after it.
      if (!request.includeHidden && !isVisible(candidate)) continue;
      if (needle !== null && textOf(candidate).toLowerCase().indexOf(needle) === -1) continue;
      count += 1;
      // The builder runs only for what is delivered — 5000 endpoints may meet a limit
      // of two, and every one of them needs a selector only if it is delivered.
      if (elements.length < request.limit) {
        elements.push(described(candidate, elements.length, selectorOf(endpoint)));
      }
    }

    return {
      outcome: "ok",
      url: String(location.href),
      title: String(document.title),
      count,
      // Two reasons, both "there was more": the caller's `limit` cut the delivery, or a
      // stage hit the cap — and then `count` is a lower bound instead of the truth.
      truncated: truncated || count > elements.length,
      elements,
      href: String(location.href),
    };
  }

  /**
   * One string that finds `element` again — the whole point of `inspect`.
   *
   * A function of its own, because the uniqueness check needs `querySelectorAll` and
   * only the page has one. It closes over nothing: both limits are arguments, so one
   * call cannot inherit the previous one's numbers (`describeElement` states the same
   * rule for itself).
   *
   * The order prefers stable identity hooks over generated class names, and the path
   * comes last. A candidate is accepted only if it finds exactly *this* element:
   * `length === 1` alone would accept a selector that hits a different one, and the
   * caller would click the wrong thing while the answer looked right.
   */
  function selectorForElement(element, valueLimit, classLimit) {
    const tag = String(element.tagName).toLowerCase();

    /**
     * An attribute value as it may stand inside a quoted CSS string, or `null`.
     *
     * A value carrying a `"` is refused instead of escaped: an escaped form the page
     * has to parse is a risk for a name, and the path below always works.
     */
    function quotedValue(name) {
      const value = element.getAttribute(name);
      if (typeof value !== "string" || value === "" || value.indexOf('"') !== -1) return null;
      return value.replace(/\r\n?|\n/g, " ").slice(0, valueLimit);
    }

    /** Is `candidate` a selector that finds this element and nothing else? */
    function isTheOnlyMatch(candidate) {
      try {
        const matches = document.querySelectorAll(candidate);
        return matches.length === 1 && matches[0] === element;
      } catch (error) {
        // A candidate the page cannot parse (`#1abc`, `#a b`) is no candidate. Its own
        // `try`, so one bad string does not cost the next one its chance.
        return false;
      }
    }

    // The same split as `classesOf` in `inspectPageSource` — two copies, no shared
    // helper, and this op is not the place for a third one.
    function classNames() {
      const className = element.getAttribute("class");
      if (typeof className !== "string") return [];
      return className
        .split(/\s+/)
        .filter((name) => name !== "")
        .slice(0, classLimit);
    }

    /** The 1-based position among the siblings that share the tag — what `:nth-of-type` counts. */
    function positionOf(target) {
      const parent = target.parentElement;
      if (parent === null || parent === undefined) return 1;
      const name = String(target.tagName);
      let position = 0;
      for (const sibling of parent.children) {
        if (String(sibling.tagName) === name) position += 1;
        if (sibling === target) break;
      }
      return position;
    }

    /**
     * The last resort: the chain from `<html>` down, one `:nth-of-type` per step.
     *
     * Unique by construction and therefore returned unchecked, which is also why it is
     * never `""`. It is a snapshot: a re-render that moves the element breaks it.
     * `<html>` and `<body>` stay bare — one document, one body, so a position would buy
     * nothing but length.
     */
    function pathOf() {
      const steps = [];
      let current = element;
      while (current !== null && current !== undefined) {
        const name = String(current.tagName).toLowerCase();
        if (name === "html" || name === "body") steps.unshift(name);
        else steps.unshift(`${name}:nth-of-type(${positionOf(current)})`);
        current = current.parentElement;
      }
      return steps.join(" > ");
    }

    if (typeof element.id === "string" && element.id !== "") {
      const candidate = `${tag}#${element.id}`;
      if (isTheOnlyMatch(candidate)) return candidate;
    }

    const testId = quotedValue("data-testid");
    if (testId !== null) {
      const candidate = `[data-testid="${testId}"]`;
      if (isTheOnlyMatch(candidate)) return candidate;
    }

    const label = quotedValue("aria-label");
    if (label !== null) {
      const candidate = `${tag}[aria-label="${label}"]`;
      if (isTheOnlyMatch(candidate)) return candidate;
    }

    const name = quotedValue("name");
    if (name !== null) {
      const candidate = `${tag}[name="${name}"]`;
      if (isTheOnlyMatch(candidate)) return candidate;
    }

    const classes = classNames();
    if (classes.length > 0) {
      const candidate = `${tag}${classes.map((className) => `.${className}`).join("")}`;
      if (isTheOnlyMatch(candidate)) return candidate;
    }

    return pathOf();
  }

  /**
   * `selectorForElement` inside one shadow tree: the same preference, asked of a root.
   *
   * A function of its own instead of a `root` parameter on the first one: `eval` uses
   * that one too, and a signature widened for the shadow path would change every
   * `eval` answer with it. Everything else is that function's reasoning — a candidate
   * has to find exactly *this* element, and a value carrying a `"` is refused instead
   * of escaped.
   *
   * Two things differ, and both come from the tree. Every candidate is checked against
   * `root` instead of the document, because `document.querySelectorAll` never looks into
   * a shadow root — every identity hook there would be silently discarded and the caller
   * would get a path that finds nothing. And the position counts along `parentNode`: a
   * node at the top of a root has no `parentElement`, so the document's `positionOf`
   * would call every same-tag sibling the first, and the returned selector would point
   * at a different element while looking right. It closes over nothing: both limits are
   * arguments.
   */
  function shadowSelectorForElement(element, root, valueLimit, classLimit) {
    const tag = String(element.tagName).toLowerCase();

    /**
     * An attribute value as it may stand inside a quoted CSS string, or `null`.
     *
     * A value carrying a `"` is refused instead of escaped: an escaped form the page has
     * to parse is a risk for a name, and the path below always works.
     */
    function quotedValue(name) {
      const value = element.getAttribute(name);
      if (typeof value !== "string" || value === "" || value.indexOf('"') !== -1) return null;
      return value.replace(/\r\n?|\n/g, " ").slice(0, valueLimit);
    }

    /** Is `candidate` a selector that finds this element in `root` and nothing else? */
    function isTheOnlyMatch(candidate) {
      try {
        const matches = root.querySelectorAll(candidate);
        return matches.length === 1 && matches[0] === element;
      } catch (error) {
        // A candidate the page cannot parse (`#1abc`, `#a b`) is no candidate. Its own
        // `try`, so one bad string does not cost the next one its chance.
        return false;
      }
    }

    // The same split as `classesOf` — two realms, no shared scope.
    function classNames() {
      const className = element.getAttribute("class");
      if (typeof className !== "string") return [];
      return className
        .split(/\s+/)
        .filter((name) => name !== "")
        .slice(0, classLimit);
    }

    /**
     * The 1-based position among the siblings that share the tag — what `:nth-of-type`
     * counts, counted along `parentNode`.
     *
     * `parentElement`, not `parentNode`, would answer `null` at the top of a root and
     * call every sibling there "the first". The root is no element, but it does carry
     * the children of its tree, and those are the siblings `:nth-of-type` counts.
     */
    function positionOf(target) {
      const parent = target.parentNode;
      if (parent === null || parent === undefined) return 1;
      const name = String(target.tagName);
      let position = 0;
      for (const sibling of parent.children) {
        if (String(sibling.tagName) === name) position += 1;
        if (sibling === target) break;
      }
      return position;
    }

    /**
     * The last resort: the chain from the root's edge down, one `:nth-of-type` per step.
     *
     * It stops where the root begins — at `parentNode === root`, which is also where
     * `parentElement` answers `null`. One step further would name a chain the document
     * cannot resolve, and a selector that looks like an answer while finding nothing is
     * the one failure this project refuses to hand out silently. Note that the steps are
     * joined with `>`, so a caller cannot reuse this one across a jump: a jump carries
     * one simple selector on each side, and this is a chain.
     */
    function pathOf() {
      const steps = [];
      let current = element;
      while (current !== null && current !== undefined) {
        const name = String(current.tagName).toLowerCase();
        steps.unshift(`${name}:nth-of-type(${positionOf(current)})`);
        const parent = current.parentNode;
        if (parent === root || parent === null || parent === undefined) break;
        current = parent;
      }
      return steps.join(" > ");
    }

    if (typeof element.id === "string" && element.id !== "") {
      const candidate = `${tag}#${element.id}`;
      if (isTheOnlyMatch(candidate)) return candidate;
    }

    const testId = quotedValue("data-testid");
    if (testId !== null) {
      const candidate = `[data-testid="${testId}"]`;
      if (isTheOnlyMatch(candidate)) return candidate;
    }

    const label = quotedValue("aria-label");
    if (label !== null) {
      const candidate = `${tag}[aria-label="${label}"]`;
      if (isTheOnlyMatch(candidate)) return candidate;
    }

    const name = quotedValue("name");
    if (name !== null) {
      const candidate = `${tag}[name="${name}"]`;
      if (isTheOnlyMatch(candidate)) return candidate;
    }

    // A position is a simple selector, and it is the candidate that survives two
    // identical siblings in one root — the one case the class form cannot describe. It
    // sits before the class form because a generated class name ages worse than a
    // structural position inside a component that owns its own tree.
    const positioned = `${tag}:nth-of-type(${positionOf(element)})`;
    if (isTheOnlyMatch(positioned)) return positioned;

    const classes = classNames();
    if (classes.length > 0) {
      const candidate = `${tag}${classes.map((className) => `.${className}`).join("")}`;
      if (isTheOnlyMatch(candidate)) return candidate;
    }

    return pathOf();
  }

  /* ----------------------------------------------------------- transcript */

  /**
   * The two gates of a transcript call, in one op: is this a desktop YouTube watch
   * page, and has the browser rendered it?
   *
   * They answer two different questions with two different errors:
   *
   * 1. Is this a desktop YouTube watch page? `example.com` must hear
   *    `transcript_failed`, not the advice to focus — that advice would send the agent
   *    into a loop it cannot leave (spec 32, R3-5). The host comparison is
   *    `youtube.com` or `.youtube.com`, never a bare suffix (`notyoutube.com`), and
   *    `m.youtube.com` is refused on purpose: it carries a different DOM.
   * 2. Is the page rendered? A tab in the background never builds `ytd-watch-flexy`
   *    (spec 32, M4), so there is nothing to read. `visibilityState` rides along because
   *    a *visible* tab can still be hydrating, and the caller must be able to tell those
   *    two states apart.
   *
   * The gates stay the first call even though the panel is no longer opened: they are
   * what keeps a call against a foreign or unrendered page from reaching the model op,
   * and the answer's sentence is decided by where the page failed, not by what the
   * model would have said.
   */
  function transcriptGateSource() {
    const visibilityState = String(document.visibilityState);
    const host = String(location.hostname);
    const isYoutubeHost =
      (host === "youtube.com" || host.endsWith(".youtube.com")) && host !== "m.youtube.com";
    if (!isYoutubeHost || String(location.pathname) !== "/watch") {
      return { outcome: "not_youtube", visibilityState };
    }
    if (document.querySelector("ytd-watch-flexy") === null) {
      return { outcome: "needs_focus", visibilityState };
    }
    return { outcome: "ok", visibilityState };
  }

  /**
   * Reads the player response: the caption tracks and the audio tracks, and nothing else.
   *
   * Everything below the walk is index loops and field-by-field copies, and that is the
   * whole point. `window.wrappedJSObject` hands out the operator's own objects; over an
   * Xray wrapper their `map`, `filter` and their iterator may simply not be there, and a
   * spread would silently produce nothing. Copying field by field is also what keeps the
   * answer small: a player response is megabytes, and this op answers four strings
   * and two numbers per track.
   *
   * A candidate may be the response itself or the JSON string the page kept (M11: the
   * string case was not measured, so both forms are read). `no_model` means no candidate
   * held a response at all; a response *without* `captionTracks` is a model — the video
   * simply has no subtitle track, and that is the caller's `no_transcript_panel`.
   */
  function transcriptModelSource(candidates) {
    // `wrappedJSObject` is absent only in a realm that is not a content script; the
    // fallback keeps this op honest there instead of throwing on a missing property.
    const pageRoot =
      typeof window.wrappedJSObject === "object" && window.wrappedJSObject !== null
        ? window.wrappedJSObject
        : window;

    function containerAt(path) {
      const parts = String(path).split(".");
      let current = pageRoot;
      for (let i = 0; i < parts.length; i += 1) {
        if (current === null || current === undefined) return null;
        current = current[parts[i]];
      }
      return current === null || current === undefined ? null : current;
    }
    function responseOf(value) {
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          return parsed !== null && typeof parsed === "object" ? parsed : null;
        } catch (error) {
          return null;
        }
      }
      return typeof value === "object" && value !== null ? value : null;
    }
    // The track list sits two levels down in the response YouTube actually ships:
    // `captions.playerCaptionsTracklistRenderer`.
    function tracklistOf(response) {
      const captions = response.captions;
      if (captions === null || typeof captions !== "object") return null;
      const renderer = captions.playerCaptionsTracklistRenderer;
      return renderer !== null && typeof renderer === "object" ? renderer : null;
    }
    // A track name is `{simpleText}` or `{runs:[{text}]}`, depending on the response. Both
    // are read here, because the menu comparison of spec 33 (M16) needs one plain string.
    function captionNameOf(name) {
      if (name === null || typeof name !== "object") return "";
      if (typeof name.simpleText === "string") return name.simpleText;
      const runs = name.runs;
      if (runs === null || runs === undefined) return "";
      let text = "";
      for (let i = 0; i < runs.length; i += 1) {
        const run = runs[i];
        if (run !== null && typeof run === "object" && typeof run.text === "string") text += run.text;
      }
      return text;
    }
    function captionTrackOf(track) {
      return {
        languageCode: typeof track.languageCode === "string" ? track.languageCode : "",
        vssId: typeof track.vssId === "string" ? track.vssId : "",
        name: captionNameOf(track.name),
        kind: typeof track.kind === "string" ? track.kind : "",
      };
    }
    function audioTrackOf(track) {
      return {
        audioTrackId: typeof track.audioTrackId === "string" ? track.audioTrackId : "",
        // The index into `captionTracks` this audio track belongs to. The track's own
        // *position* in `audioTracks` is deliberately not part of the copy: it was measured
        // to move between two calls for the same video (spec 33, M3), and only the id
        // identifies the original.
        defaultCaptionTrackIndex: Number.isInteger(track.defaultCaptionTrackIndex)
          ? track.defaultCaptionTrackIndex
          : null,
      };
    }
    function captionTracksOf(tracklist) {
      const copied = [];
      if (tracklist === null) return copied;
      const tracks = tracklist.captionTracks;
      if (tracks === null || tracks === undefined) return copied;
      for (let i = 0; i < tracks.length; i += 1) {
        const track = tracks[i];
        // The *position* is the payload here: `defaultCaptionTrackIndex` of the original
        // audio track is an index into this list. An entry that is not a track therefore
        // becomes a placeholder with empty fields instead of being dropped — a dropped
        // entry slides every later track up by one, and the original's index would then
        // answer the neighbour's language, which looks healthy and is wrong (spec 33,
        // M1/M2). The placeholder is refused where a track is actually *used*, not here.
        copied[i] =
          track !== null && typeof track === "object"
            ? captionTrackOf(track)
            : { languageCode: "", vssId: "", name: "", kind: "" };
      }
      return copied;
    }
    function audioTracksOf(tracklist) {
      const copied = [];
      if (tracklist === null) return copied;
      const tracks = tracklist.audioTracks;
      if (tracks === null || tracks === undefined) return copied;
      for (let i = 0; i < tracks.length; i += 1) {
        const track = tracks[i];
        if (track !== null && typeof track === "object") copied.push(audioTrackOf(track));
      }
      return copied;
    }

    for (let i = 0; i < candidates.length; i += 1) {
      const path = String(candidates[i]);
      const response = responseOf(containerAt(path));
      if (response === null) continue;
      const tracklist = tracklistOf(response);
      return {
        outcome: "model",
        source: path,
        captionTracks: captionTracksOf(tracklist),
        audioTracks: audioTracksOf(tracklist),
      };
    }
    return { outcome: "no_model" };
  }

  /**
   * Reads the track file whose address the caller hands in, and applies the window to its cues.
   *
   * The address arrives as an argument and from nowhere else: the background page observed the
   * request the *player* made, and only that one carries a valid signature (spec 33, M13). The
   * page's own resource timeline is no longer read for one — it was measured blind for the
   * page's requests (M18, spec 34), so a second address path in here would be the convenient
   * way back into a channel that does not work.
   *
   * Which track the address belongs to was decided before the injection: `lang`, `kind` and
   * `tlang` are the marks the wire matches on. What this op still reads out of the
   * address is the language it *delivers*, and the format it appends.
   *
   * The address never leaves this op. The answer carries the language *read out of
   * it* and the cues; an answer field with the address would be the leak the whole design
   * is built to avoid, so there is no such field and no message that names one.
   *
   * The window logic is the one from `docs/32`, criterion 3, moved and not rewritten:
   * every cue whose text overlaps `[offset, offset + maxChars)` travels whole, because
   * half a cue would make its stamp a lie, and `truncated` hangs on the end of the last
   * delivered cue rather than on `offset + chars`.
   */
  async function transcriptCaptionSource(request) {
    const address = String(request.address);

    // One query parameter of an address, or null. Parsed by hand instead of with `URL`:
    // this op only has to find two parameters of it, and the address is a string with a
    // query and a fragment, nothing more.
    function paramOf(address, name) {
      const questionMark = String(address).indexOf("?");
      if (questionMark === -1) return null;
      const query = String(address).slice(questionMark + 1);
      const hash = query.indexOf("#");
      const pairs = (hash === -1 ? query : query.slice(0, hash)).split("&");
      for (let i = 0; i < pairs.length; i += 1) {
        const pair = pairs[i];
        const equals = pair.indexOf("=");
        const key = equals === -1 ? pair : pair.slice(0, equals);
        if (key !== name) continue;
        const value = equals === -1 ? "" : pair.slice(equals + 1);
        try {
          return decodeURIComponent(value);
        } catch (error) {
          return value;
        }
      }
      return null;
    }
    // `fmt=json3` is what makes the file a whole track with timestamps (M13). It is *set*,
    // not appended blindly: an address that already names a format would otherwise carry
    // two of them and the endpoint would pick one nobody asked for.
    function json3AddressOf(address) {
      const hash = address.indexOf("#");
      const head = hash === -1 ? address : address.slice(0, hash);
      const fragment = hash === -1 ? "" : address.slice(hash);
      const questionMark = head.indexOf("?");
      const path = questionMark === -1 ? head : head.slice(0, questionMark);
      const query = questionMark === -1 ? "" : head.slice(questionMark + 1);
      const kept = [];
      const pairs = query.split("&");
      for (let i = 0; i < pairs.length; i += 1) {
        const pair = pairs[i];
        if (pair === "" || pair === "fmt" || pair.startsWith("fmt=")) continue;
        kept.push(pair);
      }
      kept.push("fmt=json3");
      return `${path}?${kept.join("&")}${fragment}`;
    }
    // "[h:]m:ss" of the cue's start. The hour form is real: a lecture is longer than an
    // hour, and `62:03` would be a stamp nobody writes.
    function timeTextOf(startMs) {
      const totalSeconds = Math.floor(startMs / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const padded = (value) => (value < 10 ? `0${value}` : String(value));
      return hours > 0 ? `${hours}:${padded(minutes)}:${padded(seconds)}` : `${minutes}:${padded(seconds)}`;
    }
    // The cue's text is the joined `segs[].utf8`. Joined with one space and with the runs
    // of spaces folded: the `ja` track writes its pieces without any space, and a parser
    // that glued them would put "Japanischlernen" in the answer (spec 33, M15) — while a
    // parser that inserted nothing would glue the *latin* words of the same track.
    function textOf(segs) {
      if (segs === null || segs === undefined) return "";
      let text = "";
      for (let i = 0; i < segs.length; i += 1) {
        const seg = segs[i];
        if (seg === null || typeof seg !== "object" || typeof seg.utf8 !== "string") continue;
        text = text === "" ? seg.utf8 : `${text} ${seg.utf8}`;
      }
      // Runs of blanks are folded, not just ASCII spaces: a cue may carry a tab or a
      // no-break space, and both would otherwise land in `chars` and `totalChars` as
      // characters nobody can see.
      return text.replace(/[ \t\u00a0]+/g, " ").trim();
    }
    function cueOf(event) {
      const startMs = typeof event.tStartMs === "number" && Number.isFinite(event.tStartMs) ? event.tStartMs : 0;
      return {
        time: Math.floor(startMs / 1000),
        timeText: timeTextOf(startMs),
        text: textOf(event.segs),
      };
    }

    let body = null;
    try {
      const response = await fetch(json3AddressOf(address));
      if (response === null || typeof response !== "object" || response.ok === false) {
        return { outcome: "caption_failed" };
      }
      if (typeof response.json !== "function") return { outcome: "caption_failed" };
      body = await response.json();
    } catch (error) {
      return { outcome: "caption_failed" };
    }
    if (body === null || typeof body !== "object") return { outcome: "caption_failed" };
    const events = body.events;
    if (events === null || events === undefined) return { outcome: "caption_failed" };

    const all = [];
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event === null || typeof event !== "object") continue;
      const cue = cueOf(event);
      // An event without text is a marker of the player, not a cue: keeping it would put
      // an empty segment in the answer and cost the connector space in `totalChars`.
      if (cue.text === "") continue;
      all.push(cue);
    }

    const offset = request.offset;
    const maxChars = request.maxChars;
    const deliveredLanguage = paramOf(address, "lang");
    const totalChars = all.map((cue) => cue.text).join(" ").length;
    if (offset > totalChars) {
      return { outcome: "offset_out_of_range", offset, totalChars };
    }
    // A paging loop's halt: exactly at the end is a valid window, one character further
    // is the mistake above.
    if (offset === totalChars) {
      return {
        outcome: "caption",
        deliveredLanguage,
        segments: [],
        totalChars,
        chars: 0,
        offset,
        truncated: false,
      };
    }

    const windowEnd = offset + maxChars;
    const delivered = [];
    let cueStart = 0;
    let endLast = 0;
    for (const cue of all) {
      const cueEnd = cueStart + cue.text.length;
      // Overlap, not containment: a cue the window only touches from either side travels
      // whole.
      if (cueEnd > offset && cueStart < windowEnd) {
        delivered.push(cue);
        endLast = cueEnd;
      }
      // The one-space connector belongs to the end of this cue.
      cueStart = cueEnd + 1;
    }
    return {
      outcome: "caption",
      deliveredLanguage,
      segments: delivered,
      totalChars,
      chars: delivered.map((cue) => cue.text).join(" ").length,
      offset,
      truncated: endLast < totalChars,
    };
  }

  /**
   * The player's settings menu and the playhead: read the track list, pick one entry, jump.
   *
   * Nothing here is anchored on an interface string. The row that opens the track list is
   * the one whose `.ytp-menuitem-content` is *exactly* one of the track names the model
   * handed out — measured: exactly one such row (spec 33, M16) — and the localized label of
   * that row is never read. The counter-check is the number of entries behind it:
   * `captionTracks + 2`, plus one when the list carries a pair entry (`… >> …`, the
   * auto-translation) — measured 2026-11-12 on `wKv-g1uEoDY`, four entries for a single track.
   * A menu whose count is off by anything else is refused by name instead of being clicked at.
   *
   * Four actions in one op, because they share the walk over the rows and because the
   * restore must be one injection: "track first, playhead last" cannot be reordered by a
   * second injection arriving in between (criterion 6).
   *
   * Every list is walked by index: the page hands out Xray wrapped objects, and `map`,
   * `filter` or a spread over one of them may simply not exist there.
   */
  function transcriptMenuSource(request) {
    const SETTINGS_BUTTON = ".ytp-settings-button";
    const MENU_ITEM = ".ytp-menuitem";
    const MENU_CONTENT = ".ytp-menuitem-content";
    const PANEL_MENU = ".ytp-panel-menu";
    const CHECKED_ATTRIBUTE = "aria-checked";
    // The marker auto-translate appends to an entry: "… >> English". Such an entry is a
    // language pair, not a track, and picking it would answer one language over the text of
    // another (M5, M9).
    const TRANSLATED_MARK = ">>";

    const names = request.names === null || request.names === undefined ? [] : request.names;
    const expectedCount = Number(request.expectedCount);
    // Whether the popup on screen is ours to close: we opened it with the settings button. A
    // popup the operator left open is read and stays open — we did not make it and we do not
    // get to remove it.
    let ours = false;

    function textOf(element) {
      if (element === null || element === undefined) return "";
      const text = element.innerText;
      return typeof text === "string" ? text.trim() : "";
    }
    function listOf(root, selector) {
      const list = [];
      if (root === null || root === undefined || typeof root.querySelectorAll !== "function") {
        return list;
      }
      const found = root.querySelectorAll(selector);
      for (let i = 0; i < found.length; i += 1) list.push(found[i]);
      return list;
    }
    function elementOf(root, selector) {
      if (root === null || root === undefined || typeof root.querySelector !== "function") return null;
      const found = root.querySelector(selector);
      return found === undefined ? null : found;
    }
    function clickableOf(element) {
      return element !== null && typeof element === "object" && typeof element.click === "function";
    }
    function videoOf() {
      return elementOf(document, "video");
    }
    function playheadOf() {
      const video = videoOf();
      if (video === null) return null;
      const value = Number(video.currentTime);
      return Number.isFinite(value) ? value : null;
    }
    // Whether the popup is on screen right now: it shows a row. That is the same signal
    // `trackRowsOf` leans on to decide whether the menu has to be opened first — a closed
    // popup hands out no row, which is all this needs to know.
    function menuIsOpen() {
      return listOf(document, MENU_ITEM).length > 0;
    }
    // Opening and closing are the same click: the button toggles the popup. So the click is
    // made only while the popup is on screen *and* was ours to begin with — a click on an
    // entry closes the popup by itself, and clicking the button then would open it again and
    // leave the operator with a menu that was closed before the call (review m4).
    function closeMenu() {
      if (!ours) return;
      ours = false;
      if (!menuIsOpen()) return;
      const button = elementOf(document, SETTINGS_BUTTON);
      if (clickableOf(button)) button.click();
    }
    // The row's value as the model names a track: with auto-translation on, the row shows the
    // *pair* while the model names only the track. Measured 2026-11-12 on `wKv-g1uEoDY`: the
    // row read "Japanisch (automatisch erzeugt) >> Englisch" against the model's "Japanisch
    // (automatisch erzeugt)", so the exact comparison found nothing and the run ended in
    // `no_row`. Hence the part before the first marker. Only here — the pick inside the
    // track list stays exact, and that exactness is what keeps a pair entry out of it.
    function rowNameOf(value) {
      const mark = value.indexOf(TRANSLATED_MARK);
      return mark === -1 ? value : value.slice(0, mark).trim();
    }
    // The row whose *value* is exactly a track name. The value is the point twice over: a
    // row's label may carry a language name as well, and the entries of an open panel carry
    // no value element at all — a substring search or an `innerText` comparison would find
    // both and then be right by accident.
    function trackRowsOf() {
      const rows = [];
      const all = listOf(document, MENU_ITEM);
      for (let i = 0; i < all.length; i += 1) {
        const value = rowNameOf(textOf(elementOf(all[i], MENU_CONTENT)));
        if (value === "") continue;
        for (let n = 0; n < names.length; n += 1) {
          if (value === String(names[n])) {
            rows.push(all[i]);
            break;
          }
        }
      }
      return rows;
    }
    // The panels stack in document order, so the deepest — the one just opened — is the
    // last. The count check in `openTrackList` is what catches a wrong panel; without it the
    // first entry's text would be the only thing between us and a wrong click.
    function deepestPanel() {
      const panels = listOf(document, PANEL_MENU);
      return panels.length === 0 ? null : panels[panels.length - 1];
    }
    // The track list, opened: the entries, their texts, and the refusal where the row is not
    // the one the model describes. Every refusal is an outcome and not a thrown error:
    // an op that throws reaches the caller as "this page is not readable", which is a
    // different story and hides what happened.
    function openTrackList() {
      let rows = trackRowsOf();
      if (rows.length === 0) {
        const button = elementOf(document, SETTINGS_BUTTON);
        if (!clickableOf(button)) return { outcome: "no_row" };
        button.click();
        ours = true;
        rows = trackRowsOf();
      }
      if (rows.length === 0) {
        closeMenu();
        return { outcome: "no_row" };
      }
      if (rows.length > 1) {
        const candidates = [];
        for (let i = 0; i < rows.length; i += 1) candidates.push(textOf(rows[i]));
        closeMenu();
        return { outcome: "row_ambiguous", candidates };
      }
      // No claim of ownership here: the popup was already on screen, either because we
      // opened it (then `ours` is set) or because the operator left it open (then it is not,
      // and the popup stays).
      rows[0].click();
      const entries = listOf(deepestPanel(), MENU_ITEM);
      const texts = [];
      for (let i = 0; i < entries.length; i += 1) texts.push(textOf(entries[i]));
      // A pair entry ("track >> language") is one entry on top of the count the model
      // predicts: measured 2026-11-12 on `wKv-g1uEoDY` with auto-translation on, the list
      // carried four entries — "Aus", the track, "Automatisch übersetzen" and
      // "Japanisch (automatisch erzeugt) >> Englisch" — against `captionTracks + 2` = 3, so
      // the counter-check refused the very list it was looking at. So one pair entry makes
      // the expectation one higher; a list off by anything else is still refused by name.
      let pairEntries = 0;
      for (let i = 0; i < texts.length; i += 1) {
        if (texts[i].indexOf(TRANSLATED_MARK) !== -1) pairEntries += 1;
      }
      const expected = expectedCount + (pairEntries > 0 ? 1 : 0);
      if (entries.length !== expected) {
        const count = entries.length;
        closeMenu();
        // The refusal names `expected`, not `expectedCount`: with a pair entry in the list the
        // two differ, and a message quoting the model's number would tell the operator the
        // wrong second number ("5 statt 3" where the check wanted 4).
        return { outcome: "row_miscount", count, expectedCount: expected };
      }
      return { outcome: "open", entries, texts };
    }
    // The entry the player marks as running. The off entry carries the mark too, and that is
    // how "captions were off" becomes a name that can be picked again.
    function checkedNameOf(entries) {
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (typeof entry.getAttribute !== "function") continue;
        if (String(entry.getAttribute(CHECKED_ATTRIBUTE)) !== "true") continue;
        return textOf(entry);
      }
      return "";
    }
    // The entries worth naming in a refusal. A `>>` entry names a language pair, not a
    // track, so it is no candidate for the pick the caller asked for. Exclusion from the
    // pick itself needs none of this: there the comparison is exact (see the set branch).
    function pickableTextsOf(texts) {
      const pickable = [];
      for (let i = 0; i < texts.length; i += 1) {
        const text = texts[i];
        if (text === "" || text.includes(TRANSLATED_MARK)) continue;
        pickable.push(text);
      }
      return pickable;
    }

    if (String(request.action) === "seek") {
      const video = videoOf();
      if (video === null) return { outcome: "no_player" };
      const from = playheadOf();
      const duration = Number(video.duration);
      const step = Number(request.seekOffsetS) > 0 ? Number(request.seekOffsetS) : 1;
      let to = null;
      // Forward when that still lies inside the video, backward otherwise, and not at all
      // when neither does: a jump past either end would hand out a track file for an instant
      // the video does not have. A length that is not a number — a live stream — is no basis
      // for a jump either.
      if (from !== null && Number.isFinite(duration)) {
        if (from + step <= duration) to = from + step;
        else if (from - step >= 0) to = from - step;
      }
      if (from === null || to === null) {
        return { outcome: "seek", seeked: false, from, to: from };
      }
      video.currentTime = to;
      return { outcome: "seek", seeked: true, from, to };
    }

    if (String(request.action) === "restore") {
      const restoreName = typeof request.name === "string" ? request.name : "";
      const restoreTime = Number.isFinite(request.currentTime) ? request.currentTime : null;
      let trackRestored = false;
      // The track half may throw — a page that is being rebuilt loses its menu mid-way — and
      // the playhead write must survive that: it is the half the operator notices, and the
      // cleanup is the one place where a partial result beats none (review m5).
      try {
        if (restoreName !== "") {
          const list = openTrackList();
          if (list.outcome === "open") {
            let found = -1;
            let count = 0;
            // The remembered name is compared exactly *with* translations: this puts back
            // what the operator had, it does not choose a track — that is what the pick
            // above is for, and only there would a pair entry be the wrong track.
            for (let i = 0; i < list.texts.length; i += 1) {
              if (list.texts[i] !== restoreName) continue;
              count += 1;
              found = i;
            }
            if (count === 1 && clickableOf(list.entries[found])) {
              list.entries[found].click();
              trackRestored = true;
            }
          }
          closeMenu();
        }
      } finally {
        // Last, after every track click: a track change moves the playhead again, and the
        // operator would be left where the change put them (criterion 6).
        const video = videoOf();
        if (video !== null && restoreTime !== null) video.currentTime = restoreTime;
      }
      return { outcome: "restored", trackRestored, currentTime: playheadOf() };
    }

    const list = openTrackList();
    if (list.outcome !== "open") return list;
    const checkedName = checkedNameOf(list.entries);
    const currentTime = playheadOf();
    if (String(request.action) !== "set") {
      closeMenu();
      return { outcome: "menu", entries: list.texts, checkedName, currentTime };
    }
    // Exact comparison on the trimmed entry text, and no index: the list starts with the off
    // entry, so the position in it is not the position in `captionTracks` (M5). The exactness
    // is also the whole exclusion of the auto-translate entries — "… >> Englisch" contains
    // the target's name and never *is* it (M5, M9) — so there is no separate `>>` filter here
    // that could look like a guard while the comparison already does the job.
    const matches = [];
    for (let i = 0; i < list.texts.length; i += 1) {
      const text = list.texts[i];
      if (text === "") continue;
      if (text !== String(request.name)) continue;
      matches.push(i);
    }
    if (matches.length !== 1) {
      const candidates = pickableTextsOf(list.texts);
      closeMenu();
      return { outcome: matches.length === 0 ? "no_match" : "ambiguous", candidates };
    }
    list.entries[matches[0]].click();
    // What the player *shows* now, read after the click: the requested name is what the call
    // asked for, and answering with it would report an intention as a state (review m6).
    let settledName = checkedNameOf(list.entries);
    let settledTexts = list.texts;
    // One re-open, then the verdict. The click closes the popup, and a page that rebuilds its
    // entries on open (or hands out the mark only while the popup is on screen) answers
    // nothing on the nodes the pick was read from — the mark is not missing, it is unread. So
    // a mark that does not match is measured a second time, in the list as it stands now, and
    // only an unread result there is the pick that did not take effect.
    if (settledName !== String(request.name)) {
      const reopened = openTrackList();
      if (reopened.outcome === "open") {
        settledName = checkedNameOf(reopened.entries);
        settledTexts = reopened.texts;
      }
    }
    closeMenu();
    return { outcome: "menu", entries: settledTexts, checkedName: settledName, currentTime };
  }

  /* ------------------------------------------------------------------- ops */

  /**
   * Which inspect answers: the plain query, or the one that knows about `>>>`.
   *
   * The choice used to be the bridge's — which heap of source it packed — and it is now
   * a branch here, where it belongs: the branch is about the page, not about transport.
   * The shadow function decides for itself whether a `>>>` inside a quoted attribute
   * value is a jump, so a plain-looking string costs one extra call and no answer.
   */
  function inspectAnswerFor(request, want) {
    const jumps = typeof request.selector === "string" && request.selector.indexOf(">>>") !== -1;
    return jumps ? inspectShadowPageSource(request, want) : inspectPageSource(request, want);
  }

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
    inspect: (args) => inspectAnswerFor(args.request, args.want ?? null),
    transcriptGate: () => transcriptGateSource(),
    transcriptModel: (args) => transcriptModelSource(args.candidates ?? []),
    transcriptCaption: (args) => transcriptCaptionSource(args.request),
    transcriptMenu: (args) => transcriptMenuSource(args.request),
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
