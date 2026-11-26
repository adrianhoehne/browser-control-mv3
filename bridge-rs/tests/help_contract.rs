//! The manuals of `browser_help` against the contract they describe.
//!
//! A manual is prose: one table of arguments and one line of return fields per tool.
//! Nothing in the compiler ties either to `tools/list` or to what the extension answers,
//! yet a model reads the manual as the truth (spec 53). Three such gaps were measured
//! live against the running service on 2026-11-26: `browser_type` documented an `enter`
//! argument where the schema says `submit`, and claimed a settle result it never
//! answers; `browser_transcript` documented a `request` argument that no longer exists,
//! together with a `videoId`/`language` result the tool does not answer; and
//! `browser_click` left `truncated` and `via` out of its return line. This file is the
//! guard against the next one. It found two more rows of the same kind on its first run —
//! `waitMs` in the manual of `browser_navigate` and `active` in the manual of
//! `browser_open_tab`, neither of which the schema declares — and those two rows are gone.
//!
//! The `## Example` section is read as well, since it is the text a model copies: every
//! key of a shown call must exist in the schema of the tool it calls, and every key of a
//! quoted answer must exist in the return line of the same manual. That is where the
//! first wrong manual was found by hand — `browser_type` passed `"enter": true` where the
//! schema says `submit`.
//!
//! What it cannot do: no text check decides whether the extension still answers those
//! fields. That part is a measurement, and the date and the page are written next to
//! every list. The schema is checked for all fourteen tools, and so is the return line:
//! five entries were pinned when this file was written, the nine remaining ones came with
//! the second measurement of 2026-11-26. That run found one more gap of the same kind —
//! `type` of a window was missing from the manual of `browser_status` — and it is now
//! written there.

#![allow(non_snake_case)]

use std::collections::BTreeSet;

use serde_json::{json, Value};

use browser_control_bridge::mcp::help::{known_names, manual_for};
use browser_control_bridge::mcp::tools::tool_list;

/// The fields each tool answers, as `Object.keys` reports them on the wire.
///
/// Fixed on purpose: a list computed from the code under test would agree with any
/// mistake the code makes. The four tools of the brief are quoted from a live run of
/// 2026-11-26; `transcript` is quoted from the extension's own result object
/// (`transcriptCaptionResultOf`), because its manual is the one rewritten with them.
const EXPECTED_RETURNS: [(&str, &[&str]); 5] = [
    (
        "browser_navigate",
        &[
            "tabId",
            "windowId",
            "url",
            "title",
            "complete",
            "settled",
            "waitedMs",
        ],
    ),
    (
        "browser_read",
        &[
            "tabId",
            "url",
            "title",
            "text",
            "offset",
            "chars",
            "totalChars",
            "truncated",
            "via",
            "mode",
            "root",
            "fellBack",
            "settled",
            "waitedMs",
        ],
    ),
    (
        "browser_click",
        &[
            "tabId",
            "url",
            "title",
            "clicked",
            "scrolled",
            "text",
            "truncated",
            "via",
            "settled",
            "waitedMs",
        ],
    ),
    (
        "browser_type",
        &[
            "tabId",
            "url",
            "title",
            "typed",
            "submitted",
            "text",
            "truncated",
            "via",
        ],
    ),
    (
        "browser_transcript",
        &[
            "requestedLanguage",
            "deliveredLanguage",
            "source",
            "segments",
            "time",
            "timeText",
            "text",
            "offset",
            "chars",
            "totalChars",
            "truncated",
        ],
    ),
];

