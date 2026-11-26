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
//! What it cannot do is written down in the two cases below: the schema is checked for
//! every tool, the return line only for the tools whose answer is pinned here.

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

/// The `## Returns` line against the fields the tool really answers, for the tools whose
/// answer is pinned in [`EXPECTED_RETURNS`].
///
/// Both directions again: a field the line leaves out (`truncated`, `via` for `click`,
/// `typed`/`submitted` for `type`) and a field the line invents (`settled` and `waitedMs`
/// for `type`, `videoId` and `language` for `transcript`) are the same mistake to a model
/// that plans its next call from this line.
#[test]
fn every_pinned_manual_returnLine_shouldNameExactlyTheAnsweredFields() {
    for (tool, expected) in EXPECTED_RETURNS {
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
