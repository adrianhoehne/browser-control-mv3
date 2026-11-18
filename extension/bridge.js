"use strict";

/**
 * The bridge page of the browser-control extension: dials the bridge, answers the
 * thirteen tool calls, and retries with exponential backoff.
 *
 * This code used to be the background page. It lives in an extension tab
 * (`bridge.html`, spec 42) because a page that can be unloaded takes the socket
 * with it, and a tab is not unloaded after 30 seconds of idling. `background.js`
 * is the coordinator that keeps exactly one such tab alive.
 *
 * A classic script, not a module — `bridge.html` loads it with a `script` tag,
 * after `protocol.js`, which publishes `globalThis.BC_PROTOCOL`. There is no
 * `main()`: the page is started by loading the file, so the last lines of this
 * file are the entry point. The tab can be discarded and reloaded at any time,
 * which is why nothing here depends on state left over from an earlier run.
 *
 * `test/extension.test.js` drives exactly this entry point with stubbed
 * `browser`, `WebSocket`, `setTimeout` and `console`.
 */
(() => {
  const PROTOCOL = globalThis.BC_PROTOCOL;
  if (PROTOCOL === undefined) {
    // The load order guarantees the constants; failing loudly beats a page that
    // silently never connects and cannot say why.
    throw new Error("bc: protocol.js did not load before bridge.js");
  }

  const ENDPOINT_KEY = "endpoint";
  const TOKEN_KEY = "token";
  // What a local install has to type: nothing but the token. The bridge listens on
  // `DEFAULT_BIND` from `bridge/config.mjs` unless the operator says otherwise, and
  // the options page pre-fills the same value for the same reason. Filling it here
  // as well means an early `storage.local` without the key connects instead of
  // staying silent (spec 36); a stored endpoint always wins, only `""` is replaced.
  const DEFAULT_ENDPOINT = "ws://127.0.0.1:8110";
  // The agent tabs, most recently used last. A hint, never the truth: tab ids do
  // not survive a browser restart, so every caller checks the ids before it trusts
  // them.
  const AGENT_TAB_IDS_KEY = "agentTabIds";
  // The single id of the previous increment. Only read to migrate it away — see
  // `readAgentTabIds`.
  const LEGACY_AGENT_TAB_ID_KEY = "agentTabId";
  // How many agent tabs the agent may keep at once. A contract number, not a knob:
  // it is what makes the tab bar predictable for the operator, and `open_tab` says
  // `too_many_tabs` above it instead of letting the bar grow.
  const AGENT_TAB_LIMIT = 5;
  // The operator's switch from spec 07. Read on *every* `type` call, not cached at
  // startup: the decision to unlock password fields has to take effect without a
  // reload of the extension. The bridge does not know this key on purpose — the
  // code that writes into the page is the code that decides.
  const ALLOW_PASSWORD_FIELDS_KEY = "allowPasswordFields";
  // The operator's switch from spec 19, read on *every* `eval` call for the same
  // reason as the password one: the decision to hand the agent code in the page has
  // to take effect without a reload. Named without the `_KEY` suffix because the
  // spec spells `const ALLOW_EVAL = "allowEval";` and `test/manifest.test.js` pins
  // that line verbatim — one spelling per literal is what keeps the storage key and
  // the checkbox id from drifting apart.
  const ALLOW_EVAL = "allowEval";
  // The operator's switch from spec 20, spelled the same way for the same reason as
  // `ALLOW_EVAL`: `test/manifest.test.js` pins this line verbatim, so the storage key,
  // the checkbox id and the reading side cannot drift into three spellings. Read on
  // *every* `screenshot` call — the decision to let the agent see the tab has to take
  // effect without a reload.
  const ALLOW_SCREENSHOT = "allowScreenshot";

  // Only the default container is exposed to the agent: a tab in a
  // multi-account container carries its own cookie jar and is logged in nowhere.
  const DEFAULT_COOKIE_STORE_ID = "firefox-default";
  const NORMAL_WINDOW_TYPE = "normal";

  const WEBSOCKET_OPEN = 1;
  const UNSUPPORTED_METHOD_CODE = "unsupported_method";
  const STATUS_FAILED_CODE = "status_failed";

  // Local on purpose: the bridge never reads this number, and a constant in
  // `BC_PROTOCOL` would have to be mirrored into the other copy of it for no
  // gain. It stays below `CALL_TIMEOUT_MS` of the bridge, which is the real
  // upper bound for the call.
  const NAVIGATE_TIMEOUT_MS = 8000;
  const INVALID_PARAMS_CODE = "invalid_params";
  const INVALID_URL_CODE = "invalid_url";
  const NO_DEFAULT_WINDOW_CODE = "no_default_window";
  const NAVIGATE_FAILED_CODE = "navigate_failed";
  const NO_AGENT_TAB_CODE = "no_agent_tab";
  // The one code `open_tab` adds: above `AGENT_TAB_LIMIT` the call is refused before
  // anything is created. Local to the extension on purpose — no other code lives in
  // `BC_PROTOCOL`, and the bridge only forwards what it reads.
  const TOO_MANY_TABS_CODE = "too_many_tabs";
  const NOT_READABLE_CODE = "not_readable";
  // Not a statement about the page but about the moment: the tab was still loading
  // when the injection was refused, so the caller may try again rather than give up.
  const PAGE_BUSY_CODE = "page_busy";
  const READ_FAILED_CODE = "read_failed";
  // The one failure `frames` reports itself. Its own name instead of `read_failed`,
  // because the caller was not reading a page — and the bridge would otherwise answer a
  // sentence about a text that never existed.
  const FRAMES_FAILED_CODE = "frames_failed";
  // The two verdicts of the frame filter (spec 24). They are the *filter's* answer, not
  // the page's: both speak only about frames that answered, which is why the count and
  // the candidates ride along in `details`.
  const FRAME_NOT_FOUND_CODE = "frame_not_found";
  const FRAME_AMBIGUOUS_CODE = "frame_ambiguous";
  // The marker every snippet answers when its own `location.href` does not match the
  // asked-for substring. Spelled out in the page realm too (it travels through
  // `toString()` and sees no module scope), the way `offset_out_of_range` already is —
  // so this constant and that literal are one word in two places.
  const NOT_THE_FRAME_CODE = "not_the_frame";
  // How many addresses a `frame_ambiguous` error names. The list is advice to address
  // more precisely, not an inventory — `browser_frames` has the whole one.
  const FRAME_CANDIDATE_LIMIT = 5;
  // The one refusal the *page* decides: it is the only realm that holds the whole text
  // and can therefore tell an `offset` behind its end from one on it. The length rides
  // in the message (not in `details`), because the caller corrects its next `offset`
  // with exactly that number.
  const OFFSET_OUT_OF_RANGE_CODE = "offset_out_of_range";
  const CLICK_FAILED_CODE = "click_failed";
  const TYPE_FAILED_CODE = "type_failed";
  // The only failure `inspect` decides itself: the injection ran and handed back a
  // shape nobody can read. Everything the page could refuse has its own code.
  const INSPECT_FAILED_CODE = "inspect_failed";
  const NOT_TYPEABLE_CODE = "not_typeable";
  const PASSWORD_NOT_ALLOWED_CODE = "password_not_allowed";
  // The one failure `focus` reports itself: the tab could not be brought forward.
  // A window that stays behind is not one — see `focusAgentTab`.
  const FOCUS_FAILED_CODE = "focus_failed";
  // Shared with `navigate`: both change the page, so only one of them may speak for
  // the tab. The newer call wins and the older one says this.
  const SUPERSEDED_CODE = "superseded";
  // The three verdicts of `transcript` (spec 32). `offset_out_of_range` is deliberately
  // not one of them: the *page* decides that refusal, and `read` already names it — a
  // second name for the same thing would be a second rule the caller has to learn.
  const TRANSCRIPT_FAILED_CODE = "transcript_failed";
  const NO_TRANSCRIPT_PANEL_CODE = "no_transcript_panel";
  const NEEDS_FOCUS_CODE = "transcript_needs_focus";

  // How long the caller waits for the wire to carry the track file after the jump. Chosen,
  // not measured: 3 000 ms are the deadline the settle wait uses, and two waits of that
  // length plus the injections still fit under `PROTOCOL.CALL_TIMEOUT_MS`. The polling
  // interval that belonged to the performance list is gone with that list (spec 34): the
  // wire pushes, nobody polls.
  const TRANSCRIPT_CAPTION_DEADLINE_MS = 3000;
  // The jump that makes the player fetch the file itself — one second was measured to be
  // enough (spec 33, M17) — and the two entries the track menu carries besides the tracks:
  // the off entry and the auto-translate entry (M16: 33 = 31 + 2).
  const TRANSCRIPT_SEEK_OFFSET_S = 1;
  const TRANSCRIPT_MENU_EXTRA_ENTRIES = 2;

  // How many requests the wire keeps per tab, and how many tabs it keeps at all. Both are
  // chosen, not measured (spec 34, `## Bekannte Lücken`): one entry per language mark, the
  // latest of it, and no more tabs than the tabs this extension is allowed to drive. Without
  // the second cap the wire would become a history of the operator's own browsing.
  const TRANSCRIPT_CAPTION_WIRE_LIMIT = 8;
  const TRANSCRIPT_CAPTION_WIRE_TAB_LIMIT = AGENT_TAB_LIMIT;

  // The wait a click falls back to when the settle wait had nothing to report.
  // Spec 15 replaced the fixed guess with a wait for DOM quiet; this number survives
  // as the floor of the old promise — a click must never wait worse than the 300 ms
  // of spec 06, not even on a page that refuses to be watched. It is the only place
  // an old number is still alive.
  const CLICK_FALLBACK_MS = 300;

  // The fixed wait after a `type` — unchanged by spec 15: whether a typed-into page
  // is "done" is a question of its own increment, and a longer guess would only cost
  // the caller time.
  const TYPE_WAIT_MS = 300;

  // How long the DOM has to stay quiet before `read` trusts what it sees, and how
  // long that wait may last in total. Contract, not a knob: no caller can raise or
  // lower them, which is why they are constants and not params — the next page that
  // is slow would otherwise turn every read into a tuning exercise.
  const QUIET_WINDOW_MS = 250;
  const SETTLE_DEADLINE_MS = 3000;
  // The same deadline, seen from the extension: 3 000 ms plus a buffer, because the
  // page-side timer is not trustworthy when its tab is in a window nobody focused.
  // Firefox throttles `setTimeout` in background tabs, so the page deadline can fire
  // minutes late — measured 2026-10-23, a `read` against a background window hung
  // until the bridge gave up. A snippet that never answers must never hold a call.
  const SETTLE_GUARD_MS = 4000;

  // The same idea for the one request that leaves this file. A HEAD for the content
  // type of an unreadable page is a decoration of an error, not an answer the caller
  // is waiting for: 1,5 s is the ceiling, and past it the field says `null`.
  const HEAD_DEADLINE_MS = 1500;

  // The page text is cut inside the page, not here: the raw `innerText` of a huge
  // page then never leaves the content process. 20 000 characters are at most
  // ~60 kB of UTF-8 — with JSON escapes still far below the message limit.
  // Two roles since spec 22: it is the *default* window of `read` and still the cut
  // of the page state `click`/`type` attach. What a caller may ask `read` for is a
  // different question — that ceiling lives in `READ_MAX_CHARS_LIMIT`.
  const TEXT_LIMIT = 20000;
  // The window a `read` may be asked for, and the one it gets when it asks for
  // nothing. The floor is 1 because an empty window is no read at all; the ceiling
  // because a 100 000-character answer is the largest text frame this system sends
  // (spec 22, `## Risiken`) — and it is a ceiling, not a target.
  const READ_MAX_CHARS_MIN = 1;
  const READ_MAX_CHARS_LIMIT = 100000;
  const READ_MAX_CHARS_DEFAULT = TEXT_LIMIT;
  const READ_OFFSET_DEFAULT = 0;
  // The two modes of a `read` (spec 23). `text` is the whole page and the behaviour
  // every older caller gets; `article` reads the article body instead. The list lives
  // here and *not* in the bridge: the bridge checks the type, this side the name.
  const READ_MODES = Object.freeze(["text", "article"]);
  const READ_MODE_DEFAULT = "text";
  // The length a candidate root needs before the article mode believes it (spec 23,
  // stage 1). A `main` element that holds a 40-character teaser is a `main`, not an
  // article, and answering with the teaser would be worse than answering with the
  // page. It travels into the snippet as an argument: the page realm sees no module
  // scope, and the number must not exist twice in this repository.
  const ARTICLE_MIN_CHARS = 500;
  // A page may set its title to anything, and an over-long frame would be closed
  // with 1009 by the bridge — the call would look like "no extension at all".
  const URL_LIMIT = 2048;
  const TITLE_LIMIT = 1024;
  // The address of an unreadable page rides in the *error* frame, and needs the same
  // cap for the same reason: a `data:` address could otherwise push the frame over
  // the bridge's message limit, and the caller would see a dead connection instead of
  // an error. Derived from the *full* address, cut only for the frame — see
  // `notReadableErrorForTab`.
  const URL_DETAIL_LIMIT = 2048;
  // The schemes no injection can reach: the browser's own pages and its own
  // extension pages. `edge:` is a Chromium scheme and will never fire in Firefox; it
  // is listed because `kind` is read by a caller that does not know the browser.
  const INTERNAL_URL_SCHEMES = ["about:", "moz-extension:", "chrome:", "edge:", "view-source:"];

  // The window a caller may ask `inspect` for, and the one it gets when it asks for
  // nothing. A page may hold thousands of elements; fifty are an answer, five
  // thousand are a wall of text the caller has to read through.
  const INSPECT_LIMIT_MIN = 1;
  const INSPECT_LIMIT_MAX = 200;
  const INSPECT_LIMIT_DEFAULT = 50;
  // The cap counts *examined* candidates, in the selector path and in the text path
  // alike: every candidate costs an `innerText` read, which costs layout, so a text
  // search on a huge page would otherwise be an errand without an end. A reached cap
  // makes `count` a lower bound and sets `truncated`.
  const INSPECT_CANDIDATE_LIMIT = 5000;
  // Readable, not exhaustive: an element carrying more text than this is described by
  // its beginning, which is what a caller picks a selector by.
  const INSPECT_TEXT_LIMIT = 200;
  const INSPECT_CLASS_LIMIT = 10;

  // Quoted from the wire protocol: the bridge maps the code back to this very
  // sentence, so both sides say the same thing about the same mistake.
  const INVALID_URL_MESSAGE = "Nur http:// und https:// sind erlaubt.";
  const NO_DEFAULT_WINDOW_MESSAGE = "Kein normales, nicht-privates Fenster gefunden.";
  const MISSING_URL_MESSAGE = "navigate braucht eine URL als String.";
  const NO_AGENT_TAB_MESSAGE = "Es gibt keinen Agenten-Tab zum Lesen.";
  // The sentence the operator reads in the MCP tool text. The bridge keeps its own
  // copy of it — the extension cannot be imported from Node, so the two are kept in
  // step by hand — and both suites assert this exact string, so a rewrite on one
  // side turns a test red instead of drifting silently.
  const TOO_MANY_TABS_MESSAGE = "Es sind schon fünf Agenten-Tabs offen — erst einen schließen.";
  const MISSING_OPEN_URL_MESSAGE = "open_tab braucht eine URL als String.";
  const NOT_READABLE_MESSAGE = "Die Seite gibt keinen lesbaren Inhalt her.";
  const PAGE_BUSY_MESSAGE = "Die Seite lädt noch.";
  const READ_FAILED_MESSAGE = "Das Ergebnis der Injektion war unbrauchbar.";
  const MISSING_SELECTOR_MESSAGE = "click braucht einen Selektor als String.";
  const SUPERSEDED_MESSAGE = "Ein neuerer Aufruf hat diesen abgelöst.";
  const INVALID_SELECTOR_MESSAGE = "Der Selektor ist ungültig.";
  const NO_MATCH_MESSAGE = "Kein Element passt zu diesem Selektor.";
  const NOT_CLICKABLE_MESSAGE = "Das Element ist nicht sichtbar oder deaktiviert.";
  const CLICK_FAILED_MESSAGE = "Das Ergebnis der Klick-Injektion war unbrauchbar.";
  const MISSING_TEXT_MESSAGE = "type braucht einen Text als String.";
  const INVALID_SUBMIT_MESSAGE = "submit muss true oder false sein.";
  const NOT_TYPEABLE_MESSAGE = "Das Element ist kein beschreibbares Feld oder deaktiviert.";
  const PASSWORD_NOT_ALLOWED_MESSAGE =
    "Passwortfelder sind gesperrt. In den Optionen der Erweiterung freischalten.";
  const TYPE_FAILED_MESSAGE = "Das Ergebnis der Tipp-Injektion war unbrauchbar.";
  const MISSING_INSPECT_FILTER_MESSAGE = "inspect braucht selector oder text.";
  // One sentence for both filters: the caller has to fix the same thing either way,
  // and the empty string is a *set* filter — its meaning is the page's decision.
  const INSPECT_FILTER_TYPE_MESSAGE = "selector und text müssen Strings sein.";
  const INSPECT_LIMIT_MESSAGE =
    `limit muss eine ganze Zahl von ${INSPECT_LIMIT_MIN} bis ${INSPECT_LIMIT_MAX} sein.`;
  // One sentence per boundary: a caller that mixed up both numbers hears which of
  // them is wrong instead of "the parameters are invalid".
  const READ_OFFSET_MESSAGE = `offset muss eine ganze Zahl ab ${READ_OFFSET_DEFAULT} sein.`;
  const READ_MAX_CHARS_MESSAGE =
    `maxChars muss eine ganze Zahl von ${READ_MAX_CHARS_MIN} bis ${READ_MAX_CHARS_LIMIT} sein.`;
  // Spelled out instead of derived from `READ_MODES`: a third mode would be a contract
  // change, and whoever adds it should have to read this sentence rather than have it
  // change under the caller's feet.
  const READ_MODE_MESSAGE = 'mode muss "text" oder "article" sein.';
  // The empty string is a *set* value and no usable address: `includes("")` matches
  // every frame, so it would silently become "the first frame that answers".
  const FRAME_MESSAGE = "frame muss ein String sein.";
  // Not the page's words: the caller reads the bridge's sentence for both codes, and
  // these two only have to say what happened in a log or a `details.message`.
  const FRAME_NOT_FOUND_MESSAGE = "Kein Rahmen passt zum angegebenen frame.";
  const FRAME_AMBIGUOUS_MESSAGE = "Mehrere Rahmen passen zum angegebenen frame.";
  const FRAMES_FAILED_MESSAGE = "Das Ergebnis der Rahmen-Injektion war unbrauchbar.";
  const INSPECT_INCLUDE_HIDDEN_MESSAGE = "includeHidden muss true oder false sein.";
  const INSPECT_FAILED_MESSAGE = "Das Ergebnis der Abfrage-Injektion war unbrauchbar.";
  const FOCUS_FAILED_MESSAGE = "Das Aktualisieren von Tab oder Fenster ist fehlgeschlagen.";
  const TRANSCRIPT_FAILED_MESSAGE = "Das Transkript der Seite konnte nicht gelesen werden.";
  // The page passed both gates and handed out no player response at all. Its own sentence
  // because the caller's next step differs from "the video has no subtitles": here the
  // page is not the shape this tool knows, and a reload may well help.
  const TRANSCRIPT_NO_MODEL_MESSAGE =
    "Das Datenmodell des Players war auf dieser Seite nicht zu finden.";
  // Not a page that failed: a page this tool does not read. The sentence names the one
  // address shape it accepts, because that is what the caller has to change.
  const TRANSCRIPT_NOT_YOUTUBE_MESSAGE =
    "Das Werkzeug liest nur YouTube-Watch-Seiten (youtube.com/watch).";
  // The menu answers below are failures of the *player's* menu, not of the video: the track
  // may well exist, but this snippet was not able to address it. None of them names an
  // entry of the list as an address — the entries are language names (M13).
  const TRANSCRIPT_MENU_ROW_MISSING_MESSAGE =
    "Die Spuren-Zeile im Einstellungsmenü des Players wurde nicht gefunden.";
  const TRANSCRIPT_MENU_ROW_AMBIGUOUS_MESSAGE =
    "Mehrere Zeilen im Einstellungsmenü des Players tragen einen Sprachnamen.";
  // No player element at all: the page is a watch page, but nothing here can be moved.
  const TRANSCRIPT_NO_PLAYER_MESSAGE = "Der Player der Seite wurde nicht gefunden.";
  // The refusals of the menu snippet — all decided *before* it clicks an entry, which is why
  // a run that ends in one of them has no track to put back (review m5).
  const TRANSCRIPT_MENU_REFUSALS = [
    "no_row",
    "row_ambiguous",
    "row_miscount",
    "no_match",
    "ambiguous",
  ];
  // The click on a track entry left the player's mark on the old entry. The entry was there
  // and was clicked, so this is not a wrong menu: the pick did not happen, and waiting for a
  // file the player will never fetch would only turn this into a timeout (review m6).
  function transcriptMenuNotSetMessageFor(trackName) {
    return `Die Spur "${trackName}" ist nach dem Klick im Menü nicht gesetzt.`;
  }
  // The video has no subtitle track. Since spec 33 the panel is not read any more and the
  // code means "the model carries no `captionTracks`" — the name is the one `docs/32` put
  // on the wire, and renaming it would be a new code. The sentence below still describes
  // the panel, because the bridge replaces it with its own; that rewrite is its stage.
  const NO_TRANSCRIPT_PANEL_MESSAGE = "Auf dieser Seite ist kein Transkript-Panel zu finden.";
  // `focus` takes no arguments but `tab`, so a caller that passes anything else is
  // told instead of having its argument silently dropped.
  const FOCUS_PARAMS_MESSAGE = "focus nimmt keine Parameter außer tab.";
  // The one sentence for a `tab` no tool can act on: `"31"`, `0` and `-1` are all the
  // same mistake to the caller, who named a tab that is not a tab id.
  const INVALID_TAB_MESSAGE = "tab muss eine positive ganze Zahl sein.";
  // Never the content: this line lands on the operator's console, and the page
  // may be their mailbox.
  const UNUSABLE_READ_RESULT_LOG_LINE = "bc: read result without usable text";
  const UNUSABLE_CLICK_RESULT_LOG_LINE = "bc: click result without a known outcome";
  const UNUSABLE_TYPE_RESULT_LOG_LINE = "bc: type result without a known outcome";
  const UNUSABLE_INSPECT_RESULT_LOG_LINE = "bc: inspect result without usable elements";
  const UNUSABLE_EVAL_RESULT_LOG_LINE = "bc: eval result without a known outcome";
  // The one line the settle wait leaves behind when it did not happen at all. Fixed
  // and content-free like the others, and it exists for a single question: after a
  // live run, `waitedMs: 0` either means "the browser did not await the promise"
  // (no line) or "the wait never ran" (this line). Without it the two are the same
  // observation, and no measurement can tell the mechanism from its absence.
  const SETTLE_WAIT_FAILED_LOG_LINE = "bc: settle wait not carried out";
  const PASSWORD_OPTION_READ_FAILED_LOG_LINE =
    "bc: Passwort-Option nicht lesbar, Passwortfelder bleiben gesperrt";
  const EVAL_OPTION_READ_FAILED_LOG_LINE =
    "bc: Option für Code-Auswertung nicht lesbar, Auswertung bleibt gesperrt";

  /* ------------------------------------------------------------------ eval */

  // How long a promise the code returns may hold the answer. The code itself cannot
  // be interrupted — only the *answer* stops waiting — so this is a deadline for the
  // call, not for the page.
  const EVAL_TIMEOUT_MS = 2000;
  // The extension's own deadline, `EVAL_TIMEOUT_MS` plus air. It exists because a page
  // timer is not a promise: Firefox throttles timers in a window that is not focused,
  // so the page-side deadline can arrive seconds late — and without this guard the
  // caller would wait for `CALL_TIMEOUT_MS` (20 s) and hear `ExtensionTimeout` instead
  // of `eval_timeout`. Measured for `read` first (spec 14, `docs/PROJECT-STATE.md`), so
  // this is a copied rule, not a second opinion.
  const EVAL_GUARD_MS = EVAL_TIMEOUT_MS + 500;
  // The code limit of the contract: 20 000 characters travel as a JSON literal into
  // the page, so the message limit is the wall this keeps a call away from.
  // Refusing here is cheap; discovering it at the frame is a closed socket.
  const EVAL_CODE_LIMIT = 20000;
  // The result limit, and a refusal rather than a cut: half a JSON is no answer. A
  // caller who needs a list is served by `inspect`.
  const EVAL_RESULT_LIMIT = 10000;
  // A thrown message is the page's words — cut to something a caller can read, and
  // without a stack, because that stack is our side and not the caller's.
  const EVAL_MESSAGE_LIMIT = 500;

  const EVAL_NOT_ALLOWED_CODE = "eval_not_allowed";
  const EVAL_FAILED_CODE = "eval_failed";
  const EVAL_TIMEOUT_CODE = "eval_timeout";
  const EVAL_RESULT_TOO_LARGE_CODE = "eval_result_too_large";
  const EVAL_RESULT_UNSERIALIZABLE_CODE = "eval_result_unserializable";

  // Quoted from the wire protocol and kept in step with the bridge by hand, like
  // `TOO_MANY_TABS_MESSAGE`: both suites assert this exact sentence, so a rewrite on
  // one side turns a test red instead of drifting silently.
  const EVAL_NOT_ALLOWED_MESSAGE =
    "Code-Auswertung ist in den Einstellungen der Erweiterung nicht erlaubt.";
  // The sentence for every outcome nobody can read — our own bugs included. A page's
  // own error text never lands here; it arrives through `EvalError` below.
  const EVAL_FAILED_MESSAGE = "Das Ergebnis der Auswertung war unbrauchbar.";
  const EVAL_TIMEOUT_MESSAGE =
    `Der Code hat nicht innerhalb von ${EVAL_TIMEOUT_MS} ms geantwortet.`;
  const EVAL_RESULT_TOO_LARGE_MESSAGE =
    `Das Ergebnis ist größer als ${EVAL_RESULT_LIMIT} Zeichen JSON.`;
  const EVAL_RESULT_UNSERIALIZABLE_MESSAGE = "Das Ergebnis lässt sich nicht auf JSON abbilden.";
  const MISSING_EVAL_CODE_MESSAGE = "eval braucht code als String.";
  const EMPTY_EVAL_CODE_MESSAGE = "code darf nicht leer sein.";
  const EVAL_CODE_TOO_LONG_MESSAGE = `code darf höchstens ${EVAL_CODE_LIMIT} Zeichen lang sein.`;

  /* ------------------------------------------------------------ screenshot */

  // The wall for the *decoded* picture. Base64 of it is 4 194 304 bytes (3 145 728 ×
  // 4/3, and a power-of-two count needs no `=` padding), which still fits under
  // `PROTOCOL.MAX_MESSAGE_BYTES` (5 242 880) with 1 048 576 bytes of air for the frame
  // around it — the limit is drawn here, deliberately, and not left to the socket.
  const SCREENSHOT_MAX_BYTES = 3145728;
  // The ladder is contract, not optimisation (spec 20): stage 0 is the capture itself,
  // the later stages are JPEG re-encodes — the same edge at two qualities, then fewer
  // pixels. `maxEdge: null` is stage 0's way of saying "nothing to scale": that stage is
  // only ever described here, never encoded (a PNG re-encode of a PNG is the same
  // picture twice, and a shrunk PNG of a photo-heavy page is still too big).
  const SCREENSHOT_SCALE_STEPS = [
    { maxEdge: null, format: "png" },
    { maxEdge: 1600, quality: 0.75 },
    { maxEdge: 1600, quality: 0.5 },
    { maxEdge: 1200, quality: 0.6 },
  ];
  // One deadline *per stage*, not one around the ladder: a decode that never finishes
  // must not hold the call open (spec 20, `## Risiken`), and a slow first stage must not
  // eat the last one's time. 3 000 ms is a decode plus a draw of a full viewport with
  // room to spare; a fourth stage would not fit this increment.
  const SCREENSHOT_ENCODE_TIMEOUT_MS = 3000;
  // A browser message about a page it will not photograph is the browser's words: cut
  // to something a caller can read, and without a stack, because that stack is our
  // side. The same value as `EVAL_MESSAGE_LIMIT`, so one trimmed message looks like the
  // other.
  const SCREENSHOT_MESSAGE_LIMIT = 500;

  const SCREENSHOT_NOT_ALLOWED_CODE = "screenshot_not_allowed";
  const SCREENSHOT_TOO_LARGE_CODE = "screenshot_too_large";
  const SCREENSHOT_FAILED_CODE = "screenshot_failed";

  // Quoted from the wire protocol and kept in step with the bridge by hand, like
  // `EVAL_NOT_ALLOWED_MESSAGE`: both suites assert this exact sentence, so a rewrite on
  // one side turns a test red instead of drifting silently.
  const SCREENSHOT_NOT_ALLOWED_MESSAGE =
    "Bildschirmfotos sind in den Einstellungen der Erweiterung nicht erlaubt.";
  // The sentence for every outcome nobody can read — our own bugs included. A browser's
  // own rejection text never lands here; `captureAgentTab` cuts it into a
  // `ScreenshotError` instead.
  const SCREENSHOT_FAILED_MESSAGE = "Das Bild konnte nicht aufgenommen werden.";
  // `screenshot` takes no arguments but `tab`, so a caller that passes anything else is
  // told instead of having its argument silently dropped — same rule as `focus`.
  const SCREENSHOT_PARAMS_MESSAGE = "screenshot nimmt keine Parameter außer tab.";
  const SCREENSHOT_OPTION_READ_FAILED_LOG_LINE =
    "bc: Option für Bildschirmfotos nicht lesbar, Aufnahme bleibt gesperrt";

  const TAB_STATUS_COMPLETE = "complete";
  const TAB_STATUS_LOADING = "loading";
  // The two sources the injected code may name. The page-side literal and this
  // list cannot share one constant: only what `readPageSource` closes over
  // survives the `toString()` trip into the page.
  const TEXT_SOURCES = ["innerText", "textContent"];

  // What `read` reports when the wait did not happen: the tab was loading, the
  // injection was refused, the page had no `MutationObserver`, or the snippet never
  // answered. Frozen because it is handed out as a value and spread into results —
  // a caller mutating it would change the answer of every later read.
  const NO_SETTLE = Object.freeze({ settled: false, waitedMs: 0 });

  // What a wait reports when its caller was replaced. Same two values on the wire as
  // `NO_SETTLE` — the distinction exists only in the control flow, as an identity:
  // `click` has to tell "the page said nothing, wait the old 300 ms" from "nobody is
  // listening any more, do not wait a millisecond". Spreading this would erase it,
  // which is why it is handed out as itself and never copied.
  const SUPERSEDED_SETTLE = Object.freeze({ settled: false, waitedMs: 0 });

  // The outcomes the injected click snippet may report. Anything else is our own
  // bug, the same way an unknown `via` is for a read. Every outcome but `clicked`
  // is a refusal, and its message is what the operator reads next to the code.
  const CLICK_OUTCOMES = ["clicked", "invalid_selector", "no_match", "not_clickable"];
  const CLICK_REFUSAL_MESSAGES = Object.freeze({
    invalid_selector: INVALID_SELECTOR_MESSAGE,
    no_match: NO_MATCH_MESSAGE,
    not_clickable: NOT_CLICKABLE_MESSAGE,
  });

  // The same shape for `type`. `type_failed` sits in the refusal list because the
  // snippet reports it as an outcome: the field has no native value setter, which
  // is a property of the page, not a bug of this module.
  const TYPE_OUTCOMES = [
    "typed",
    "invalid_selector",
    "no_match",
    "not_typeable",
    "password_not_allowed",
    "type_failed",
  ];
  const TYPE_REFUSAL_MESSAGES = Object.freeze({
    invalid_selector: INVALID_SELECTOR_MESSAGE,
    no_match: NO_MATCH_MESSAGE,
    not_typeable: NOT_TYPEABLE_MESSAGE,
    password_not_allowed: PASSWORD_NOT_ALLOWED_MESSAGE,
    type_failed: TYPE_FAILED_MESSAGE,
  });

  const STARTUP_LOG_LINE = "bc: background page started";
  const MISSING_SETTINGS_LOG_LINE =
    "bc: Endpunkt oder Token fehlt in den Optionen — es wird keine Verbindung aufgebaut";
  const SETTINGS_READ_FAILED_LOG_LINE = "bc: Einstellungen nicht lesbar, neuer Versuch mit Backoff";
  const INVALID_ENDPOINT_LOG_PREFIX = "bc: Endpunkt ungültig:";
  const RECONNECT_LOG_PREFIX = "bc: neuer Verbindungsversuch in";

  let socket = null;
  // Consecutive failed attempts. Reset to 0 by `welcome`, so a reload of the
  // extension reconnects in about a second instead of the last backoff step.
  let reconnectAttempt = 0;
  let connectedAt = null;
  // Only the operator matters here: one message about the missing settings, not
  // one per reconnect.
  let missingSettingsLogged = false;
  // The calls that have not answered yet, one entry per tab: a navigation, a click
  // or a type — all three change the page, so two of them must not race for the
  // same tab. The newer call ends the older one of *that* tab with `superseded`
  // (click, type) or `complete: false` (navigate); a call in another tab is not in
  // its way (spec 17).
  //
  // Keyed by the tab id, spelled out at every `set`. The values are only read back
  // through `releasePageSlot`, which compares identity, so they may be of either
  // shape: a claim slot from `claimPageSlot`, or the `{finish}`-shaped object
  // `startNavigation` returns. Nothing here assumes more than `finish`.
  const pageSlots = new Map();
  // Tail of the tab store chain; see `enqueueTabStore`.
  let tabStoreTail = Promise.resolve();

  function asText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  async function readSettings() {
    const stored = await browser.storage.local.get([ENDPOINT_KEY, TOKEN_KEY]);
    return {
      endpoint: asText(stored[ENDPOINT_KEY]),
      token: asText(stored[TOKEN_KEY]),
    };
  }

  /**
   * Whether the operator unlocked password fields — default `false`.
   *
   * A storage that cannot be read counts as locked: an unknown answer must never
   * be the permissive one. `console.warn` and not `throw`, so a broken
   * `storage.local` refuses password fields instead of ending every `type` call.
   */
  async function passwordFieldsAllowed() {
    try {
      // Array form like `readSettings`: the stub mirrors only the array and the
      // object form, and a wrong form would look "correctly locked" for the wrong
      // reason.
      const stored = await browser.storage.local.get([ALLOW_PASSWORD_FIELDS_KEY]);
      return stored?.[ALLOW_PASSWORD_FIELDS_KEY] === true;
    } catch (error) {
      console.warn(PASSWORD_OPTION_READ_FAILED_LOG_LINE, error);
      return false;
    }
  }

  /**
   * Whether the operator unlocked code evaluation — default `false`.
   *
   * The twin of `passwordFieldsAllowed`, deliberately line for line: only the boolean
   * `true` opens, and an unreadable storage counts as *off*. That is contract and not
   * an implementation detail here — this switch hands out arbitrary code in the page,
   * so the unknown answer has to be the closed one.
   */
  async function evalAllowed() {
    try {
      const stored = await browser.storage.local.get([ALLOW_EVAL]);
      return stored?.[ALLOW_EVAL] === true;
    } catch (error) {
      console.warn(EVAL_OPTION_READ_FAILED_LOG_LINE, error);
      return false;
    }
  }

  async function connect() {
    let settings;
    try {
      settings = await readSettings();
    } catch (error) {
      // The settings live in `storage.local`, which is not supposed to fail; if
      // it does, retrying is still better than going silent forever.
      console.error(SETTINGS_READ_FAILED_LOG_LINE, error);
      scheduleReconnect(reconnectAttempt + 1);
      return;
    }

    // Not in `readSettings`: the endpoint that is dialled is the fallback, not a
    // stored value, and nothing may write it back to the operator's settings.
    if (settings.endpoint === "") settings.endpoint = DEFAULT_ENDPOINT;

    if (settings.endpoint === "" || settings.token === "") {
      if (!missingSettingsLogged) {
        missingSettingsLogged = true;
        console.warn(MISSING_SETTINGS_LOG_LINE);
      }
      return;
    }

    try {
      openSocket(settings);
    } catch {
      // Not a failed dial but a rejected endpoint: `new WebSocket(...)` parses
      // the URL synchronously and throws a `SyntaxError` for anything that is
      // no `ws:`/`wss:` URL, so no `close` event ever arrives. Without this
      // catch the retry loop ends here and the background page stays silent
      // until it is reloaded — and nobody watches a background console.
      // The error object is not logged: it is not needed to fix a typo, and
      // `settings` next to it carries the token.
      console.error(INVALID_ENDPOINT_LOG_PREFIX, settings.endpoint);
      scheduleReconnect(reconnectAttempt + 1);
      return;
    }
  }

  function openSocket(settings) {
    const nextSocket = new WebSocket(settings.endpoint);
    socket = nextSocket;

    nextSocket.addEventListener("open", () => {
      void sendHello(nextSocket, settings);
    });
    nextSocket.addEventListener("message", (event) => {
      void onMessage(nextSocket, event.data);
    });
    // Without a listener a failed dial shows up as an unhandled error; the
    // `close` event that always follows it is what schedules the retry.
    nextSocket.addEventListener("error", () => {});
    nextSocket.addEventListener("close", () => onSocketClosed(nextSocket));
  }

  async function sendHello(target, settings) {
    send(target, {
      type: PROTOCOL.TYPES.HELLO,
      protocol: PROTOCOL.VERSION,
      extensionVersion: browser.runtime.getManifest().version,
      browser: await readBrowserIdentity(),
      token: settings.token,
    });
  }

  async function readBrowserIdentity() {
    try {
      const info = await browser.runtime.getBrowserInfo();
      return { name: asText(info?.name), version: asText(info?.version) };
    } catch (error) {
      // Reporting the browser is informational; a missing API must not keep the
      // operator offline.
      console.warn("bc: Browserkennung nicht lesbar", error);
      return { name: "unknown", version: "" };
    }
  }

  function send(target, message) {
    // A close can race with a pending answer; sending on a closing socket throws.
    if (target.readyState !== WEBSOCKET_OPEN) return;
    target.send(JSON.stringify(message));
  }

  async function onMessage(target, raw) {
    const message = parseJsonObject(raw);
    if (message === null) return;

    if (message.type === PROTOCOL.TYPES.WELCOME) {
      onWelcome();
      return;
    }
    if (message.type === PROTOCOL.TYPES.REQUEST) {
      await answerRequest(target, message);
      return;
    }
    // Unknown types stay unanswered on purpose: a newer bridge may send types
    // this version does not know, and inventing a reply is worse than silence.
  }

  function onWelcome() {
    // The extension's clock is the only one that knows when the handshake
    // finished; the bridge takes `connectedAt` from the status result.
    connectedAt = new Date().toISOString();
    reconnectAttempt = 0;
  }

  async function answerRequest(target, request) {
    if (!Number.isInteger(request.id)) return;

    if (request.method === PROTOCOL.METHODS.NAVIGATE) {
      await answerNavigate(target, request);
      return;
    }

    if (request.method === PROTOCOL.METHODS.READ) {
      await answerRead(target, request);
      return;
    }

    if (request.method === PROTOCOL.METHODS.CLICK) {
      await answerClick(target, request);
      return;
    }

    if (request.method === PROTOCOL.METHODS.TYPE) {
      await answerType(target, request);
      return;
    }

    if (request.method === PROTOCOL.METHODS.FOCUS) {
      await answerFocus(target, request);
      return;
    }

    if (request.method === PROTOCOL.METHODS.INSPECT) {
      await answerInspect(target, request);
      return;
    }

    if (request.method === PROTOCOL.METHODS.OPEN_TAB) {
      await answerOpenTab(target, request);
      return;
    }

    if (request.method === PROTOCOL.METHODS.CLOSE_TAB) {
      await answerCloseTab(target, request);
      return;
    }

    if (request.method === PROTOCOL.METHODS.EVAL) {
      await answerEval(target, request);
      return;
    }

    if (request.method === PROTOCOL.METHODS.SCREENSHOT) {
      await answerScreenshot(target, request);
      return;
    }

    if (request.method === PROTOCOL.METHODS.FRAMES) {
      await answerFrames(target, request);
      return;
    }

    if (request.method === PROTOCOL.METHODS.TRANSCRIPT) {
      await answerTranscript(target, request);
      return;
    }

    if (request.method !== PROTOCOL.METHODS.STATUS) {
      sendResponse(target, request.id, {
        ok: false,
        error: {
          code: UNSUPPORTED_METHOD_CODE,
          message: `unsupported method: ${String(request.method)}`,
        },
      });
      return;
    }

    try {
      sendResponse(target, request.id, { ok: true, result: await collectStatus() });
    } catch (error) {
      sendResponse(target, request.id, {
        ok: false,
        error: { code: STATUS_FAILED_CODE, message: describeError(error) },
      });
    }
  }

  function sendResponse(target, id, payload) {
    send(target, { type: PROTOCOL.TYPES.RESPONSE, id, ...payload });
  }

  function describeError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function parseJsonObject(raw) {
    if (typeof raw !== "string") return null;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  }

  async function collectStatus() {
    const windows = await browser.windows.getAll({ populate: true });
    // Read once, not per tab: the ids are a convenience, and a store that refuses
    // to answer must cost the mark, not the status. A catch-all without
    // `instanceof` — `storage.local.get` rejects with a plain `Error`, and there
    // is nothing to tell apart here. No log line either: the caller never asked
    // about the settings, and the answer already says no tab is marked.
    //
    // No `pruneAgentTabIds` on this path, on purpose: the window list is the truth
    // here, so an id with no tab marks nothing by itself — and a `tabs.get` per
    // stored id would make the cheapest call of the extension the most expensive.
    let agentTabIds = new Set();
    try {
      agentTabIds = new Set(await readAgentTabIds());
    } catch {
      // Deliberately silent: the set stays empty, so no tab gets the mark.
    }
    return {
      extension: {
        version: browser.runtime.getManifest().version,
        connectedAt,
      },
      // An arrow, not `map(toWindowSummary)`: `map` would hand the number in as the
      // last argument, and the first thing `toTabSummary` does with it is `.has` —
      // a `Map`/`Set` method a number does not have. The arrow is what keeps the set.
      windows: asArray(windows).filter(isInspectableWindow).map((window) => toWindowSummary(window, agentTabIds)),
    };
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  /**
   * Private windows are `type: "normal"` in Firefox too and only differ by
   * `incognito`; without that check an empty window would show up in the list.
   */
  function isInspectableWindow(window) {
    return window.type === NORMAL_WINDOW_TYPE && !window.incognito;
  }

  function toWindowSummary(window, agentTabIds) {
    return {
      id: window.id,
      focused: Boolean(window.focused),
      type: window.type,
      tabs: asArray(window.tabs).filter(isDefaultContainerTab).map((tab) => toTabSummary(tab, agentTabIds)),
    };
  }

  function isDefaultContainerTab(tab) {
    return tab.cookieStoreId === DEFAULT_COOKIE_STORE_ID;
  }

  /**
   * One tab of the status answer. The mark sits here, in the function that shapes
   * a *single* tab, so a later field-by-field rewrite cannot forget it.
   *
   * A stale id and an id in a container need no check of their own: the tab list
   * is already filtered to the default container, so such an id simply matches
   * nothing.
   */
  function toTabSummary(tab, agentTabIds) {
    return {
      id: tab.id,
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      agent: agentTabIds.has(tab.id),
      // `about:newtab` has no url right after opening; the key is expected by
      // the bridge, so an empty string beats a missing field.
      url: tab.url ?? "",
      title: tab.title ?? "",
    };
  }

  /* --------------------------------------------------------------- navigate */

  /**
   * A refusal the extension decides on. It carries the code the wire protocol
   * names, so the catcher can forward the decision instead of guessing it.
   */
  class NavigateError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "NavigateError";
      this.code = code;
    }
  }

  /**
   * Answers one `navigate` request: a URL in, the five result fields out.
   *
   * `NavigateError` carries the codes the extension itself assigns; everything
   * else — a `tabs.create` that fails, say — is gathered under `navigate_failed`,
   * because the caller can only be told that the browser refused.
   */
  async function answerNavigate(target, request) {
    try {
      sendResponse(target, request.id, { ok: true, result: await navigate(request.params) });
    } catch (error) {
      sendResponse(target, request.id, { ok: false, error: navigateErrorFor(error) });
    }
  }

  function navigateErrorFor(error) {
    if (error instanceof NavigateError) return { code: error.code, message: error.message };
    return { code: NAVIGATE_FAILED_CODE, message: describeError(error) };
  }

  async function navigate(params) {
    // The parameters are checked before anything else — including before a running
    // navigation is ended: a refused request must not kill an allowed one.
    const requestedUrl = navigateRequestUrl(params);
    const requestedTabId = requestTabId(params, NavigateError);
    const target = await enqueueTabStore(() => resolveNavigationTarget(requestedUrl, requestedTabId));

    // Before the answer, not after: a request for the address the tab already
    // shows answers immediately, and the replaced request must not be left
    // waiting for a page nobody is loading any more. Only *this* tab's slot is
    // resolved — a navigation in another tab keeps its own, see spec 17.
    supersedePageSlot(target.tab.id);

    const navigation = startNavigation(target, requestedUrl);
    pageSlots.set(target.tab.id, navigation);
    try {
      return await navigation.answer;
    } finally {
      // Only if this navigation still owns the slot: by now a successor may have
      // taken it over, and clearing it here would hide that successor.
      releasePageSlot(target.tab.id, navigation);
    }
  }

  /**
   * Runs one change of the agent tabs after the previous one finished.
   *
   * Two `navigate` calls in the same tick would otherwise both read the still empty
   * `agentTabIds` and both create a tab — one of them an orphan in the operator's
   * tab bar. Chaining them keeps the read-check-create sequence of one call inside
   * itself; a failure must neither break the chain nor go unhandled.
   *
   * Never call it from inside a task it already runs: the chain would wait for the
   * task, and that task for the chain.
   */
  function enqueueTabStore(storeChange) {
    const result = tabStoreTail.then(storeChange, storeChange);
    tabStoreTail = result.then(ignoreOutcome, ignoreOutcome);
    return result;
  }

  function ignoreOutcome() {}

  /**
   * Ends the running call in `tabId` with `complete: false` (navigate) or
   * `superseded` (click, type). Other tabs are untouched: their slots have their own
   * keys, and a call in one of them is not racing this one.
   *
   * Its fields come from what that call already knows; nothing is read again. A late
   * `tabs.get` could return the *successor's* page and report it as the answer to the
   * request that was just replaced.
   *
   * The entry is deleted *before* `finish()`, and that order is load-bearing: `finish`
   * releases the predecessor's wait, and its `finally` follows. Whatever that
   * `finally` sees must be "no entry here", never the entry of the successor that the
   * caller sets right after this returns.
   */
  function supersedePageSlot(tabId) {
    const previous = pageSlots.get(tabId);
    if (previous === undefined) return;
    pageSlots.delete(tabId);
    previous.finish();
  }

  /**
   * The two-phase wait of one navigation: `complete` first, then the quiet.
   *
   * The settle is opened only in the second phase, so a page that never reports
   * itself costs no injection at all. Both phases hang off the *one* `finish` of the
   * navigation object: a successor supersedes a navigation, not two waits, and it
   * must reach whichever wait is armed.
   *
   * `alreadyThere` never waits — no load and no quiet: the page the tab already shows
   * is not being loaded again, and the fixed fallback of `click` has no counterpart
   * here.
   */
  function startNavigation(target, requestedUrl) {
    const known = knownTabState(target.tab, requestedUrl);
    if (target.alreadyThere) {
      return finishedNavigation(navigationResult(known, target.tab, NO_SETTLE));
    }
    const wait = waitForTabComplete(known.tabId, target.previousUrl);
    // Reached by `finish` from outside, and only ever after the load phase: before
    // that there is no settle to end, so the no-op default answers for it.
    let finishSettle = () => {};
    return {
      finish: () => {
        wait.finish();
        finishSettle();
      },
      answer: wait.settled.then((loadedTab) => {
        // `null` is both exits of the load phase — the time limit and a successor —
        // and neither may inject anything: nobody is waiting for this page any more.
        if (loadedTab === null) return navigationResult(known, loadedTab, NO_SETTLE);
        const settle = settleWindow(known.tabId);
        finishSettle = settle.finish;
        return settle.answer.then((outcome) => navigationResult(known, loadedTab, outcome));
      }),
    };
  }

  /** A navigation with nothing to wait for — and therefore nothing to end. */
  function finishedNavigation(answer) {
    return { finish: () => {}, answer: Promise.resolve(answer) };
  }

  /**
   * What resolving a tab produced, so a wait can tell the old page from the new.
   *
   * `previousUrl` is the address the tab showed *before* it was sent to the new
   * one: a `tabs.get` directly after `tabs.update` still reports that page's
   * `complete`, and trusting it is how `navigate` once answered the previous page
   * in a real run. It stays `null` for a freshly created tab, which has no
   * earlier page it could be mistaken for.
   *
   * `alreadyThere` marks the one case that needs no wait at all.
   */
  function navigationTarget(tab, previousUrl, alreadyThere = false) {
    return { tab, previousUrl, alreadyThere };
  }

  /** What a navigation can say about its tab without asking the browser again. */
  function knownTabState(tab, requestedUrl) {
    // A tab that only reports `about:` shows no page of this navigation, so it has
    // neither a URL nor a title to contribute — and the requested address is the
    // honest answer, see `about:` in the spec.
    const showsPage = !isAboutAddress(tab.url);
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      // `create`/`update` may answer with a normalised URL; the request is the
      // fallback that always says what was asked for.
      url: (showsPage && asText(tab.url)) || requestedUrl,
      title: showsPage ? asText(tab.title) : "",
    };
  }

  /**
   * The seven fields of a navigate answer, `settled`/`waitedMs` behind `complete`.
   *
   * `settle` is the settle outcome of the second phase — or, for a navigation that
   * was overtaken *during* that phase, the `SUPERSEDED_SETTLE` sentinel. The sentinel
   * is control flow and never a result: the page really did load, so `complete` stays
   * true, and the quiet it never observed is reported as `NO_SETTLE`.
   */
  function navigationResult(known, loadedTab, settle) {
    const complete = loadedTab !== null;
    const waited = settle === SUPERSEDED_SETTLE ? NO_SETTLE : settle;
    return {
      tabId: known.tabId,
      windowId: known.windowId,
      // After loading the tab wins, so redirects and error pages become visible;
      // an interrupted wait has nothing better than what it already knew.
      url: (complete && asText(loadedTab.url)) || known.url,
      title: complete ? asText(loadedTab.title) : known.title,
      complete,
      settled: waited.settled,
      waitedMs: waited.waitedMs,
    };
  }

  /**
   * Waits for `tabId` to report the newly requested page as `complete`, at most
   * NAVIGATE_TIMEOUT_MS.
   *
   * `settled` resolves with the loaded tab, or with `null` when the wait ended
   * without one — time limit, or a successor calling `finish()`. Both exits share
   * one idempotent `finish()`, which removes the listener through the *stored*
   * reference: `removeListener` with a freshly built closure removes nothing and
   * leaves one listener behind per navigation.
   */
  function waitForTabComplete(tabId, previousUrl) {
    let timer = null;
    // Assigned inside the promise executor; a successor navigation outside has to
    // reach that same settle path, hence the variable.
    let finish = () => {};

    const settled = new Promise((resolve) => {
      let finished = false;

      const settle = (tab) => {
        if (finished) return;
        finished = true;
        browser.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve(tab);
      };
      finish = () => settle(null);

      const onUpdated = (changedTabId, changeInfo) => {
        // Other tabs navigate all the time — the operator's own browsing must
        // never answer the agent's request.
        if (changedTabId !== tabId) return;
        if (changeInfo?.status !== TAB_STATUS_COMPLETE) return;
        void readTabOrNull(tabId).then((tab) => {
          // A `complete` about `about:blank` is the tab being dragged between
          // windows, not the page the request asked for: keep waiting for the next
          // event, or for the time limit.
          if (isAboutAddress(tab?.url)) return;
          settle(tab);
        });
      };

      // Listener first, then the check: a page that is already loaded when the
      // listener goes up (a cached page, a redirect that finished early) would
      // otherwise have reported its `complete` before anyone listened, and the
      // call would wait the full 8 s and then claim `complete: false` about a
      // page that is there.
      browser.tabs.onUpdated.addListener(onUpdated);
      void readTabOrNull(tabId).then((tab) => {
        if (reportsLoadedPage(tab, previousUrl)) settle(tab);
      });

      timer = setTimeout(() => settle(null), NAVIGATE_TIMEOUT_MS);
    });

    // By now the executor has run, so `finish` is the real one.
    return { settled, finish };
  }

  /**
   * What a `navigate` targets: the tab named `tabIdOrNothing`, or — for a call without
   * a `tab` — the last used one, replaced by a fresh tab when there is none left.
   *
   * The window is chosen *first*. `tabs.create` without `windowId` puts the tab
   * into the current window, which may be a private one; such a tab is never in
   * the default container and would be discarded on the next call — one new tab
   * per navigation, visible to the operator as a growing tab bar.
   *
   * A call that names a `tab` never creates one: the caller asked about *that* tab,
   * and a fresh tab in its place would be a page nobody asked for. Hence
   * `no_agent_tab`, and hence the `createWhenGone` flag on `updateOrCreateTab`.
   */
  async function resolveNavigationTarget(url, tabIdOrNothing) {
    const window = await selectAgentWindow();
    if (window === null) {
      throw new NavigateError(NO_DEFAULT_WINDOW_CODE, NO_DEFAULT_WINDOW_MESSAGE);
    }

    const existingTab = await resolveAgentTab(tabIdOrNothing);
    if (existingTab === null) {
      if (tabIdOrNothing !== null) {
        throw new NavigateError(NO_AGENT_TAB_CODE, NO_AGENT_TAB_MESSAGE);
      }
      return navigationTarget(await createAgentTab(url, window.id), null);
    }
    return updateOrCreateTab(existingTab, url, window.id, tabIdOrNothing === null);
  }

  /** The focused normal window, else the first normal window, else `null`. */
  async function selectAgentWindow() {
    const inspectable = asArray(await browser.windows.getAll()).filter(isInspectableWindow);
    return inspectable.find((window) => window.focused === true) ?? inspectable[0] ?? null;
  }

  /**
   * The stored agent tabs, most recently used last.
   *
   * Reads the list *and* runs the migration of the previous increment's single
   * `agentTabId`: the first read after the update is the only moment we know the
   * new key has not been written yet, so the migration needs no step of its own. A
   * non-empty list is the newer truth and wins; an empty one against a usable old id
   * is a migration that never finished — most likely a `set` that threw — and there
   * the old id wins, otherwise the operator's tab is gone for good.
   *
   * The migration write is the one list change outside `enqueueTabStore`, because
   * every queued change reads the list first and a queued migration would wait for
   * the queue that waits for it. It is safe there: the conversion is idempotent, so
   * a lost race writes the same list twice, and the old key never survives a read
   * that could answer for it.
   */
  async function readAgentTabIds() {
    // Array form like `readSettings`: the stub mirrors only the array and the object
    // form, and the whole point of this read is that it asks for both keys at once.
    const stored = await browser.storage.local.get([AGENT_TAB_IDS_KEY, LEGACY_AGENT_TAB_ID_KEY]);
    const storedTabIds = asAgentTabIds(stored[AGENT_TAB_IDS_KEY]);
    const legacyTabId = stored[LEGACY_AGENT_TAB_ID_KEY];
    if (legacyTabId === undefined) return storedTabIds;

    if (storedTabIds.length === 0 && Number.isInteger(legacyTabId)) {
      return migrateAgentTabId(legacyTabId);
    }
    await removeLegacyAgentTabId();
    return storedTabIds;
  }

  /**
   * The stored value as a list of tab ids.
   *
   * Anything that is not an integer is dropped: the list is a hint the extension
   * writes, but `storage.local` is also what an operator with a console can edit.
   */
  function asAgentTabIds(value) {
    return asArray(value).filter((tabId) => Number.isInteger(tabId));
  }

  /**
   * Turns the old single id into a one-element list and drops the old key.
   *
   * The old key stays when the write failed: removing it would end every chance the
   * next read has of finding that tab again, while the answer of *this* read is the
   * same either way.
   */
  async function migrateAgentTabId(legacyTabId) {
    const stored = await storeAgentTabIds([legacyTabId]);
    if (stored) await removeLegacyAgentTabId();
    return [legacyTabId];
  }

  async function removeLegacyAgentTabId() {
    try {
      await browser.storage.local.remove(LEGACY_AGENT_TAB_ID_KEY);
    } catch (error) {
      // A key that stays behind costs one more migration attempt and nothing else.
      console.warn("bc: alte Agenten-Tab-Id nicht entfernt", error);
    }
  }

  /** Writes the whole list; `false` when the store refused, so the caller decides. */
  async function storeAgentTabIds(tabIds) {
    try {
      await browser.storage.local.set({ [AGENT_TAB_IDS_KEY]: [...tabIds] });
      return true;
    } catch (error) {
      // The list is a hint, not state: forgetting it costs one extra tab on the next
      // call, while throwing would fail a call that worked.
      console.warn("bc: Agenten-Tab-Ids nicht gespeichert", error);
      return false;
    }
  }

  /**
   * The list with `tabId` at its end.
   *
   * "Last used" *is* the order, so no second key can disagree with it, and closing a
   * tab moves the previous entry up for free. The existing entry moves instead of
   * being added a second time: a duplicate would make the list grow past the limit
   * spec 16 stage 4 enforces.
   */
  function withLastUsed(tabIds, tabId) {
    return [...tabIds.filter((storedTabId) => storedTabId !== tabId), tabId];
  }

  /**
   * Records `tabId` as the last used agent tab.
   *
   * Belongs *inside* `enqueueTabStore`, like every read-modify-write of the list: two
   * concurrent calls would otherwise read the same list, and the later write would
   * drop the entry of the earlier one. Enqueueing here instead would deadlock the
   * caller that already holds the queue — every caller of this function does.
   */
  async function markAgentTabLastUsed(tabId) {
    const currentTabIds = await readAgentTabIds();
    if (currentTabIds.at(-1) === tabId) return;
    await storeAgentTabIds(withLastUsed(currentTabIds, tabId));
  }

  /**
   * The surviving entries of `tabIds`: a tab that is gone, or that lives in a
   * container, is not addressable and falls out.
   *
   * Only the tool path prunes. `status` answers from the window list it already has,
   * where a dead id marks nothing by itself — pruning there would cost a `tabs.get`
   * per stored id on the cheapest call the extension has.
   */
  async function pruneAgentTabIds(tabIds) {
    const candidates = asAgentTabIds(tabIds);
    const tabs = await Promise.all(candidates.map((tabId) => findDefaultContainerTab(tabId)));
    return candidates.filter((tabId, index) => tabs[index] !== null);
  }

  /**
   * The `tab` of any tool call: a positive integer, or `null` for "the last used one".
   *
   * The error class is the caller's, not ours: every tool answers a wrong argument in
   * its own error type, so the check travels while the code's owner stays where the
   * code belongs. `0` and `-1` are refused as well — an id is positive by definition,
   * and a string `"31"` would address whatever `tabs.get` makes of it. Six tools share
   * this one check, which is the whole point of the function.
   */
  function requestTabId(params, RequestError) {
    const tab = params?.tab;
    if (tab === undefined) return null;
    if (!Number.isInteger(tab) || tab < 1) {
      throw new RequestError(INVALID_PARAMS_CODE, INVALID_TAB_MESSAGE);
    }
    return tab;
  }

  /**
   * The agent tab a call addresses, or the caller's own `no_agent_tab` refusal.
   *
   * Three steps that belong together, in one place: read the `tab` of the request,
   * resolve it *inside* the queue, and turn the empty result into a refusal. Every
   * tool that addresses a tab shares this, so no call site can forget the queue —
   * and the queue is what makes marking a tab as last used safe next to a
   * concurrent list change.
   *
   * `navigate` keeps its own entry into the queue: it resolves a *target* rather
   * than a tab, because a call without a `tab` may have to create one.
   */
  async function addressedAgentTab(params, RequestError) {
    const requestedTabId = requestTabId(params, RequestError);
    const tab = await enqueueTabStore(() => resolveAgentTab(requestedTabId));
    if (tab === null) {
      throw new RequestError(NO_AGENT_TAB_CODE, NO_AGENT_TAB_MESSAGE);
    }
    return tab;
  }

  /**
   * The agent tab a tool call addresses: the tab named `tabIdOrNothing`, or else the
   * last used one. `null` when there is none — the *caller* names that failure, because
   * each tool answers `no_agent_tab` in its own error type; `addressedAgentTab` does
   * both steps for every tool that only needs a tab.
   *
   * One place for all six tools, so "which tab is the agent's" cannot drift apart
   * between them — the five copies this replaces had exactly that risk.
   *
   * Only an id *in the list* is addressable: a tab of the operator's own, alive and in
   * the default container, is still not the agent's, and reading or clicking it would
   * reach a page nobody opened for the agent. Hence the membership check before the
   * lookup, and hence the mark below it — an id the caller invented never becomes
   * state.
   *
   * Must run inside `enqueueTabStore`: addressing a tab *is* a list change
   * (`markAgentTabLastUsed`), and a change outside the queue would race a concurrent
   * one. Enqueueing here instead would deadlock the caller that already holds it —
   * every caller does.
   */
  async function resolveAgentTab(tabIdOrNothing) {
    const tabIds = await readAgentTabIds();
    return tabIdOrNothing === null ? lastUsedAgentTab(tabIds) : namedAgentTab(tabIds, tabIdOrNothing);
  }

  /**
   * The tab a call named, or `null` when that id is not one of ours.
   *
   * No fallback: the caller asked about *that* tab, and answering with a different
   * one would reach a page nobody asked for.
   */
  async function namedAgentTab(tabIds, tabId) {
    if (!tabIds.includes(tabId)) return null;

    const tab = await findDefaultContainerTab(tabId);
    if (tab === null) return null;

    await markAgentTabLastUsed(tab.id);
    return tab;
  }

  /**
   * The last used tab, after the dead ids fell out of the list.
   *
   * The prune is the reason this is not two lines: a tab the operator closed stays in
   * the list until something reads the list, and the spec says stale ids fall out
   * *when reading*. Without the prune a closed last-used tab would answer
   * `no_agent_tab` while the agent tab right in front of it in the list is alive and
   * would have done fine — the dead entry is dropped, and the previous one moves up.
   *
   * The resolved tab is fetched once more even though `pruneAgentTabIds` just saw it:
   * that function promises ids, and a second report shape here would be a second thing
   * to keep right. One `tabs.get` is the cheaper price of the simpler contract.
   */
  async function lastUsedAgentTab(tabIds) {
    const liveTabIds = await pruneAgentTabIds(tabIds);
    if (liveTabIds.length !== tabIds.length) await storeAgentTabIds(liveTabIds);

    const tabId = liveTabIds.at(-1) ?? null;
    if (tabId === null) return null;

    const tab = await findDefaultContainerTab(tabId);
    if (tab === null) return null;

    // Already the end of the list, so this writes nothing — the call is here for the
    // one case that keeps a caller honest: a list whose order the prune just changed.
    await markAgentTabLastUsed(tab.id);
    return tab;
  }

  /** `null` for a tab that is gone or that lives in a container. */
  async function findDefaultContainerTab(tabId) {
    const tab = await readTabOrNull(tabId);
    return tab !== null && isDefaultContainerTab(tab) ? tab : null;
  }

  async function createAgentTab(url, windowId) {
    // `active: false`: the operator keeps reading the page they are on. The tab
    // only comes forward when a later `focus` asks for it.
    const tab = await browser.tabs.create({ url, active: false, windowId });
    // The list is rebuilt from what is still alive plus the new tab, in one write:
    // creating a tab means the one it replaces is gone, and appending to the corpses
    // would let the list creep up to the limit a later `open_tab` enforces. The pruned
    // list and the new id are composed *before* `storage.local` sees either.
    await storeAgentTabIds(withLastUsed(await pruneAgentTabIds(await readAgentTabIds()), tab.id));
    return tab;
  }

  /**
   * Sends `existingTab` to `url` — or, for `createWhenGone`, creates a tab instead.
   *
   * The flag is `navigate`'s promise about its own tab: only the path *without* a `tab`
   * may replace a tab that vanished between the lookup and the update. A named tab is
   * answerable as `no_agent_tab`, and answering with a different tab would be worse
   * than answering nothing. No warning on that path either: a closed tab is a normal
   * case, and the code already says which one it was.
   */
  async function updateOrCreateTab(existingTab, url, windowId, createWhenGone) {
    // Asking for the page that is already there is the one case that needs no
    // navigation: a same-URL `tabs.update` restarts the load, and the tab will not
    // report another `complete` for a page it never left. It only counts while the
    // tab is not in the middle of a load — `complete: true` would be a lie.
    if (isSameAddress(existingTab, url) && existingTab.status !== TAB_STATUS_LOADING) {
      return navigationTarget(existingTab, null, true);
    }

    try {
      const tab = await browser.tabs.update(existingTab.id, { url });
      return navigationTarget(tab, asUrl(existingTab.url));
    } catch (error) {
      // The tab has to be answerable as the tab it names — a named `tab` gets
      // `no_agent_tab` instead of a substitute nobody asked for.
      if (!createWhenGone) throw new NavigateError(NO_AGENT_TAB_CODE, NO_AGENT_TAB_MESSAGE);
      // The tab was closed between the check and the update — the same situation
      // as a stale stored id, and it ends the same way: a new tab, not an error.
      // The reason is worth a line anyway: every *other* failure lands here too,
      // and a silent second tab would hide it from the operator for good.
      console.warn("bc: Agenten-Tab nicht aktualisiert, neuer Tab wird angelegt", error);
      // The new tab has no earlier page, so the wait must not compare against the
      // closed tab's address either.
      return navigationTarget(await createAgentTab(url, windowId), null);
    }
  }

  /** Whether the tab already shows `url`, compared as `new URL(...).href`. */
  function isSameAddress(tab, url) {
    const current = normalizedHref(tab?.url);
    return current !== null && current === normalizedHref(url);
  }

  /** `new URL(value).href`, or `null` for anything that is not an absolute URL. */
  function normalizedHref(value) {
    if (typeof value !== "string") return null;
    try {
      return new URL(value).href;
    } catch (error) {
      return null;
    }
  }

  /** The tab's URL, or `null` — the difference between "that page" and "no page". */
  function asUrl(value) {
    return typeof value === "string" && value !== "" ? value : null;
  }

  /**
   * Whether `value` is an `about:` address — `about:blank` above all.
   *
   * Those are shell pages, never a page a navigation loaded: a real run answered
   * `{"url":"about:blank","title":"(369) YouTube","complete":true}` for a tab
   * that stood on the requested address right afterwards (it had been moved into
   * a new window meanwhile). Nothing about such a state may be reported as a
   * loaded page.
   */
  function isAboutAddress(value) {
    const href = normalizedHref(value);
    return href !== null && href.startsWith("about:");
  }

  /**
   * Whether `tab` reports the *requested* page as loaded.
   *
   * `status: "complete"` alone is not enough after an update: the tab still
   * carries the old page's state until the new load starts, so `complete` only
   * counts once the address has moved away from the one remembered before. A
   * freshly created tab has no earlier address (`null`), so anything it reports as
   * complete is its own page — except `about:`, which is no page at all.
   */
  function reportsLoadedPage(tab, previousUrl) {
    if (tab?.status !== TAB_STATUS_COMPLETE) return false;
    if (isAboutAddress(tab.url)) return false;
    if (previousUrl === null) return true;
    if (typeof tab.url !== "string") return false;
    return normalizedHref(tab.url) !== normalizedHref(previousUrl);
  }

  /** The tab, or `null` — a tab that is gone is a normal case here, not an error. */
  async function readTabOrNull(tabId) {
    try {
      return await browser.tabs.get(tabId);
    } catch (error) {
      return null;
    }
  }

  function navigateRequestUrl(params) {
    const url = params?.url;
    if (typeof url !== "string") {
      throw new NavigateError(INVALID_PARAMS_CODE, MISSING_URL_MESSAGE);
    }
    if (!isHttpUrl(url)) {
      // Relative values throw inside `new URL` and land here too, hence the one
      // check that covers both "wrong scheme" and "not absolute".
      throw new NavigateError(INVALID_URL_CODE, INVALID_URL_MESSAGE);
    }
    return url;
  }

  function isHttpUrl(value) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch (error) {
      return false;
    }
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  }

  /* --------------------------------------------------- open_tab / close_tab */

  /**
   * A refusal `open_tab` decides on — the same shape as `NavigateError`, and for the
   * same reason: the catcher forwards a code instead of guessing what went wrong.
   */
  class OpenTabError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "OpenTabError";
      this.code = code;
    }
  }

  /**
   * The `close_tab` counterpart. It carries the same two codes the method can answer:
   * `no_agent_tab` and `invalid_params`.
   */
  class CloseTabError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "CloseTabError";
      this.code = code;
    }
  }

  /**
   * Answers one `open_tab` request: a URL in, the three fields of the new tab out.
   *
   * The browser's own refusals are answered in `navigate`'s vocabulary — opening a tab
   * *is* a navigation that always creates one, so `invalid_params`, `invalid_url`,
   * `no_default_window` and the `navigate_failed` catch-all are the very decisions the
   * other method makes. `too_many_tabs` is the only code the cap adds.
   */
  async function answerOpenTab(target, request) {
    try {
      sendResponse(target, request.id, { ok: true, result: await openAgentTab(request.params) });
    } catch (error) {
      sendResponse(target, request.id, { ok: false, error: openTabErrorFor(error) });
    }
  }

  function openTabErrorFor(error) {
    if (error instanceof OpenTabError) return { code: error.code, message: error.message };
    return { code: NAVIGATE_FAILED_CODE, message: describeError(error) };
  }

  /**
   * Creates an agent tab on `url` and answers with its id, address and title.
   *
   * The check-and-create runs inside `enqueueTabStore` as one step: `answerRequest`
   * handles requests concurrently, so a cap checked outside the queue is a
   * check-then-act race — two simultaneous calls at the limit would both see room and
   * create a sixth tab.
   *
   * The wait that follows is `complete`, not quiet: what comes after an `open_tab` is a
   * `read`, and a `page_busy` for the tab this very call opened would be an error the
   * agent cannot act on except by retrying. The answer keeps three fields, so the wait
   * may only make the `title` truer.
   */
  async function openAgentTab(params) {
    const url = openRequestUrl(params);
    // `createAgentTab` appends the new id to the list and thereby makes it the last
    // used one, so no second mark is needed here.
    const createdTab = await enqueueTabStore(() => createTabBelowTheLimit(url));
    const loadedTab = await waitForTabComplete(createdTab.id, null).settled;
    return openTabResult(createdTab, loadedTab);
  }

  /**
   * The cap check and the creation, as one queue entry.
   *
   * The check reads the *pruned* list: five ids whose tabs the operator closed long ago
   * must not block opening a tab for ever. `createAgentTab` then rebuilds the list from
   * what is alive plus the new tab, which is the same prune one step later.
   */
  async function createTabBelowTheLimit(url) {
    const liveTabIds = await pruneAgentTabIds(await readAgentTabIds());
    if (liveTabIds.length >= AGENT_TAB_LIMIT) {
      throw new OpenTabError(TOO_MANY_TABS_CODE, TOO_MANY_TABS_MESSAGE);
    }

    const window = await selectAgentWindow();
    if (window === null) {
      throw new OpenTabError(NO_DEFAULT_WINDOW_CODE, NO_DEFAULT_WINDOW_MESSAGE);
    }
    return createAgentTab(url, window.id);
  }

  /**
   * The three fields of an `open_tab` answer: the tab it created, plus what the wait
   * learned about it.
   *
   * `knownTabState` does the `about:` handling: a tab that answers `about:blank` after
   * the wait was moved between windows rather than loaded, so the requested address and
   * an empty title are the honest answer for it.
   */
  function openTabResult(createdTab, loadedTab) {
    const state = knownTabState(loadedTab ?? createdTab, asText(createdTab.url));
    return { tabId: state.tabId, url: state.url, title: state.title };
  }

  /**
   * The `url` of an `open_tab`: required, and `http(s)` only — the same check `navigate`
   * makes, in this method's own error type.
   */
  function openRequestUrl(params) {
    const url = params?.url;
    if (typeof url !== "string") {
      throw new OpenTabError(INVALID_PARAMS_CODE, MISSING_OPEN_URL_MESSAGE);
    }
    if (!isHttpUrl(url)) {
      throw new OpenTabError(INVALID_URL_CODE, INVALID_URL_MESSAGE);
    }
    return url;
  }

  /**
   * Answers one `close_tab` request: the tab that went away, and `closed: true`.
   *
   * An unexpected failure is `no_agent_tab` and not a code of its own: the only thing
   * that realistically fails here is `tabs.remove` on a tab that is already gone, which
   * is exactly that answer — and the wire stays free of a code only a lost race could
   * produce.
   */
  async function answerCloseTab(target, request) {
    try {
      sendResponse(target, request.id, { ok: true, result: await closeAgentTab(request.params) });
    } catch (error) {
      sendResponse(target, request.id, { ok: false, error: closeTabErrorFor(error) });
    }
  }

  function closeTabErrorFor(error) {
    if (error instanceof CloseTabError) return { code: error.code, message: error.message };
    return { code: NO_AGENT_TAB_CODE, message: NO_AGENT_TAB_MESSAGE };
  }

  /**
   * Closes the agent tab the call addresses — the named one, or the last used one.
   *
   * No page slot is *taken*: closing a tab changes no page. The one this tab holds is
   * superseded, though — a call still waiting there answers `superseded` instead of
   * driving its remaining injections into a tab that is going away. The same call
   * serves the path without `tab`, because the resolution runs first and the tab it
   * hands back is the id whose slot is dropped.
   *
   * The limit of that: a call that is *inside* an injection cannot be cancelled, so a
   * `close_tab` arriving during the click itself leaves it to answer with the error
   * of that injection (`no_agent_tab`). Only the wait is cancellable.
   *
   * Superseding comes before `removeAgentTab` so the waiting call is released as soon
   * as the tab is known to be the one going, not after the removal and the storage
   * round-trip behind it. The list follows in its own queue entry — with the closed
   * id gone, the entry before it is the last used one by simply staying where it is.
   */
  async function closeAgentTab(params) {
    const tab = await addressedAgentTab(params, CloseTabError);
    // Before the removal: the entry is dropped while its tab still exists, so nothing
    // can claim a slot under an id that is on its way out; a *stale* entry does not survive.
    supersedePageSlot(tab.id);
    const removed = await removeAgentTab(tab.id);
    // Forgetting happens either way: a tab that was already gone must not leave its id
    // in the list for the next call to prune again.
    await enqueueTabStore(() => forgetAgentTab(tab.id));
    if (!removed) {
      throw new CloseTabError(NO_AGENT_TAB_CODE, NO_AGENT_TAB_MESSAGE);
    }
    return { tabId: tab.id, closed: true };
  }

  /** `tabs.remove` as a yes/no: a tab the browser no longer has is not an error *here*. */
  async function removeAgentTab(tabId) {
    try {
      await browser.tabs.remove(tabId);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Drops `tabId` from the stored list.
   *
   * Belongs inside `enqueueTabStore` like every other list change. No second write for
   * the order: with the closed id gone, the entry before it is the last one — which is
   * what "der vorige rückt nach" means.
   */
  async function forgetAgentTab(tabId) {
    const tabIds = await readAgentTabIds();
    if (!tabIds.includes(tabId)) return;
    await storeAgentTabIds(tabIds.filter((storedTabId) => storedTabId !== tabId));
  }

  /* ------------------------------------------------------------------- read */

  /**
   * Same contract as `NavigateError`: the code the wire protocol names rides along.
   *
   * `details` are the optional extra fields of the error frame. Only a `not_readable`
   * carries any, and only `notReadableErrorForTab` fills them — that is what keeps
   * `readErrorFrame` a plain object spread.
   */
  class ReadError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "ReadError";
      this.code = code;
      this.details = details;
    }
  }

  /**
   * The error frame of a `ReadError`: code and message, plus whatever `details` its
   * producer attached.
   *
   * The spread makes "the extra fields exist only for `not_readable`" structural
   * rather than a promise: every other `ReadError` is built without `details`, so its
   * frame is the old two-field one — `no_agent_tab` and `read_failed` included.
   */
  function readErrorFrame(error) {
    return { code: error.code, message: error.message, ...error.details };
  }

  /**
   * The error frame of a `FrameError` — the same shape as the one above, for the other
   * class that carries `details`.
   *
   * Kept as its own function because the two classes answer about different things: a
   * `ReadError` speaks about the page, a `FrameError` about the frame filter's verdict.
   * The shape has one home (`...error.details`), so a `frames` or `candidates` field
   * cannot exist in one frame and go missing in the other.
   */
  function frameErrorFrame(error) {
    return { code: error.code, message: error.message, ...error.details };
  }

  /**
   * What the *address* of an unreadable page reveals about it — never what the server
   * delivers.
   *
   * The order is the point: `file:///tmp/a.pdf` is a `file` and not a `pdf`, so the
   * scheme is decided before the suffix. A suffix is a claim by the address and not by
   * the answer, which is why `…/bild.jpg` stays `unknown` and why the field is called
   * `kind` and not `fileType`.
   */
  function kindFromUrl(url) {
    if (typeof url !== "string") return "unknown";
    // Schemes are case-insensitive and a tab's address is not guaranteed to be
    // normalised, so the comparison lower-cases the scheme and nothing else.
    const scheme = url.slice(0, url.indexOf(":") + 1).toLowerCase();
    if (INTERNAL_URL_SCHEMES.includes(scheme)) return "internal";
    if (scheme === "file:") return "file";
    return pathEndsInPdf(url) ? "pdf" : "unknown";
  }

  /** Whether the path of `url` ends in `.pdf`, ignoring `?query` and `#fragment`. */
  function pathEndsInPdf(url) {
    const path = url.split(/[?#]/, 1)[0];
    return path.toLowerCase().endsWith(".pdf");
  }

  /**
   * An address for the error frame: cut, and only here.
   *
   * Same shape as the page-side `cappedString`: anything that is not a string is "no
   * address", and the cut happens last so that it cannot influence a classification.
   */
  function cappedAddress(address) {
    if (typeof address !== "string" || address === "") return null;
    return address.slice(0, URL_DETAIL_LIMIT);
  }

  /**
   * The `Content-Type` the server reports for `url`, or `null`.
   *
   * Best effort, never throws: a network error, a non-2xx answer and a deadline that
   * expires all mean "nothing known". `internal` and `file` addresses never reach a
   * server at all — the browser's own pages have no origin to ask, and a local file
   * has no server.
   *
   * Two guards, because they answer different questions: the `AbortController` frees
   * the socket in the real browser, `guardAfter` ends the *call* even if the fetch
   * ignores its signal — the same pattern `settleAgentTab` uses, and for the same
   * reason: a request that never answers must never hold an error frame hostage.
   *
   * `credentials: "omit"` is the honest question — without the operator's cookies the
   * answer describes the resource rather than their session. `redirect: "follow"`
   * means a redirect to a login page reports the type of the *target*, which is what
   * the browser would show. `response.ok` is the whole status check and no more: a
   * 401/403 page happily serves `text/html`, and that is the type of the error page.
   * The final URL is deliberately not compared — see the spec's decision 4.
   */
  async function contentTypeOf(url, kind) {
    if (kind === "internal" || kind === "file") return null;
    const guard = guardAfter(HEAD_DEADLINE_MS);
    const controller = new AbortController();
    try {
      const response = await Promise.race([
        fetch(url, {
          method: "HEAD",
          credentials: "omit",
          redirect: "follow",
          signal: controller.signal,
        }).catch(() => null),
        guard.promise,
      ]);
      // Its own `try`, and the return value lives inside it: a reply without `headers`
      // — or a `headers` that throws — must answer `null` like any other broken
      // answer. Letting it escape would reject `contentTypeOf`, and that rejection
      // would surface as `read_failed`, the one code this path must never produce.
      try {
        if (!response?.ok) return null;
        // `?? null` because `Headers.get` answers `null` for a header the answer does
        // not have, while a map-shaped stand-in answers `undefined` — and the frame
        // promises the field either way.
        return response.headers.get("content-type") ?? null;
      } catch {
        return null;
      }
    } finally {
      // Timer first, then the socket. A throwing `abort()` has to be swallowed here,
      // for the same reason: a `finally` that throws replaces the value the `try`
      // already computed with a rejection.
      guard.cancel();
      try {
        controller.abort();
      } catch {
        // Teardown is not worth an error: the answer was already decided above.
      }
    }
  }

  /**
   * The `not_readable` error for `tab`: what its address reveals and, unless `head` is
   * `false`, what the server says about it.
   *
   * Asynchronous now, and it takes the tab rather than an id: the failure path has
   * already looked the tab up to tell `page_busy` from this code, and a second
   * `tabs.get` would answer a question that is settled. A tab without an address still
   * gets the sentence — the fields then say `null`/`unknown` instead of guessing. The
   * kind is derived from the *full* address and only then cut for the frame — cutting
   * first would turn a long path ending in `.pdf` into `unknown`. `contentType` is
   * there either way: `null` is the field's way of saying nothing is known.
   *
   * `head` exists for the caller whose error is thrown away (`settleAgentTab`): a
   * request nobody will read is a request for the bin, and it could cost 1,5 s before
   * the read it belongs to has even started.
   */
  async function notReadableErrorForTab(tab, { head = true } = {}) {
    const address = asUrl(tab?.url);
    const kind = kindFromUrl(address);
    return new ReadError(NOT_READABLE_CODE, NOT_READABLE_MESSAGE, {
      url: cappedAddress(address),
      kind,
      contentType: head ? await contentTypeOf(address, kind) : null,
    });
  }

  /**
   * Answers one `read` request: the stored agent tab in, its page text out.
   *
   * Six outcomes stay apart on purpose: no tab (`no_agent_tab`), a page that is
   * still loading (`page_busy`), a page that refuses injection (`not_readable`), an
   * argument that is not one (`invalid_params` — the window's two numbers or the
   * `tab`), an `offset` behind the text's end (`offset_out_of_range`, carrying the
   * length the caller pages by) and our own broken result (`read_failed`). Only the
   * last one is the extension's fault, and only the last one is worth a warning — a
   * caller reading a PDF gets the same code as one reading `about:`.
   */
  async function answerRead(target, request) {
    try {
      sendResponse(target, request.id, { ok: true, result: await readAgentTabPage(request.params) });
    } catch (error) {
      sendResponse(target, request.id, { ok: false, error: readErrorFor(error) });
    }
  }

  function readErrorFor(error) {
    if (error instanceof ReadError) return readErrorFrame(error);
    // The filter's verdict carries `details` (`frames` or `candidates`), and
    // `frameErrorFrame` is the one place that spreads them — a builder written out here
    // would be a second shape for the same frame.
    if (error instanceof FrameError) return frameErrorFrame(error);
    return { code: READ_FAILED_CODE, message: describeError(error) };
  }

  /**
   * The refusal of the frame filter: code, sentence and the facts the caller needs to
   * address more precisely (`frames`, `candidates`).
   *
   * Its own class, and not `ReadError`, because it is raised *after* the injection and
   * speaks about the answer rather than about the page — the distinction `readErrorFor`
   * needs to keep the two apart.
   */
  class FrameError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "FrameError";
      this.code = code;
      this.details = details;
    }
  }

  /**
   * The `frame` substring of a request, lower-cased — or `null` for "the main frame".
   *
   * Through `params` and not through `readRequestParams`, because the frame is no number
   * and no enum: it is a fragment of an address, and which address it means is decided
   * in the page. Checked *after* the window and the mode on purpose — a caller with two
   * mistakes hears about the one it can fix without a browser.
   *
   * The error class comes in from the call so that each tool keeps its own frame: the
   * same `invalid_params` code, a class whose `…ErrorFor` knows what to do with it.
   */
  function frameWantedOf(params, RequestError) {
    const frame = params?.frame;
    if (frame === undefined) return null;
    if (typeof frame !== "string" || frame === "") {
      throw new RequestError(INVALID_PARAMS_CODE, FRAME_MESSAGE);
    }
    // Folded here and compared against a folded `location.href` in the page: one side has
    // to, and this is the side that can afford it once per call instead of per frame.
    return frame.toLowerCase();
  }

  /**
   * The one place the frame triangle is decided: which of the answers is the addressed
   * frame — an **entry**, never a list.
   *
   * `want === null` is the main-frame path and never throws: `results[0]` is the answer
   * `read` has always read, and a missing entry stays `undefined` so every consumer's own
   * "unusable" branch keeps its code (`read_failed`, `click_failed`, …).
   *
   * With a `want`, the answers are the evidence: a frame that did not match said so
   * (`not_the_frame`) and did nothing, so it is not a candidate — and the extension must
   * not compare addresses a second time, because the page is the only realm that knows
   * where the op really ran. A non-object entry is no answer at all (the page sent
   * nothing usable, or the injection's slot stayed empty): `frames` counts the entries
   * that answered, and the sentence says exactly that.
   *
   * Callers on the message channel hand in `valuesOf(answers)`: the frame id and the ok
   * flag were the channel's business, and the page's own word is what is selected here.
   */
  function frameTargetOf(results, want = null) {
    if (want === null) return Array.isArray(results) ? results[0] : undefined;
    const answered = Array.isArray(results)
      ? results.filter((entry) => entry !== null && typeof entry === "object")
      : [];
    const hits = answered.filter((entry) => entry.outcome !== NOT_THE_FRAME_CODE);
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) {
      throw new FrameError(FRAME_NOT_FOUND_CODE, FRAME_NOT_FOUND_MESSAGE, { frames: answered.length });
    }
    // The first five, in the order the browser answered: this list is advice to address
    // more precisely, and cutting it keeps an error frame from carrying an inventory.
    // `cappedAddress` is the second guard: an address off the wire gets the same cut and
    // the same "no address" rule as everywhere else.
    const candidates = hits.slice(0, FRAME_CANDIDATE_LIMIT).map((entry) => cappedAddress(entry.href));
    throw new FrameError(FRAME_AMBIGUOUS_CODE, FRAME_AMBIGUOUS_MESSAGE, { candidates });
  }

  /**
   * The two window parameters shared by `read` and `transcript`, checked before
   * anything is injected.
   *
   * `undefined` means "not set" and falls back to the defaults; every value that is
   * there has to be an integer inside its range. The check runs *first* in both
   * callers, ahead of the tab lookup: a caller whose `maxChars` is 0 hears about its own
   * mistake whether or not an agent tab exists, and nothing is injected for a request
   * that could not be answered anyway.
   *
   * The range checks live here and not in the bridge on purpose — the bridge checks
   * types (and only types, the way it does for `inspect`'s `limit`), this side checks
   * the numbers it actually acts on. `RequestError` is the class of the caller, so each
   * tool answers in its own error frame without a second copy of these two rules.
   */
  function windowParamsOf(params, RequestError) {
    const offset = params?.offset === undefined ? READ_OFFSET_DEFAULT : params.offset;
    if (!Number.isInteger(offset) || offset < READ_OFFSET_DEFAULT) {
      throw new RequestError(INVALID_PARAMS_CODE, READ_OFFSET_MESSAGE);
    }
    const maxChars = params?.maxChars === undefined ? READ_MAX_CHARS_DEFAULT : params.maxChars;
    if (!Number.isInteger(maxChars) || maxChars < READ_MAX_CHARS_MIN || maxChars > READ_MAX_CHARS_LIMIT) {
      throw new RequestError(INVALID_PARAMS_CODE, READ_MAX_CHARS_MESSAGE);
    }
    return { offset, maxChars };
  }

  /**
   * The window plus the mode of a `read`. `mode` has to be one of the two names this
   * extension acts on; the window comes from the shared rule above.
   */
  function readRequestParams(params) {
    const { offset, maxChars } = windowParamsOf(params, ReadError);
    const mode = params?.mode === undefined ? READ_MODE_DEFAULT : params.mode;
    if (typeof mode !== "string" || !READ_MODES.includes(mode)) {
      throw new ReadError(INVALID_PARAMS_CODE, READ_MODE_MESSAGE);
    }
    return { offset, maxChars, mode };
  }

  /**
   * Reads the page of the agent tab — the tab the agent opened, not whichever one
   * the operator happens to be looking at.
   *
   * A missing tab is decided *before* the injection: `executeScript` without a
   * tab id would have nothing to run against, and a silent fallback to another
   * tab would read a page nobody asked for.
   *
   * The wait comes first and never blocks the answer: a tab that reports
   * `loading` is not settled by definition, and asking it anyway would only cost a
   * refused injection plus an extra `tabs.get` — while the honest `page_busy` must
   * not be pushed back by three seconds.
   */
  async function readAgentTabPage(params) {
    // Before the tab lookup, on purpose — see `readRequestParams`. The frame is checked
    // *after* the window and the mode, for the same reason it is checked here at all.
    const { offset, maxChars, mode } = readRequestParams(params);
    const want = frameWantedOf(params, ReadError);
    const tab = await addressedAgentTab(params, ReadError);
    // The wait runs in the frame that will be read: the quietness of the main frame says
    // nothing about the widget, and a read that waited at the wrong address would answer
    // the frame's untouched state (see `settleAgentTab`).
    const settle = tab.status === TAB_STATUS_LOADING ? NO_SETTLE : await settleAgentTab(tab.id, null, want);
    const { answers } = await injectPageCode(
      tab.id,
      readPageRequest(offset, maxChars, mode, ARTICLE_MIN_CHARS, want),
      { allFrames: want !== null },
    );
    const page = pageResultOf(tab.id, frameTargetOf(valuesOf(answers), want));
    return { ...page, ...settle };
  }

  /**
   * Waits for the page of `tabId` to settle — and answers `NO_SETTLE` instead of
   * failing, whatever went wrong.
   *
   * The wait improves the read, it is not a precondition of it: everything is
   * caught here, a `ReadError` from a refused injection included, and the second
   * injection still decides whether the page can be read at all. The one exception is
   * the filter's own verdict (spec 26): a `FrameError` passes through, because a wait
   * that answered `frame_not_found` in every frame says something the caller must hear —
   * swallowed, it would surface 300 ms later as a second, worse code (`NO_SETTLE`, then
   * the page state's guess).
   *
   * The warning is the fixed `bc:` line and carries no error: the rejection text of
   * an injection is no contract, and its content-free presence is all the live
   * measurement in the spec needs to tell a wait that did not run from a browser
   * that did not await the promise.
   *
   * The race against `guardAfter` is what keeps the call from hanging: the page-side
   * deadline lives in a timer the browser may throttle, so the extension brings its
   * own. Winning the race with the guard is *not* a result — it is no answer at all,
   * which is exactly what `settleOutcomeOf(undefined)` reports.
   *
   * `halt` is the third participant, and it exists for the call that gets replaced: a
   * `click` must answer promptly instead of waiting out a page nobody asked about any
   * more. It is a signal, not a timer, so the only thing that can keep it alive is
   * this very race.
   *
   * `want` is the frame filter of spec 24, and it makes the wait happen where the read
   * will: the snippet runs in every frame, answers `not_the_frame` where it is not
   * meant, and the pair below is the addressed frame's. The order is the contract —
   * halt, then deadline, then selection: a deadline is no answer from *any* frame, and
   * running it through `frameTargetOf` would turn the guard's silence into
   * `frame_not_found`.
   */
  async function settleAgentTab(tabId, halt = null, want = null) {
    const guard = guardAfter(SETTLE_GUARD_MS);
    try {
      // No HEAD from here: this rejection is swallowed by the `catch` below, so a
      // request for it would be a request for the bin — and it would cost up to 1,5 s
      // before the read it belongs to has even started.
      const injected = injectPageCode(tabId, settlePageRequest(want), {
        head: false,
        allFrames: want !== null,
      });
      // The promise that loses the race keeps running: a call of its own can still reject
      // at its own deadline ("no frame answered"), and nobody would be left to read that
      // rejection — an unhandled one takes the page down with it. Handled here, once.
      void injected.catch(() => {});
      const winner = await Promise.race(
        halt === null ? [injected, guard.promise] : [injected, guard.promise, halt.promise],
      );
      // A halt is no outcome: it says the call has nobody to answer any more. Running
      // it through `settleOutcomeOf` would hand back a *copy*, and the identity is the
      // one thing the caller can read it by — see `SUPERSEDED_SETTLE`.
      if (winner === SUPERSEDED_SETTLE) return SUPERSEDED_SETTLE;
      // The guard answers `undefined`: no frame said anything, so there is no selection
      // to make and nothing to wait for. Anything that is not a call's answers is the same
      // silence — a missing frame target is swallowed by the `catch` below, and the read
      // that follows names it with a better sentence.
      if (!isPageAnswers(winner)) return NO_SETTLE;
      return settleOutcomeOf(frameTargetOf(valuesOf(winner.answers), want));
    } catch (error) {
      // The filter's verdict is not a reason to keep quiet — see the note in the comment
      // above. Everything else stays swallowed, warning line included.
      if (error instanceof FrameError) throw error;
      console.warn(SETTLE_WAIT_FAILED_LOG_LINE);
      return NO_SETTLE;
    } finally {
      // Nothing is left armed once the call is answered, whether the guard or the
      // page won: an uncleared timer would outlive the read it belonged to. A halt
      // that never came is disarmed the same way; halting twice is a no-op.
      guard.cancel();
      if (halt !== null) halt.halt();
    }
  }

  /**
   * A signal that resolves the wait it is raced against — the pair `guardAfter` is,
   * with the opposite intent.
   *
   * `guardAfter` says "time is up", this one says "your caller is gone". Both have to
   * be disarmable by the wait itself, or a replaced call would leave a pending
   * resolution behind; for the halt that is exactly `halt()`.
   */
  function haltSignal() {
    let halt = () => {};
    const promise = new Promise((resolve) => {
      halt = () => resolve(SUPERSEDED_SETTLE);
    });
    return { promise, halt };
  }

  /**
   * The settle wait of one call, in the shape `claimPageSlot` arms.
   *
   * `finish` is what a successor reaches: it ends the wait with `SUPERSEDED_SETTLE`,
   * so the caller answers promptly instead of waiting out a page nobody asked about
   * any more. Armed several times, the last window is the one `finish` ends.
   *
   * `want` is passed on unchanged: a click that addresses a frame has to wait *there*, or
   * it would report the quietness of a page the click never touched (spec 26).
   */
  function settleWindow(tabId, want = null) {
    const halt = haltSignal();
    return { finish: halt.halt, answer: settleAgentTab(tabId, halt, want) };
  }

  /**
   * A promise that resolves after `delayMs`, plus the handle to disarm it.
   *
   * The pair instead of a bare promise because the caller has to be able to clear the
   * timer in a `finally` — `Promise.race` drops the loser, timer and all.
   */
  function guardAfter(delayMs) {
    let timerId = null;
    const promise = new Promise((resolve) => {
      timerId = setTimeout(resolve, delayMs);
    });
    return { promise, cancel: () => clearTimeout(timerId) };
  }

  /* ------------------------------------------ the page agent's channel */

  /**
   * The file that carries the helpers and the dispatcher into the page (spec 45).
   *
   * It has to be in `web_accessible_resources`: `tabs.executeScript({file})` resolves
   * the name against the extension package, and MV2 refuses a file the manifest does
   * not expose.
   */
  const PAGE_AGENT_FILE = "page-agent.js";

  /**
   * The call id of the next `{callId, op, args}` message.
   *
   * A counter, not a timestamp and not a random number (spec 45): two calls on the same
   * tab have to be told apart, and "unique" is a promise only a number that is never
   * handed out twice can keep.
   */
  let nextCallId = 1;

  /**
   * The calls that are still waiting for answers, by their call id.
   *
   * A `Map` and not a list: an answer is matched by its id, and the entry is gone the
   * moment the call ends — which is exactly what makes a late answer fall through to
   * "nobody is waiting for this".
   */
  const pendingReplies = new Map();

  function takeCallId() {
    const callId = nextCallId;
    nextCallId += 1;
    return callId;
  }

  /**
   * One answer as this side records it: which frame said it, and what it said.
   *
   * The frame id is the `sender`'s and no longer the page's business — a frame cannot
   * answer a question about its own id, but the message it sends carries one.
   */
  function replyOf(message, frameId) {
    return message.ok === true
      ? { frameId, ok: true, value: message.value }
      : { frameId, ok: false, error: message.error ?? null };
  }

  /**
   * The values a call's answers carry, in arrival order.
   *
   * Every consumer behind the seam reads the *page's* word, not the envelope: the frame id
   * and the ok flag belong to the channel and are spent by the time a tool asks which
   * frame answered what. That question is still answered by content (`not_the_frame`,
   * the href of a hit), because the page is the only realm that knows where it ran.
   */
  function valuesOf(answers) {
    return answers.map((answer) => answer.value);
  }

  /**
   * Whether a value is a call's answers (`{callId, answers}`) and not the guard's silence.
   *
   * The settle wait races the call against its own watchdog, and the two results used to
   * be told apart by `Array.isArray`. The answers now travel wrapped, so the shape is the
   * one thing to ask — a plain `undefined` is still no answer from any frame.
   */
  function isPageAnswers(value) {
    return value !== null && typeof value === "object" && Array.isArray(value.answers);
  }

  /**
   * One call's answers, gathered until the expected number is in.
   *
   * `expectedCount` is the frame count of the injection: `tabs.executeScript` with
   * `{file, allFrames}` answers one entry per frame it reached, so the *length* of that
   * result is how many answers this call may expect.
   *
   * Three rules the shape carries (spec 45, `## Die Naht`):
   *
   * - the call ends at the count, not at the first answer — `frame_ambiguous` and the
   *   frame filter of spec 24 need *every* frame's word, and an early resolution would
   *   silently devalue both;
   * - a frame that never answers is the deadline's job, not an idle guess. The budget is
   *   `INJECTION_REPLY_TIMEOUT_MS` (5 000 ms), deliberately under the bridge's 20 000: an
   *   injected call has to answer the tool, not expire the whole call;
   * - a frame that could not be reached at all counts as silent, not as an error — after
   *   a navigation that is the normal case.
   */
  function createReplyCollection(expectedCount) {
    const answers = [];
    let settledCount = 0;
    let settle = () => {};
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    const deadlineId = setTimeout(finish, PROTOCOL.INJECTION_REPLY_TIMEOUT_MS);

    // Clears the timer on both ways out: a deadline that fired while the last answer was
    // already in would leave a timer behind, and `clearTimeout` twice is harmless.
    function finish() {
      clearTimeout(deadlineId);
      settle(answers);
    }

    function fill(answer) {
      // A duplicate for a completed call is dropped here instead of being handed to the
      // next caller: one frame, one slot.
      if (settledCount >= expectedCount) return;
      settledCount += 1;
      if (answer !== null) answers.push(answer);
      if (settledCount === expectedCount) finish();
    }

    // An injection that reached no frame at all has nothing to wait for — the call is
    // answered now and the caller decides what silence means.
    if (expectedCount <= 0) finish();

    return {
      receive: (message, frameId) => fill(replyOf(message, frameId)),
      markSilent: () => fill(null),
      // Resolves with the answers as they are — the deadline and the last answer share the
      // way out, so a call that ends without an answer gets an empty list, not `undefined`.
      done,
    };
  }

  /**
   * Routes the page agent's answers to the call that waits for their `callId`.
   *
   * Registered before the socket is dialled, because a call can only be open while a
   * socket is: the answers have to have somewhere to land before the first `read`.
   */
  function listenForPageReplies() {
    browser.runtime.onMessage.addListener((message, sender) => {
      const collection = pendingReplies.get(message?.callId);
      // The id is the whole filter. An answer for a call that is over — the late frame of
      // a collection that hit its deadline — belongs to nobody, and handing it to the
      // next caller would be the one mix-up this counter exists to prevent.
      if (collection === undefined) return undefined;
      collection.receive(message, sender?.frameId ?? null);
      // Nothing on the response channel: the answer already travelled as its own
      // message, and a second copy here would answer the same call twice.
      return undefined;
    });
  }

  /**
   * Runs one request in `tabId`: a snippet as source, or a `{op, args}` call to the page
   * agent.
   *
   * Two shapes, one door. `read`, `click`, `type` and the settle wait between them ask by
   * `{op, args}` and take the file plus the message channel; `inspect`, `eval`, `frames`
   * and `transcript` still pass source text and keep their path unchanged. The source
   * form goes away with the last of them (stage 1b, block 2).
   *
   * Three modes, and the caller must pick the right one:
   *
   * - without `allFrames` the request runs in the main frame, addressed as `frameId: 0`;
   * - with `allFrames` it runs in every frame of the tab, and `frameId` stays out of the
   *   details because `tabs.executeScript` refuses the two together. The injection then
   *   answers one entry per frame, in no promised order — which is why every consumer of
   *   that mode decides by *content* (`framesOf`, and the frame filter of spec 24) and
   *   never by position. `matchAboutBlank` is the option that makes an `about:blank`
   *   frame injectable at all; without it that frame is simply not in the list.
   *
   * `head` only concerns the `not_readable` frame of the rejection: `false` keeps the
   * HEAD request out of a call whose error nobody will read.
   */
  async function injectPageCode(tabId, request, { head = true, allFrames = false } = {}) {
    // A string is source text, an object is a request — `typeof` is the whole branch, and
    // the two paths share nothing but the refusal handling in `injectScript`.
    if (typeof request === "string") {
      return injectScript(tabId, sourceDetails(request, allFrames), { head });
    }
    return requestPageAnswers(tabId, request, { head, allFrames });
  }

  /** The `executeScript` details of a snippet that travels as source text. */
  function sourceDetails(code, allFrames) {
    return allFrames
      ? { code, runAt: "document_idle", allFrames: true, matchAboutBlank: true }
      : {
          code,
          runAt: "document_idle",
          // Named explicitly instead of relying on a default: the main frame is the
          // whole page for every caller that does not ask for all of them.
          frameId: 0,
        };
  }

  /**
   * The `executeScript` details of the page agent — the same two modes, one file.
   *
   * `{file}` hands back `undefined` and nothing else: the result of this injection is
   * only good for its *length*, which is the number of frames that received the file.
   */
  function pageAgentDetails(allFrames) {
    return allFrames
      ? { file: PAGE_AGENT_FILE, runAt: "document_idle", allFrames: true, matchAboutBlank: true }
      : { file: PAGE_AGENT_FILE, runAt: "document_idle", frameId: 0 };
  }

  /**
   * `tabs.executeScript` for one detail set, with the three codes a refusal can mean.
   *
   * The single injection call of this file lives here on purpose: a page that refuses
   * injection is refused for every snippet, and a second call site would be a second
   * opinion about what that means.
   */
  async function injectScript(tabId, details, { head = true } = {}) {
    try {
      return await browser.tabs.executeScript(tabId, details);
    } catch (error) {
      // The rejection texts for `about:`, `view-source:`, the PDF viewer and AMO
      // are no contract; parsing them would break on the next browser version.
      // Every rejection now means one of three things — the tab is gone, the page
      // is not there *yet*, or it has nothing to give — and only the tab says
      // which. Never the rejection text.
      throw await unavailablePageError(tabId, { head });
    }
  }

  /**
   * Why a page could not be reached: gone, still loading, or nothing to give.
   *
   * Which of the three codes the caller sees is the *tab's* decision, and the tab is
   * looked up exactly once — here, because the enrichment further down needs the same
   * tab. Two later paths use this: a refused injection, and a call that no frame
   * answered at all. Neither can be decided from a rejection text.
   */
  async function unavailablePageError(tabId, { head = true } = {}) {
    // The `await` is load-bearing: without it a promise would be thrown, the
    // `instanceof ReadError` check in every `…ErrorFor` would miss, and the code would
    // silently become `read_failed`.
    const tab = await readTabOrNull(tabId);
    if (tab === null) {
      // Gone for real: no page to read, and no address to enrich it with.
      throw new ReadError(NO_AGENT_TAB_CODE, NO_AGENT_TAB_MESSAGE);
    }
    if (tab.status === TAB_STATUS_LOADING) {
      // Refused because the page was not there *yet*, not because it has nothing
      // to give — calling that `not_readable` would make the caller give up. No
      // details on purpose: this speaks about the moment, not about the page.
      throw new ReadError(PAGE_BUSY_CODE, PAGE_BUSY_MESSAGE);
    }
    return notReadableErrorForTab(tab, { head });
  }

  /**
   * Hands one call to the frames: one frame with an address, all of them as a broadcast.
   *
   * Without a `frameId` every frame of the tab receives the message. That is what a
   * collection needs — the frame ids are unknown on this side, and the answers are told
   * apart by `callId`, never by their order.
   */
  function sendPageMessage(tabId, message, allFrames) {
    return allFrames
      ? browser.tabs.sendMessage(tabId, message)
      : browser.tabs.sendMessage(tabId, message, {
          // The main frame is the whole page for a caller that asked for one — the same
          // number the injection uses.
          frameId: 0,
        });
  }

  /**
   * One call to the page agent: inject the file, send `{callId, op, args}`, collect the
   * answers.
   *
   * The injection comes first and the message second: a frame that does not run the file
   * yet would drop the message, and `executeScript` is what guarantees the listener is in
   * place before anybody speaks.
   */
  async function requestPageAnswers(tabId, request, { head = true, allFrames = false } = {}) {
    const callId = takeCallId();
    const injected = await injectScript(tabId, pageAgentDetails(allFrames), { head });
    const collection = createReplyCollection(Array.isArray(injected) ? injected.length : 0);
    pendingReplies.set(callId, collection);
    try {
      // A refused channel — "Receiving end does not exist", the normal case after a
      // navigation — is not an error but a silent frame (spec 45): the call ends as if
      // that frame had said nothing, which is what `markSilent` records. A frame that
      // receives the message but answers nothing does *not* reject the promise in MV2;
      // the answer of the page agent travels as its own message either way.
      await sendPageMessage(tabId, { callId, op: request.op, args: request.args ?? {} }, allFrames).catch(
        () => collection.markSilent(),
      );
      const answers = await collection.done;
      // A frame that answered with a rejection is a page this call cannot read: before
      // the seam that was one rejected `executeScript` for the whole injection, and the
      // verdict belongs to the tab (gone, still loading, nothing to give) — not to the
      // sentence an op happened to throw. One failing frame decides it for every frame,
      // exactly like the single rejection it replaces.
      if (answers.some((answer) => answer.ok === false)) throw await unavailablePageError(tabId, { head });
      // One addressed frame and no answer at all: no second frame could carry the result,
      // and the caller has no list to sort out — the page is as unreadable as one that
      // refused the injection. A collection is different: it hands back what came in,
      // because "no frame said anything" is the *tool's* verdict (`not_readable` for a
      // read, `frames_failed` for the inventory) and not this function's.
      if (answers.length === 0 && allFrames !== true) throw await unavailablePageError(tabId, { head });
      return { callId, answers };
    } finally {
      // Whatever ended the wait, this call is over: from here on an answer with its id
      // belongs to nobody and is dropped by the listener.
      pendingReplies.delete(callId);
    }
  }

  /**
   * The `read` call: the window and the frame filter, nothing else.
   *
   * Built per call instead of pinned in a constant, because the window is an argument: a
   * constant would carry the first caller's numbers for every later one, and a second
   * `read` would silently answer the first one's window.
   *
   * `pageStateRequest` reuses this call for the page state after a click or a typing, so
   * the page-side article machinery is loaded for a path that never sets `mode`. Accepted:
   * it costs bytes in a file that is injected anyway, not time, and a slimmer op for that
   * path would be a second copy of the read.
   */
  function readPageRequest(offset, maxChars, mode, minChars, want = null) {
    return {
      op: "read",
      args: { offset, maxChars, mode, minChars, urlLimit: URL_LIMIT, titleLimit: TITLE_LIMIT, want },
    };
  }

  /**
   * The page state `click` and `type` attach: the whole text, cut at the old limit.
   *
   * They take no window (spec 22, `## Non-goals`) and no mode either (spec 23), so this
   * one call is what their two follow-ups share. The `"text"` is not decoration: without
   * it the page would answer `mode: undefined`, the field would vanish in JSON, and both
   * specs would fall over as `read_failed`.
   */
  function pageStateRequest(want = null) {
    return readPageRequest(0, TEXT_LIMIT, "text", ARTICLE_MIN_CHARS, want);
  }

  /**
   * The `settle` call: both limits travel, so the page needs no constant of ours.
   *
   * The filter travels always, `null` included — the page reads `null` as "the main
   * frame", and one shape for three callers (`read`, `click`, `type`) is easier to read
   * than a condition.
   */
  function settlePageRequest(want = null) {
    return {
      op: "settle",
      args: { quietWindowMs: QUIET_WINDOW_MS, deadlineMs: SETTLE_DEADLINE_MS, want },
    };
  }

  /**
   * The pair the settle snippet answered, or `NO_SETTLE` when it did not answer.
   *
   * Takes the one entry `frameTargetOf` picked, not the answer list: with a frame filter
   * the addressed frame's pair is somewhere in the list, and this function has no way to
   * tell which — the selection happens in one place.
   *
   * A page that answered anything but the pair — an empty object, a `settled` that came
   * back as the string `"true"` — is no answer, and the two are told apart by shape here
   * and nowhere else. A caller must never see `settled: "true"`.
   */
  function settleOutcomeOf(entry) {
    if (entry === null || typeof entry !== "object") return NO_SETTLE;
    if (typeof entry.settled !== "boolean") return NO_SETTLE;
    if (!Number.isInteger(entry.waitedMs)) return NO_SETTLE;
    return { settled: entry.settled, waitedMs: entry.waitedMs };
  }

  /**
   * The answer out of the one entry `frameTargetOf` picked. A missing entry or a
   * non-object means the page handed nothing back — indistinguishable, for us, from
   * nobody having run at all, and therefore our own bug rather than a page that cannot be
   * read.
   */
  function pageResultOf(tabId, entry) {
    // The page's own refusal, translated instead of recomputed: the two numbers are its
    // words, and this side never saw the whole text. An `outcome` without two integers
    // behind it is our own bug, not the page's — hence the fall-through to the
    // `read_failed` branch below instead of a sentence with `undefined` in it.
    if (entry?.outcome === OFFSET_OUT_OF_RANGE_CODE && isUsableOffsetOutOfRange(entry)) {
      throw new ReadError(OFFSET_OUT_OF_RANGE_CODE, offsetOutOfRangeMessageFor(entry.offset, entry.totalChars));
    }
    if (!isUsablePageResult(entry)) {
      console.warn(UNUSABLE_READ_RESULT_LOG_LINE);
      throw new ReadError(READ_FAILED_CODE, READ_FAILED_MESSAGE);
    }
    return {
      tabId,
      url: entry.url,
      title: typeof entry.title === "string" ? entry.title : "",
      text: entry.text,
      // The three window fields are the page's words, passed through untouched: this
      // side never saw the whole text, so any number computed here would be a guess
      // dressed as a measurement. The order is the wire contract.
      offset: entry.offset,
      chars: entry.chars,
      totalChars: entry.totalChars,
      truncated: entry.truncated === true,
      via: entry.via,
      mode: entry.mode,
      // Appended only when the page sent them: in text mode their *absence* is the
      // contract, and writing a `null` here would invent a fallback nobody performed.
      // `isUsablePageResult` has already refused a text answer that carries either.
      ...(Object.hasOwn(entry, "root") ? { root: entry.root } : {}),
      ...(Object.hasOwn(entry, "fellBack") ? { fellBack: entry.fellBack } : {}),
    };
  }

  /**
   * Whether the page's `offset_out_of_range` answer carries the two numbers the
   * sentence needs. A bare `outcome` is no answer: the whole point of this code is the
   * length, and a message with `undefined` in it would be worse than `read_failed`.
   */
  function isUsableOffsetOutOfRange(value) {
    return Number.isInteger(value.offset) && Number.isInteger(value.totalChars);
  }

  /**
   * The `offset_out_of_range` sentence, built in one place.
   *
   * Both numbers are the point: the length is what the caller pages by, and the offset
   * is what it has to change. The extension writes the sentence and the bridge only
   * passes it through, so the same two numbers cannot be formatted twice.
   */
  function offsetOutOfRangeMessageFor(offset, totalChars) {
    return `Der Text hat ${totalChars} Zeichen; offset ${offset} liegt dahinter.`;
  }

  /**
   * The fields `readPageSource` always sets; anything else is our own bug.
   *
   * `mode` is mandatory and one of the two names, and the two article fields follow it:
   * mandatory in article mode (`root` may be `null` — that is the honest fallback), and
   * *forbidden* in text mode. A text answer that names a root is a page that read
   * something it was not asked to, and `read_failed` is the only honest reply to that.
   * The `root` vocabulary itself is not checked: `"density"` and whatever a later step
   * adds are no closed set.
   */
  function isUsablePageResult(value) {
    if (value === null || typeof value !== "object") return false;
    if (!READ_MODES.includes(value.mode)) return false;
    if (value.mode === "article") {
      if (value.root !== null && typeof value.root !== "string") return false;
      if (typeof value.fellBack !== "boolean") return false;
    } else if (Object.hasOwn(value, "root") || Object.hasOwn(value, "fellBack")) {
      return false;
    }
    return (
      typeof value.text === "string" &&
      typeof value.url === "string" &&
      // Three integers, not merely present: `offset` and `chars` are what a caller
      // pages with, and `undefined` there would answer `offset: undefined` instead
      // of admitting the result is broken — `read_failed` is the honest answer.
      Number.isInteger(value.offset) &&
      Number.isInteger(value.chars) &&
      Number.isInteger(value.totalChars) &&
      // A source the protocol does not know is a broken result, not a new one:
      // the caller would have no way to read `text` correctly.
      TEXT_SOURCES.includes(value.via)
    );
  }

  /* ------------------------------------------------- page snippets */

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

  /** The three helpers above, as source, for the IIFE of `pageSnippetCode`. */
  const PAGE_HELPERS_CODE = `${describeElement.toString()}\n${isVisible.toString()}\n${isAddressedFrame.toString()}`;

  /**
   * A page snippet as one expression: the helpers, the extra helpers, then the
   * snippet itself.
   *
   * The IIFE is not decoration. A bare `function describeElement(…)` at the top of
   * an injected script would land on the operator's `window` — a write access to
   * *their* globals. Inside the wrapper the helpers are local and still real, and
   * every argument is JSON-quoted, so a text with quotes and newlines arrives
   * unchanged.
   *
   * `extraHelpers` is for a snippet that needs more than the three shared helpers. It
   * is empty by default, and the generated code for a snippet without one is
   * byte-for-byte what it was before the parameter existed: every click and every
   * typing carries this payload, and nobody should pay for `inspect`'s selector
   * builder there (a test pins the difference).
   */
  function pageSnippetCode(source, args, extraHelpers = "") {
    const argumentList = args.map((arg) => JSON.stringify(arg)).join(", ");
    const helpers = extraHelpers === "" ? PAGE_HELPERS_CODE : `${PAGE_HELPERS_CODE}\n${extraHelpers}`;
    return `(() => {\n${helpers}\nreturn (${source.toString()})(${argumentList});\n})()`;
  }

  /* ------------------------------------------------------------------ click */

  /** Same contract as `NavigateError` and `ReadError`: the code rides along. */
  class ClickError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ClickError";
      this.code = code;
    }
  }

  /**
   * Answers one `click` request: a selector in, the page after the click out.
   *
   * A `ReadError` from the second injection passes through untouched: after the
   * click the page may be unreadable (`not_readable`) or our snippet may have handed
   * back nothing usable (`read_failed`). Both say more to the caller than a
   * catch-all `click_failed` would.
   */
  async function answerClick(target, request) {
    try {
      sendResponse(target, request.id, { ok: true, result: await clickAgentTab(request.params) });
    } catch (error) {
      sendResponse(target, request.id, { ok: false, error: clickErrorFor(error) });
    }
  }

  function clickErrorFor(error) {
    if (error instanceof ClickError) return { code: error.code, message: error.message };
    // The filter's verdict, with its `frames`/`candidates` details. Without this line the
    // `frame_not_found` of the settle wait would arrive as `click_failed` — and the wait is
    // exactly where a click loses its frame (spec 26).
    if (error instanceof FrameError) return frameErrorFrame(error);
    if (error instanceof ReadError) return readErrorFrame(error);
    return { code: CLICK_FAILED_CODE, message: describeError(error) };
  }

  /**
   * The selector, checked as little as possible: every string goes into the page,
   * where `querySelector` decides what it means — the empty one included. Only a
   * missing or non-string argument is a decision of ours.
   */
  function clickRequestSelector(params) {
    const selector = params?.selector;
    if (typeof selector !== "string") {
      throw new ClickError(INVALID_PARAMS_CODE, MISSING_SELECTOR_MESSAGE);
    }
    return selector;
  }

  /**
   * Clicks the first element matching `selector` in the agent tab and answers the
   * page as it stands after the click — read once the DOM has come to rest.
   *
   * Three injections, not one: the click snippet has to stay synchronous, the wait
   * belongs here, and reading inside the page itself would need a second copy of the
   * normalisation, of the `truncated` rule and of `via`. So the second injection is
   * the settle snippet of spec 14 and the third is the `read` snippet.
   *
   * A page the click *sets* loading is not a page that was loading: asking after the
   * click would skip the wait on every link click and make the wait pointless. The
   * status is therefore read from the tab resolution, before the click — and a tab
   * that was already loading is the one case that ends before the wait: no settle
   * wait, whether or not the click injection still gets through (`page_busy` when
   * it does not), and no fallback behind it either.
   *
   * With a `frame`, all three steps happen where the caller pointed: the click, the wait
   * and the state read (spec 26). The tab is still the tab — only the frame changes —
   * and the slot stays the tab's, because two calls in one tab keep racing for one page
   * even when they aim at different frames.
   */
  async function clickAgentTab(params) {
    const selector = clickRequestSelector(params);
    // After the selector check, like the window of a `read`: a caller with a wrong `frame`
    // hears about its own mistake whether or not an agent tab exists, and nothing is
    // injected for a request that could not be answered.
    const want = frameWantedOf(params, ClickError);
    const tab = await addressedAgentTab(params, ClickError);
    const before = pageStateBeforeClick(tab);
    // Read *before* the click, for the reason in the comment above.
    const tabWasLoading = tab.status === TAB_STATUS_LOADING;

    // A click changes the page just like a navigation does, so it takes the same
    // slot — the one of *this* tab: the older call in the same tab answers
    // `superseded` (or `complete: false`) instead of two calls racing for one tab.
    // A click in another tab is not in the way.
    supersedePageSlot(tab.id);
    const click = claimPageSlot(tab.id, () => settleWindow(tab.id, want));
    try {
      const { answers } = await injectPageCode(tab.id, clickPageRequest(selector, want), {
        allFrames: want !== null,
      });
      const clicked = clickOutcomeOf(frameTargetOf(valuesOf(answers), want));
      // Ownership after the click, before the wait: a successor may have taken the
      // slot over while the page was still being clicked. This request is answered
      // by then, so it must neither wait nor read.
      requirePageSlotOwnership(tab.id, click);
      // The wait starts *here*, not when the request arrived: it belongs to the click
      // ("Warten danach"). Armed earlier, a heavy or throttled page would spend the
      // whole window on its own injection, and the read would see a page that never
      // had the chance to react.
      const settle = tabWasLoading ? NO_SETTLE : await click.arm();
      // `tabWasLoading` is repeated here because `NO_SETTLE` cannot carry the
      // difference: it is the pair that *asks* for the fallback, so a loading tab
      // would get the 300 ms it must not wait. `SUPERSEDED_SETTLE` never falls back
      // either: the caller is gone, and a wait for nobody would only leave a timer
      // behind.
      if (!tabWasLoading && needsFixedClickFallback(settle)) {
        // Armed through the slot, so `finish()` ends it and the `finally` clears it —
        // the fallback must be as cancellable as the settle wait it replaces. The
        // Boolean this resolves with answers nothing: which is exactly why `arm`
        // hands back whatever its window resolves with instead of one shared shape.
        await click.arm(() => startFixedWaitWindow(CLICK_FALLBACK_MS));
      }
      // Ownership after the wait, before the read injection: a successor may have
      // taken the slot over meanwhile, and reading *its* page here would answer a
      // request that was already replaced.
      requirePageSlotOwnership(tab.id, click);
      return await clickResult(tab.id, clicked, before, settle, want);
    } finally {
      // Idempotent for an armed window that ran its course; it also ends the wait
      // of a click that refuses before the timer, so neither leaves a timer behind.
      click.finish();
      // Only if this click still owns the slot — a successor's slot must stay.
      releasePageSlot(tab.id, click);
    }
  }

  /**
   * Whether this click has to wait out the old fixed 300 ms after all.
   *
   * Only `NO_SETTLE` counts — the page said nothing about being quiet. The values of
   * `SUPERSEDED_SETTLE` are the same on the wire, so the decision is made on the
   * identity: a replaced click must not wait for a caller that is already answered.
   */
  function needsFixedClickFallback(settle) {
    return settle !== SUPERSEDED_SETTLE && settle.settled === false && settle.waitedMs === 0;
  }

  /** `superseded` unless this call still owns the slot of its tab. */
  function requirePageSlotOwnership(tabId, slot) {
    if (pageSlots.get(tabId) !== slot) {
      throw new ClickError(SUPERSEDED_CODE, SUPERSEDED_MESSAGE);
    }
  }

  /**
   * Drops the slot of `tabId` — but only if it still is `slot`.
   *
   * The identity check lives here and nowhere else, so all three `finally`s get it
   * right by construction: an old call must not remove the entry of its successor.
   * A slot that `supersedePageSlot` already took is simply no longer there.
   */
  function releasePageSlot(tabId, slot) {
    if (pageSlots.get(tabId) === slot) pageSlots.delete(tabId);
  }

  /**
   * The slot entry for a call whose wait is not armed yet.
   *
   * The slot is claimed *before* the first injection — a successor has to be able to
   * end a click that is still clicking — but the wait is armed only after it, because
   * the wait belongs to the click. `finish` is therefore safe at any time: before
   * `arm` it has no timer to clear, and the ownership checks decide.
   *
   * `armWait` is the wait this tool normally uses; a caller that needs a second, later
   * wait passes it per call (`arm(wait)`), and the slot keeps pointing `finish` at the
   * window that is armed last. That is what keeps one `finally` enough for both.
   *
   * The slot registers itself under `tabId`, so the callers own no state and a slot
   * that exists is always reachable for a successor. Between the call and the `try`
   * of the caller lies no `await`: a request that is refused before (`invalid_params`,
   * `no_agent_tab`) never reaches this function and leaves no entry behind.
   */
  function claimPageSlot(tabId, armWait) {
    let finishWindow = () => {};
    const slot = {
      finish: () => finishWindow(),
      /**
       * Arms `wait` (this slot's own by default) and resolves with what that window's
       * `answer` resolves with: a Boolean for a fixed window, a settle outcome for
       * `settleWindow`. Deliberately not one shape — the caller knows what it armed.
       */
      arm(wait = armWait) {
        const window = wait();
        finishWindow = window.finish;
        return window.answer;
      },
    };
    pageSlots.set(tabId, slot);
    return slot;
  }

  /**
   * A fixed wait of `delayMs`, in the shape of `waitForTabComplete`.
   *
   * Armed by `claimPageSlot().arm()`. `answer` resolves with whether the window really
   * elapsed: a successor ends it early through `finish()`. A rejection would be an
   * unhandled one here, and an id-less `clearTimeout` removes nothing and would leave
   * one timer per replaced call behind.
   */
  function startFixedWaitWindow(delayMs) {
    let timer = null;
    // Assigned inside the promise executor; `supersedePageSlot` outside has
    // to reach that same settle path, hence the variable.
    let finish = () => {};

    const answer = new Promise((resolve) => {
      let finished = false;

      const settle = (elapsed) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(elapsed);
      };
      finish = () => settle(false);

      timer = setTimeout(() => settle(true), delayMs);
    });

    // By now the executor has run, so `finish` is the real one.
    return { finish, answer };
  }

  /**
   * What the injected snippet reported, or a `ClickError` carrying its code.
   *
   * Takes the entry `frameTargetOf` picked. With a `frame` that is the addressed frame's
   * answer; the selection itself lives in one place, so this function never sees the list.
   *
   * An unknown outcome is our own bug, like an unknown `via` in a read result: the
   * caller could not act on it.
   */
  function clickOutcomeOf(entry) {
    const outcome = entry?.outcome;
    if (!CLICK_OUTCOMES.includes(outcome)) {
      console.warn(UNUSABLE_CLICK_RESULT_LOG_LINE);
      throw new ClickError(CLICK_FAILED_CODE, CLICK_FAILED_MESSAGE);
    }
    if (outcome !== "clicked") {
      throw new ClickError(outcome, CLICK_REFUSAL_MESSAGES[outcome]);
    }
    return typeof entry.clicked === "string" ? entry.clicked : "";
  }

  /**
   * What the tab showed before the click — the honest answer when the click ends on
   * an `about:` address, because that address is no page (spec 04). A tab that
   * already showed one has neither URL nor title to contribute.
   */
  function pageStateBeforeClick(tab) {
    const showsPage = !isAboutAddress(tab.url);
    return {
      url: showsPage ? asText(tab.url) : "",
      title: showsPage ? asText(tab.title) : "",
    };
  }

  /**
   * The answer: the page read like `browser_read`, plus what was clicked and how the
   * wait ended.
   *
   * A click answer carries no `complete`, so the `about:` rule of `navigate` lands
   * on `url` and `title`: the state from before the click stands in, with an empty
   * text. Reporting `about:blank` as a page would be a lie.
   *
   * `before` is the **tab's** state, the frame's is not: the fallback exists because the
   * click may have taken the page away, and a frame that vanished with it has no address
   * left to report. Taking the frame into the fallback would need a second `before` that
   * nobody measured — so the mismatch is documented instead of guessed away (spec 26,
   * `## Ziel`).
   */
  async function clickResult(tabId, clicked, before, settle, want = null) {
    const { answers } = await injectPageCode(tabId, pageStateRequest(want), { allFrames: want !== null });
    const page = pageResultOf(tabId, frameTargetOf(valuesOf(answers), want));
    // One field order for both branches, `clicked` after `title` — the same answer
    // in the same shape, whether or not the click ended on an `about:` address.
    const state = isAboutAddress(page.url)
      ? { url: before.url, title: before.title, text: "", truncated: false, via: "innerText" }
      : page;
    return {
      tabId,
      url: state.url,
      title: state.title,
      clicked,
      text: state.text,
      truncated: state.truncated,
      via: state.via,
      // Behind `via` on purpose: the field order of this answer is part of the wire
      // contract, and spec 15 appended its two fields rather than putting them
      // somewhere a reader would have to re-learn.
      settled: settle.settled,
      waitedMs: settle.waitedMs,
    };
  }

  /**
   * The `click` call: the selector and the frame filter.
   *
   * The filter travels always, `null` included — one shape for both callers, like
   * `settlePageRequest`, because the page reads `null` as "the main frame".
   */
  function clickPageRequest(selector, want = null) {
    return { op: "click", args: { selector, want } };
  }

  /* ------------------------------------------------------------------- type */

  /**
   * Not `TypeError`: a class named after a built-in error sends every reader in
   * the wrong direction. This is the extension's own refusal, and its `code` rides
   * along the way `ReadError`'s and `ClickError`'s do.
   */
  class TypingError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "TypingError";
      this.code = code;
    }
  }

  /**
   * Answers one `type` request: a selector and a text in, the page after the
   * typing out.
   *
   * `ReadError` and `ClickError` pass through untouched, and both are load-bearing:
   * the second injection reports `not_readable`/`read_failed` as a `ReadError`, and
   * being overtaken throws `ClickError(SUPERSEDED_CODE)` from the shared slot. A
   * catch-all here would answer `type_failed` to both, which is the wrong story.
   */
  async function answerType(target, request) {
    try {
      sendResponse(target, request.id, { ok: true, result: await typeAgentTab(request.params) });
    } catch (error) {
      sendResponse(target, request.id, { ok: false, error: typeErrorFor(error) });
    }
  }

  function typeErrorFor(error) {
    if (error instanceof TypingError) return { code: error.code, message: error.message };
    if (error instanceof ClickError) return { code: error.code, message: error.message };
    // The filter's verdict, with its `frames`/`candidates` details — the same frame `read`
    // and `click` answer for the same page.
    if (error instanceof FrameError) return frameErrorFrame(error);
    if (error instanceof ReadError) return readErrorFrame(error);
    return { code: TYPE_FAILED_CODE, message: describeError(error) };
  }

  /**
   * The parameters, checked where only this side can decide.
   *
   * `selector` and `text` are passed on as they are — the empty string included,
   * which the page reads as "clear the field". `submit` is a switch, not a truthy
   * value: a `"true"` from a sloppy caller must not become an Enter press.
   */
  function typeRequestParams(params) {
    const selector = params?.selector;
    if (typeof selector !== "string") {
      throw new TypingError(INVALID_PARAMS_CODE, MISSING_SELECTOR_MESSAGE);
    }
    const text = params?.text;
    if (typeof text !== "string") {
      throw new TypingError(INVALID_PARAMS_CODE, MISSING_TEXT_MESSAGE);
    }
    const submit = params?.submit;
    if (submit !== undefined && submit !== true && submit !== false) {
      throw new TypingError(INVALID_PARAMS_CODE, INVALID_SUBMIT_MESSAGE);
    }
    return { selector, text, submit: submit === true };
  }

  /**
   * Types into the agent tab and answers what the page says 300 ms later.
   *
   * The same two injections as `click`, and for the same reason: the writing
   * snippet has to stay synchronous, the wait belongs here, and the second
   * injection is the `read` snippet instead of a second copy of its rules. The
   * slot is that of the addressed tab, like `navigate` and `click` — all three
   * change the page, and all three therefore share one slot *per tab* (spec 17).
   *
   * The wait stays fixed: `type` does not get the settle wait in this increment, so
   * its 300 ms are the one place where nothing about this path has changed — and the
   * window injects nothing, which is why it gets no frame filter (spec 26, `## Ziel`).
   * Everything that *is* injected addresses the frame the caller named.
   */
  async function typeAgentTab(params) {
    const request = typeRequestParams(params);
    // After the parameter table, like `click`: a caller with a wrong `frame` hears about
    // its own mistake before any tab is resolved and before anything is injected.
    const want = frameWantedOf(params, TypingError);
    // Before the tab is even resolved: nothing may be injected while the password
    // switch is unknown.
    const allowPasswordFields = await passwordFieldsAllowed();

    const tab = await addressedAgentTab(params, TypingError);
    const before = pageStateBeforeClick(tab);

    supersedePageSlot(tab.id);
    const slot = claimPageSlot(tab.id, () => startFixedWaitWindow(TYPE_WAIT_MS));
    try {
      const pageRequest = {
        selector: request.selector,
        text: request.text,
        submit: request.submit,
        allowPasswordFields,
      };
      const { answers } = await injectPageCode(tab.id, typePageRequest(pageRequest, want), {
        allFrames: want !== null,
      });
      const typed = typeOutcomeOf(frameTargetOf(valuesOf(answers), want));
      // Ownership after the writing, before the wait: a successor may have taken
      // the slot over while the page was still being typed into.
      requirePageSlotOwnership(tab.id, slot);
      // The wait starts here, not when the request arrived: the 300 ms are the
      // page's chance to react to the typing.
      await slot.arm();
      // Ownership after the wait, before the second injection: reading the
      // successor's page here would answer a request that was already replaced.
      requirePageSlotOwnership(tab.id, slot);
      return await typeResult(tab.id, typed, before, want);
    } finally {
      slot.finish();
      releasePageSlot(tab.id, slot);
    }
  }

  /**
   * What the injected snippet reported, or a `TypingError` carrying its code.
   *
   * Takes the entry `frameTargetOf` picked, like `clickOutcomeOf` — and for the same
   * reason: the selection is one place, not one per tool.
   *
   * An unknown outcome is our own bug, like an unknown `via` in a read result.
   */
  function typeOutcomeOf(entry) {
    const outcome = entry?.outcome;
    if (!TYPE_OUTCOMES.includes(outcome)) {
      console.warn(UNUSABLE_TYPE_RESULT_LOG_LINE);
      throw new TypingError(TYPE_FAILED_CODE, TYPE_FAILED_MESSAGE);
    }
    if (outcome !== "typed") {
      throw new TypingError(outcome, TYPE_REFUSAL_MESSAGES[outcome]);
    }
    return {
      typed: typeof entry.typed === "string" ? entry.typed : "",
      submitted: entry.submitted === true,
    };
  }

  /**
   * The answer: the page read like `browser_read`, plus what was typed into where
   * and whether Enter went along.
   *
   * `clickResult` with `typed`/`submitted` instead of `clicked`, including the
   * `about:` rule: a page that ends on an `about:` address is no page, so the state
   * from before stands in with an empty text. That `before` is the **tab's** state and
   * not the frame's — the same documented mismatch `clickResult` carries.
   */
  async function typeResult(tabId, typed, before, want = null) {
    const { answers } = await injectPageCode(tabId, pageStateRequest(want), { allFrames: want !== null });
    const page = pageResultOf(tabId, frameTargetOf(valuesOf(answers), want));
    const state = isAboutAddress(page.url)
      ? { url: before.url, title: before.title, text: "", truncated: false, via: "innerText" }
      : page;
    return {
      tabId,
      url: state.url,
      title: state.title,
      typed: typed.typed,
      submitted: typed.submitted,
      text: state.text,
      truncated: state.truncated,
      via: state.via,
    };
  }

  /**
   * The `type` call: the whole request plus the frame filter.
   *
   * The filter travels always, `null` included — one shape for both callers, like
   * `clickPageRequest`. Everything in `request` is JSON: the page gets no function and no
   * node, only the four fields `typeRequestParams` decided on.
   */
  function typePageRequest(request, want = null) {
    return { op: "type", args: { request, want } };
  }

  /* ---------------------------------------------------------------- inspect */

  /** Same contract as `NavigateError`, `ReadError` and `ClickError`: the code rides along. */
  class InspectError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "InspectError";
      this.code = code;
    }
  }

  /**
   * Answers one `inspect` request: the matching elements of the agent tab out.
   *
   * Read-only, and that is structural, not decoration: no slot and no
   * `supersedePageSlot`, because this call changes nothing on the page — it
   * may neither end a running navigation nor be ended by one. One injection, no
   * timer, no second read.
   *
   * A `ReadError` from the injection passes through untouched (`not_readable`, the
   * same code `read` answers for the same page), and `inspect_failed` is the only
   * code this call decides itself.
   */
  async function answerInspect(target, request) {
    try {
      sendResponse(target, request.id, { ok: true, result: await inspectAgentTab(request.params) });
    } catch (error) {
      sendResponse(target, request.id, { ok: false, error: inspectErrorFor(error) });
    }
  }

  function inspectErrorFor(error) {
    if (error instanceof InspectError) return { code: error.code, message: error.message };
    // The filter's verdict, with its `frames`/`candidates` details — the same frame
    // `read` answers for the same page, built by the one builder that spreads them.
    if (error instanceof FrameError) return frameErrorFrame(error);
    if (error instanceof ReadError) return readErrorFrame(error);
    return { code: INSPECT_FAILED_CODE, message: describeError(error) };
  }

  /**
   * The four parameters, checked where only this side can decide — and *before* the
   * agent tab is resolved, so a caller that forgot its filter hears about its own
   * mistake whether or not a tab exists.
   *
   * `undefined` means "not set"; every value that is there has to have the declared
   * type, `null` and `""` included. An empty filter is a *set* filter: what it means
   * is the page's call — `querySelector("")` throws, and `text: ""` matches
   * everything on purpose. Only the limits are narrowed here, because the page has no
   * business knowing the caller's window.
   */
  function inspectRequestParams(params) {
    const selectorGiven = params?.selector !== undefined;
    const textGiven = params?.text !== undefined;
    if (!selectorGiven && !textGiven) {
      throw new InspectError(INVALID_PARAMS_CODE, MISSING_INSPECT_FILTER_MESSAGE);
    }
    const selector = selectorGiven ? params.selector : null;
    const text = textGiven ? params.text : null;
    if ((selectorGiven && typeof selector !== "string") || (textGiven && typeof text !== "string")) {
      throw new InspectError(INVALID_PARAMS_CODE, INSPECT_FILTER_TYPE_MESSAGE);
    }
    const limit = params?.limit === undefined ? INSPECT_LIMIT_DEFAULT : params.limit;
    if (!Number.isInteger(limit) || limit < INSPECT_LIMIT_MIN || limit > INSPECT_LIMIT_MAX) {
      throw new InspectError(INVALID_PARAMS_CODE, INSPECT_LIMIT_MESSAGE);
    }
    // A switch, not a truthy value: `"false"` from a sloppy caller must not read as
    // "hidden elements please".
    const includeHidden = params?.includeHidden === undefined ? false : params.includeHidden;
    if (typeof includeHidden !== "boolean") {
      throw new InspectError(INVALID_PARAMS_CODE, INSPECT_INCLUDE_HIDDEN_MESSAGE);
    }
    return { selector, text, limit, includeHidden };
  }

  /**
   * Lists the matching elements of the agent tab.
   *
   * The page answers the whole result — `count`, `truncated` and the elements — in one
   * piece, because only the page can count without shipping everything first. The
   * limits travel as arguments for the same reason the filters do: `toString()` loses
   * this scope, and a literal inside the snippet would be a second place to keep a
   * number up to date.
   */
  async function inspectAgentTab(params) {
    const request = inspectRequestParams(params);
    // After the parameter table and before the tab, like the window of a `read`: a
    // caller with a wrong `frame` hears about its own mistake whether or not an agent
    // tab exists, and nothing is injected for a request that could not be answered.
    const want = frameWantedOf(params, InspectError);

    const tab = await addressedAgentTab(params, InspectError);

    const pageRequest = {
      selector: request.selector,
      text: request.text,
      limit: request.limit,
      includeHidden: request.includeHidden,
      candidateLimit: INSPECT_CANDIDATE_LIMIT,
      textLimit: INSPECT_TEXT_LIMIT,
      classLimit: INSPECT_CLASS_LIMIT,
    };
    // The answer is one entry per frame, and `frameTargetOf` picks the addressed one: a
    // caller without a `frame` keeps the single main-frame answer every earlier
    // increment injected.
    const results = await injectPageCode(tab.id, inspectPageCode(pageRequest, want), {
      allFrames: want !== null,
    });
    return inspectResultOf(tab.id, frameTargetOf(results, want));
  }

  /**
   * The page's verdict, or a refusal that names why there is none.
   *
   * Deliberately thin, the way `pageResultOf` is not: nothing is recomputed here.
   * `count` and `truncated` are the page's own words — re-deriving them from the
   * delivered elements would turn "5000 seen" into "2 delivered" and call a capped
   * page exact. `invalid_selector` is the page's refusal and keeps its code; a shape
   * that is not the documented one is our own bug, and the only producer of
   * `inspect_failed`. A *throw* inside the snippet never arrives here —
   * `injectPageCode` decides the code of a rejection from the tab's state.
   */
  function inspectResultOf(tabId, entry) {
    if (entry?.outcome === "invalid_selector") {
      throw new InspectError("invalid_selector", INVALID_SELECTOR_MESSAGE);
    }
    if (!isUsableInspectResult(entry)) {
      console.warn(UNUSABLE_INSPECT_RESULT_LOG_LINE);
      throw new InspectError(INSPECT_FAILED_CODE, INSPECT_FAILED_MESSAGE);
    }
    return {
      tabId,
      url: entry.url,
      title: entry.title,
      count: entry.count,
      // One field, two meanings, both "there was more": more hits than the caller's
      // `limit` asked for, or the candidate cap was reached — and then `count` is a
      // lower bound instead of the truth.
      truncated: entry.truncated === true,
      elements: entry.elements,
    };
  }

  /** The fields `inspectPageSource` always sets; anything else is our own bug. */
  function isUsableInspectResult(value) {
    if (value === null || typeof value !== "object") return false;
    return (
      value.outcome === "ok" &&
      typeof value.url === "string" &&
      typeof value.title === "string" &&
      // `0` is a good answer — an empty hit list is no error — so the check is on the
      // type, not on truthiness.
      Number.isInteger(value.count) &&
      Array.isArray(value.elements)
    );
  }

  /**
   * The query itself, inside the page.
   *
   * Synchronous, and every limit arrives as an argument (same rule as
   * `readPageSource`): a closure over this module's constants does not survive the
   * trip into the other realm. Two costs are split on purpose — `innerText` (layout)
   * runs once per examined candidate, which the candidate cap bounds, while the
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
   * A module function like `describeElement`, and for the same reason: it travels into
   * the page through `toString()` and may therefore close over nothing.
   *
   * Counting quotes is the whole parser. `[title="a>>>b"]` is one selector and
   * `a >>> b` is two; whether a segment is a *usable* selector is not decided here — the
   * whitelist `isSimpleSelector` answers that.
   *
   * Each segment is trimmed exactly once, because that trimming is what the whitelist
   * sees: `my-card >>> button`, the spelling of the whole spec, has to pass with its
   * spaces around the jump. `null` instead of a throw, because a thrown error inside the
   * snippet would reach the caller as `not_readable` and not as the refusal it is.
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
   * No closure, like `splitPiercingSelector`: the patterns are built per call, because a
   * module-level list would not survive the trip through `toString()`.
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
   * The `>>>` snippet: it decides *inside the page* what a jump means.
   *
   * A snippet of its own instead of a second branch in `inspectPageSource`, because that
   * function's `toString()` *is* the payload of every `inspect` without a jump — a branch
   * in it would have changed every one of those bytes. Which of the two travels is
   * `inspectPageCode`'s call, and that call is a payload choice, not a split: the strings
   * arrive whole and are cut here, where only the page can tell whether a jump lands in a
   * shadow tree.
   *
   * The frame filter comes first, exactly as in the plain snippet: a frame nobody
   * addressed answers the marker and asks nothing — `frameTargetOf` builds its candidates
   * from that `href`.
   */
  function inspectShadowPageSource(request, want) {
    if (!isAddressedFrame(want)) {
      return { outcome: "not_the_frame", href: String(location.href) };
    }
    const segments = splitPiercingSelector(request.selector);
    if (segments === null) return { outcome: "invalid_selector" };
    // A `>>>` that never left its quotes is one plain selector, and the plain snippet
    // already knows how to answer it — a copy of that query here would drift from it.
    if (segments.length === 1) return inspectPageSource(request, want);
    // Both sides of every jump are one simple selector, and that is decided *before* the
    // first query: the harness matcher throws for what the whitelist refuses, so a search
    // first would be red here and green on a real page — and the refusal would name the
    // wrong reason.
    if (!segments.every((segment) => isSimpleSelector(segment))) {
      return { outcome: "invalid_selector" };
    }

    // The delivery tail of `inspectPageSource`, copied on purpose and not shared: that
    // snippet's `toString()` is byte-pinned (`INSPECT_PAGE_SOURCE_PIN`), so pulling these
    // six functions out into a helper would rewrite every plain `inspect` payload. The
    // two copies are kept honest by a case that compares the delivered field sets of a
    // shadow hit and a document hit — whoever calls that case superfluous should read
    // this comment before deleting it.
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
      // Stage one is the document's own query, exactly as the plain snippet asks it. The
      // selector passed the whitelist, so this is not expected to throw — the catch is
      // there for the same reason it is there in the plain snippet, because a page may
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
          // The same refusal as the plain snippet's: a string the page will not parse is
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
      // The same two filters as the plain snippet, in the same order: visibility first,
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
   * A module function shipped into the page through `toString()` and handed to the
   * snippet as a third part, because the uniqueness check needs `querySelectorAll` and
   * only the page has one. It closes over nothing — `toString()` loses this scope, so
   * both limits are arguments (the rule `describeElement` already states for itself).
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

    // The same split as `classesOf` in `inspectPageSource` — two realms, no shared
    // scope, and the page payload is not the place for a third helper.
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
   * A function of its own instead of a `root` parameter on the first one, because `eval`
   * ships that one too: a changed signature would change two payloads, and the plain
   * path is pinned byte for byte. Everything else is that function's reasoning — a
   * candidate has to find exactly *this* element, and a value carrying a `"` is refused
   * instead of escaped.
   *
   * Two things differ, and both come from the tree. Every candidate is checked against
   * `root` instead of the document, because `document.querySelectorAll` never looks into
   * a shadow root — every identity hook there would be silently discarded and the caller
   * would get a path that finds nothing. And the position counts along `parentNode`: a
   * node at the top of a root has no `parentElement`, so the document's `positionOf`
   * would call every same-tag sibling the first, and the returned selector would point
   * at a different element while looking right. It closes over nothing — `toString()`
   * loses this scope, so both limits are arguments.
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

  /**
   * The inspect snippet: the three shared helpers, the extra helpers, the query.
   *
   * The builder is a third part instead of a third shared helper: `PAGE_HELPERS_CODE`
   * is the payload of every click and every typing, and forty dead lines there would
   * be pure cost for both.
   *
   * The filter travels always, `null` included: one shape for both callers is easier to
   * read than a condition, and `isAddressedFrame(null)` is the main-frame answer.
   *
   * A `>>>` in the selector is the only thing this side notices, and it only picks the
   * payload: a `>>>` inside an attribute value needs the shadow snippet as well, and it
   * is the snippet that decides the string is one selector. Without a jump the payload is
   * byte-for-byte the one every earlier increment sent — the plain snippet, the builder,
   * nothing of the shadow path.
   */
  function inspectPageCode(request, want) {
    const jumps = typeof request.selector === "string" && request.selector.indexOf(">>>") !== -1;
    if (!jumps) {
      return pageSnippetCode(inspectPageSource, [request, want], selectorForElement.toString());
    }
    // The shadow snippet calls five: the plain snippet for the one-segment case, the
    // document builder the plain snippet needs anyway, the two pure functions of the
    // split, and the builder for a tree the document cannot see into.
    const extraHelpers = [
      inspectPageSource,
      selectorForElement,
      splitPiercingSelector,
      isSimpleSelector,
      shadowSelectorForElement,
    ]
      .map((helper) => helper.toString())
      .join("\n");
    return pageSnippetCode(inspectShadowPageSource, [request, want], extraHelpers);
  }

  /* ------------------------------------------------------------------ focus */

  /** Same contract as `NavigateError`: the code the wire protocol names rides along. */
  class FocusError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "FocusError";
      this.code = code;
    }
  }

  /**
   * Answers one `focus` request: the agent tab comes forward, the answer says where
   * it stands.
   *
   * Nothing is read here, so `not_readable` and the `about:` rule have no say: the
   * two page fields come from the tab object, and a window that would not come
   * forward is a half success, still `ok: true`.
   */
  async function answerFocus(target, request) {
    try {
      sendResponse(target, request.id, { ok: true, result: await focusAgentTab(request.params) });
    } catch (error) {
      sendResponse(target, request.id, { ok: false, error: focusErrorFor(error) });
    }
  }

  function focusErrorFor(error) {
    if (error instanceof FocusError) return { code: error.code, message: error.message };
    // Deliberately not the browser's own text: the caller cannot act on it, and a
    // tab that vanished between `get` and `update` deserves one sentence rather
    // than a raw `invalid tab id`.
    return { code: FOCUS_FAILED_CODE, message: FOCUS_FAILED_MESSAGE };
  }

  /**
   * `focus` takes `tab` and nothing else — not even an ignored argument.
   *
   * Checked before the tab is resolved, so a sloppy caller hears about its mistake
   * without anything being brought forward first. `tabId` is *not* the wire name and
   * is refused here on purpose: the two tripwire cases of this rule send exactly that.
   */
  function focusRequestParams(params) {
    if (params === undefined || params === null) return;
    const isObject = typeof params === "object" && !Array.isArray(params);
    const hasOnlyTab = isObject && Object.keys(params).every((key) => key === "tab");
    if (!hasOnlyTab) {
      throw new FocusError(INVALID_PARAMS_CODE, FOCUS_PARAMS_MESSAGE);
    }
  }

  /**
   * Brings the agent tab to the front, and its window with it.
   *
   * The order is contract: an active tab in a background window is not visible,
   * and a focused window with another active tab would show the wrong page.
   *
   * The two calls sit in two separate `try` blocks, and that is contract too, not
   * taste: if the window is gone between them, the tab is still forward, and
   * answering `focus_failed` would deny a success that already happened. Only a
   * throwing `tabs.update` is a failure.
   *
   * No slot, no `supersedePageSlot`: this call changes no page, so it may
   * neither end a running navigation nor be ended by one (the `active: true` it
   * triggers is a `tabs.onUpdated` without `status`, which `waitForTabComplete`
   * ignores).
   *
   * `focused` is the one field that is *measured* instead of echoed: `windows.update`
   * answers with the state from before the change, so its `focused` is the old truth.
   * A `windows.get` afterwards asks what is. A failing read is not a failure of the
   * call — the update's value is the weakest remaining claim, and `focused: false`
   * from a read that worked must not fall back to it (hence `??`, not `||`).
   */
  async function focusAgentTab(params) {
    focusRequestParams(params);

    // `addressedAgentTab` covers all three sorts of "no agent tab": never stored, tab
    // gone, tab in a container.
    const tab = await addressedAgentTab(params, FocusError);

    // No own `try`: a throw here is the one failure this call reports.
    const activeTab = await browser.tabs.update(tab.id, { active: true });
    let window = null;
    try {
      window = await browser.windows.update(tab.windowId, { focused: true });
    } catch {
      // Intentionally swallowed: `focused: false` below is the whole report. A log
      // line would repeat on every call into a window the operator closed.
    }

    // No read at all when the update threw: that window is gone, and asking again
    // would only throw a second time — for a value the update already answered.
    let focusedAfter = null;
    if (window !== null) {
      try {
        focusedAfter = await browser.windows.get(tab.windowId);
      } catch {
        // Intentionally swallowed: the update's answer below is the fallback.
      }
    }

    // `active` stays the return value of `tabs.update` — the same rule as before, and
    // it may resolve without activating anything, so `active: false` is the truth.
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      url: asText(tab.url),
      title: asText(tab.title),
      active: activeTab?.active === true,
      focused: (focusedAfter?.focused ?? window?.focused) === true,
    };
  }

  /* ------------------------------------------------------------------ eval */

  /** Same contract as `NavigateError` and `InspectError`: the code rides along. */
  class EvalError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "EvalError";
      this.code = code;
    }
  }

  /**
   * Answers one `eval` request: code in, the page's verdict out.
   *
   * A `ReadError` from the injection passes through untouched, exactly like in
   * `answerInspect`: `page_busy` and `not_readable` are the *tab's* verdict, inherited
   * from `read`, and calling them `eval_failed` would hide the difference between a
   * page that is not there yet and a snippet of ours that misbehaved. That third line
   * is the whole of the inherited error truth, which is why it is copied and not
   * re-invented.
   */
  async function answerEval(target, request) {
    try {
      sendResponse(target, request.id, { ok: true, result: await evalAgentTab(request.params) });
    } catch (error) {
      sendResponse(target, request.id, { ok: false, error: evalErrorFor(error) });
    }
  }

  function evalErrorFor(error) {
    if (error instanceof EvalError) return { code: error.code, message: error.message };
    // The filter's verdict, built like `read` builds it — same code, same details.
    if (error instanceof FrameError) return frameErrorFrame(error);
    if (error instanceof ReadError) return readErrorFrame(error);
    return { code: EVAL_FAILED_CODE, message: EVAL_FAILED_MESSAGE };
  }

  /**
   * The one parameter this side checks itself: the code.
   *
   * Not trimmed, deliberately: a code made of whitespace is no empty code — it runs,
   * returns nothing and answers `null`. Only a missing, non-string or empty code and
   * an over-long one are decisions of ours.
   *
   * `tab` is *not* checked here: `addressedAgentTab` owns type and lower bound for
   * every tool, and a second opinion would be a second place to change the rule.
   */
  function evalRequestParams(params) {
    const code = params?.code;
    if (typeof code !== "string") {
      throw new EvalError(INVALID_PARAMS_CODE, MISSING_EVAL_CODE_MESSAGE);
    }
    if (code === "") {
      throw new EvalError(INVALID_PARAMS_CODE, EMPTY_EVAL_CODE_MESSAGE);
    }
    if (code.length > EVAL_CODE_LIMIT) {
      throw new EvalError(INVALID_PARAMS_CODE, EVAL_CODE_TOO_LONG_MESSAGE);
    }
    return { code };
  }

  /**
   * Runs the code of the agent tab — in this order, which is contract (spec 19):
   * switch, parameters, tab, injection.
   *
   * The switch comes first so that a switched-off `eval` sorts no parameter before it
   * refuses, and — the part that matters — asks the browser to inject *nothing*.
   * `eval_not_allowed` is therefore an answer about the operator's decision, not about
   * the caller's request.
   *
   * No slot and no `supersedePageSlot`, unlike `click` and `navigate`: what the code
   * does is unknown, so a `settled` would be a claim nobody can make, and `superseded`
   * would claim an execution stopped that is still running. Two calls in one tab just
   * both run.
   */
  async function evalAgentTab(params) {
    if (!(await evalAllowed())) {
      throw new EvalError(EVAL_NOT_ALLOWED_CODE, EVAL_NOT_ALLOWED_MESSAGE);
    }

    const request = evalRequestParams(params);
    // After the switch and the parameter table: a switched-off `eval` answers
    // `eval_not_allowed` whatever else is wrong with the call (spec 19), and a caller
    // with a wrong `frame` hears about it before a tab is resolved.
    const want = frameWantedOf(params, EvalError);

    const tab = await addressedAgentTab(params, EvalError);

    // Every number the page needs arrives as an argument: the snippet closes over
    // nothing, and a closure over this module's constants would not survive the trip.
    const cfg = {
      code: request.code,
      timeoutMs: EVAL_TIMEOUT_MS,
      messageLimit: EVAL_MESSAGE_LIMIT,
      resultLimit: EVAL_RESULT_LIMIT,
      // `inspect`'s limits, not new numbers: the selector a caller gets here has to be
      // the same string `inspect` hands out, or the two tools would describe one
      // element in two ways.
      valueLimit: INSPECT_TEXT_LIMIT,
      classLimit: INSPECT_CLASS_LIMIT,
    };

    // The guard is the extension's answer to a throttled page timer (see
    // `EVAL_GUARD_MS`): the *call* ends on time even when the page's own deadline
    // does not.
    const guard = guardAfter(EVAL_GUARD_MS);
    try {
      const results = await Promise.race([
        injectPageCode(tab.id, evalPageCode(cfg, want), { allFrames: want !== null }),
        guard.promise,
      ]);
      // `executeScript` answers an array, `guardAfter` answers `undefined`. So "no
      // array" is the guard — or a browser that handed back nothing at all, which is
      // the same statement for the caller: no answer from the page in time. The check
      // has to stay *before* the frame selection: `frameTargetOf` would read the guard's
      // `undefined` as "no frame answered" and turn the timeout into `frame_not_found`.
      if (!Array.isArray(results)) {
        throw new EvalError(EVAL_TIMEOUT_CODE, EVAL_TIMEOUT_MESSAGE);
      }
      return evalResultOf(tab.id, frameTargetOf(results, want));
    } finally {
      // Disarmed whichever side won: an uncleared guard would outlive the call it
      // belonged to.
      guard.cancel();
    }
  }

  /**
   * The page's verdict, or a refusal that names why there is none.
   *
   * Thin like `inspectResultOf`, for the same reason: `url`, `title`, `elapsedMs` and
   * the result are the page's own words. Recomputing the elapsed time here would put a
   * second measurement next to the one that was taken around the call, and the page is
   * the only source there is.
   *
   * `json` is parsed here — the only work left, because the string is what travelled.
   * A parse can only fail on a bug of ours, and then the generic `eval_failed` of
   * `evalErrorFor` answers without a word of content.
   */
  function evalResultOf(tabId, entry) {
    if (entry?.outcome === "threw") {
      throw new EvalError(
        EVAL_FAILED_CODE,
        typeof entry.message === "string" ? entry.message : EVAL_FAILED_MESSAGE,
      );
    }
    if (entry?.outcome === "timeout") {
      throw new EvalError(EVAL_TIMEOUT_CODE, EVAL_TIMEOUT_MESSAGE);
    }
    if (entry?.outcome === "too_large") {
      throw new EvalError(EVAL_RESULT_TOO_LARGE_CODE, EVAL_RESULT_TOO_LARGE_MESSAGE);
    }
    if (entry?.outcome === "unserializable") {
      throw new EvalError(EVAL_RESULT_UNSERIALIZABLE_CODE, EVAL_RESULT_UNSERIALIZABLE_MESSAGE);
    }
    if (!isUsableEvalResult(entry)) {
      console.warn(UNUSABLE_EVAL_RESULT_LOG_LINE);
      throw new EvalError(EVAL_FAILED_CODE, EVAL_FAILED_MESSAGE);
    }
    return {
      tabId,
      url: entry.url,
      title: entry.title,
      elapsedMs: entry.elapsedMs,
      result: JSON.parse(entry.json),
    };
  }

  /** The fields `evalPageSource` sets for `ok`; anything else is our own bug. */
  function isUsableEvalResult(value) {
    if (value === null || typeof value !== "object") return false;
    return (
      value.outcome === "ok" &&
      typeof value.url === "string" &&
      typeof value.title === "string" &&
      // `0` is a good answer — a page that answered before the millisecond turned over
      // — so the check is on the type, not on truthiness.
      Number.isInteger(value.elapsedMs) &&
      typeof value.json === "string"
    );
  }

  /**
   * The code of the agent tab, run in the page — and everything that follows it.
   *
   * Every number arrives as an argument and `selectorForElement` arrives as source
   * (`evalPageCode`), because nothing of this scope survives the trip into the page.
   * The code under test sees neither: `new Function` compiles in the page's global
   * scope, so the IIFE's locals stay out of its reach while the DOM stays in it.
   *
   * Answers one `outcome` in every case and never a rejection: the caller's vocabulary
   * is the wire protocol's codes, and a `TypeError` thrown out of here would reach it as
   * "our bug" instead of "the page said no".
   */
  async function evalPageSource(cfg, want) {
    // The frame filter of spec 25, and the first statement on purpose: a frame that is
    // not meant runs no code at all. That is the whole difference between "described"
    // and "restricted" for this tool — `eval` may change the page, and a frame nobody
    // addressed must not be changed by a call that was meant for another one.
    if (!isAddressedFrame(want)) {
      return { outcome: "not_the_frame", href: String(location.href) };
    }
    /**
     * The hit's own address, attached by every answer below.
     *
     * Unconditionally, unlike `readPageSource`'s twin: the `ok` answer has always carried
     * it, and a refusal without one turns two throwing frames into `frame_ambiguous` with
     * `candidates: [null, null]` — the extension builds those candidates out of exactly
     * this field. `evalResultOf` drops it on its way to the wire either way.
     */
    function frameFieldsOf() {
      return { href: String(location.href) };
    }
    /**
     * One value, as data JSON can carry.
     *
     * `undefined` becomes `null` *by hand*, and that is the point of the walk:
     * `JSON.stringify({a: undefined})` drops the key, while a missing key is a
     * different statement than `"a": null`.
     *
     * `ancestors` is the path, not every object ever seen: a reference that is shared
     * twice is duplicated, like `JSON.stringify` would, while a real cycle is the one
     * thing JSON cannot say.
     */
    function serialize(value) {
      function walk(current, ancestors) {
        if (current === null || current === undefined) return null;
        const type = typeof current;
        if (type === "function") return "[function]";
        if (type === "symbol") return "[symbol]";
        // A decimal string instead of a number: `JSON` has no `BigInt`, and a rounded
        // number would be a different value without saying so.
        if (type === "bigint") return current.toString();
        if (type !== "object") return current;

        // A DOM node of any kind: `nodeType` is the one property they all share.
        if (typeof current.nodeType === "number") {
          // Only an element has a tag and a selector — a text node, a comment or a
          // document has neither, and inventing one would be a second format. Its
          // content is one `.textContent` away in a second call, which is the cheaper
          // contract than two shapes in one answer.
          if (current.nodeType !== 1) return { kind: "node", nodeType: current.nodeType };
          return {
            kind: "node",
            // Lower-cased like `selectorForElement` does it, so `tag` and `selector`
            // describe the same element in the same spelling.
            tag: String(current.tagName).toLowerCase(),
            selector: selectorForElement(current, cfg.valueLimit, cfg.classLimit),
          };
        }

        if (ancestors.has(current)) throw new Error("circular result");
        ancestors.add(current);
        try {
          if (Array.isArray(current)) return current.map((entry) => walk(entry, ancestors));
          const mapped = {};
          for (const key of Object.keys(current)) mapped[key] = walk(current[key], ancestors);
          return mapped;
        } finally {
          // Popped on the way out: refused is a cycle, not an object that happens to be
          // referenced from two places.
          ancestors.delete(current);
        }
      }

      return walk(value, new WeakSet());
    }

    /** Whether the code produced something we should wait for. */
    function isThenable(value) {
      return value !== null && typeof value === "object" && typeof value.then === "function";
    }

    /**
     * Waits for `thenable`, but not longer than `cfg.timeoutMs`.
     *
     * Answers `deadline` — the caller's marker object, so "time ran out" cannot be
     * confused with a code that answered nothing — and always disarms the timer: a page
     * timer that outlives the answer keeps the content process busy for a value nobody
     * will read.
     */
    async function withinDeadline(thenable, deadline) {
      let timerId = null;
      try {
        return await Promise.race([
          thenable,
          new Promise((resolve) => {
            timerId = setTimeout(() => resolve(deadline), cfg.timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timerId);
      }
    }

    /**
     * The message of a throw, whatever was thrown.
     *
     * An `Error` carries one, a thrown string does not, and both are the page's words.
     * Cut to what a caller can read — a stack never travels, because that stack is our
     * side and not theirs.
     */
    function messageOf(error) {
      const raw = error?.message ?? error;
      return String(raw).slice(0, cfg.messageLimit);
    }

    // The window of `elapsedMs`: from immediately before the code is called to after
    // its result is mapped. A number taken outside this window would be no measurement.
    const startedAt = Date.now();
    // A value no code can reach: the locals of this function are invisible to
    // `new Function`, which compiles in the page's global scope.
    const deadline = { deadline: true };

    let produced;
    try {
      // A syntax error is thrown right here, while the function is built, and is the
      // caller's failure exactly like a throw inside the code: same outcome, same
      // message, because for the caller the two are the same event.
      produced = new Function(cfg.code)();
      if (isThenable(produced)) {
        produced = await withinDeadline(produced, deadline);
        if (produced === deadline) return { outcome: "timeout", ...frameFieldsOf() };
      }
    } catch (error) {
      return { outcome: "threw", message: messageOf(error), ...frameFieldsOf() };
    }

    let json;
    try {
      json = JSON.stringify(serialize(produced));
    } catch (error) {
      return { outcome: "unserializable", ...frameFieldsOf() };
    }

    // Measured after the mapping, before the size check: the mapping is what the code
    // cost the page, the check is our bookkeeping.
    const elapsedMs = Date.now() - startedAt;
    // A refusal, never a cut: half a JSON is no answer. The caller who needs a list is
    // served by `inspect`.
    if (json.length > cfg.resultLimit) return { outcome: "too_large", ...frameFieldsOf() };
    return {
      outcome: "ok",
      url: location.href,
      title: document.title,
      elapsedMs,
      json,
      ...frameFieldsOf(),
    };
  }

  /**
   * The eval snippet: the three shared helpers, the selector builder, the evaluator.
   *
   * The builder arrives as source like in `inspectPageCode`, because mapping a DOM
   * element needs the one selector a caller can hand back to `click`. The filter
   * travels always, `null` included (see `inspectPageCode`).
   */
  function evalPageCode(cfg, want) {
    return pageSnippetCode(evalPageSource, [cfg, want], selectorForElement.toString());
  }

  /* ------------------------------------------------------------ screenshot */

  /** Same contract as `EvalError`: the code the wire protocol names rides along. */
  class ScreenshotError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ScreenshotError";
      this.code = code;
    }
  }

  /**
   * Whether the operator allowed pictures of the tab — default `false`.
   *
   * The third twin of `passwordFieldsAllowed` and `evalAllowed`, deliberately line for
   * line: only the boolean `true` opens, and an unreadable storage counts as *off*. The
   * permit has to be the closed answer exactly here, because a picture shows the
   * logged-in profile — more than any text this extension hands out.
   */
  async function screenshotAllowed() {
    try {
      const stored = await browser.storage.local.get([ALLOW_SCREENSHOT]);
      return stored?.[ALLOW_SCREENSHOT] === true;
    } catch (error) {
      console.warn(SCREENSHOT_OPTION_READ_FAILED_LOG_LINE, error);
      return false;
    }
  }

  /**
   * Answers one `screenshot` request: one picture of the agent tab, or a refusal.
   *
   * Nothing is injected here, so `page_busy` and `not_readable` have no say —
   * `captureTab` needs no `executeScript`, hence no injection the browser could refuse
   * for a page that is not ready. A tab that is gone is `no_agent_tab`, decided by
   * `addressedAgentTab`.
   */
  async function answerScreenshot(target, request) {
    try {
      sendResponse(target, request.id, { ok: true, result: await screenshotAgentTab(request.params) });
    } catch (error) {
      sendResponse(target, request.id, { ok: false, error: screenshotErrorFor(error) });
    }
  }

  function screenshotErrorFor(error) {
    if (error instanceof ScreenshotError) return { code: error.code, message: error.message };
    // Deliberately not the browser's own text: a caller cannot act on it, and everything
    // the browser says about a failed capture is already cut into a `ScreenshotError` by
    // `captureAgentTab`.
    return { code: SCREENSHOT_FAILED_CODE, message: SCREENSHOT_FAILED_MESSAGE };
  }

  /**
   * `screenshot` takes `tab` and nothing else — not even an ignored argument.
   *
   * Checked before the tab is resolved, so a sloppy caller hears about its mistake
   * without a picture being taken first. The *type* of `tab` is not checked here:
   * `addressedAgentTab` owns type and lower bound for every tool, and a second opinion
   * would be a second place to change the rule.
   */
  function screenshotRequestParams(params) {
    if (params === undefined || params === null) return;
    const isObject = typeof params === "object" && !Array.isArray(params);
    const hasOnlyTab = isObject && Object.keys(params).every((key) => key === "tab");
    if (!hasOnlyTab) {
      throw new ScreenshotError(INVALID_PARAMS_CODE, SCREENSHOT_PARAMS_MESSAGE);
    }
  }

  /**
   * Takes the picture of the agent tab — in this order, which is contract (spec 20):
   * switch, parameters, tab, capture.
   *
   * The switch comes first so that a switched-off call sorts no parameter and resolves
   * no tab before it refuses, and — the part that matters — never asks the browser for a
   * picture. `screenshot_not_allowed` is therefore an answer about the operator's
   * decision, not about the caller's request.
   *
   * No slot and no settle wait: `captureTab` only reads, and whether the page is "done"
   * does not change the picture. A `settled` here would be a claim about a state the
   * picture itself shows.
   */
  async function screenshotAgentTab(params) {
    if (!(await screenshotAllowed())) {
      throw new ScreenshotError(SCREENSHOT_NOT_ALLOWED_CODE, SCREENSHOT_NOT_ALLOWED_MESSAGE);
    }

    screenshotRequestParams(params);

    const tab = await addressedAgentTab(params, ScreenshotError);

    return captureAgentTab(tab);
  }

  /**
   * One capture, answered as both the data URL and its base64 half.
   *
   * `dataUrl` is no dead weight: shrinking the picture re-encodes it and needs the
   * source again. Cutting the prefix twice — the second time possibly with a guessed
   * mime — is the trap this return shape keeps shut.
   */
  async function captureTabOnce(tabId) {
    const dataUrl = await browser.tabs.captureTab(tabId, { format: "png" });
    return { dataUrl, base64: base64OfDataUrl(dataUrl) };
  }

  /**
   * The base64 half of a data URL — the only part of a picture that travels.
   *
   * One place for the cut, because two places would eventually disagree about the mime
   * in front of it: the capture's own data URL and the canvas's re-encode both come
   * through here.
   */
  function base64OfDataUrl(dataUrl) {
    const isDataUrl = typeof dataUrl === "string" && dataUrl.startsWith("data:");
    const commaIndex = isDataUrl ? dataUrl.indexOf(",") : -1;
    if (commaIndex === -1) {
      // No data URL, no picture: whatever came back is not something a caller can read,
      // and passing it on as `base64` would be a lie with a measured size.
      throw new ScreenshotError(SCREENSHOT_FAILED_CODE, SCREENSHOT_FAILED_MESSAGE);
    }
    return dataUrl.slice(commaIndex + 1);
  }

  /**
   * The decoded length of a base64 string — the number the limit is measured against.
   *
   * `Buffer` is Node's and the background page is a browser, so the arithmetic is done
   * by hand: three bytes per four characters, minus the padding that the last group
   * does not carry. (68 decoded bytes travel as 92 characters with one `=`, and
   * `Math.floor(92 · 3 / 4)` alone would claim 69.)
   */
  function bytesOf(base64) {
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
  }

  /**
   * Width and height out of the PNG header: IHDR, bytes 16–23.
   *
   * Reading the header beats loading an `Image` only to learn two numbers — no decode,
   * no timeout, no canvas. The signature check is not decoration: a base64 streak of the
   * right length that is not a PNG would otherwise be measured and reported as a picture
   * with plausible dimensions. A header that is missing or too short is
   * `screenshot_failed`, because `0 × 0` would be a silent non-answer.
   */
  function pngSizeOf(base64) {
    // 32 characters are 24 decoded bytes: signature (8), IHDR length and type (8) and
    // width plus height (8). Anything shorter has no size to report.
    const head = decodeBase64Head(base64);
    if (head === null || head.length < 24 || !hasPngSignature(head)) {
      throw new ScreenshotError(SCREENSHOT_FAILED_CODE, SCREENSHOT_FAILED_MESSAGE);
    }
    return { width: uint32At(head, 16), height: uint32At(head, 20) };
  }

  /**
   * The first 24 decoded bytes, or `null` when there are not that many.
   *
   * `atob` throws on anything outside its alphabet, and a thrown `InvalidCharacterError`
   * would reach the caller as our bug instead of "the browser handed back no picture".
   */
  function decodeBase64Head(base64) {
    if (base64.length < 32) return null;
    try {
      return atob(base64.slice(0, 32));
    } catch {
      return null;
    }
  }

  function hasPngSignature(bytes) {
    return (
      bytes.charCodeAt(0) === 0x89 &&
      bytes.charCodeAt(1) === 0x50 && // "P"
      bytes.charCodeAt(2) === 0x4e && // "N"
      bytes.charCodeAt(3) === 0x47 // "G"
    );
  }

  /** Four bytes, most significant first — `readUInt32BE` is Node's, not the browser's. */
  function uint32At(bytes, offset) {
    return (
      ((bytes.charCodeAt(offset) << 24) |
        (bytes.charCodeAt(offset + 1) << 16) |
        (bytes.charCodeAt(offset + 2) << 8) |
        bytes.charCodeAt(offset + 3)) >>>
      0
    );
  }

  /**
   * The picture, shrunk down the ladder until it fits in `SCREENSHOT_MAX_BYTES`.
   *
   * Stage 0 is the capture itself: it is only measured, never run, because
   * `SCREENSHOT_SCALE_STEPS[0]` describes the PNG that is already in hand. Every later
   * stage encodes once and is measured before the next one is tried — so a picture that
   * fits after stage 1 is never encoded a second time.
   *
   * The answer is always the *last* attempt, whether it fits or not: the caller has to
   * be able to name the numbers of the rung that lost, which is the whole point of the
   * `screenshot_too_large` sentence.
   */
  async function shrinkToLimit(capture) {
    const capturePicture = {
      format: "png",
      ...pngSizeOf(capture.base64),
      bytes: bytesOf(capture.base64),
      base64: capture.base64,
    };
    if (capturePicture.bytes <= SCREENSHOT_MAX_BYTES) return capturePicture;

    let attempt = capturePicture;
    for (const step of SCREENSHOT_SCALE_STEPS.slice(1)) {
      attempt = await encodeWithinDeadline(capture.dataUrl, step);
      if (attempt.bytes <= SCREENSHOT_MAX_BYTES) return attempt;
    }
    return attempt;
  }

  /**
   * One rung, encoded under its own deadline.
   *
   * `guard.cancel()` in the `finally` and not a bare `clearTimeout`: the timer id lives
   * inside `guardAfter`'s closure, exactly like the deadline of `evalAgentTab`. A guard
   * that is not disarmed would outlive the stage it belonged to.
   */
  async function encodeWithinDeadline(dataUrl, step) {
    const guard = guardAfter(SCREENSHOT_ENCODE_TIMEOUT_MS);
    try {
      const attempt = await Promise.race([encodeStep(dataUrl, step), guard.promise]);
      // `encodeStep` answers a picture, the guard answers `undefined`. No picture is the
      // deadline: the call ends instead of waiting for a decode that never comes.
      if (attempt === undefined) {
        throw new ScreenshotError(SCREENSHOT_FAILED_CODE, SCREENSHOT_FAILED_MESSAGE);
      }
      return attempt;
    } finally {
      guard.cancel();
    }
  }

  /**
   * One rung of the ladder: the picture at `step`'s size, in the format it names.
   *
   * The handlers are assigned **before** `src`, and that order is contract: a `data:` URL
   * the browser has already decoded once can finish before the handler exists, and the
   * call would then sit there until the deadline. `onerror` is the decode failure, and a
   * decode that produced no pixel — `naturalWidth === 0` — is refused too: `toDataURL` on
   * the 0×0 canvas that follows answers `"data:,"`, whose `bytesOf` is 0, and the ladder
   * would report a picture that fits and does not exist.
   */
  function encodeStep(dataUrl, step) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const fail = () => reject(new ScreenshotError(SCREENSHOT_FAILED_CODE, SCREENSHOT_FAILED_MESSAGE));
      image.onload = () => {
        if (image.naturalWidth === 0 || image.naturalHeight === 0) {
          fail();
          return;
        }
        try {
          resolve(encodeOnCanvas(image, step));
        } catch {
          // A canvas that refuses to draw — memory, no context, a tainted image —
          // leaves this stage without a picture, which is the same answer as a decode
          // that never happened.
          fail();
        }
      };
      image.onerror = fail;
      image.src = dataUrl;
    });
  }

  /** Draws the decoded image at the step's size and hands back what the canvas produced. */
  function encodeOnCanvas(image, step) {
    const { width, height } = scaledSizeFor(image.naturalWidth, image.naturalHeight, step.maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    const base64 = base64OfDataUrl(canvas.toDataURL("image/jpeg", step.quality));
    return { format: "jpeg", width, height, bytes: bytesOf(base64), base64 };
  }

  /**
   * The size a stage asks for: the longer edge capped at `maxEdge`, the ratio kept.
   *
   * Only ever smaller. A picture that is already inside the edge keeps its own size —
   * enlarging would add bytes and no detail. The short side is rounded rather than
   * floored, so 1600 × 900 on the 1200 stage becomes 1200 × 675 and not 1200 × 674.
   */
  function scaledSizeFor(sourceWidth, sourceHeight, maxEdge) {
    const longestEdge = Math.max(sourceWidth, sourceHeight);
    if (maxEdge === null || longestEdge <= maxEdge) {
      return { width: sourceWidth, height: sourceHeight };
    }
    const factor = maxEdge / longestEdge;
    return {
      width: Math.max(1, Math.round(sourceWidth * factor)),
      height: Math.max(1, Math.round(sourceHeight * factor)),
    };
  }

  /**
   * The picture of the agent tab, its header and its size included.
   *
   * The fallback is Firefox's, not ours: some window groups photograph only the active
   * tab, so a failed first attempt is repeated once after `tabs.update {active: true}` —
   * the only focus grab of this tool, and never on a tab that is already in front (that
   * call would have no effect but would still be a change). The window stays where it
   * is. `activated` reports whether the grab was needed, because the operator sees his
   * tab move.
   *
   * Not covered, and openly so: a tab in the back whose page cannot be photographed at
   * all (PDF viewer, `view-source:`) is still brought forward and then answered with
   * `screenshot_failed`. Telling the two failures apart would need the reason of the
   * first rejection, and those texts are no contract.
   */
  async function captureAgentTab(tab) {
    let capture;
    let activated = false;
    try {
      capture = await captureTabOnce(tab.id);
    } catch {
      // Intentionally swallowed: the first rejection's text is no contract (a PDF
      // viewer, a `view-source:` page and a busy tab all sound different and mean the
      // same here), and the second attempt's message is the one worth reporting.
      if (tab.active !== true) {
        activated = true;
        await browser.tabs.update(tab.id, { active: true });
      }
      capture = await captureAttemptOrFail(tab.id);
    }

    // The ladder answers either a picture that fits or its own last, best attempt — and
    // that attempt's numbers are what the refusal names.
    const picture = await shrinkToLimit(capture);
    if (picture.bytes > SCREENSHOT_MAX_BYTES) {
      throw new ScreenshotError(SCREENSHOT_TOO_LARGE_CODE, screenshotTooLargeMessageFor(picture));
    }

    return {
      tabId: tab.id,
      url: asText(tab.url),
      title: asText(tab.title),
      format: picture.format,
      width: picture.width,
      height: picture.height,
      bytes: picture.bytes,
      // `scaled` is "was re-encoded", not "has fewer pixels": a stage-1 JPEG of a
      // 1600 px capture keeps those 1600 px and is still no longer the capture's PNG.
      // Stage 0 is the only PNG on this ladder, so `format` is the honest reading.
      scaled: picture.format !== "png",
      activated,
      base64: picture.base64,
    };
  }

  /** The second capture, whose failure is the caller's one readable sentence. */
  async function captureAttemptOrFail(tabId) {
    try {
      return await captureTabOnce(tabId);
    } catch (error) {
      throw new ScreenshotError(SCREENSHOT_FAILED_CODE, screenshotFailureMessage(error));
    }
  }

  /**
   * The browser's message, cut to what a caller can read — and never a stack.
   *
   * An empty message is no answer at all, so it falls back to the generic sentence
   * instead of travelling as an empty string next to a code.
   */
  function screenshotFailureMessage(error) {
    const raw = typeof error?.message === "string" ? error.message : String(error ?? "");
    const cut = raw.slice(0, SCREENSHOT_MESSAGE_LIMIT);
    return cut === "" ? SCREENSHOT_FAILED_MESSAGE : cut;
  }

  /**
   * The `screenshot_too_large` sentence, built in one place.
   *
   * The numbers are the point: with them the caller can decide whether another tab
   * would help. Two formats for one measurement would be two truths about it, so the
   * extension writes the sentence and the bridge only passes it through.
   */
  function screenshotTooLargeMessageFor(picture) {
    return `Das Bild ist auch nach dem Verkleinern zu groß: ${picture.bytes} Bytes bei ` +
      `${picture.width} × ${picture.height} (Grenze ${SCREENSHOT_MAX_BYTES}).`;
  }

  /* ----------------------------------------------------------------- frames */

  /**
   * The refusal of a `frames` call: the code the wire protocol names rides along.
   *
   * Its own class and not `ReadError`, because a tool with its own error frame is the
   * pattern every tool here follows — `frameErrorFor` maps the shared `ReadError` of the
   * injection onto that frame by itself.
   */
  class FramesError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "FramesError";
      this.code = code;
    }
  }

  /**
   * The `frames` snippet: one frame's own address and whether it is the outermost one.
   *
   * `window.top === window` is asked *inside* the frame because that is the only place
   * that can answer it: `tabs.executeScript` in MV2 hands back the results without a
   * frame id, so nothing outside tells the main frame from a child.
   *
   * The address travels as it is — non-strings included. Which entry is a usable frame
   * is a single decision, and it lives in `framesOf`; a second opinion here would be a
   * second rule about the same field.
   */
  function framesPageSource() {
    return { href: location.href, top: window.top === window };
  }

  /** The snippet as one injected expression — the same wrapper every snippet takes. */
  function framesPageCode() {
    return pageSnippetCode(framesPageSource, []);
  }

  /**
   * The listed frames out of one `allFrames` result, and how many there are.
   *
   * The order is `executeScript`'s and is deliberately *not* promised — Firefox may
   * answer in any sequence, so nothing here sorts and no caller may pin a sequence as if
   * it were a contract. A caller that needs the main frame finds it by `top`.
   *
   * An entry without a string `href` is dropped, and the drop is why `count` comes from
   * the filtered list: a frame nobody can address is nothing `browser_frames` may name,
   * and counting it would make `count` and the list two different numbers under one word.
   *
   * A non-array answer is *not* "no frames": `executeScript` with `allFrames` always
   * answers a list, so an object here is an injection whose result nobody can read — our
   * own bug, and `frames_failed` says so instead of handing out an empty inventory that
   * looks like a page without frames (`asArray` would happily do exactly that).
   */
  function framesOf(results) {
    if (!Array.isArray(results)) {
      throw new FramesError(FRAMES_FAILED_CODE, FRAMES_FAILED_MESSAGE);
    }
    const frames = results
      .filter((entry) => typeof entry?.href === "string")
      .map((entry) => ({ href: entry.href, top: entry.top === true }));
    return { count: frames.length, frames };
  }

  /**
   * Lists the frames of the agent tab.
   *
   * One injection for every frame and no settle wait: this call takes an inventory, it
   * does not read a text — and a page that is still loading either defers the
   * injection (then the list describes the page as it stands) or refuses it (`page_busy`)
   * — which of the two, criterion 6 measures, not this comment.
   *
   * `url` is the tab's address, not a frame's: it says which page the list belongs to,
   * and `null` is the honest answer for a tab that reports no address.
   */
  async function framesAgentTab(params) {
    const tab = await addressedAgentTab(params, FramesError);
    const results = await injectPageCode(tab.id, framesPageCode(), { allFrames: true });
    const { count, frames } = framesOf(results);
    return { tabId: tab.id, url: asUrl(tab.url), count, frames };
  }

  /** Answers one `frames` request: the agent tab in, the list of its frames out. */
  async function answerFrames(target, request) {
    try {
      sendResponse(target, request.id, { ok: true, result: await framesAgentTab(request.params) });
    } catch (error) {
      sendResponse(target, request.id, { ok: false, error: frameErrorFor(error) });
    }
  }

  /**
   * The error frame of a `frames` call.
   *
   * `no_agent_tab` arrives as a `FramesError` from `addressedAgentTab` (first branch
   * below); the two injection refusals (`page_busy`, `not_readable`) arrive as
   * `ReadError`s from `injectPageCode` and keep the frame
   * `read` gives them: same codes, same sentences, same `details`. Translating instead of
   * recomputing is what keeps `frames` from telling a different story about a page
   * `read` would refuse for another reason.
   */
  function frameErrorFor(error) {
    if (error instanceof FramesError) return { code: error.code, message: error.message };
    if (error instanceof ReadError) return readErrorFrame(error);
    return { code: FRAMES_FAILED_CODE, message: describeError(error) };
  }

  /* ----------------------------------------------------------- transcript */

  /**
   * The refusal of a `transcript` call: the code the wire protocol names rides along.
   *
   * Its own class and not `ReadError`, for the reason `FramesError` gives above: every
   * tool answers with its own error frame, and the shared `ReadError` of an injection is
   * mapped onto that frame in `transcriptErrorFor` instead of leaking through unpacked.
   */
  class TranscriptError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "TranscriptError";
      this.code = code;
    }
  }

  /* --------------------------------------------------------- transcript wire */

  /**
   * The `api/timedtext` requests the extension has seen, per tab.
   *
   * A plain object without a prototype and *not* a `Map`: the keys are tab ids from the
   * browser, and the one `Map` of this file is the slot map. A second one would be a second
   * answer to "where does per-tab state live" — the kind of drift a test can forbid and a
   * reviewer should not have to explain.
   *
   * The address in here is a credential for the operator's session: it is never logged, never
   * answered and never sent to the bridge. Only the reading side of `transcript` looks at it,
   * and only for the tab the call addresses (spec 34).
   */
  const transcriptCaptionWire = Object.create(null);
  // Waits that are still hoping for an event. Kept next to the wire so `record` can settle
  // them without a second `webRequest` listener that would have to be removed again.
  const transcriptCaptionWireWaiters = new Set();
  // Only the eviction reads this: `Object.keys` of integer-like keys counts up, which is not
  // the order the requests came in.
  let transcriptCaptionWireTick = 0;

  /**
   * One observed request, as far as this tool cares: its address and its language marks.
   *
   * `null` for everything that is not a track file — another host, another path, or an
   * address without `lang`, which names no track at all. A *translated* address is kept and
   * marked by its `tlang`; the reading side is where it loses, because the file behind it
   * carries German while its `lang` says English (spec 33, M14).
   *
   * The address is the parsed one, not the raw string: it is what will be fetched, and a
   * fragment or a stray space in the observed string would go along otherwise.
   */
  function transcriptCaptionWireOf(url) {
    let parsed = null;
    try {
      parsed = new URL(String(url));
    } catch {
      return null;
    }
    const host = parsed.hostname;
    // `youtube.com` or a subdomain of it, never a bare suffix: `notyoutube.com` is somebody
    // else's host. `m.youtube.com` is admitted here even though the gate refuses it: the
    // mobile page never reaches the wait, and a second host filter would be a second,
    // silent answer to the same question.
    if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return null;
    if (parsed.pathname !== "/api/timedtext") return null;
    const languageCode = parsed.searchParams.get("lang");
    if (languageCode === null || languageCode === "") return null;
    return {
      address: parsed.href,
      languageCode,
      kind: parsed.searchParams.get("kind") ?? "",
      tlang: parsed.searchParams.get("tlang") ?? "",
      // From the address and not from `tabs.get`: a `webRequest` listener is synchronous,
      // and a promise here would record the answer of a question nobody waited for.
      // Nothing reads it yet; a later stage compares it against the tab's address, and an
      // address without `v` (the empty string here) must not count as "matches everything"
      // there.
      videoId: parsed.searchParams.get("v") ?? "",
    };
  }

  /**
   * Keeps one observed request, and tells the waits that were hoping for it.
   *
   * "The latest request of a language wins" is the load-bearing rule: a signature expires and
   * the player asks again, so the older address is the one that answers 404 (spec 33, M13).
   * Two requests are the same language when they agree in `lang`, `kind` and `tlang` — the
   * automatic track carries `kind=asr`, and a translated address is a different file behind
   * the same `lang`, so neither may overwrite the one the caller wants.
   */
  function recordTranscriptCaptionRequest(details) {
    const tabId = details?.tabId;
    // Requests without a tab name no page and belong to nobody; the browser says -1.
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const entry = transcriptCaptionWireOf(details.url);
    if (entry === null) return;

    transcriptCaptionWireTick += 1;
    const record = transcriptCaptionWire[tabId] ?? { seenAt: 0, entries: [] };
    record.seenAt = transcriptCaptionWireTick;
    const identity = (kept) => `${kept.languageCode}/${kept.kind}/${kept.tlang}`;
    const entries = record.entries.filter((kept) => identity(kept) !== identity(entry));
    entries.push(entry);
    while (entries.length > TRANSCRIPT_CAPTION_WIRE_LIMIT) entries.shift();
    record.entries = entries;
    transcriptCaptionWire[tabId] = record;
    forgetOldTranscriptCaptionTabs();
    settleTranscriptCaptionWaiters(tabId);
  }

  /** Drops the tab that was heard from longest ago, until the tab cap holds again. */
  function forgetOldTranscriptCaptionTabs() {
    let known = Object.keys(transcriptCaptionWire);
    while (known.length > TRANSCRIPT_CAPTION_WIRE_TAB_LIMIT) {
      let oldest = known[0];
      for (const tabId of known) {
        if (transcriptCaptionWire[tabId].seenAt < transcriptCaptionWire[oldest].seenAt) oldest = tabId;
      }
      delete transcriptCaptionWire[oldest];
      known = known.filter((tabId) => tabId !== oldest);
    }
  }

  /**
   * The stored address of the track the request describes, or `null`.
   *
   * `request.asr` is the caller's own decision about the kind (`transcriptIsAutomaticTrack` of
   * the target), so the automatic and the uploaded English track stay two different files —
   * the only thing that tells them apart at their addresses (spec 33, M1). A translated entry
   * never answers: it would deliver another language under the `lang` the caller asked for.
   */
  function transcriptCaptionWireLookup(tab, request) {
    const record = transcriptCaptionWire[tab.id];
    if (record === undefined) return null;
    let found = null;
    for (const entry of record.entries) {
      if (entry.languageCode !== request.languageCode) continue;
      if ((entry.kind === "asr") !== (request.asr === true)) continue;
      if (entry.tlang !== "") continue;
      found = entry;
    }
    return found;
  }

  /**
   * Tells the waits of one tab that a request arrived, and settles the ones it answers.
   *
   * Only a request the lookup finds ends a wait. Any other request of the same tab — another
   * language, a translated address, the auto-translated `tlang` the player asks for next — is
   * not an answer, and settling on one would report `no_address` while the requested track is
   * still on its way, a few milliseconds short of the deadline this wait exists for.
   */
  function settleTranscriptCaptionWaiters(tabId) {
    if (transcriptCaptionWireWaiters.size === 0) return;
    for (const waiter of [...transcriptCaptionWireWaiters]) {
      if (waiter.tab.id !== tabId) continue;
      const found = transcriptCaptionWireLookup(waiter.tab, waiter.request);
      if (found !== null) waiter.settle(found);
    }
  }

  /**
   * Waits until the wire carries the requested track, at most `deadlineMs`.
   *
   * The look comes *first*, and that order is the point: after a jump the player's request is
   * usually recorded while the injection that jumped is still on its way back, so a wait that
   * subscribed before looking would sleep through exactly the event it was armed for.
   *
   * A `deadlineMs` of 0 is the honest "look once": no timer is armed at all, which is how a
   * call finds out whether a jump is needed without making the operator wait three seconds for
   * nothing.
   */
  function transcriptCaptionWaitFor(tab, request, deadlineMs) {
    const found = transcriptCaptionWireLookup(tab, request);
    if (found !== null) return Promise.resolve(found);
    if (!(deadlineMs > 0)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = {
        tab,
        request,
        settle(entry) {
          transcriptCaptionWireWaiters.delete(waiter);
          clearTimeout(timer);
          resolve(entry);
        },
      };
      const timer = setTimeout(() => waiter.settle(null), deadlineMs);
      transcriptCaptionWireWaiters.add(waiter);
    });
  }

  /**
   * Starts the observation of the requests YouTube makes for its track files.
   *
   * Nothing is blocked and nothing is changed: `onBeforeRequest` without a callback and
   * without `webRequestBlocking`. The filter is the browser's, so a request of any other host
   * or path never reaches this listener at all — and one that slips through the pattern is
   * still checked in `transcriptCaptionWireOf`.
   */
  function watchTranscriptCaptionWire() {
    browser.webRequest.onBeforeRequest.addListener(recordTranscriptCaptionRequest, {
      urls: ["*://*.youtube.com/api/timedtext*"],
    });
  }

  /**
   * The two gates of a transcript call, in one snippet: is this a desktop YouTube watch
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
   * The gates stay the first injection even though the panel is no longer opened: they
   * are what keeps a call against a foreign or unrendered page from reaching the model
   * snippet, and the answer's sentence is decided by where the page failed, not by what
   * the model would have said.
   */
  function transcriptGateSource() {
    /*bc:transcript-gate*/
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
   * The containers a player response is known to hang off — the measured one first
   * (spec 33, M11), then the four candidates that were *not* measured.
   *
   * The order is the contract: the first container that carries a readable response
   * wins, and the answer names it in `source`, so a live measurement can tell which of
   * the five actually answered. A hard-wired path would answer `no_transcript_panel` on
   * the day the bootstrap container moves.
   */
  const TRANSCRIPT_MODEL_CANDIDATES = Object.freeze([
    "ytplayer.bootstrapPlayerResponse",
    "ytplayer.response",
    "ytInitialPlayerResponse",
    "ytplayer.config.args.player_response",
    "ytplayer.config.args.raw_player_response",
  ]);

  /**
   * Reads the player response: the caption tracks and the audio tracks, and nothing else.
   *
   * Everything below the walk is index loops and field-by-field copies, and that is the
   * whole point. `window.wrappedJSObject` hands out the operator's own objects; over an
   * Xray wrapper their `map`, `filter` and their iterator may simply not be there, and a
   * spread would silently produce nothing. Copying field by field is also what keeps the
   * answer small: a player response is megabytes, and this snippet answers four strings
   * and two numbers per track.
   *
   * A candidate may be the response itself or the JSON string the page kept (M11: the
   * string case was not measured, so both forms are read). `no_model` means no candidate
   * held a response at all; a response *without* `captionTracks` is a model — the video
   * simply has no subtitle track, and that is the caller's `no_transcript_panel`.
   */
  function transcriptModelSource(candidates) {
    /*bc:transcript-model*/
    // `wrappedJSObject` is absent only in a realm that is not a content script; the
    // fallback keeps the snippet honest there instead of throwing on a missing property.
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
   * `tlang` are the marks the wire matches on. What this snippet still reads out of the
   * address is the language it *delivers*, and the format it appends.
   *
   * The address never leaves this snippet. The answer carries the language *read out of
   * it* and the cues; an answer field with the address would be the leak the whole design
   * is built to avoid, so there is no such field and no message that names one.
   *
   * The window logic is the one from `docs/32`, criterion 3, moved and not rewritten:
   * every cue whose text overlaps `[offset, offset + maxChars)` travels whole, because
   * half a cue would make its stamp a lie, and `truncated` hangs on the end of the last
   * delivered cue rather than on `offset + chars`.
   */
  async function transcriptCaptionSource(request) {
    /*bc:transcript-caption*/
    const address = String(request.address);

    // One query parameter of an address, or null. Parsed by hand instead of with `URL`:
    // this snippet must run in the page realm as it is, and the address is a string with
    // a query and a fragment, nothing more.
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
   * Four actions in one snippet, because they share the walk over the rows and because the
   * restore must be one injection: "track first, playhead last" cannot be reordered by a
   * second injection arriving in between (criterion 6).
   *
   * Every list is walked by index: the page hands out Xray wrapped objects, and `map`,
   * `filter` or a spread over one of them may simply not exist there.
   */
  function transcriptMenuSource(request) {
    /*bc:transcript-menu*/
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
    // a snippet that throws reaches the caller as "this page is not readable", which is a
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

  /** The gate snippet as one injected expression. */
  function transcriptGateCode() {
    return pageSnippetCode(transcriptGateSource, []);
  }

  /** The menu snippet, with its action and the model's track names as arguments. */
  function transcriptMenuCode(request) {
    return pageSnippetCode(transcriptMenuSource, [request]);
  }

  /** The model snippet, with the container candidates as the only argument. */
  function transcriptModelCode() {
    return pageSnippetCode(transcriptModelSource, [TRANSCRIPT_MODEL_CANDIDATES]);
  }

  /** The reading snippet, with the target track and the window as its argument. */
  function transcriptCaptionCode(request) {
    return pageSnippetCode(transcriptCaptionSource, [request]);
  }

  /**
   * Turns the gate's answer into this tool's refusal, and answers nothing when the page
   * passed both gates.
   *
   * `not_youtube` is `transcript_failed`, not `transcript_needs_focus`: on a foreign page
   * the advice to focus is a false instruction (R3-5).
   */
  function requireTranscriptGate(entry) {
    if (entry === null || typeof entry !== "object") {
      throw new TranscriptError(TRANSCRIPT_FAILED_CODE, TRANSCRIPT_FAILED_MESSAGE);
    }
    if (entry.outcome === "not_youtube") {
      throw new TranscriptError(TRANSCRIPT_FAILED_CODE, TRANSCRIPT_NOT_YOUTUBE_MESSAGE);
    }
    if (entry.outcome === "needs_focus") {
      throw new TranscriptError(NEEDS_FOCUS_CODE, needsFocusMessageFor(entry.visibilityState));
    }
    if (entry.outcome === "ok") return;
    throw new TranscriptError(TRANSCRIPT_FAILED_CODE, TRANSCRIPT_FAILED_MESSAGE);
  }

  /**
   * The sentence for a page that is not rendered yet.
   *
   * `visibilityState` is the counter-check: a *visible* tab that has not built
   * `ytd-watch-flexy` is still hydrating, and telling the caller to focus it again would
   * start a loop that cannot end (spec 32, criterion 5).
   */
  function needsFocusMessageFor(visibilityState) {
    const state = typeof visibilityState === "string" ? visibilityState : "unbekannt";
    if (state === "visible") {
      return 'Der Tab ist im Vordergrund (document.visibilityState: "visible"), die Seite ist ' +
        "aber noch nicht aufgebaut. Ein erneuter browser_focus hilft nicht; warte kurz und " +
        "versuche es erneut.";
    }
    return `Der Tab ist nicht im Vordergrund (document.visibilityState: "${state}"); die Seite ` +
      "ist deshalb nicht gerendert. Rufe browser_focus auf und versuche es dann erneut.";
  }

  /** Whether the track was produced by speech recognition rather than uploaded. */
  function transcriptIsAutomaticTrack(track) {
    return track.kind === "asr" || track.vssId.startsWith("a.");
  }

  /** A track as the caller can tell it apart in a sentence: its name, with its id. */
  function transcriptTrackLabel(track) {
    return track.name === "" ? track.vssId : `${track.name} (${track.vssId})`;
  }

  /**
   * The original audio track: the one entry whose id carries no `.3` suffix.
   *
   * Every translation track is named `de.3`, `fr.3`, …; the original is `en-US.4`
   * (spec 33, M2). The *position* in the list is no signal at all: it was 7 in one call
   * and 8 in the next for the same video (M3), so anything built on the position answers
   * the wrong track every other call.
   *
   * Two candidates are no answer: the caller hears a named error with both ids instead of
   * this function picking the first. Picking would look like a result.
   *
   * A video with exactly *one* audio track has its original by definition: there is nothing
   * to tell apart. That is not a corner case on paper — measured 2026-11-12 on `wKv-g1uEoDY`,
   * a single entry whose `audioTrackId` field does not exist at all (the copy reads `""`), so
   * the suffix rule below left zero candidates and the tool refused a transcript that was
   * right there.
   */
  function transcriptOriginalAudioTrackOf(audioTracks) {
    if (audioTracks.length === 1) return audioTracks[0];
    const candidates = [];
    for (const track of audioTracks) {
      if (track.audioTrackId === "" || track.audioTrackId.endsWith(".3")) continue;
      candidates.push(track);
    }
    if (candidates.length !== 1) {
      const named = candidates.map((track) => track.audioTrackId);
      throw new TranscriptError(
        TRANSCRIPT_FAILED_CODE,
        "Die Originalspur ist nicht eindeutig (" +
          `${named.length === 0 ? "kein Audiotrack ohne .3-Suffix" : named.join(", ")}).`,
      );
    }
    return candidates[0];
  }

  /**
   * The track this tool reads, out of the model.
   *
   * The rule is the operator's (2026-11-11): the video's own track, unless that track is
   * not English or German — then the English one, and if there is none, the original with
   * its language named. "The original" is the track the original *audio* track points at
   * (M2), never the track the page happened to suggest: the page picks the interface
   * language when a track for it exists (M14), which is how a German panel ends up on an
   * English video.
   *
   * The English track is the one marked `en`, and an uploaded one beats an automatic one:
   * two automatic transcripts of the same language are two guesses. Two uploaded ones are
   * no choice at all, and that is a named error with both names.
   *
   * Without a usable index the caption list has to speak for the original (see
   * `transcriptTrackWithoutIndex`), because the index is the only field that names a track.
   */
  function transcriptTargetTrackOf(model) {
    const originalAudio = transcriptOriginalAudioTrackOf(model.audioTracks);
    const index = originalAudio.defaultCaptionTrackIndex;
    const indexNamesATrack =
      Number.isInteger(index) && index >= 0 && index < model.captionTracks.length;
    if (!indexNamesATrack) {
      const chosen = transcriptTrackWithoutIndex(model.captionTracks);
      if (chosen !== null) return chosen;
      throw new TranscriptError(
        TRANSCRIPT_FAILED_CODE,
        "Die Originalspur des Videos verweist auf keine Transkriptspur.",
      );
    }
    const originalTrack = model.captionTracks[index];
    // The index names a *position*, and a hole in the page's caption list keeps that
    // position as a placeholder with empty fields. That placeholder names no track, and
    // reading "nothing" as a language would answer `requestedLanguage: ""` over whatever
    // file matched "". A position the audio track really points at stays refused: sliding
    // the next track onto it would look healthy and answer the neighbour's language.
    if (!isUsableTranscriptTrack(originalTrack) || originalTrack.languageCode === "") {
      throw new TranscriptError(
        TRANSCRIPT_FAILED_CODE,
        "Die Originalspur des Videos verweist auf keine Transkriptspur.",
      );
    }
    if (originalTrack.languageCode === "en" || originalTrack.languageCode === "de") {
      return originalTrack;
    }

    const uploaded = [];
    const automatic = [];
    for (const track of model.captionTracks) {
      if (track.languageCode !== "en") continue;
      if (transcriptIsAutomaticTrack(track)) automatic.push(track);
      else uploaded.push(track);
    }
    if (uploaded.length === 1) return uploaded[0];
    if (uploaded.length === 0 && automatic.length === 1) return automatic[0];
    // No English track is an answer, not a failure: the original is read and its language
    // is named in the response, so the caller can see what it got.
    if (uploaded.length === 0 && automatic.length === 0) return originalTrack;
    const ambiguous = uploaded.length > 1 ? uploaded : automatic;
    throw new TranscriptError(
      TRANSCRIPT_FAILED_CODE,
      `Die englische Spur ist nicht eindeutig (${ambiguous.map(transcriptTrackLabel).join(", ")}).`,
    );
  }

  /**
   * The track to read when the audio track points at no usable caption index.
   *
   * Measured on `SmxSCZzV7j0` (2026-11-12): one `audioTracks` entry, its `audioTrackId` *and*
   * its `defaultCaptionTrackIndex` both missing, and two Japanese tracks — `ja` (uploaded)
   * and `a.ja` (automatic). The index is the only thing that names the original track, so
   * without it only the list can speak, and only when it leaves nothing to guess:
   *
   * - one usable track: there is nothing to choose between, so a missing index decides
   *   nothing. Measured earlier on `wKv-g1uEoDY` (2026-11-12), where refusing it hid the
   *   only transcript the video had;
   * - several tracks of *one* language: the operator's ranking applies, an uploaded track
   *   beats an automatic one (2026-11-11). Two uploaded or two automatic tracks are still
   *   two guesses and stay a named error with both names — same rule as for English.
   *
   * Several languages are the case this function does *not* answer: there the list would be
   * a guess between two different originals, and a wrong guess reads the wrong language over
   * text that looks healthy. The caller keeps its named error for that.
   */
  function transcriptTrackWithoutIndex(captionTracks) {
    const usable = [];
    for (const track of captionTracks) {
      if (isUsableTranscriptTrack(track) && track.languageCode !== "") usable.push(track);
    }
    if (usable.length === 0) return null;
    const language = usable[0].languageCode;
    const uploaded = [];
    const automatic = [];
    for (const track of usable) {
      // Different languages: no index, no choice. Not an error here — the caller names it.
      if (track.languageCode !== language) return null;
      if (transcriptIsAutomaticTrack(track)) automatic.push(track);
      else uploaded.push(track);
    }
    if (uploaded.length === 1) return uploaded[0];
    if (uploaded.length === 0 && automatic.length === 1) return automatic[0];
    const ambiguous = uploaded.length > 1 ? uploaded : automatic;
    throw new TranscriptError(
      TRANSCRIPT_FAILED_CODE,
      "Ohne Originalspur-Index ist die Transkriptspur nicht eindeutig " +
        `(${ambiguous.map(transcriptTrackLabel).join(", ")}).`,
    );
  }

  /** One caption track of the model, and whether every field has the type the rule acts on. */
  function isUsableTranscriptTrack(track) {
    return (
      track !== null &&
      typeof track === "object" &&
      typeof track.languageCode === "string" &&
      typeof track.vssId === "string" &&
      typeof track.name === "string" &&
      typeof track.kind === "string"
    );
  }

  /**
   * One audio track of the model. The index may be `null` — a track without a default
   * caption — but never a number that is not a whole one: the rule uses it as an index into
   * another list, and `1.5` there would answer a track nobody named.
   */
  function isUsableTranscriptAudioTrack(track) {
    return (
      track !== null &&
      typeof track === "object" &&
      typeof track.audioTrackId === "string" &&
      (track.defaultCaptionTrackIndex === null || Number.isInteger(track.defaultCaptionTrackIndex))
    );
  }

  /**
   * The model out of the one entry the model injection picked.
   *
   * `no_model` and an unusable entry are the same failure for the caller — the page did
   * not hand out a player response — but they are not the same sentence: the first is the
   * page's answer, the second is our own bug. A model *without* caption tracks is
   * neither: the video really has no subtitle track, and `no_transcript_panel` is the code
   * that has always meant exactly that to this tool.
   */
  function transcriptModelOf(entry) {
    if (entry !== null && typeof entry === "object" && entry.outcome === "no_model") {
      throw new TranscriptError(TRANSCRIPT_FAILED_CODE, TRANSCRIPT_NO_MODEL_MESSAGE);
    }
    const usable =
      entry !== null &&
      typeof entry === "object" &&
      entry.outcome === "model" &&
      typeof entry.source === "string" &&
      Array.isArray(entry.captionTracks) &&
      entry.captionTracks.every(isUsableTranscriptTrack) &&
      Array.isArray(entry.audioTracks) &&
      entry.audioTracks.every(isUsableTranscriptAudioTrack);
    if (!usable) {
      throw new TranscriptError(TRANSCRIPT_FAILED_CODE, TRANSCRIPT_FAILED_MESSAGE);
    }
    if (entry.captionTracks.length === 0) {
      throw new TranscriptError(NO_TRANSCRIPT_PANEL_CODE, NO_TRANSCRIPT_PANEL_MESSAGE);
    }
    return entry;
  }

  /** One cue of the answer, and whether every field has the type the contract names. */
  function isUsableTranscriptSegment(segment) {
    return (
      segment !== null &&
      typeof segment === "object" &&
      Number.isInteger(segment.time) &&
      typeof segment.timeText === "string" &&
      typeof segment.text === "string"
    );
  }

  /**
   * The window of the answer, checked as a whole.
   *
   * A page that hands back four numbers and a list of strings is our own bug, not a page
   * that cannot be read — `transcript_failed` says so instead of `offset: undefined`
   * reaching the caller.
   */
  function isUsableTranscriptResult(value) {
    if (value === null || typeof value !== "object") return false;
    if (!Array.isArray(value.segments) || !value.segments.every(isUsableTranscriptSegment)) return false;
    if (!Number.isInteger(value.totalChars) || !Number.isInteger(value.chars)) return false;
    return Number.isInteger(value.offset) && typeof value.truncated === "boolean";
  }

  /** The sentence for a track file that is not in the resource list. */
  function noCaptionFileMessageFor(languageCode) {
    return `Die Spurendatei zur Sprache "${languageCode}" wurde auf dieser Seite nicht gefunden.`;
  }

  /**
   * The answer out of the one entry the caption injection picked.
   *
   * The page's `offset_out_of_range` is translated, not recomputed: the two numbers are
   * its words, and this side never saw the whole text. The language fields come first in
   * the answer on purpose — behind twenty thousand characters of segment text nobody
   * would read them.
   */
  function transcriptCaptionResultOf(entry, model, target) {
    if (entry?.outcome === OFFSET_OUT_OF_RANGE_CODE && isUsableOffsetOutOfRange(entry)) {
      throw new TranscriptError(
        OFFSET_OUT_OF_RANGE_CODE,
        offsetOutOfRangeMessageFor(entry.offset, entry.totalChars),
      );
    }
    if (entry?.outcome === "no_address" || entry?.outcome === "caption_failed") {
      throw new TranscriptError(TRANSCRIPT_FAILED_CODE, noCaptionFileMessageFor(target.languageCode));
    }
    const usable =
      entry?.outcome === "caption" &&
      isUsableTranscriptResult(entry) &&
      typeof entry.deliveredLanguage === "string" &&
      entry.deliveredLanguage !== "";
    if (!usable) {
      throw new TranscriptError(TRANSCRIPT_FAILED_CODE, TRANSCRIPT_FAILED_MESSAGE);
    }
    return {
      requestedLanguage: target.languageCode,
      deliveredLanguage: entry.deliveredLanguage,
      source: model.source,
      segments: entry.segments.map((segment) => ({
        time: segment.time,
        timeText: segment.timeText,
        text: segment.text,
      })),
      totalChars: entry.totalChars,
      chars: entry.chars,
      offset: entry.offset,
      truncated: entry.truncated,
    };
  }

  /**
   * Reads the transcript of the agent tab: model, target track, track file.
   *
   * Four steps, and each one is a decision the next one depends on. They stay separate
   * instead of one page task for two reasons: every refusal has to travel back as an entry
   * the caller can read (`frameTargetOf` picks the one answer), and the gate must be able to
   * stop the call before a single byte of the model is read on a page that is not a
   * rendered watch page.
   *
   * The player is only touched when the track file is not there yet, and that is the whole
   * rule, in one place: the background page asks its own wire for the target track's address
   * once (`deadlineMs` 0), and only when it has none is the track picked in the menu and the
   * playhead moved to make the player fetch it (spec 33, M17). A target track that is already
   * running therefore costs neither a click nor a jump — the operator sees no flicker. After a
   * jump the same address is waited for up to `TRANSCRIPT_CAPTION_DEADLINE_MS`, and a jump that
   * did not deliver — no address, or a stale one whose file answers without `events` — is
   * repeated exactly once before the call fails.
   *
   * Whatever the run changed is put back before the answer or the failure leaves this
   * function: the previous track first, the playhead last (criterion 6).
   *
   * The window is checked before the tab is looked up, like `read`: a caller whose
   * `maxChars` is 0 hears about its own mistake whether or not an agent tab exists.
   */
  async function transcriptAgentTab(params) {
    const { offset, maxChars } = windowParamsOf(params, TranscriptError);
    const tab = await addressedAgentTab(params, TranscriptError);
    const gateResults = await injectPageCode(tab.id, transcriptGateCode());
    requireTranscriptGate(frameTargetOf(gateResults));
    const modelResults = await injectPageCode(tab.id, transcriptModelCode());
    const model = transcriptModelOf(frameTargetOf(modelResults));
    const target = transcriptTargetTrackOf(model);

    const captionRequest = transcriptCaptionRequestOf(target, offset, maxChars);

    // The first look costs no wait and no click: `deadlineMs` 0 asks the resource list once.
    const firstLook = await readTranscriptFile(tab, captionRequest, 0);
    if (!transcriptCaptionIsMissing(firstLook)) {
      return transcriptCaptionResultOf(firstLook, model, target);
    }

    const menuBase = {
      names: transcriptCaptionNamesOf(model),
      expectedCount: model.captionTracks.length + TRANSCRIPT_MENU_EXTRA_ENTRIES,
    };
    const menuResults = await injectPageCode(
      tab.id,
      transcriptMenuCode({ ...menuBase, action: "read" }),
    );
    const menu = transcriptMenuOf(frameTargetOf(menuResults), target.name);
    const previous = { name: menu.checkedName, currentTime: menu.currentTime };
    const changed = { track: false, position: false };
    let answer = null;
    let failure = null;
    try {
      if (menu.checkedName !== target.name) {
        const setResults = await injectPageCode(
          tab.id,
          transcriptMenuCode({ ...menuBase, action: "set", name: target.name }),
        );
        // The flag first, and before the answer is read: a click may have happened and the
        // answer still be unusable, and then the operator must not be left on a track this
        // run picked (review m5). A refusal is the one answer that clicked nothing, so it is
        // the one case that leaves nothing to undo.
        const setEntry = frameTargetOf(setResults);
        changed.track = transcriptMenuDidClick(setEntry);
        const settled = transcriptMenuOf(setEntry, target.name);
        // The snippet reports the entry the player marks *after* the click, so a pick that
        // did not take effect is caught here and named — instead of surfacing six seconds
        // later as a missing track file, which would blame the page (review m6).
        if (settled.checkedName !== target.name) {
          throw new TranscriptError(
            TRANSCRIPT_FAILED_CODE,
            transcriptMenuNotSetMessageFor(target.name),
          );
        }
      }
      let caption = await seekAndReadTranscriptFile(tab, captionRequest, changed);
      if (transcriptCaptionIsMissing(caption)) {
        caption = await seekAndReadTranscriptFile(tab, captionRequest, changed);
      }
      answer = transcriptCaptionResultOf(caption, model, target);
    } catch (error) {
      failure = error;
    }
    // Before the throw and before the answer, so no error path leaves the operator with a
    // moved playhead or a foreign track.
    await restoreTranscriptPlayer(tab, menuBase, previous, changed);
    if (failure !== null) throw failure;
    return answer;
  }

  /** Whether a menu answer may have clicked an entry — the refusals may not. */
  function transcriptMenuDidClick(entry) {
    if (entry === null || typeof entry !== "object") return true;
    return !TRANSCRIPT_MENU_REFUSALS.includes(entry.outcome);
  }

  /** Whether the page answered "no track file for this track" rather than a window. */
  function transcriptCaptionIsMissing(entry) {
    return entry?.outcome === "no_address" || entry?.outcome === "caption_failed";
  }

  /**
   * The track the wait and the reading injection ask for: its language and its kind.
   *
   * No wait parameters ride along any more. The wait belongs to the background page (it is the
   * one that hears the requests), and the injected snippet only turns an address into cues
   * (spec 34).
   */
  function transcriptCaptionRequestOf(target, offset, maxChars) {
    return {
      languageCode: target.languageCode,
      asr: transcriptIsAutomaticTrack(target),
      offset,
      maxChars,
    };
  }

  /**
   * One look for the track file, waiting up to `deadlineMs` for the player to fetch it.
   *
   * The wait and the injection are two steps of one answer, and their order is the contract: a
   * `deadlineMs` of 0 is the honest "look once" a call uses to find out whether a jump is
   * needed at all, and an address that is already on the wire costs neither a timer nor an
   * injection that looks for one.
   */
  async function readTranscriptFile(tab, request, deadlineMs) {
    const entry = await transcriptCaptionWaitFor(tab, request, deadlineMs);
    if (entry === null) return { outcome: "no_address" };
    const results = await injectPageCode(
      tab.id,
      transcriptCaptionCode({
        address: entry.address,
        offset: request.offset,
        maxChars: request.maxChars,
      }),
    );
    return frameTargetOf(results);
  }

  /**
   * Jumps the playhead and then waits for the track file.
   *
   * The jump is what makes the player fetch the file (M17) — the snippet remembers nothing
   * about the position, because the restore is told the number that was read before any of
   * this started.
   */
  async function seekAndReadTranscriptFile(tab, request, changed) {
    const seekResults = await injectPageCode(
      tab.id,
      transcriptMenuCode({ action: "seek", seekOffsetS: TRANSCRIPT_SEEK_OFFSET_S }),
    );
    // The flag before the answer is judged: the jump happened, and a `seek` answer this side
    // cannot read must not end with the operator's playhead left where the jump put it
    // (review m5). The answer's own flag then has the last word: a playhead that never moved
    // is nothing to undo, and writing `currentTime` back onto its own value would be a write
    // without a change behind it.
    changed.position = true;
    changed.position = transcriptSeekOf(frameTargetOf(seekResults)).seeked === true;
    return readTranscriptFile(tab, request, TRANSCRIPT_CAPTION_DEADLINE_MS);
  }

  /**
   * Puts the player back: the track the operator had, then the playhead.
   *
   * Best effort and quiet, on purpose. A page that cannot be reached any more is nothing the
   * caller can act on, and a failed restore must not replace the answer it just read or the
   * reason of the failure that is about to be reported. Only what was changed is restored: a
   * run that never left the current track does not click, and a run that never jumped does
   * not touch the playhead.
   */
  async function restoreTranscriptPlayer(tab, menuBase, previous, changed) {
    if (!changed.track && !changed.position) return;
    try {
      await injectPageCode(
        tab.id,
        transcriptMenuCode({
          ...menuBase,
          action: "restore",
          name: changed.track ? previous.name : null,
          currentTime: changed.position ? previous.currentTime : null,
        }),
      );
    } catch {
      // Swallowed on purpose: this is the cleanup, not the answer.
    }
  }

  /** The one anchor the menu row is found by: the track names of the model (M16). */
  function transcriptCaptionNamesOf(model) {
    const names = [];
    for (const track of model.captionTracks) {
      if (track.name !== "") names.push(track.name);
    }
    return names;
  }

  /** A list of menu entries as one sentence fragment — language names, never an address. */
  function transcriptMenuCandidatesOf(candidates) {
    if (!Array.isArray(candidates)) return "keine";
    const named = candidates.filter((text) => typeof text === "string");
    return named.length === 0 ? "keine" : named.join(", ");
  }

  /**
   * The menu answer, checked — and the page's refusal turned into this tool's.
   *
   * `no_match` and `ambiguous` carry the entries the snippet saw, so the caller can compare
   * them with what it asked for; the sentence names the track it was looking for and never
   * an address (M13). A missing row and a wrong entry count are their own sentences: both
   * say "this menu is not the track list the model describes", and clicking in it would be a
   * guess.
   */
  function transcriptMenuOf(entry, trackName) {
    if (entry === null || typeof entry !== "object") {
      throw new TranscriptError(TRANSCRIPT_FAILED_CODE, TRANSCRIPT_FAILED_MESSAGE);
    }
    if (entry.outcome === "no_row") {
      throw new TranscriptError(TRANSCRIPT_FAILED_CODE, TRANSCRIPT_MENU_ROW_MISSING_MESSAGE);
    }
    if (entry.outcome === "row_ambiguous") {
      throw new TranscriptError(
        TRANSCRIPT_FAILED_CODE,
        `${TRANSCRIPT_MENU_ROW_AMBIGUOUS_MESSAGE} (${transcriptMenuCandidatesOf(entry.candidates)})`,
      );
    }
    if (entry.outcome === "row_miscount") {
      if (!Number.isInteger(entry.count) || !Number.isInteger(entry.expectedCount)) {
        throw new TranscriptError(TRANSCRIPT_FAILED_CODE, TRANSCRIPT_FAILED_MESSAGE);
      }
      throw new TranscriptError(
        TRANSCRIPT_FAILED_CODE,
        `Das Spuren-Menü des Players hat ${entry.count} Einträge statt ${entry.expectedCount}.`,
      );
    }
    if (entry.outcome === "no_match") {
      throw new TranscriptError(
        TRANSCRIPT_FAILED_CODE,
        `Der Menüeintrag "${trackName}" wurde nicht gefunden ` +
          `(Einträge: ${transcriptMenuCandidatesOf(entry.candidates)}).`,
      );
    }
    if (entry.outcome === "ambiguous") {
      throw new TranscriptError(
        TRANSCRIPT_FAILED_CODE,
        `Der Menüeintrag "${trackName}" ist nicht eindeutig ` +
          `(${transcriptMenuCandidatesOf(entry.candidates)}).`,
      );
    }
    const usable =
      entry.outcome === "menu" &&
      Array.isArray(entry.entries) &&
      entry.entries.every((text) => typeof text === "string") &&
      typeof entry.checkedName === "string" &&
      (entry.currentTime === null || Number.isFinite(entry.currentTime));
    if (!usable) {
      throw new TranscriptError(TRANSCRIPT_FAILED_CODE, TRANSCRIPT_FAILED_MESSAGE);
    }
    return entry;
  }

  /**
   * The jump's answer, checked: a jump that could not happen is a named failure. The answer
   * comes back, because its `seeked` flag is the only word on whether the playhead moved at
   * all — a live stream or a playhead already at either end leaves it where it was.
   */
  function transcriptSeekOf(entry) {
    if (entry !== null && typeof entry === "object" && entry.outcome === "seek") return entry;
    if (entry !== null && typeof entry === "object" && entry.outcome === "no_player") {
      throw new TranscriptError(TRANSCRIPT_FAILED_CODE, TRANSCRIPT_NO_PLAYER_MESSAGE);
    }
    throw new TranscriptError(TRANSCRIPT_FAILED_CODE, TRANSCRIPT_FAILED_MESSAGE);
  }

  /** Answers one `transcript` request: the agent tab in, its segments out. */
  async function answerTranscript(target, request) {
    try {
      sendResponse(target, request.id, { ok: true, result: await transcriptAgentTab(request.params) });
    } catch (error) {
      sendResponse(target, request.id, { ok: false, error: transcriptErrorFor(error) });
    }
  }

  /**
   * The error frame of a `transcript` call.
   *
   * A `TranscriptError` carries its own code and keeps it; `no_agent_tab` is the one the
   * tab store decides, and it travels in that class too, so every tool names it the same
   * way. The injection refusals (`page_busy`, `not_readable`) arrive as `ReadError`s from
   * `injectPageCode` and keep the frame `read` gives them — translated, not recomputed,
   * so this tool cannot tell a different story about a page `read` would refuse.
   */
  function transcriptErrorFor(error) {
    if (error instanceof TranscriptError) return { code: error.code, message: error.message };
    if (error instanceof ReadError) return readErrorFrame(error);
    return { code: TRANSCRIPT_FAILED_CODE, message: describeError(error) };
  }

  function onSocketClosed(closedSocket) {
    // A socket that was already replaced must not schedule its own retry,
    // otherwise every reconnect doubles the number of open attempts.
    if (closedSocket !== socket) return;

    socket = null;
    // `connectedAt` describes the current connection; a stale value would make
    // a later status claim a connection time that never happened.
    connectedAt = null;

    scheduleReconnect(reconnectAttempt + 1);
  }

  /**
   * `min(30 s, 1 s · 2^(n−1))` plus 0–250 ms jitter. The jitter keeps two
   * extensions that lost the same bridge from retrying in lockstep.
   */
  function scheduleReconnect(attempt) {
    reconnectAttempt = attempt;
    const delayMs = reconnectDelayMs(attempt);
    console.log(`${RECONNECT_LOG_PREFIX} ${delayMs} ms`);
    setTimeout(() => {
      void connect();
    }, delayMs);
  }

  function reconnectDelayMs(attempt) {
    const exponentialMs = PROTOCOL.RECONNECT_BASE_MS * 2 ** (attempt - 1);
    const cappedMs = Math.min(PROTOCOL.RECONNECT_MAX_MS, exponentialMs);
    return cappedMs + jitterMs();
  }

  function jitterMs() {
    return Math.floor(Math.random() * (PROTOCOL.RECONNECT_JITTER_MS + 1));
  }

  // The harness's own door into the message channel — and only the harness's. Until
  // stage 1b converts the sixteen callers, nothing in this file sends a
  // `{callId, op, args}` message, so the deadline and the collection could not be proven
  // at all. Published only when `test/extension.test.js` sets `globalThis.__bcInjectionProbe`
  // before this file loads; the extension itself never sets it, so a real page carries no
  // hook. It goes away with the last converted caller.
  if (globalThis.__bcInjectionProbe === true) {
    globalThis.__bcInjection = Object.freeze({ requestPageAnswers });
  }
  console.log(STARTUP_LOG_LINE);
  // Before the dial, for the same reason as the wire below: an answer can only be matched
  // while its call is open, and a call is only open while the socket is.
  listenForPageReplies();
  // Before the dial: a page that fetched its track file while the bridge was down is the
  // normal case, and the wire has to be listening before the first call arrives (spec 34).
  // Nothing is logged here — the address is a session credential.
  watchTranscriptCaptionWire();
  void connect();
})();
