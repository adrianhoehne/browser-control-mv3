//! What a failed call reads like, ported from `bridge/mcp.mjs` (`failureTextFor`,
//! `extensionFailureText` and the builders behind them).
//!
//! One sentence per situation, and the fallback is always the shorter sentence: the
//! extension's own words ride along only where a sentence has room for them. An empty
//! or absent `message` therefore never leaves a dangling colon, and a `kind` the
//! bridge does not know loses its bracket instead of gaining a soapbox.
//!
//! The `details` object is the extension's whole `error` object (`url`, `kind`,
//! `contentType`, `message`, `frames`, `candidates`); the hub hands it over
//! unchanged, which is why this module reads it field by field instead of parsing a
//! message.

use serde_json::{Map, Value};

use crate::hub::{FailureKind, HubRequestError};
use crate::mcp::texts;
use crate::mcp::tools;

/// The code the sentences print when the extension answered `ok:false` without one.
const UNKNOWN_CODE: &str = "unknown";

/// What a refused URL — the extension's own refusal — is spelled as. The bridge has
/// its own copy of the same rule; both floors answer with the same sentence, so the
/// operator cannot tell which one caught it and does not need to.
const INVALID_URL_CODE: &str = "invalid_url";
const NO_AGENT_TAB_CODE: &str = "no_agent_tab";
const NOT_READABLE_CODE: &str = "not_readable";
const PAGE_BUSY_CODE: &str = "page_busy";
const OFFSET_OUT_OF_RANGE_CODE: &str = "offset_out_of_range";
const FRAME_NOT_FOUND_CODE: &str = "frame_not_found";
const FRAME_AMBIGUOUS_CODE: &str = "frame_ambiguous";
const TRANSCRIPT_FAILED_CODE: &str = "transcript_failed";
const NO_TRANSCRIPT_PANEL_CODE: &str = "no_transcript_panel";
const TRANSCRIPT_NEEDS_FOCUS_CODE: &str = "transcript_needs_focus";
const INVALID_SELECTOR_CODE: &str = "invalid_selector";
const NO_MATCH_CODE: &str = "no_match";
const NOT_CLICKABLE_CODE: &str = "not_clickable";
/// The fourth reason a click can be refused: the target stayed outside the visible area
/// even after the page scrolled to it (`docs/56`). A code of its own, because the code
/// carries the reason and the sentence is built from it.
const OFFSCREEN_AFTER_SCROLL_CODE: &str = "offscreen_after_scroll";
const NOT_TYPEABLE_CODE: &str = "not_typeable";
const PASSWORD_NOT_ALLOWED_CODE: &str = "password_not_allowed";
const INVALID_PARAMS_CODE: &str = "invalid_params";
const TOO_MANY_TABS_CODE: &str = "too_many_tabs";
const EVAL_NOT_ALLOWED_CODE: &str = "eval_not_allowed";
const EVAL_FAILED_CODE: &str = "eval_failed";
const EVAL_TIMEOUT_CODE: &str = "eval_timeout";
const EVAL_RESULT_TOO_LARGE_CODE: &str = "eval_result_too_large";
const EVAL_RESULT_UNSERIALIZABLE_CODE: &str = "eval_result_unserializable";
const SCREENSHOT_NOT_ALLOWED_CODE: &str = "screenshot_not_allowed";
const SCREENSHOT_FAILED_CODE: &str = "screenshot_failed";
const SCREENSHOT_TOO_LARGE_CODE: &str = "screenshot_too_large";

/// The `kind` values a `not_readable` sentence may print. A whitelist, not a
/// pass-through: the value comes off the wire, and an unvetted string has no business
/// inside a sentence the operator reads. `unknown` is on the list so the extension's
/// own "I cannot tell" is a known answer — the sentence still drops it, because
/// printing `Typ: unknown` would dress up a missing fact as a finding.
const NOT_READABLE_KINDS: [&str; 4] = ["internal", "pdf", "file", "unknown"];

/// How many colliding frame addresses a `frame_ambiguous` sentence prints. The
/// extension caps its own list at five too; this second cap is the display limit of
/// the side that builds the sentence, not a second opinion about the frames.
const FRAME_CANDIDATE_LIMIT: usize = 5;