/// The fields the nine remaining tools answer, as `Object.keys` reports them on the
/// wire.
///
/// Measured live on 2026-11-26 against `127.0.0.1:8111/mcp` (`tools/call`, the JSON in
/// `result.content[0].text`; no tool answered a `structuredContent` block). The comment
/// above each entry says which page or branch produced it, so the list can be re-measured
/// instead of guessed. Nested fields are flattened to their bare names — `type` of a
/// window, `href`/`top` of a frame, the twelve names of an `elements` entry — the same
/// way the manuals write them.
const MEASURED_RETURNS: [(&str, &[&str]); 9] = [
    // Firefox, one window, 4 → 2 tabs.
    (
        "browser_status",
        &[
            "extension",
            "version",
            "connectedAt",
            "windows",
            "id",
            "focused",
            "type",
            "tabs",
            "url",
            "title",
            "active",
            "pinned",
            "agent",
        ],
    ),
    // Two agent tabs, once without `tab` and once with `tab:15`.
    (
        "browser_focus",
        &["tabId", "windowId", "url", "title", "active", "focused"],
    ),
    // `selector:"a", limit:3` on www.wikipedia.org: count 378, truncated true. A
    // selector with no hit answered the same six fields with count 0 and no error.
    (
        "browser_inspect",
        &[
            "tabId",
            "url",
            "title",
            "count",
            "truncated",
            "elements",
            "index",
            "selector",
            "tag",
            "id",
            "classes",
            "text",
            "href",
            "ariaLabel",
            "visible",
            "offscreen",
            "disabled",
            "rect",
        ],
    ),
    // example.com, then two YouTube watch tabs.
    ("browser_open_tab", &["tabId", "url", "title"]),
    // Once with `tab` and once without it.
    ("browser_close_tab", &["tabId", "closed"]),
    // `return document.title` on www.wikipedia.org: result "Wikipedia", elapsedMs 0.
    (
        "browser_eval",
        &["tabId", "url", "title", "elapsedMs", "result"],
    ),
    // www.wikipedia.org at 1904×871: png, 219600 bytes, scaled false, plus an image
    // block. A second run above the size limit answered jpeg, 1600×732, scaled true,
    // with the same nine fields.
    (
        "browser_screenshot",
        &[
            "tabId",
            "url",
            "title",
            "format",
            "width",
            "height",
            "bytes",
            "scaled",
            "activated",
        ],
    ),
    // www.wikipedia.org and en.wikipedia.org: count 1, the top frame only.
    (
        "browser_frames",
        &["tabId", "url", "count", "frames", "href", "top"],
    ),
    // Not a JSON object: one markdown text block with six sections, so there was no
    // `Object.keys` to read and the expected set is empty. This still guards the line:
    // a hand that lists JSON fields here would be describing an answer that never comes.
    // The six sections themselves are guarded in `tests/mcp.rs`.
    ("browser_help", &[]),
];

/// The one section of a manual with this heading, as its lines.
fn section<'a>(manual: &'a str, heading: &str, tool: &str) -> Vec<&'a str> {
    let marker = format!("## {heading}");
    let lines: Vec<&str> = manual.lines().collect();
    let start = lines
        .iter()
        .position(|line| line.trim_end() == marker)
        .unwrap_or_else(|| panic!("the manual of {tool} has no `{marker}` section"));

    lines[start + 1..]
        .iter()
        .take_while(|line| !line.starts_with("## "))
        .copied()
        .collect()
}

/// The rows of the `## Arguments` table: the argument name and whether it is marked as
/// required.
///
/// The third column is prose and stays unread; the header row and the `|---|` separator
/// are not arguments either.
fn argument_rows(manual: &str, tool: &str) -> Vec<(String, bool)> {
    let mut rows: Vec<(String, bool)> = Vec::new();

    for line in section(manual, "Arguments", tool) {
        let line = line.trim();
        if !line.starts_with('|') {
            continue;
        }
        let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
        if cells.len() < 2 || cells[0] == "Name" || cells[0].chars().all(|c| c == '-') {
            continue;
        }

        let name = cells[0].trim_matches('`').to_string();
        assert!(
            !name.is_empty() && !name.contains(char::is_whitespace),
            "the manual of {tool} names an argument `{name}` that is not a single bare name"
        );
        assert!(
            !rows.iter().any(|(documented, _)| *documented == name),
            "the manual of {tool} lists `{name}` twice"
        );

        let required = match cells[1] {
            "yes" => true,
            "no" => false,
            other => panic!(
                "the manual of {tool} marks `{name}` with `{other}`; the Required column says yes or no"
            ),
        };
        rows.push((name, required));
    }

    rows
}

