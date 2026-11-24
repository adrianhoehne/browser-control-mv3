//! The long manual behind `browser_help`: one English text per tool.
//!
//! These texts are deliberately **not** part of `tools/list`. That list is read on
//! every session and costs tokens in every request; a model that needs to know how a
//! tool works asks for it, once (spec 53). The short descriptions stay where they are.
//!
//! Every text has the same six sections, in the same order, so a model can orient
//! itself after the first read: Purpose, Arguments, Returns, Example, Pitfalls,
//! Related. Nothing here is generated: no version, no date, no state — otherwise the
//! answer would not be reproducible and not testable.

use crate::mcp::tools::{
    BROWSER_CLICK, BROWSER_CLOSE_TAB, BROWSER_EVAL, BROWSER_FOCUS, BROWSER_FRAMES,
    BROWSER_HELP, BROWSER_INSPECT, BROWSER_NAVIGATE, BROWSER_OPEN_TAB, BROWSER_READ,
    BROWSER_SCREENSHOT, BROWSER_STATUS, BROWSER_TRANSCRIPT, BROWSER_TYPE,
};

const STATUS: &str = r#"## Purpose
Shows the operator's windows and tabs, the connection state of the extension, and marks the agent tab with `agent: true`.

## Arguments
None. This tool takes no arguments at all.

## Returns
`extension` (`version`, `connectedAt`), and `windows` with `id`, `focused` and `tabs`; each tab carries `id`, `url`, `title`, `active`, `pinned` and `agent`.

## Example
`browser_status({})` answers `{"extension":{"version":"0.6.1","connectedAt":"…"},"windows":[{"id":1,"focused":true,"tabs":[{"id":12,"url":"https://example.com/","agent":true}]}]}`.

## Pitfalls
An empty `windows` list is a real answer: the extension is connected but has no default container. `extension: null` means the bridge is up and nothing is listening.

## Related
`browser_open_tab`, `browser_frames`"#;

const NAVIGATE: &str = r#"## Purpose
Opens an http(s) URL in the agent tab and waits for the page to load, then for it to settle.

## Arguments
| Name | Required | Meaning |
|---|---|---|
| `url` | yes | `http://` or `https://` only |
| `tab` | no | an agent tab by id; without it the last used one |
| `waitMs` | no | how long to wait for settling, at most 10000 |

## Returns
`tabId`, `windowId`, `url`, `title`, `complete`, `settled`, `waitedMs`.

## Example
`browser_navigate({"url":"https://example.com/"})` answers `{"tabId":12,"url":"https://example.com/","title":"Example Domain","settled":true}`.

## Pitfalls
`settled: false` means **the page is still working**. Read again after a moment instead of concluding that the page is empty — a single-page app hydrates after the first paint. `about:` URLs are refused; this tool only speaks http(s).

## Related
`browser_read`, `browser_open_tab`"#;

const READ: &str = r#"## Purpose
Reads the **current agent tab**. It opens nothing and takes **no URL**. Order: `browser_navigate` → `browser_read`.

## Arguments
| Name | Required | Meaning |
|---|---|---|
| `offset` | no | characters to skip, default 0 |
| `maxChars` | no | window size, default 20000, at most 100000 |
| `mode` | no | `text` (visible text) or `article` (the article body only) |
| `frame` | no | a substring of a frame address, see `browser_frames` |
| `tab` | no | an agent tab by id |

## Returns
`tabId`, `url`, `title`, `text`, `chars`, `totalChars`, `via`, `settled`, `waitedMs`.

## Example
`browser_read({"maxChars":200})` answers `{"title":"Example Domain","text":"This domain is for use in documentation…","chars":200,"totalChars":917}`.

## Pitfalls
There is no `url` argument — passing one is refused before anything is injected. `chars` and `totalChars` tell you where you are in a long page. A page that refuses injection answers with a named error instead of text.

## Related
`browser_navigate`, `browser_inspect`"#;

const CLICK: &str = r#"## Purpose
Clicks the first element that matches a CSS selector in the **current agent tab**, waits for the page to settle, and returns the text afterwards.

## Arguments
| Name | Required | Meaning |
|---|---|---|
| `selector` | yes | CSS selector; shadow paths use `>>>` |
| `tab` | no | an agent tab by id |
| `frame` | no | a substring of a frame address |

## Returns
`tabId`, `url`, `title`, `clicked`, `scrolled`, `text` (cut at 20000 characters), `settled`, `waitedMs`. `scrolled` says whether the target had to be scrolled into the visible area first.

## Example
`browser_click({"selector":"a.more-info"})` answers `{"tabId":12,"url":"https://www.iana.org/help/example-domains","settled":true,"text":"…"}`.