/// Maps a failed request onto the sentence the operator reads.
///
/// `params` is for the tools whose sentences quote a request field (`click`, `type`
/// and `inspect` name the selector); the other callers pass `None` and are answered
/// exactly as before.
///
/// The template passes its log writer in as well, because its last arm reports an
/// error name it does not know and answers `BRIDGE_FAILED`. That arm has no
/// counterpart here: every error this layer sees is one of the three [`FailureKind`]s,
/// so there is nothing to log and nothing to fall back to — the sentence is pinned by
/// the unit test at the bottom of this file instead of by a case.
pub fn failure_text_for(
    tool: &str,
    error: &HubRequestError,
    params: Option<&Map<String, Value>>,
) -> String {
    match error.kind {
        FailureKind::Unavailable => texts::NO_EXTENSION.to_string(),
        FailureKind::Timeout => texts::NO_ANSWER.to_string(),
        FailureKind::Extension => extension_failure_text(
            tool,
            error.code.as_deref(),
            params,
            error.details.as_ref(),
        ),
    }
}

/// What an `ok:false` from the extension reads like.
///
/// The two frame codes are answered before the per-tool branches: they are the same
/// verdict on the same page whichever tool asked, and both sentences name the next
/// step. The last arm is the `status` catch-all — every tool that reaches it has a
/// branch of its own, so it is the sentence for a call nothing else claimed.
fn extension_failure_text(
    tool: &str,
    code: Option<&str>,
    params: Option<&Map<String, Value>>,
    details: Option<&Value>,
) -> String {
    // The hub already normalises a missing code to `unknown`, exactly like the
    // template's `code ?? "unknown"` — the fallback stays here anyway so that a
    // caller handing over `None` cannot print an empty bracket.
    let code_text = code.unwrap_or(UNKNOWN_CODE);

    if code == Some(FRAME_NOT_FOUND_CODE) {
        return frame_not_found_text(details);
    }
    if code == Some(FRAME_AMBIGUOUS_CODE) {
        return frame_ambiguous_text(details);
    }

    match tool {
        tools::BROWSER_NAVIGATE => {
            if code == Some(INVALID_URL_CODE) {
                texts::INVALID_URL.to_string()
            } else {
                texts::call_extension_failed(code_text)
            }
        }
        tools::BROWSER_READ => read_failure_text(code, details, code_text),
        tools::BROWSER_CLICK => {
            if code == Some(INVALID_SELECTOR_CODE) {
                return texts::invalid_selector(&selector_of(params));
            }
            if code == Some(NO_MATCH_CODE) {
                return texts::no_match(&selector_of(params));
            }
            if code == Some(NOT_CLICKABLE_CODE) {
                return texts::not_clickable(&selector_of(params));
            }
            // Before `page_failure_text`: a click that scrolled and still saw nothing
            // reachable names the target, like the three reasons before it.
            if code == Some(OFFSCREEN_AFTER_SCROLL_CODE) {
                return texts::offscreen_after_scroll(&selector_of(params));
            }
            page_failure_text(code, details, code_text)
        }
        // `type` repeats the selector sentences of `click` and adds the two that are
        // specific to writing: the element takes no text, or a password field is
        // locked. `type_failed` and `superseded` keep the generic sentence with their
        // code — the operator can act on neither, and inventing advice would be a
        // guess.
        tools::BROWSER_TYPE => {
            if code == Some(INVALID_SELECTOR_CODE) {
                return texts::invalid_selector(&selector_of(params));
            }
            if code == Some(NO_MATCH_CODE) {
                return texts::no_match(&selector_of(params));
            }
            if code == Some(NOT_TYPEABLE_CODE) {
                return texts::not_typeable(&selector_of(params));
            }
            if code == Some(PASSWORD_NOT_ALLOWED_CODE) {
                return texts::PASSWORD_NOT_ALLOWED.to_string();
            }
            page_failure_text(code, details, code_text)
        }
        // `focus` has no code of its own that the operator could act on: "no agent tab
        // yet" is advice, everything else keeps its code in the generic sentence.
        tools::BROWSER_FOCUS => {
            if code == Some(NO_AGENT_TAB_CODE) {
                texts::NO_AGENT_TAB.to_string()
            } else {
                texts::call_extension_failed(code_text)
            }
        }
        tools::BROWSER_INSPECT => inspect_failure_text_for(code, params, details),
        // The fifth tab is the limit, and the sentence names the only way out.
        tools::BROWSER_OPEN_TAB => {
            if code == Some(TOO_MANY_TABS_CODE) {
                texts::TOO_MANY_TABS.to_string()
            } else {
                texts::call_extension_failed(code_text)
            }
        }
        // `close_tab` adds no code: a foreign or already-gone id is `no_agent_tab`,
        // which is the same advice `read` gives.
        tools::BROWSER_CLOSE_TAB => {
            if code == Some(NO_AGENT_TAB_CODE) {
                texts::NO_AGENT_TAB.to_string()
            } else {
                texts::call_extension_failed(code_text)
            }
        }
        tools::BROWSER_EVAL => eval_failure_text_for(code, details),
        tools::BROWSER_SCREENSHOT => screenshot_failure_text_for(code, details),
        // `frames` inherits `read`'s three refusals and nothing else: the list is an
        // inventory *of a page*.
        tools::BROWSER_FRAMES => page_failure_text(code, details, code_text),
        // The transcript reads a page too, and adds its own three codes.
        tools::BROWSER_TRANSCRIPT => {
            if code == Some(INVALID_PARAMS_CODE) {
                return invalid_read_params_text(details);
            }
            if code == Some(OFFSET_OUT_OF_RANGE_CODE) {
                return offset_out_of_range_text(details);
            }
            if code == Some(TRANSCRIPT_FAILED_CODE) {
                return transcript_failed_text(details);
            }
            if code == Some(TRANSCRIPT_NEEDS_FOCUS_CODE) {
                return transcript_needs_focus_text(details);
            }
            if code == Some(NO_TRANSCRIPT_PANEL_CODE) {
                return texts::NO_TRANSCRIPT_PANEL.to_string();
            }
            page_failure_text(code, details, code_text)
        }
        _ => texts::status_extension_failed(code_text),
    }
}