/// Every name the `## Returns` section writes in backticks.
///
/// The line is prose, so two sorts of backticked words are not field names and are
/// dropped: a phrase with a space (`mode: "article"`, `fellBack: true`) and a bare JSON
/// literal (`null`, `true`, `false`).
fn return_fields(manual: &str, tool: &str) -> BTreeSet<String> {
    const JSON_LITERALS: [&str; 3] = ["null", "true", "false"];
    let mut fields = BTreeSet::new();

    for line in section(manual, "Returns", tool) {
        let mut rest = line;
        while let Some(open) = rest.find('`') {
            let after = &rest[open + 1..];
            let Some(close) = after.find('`') else { break };
            let token = &after[..close];
            rest = &after[close + 1..];

            if token.chars().any(char::is_whitespace) || JSON_LITERALS.contains(&token) {
                continue;
            }
            fields.insert(token.to_string());
        }
    }

    fields
}

/// The tools whose example quotes an answer with the word `answers` before it.
///
/// Pinned for the reason of the return tables: without it, a manual that quietly dropped
/// its quoted answer would stop being read instead of failing. Ten of the fourteen quote
/// one; `type`, `inspect`, `eval` and `help` answer in prose or with a number.
const QUOTED_ANSWERS: [&str; 10] = [
    "browser_status",
    "browser_navigate",
    "browser_read",
    "browser_click",
    "browser_focus",
    "browser_open_tab",
    "browser_close_tab",
    "browser_screenshot",
    "browser_frames",
    "browser_transcript",
];

/// One call an example shows: the tool it names and the argument names it passes.
struct ExampleCall {
    tool: String,
    arguments: BTreeSet<String>,
}

/// One `## Example` section, as far as text can read it.
///
/// The section is prose, so it is split by backtick span. A span that starts with a tool
/// name and parentheses (`browser_read({…})`) is a call. A span that is a JSON object and
/// is written directly after the word `answers` is the quoted answer. An object in
/// neither place is neither: `browser_eval` shows one without its tool name
/// (`For the tab title: {"code":"return document.title"}`), so its keys are checked
/// against schema and return line together — the text does not say which one they are.
struct Example {
    calls: Vec<ExampleCall>,
    answers: Vec<(String, BTreeSet<String>)>,
    unlabelled: Vec<(String, BTreeSet<String>)>,
}

/// Every key of a JSON value, nested objects and array entries included, as bare names —
/// the same flattening the return lines use for `windows`, `elements` and `segments`.
fn keys_in(value: &Value, into: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                into.insert(key.clone());
                keys_in(child, into);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| keys_in(item, into)),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

/// The keys of one JSON object, with the span quoted back when it does not parse.
fn object_keys(text: &str, tool: &str, span: &str) -> BTreeSet<String> {
    let value: Value = serde_json::from_str(text).unwrap_or_else(|error| {
        panic!("the example of {tool} writes `{span}`, which is not JSON: {error}")
    });
    let mut keys = BTreeSet::new();
    keys_in(&value, &mut keys);
    keys
}

/// The call in one backticked span, when the span is one: `browser_read({…})`.
fn call_in(span: &str, manual_tool: &str) -> Option<ExampleCall> {
    if !span.starts_with("browser_") || !span.ends_with(')') {
        return None;
    }
    let open = span.find('(')?;
    let inner = span[open + 1..span.len() - 1].trim();
    assert!(
        inner.starts_with('{'),
        "the example of {manual_tool} shows the call `{span}`, whose arguments are not a JSON object"
    );

    Some(ExampleCall {
        tool: span[..open].to_string(),
        arguments: object_keys(inner, manual_tool, span),
    })
}

/// The `## Example` section of one manual, split into calls, quoted answers and the rest.
fn example_of(manual: &str, tool: &str) -> Example {
    let text = section(manual, "Example", tool).join("\n");
    let mut example = Example {
        calls: Vec::new(),
        answers: Vec::new(),
        unlabelled: Vec::new(),
    };

    let mut rest = text.as_str();
    while let Some(open) = rest.find('`') {
        let before = rest[..open].trim_end();
        let after = &rest[open + 1..];
        let Some(close) = after.find('`') else { break };
        let span = &after[..close];
        rest = &after[close + 1..];

        let trimmed = span.trim();
        if let Some(call) = call_in(trimmed, tool) {
            example.calls.push(call);
        } else if trimmed.starts_with('{') {
            let keys = object_keys(trimmed, tool, span);
            if before.ends_with("answers") {
                example.answers.push((span.to_string(), keys));
            } else {
                example.unlabelled.push((span.to_string(), keys));
            }
        }
    }

    example
}

