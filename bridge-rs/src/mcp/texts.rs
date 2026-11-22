//! The visible texts of the tool layer, copied word for word from
//! `bridge/mcp.mjs` (`TOOL_TEXTS`).
//!
//! Copied, not formulated: the sentences are the contract the operator reads, and
//! `scripts/parity.sh` comparison 2 compares them character for character. The
//! German stays German here on purpose (`CONTRIBUTING.md`, `## Language`): what the
//! agent reports to the operator is the one exception to the English-code rule.
//!
//! The `*_WITH_MESSAGE` builders exist because the extension's own words are the
//! fact: a length, a browser rejection, a reason. Without a usable message the plain
//! sentence stands, so nothing here ever ends in a dangling colon.

/// `TOOL_TEXTS.UNKNOWN_TOOL`
pub fn unknown_tool(name: &str) -> String {
    format!(r#"Unbekanntes Tool: {name}"#)
}

/// `TOOL_TEXTS.INVALID_URL`
pub const INVALID_URL: &str = r#"Nur http:// und https:// sind erlaubt."#;

/// `TOOL_TEXTS.NO_EXTENSION`
pub const NO_EXTENSION: &str = r#"Keine Extension verbunden — Firefox mit der Extension läuft nicht oder die Verbindung ist getrennt."#;

/// `TOOL_TEXTS.NO_ANSWER`
pub const NO_ANSWER: &str = r#"Die Extension hat nicht geantwortet (Zeitüberschreitung)."#;

/// `TOOL_TEXTS.NO_AGENT_TAB`
pub const NO_AGENT_TAB: &str = r#"Kein Agenten-Tab — zuerst browser_navigate aufrufen."#;

/// `TOOL_TEXTS.TOO_MANY_TABS`
pub const TOO_MANY_TABS: &str = r#"Es sind schon fünf Agenten-Tabs offen — erst einen schließen."#;

/// `TOOL_TEXTS.PAGE_BUSY`
pub const PAGE_BUSY: &str = r#"Die Seite lädt noch — bitte gleich noch einmal versuchen."#;

/// `TOOL_TEXTS.NOT_READABLE`
pub const NOT_READABLE: &str = r#"Diese Seite kann die Extension nicht lesen (interne Seite oder Sonderformat)."#;

/// `TOOL_TEXTS.NOT_READABLE_WITH_KIND`
pub fn not_readable_with_kind(kind: &str, url: &str) -> String {
    format!(r#"Diese Seite kann die Extension nicht lesen (Typ: {kind}). Adresse: {url}"#)
}

/// `TOOL_TEXTS.NOT_READABLE_WITH_KIND_AND_TYPE`
pub fn not_readable_with_kind_and_type(kind: &str, content_type: &str, url: &str) -> String {
    format!(r#"Diese Seite kann die Extension nicht lesen (Typ: {kind}, Content-Type: {content_type}). Adresse: {url}"#)
}

/// `TOOL_TEXTS.NOT_READABLE_WITH_TYPE`
pub fn not_readable_with_type(content_type: &str, url: &str) -> String {
    format!(r#"Diese Seite kann die Extension nicht lesen (Content-Type: {content_type}). Adresse: {url}"#)
}

/// `TOOL_TEXTS.NOT_READABLE_WITH_URL`
pub fn not_readable_with_url(url: &str) -> String {
    format!(r#"Diese Seite kann die Extension nicht lesen. Adresse: {url}"#)
}

/// `TOOL_TEXTS.OFFSET_OUT_OF_RANGE`
pub const OFFSET_OUT_OF_RANGE: &str = r#"Der `offset` liegt hinter dem Ende des Textes."#;

/// `TOOL_TEXTS.OFFSET_OUT_OF_RANGE_WITH_MESSAGE`
pub fn offset_out_of_range_with_message(message: &str) -> String {
    format!(r#"Der `offset` liegt hinter dem Ende des Textes: {message}"#)
}

/// `TOOL_TEXTS.INVALID_READ_PARAMS`
pub const INVALID_READ_PARAMS: &str = r#"Der Parameter ist ungültig."#;

/// `TOOL_TEXTS.INVALID_READ_PARAMS_WITH_MESSAGE`
pub fn invalid_read_params_with_message(message: &str) -> String {
    format!(r#"Der Parameter ist ungültig: {message}"#)
}

/// `TOOL_TEXTS.FRAME_NOT_FOUND`
pub const FRAME_NOT_FOUND: &str = r#"Zu diesem `frame` passt kein Rahmen — mit browser_frames die Adressen prüfen."#;

/// `TOOL_TEXTS.FRAME_NOT_FOUND_WITH_COUNT`
pub fn frame_not_found_with_count(count: i64) -> String {
    format!(r#"Zu diesem `frame` passt kein Rahmen — mit browser_frames die Adressen prüfen (geantwortete Rahmen: {count})."#)
}

/// `TOOL_TEXTS.FRAME_AMBIGUOUS`
pub const FRAME_AMBIGUOUS: &str = r#"Mehrere Rahmen passen zu diesem `frame` — einen längeren Teilstring der Adresse angeben."#;

/// `TOOL_TEXTS.FRAME_AMBIGUOUS_WITH_CANDIDATES`
pub fn frame_ambiguous_with_candidates(candidates: &str) -> String {
    format!(r#"Mehrere Rahmen passen zu diesem `frame` — einen längeren Teilstring einer dieser Adressen angeben: {candidates}."#)
}

/// `TOOL_TEXTS.INVALID_SELECTOR`
pub fn invalid_selector(selector: &str) -> String {
    format!(r#"Der Selektor ist ungültig: {selector}."#)
}

/// `TOOL_TEXTS.NO_MATCH`
pub fn no_match(selector: &str) -> String {
    format!(r#"Kein Element passt zu: {selector}."#)
}

/// `TOOL_TEXTS.NOT_CLICKABLE`
pub fn not_clickable(selector: &str) -> String {
    format!(r#"Das Element ist nicht sichtbar oder deaktiviert: {selector}."#)
}

/// `TOOL_TEXTS.NOT_TYPEABLE`
pub fn not_typeable(selector: &str) -> String {
    format!(r#"Das Element ist kein beschreibbares Feld oder deaktiviert: {selector}."#)
}

/// `TOOL_TEXTS.PASSWORD_NOT_ALLOWED`
pub const PASSWORD_NOT_ALLOWED: &str = r#"Passwortfelder sind gesperrt. In den Optionen der Erweiterung freischalten."#;

/// `TOOL_TEXTS.INSPECT_NEEDS_FILTER`
pub const INSPECT_NEEDS_FILTER: &str = r#"browser_inspect braucht `selector` oder `text`."#;

/// `TOOL_TEXTS.INVALID_INSPECT_PARAMS`
pub const INVALID_INSPECT_PARAMS: &str = r#"Der Parameter ist ungültig."#;

/// `TOOL_TEXTS.STATUS_EXTENSION_FAILED`
pub fn status_extension_failed(code: &str) -> String {
    format!(r#"Die Extension konnte den Status nicht liefern (code={code})."#)
}

/// `TOOL_TEXTS.EVAL_NOT_ALLOWED`
pub const EVAL_NOT_ALLOWED: &str = r#"Code-Auswertung ist in den Einstellungen der Erweiterung nicht erlaubt — erst dort einschalten."#;

/// `TOOL_TEXTS.EVAL_FAILED`
pub const EVAL_FAILED: &str = r#"Der Code im Agenten-Tab ist gescheitert (Ausnahme oder Syntaxfehler)."#;

/// `TOOL_TEXTS.EVAL_FAILED_WITH_MESSAGE`
pub fn eval_failed_with_message(message: &str) -> String {
    format!(r#"Der Code im Agenten-Tab ist gescheitert: {message}"#)
}

/// `TOOL_TEXTS.EVAL_TIMEOUT`
pub const EVAL_TIMEOUT: &str = r#"Der Code hat nicht rechtzeitig geantwortet (Zeitüberschreitung nach 2 s)."#;

/// `TOOL_TEXTS.EVAL_RESULT_TOO_LARGE`
pub const EVAL_RESULT_TOO_LARGE: &str = r#"Das Ergebnis ist zu groß für eine Antwort (mehr als 10 000 Zeichen JSON) — weniger zurückgeben, zum Beispiel mit browser_inspect."#;

/// `TOOL_TEXTS.EVAL_RESULT_UNSERIALIZABLE`
pub const EVAL_RESULT_UNSERIALIZABLE: &str = r#"Das Ergebnis lässt sich nicht als JSON abbilden (etwa zirkulär) — nur einfache Werte zurückgeben."#;

/// `TOOL_TEXTS.INVALID_EVAL_PARAMS`
pub const INVALID_EVAL_PARAMS: &str = r#"Der Parameter ist ungültig."#;

/// `TOOL_TEXTS.SCREENSHOT_NOT_ALLOWED`
pub const SCREENSHOT_NOT_ALLOWED: &str = r#"Bildschirmfotos sind in den Einstellungen der Erweiterung nicht erlaubt — erst dort einschalten."#;

/// `TOOL_TEXTS.SCREENSHOT_FAILED`
pub const SCREENSHOT_FAILED: &str = r#"Der Agenten-Tab ließ sich nicht fotografieren."#;

/// `TOOL_TEXTS.SCREENSHOT_FAILED_WITH_MESSAGE`
pub fn screenshot_failed_with_message(message: &str) -> String {
    format!(r#"Der Agenten-Tab ließ sich nicht fotografieren: {message}"#)
}

/// `TOOL_TEXTS.SCREENSHOT_TOO_LARGE`
pub const SCREENSHOT_TOO_LARGE: &str = r#"Das Bild ist auch nach dem Verkleinern zu groß — es wird nicht geliefert; ein anderer Tab kann kleiner ausfallen."#;

/// `TOOL_TEXTS.SCREENSHOT_TOO_LARGE_WITH_MESSAGE`
pub fn screenshot_too_large_with_message(message: &str) -> String {
    format!(r#"Das Bild ist auch nach dem Verkleinern zu groß — es wird nicht geliefert; ein anderer Tab kann kleiner ausfallen. Messung: {message}"#)
}

/// `TOOL_TEXTS.INVALID_SCREENSHOT_PARAMS`
pub const INVALID_SCREENSHOT_PARAMS: &str = r#"Der Parameter ist ungültig."#;

/// `TOOL_TEXTS.TRANSCRIPT_FAILED`
pub const TRANSCRIPT_FAILED: &str = r#"Das Transkript ließ sich nicht lesen — nur YouTube-Watch-Seiten haben eines."#;

/// `TOOL_TEXTS.TRANSCRIPT_FAILED_WITH_MESSAGE`
pub fn transcript_failed_with_message(message: &str) -> String {
    format!(r#"Das Transkript ließ sich nicht lesen: {message}"#)
}

/// `TOOL_TEXTS.TRANSCRIPT_NEEDS_FOCUS`
pub const TRANSCRIPT_NEEDS_FOCUS: &str = r#"Der Tab ist nicht im Vordergrund, deshalb ist die Seite nicht gerendert — zuerst browser_focus aufrufen und es dann erneut versuchen."#;

/// `TOOL_TEXTS.TRANSCRIPT_NEEDS_FOCUS_WITH_MESSAGE`
pub fn transcript_needs_focus_with_message(message: &str) -> String {
    format!(r#"Die Seite ist nicht gerendert: {message}"#)
}

/// `TOOL_TEXTS.NO_TRANSCRIPT_PANEL`
pub const NO_TRANSCRIPT_PANEL: &str = r#"Keine Untertitelspur im Video gefunden — das Video hat keine, oder die Seite ist noch nicht fertig aufgebaut."#;

/// `TOOL_TEXTS.CALL_EXTENSION_FAILED`
pub fn call_extension_failed(code: &str) -> String {
    format!(r#"Die Extension konnte die Anfrage nicht ausführen (code={code})."#)
}

/// `TOOL_TEXTS.BRIDGE_FAILED`
pub const BRIDGE_FAILED: &str = r#"Die Bridge konnte den Status nicht lesen."#;

/// `browser_help` ohne `tool`: derselbe Ton wie die anderen Refusals.
pub fn help_asked_for_nothing() -> String {
    "browser_help erwartet `tool` — den Namen eines Werkzeugs, zum Beispiel `browser_read`.".to_string()
}

/// `browser_help` mit einem Argument, das es nicht kennt.
pub fn help_asked_for_something_else() -> String {
    "browser_help erwartet nur `tool`.".to_string()
}

/// `browser_help` mit einem Namen, den der Vertrag nicht kennt: die gueltigen dazu.
pub fn help_unknown_tool(name: &str, known: &[&str]) -> String {
    format!(
        "`{name}` ist kein Werkzeug dieses Vertrags. Gueltig sind: {}.",
        known.join(", ")
    )
}