/// The three refusals every page-reading tool shares: the missing agent tab, the
/// unreadable page and the page that is still loading — plus the generic sentence for
/// everything else.
///
/// One helper instead of five copies, because "open a tab first", "this page cannot be
/// read" and "the page is still loading" mean the same thing whichever tool walked
/// into the page. The order inside a branch cannot matter: a code is one value, so no
/// two arms here can both match.
fn page_failure_text(code: Option<&str>, details: Option<&Value>, code_text: &str) -> String {
    if code == Some(NO_AGENT_TAB_CODE) {
        return texts::NO_AGENT_TAB.to_string();
    }
    if code == Some(NOT_READABLE_CODE) {
        return not_readable_text(details);
    }
    if code == Some(PAGE_BUSY_CODE) {
        return texts::PAGE_BUSY.to_string();
    }
    texts::call_extension_failed(code_text)
}

/// `read`'s own branch: the window refusal first, then the page triangle.
fn read_failure_text(code: Option<&str>, details: Option<&Value>, code_text: &str) -> String {
    if code == Some(INVALID_PARAMS_CODE) {
        return invalid_read_params_text(details);
    }
    if code == Some(OFFSET_OUT_OF_RANGE_CODE) {
        return offset_out_of_range_text(details);
    }
    page_failure_text(code, details, code_text)
}

/// `params.selector` as the template interpolates it: the string itself, and
/// `undefined` when the caller sent no selector.
///
/// That word is not decoration: `inspect` may be called with `text` alone and still
/// be refused with `invalid_selector`, and the template prints `undefined` there. A
/// quieter empty string would hide which key the sentence is about.
fn selector_of(params: Option<&Map<String, Value>>) -> String {
    match params.and_then(|params| params.get("selector")) {
        None => "undefined".to_string(),
        Some(Value::String(selector)) => selector.clone(),
        Some(other) => other.to_string(),
    }
}