fn named(items: &BTreeSet<String>) -> String {
    if items.is_empty() {
        return "none".to_string();
    }
    items
        .iter()
        .map(|item| format!("`{item}`"))
        .collect::<Vec<String>>()
        .join(", ")
}

fn sorted(items: &BTreeSet<&str>) -> String {
    if items.is_empty() {
        return "none".to_string();
    }
    items.iter().copied().collect::<Vec<&str>>().join(", ")
}

/// The schema of one tool out of the real `tools/list`.
fn schema_of(tool: &str) -> (BTreeSet<String>, BTreeSet<String>) {
    let tools = tool_list();
    let entry = tools
        .as_array()
        .expect("tools/list is a list of tools")
        .iter()
        .find(|entry| entry.get("name").and_then(Value::as_str) == Some(tool))
        .unwrap_or_else(|| panic!("tools/list has no tool called {tool}"));
    let schema = entry
        .get("inputSchema")
        .expect("every tool declares an inputSchema");

    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .expect("every inputSchema declares its properties")
        .keys()
        .cloned()
        .collect();
    let required = schema
        .get("required")
        .map(|required| {
            required
                .as_array()
                .expect("`required` is a list")
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    (properties, required)
}

/// The argument table and the schema, in both directions.
///
/// One direction is the one `browser_transcript` broke: a name the manual offers and the
/// schema refuses (`request`). The other is the one a forgotten rename produces: the
/// schema declares an argument the manual never mentions. Every tool of `tools/list` is
/// read, so a new tool cannot arrive without a manual either.
#[test]
fn every_manual_argument_shouldMatchTheToolSchema() {
    let tools = tool_list();
    let names: Vec<&str> = tools
        .as_array()
        .expect("tools/list is a list of tools")
        .iter()
        .map(|entry| {
            entry
                .get("name")
                .and_then(Value::as_str)
                .expect("every tool has a name")
        })
        .collect();

    assert_eq!(
        names,
        known_names().to_vec(),
        "the manuals and the tool list name different tools, in a different order"
    );

    for tool in names {
        let manual = manual_for(tool).unwrap_or_else(|| panic!("{tool} has no manual"));
        let documented = argument_rows(manual, tool);
        let documented_names: BTreeSet<String> =
            documented.iter().map(|(name, _)| name.clone()).collect();
        let (properties, required) = schema_of(tool);

        assert_eq!(
            documented_names,
            properties,
            "the manual of {tool} and its schema list different arguments: \
             only in the manual {}, only in the schema {}",
            named(&documented_names.difference(&properties).cloned().collect()),
            named(&properties.difference(&documented_names).cloned().collect()),
        );

        for (name, marked_required) in documented {
            assert_eq!(
                required.contains(&name),
                marked_required,
                "the manual of {tool} marks `{name}` as required={marked_required}, \
                 the schema says required={}",
                required.contains(&name),
            );
        }
    }
}

/// The `## Returns` line against the fields the tool really answers, for every tool
/// whose answer is pinned in [`EXPECTED_RETURNS`] or [`MEASURED_RETURNS`].
///
/// Both directions again: a field the line leaves out (`truncated`, `via` for `click`,
/// `typed`/`submitted` for `type`, `type` of a window for `status`) and a field the line
/// invents (`settled` and `waitedMs` for `type`, `videoId` and `language` for
/// `transcript`) are the same mistake to a model that plans its next call from this line.
#[test]
fn every_pinned_manual_returnLine_shouldNameExactlyTheAnsweredFields() {
    for (tool, expected) in EXPECTED_RETURNS.into_iter().chain(MEASURED_RETURNS) {
        let manual = manual_for(tool).unwrap_or_else(|| panic!("{tool} has no manual"));
        let documented = return_fields(manual, tool);
        let expected: BTreeSet<String> = expected.iter().map(|field| field.to_string()).collect();

        assert_eq!(
            documented,
            expected,
            "the Returns line of {tool} and the real answer disagree: \
             only in the manual {}, only in the answer {}",
            named(&documented.difference(&expected).cloned().collect()),
            named(&expected.difference(&documented).cloned().collect()),
        );
    }
}

/// The examples against schema and return line, both halves.
///
/// Two checks per example, both pure text: every key of a shown call exists in the schema
/// of the tool it calls, and every key of a quoted answer exists in the return line of the
/// manual's own tool. Values and types stay unread — whether `"width":1708` fits a real
/// page is a measurement, not a sentence. The quoted answers are shortened on purpose
/// (`browser_screenshot` omits `tabId`), so only existence is required, never completeness.
#[test]
fn every_manual_example_shouldOnlyNameKeysOfItsSchemaAndItsReturnLine() {
    let mut quoting: BTreeSet<&str> = BTreeSet::new();

    for tool in known_names() {
        let manual = manual_for(tool).unwrap_or_else(|| panic!("{tool} has no manual"));
        let example = example_of(manual, tool);

        assert!(
            !example.calls.is_empty(),
            "the example of {tool} shows no call like `browser_x({{…}})`"
        );

        let (properties, _) = schema_of(tool);
        for call in &example.calls {
            assert_eq!(
                call.tool, tool,
                "the example of {tool} shows a call of {}, not of the tool it describes",
                call.tool
            );

            let unknown: BTreeSet<String> =
                call.arguments.difference(&properties).cloned().collect();
            assert!(
                unknown.is_empty(),
                "the example of {tool} passes {} to {tool}; its schema declares {}",
                named(&unknown),
                named(&properties),
            );
        }

        if !example.answers.is_empty() {
            quoting.insert(tool);
        }
        let returns = return_fields(manual, tool);
        for (span, keys) in &example.answers {
            let unknown: BTreeSet<String> = keys.difference(&returns).cloned().collect();
            assert!(
                unknown.is_empty(),
                "the example of {tool} quotes `{span}` as the answer, but the Returns line \
                 does not name {}; it names {}",
                named(&unknown),
                named(&returns),
            );
        }

        let known: BTreeSet<String> = returns.union(&properties).cloned().collect();
        for (span, keys) in &example.unlabelled {
            let unknown: BTreeSet<String> = keys.difference(&known).cloned().collect();
            assert!(
                unknown.is_empty(),
                "the example of {tool} writes the object `{span}`; {} is neither an argument \
                 of its schema nor a field of its Returns line",
                named(&unknown),
            );
        }
    }

    let pinned: BTreeSet<&str> = QUOTED_ANSWERS.into_iter().collect();
    assert_eq!(
        quoting,
        pinned,
        "the pinned examples and the written ones disagree: quotes an answer but is not \
         pinned {}, is pinned but quotes none {}",
        sorted(&quoting.difference(&pinned).copied().collect()),
        sorted(&pinned.difference(&quoting).copied().collect()),
    );
}

/// Every tool of the contract carries a pinned return line.
///
/// Without this, the guard above could shrink back: a tool whose table entry is dropped
/// would simply stop being read, and a second tool added to the list would never be
/// pinned. The two tables together must name exactly the fourteen tools of
/// [`known_names`], each one once.
#[test]
fn the_pinnedTools_shouldBeEveryToolOfTheContract() {
    let pinned: Vec<&str> = EXPECTED_RETURNS
        .iter()
        .chain(MEASURED_RETURNS.iter())
        .map(|(tool, _)| *tool)
        .collect();
    let unique: BTreeSet<&str> = pinned.iter().copied().collect();

    assert_eq!(
        unique.len(),
        pinned.len(),
        "a tool is pinned twice in the return tables"
    );

    let contract: BTreeSet<&str> = known_names().into_iter().collect();
    assert_eq!(
        unique,
        contract,
        "the pinned return lines and the tool contract disagree: \
         pinned but not a tool {}, a tool without a pinned return line {}",
        sorted(&unique.difference(&contract).copied().collect()),
        sorted(&contract.difference(&unique).copied().collect()),
    );
}

/// The budget of `docs/53`: the tool list stays under 8 500 characters, because it is
/// read on every session. The manuals do not count — they are answered on demand.
#[test]
fn toolsList_shouldStayUnderTheCharacterBudget() {
    let result = json!({ "tools": tool_list() }).to_string();
    let characters = result.chars().count();

    assert!(
        characters < 8_500,
        "tools/list is {characters} characters; the budget of docs/53 is 8 500"
    );
}
