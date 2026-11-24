//! The visible texts of the tool layer.
//!
//! English, because every one of these sentences is read by the agent
//! (Betreiberentscheid 2026-11-22, `docs/54`). Fixed, not formulated: the sentences are
//! the contract the agent reads, and `scripts/parity.sh` comparison 2 compares them
//! character for character. A missing umlaut is the machine check (`tests/texts.rs`),
//! the pinned assertions in `tests/mcp.rs` are the semantic one.
//!
//! The `*_WITH_MESSAGE` builders exist because the extension's own words are the
//! fact: a length, a browser rejection, a reason. Without a usable message the plain
//! sentence stands, so nothing here ever ends in a dangling colon.

/// `TOOL_TEXTS.UNKNOWN_TOOL`
pub fn unknown_tool(name: &str) -> String {
    format!(r#"Unknown tool: {name}"#)
}

/// `TOOL_TEXTS.INVALID_URL`
pub const INVALID_URL: &str = r#"Only http:// and https:// are allowed."#;

/// `TOOL_TEXTS.NO_EXTENSION`
pub const NO_EXTENSION: &str = r#"No extension connected — Firefox with the extension is not running, or the connection was dropped."#;

/// `TOOL_TEXTS.NO_ANSWER`
pub const NO_ANSWER: &str = r#"The extension did not answer (timeout)."#;

/// `TOOL_TEXTS.NO_AGENT_TAB`
pub const NO_AGENT_TAB: &str = r#"No agent tab — call browser_navigate first."#;

/// `TOOL_TEXTS.TOO_MANY_TABS`
pub const TOO_MANY_TABS: &str = r#"Five agent tabs are already open — close one first."#;

/// `TOOL_TEXTS.PAGE_BUSY`
pub const PAGE_BUSY: &str = r#"The page is still loading — try again in a moment."#;

/// `TOOL_TEXTS.NOT_READABLE`
pub const NOT_READABLE: &str = r#"The extension cannot read this page (internal page or special format)."#;

/// `TOOL_TEXTS.NOT_READABLE_WITH_KIND`
pub fn not_readable_with_kind(kind: &str, url: &str) -> String {
    format!(r#"The extension cannot read this page (kind: {kind}). Address: {url}"#)
}

/// `TOOL_TEXTS.NOT_READABLE_WITH_KIND_AND_TYPE`
pub fn not_readable_with_kind_and_type(kind: &str, content_type: &str, url: &str) -> String {
    format!(r#"The extension cannot read this page (kind: {kind}, content-type: {content_type}). Address: {url}"#)
}

/// `TOOL_TEXTS.NOT_READABLE_WITH_TYPE`
pub fn not_readable_with_type(content_type: &str, url: &str) -> String {
    format!(r#"The extension cannot read this page (content-type: {content_type}). Address: {url}"#)
}

/// `TOOL_TEXTS.NOT_READABLE_WITH_URL`
pub fn not_readable_with_url(url: &str) -> String {
    format!(r#"The extension cannot read this page. Address: {url}"#)
}

/// `TOOL_TEXTS.OFFSET_OUT_OF_RANGE`
pub const OFFSET_OUT_OF_RANGE: &str = r#"`offset` is past the end of the text."#;

/// `TOOL_TEXTS.OFFSET_OUT_OF_RANGE_WITH_MESSAGE`
pub fn offset_out_of_range_with_message(message: &str) -> String {
    format!(r#"`offset` is past the end of the text: {message}"#)
}

/// `TOOL_TEXTS.INVALID_READ_PARAMS`
pub const INVALID_READ_PARAMS: &str = r#"The parameter is invalid."#;

/// `TOOL_TEXTS.INVALID_READ_PARAMS_WITH_MESSAGE`
pub fn invalid_read_params_with_message(message: &str) -> String {
    format!(r#"The parameter is invalid: {message}"#)
}

/// `TOOL_TEXTS.FRAME_NOT_FOUND`
pub const FRAME_NOT_FOUND: &str = r#"No frame matches this `frame` — check the addresses with browser_frames."#;

/// `TOOL_TEXTS.FRAME_NOT_FOUND_WITH_COUNT`
pub fn frame_not_found_with_count(count: i64) -> String {
    format!(r#"No frame matches this `frame` — check the addresses with browser_frames (frames that answered: {count})."#)
}

/// `TOOL_TEXTS.FRAME_AMBIGUOUS`
pub const FRAME_AMBIGUOUS: &str = r#"Several frames match this `frame` — pass a longer substring of the address."#;

/// `TOOL_TEXTS.FRAME_AMBIGUOUS_WITH_CANDIDATES`
pub fn frame_ambiguous_with_candidates(candidates: &str) -> String {
    format!(r#"Several frames match this `frame` — pass a longer substring of one of these addresses: {candidates}."#)
}

/// `TOOL_TEXTS.INVALID_SELECTOR`
pub fn invalid_selector(selector: &str) -> String {
    format!(r#"The selector is invalid: {selector}."#)
}

/// `TOOL_TEXTS.NO_MATCH`
pub fn no_match(selector: &str) -> String {
    format!(r#"No element matches: {selector}."#)
}

/// `TOOL_TEXTS.NOT_CLICKABLE`
pub fn not_clickable(selector: &str) -> String {
    format!(r#"The element is not visible or is disabled: {selector}."#)
}

/// The sentence for `offscreen_after_scroll` (spec 56): the target stayed outside the
/// visible area even after the page scrolled to it.
pub fn offscreen_after_scroll(selector: &str) -> String {
    format!(r#"The element stays outside the viewport after scrolling: {selector}."#)
}

/// `TOOL_TEXTS.NOT_TYPEABLE`
pub fn not_typeable(selector: &str) -> String {
    format!(r#"The element is not a writable field or is disabled: {selector}."#)
}

/// `TOOL_TEXTS.PASSWORD_NOT_ALLOWED`
pub const PASSWORD_NOT_ALLOWED: &str = r#"Password fields are locked. Unlock them in the extension options."#;

/// `TOOL_TEXTS.INSPECT_NEEDS_FILTER`
pub const INSPECT_NEEDS_FILTER: &str = r#"browser_inspect needs `selector` or `contains_text`."#;

/// `TOOL_TEXTS.INVALID_INSPECT_PARAMS`
pub const INVALID_INSPECT_PARAMS: &str = r#"The parameter is invalid."#;

/// `TOOL_TEXTS.STATUS_EXTENSION_FAILED`
pub fn status_extension_failed(code: &str) -> String {
    format!(r#"The extension could not deliver the status (code={code})."#)
}

/// `TOOL_TEXTS.EVAL_NOT_ALLOWED`
pub const EVAL_NOT_ALLOWED: &str = r#"Code evaluation is not allowed in the extension settings — enable it there first."#;

/// `TOOL_TEXTS.EVAL_FAILED`
pub const EVAL_FAILED: &str = r#"The code in the agent tab failed (exception or syntax error)."#;

/// `TOOL_TEXTS.EVAL_FAILED_WITH_MESSAGE`
pub fn eval_failed_with_message(message: &str) -> String {
    format!(r#"The code in the agent tab failed: {message}"#)
}

/// `TOOL_TEXTS.EVAL_TIMEOUT`
pub const EVAL_TIMEOUT: &str = r#"The code did not answer in time (timeout after 2 s)."#;

/// `TOOL_TEXTS.EVAL_RESULT_TOO_LARGE`
pub const EVAL_RESULT_TOO_LARGE: &str = r#"The result is too large for one answer (more than 10 000 characters of JSON) — return less, for example with browser_inspect."#;

/// `TOOL_TEXTS.EVAL_RESULT_UNSERIALIZABLE`
pub const EVAL_RESULT_UNSERIALIZABLE: &str = r#"The result cannot be represented as JSON (circular, for example) — return plain values only."#;

/// `TOOL_TEXTS.INVALID_EVAL_PARAMS`
pub const INVALID_EVAL_PARAMS: &str = r#"The parameter is invalid."#;

/// `TOOL_TEXTS.SCREENSHOT_NOT_ALLOWED`
pub const SCREENSHOT_NOT_ALLOWED: &str = r#"Screenshots are not allowed in the extension settings — enable them there first."#;

/// `TOOL_TEXTS.SCREENSHOT_FAILED`
pub const SCREENSHOT_FAILED: &str = r#"The agent tab could not be photographed."#;

/// `TOOL_TEXTS.SCREENSHOT_FAILED_WITH_MESSAGE`
pub fn screenshot_failed_with_message(message: &str) -> String {
    format!(r#"The agent tab could not be photographed: {message}"#)
}

/// `TOOL_TEXTS.SCREENSHOT_TOO_LARGE`
pub const SCREENSHOT_TOO_LARGE: &str = r#"The picture is too large even after scaling down — it is not delivered; another tab may come out smaller."#;

/// `TOOL_TEXTS.SCREENSHOT_TOO_LARGE_WITH_MESSAGE`
pub fn screenshot_too_large_with_message(message: &str) -> String {
    format!(r#"The picture is too large even after scaling down — it is not delivered; another tab may come out smaller. Measurement: {message}"#)
}

/// `TOOL_TEXTS.INVALID_SCREENSHOT_PARAMS`
pub const INVALID_SCREENSHOT_PARAMS: &str = r#"The parameter is invalid."#;

/// `TOOL_TEXTS.TRANSCRIPT_FAILED`
pub const TRANSCRIPT_FAILED: &str = r#"The transcript could not be read — only YouTube watch pages have one."#;

/// `TOOL_TEXTS.TRANSCRIPT_FAILED_WITH_MESSAGE`
pub fn transcript_failed_with_message(message: &str) -> String {
    format!(r#"The transcript could not be read: {message}"#)
}

/// `TOOL_TEXTS.TRANSCRIPT_NEEDS_FOCUS`
pub const TRANSCRIPT_NEEDS_FOCUS: &str = r#"The tab is not in the foreground, so the page is not rendered — call browser_focus first, then try again."#;

/// `TOOL_TEXTS.TRANSCRIPT_NEEDS_FOCUS_WITH_MESSAGE`
pub fn transcript_needs_focus_with_message(message: &str) -> String {
    format!(r#"The page is not rendered: {message}"#)
}

/// `TOOL_TEXTS.NO_TRANSCRIPT_PANEL`
pub const NO_TRANSCRIPT_PANEL: &str = r#"No subtitle track found in the video — it has none, or the page is not built yet."#;

/// `TOOL_TEXTS.CALL_EXTENSION_FAILED`
pub fn call_extension_failed(code: &str) -> String {
    format!(r#"The extension could not carry out the request (code={code})."#)
}

/// `TOOL_TEXTS.BRIDGE_FAILED`
pub const BRIDGE_FAILED: &str = r#"The bridge could not read the status."#;

/// `browser_help` ohne `tool`: derselbe Ton wie die anderen Refusals.
pub fn help_asked_for_nothing() -> String {
    "browser_help needs `tool` — the name of a tool, for example `browser_read`.".to_string()
}

/// `browser_help` mit einem Argument, das es nicht kennt.
pub fn help_asked_for_something_else() -> String {
    "browser_help takes only `tool`.".to_string()
}

/// `browser_help` mit einem Namen, den der Vertrag nicht kennt: die gueltigen dazu.
pub fn help_unknown_tool(name: &str, known: &[&str]) -> String {
    format!(
        "`{name}` is not a tool of this contract. Valid names: {}.",
        known.join(", ")
    )
}