## Pitfalls
No `url` argument. A selector that matches nothing is an error, not an empty answer. A target outside the visible area is scrolled to and clicked; one that stays outside after scrolling is refused as `offscreen_after_scroll` instead of being clicked blind. The click is a real click on the page — it can navigate, submit a form or start a download. A click that lands on a page this extension cannot read answers `not_readable_after_click`: the click went through, so do not repeat it — go back with `browser_navigate`.

## Related
`browser_inspect`, `browser_type`"#;

const TYPE: &str = r#"## Purpose
Writes text into the field that matches a CSS selector in the **current agent tab** and returns the page text afterwards.

## Arguments
| Name | Required | Meaning |
|---|---|---|
| `selector` | yes | CSS selector of the field |
| `typed_text` | yes | the text to write |
| `enter` | no | send Enter afterwards, default false |
| `tab` | no | an agent tab by id |
| `frame` | no | a substring of a frame address |

## Returns
`tabId`, `url`, `title`, `text` (cut at 20000 characters), `settled`, `waitedMs`.

## Example
`browser_type({"selector":"input[name=q]","typed_text":"weather","enter":true})` answers the search page text after the submit.

## Pitfalls
No `url` argument. A password field is refused unless the operator turned that switch on — the refusal is named and does not write. `enter: true` submits, which can lose what you typed if the page navigates.

## Related
`browser_click`, `browser_read`"#;

const FOCUS: &str = r#"## Purpose
Brings the agent tab to the front and its window into the foreground. The page is not changed.

## Arguments
| Name | Required | Meaning |
|---|---|---|
| `tab` | no | an agent tab by id |

## Returns
`tabId`, `windowId`, `focused`.

## Example
`browser_focus({})` answers `{"tabId":12,"windowId":1,"focused":true}`.

## Pitfalls
`focused` is read back after the attempt, so `false` is a real refusal by the window manager — not an error of the call. Useful before a screenshot, so the visible area is the one you expect.

## Related
`browser_screenshot`, `browser_status`"#;

const INSPECT: &str = r#"## Purpose
Lists elements of the **current agent tab** with tag, id, class, link, visible text, visibility and a ready-to-use selector.

## Arguments
| Name | Required | Meaning |
|---|---|---|
| `selector` | no | CSS selector to narrow the search |
| `contains_text` | no | a substring to search for |
| `limit` | no | how many elements, default 20 |
| `includeHidden` | no | list invisible elements too, default false |
| `frame` | no | a substring of a frame address |
| `tab` | no | an agent tab by id |

## Returns
`count`, `truncated`, `elements` (each with `selector`, `tag`, `id`, `classes`, `text`, `href`, `visible`, `rect`).

## Example
`browser_inspect({"contains_text":"Login","limit":5})` answers elements whose selector you can pass to `browser_click` unchanged.

## Pitfalls
No `url` argument. The selector it returns is the value to hand to `click`/`type` — do not build your own from the tag. Shadow DOM paths appear as `my-card >>> button`.

## Related
`browser_click`, `browser_read`"#;

const OPEN_TAB: &str = r#"## Purpose
Opens another agent tab in the default container (at most five) and returns its id.

## Arguments
| Name | Required | Meaning |
|---|---|---|
| `url` | yes | `http://` or `https://` |
| `active` | no | bring it to the front, default true |

## Returns
`tabId`, `url`, `title`.

## Example
`browser_open_tab({"url":"https://github.com/"})` answers `{"tabId":21,"url":"https://github.com/","title":"GitHub"}`.

## Pitfalls
Five agent tabs is the limit; a sixth is refused. The new tab becomes the one the other tools address unless you pass `tab`. It does not wait for settling — a `browser_read` afterwards may need a moment.

## Related
`browser_status`, `browser_close_tab`"#;

const CLOSE_TAB: &str = r#"## Purpose
Closes an agent tab and removes it from the list.

## Arguments
| Name | Required | Meaning |
|---|---|---|
| `tab` | no | an agent tab by id; without it the last used one |

## Returns
`tabId`, `closed`.

## Example
`browser_close_tab({})` answers `{"tabId":21,"closed":true}`.

## Pitfalls
It closes a tab in the operator's browser. Close what you opened, and prefer the agent tab over the operator's. Closing the last agent tab leaves no tab to address.

## Related
`browser_open_tab`, `browser_status`"#;

const EVAL: &str = r#"## Purpose
Evaluates JavaScript in the page's **own world** of the current agent tab and returns the result as JSON.

## Arguments
| Name | Required | Meaning |
|---|---|---|
| `code` | yes | function body; `return` decides the result, top-level `await` is allowed |
| `frame` | no | a substring of a frame address |
| `tab` | no | an agent tab by id |

## Returns
`tabId`, `url`, `title`, `elapsedMs`, `result`.

## Example
`browser_eval({"code":"const r = await fetch('/api/items'); return (await r.json()).length;"})` answers the number. For the tab title: `{"code":"return document.title"}`.

