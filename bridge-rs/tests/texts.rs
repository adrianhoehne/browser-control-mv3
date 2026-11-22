//! The machine check behind criterion 1 of `docs/54`: no umlaut survives in a sentence
//! the agent reads.
//!
//! Three files carry those sentences — `src/mcp/texts.rs` (the refusals),
//! `src/mcp/tools.rs` (the descriptions and the argument refusals) and
//! `src/mcp/help.rs` (the long manuals). Comments are
//! allowed to stay German, so a line whose first non-space characters are `//` is
//! skipped; everything else is a string, a constant or a signature, and a German word
//! there would be a sentence the agent reads.
//!
//! What this cannot catch is a German sentence without an umlaut ("Der Code ist
//! gescheitert."). The pinned assertions in `tests/mcp.rs` are the answer to that —
//! this test is the net below them, not a replacement.

// The case name carries the suite's spelling, like every other case in this tree.
#![allow(non_snake_case)]

const SOURCES: [(&str, &str); 3] = [
    ("src/mcp/texts.rs", include_str!("../src/mcp/texts.rs")),
    ("src/mcp/tools.rs", include_str!("../src/mcp/tools.rs")),
    // The `browser_help` manuals are agent-facing too; they are English already and
    // must stay that way.
    ("src/mcp/help.rs", include_str!("../src/mcp/help.rs")),
];

/// `ä ö ü ß` and their capitals. `Ü`/`Ö`/`Ä` matter for a sentence that starts with
/// one; they are as German as the lower-case forms.
const UMLAUTS: [char; 7] = ['ä', 'ö', 'ü', 'ß', 'Ä', 'Ö', 'Ü'];

#[test]
fn texts_shouldContainNoGermanUmlauts() {
    let mut offenders = Vec::new();

    for (name, source) in SOURCES {
        for (index, line) in source.lines().enumerate() {
            // Comments may stay German (`docs/54`, `## Ziel`).
            if line.trim_start().starts_with("//") {
                continue;
            }
            if let Some(found) = line.chars().find(|c| UMLAUTS.contains(c)) {
                offenders.push(format!("{name}:{}: {found} in {line}", index + 1));
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "German umlauts in agent-facing text:\n{}",
        offenders.join("\n")
    );
}