/// The sentence for an unreadable page, built from the facts the extension could add:
/// `kind`, `url` and `contentType`.
///
/// Nothing usable means the old sentence, word for word. A `url` without a usable
/// `kind` still names the address — an address is worth more than a type nobody
/// knows. The `contentType` gets no whitelist and only has to be a non-empty string:
/// a media type has no closed set.
fn not_readable_text(details: Option<&Value>) -> String {
    let Some(url) = non_empty_string(details.and_then(|details| details.get("url"))) else {
        return texts::NOT_READABLE.to_string();
    };

    let kind = non_empty_string(details.and_then(|details| details.get("kind")));
    let content_type = non_empty_string(details.and_then(|details| details.get("contentType")));
    let named_kind = kind.filter(|kind| NOT_READABLE_KINDS.contains(kind) && *kind != "unknown");

    match (named_kind, content_type) {
        (Some(kind), Some(content_type)) => {
            texts::not_readable_with_kind_and_type(kind, content_type, url)
        }
        (None, Some(content_type)) => texts::not_readable_with_type(content_type, url),
        (Some(kind), None) => texts::not_readable_with_kind(kind, url),
        (None, None) => texts::not_readable_with_url(url),
    }
}

/// The sentence for an `offset` behind the text's end, with the length the extension
/// sent when there is one. The number is what the caller pages by, and it only ever
/// lived in the page — inventing one here would be a second measurement.
fn offset_out_of_range_text(details: Option<&Value>) -> String {
    message_sentence(
        details,
        texts::OFFSET_OUT_OF_RANGE,
        texts::offset_out_of_range_with_message,
    )
}

/// The sentence for `transcript_needs_focus`, with the extension's own message. The
/// two shapes of this refusal need opposite advice — a hidden tab needs
/// `browser_focus`, a visible but hydrating one must not be focused again — so
/// dropping the message would start the loop the second shape exists to prevent.
fn transcript_needs_focus_text(details: Option<&Value>) -> String {
    message_sentence(
        details,
        texts::TRANSCRIPT_NEEDS_FOCUS,
        texts::transcript_needs_focus_with_message,
    )
}

/// The sentence for `transcript_failed`, with the extension's own reason. The plain
/// sentence blames the page, which is false on a watch page whose track file is
/// missing; the reason is the only fact that tells the two apart.
fn transcript_failed_text(details: Option<&Value>) -> String {
    message_sentence(
        details,
        texts::TRANSCRIPT_FAILED,
        texts::transcript_failed_with_message,
    )
}

/// The sentence for a `read` the extension refused as `invalid_params`, with its own
/// message: the extension is the side that knows which field is wrong and which
/// bounds apply.
fn invalid_read_params_text(details: Option<&Value>) -> String {
    message_sentence(
        details,
        texts::INVALID_READ_PARAMS,
        texts::invalid_read_params_with_message,
    )
}

/// `generic` when the details carry no usable `message`, the built sentence otherwise.
fn message_sentence(
    details: Option<&Value>,
    generic: &str,
    with_message: fn(&str) -> String,
) -> String {
    match non_empty_string(details.and_then(|details| details.get("message"))) {
        None => generic.to_string(),
        Some(message) => with_message(message),
    }
}

/// The sentence for a `frame` substring no frame answered to, with the answered count
/// when the extension sent one. A frame that never answered (a hung embed) is missing
/// from the count, so "no frame matched" and "nobody was listening" stay two
/// situations.
///
/// `Number.isInteger`, not `Value::as_i64`: a `frames: 3.0` off the wire is an integer to
/// the template, and answering with the shorter sentence would claim the extension sent no
/// count at all.
fn frame_not_found_text(details: Option<&Value>) -> String {
    let frames = details.and_then(|details| details.get("frames"));
    match frames.filter(|frames| tools::is_integer(frames)).and_then(answered_frames) {
        Some(count) if count >= 0 => texts::frame_not_found_with_count(count),
        _ => texts::FRAME_NOT_FOUND.to_string(),
    }
}

/// The count as the sentence prints it. `is_integer` has already proven the value a whole
/// number, so the float arm is the `3.0` shape, and `3.0` prints as `3` in Node as well.
fn answered_frames(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|float| float as i64))
}

/// The sentence for an ambiguous `frame`, naming the addresses that collided. The
/// list is cut again here: the extension caps it at five, and a display limit belongs
/// on the side that formats.
fn frame_ambiguous_text(details: Option<&Value>) -> String {
    let candidates = frame_candidates_of(details.and_then(|details| details.get("candidates")));
    if candidates.is_empty() {
        return texts::FRAME_AMBIGUOUS.to_string();
    }
    texts::frame_ambiguous_with_candidates(&candidates.join(", "))
}