## Pitfalls
No `url` argument. Requires the operator's evaluation switch, otherwise a named refusal. A page with its own CSP answers `eval_blocked_by_the_page` — that is the page's rule, not a broken call; use `browser_read` or `browser_inspect` there. Two seconds is the deadline; a never-settling promise answers `eval_timeout`. Results over 10000 JSON characters are refused, not cut.

## Related
`browser_read`, `browser_inspect`"#;

const SCREENSHOT: &str = r#"## Purpose
Photographs the visible area of the **current agent tab** and returns it as an MCP image block.

## Arguments
| Name | Required | Meaning |
|---|---|---|
| `tab` | no | an agent tab by id |

## Returns
`tabId`, `url`, `format`, `width`, `height`, `bytes`, `scaled` — plus the image itself.

## Example
`browser_screenshot({})` answers `{"format":"png","width":1708,"height":1214,"bytes":749023}` and the picture.

## Pitfalls
No `url` argument. Needs the operator's screenshot switch. Above 3 MiB the picture is scaled down and re-encoded as JPEG — `scaled: true` says so. The visible area only, so `browser_focus` first if the tab is in the background.

## Related
`browser_focus`, `browser_read`"#;

const FRAMES: &str = r#"## Purpose
Lists the frames (iframes) of the agent tab with their address.

## Arguments
| Name | Required | Meaning |
|---|---|---|
| `tab` | no | an agent tab by id |

## Returns
`count`, `frames` (each with `href` and `top`).

## Example
`browser_frames({})` answers `{"count":2,"frames":[{"href":"https://example.com/","top":true},{"href":"https://widget.example.net/kalender","top":false}]}`.

## Pitfalls
The `frame` argument of the other tools takes a **substring** of one of these addresses, not an index. Several frames matching is `frame_ambiguous`, with the candidates in the error.

## Related
`browser_read`, `browser_inspect`"#;

const TRANSCRIPT: &str = r#"## Purpose
Reads the transcript of the YouTube video tab as segments with timestamp and text.

## Arguments
| Name | Required | Meaning |
|---|---|---|
| `request` | no | `auto`, or a language and track selection |
| `tab` | no | an agent tab by id |

## Returns
`videoId`, `title`, `language`, `segments` (each with `startMs`, `text`).

## Example
`browser_transcript({})` answers `{"videoId":"…","language":"de","segments":[{"startMs":0,"text":"…"}]}`.

## Pitfalls
Only a desktop YouTube watch page works; anything else answers `transcript_failed` with the reason, not with an empty list. The first call on a cold page can take longer than the bridge's call timeout — open the video, let it play, then ask.

## Related
`browser_navigate`, `browser_read`"#;

const HELP: &str = r#"## Purpose
Answers with the long manual of one browser tool: purpose, arguments, returns, an example, the pitfalls and the related tools.

## Arguments
| Name | Required | Meaning |
|---|---|---|
| `tool` | yes | one of the browser tool names, `browser_help` included |

## Returns
A text block with six sections, in the same order for every tool.

## Example
`browser_help({"tool":"browser_read"})` answers the manual above, so that `browser_read` is called with `offset`/`maxChars` and not with a URL.

## Pitfalls
It answers **without** a connected extension — reading a manual never needs a browser. An unknown name is refused with the list of valid names.

## Related
`browser_status`"#;

/// The manual for `name`, or `None` when the name is not a tool of this contract.
pub fn manual_for(name: &str) -> Option<&'static str> {
    let text = match name {
        BROWSER_STATUS => STATUS,
        BROWSER_NAVIGATE => NAVIGATE,
        BROWSER_READ => READ,
        BROWSER_CLICK => CLICK,
        BROWSER_TYPE => TYPE,
        BROWSER_FOCUS => FOCUS,
        BROWSER_INSPECT => INSPECT,
        BROWSER_OPEN_TAB => OPEN_TAB,
        BROWSER_CLOSE_TAB => CLOSE_TAB,
        BROWSER_EVAL => EVAL,
        BROWSER_SCREENSHOT => SCREENSHOT,
        BROWSER_FRAMES => FRAMES,
        BROWSER_TRANSCRIPT => TRANSCRIPT,
        BROWSER_HELP => HELP,
        _ => return None,
    };
    Some(text)
}

/// Every name this manual answers for, in the order of the tool list. The refusal for
/// an unknown name lists them, so a model can correct itself without another call.
pub fn known_names() -> [&'static str; 14] {
    [
        BROWSER_STATUS,
        BROWSER_NAVIGATE,
        BROWSER_READ,
        BROWSER_CLICK,
        BROWSER_TYPE,
        BROWSER_FOCUS,
        BROWSER_INSPECT,
        BROWSER_OPEN_TAB,
        BROWSER_CLOSE_TAB,
        BROWSER_EVAL,
        BROWSER_SCREENSHOT,
        BROWSER_FRAMES,
        BROWSER_TRANSCRIPT,
        BROWSER_HELP,
    ]
}