/// The non-empty strings of a candidate list, at most [`FRAME_CANDIDATE_LIMIT`] of them.
fn frame_candidates_of(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(entries)) = value else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| entry.as_str().filter(|text| !text.is_empty()))
        .take(FRAME_CANDIDATE_LIMIT)
        .map(str::to_string)
        .collect()
}

/// What an `ok:false` from an `inspect` call reads like. Its own function, because
/// the sentences are assembled from the request: `invalid_selector` names the selector
/// the caller sent, while `invalid_params` deliberately names no field at all.
fn inspect_failure_text_for(
    code: Option<&str>,
    params: Option<&Map<String, Value>>,
    details: Option<&Value>,
) -> String {
    if code == Some(INVALID_PARAMS_CODE) {
        return texts::INVALID_INSPECT_PARAMS.to_string();
    }
    if code == Some(INVALID_SELECTOR_CODE) {
        return texts::invalid_selector(&selector_of(params));
    }
    page_failure_text(code, details, code.unwrap_or(UNKNOWN_CODE))
}

/// What an `ok:false` from an `eval` call reads like: five codes of its own plus the
/// three of the page triangle it walks into. Unknown codes keep the generic sentence.
fn eval_failure_text_for(code: Option<&str>, details: Option<&Value>) -> String {
    if code == Some(EVAL_NOT_ALLOWED_CODE) {
        return texts::EVAL_NOT_ALLOWED.to_string();
    }
    if code == Some(EVAL_FAILED_CODE) {
        return message_sentence(
            details,
            texts::EVAL_FAILED,
            texts::eval_failed_with_message,
        );
    }
    if code == Some(EVAL_TIMEOUT_CODE) {
        return texts::EVAL_TIMEOUT.to_string();
    }
    if code == Some(EVAL_RESULT_TOO_LARGE_CODE) {
        return texts::EVAL_RESULT_TOO_LARGE.to_string();
    }
    if code == Some(EVAL_RESULT_UNSERIALIZABLE_CODE) {
        return texts::EVAL_RESULT_UNSERIALIZABLE.to_string();
    }
    if code == Some(INVALID_PARAMS_CODE) {
        return texts::INVALID_EVAL_PARAMS.to_string();
    }
    page_failure_text(code, details, code.unwrap_or(UNKNOWN_CODE))
}

/// What an `ok:false` from a `screenshot` call reads like. `page_busy` and
/// `not_readable` are deliberately absent: `captureTab` injects no script, so the
/// extension never answers them and a sentence for them would be advice about a
/// failure that cannot happen.
fn screenshot_failure_text_for(code: Option<&str>, details: Option<&Value>) -> String {
    if code == Some(SCREENSHOT_NOT_ALLOWED_CODE) {
        return texts::SCREENSHOT_NOT_ALLOWED.to_string();
    }
    if code == Some(SCREENSHOT_FAILED_CODE) {
        return message_sentence(
            details,
            texts::SCREENSHOT_FAILED,
            texts::screenshot_failed_with_message,
        );
    }
    if code == Some(SCREENSHOT_TOO_LARGE_CODE) {
        return message_sentence(
            details,
            texts::SCREENSHOT_TOO_LARGE,
            texts::screenshot_too_large_with_message,
        );
    }
    if code == Some(INVALID_PARAMS_CODE) {
        return texts::INVALID_SCREENSHOT_PARAMS.to_string();
    }
    if code == Some(NO_AGENT_TAB_CODE) {
        return texts::NO_AGENT_TAB.to_string();
    }
    texts::call_extension_failed(code.unwrap_or(UNKNOWN_CODE))
}

/// The value itself when it is a non-empty string, `None` for everything else.
fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    // The case names carry the Node suite's spelling so the mapping stays readable;
    // `docs/38`, `### What could go wrong` names the allow.
    #![allow(non_snake_case)]

    use super::*;

    /// The one sentence no path reaches: every refusal in Rust is one of the three
    /// [`FailureKind`]s, so the template's fallback arm for an unknown error name has
    /// no counterpart here. `docs/38`, `## Bekannte Lücken` names that as a gap —
    /// pinning the sentence is the honest replacement for a case that cannot exist.
    #[test]
    fn bridgeFailed_shouldKeepTheSentenceTheTemplateWouldPrint() {
        assert_eq!(
            texts::BRIDGE_FAILED,
            "The bridge could not read the status."
        );
    }
}
