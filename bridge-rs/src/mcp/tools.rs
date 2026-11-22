//! The thirteen tools: their names, their schemas, the argument checks and the
//! `tools/call` implementations — ported from `bridge/mcp.mjs`.
//!
//! The table is the contract with the client, so it is copied and not composed:
//! `name`, `description` and `inputSchema` in exactly the order the template lists
//! them, because `scripts/parity.sh` comparison 1 compares the `tools/list` answer
//! character for character. `additionalProperties: false` is load-bearing: every call
//! refuses an undeclared argument, and the schema has to say the same thing before the
//! call happens.
//!
//! Every check runs *before* a request goes out, so a refused call costs no round trip
//! to the operator's browser. What the bridge does **not** check is deliberate: the
//! ranges (`limit`, `offset`, `maxChars`) and the `mode` enum belong to the extension,
//! which refuses them with `invalid_params` and names the field it refused. A second
//! opinion here would be a second list with its own drift.

use std::borrow::Cow;

use serde_json::{json, Map, Value};

use crate::mcp::failure::failure_text_for;
use crate::mcp::texts;
use crate::mcp::{error_message, is_json_object, result_message, RpcError, ToolContext};
use crate::protocol;

pub const BROWSER_STATUS: &str = "browser_status";
pub const BROWSER_NAVIGATE: &str = "browser_navigate";
pub const BROWSER_READ: &str = "browser_read";
pub const BROWSER_CLICK: &str = "browser_click";
pub const BROWSER_TYPE: &str = "browser_type";
pub const BROWSER_FOCUS: &str = "browser_focus";
pub const BROWSER_INSPECT: &str = "browser_inspect";
pub const BROWSER_OPEN_TAB: &str = "browser_open_tab";
pub const BROWSER_CLOSE_TAB: &str = "browser_close_tab";
pub const BROWSER_EVAL: &str = "browser_eval";
pub const BROWSER_SCREENSHOT: &str = "browser_screenshot";
pub const BROWSER_FRAMES: &str = "browser_frames";
pub const BROWSER_TRANSCRIPT: &str = "browser_transcript";

/// The wire name of the tab every tab-addressed tool may name. `tabId` is the name the
/// extension *answers* with; a second spelling here would travel to it as an argument
/// it silently ignores.
const TAB_ARGUMENT: &str = "tab";

/// The whole of the `focus`, `close_tab`, `screenshot` and `frames` schema: one
/// optional key.
const TAB_ARGUMENTS: [&str; 1] = [TAB_ARGUMENT];
/// The `status` schema: nothing at all, not even `tab` — it reports every window, so
/// a tab could only be ignored.
const NO_ARGUMENTS: [&str; 0] = [];
/// The two keys `browser_navigate` accepts, in the order the schema declares them.
const NAVIGATE_ARGUMENTS: [&str; 2] = ["url", TAB_ARGUMENT];
/// The one required key of `browser_open_tab`; it deliberately takes no `tab`: the tab
/// it would name does not exist until the call returns.
const OPEN_TAB_ARGUMENTS: [&str; 1] = ["url"];
/// The three keys `browser_click` accepts, in schema order.
const CLICK_ARGUMENTS: [&str; 3] = ["selector", "frame", TAB_ARGUMENT];
/// The five keys `browser_read` accepts, in the order the schema declares them. Also
/// the order the set ones are copied onto the wire, so the payload reads like the tool
/// description instead of like the caller's key order.
const READ_ARGUMENTS: [&str; 5] = ["offset", "maxChars", "mode", "frame", TAB_ARGUMENT];
/// The five keys `browser_type` accepts.
const TYPE_ARGUMENTS: [&str; 5] = ["selector", "text", "submit", "frame", TAB_ARGUMENT];
/// The six keys `browser_inspect` accepts, in schema order.
const INSPECT_ARGUMENTS: [&str; 6] = [
    "selector",
    "text",
    "limit",
    "includeHidden",
    "frame",
    TAB_ARGUMENT,
];
/// The three keys `browser_eval` accepts: the code body, the optional frame and the
/// optional tab.
const EVAL_ARGUMENTS: [&str; 3] = ["code", "frame", TAB_ARGUMENT];
/// The three keys `browser_transcript` accepts, in schema order.
const TRANSCRIPT_ARGUMENTS: [&str; 3] = ["offset", "maxChars", TAB_ARGUMENT];

/* ------------------------------------------------------------------- the table */

/// The tool table.
///
/// Built per `tools/list` instead of shared through a `static`: a `serde_json::Value`
/// cannot be frozen, and thirteen `json!` literals cost less than the `OnceLock` that
/// would hide them behind a lazy initialiser. `tools/list` is called once per client
/// session, not per tool call.
pub fn tool_list() -> Value {
    Value::Array(vec![
        json!({
            "name": BROWSER_STATUS,
            "description": BROWSER_STATUS_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            },
        }),
        json!({
            "name": BROWSER_NAVIGATE,
            "description": BROWSER_NAVIGATE_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                    },
                    "tab": {
                        "type": "integer",
                        "minimum": 1,
                    },
                },
                "required": [
                    "url",
                ],
                "additionalProperties": false,
            },
        }),
        json!({
            "name": BROWSER_READ,
            "description": BROWSER_READ_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                    },
                    "maxChars": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100000,
                    },
                    "mode": {
                        "type": "string",
                        "enum": [
                            "text",
                            "article",
                        ],
                    },
                    "frame": {
                        "type": "string",
                        "minLength": 1,
                    },
                    "tab": {
                        "type": "integer",
                        "minimum": 1,
                    },
                },
                "additionalProperties": false,
            },
        }),
        json!({
            "name": BROWSER_CLICK,
            "description": BROWSER_CLICK_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector": {
                        "type": "string",
                    },
                    "frame": {
                        "type": "string",
                        "minLength": 1,
                    },
                    "tab": {
                        "type": "integer",
                        "minimum": 1,
                    },
                },
                "required": [
                    "selector",
                ],
                "additionalProperties": false,
            },
        }),
        json!({
            "name": BROWSER_TYPE,
            "description": BROWSER_TYPE_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector": {
                        "type": "string",
                    },
                    "text": {
                        "type": "string",
                    },
                    "submit": {
                        "type": "boolean",
                    },
                    "frame": {
                        "type": "string",
                        "minLength": 1,
                    },
                    "tab": {
                        "type": "integer",
                        "minimum": 1,
                    },
                },
                "required": [
                    "selector",
                    "text",
                ],
                "additionalProperties": false,
            },
        }),
        json!({
            "name": BROWSER_FOCUS,
            "description": BROWSER_FOCUS_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab": {
                        "type": "integer",
                        "minimum": 1,
                    },
                },
                "additionalProperties": false,
            },
        }),
        json!({
            "name": BROWSER_INSPECT,
            "description": BROWSER_INSPECT_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector": {
                        "type": "string",
                    },
                    "text": {
                        "type": "string",
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 200,
                    },
                    "includeHidden": {
                        "type": "boolean",
                    },
                    "frame": {
                        "type": "string",
                        "minLength": 1,
                    },
                    "tab": {
                        "type": "integer",
                        "minimum": 1,
                    },
                },
                "additionalProperties": false,
            },
        }),
        json!({
            "name": BROWSER_OPEN_TAB,
            "description": BROWSER_OPEN_TAB_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                    },
                },
                "required": [
                    "url",
                ],
                "additionalProperties": false,
            },
        }),
        json!({
            "name": BROWSER_CLOSE_TAB,
            "description": BROWSER_CLOSE_TAB_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab": {
                        "type": "integer",
                        "minimum": 1,
                    },
                },
                "additionalProperties": false,
            },
        }),
        json!({
            "name": BROWSER_EVAL,
            "description": BROWSER_EVAL_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                    },
                    "frame": {
                        "type": "string",
                        "minLength": 1,
                    },
                    "tab": {
                        "type": "integer",
                        "minimum": 1,
                    },
                },
                "required": [
                    "code",
                ],
                "additionalProperties": false,
            },
        }),
        json!({
            "name": BROWSER_SCREENSHOT,
            "description": BROWSER_SCREENSHOT_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab": {
                        "type": "integer",
                        "minimum": 1,
                    },
                },
                "additionalProperties": false,
            },
        }),
        json!({
            "name": BROWSER_FRAMES,
            "description": BROWSER_FRAMES_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab": {
                        "type": "integer",
                        "minimum": 1,
                    },
                },
                "additionalProperties": false,
            },
        }),
        json!({
            "name": BROWSER_TRANSCRIPT,
            "description": BROWSER_TRANSCRIPT_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                    },
                    "maxChars": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100000,
                    },
                    "tab": {
                        "type": "integer",
                        "minimum": 1,
                    },
                },
                "additionalProperties": false,
            },
        }),
    ])
}

/* -------------------------------------------------------------- descriptions */

/// The descriptions are the part of the contract a client shows *before* the first
/// call, so they are copied word for word — including the backticks, the German quotes
/// and the two-space thousands. `test/mcp.rs` pins the whole table against
/// `scripts/parity/expected/1-initialize-and-tools-list.txt` byte for byte.
const BROWSER_STATUS_DESCRIPTION: &str =
    r#"Zeigt die Fenster und Tabs des Betreiber-Browsers im Default-Container, samt Verbindungszustand der Extension, und markiert den Agenten-Tab mit `agent: true`."#;

const BROWSER_NAVIGATE_DESCRIPTION: &str =
    r#"Öffnet eine http(s)-URL im Agenten-Tab des Betreiber-Browsers (Default-Container), wartet, bis die Seite geladen ist, und danach, bis sie sich beruhigt hat (höchstens 3 s); meldet `settled`/`waitedMs`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten."#;

const BROWSER_READ_DESCRIPTION: &str =
    r#"Liest den **aktuellen** Agenten-Tab und nimmt **keine** URL — vorher `browser_navigate`. Liest Titel, Adresse und den Text des Agenten-Tabs; `offset` überspringt so viele Zeichen des Textes (Default 0), `maxChars` begrenzt den Ausschnitt (Default 20 000, höchstens 100 000). `offset`/`maxChars` blättern durch den Text; `chars` und `totalChars` sagen, wo man steht. `via` sagt, ob sichtbarer Text oder Textinhalt. `mode: article` liest nur den Artikelkörper — ohne Navigation, Fußzeile und Cookie-Banner. Wartet vorher, bis sich die Seite beruhigt hat (höchstens 3 s), und meldet `settled`/`waitedMs`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten."#;

const BROWSER_CLICK_DESCRIPTION: &str =
    r#"Arbeitet auf dem **aktuellen** Agenten-Tab und nimmt **keine** URL — vorher `browser_navigate`. Klickt das erste Element, das dem CSS-Selektor entspricht, im Agenten-Tab, wartet, bis sich die Seite beruhigt hat (höchstens 3 s), und liefert den Seitentext danach (auf 20 000 Zeichen gekürzt); meldet `settled`/`waitedMs`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten."#;

const BROWSER_TYPE_DESCRIPTION: &str =
    r#"Arbeitet auf dem **aktuellen** Agenten-Tab und nimmt **keine** URL — vorher `browser_navigate`. Schreibt Text in das Feld, das dem CSS-Selektor entspricht, sendet optional Enter und liefert den Seitentext danach (auf 20 000 Zeichen gekürzt). Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten."#;

const BROWSER_FOCUS_DESCRIPTION: &str =
    r#"Holt den Agenten-Tab nach vorn und sein Fenster in den Vordergrund; die Seite wird dabei nicht verändert, und `focused` kommt aus einer Abfrage nach dem Fokussieren. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten."#;

const BROWSER_INSPECT_DESCRIPTION: &str =
    r#"Arbeitet auf dem **aktuellen** Agenten-Tab und nimmt **keine** URL — vorher `browser_navigate`. Listet die Elemente des Agenten-Tabs auf (per CSS-Selektor und/oder Textsuche) mit Tag, id, class, Link, sichtbarem Text, Sichtbarkeit und einem fertigen Selektor zum Weiterverwenden. `my-card >>> button` springt rechts vom `>>>` in den offenen Schattenbaum von `my-card` (mehrere Stufen erlaubt); jedes Glied ist ein einfacher Selektor — Typ, `#id`, `.class`, `[attr="wert"]` oder `:nth-of-type(n)`; geschlossene Schattenbäume bleiben unerreichbar, und ohne `>>>` ändert sich nichts. Ändert nichts an der Seite. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten."#;

const BROWSER_OPEN_TAB_DESCRIPTION: &str =
    r#"Öffnet einen weiteren Agenten-Tab im Default-Container (höchstens fünf) und liefert `tabId`, `url` und `title`. Wartet, bis die Seite geladen ist, aber nicht auf Ruhe — ein `browser_read` danach soll nicht `page_busy` kosten."#;

const BROWSER_CLOSE_TAB_DESCRIPTION: &str =
    r#"Schließt einen Agenten-Tab und entfernt ihn aus der Liste; ohne `tab` den zuletzt benutzten. Liefert `tabId` und `closed`."#;

const BROWSER_EVAL_DESCRIPTION: &str =
    r#"Wertet Code im **aktuellen** Agenten-Tab aus und nimmt **keine** URL — vorher `browser_navigate`. Wertet Code im Seitenkontext des Agenten-Tabs aus und liefert das Ergebnis als JSON; Code darf die Seite ändern, auch Passwortfelder füllen. `code` läuft als Funktionsrumpf: Das Ergebnis kommt mit `return` zurück, ohne `return` ist es `null`. Nur möglich, wenn „Code-Auswertung erlauben" in den Einstellungen der Erweiterung eingeschaltet ist — sonst `eval_not_allowed`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten."#;

const BROWSER_SCREENSHOT_DESCRIPTION: &str =
    r#"Arbeitet auf dem **aktuellen** Agenten-Tab und nimmt **keine** URL — vorher `browser_navigate`. Fotografiert den sichtbaren Ausschnitt des Agenten-Tabs und liefert das Bild als MCP-Bildinhalt (höchstens 3 MiB; PNG, bei Überschreiten verkleinert und als JPEG neu kodiert). Die Zahlen dazu — `format`, `width`, `height`, `bytes` und `scaled` — stehen als Textblock daneben. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten."#;

const BROWSER_FRAMES_DESCRIPTION: &str =
    r#"Listet die Rahmen (iframes) des Agenten-Tabs mit ihrer Adresse; `frame` bei den anderen Werkzeugen nimmt einen Teilstring davon. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten."#;

const BROWSER_TRANSCRIPT_DESCRIPTION: &str =
    r#"Liest das Transkript des YouTube-Video-Tabs als Segmente mit Zeitstempel und Text aus der Untertitelspur des Videos `requestedLanguage` nennt die gewählte Spur, `deliveredLanguage` die Sprache der gelieferten Spurendatei, `source` den Ort, an dem das Datenmodell des Players gefunden wurde. `offset` überspringt so viele Zeichen der verketteten Segmenttexte (Default 0), `maxChars` begrenzt den Ausschnitt (Default 20 000, höchstens 100 000); `segments` enthält genau die Segmente dieses Fensters, `chars` und `totalChars` sagen, wo man steht, und `truncated` blättert weiter. Der Tab muss im Vordergrund sein — vorher browser_focus aufrufen, sonst antwortet das Werkzeug `transcript_needs_focus`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten."#;

/* ----------------------------------------------------------------- dispatch */

/// Answers a `tools/call` request.
///
/// The order of the checks comes from the template: a request without a usable `name`
/// is a malformed *request* (`-32602`), an unknown `name` is a tool result the client
/// should display, and only then are the arguments judged — per tool, because each tool
/// judges its own.
pub async fn call_tool(id: &Value, params: Option<&Value>, context: &ToolContext) -> Value {
    let name = params
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty());

    let Some(name) = name else {
        return error_message(id, RpcError::INVALID_PARAMS);
    };

    match name {
        BROWSER_STATUS => {
            allow_list_tool(
                id,
                params,
                context,
                BROWSER_STATUS,
                protocol::methods::STATUS,
                &NO_ARGUMENTS,
                AnswerShape::Text,
            )
            .await
        }
        BROWSER_FOCUS => {
            allow_list_tool(
                id,
                params,
                context,
                BROWSER_FOCUS,
                protocol::methods::FOCUS,
                &TAB_ARGUMENTS,
                AnswerShape::Text,
            )
            .await
        }
        BROWSER_CLOSE_TAB => {
            allow_list_tool(
                id,
                params,
                context,
                BROWSER_CLOSE_TAB,
                protocol::methods::CLOSE_TAB,
                &TAB_ARGUMENTS,
                AnswerShape::Text,
            )
            .await
        }
        // A picture is not JSON text, it is an image content block with the numbers
        // beside it — the only difference to the other four allow-list tools.
        BROWSER_SCREENSHOT => {
            allow_list_tool(
                id,
                params,
                context,
                BROWSER_SCREENSHOT,
                protocol::methods::SCREENSHOT,
                &TAB_ARGUMENTS,
                AnswerShape::Screenshot,
            )
            .await
        }
        // The frame *addresses* are the answer, and the filter that uses them is a
        // parameter of the other tools — so no extra knob here.
        BROWSER_FRAMES => {
            allow_list_tool(
                id,
                params,
                context,
                BROWSER_FRAMES,
                protocol::methods::FRAMES,
                &TAB_ARGUMENTS,
                AnswerShape::Text,
            )
            .await
        }
        BROWSER_NAVIGATE => navigate_tool(id, params, context).await,
        BROWSER_OPEN_TAB => open_tab_tool(id, params, context).await,
        BROWSER_READ => read_tool(id, params, context).await,
        BROWSER_CLICK => click_tool(id, params, context).await,
        BROWSER_TYPE => type_tool(id, params, context).await,
        BROWSER_INSPECT => inspect_tool(id, params, context).await,
        BROWSER_EVAL => eval_tool(id, params, context).await,
        BROWSER_TRANSCRIPT => transcript_tool(id, params, context).await,
        _ => tool_error(id, &texts::unknown_tool(name)),
    }
}

/* ------------------------------------------------------------- the tools */

/// The two answer shapes of the allow-list tools. `Screenshot` is the only one that is
/// not indented JSON, and it validates its result instead of throwing: a formatter that
/// panicked would answer a sentence about the bridge for a fault on the extension's
/// side.
#[derive(Debug, Clone, Copy)]
enum AnswerShape {
    Text,
    Screenshot,
}

/// One `tools/call` for a tool whose whole argument rule is a short allow-list: `status`
/// allows nothing at all, `focus`, `close_tab`, `screenshot` and `frames` allow exactly
/// `tab`. They differ only in the request they send and in the shape of their answer, so
/// a second copy of check-then-ask would be a second place to fix.
///
/// Both checks come first: a call that would be refused must not reach the extension at
/// all. The key set is judged before the type, because a tool that declares no `tab` has
/// to answer its own sentence even when the value would be an integer.
async fn allow_list_tool(
    id: &Value,
    params: Option<&Value>,
    context: &ToolContext,
    name: &'static str,
    method: &'static str,
    allowed_arguments: &[&str],
    answer: AnswerShape,
) -> Value {
    let args = raw_arguments(params);
    if !has_no_arguments(args, allowed_arguments) {
        return tool_error(id, unexpected_arguments(name));
    }
    if allowed_arguments.contains(&TAB_ARGUMENT) && !has_declared_tab_argument(args) {
        return error_message(id, RpcError::INVALID_PARAMS);
    }

    let payload = with_optional_tab(Map::new(), tab_field(args));
    match context.hub.request(method, Value::Object(payload)).await {
        Ok(result) => answer_message(id, &result, answer),
        Err(error) => tool_error(id, &failure_text_for(name, &error, None)),
    }
}

/// `tools/call` for `browser_navigate`.
///
/// A missing or non-string `url` is a malformed request (`-32602`): the schema declares
/// it required, so the client broke the contract before the tool ever ran. A `url` that
/// is not http(s) is a *tool* error instead — the message is for the human, and it is
/// decided here, before any request reaches the extension.
async fn navigate_tool(id: &Value, params: Option<&Value>, context: &ToolContext) -> Value {
    let args = raw_arguments(params);
    let Some(url) = args
        .and_then(|args| args.get("url"))
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return error_message(id, RpcError::INVALID_PARAMS);
    };

    if !has_declared_tab_argument(args) {
        return error_message(id, RpcError::INVALID_PARAMS);
    }
    if !declares_only(args, &NAVIGATE_ARGUMENTS) {
        return tool_error(id, unexpected_arguments(BROWSER_NAVIGATE));
    }
    if !is_http_url(&url) {
        return tool_error(id, texts::INVALID_URL);
    }

    let mut payload = Map::new();
    payload.insert("url".to_string(), Value::String(url));
    let payload = with_optional_tab(payload, tab_field(args));
    match context
        .hub
        .request(protocol::methods::NAVIGATE, Value::Object(payload))
        .await
    {
        Ok(result) => text_result_message(id, &result),
        // No `params`: navigate's sentences quote no request field.
        Err(error) => tool_error(id, &failure_text_for(BROWSER_NAVIGATE, &error, None)),
    }
}

/// `tools/call` for `browser_open_tab`: `navigate` without a tab to fall back on, because
/// the tab this call addresses does not exist until the call returns.
async fn open_tab_tool(id: &Value, params: Option<&Value>, context: &ToolContext) -> Value {
    let args = raw_arguments(params);
    let Some(url) = args
        .and_then(|args| args.get("url"))
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return error_message(id, RpcError::INVALID_PARAMS);
    };

    if !declares_only(args, &OPEN_TAB_ARGUMENTS) {
        return tool_error(id, unexpected_arguments(BROWSER_OPEN_TAB));
    }
    if !is_http_url(&url) {
        return tool_error(id, texts::INVALID_URL);
    }

    let payload = json!({ "url": url });
    match context
        .hub
        .request(protocol::methods::OPEN_TAB, payload)
        .await
    {
        Ok(result) => text_result_message(id, &result),
        Err(error) => tool_error(id, &failure_text_for(BROWSER_OPEN_TAB, &error, None)),
    }
}

/// `tools/call` for `browser_read`: a window, a `mode`, an optional `frame` and `tab`.
///
/// Two checks before the request leaves, in the order `inspect` established: the declared
/// *types* (`-32602`, because the schema states them) and the keys the schema forbids (the
/// tool's own sentence). The enum and the ranges are **not** checked here: `"text"`/
/// `"article"`, 1 … 100 000 and "0 or more" belong to the extension, which refuses
/// anything else with `invalid_params` and names the field.
async fn read_tool(id: &Value, params: Option<&Value>, context: &ToolContext) -> Value {
    let args = arguments_or_empty(params);
    if !has_declared_read_argument_types(&args) {
        return error_message(id, RpcError::INVALID_PARAMS);
    }
    if !declares_only_object(args.as_object(), &READ_ARGUMENTS) {
        return tool_error(id, unexpected_arguments(BROWSER_READ));
    }

    // Only the keys the caller actually set, in schema order: the extension fills
    // `offset`, `maxChars` and `mode` with its defaults, and a request that named them
    // would put a window on the wire — and into the hub's log line — that nobody asked
    // for.
    let request_params = declared_keys_of(&args, &READ_ARGUMENTS);
    match context
        .hub
        .request(protocol::methods::READ, Value::Object(request_params.clone()))
        .await
    {
        Ok(result) => text_result_message(id, &result),
        Err(error) => tool_error(
            id,
            &failure_text_for(BROWSER_READ, &error, Some(&request_params)),
        ),
    }
}

/// `tools/call` for `browser_click`.
///
/// Same order as `navigate`: a missing or non-string `selector` is a malformed request
/// (`-32602`), because the schema declares it required. An *empty* string is not
/// malformed — it goes to the page, where `querySelector` decides and answers
/// `invalid_selector`. The bridge has no opinion on selector syntax.
async fn click_tool(id: &Value, params: Option<&Value>, context: &ToolContext) -> Value {
    let args = arguments_or_empty(params);
    let Some(selector) = args
        .get("selector")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return error_message(id, RpcError::INVALID_PARAMS);
    };

    // The frame filter of spec 26: type only, like every other key — the `minLength: 1`
    // of the schema is the contract, and the empty substring travels to the extension,
    // which refuses it with `invalid_params` before anything is injected.
    if !is_absent_or(&args, "frame", Value::is_string) {
        return error_message(id, RpcError::INVALID_PARAMS);
    }
    if !has_declared_tab_argument(Some(&args)) {
        return error_message(id, RpcError::INVALID_PARAMS);
    }
    if !declares_only_object(args.as_object(), &CLICK_ARGUMENTS) {
        return tool_error(id, unexpected_arguments(BROWSER_CLICK));
    }

    // `frame` is copied by hand because the payload is built by hand: a key the schema
    // declares but this line forgets would fall out silently — no error, no sentence,
    // just a click that quietly lands in the main frame.
    let mut payload = Map::new();
    payload.insert("selector".to_string(), Value::String(selector));
    if let Some(frame) = args.get("frame") {
        payload.insert("frame".to_string(), frame.clone());
    }
    let request_params = with_optional_tab(payload, tab_field(Some(&args)));
    match context
        .hub
        .request(protocol::methods::CLICK, Value::Object(request_params.clone()))
        .await
    {
        Ok(result) => text_result_message(id, &result),
        // The request is what the sentences are built from: the extension answers a
        // code, and the sentence needs the selector it refused.
        Err(error) => tool_error(
            id,
            &failure_text_for(BROWSER_CLICK, &error, Some(&request_params)),
        ),
    }
}

/// `tools/call` for `browser_type`.
///
/// Four checks before the request leaves, in this order: `selector` and `text` must be
/// strings (`-32602`; `""` is a string, so emptying a field stays allowed), `submit` may
/// be absent but must be a boolean if present, `frame` may be absent but must be a string
/// if present, and every other key is an argument the schema forbids.
///
/// The `submit` check is the interesting one: without it a `"true"` would travel to the
/// extension, come back as a refusal, and the operator would read "the extension could
/// not run this request" — blaming the wrong side of the wire for a client mistake.
async fn type_tool(id: &Value, params: Option<&Value>, context: &ToolContext) -> Value {
    let args = arguments_or_empty(params);
    let (Some(selector), Some(text)) = (
        args.get("selector").and_then(Value::as_str),
        args.get("text").and_then(Value::as_str),
    ) else {
        return error_message(id, RpcError::INVALID_PARAMS);
    };
    if !is_absent_or(&args, "submit", Value::is_boolean) {
        return error_message(id, RpcError::INVALID_PARAMS);
    }
    if !is_absent_or(&args, "frame", Value::is_string) {
        return error_message(id, RpcError::INVALID_PARAMS);
    }
    if !has_declared_tab_argument(Some(&args)) {
        return error_message(id, RpcError::INVALID_PARAMS);
    }
    if !declares_only_object(args.as_object(), &TYPE_ARGUMENTS) {
        return tool_error(id, unexpected_arguments(BROWSER_TYPE));
    }

    // The missing `submit` means "no Enter", and it is filled in here rather than in the
    // extension: the wire format documents `false` as the default, and a request that
    // names all three keys is easier to read in a log.
    let mut payload = Map::new();
    payload.insert("selector".to_string(), Value::String(selector.to_string()));
    payload.insert("text".to_string(), Value::String(text.to_string()));
    payload.insert(
        "submit".to_string(),
        Value::Bool(matches!(args.get("submit"), Some(Value::Bool(true)))),
    );
    if let Some(frame) = args.get("frame") {
        payload.insert("frame".to_string(), frame.clone());
    }
    let request_params = with_optional_tab(payload, tab_field(Some(&args)));
    match context
        .hub
        .request(protocol::methods::TYPE, Value::Object(request_params.clone()))
        .await
    {
        Ok(result) => text_result_message(id, &result),
        Err(error) => tool_error(
            id,
            &failure_text_for(BROWSER_TYPE, &error, Some(&request_params)),
        ),
    }
}

/// `tools/call` for `browser_inspect`.
///
/// Three checks before the request leaves: the declared type of every key (`-32602`,
/// because the schema states it), the keys the schema forbids (the tool's own sentence),
/// and the one rule the schema cannot state — at least one of `selector`/`text`.
async fn inspect_tool(id: &Value, params: Option<&Value>, context: &ToolContext) -> Value {
    let args = arguments_or_empty(params);
    if !has_declared_inspect_argument_types(&args) {
        return error_message(id, RpcError::INVALID_PARAMS);
    }
    if !declares_only_object(args.as_object(), &INSPECT_ARGUMENTS) {
        return tool_error(id, unexpected_arguments(BROWSER_INSPECT));
    }
    // Refused here rather than by the extension: the sentence can name the two
    // arguments, and a call with nothing to search for must not reach the page.
    if args.get("selector").is_none() && args.get("text").is_none() {
        return tool_error(id, texts::INSPECT_NEEDS_FILTER);
    }

    let request_params = declared_keys_of(&args, &INSPECT_ARGUMENTS);
    match context
        .hub
        .request(protocol::methods::INSPECT, Value::Object(request_params.clone()))
        .await
    {
        Ok(result) => text_result_message(id, &result),
        Err(error) => tool_error(
            id,
            &failure_text_for(BROWSER_INSPECT, &error, Some(&request_params)),
        ),
    }
}

/// `tools/call` for `browser_eval`: the code body, an optional `frame` and `tab`.
///
/// What is *not* checked here is deliberate: the length of the code and the switch behind
/// it belong to the extension, and a second opinion in the bridge would be a rule with its
/// own drift. An empty code travels too, and comes back as the extension's
/// `invalid_params` with its own sentence.
async fn eval_tool(id: &Value, params: Option<&Value>, context: &ToolContext) -> Value {
    let args = arguments_or_empty(params);
    if !has_declared_eval_argument_types(&args) {
        return error_message(id, RpcError::INVALID_PARAMS);
    }
    if !declares_only_object(args.as_object(), &EVAL_ARGUMENTS) {
        return tool_error(id, unexpected_arguments(BROWSER_EVAL));
    }

    let mut payload = Map::new();
    payload.insert(
        "code".to_string(),
        args.get("code").cloned().unwrap_or(Value::Null),
    );
    if let Some(frame) = args.get("frame") {
        payload.insert("frame".to_string(), frame.clone());
    }
    let request_params = with_optional_tab(payload, tab_field(Some(&args)));
    match context
        .hub
        .request(protocol::methods::EVAL, Value::Object(request_params.clone()))
        .await
    {
        Ok(result) => text_result_message(id, &result),
        Err(error) => tool_error(
            id,
            &failure_text_for(BROWSER_EVAL, &error, Some(&request_params)),
        ),
    }
}

/// `tools/call` for `browser_transcript`: the window (`offset`, `maxChars`), an optional
/// `tab`.
///
/// The same split as `read`, because it is the same window: the declared *types* are the
/// bridge's (`-32602`), the *ranges* are the extension's.
async fn transcript_tool(id: &Value, params: Option<&Value>, context: &ToolContext) -> Value {
    let args = arguments_or_empty(params);
    if !has_declared_transcript_argument_types(&args) {
        return error_message(id, RpcError::INVALID_PARAMS);
    }
    if !declares_only_object(args.as_object(), &TRANSCRIPT_ARGUMENTS) {
        return tool_error(id, unexpected_arguments(BROWSER_TRANSCRIPT));
    }

    let request_params = declared_keys_of(&args, &TRANSCRIPT_ARGUMENTS);
    match context
        .hub
        .request(
            protocol::methods::TRANSCRIPT,
            Value::Object(request_params.clone()),
        )
        .await
    {
        Ok(result) => text_result_message(id, &result),
        Err(error) => tool_error(
            id,
            &failure_text_for(BROWSER_TRANSCRIPT, &error, Some(&request_params)),
        ),
    }
}

/* --------------------------------------------------------- declared types */

/// The types the `browser_read` schema declares, checked key by key.
///
/// Absent is not wrong: every key is optional. The two window parameters are only required
/// to be an *integer* — where their ranges end is the extension's business. `mode` is only
/// required to be a *string*, never one of the two values the schema lists.
fn has_declared_read_argument_types(args: &Value) -> bool {
    if !is_json_object(args) {
        return false;
    }
    if !is_absent_or(args, "offset", is_integer) {
        return false;
    }
    if !is_absent_or(args, "maxChars", is_integer) {
        return false;
    }
    if !is_absent_or(args, "mode", Value::is_string) {
        return false;
    }
    if !is_absent_or(args, "frame", Value::is_string) {
        return false;
    }
    has_declared_tab_argument(Some(args))
}

/// The types the `browser_inspect` schema declares. `limit` is only required to be an
/// *integer* — where its range ends is the extension's business.
fn has_declared_inspect_argument_types(args: &Value) -> bool {
    if !is_json_object(args) {
        return false;
    }
    if !is_absent_or(args, "selector", Value::is_string) {
        return false;
    }
    if !is_absent_or(args, "text", Value::is_string) {
        return false;
    }
    if !is_absent_or(args, "limit", is_integer) {
        return false;
    }
    if !is_absent_or(args, "includeHidden", Value::is_boolean) {
        return false;
    }
    if !is_absent_or(args, "frame", Value::is_string) {
        return false;
    }
    has_declared_tab_argument(Some(args))
}

/// The types the `browser_transcript` schema declares: two keys fewer than `read` — no
/// `mode`, no `frame` — and the same rule for the window.
fn has_declared_transcript_argument_types(args: &Value) -> bool {
    if !is_json_object(args) {
        return false;
    }
    if !is_absent_or(args, "offset", is_integer) {
        return false;
    }
    if !is_absent_or(args, "maxChars", is_integer) {
        return false;
    }
    has_declared_tab_argument(Some(args))
}

/// The one required key of the `browser_eval` schema, checked for its type.
///
/// A missing `code` lands in the `false` as well: the schema requires it, and a call
/// without it has nothing to run — the protocol error is the honest answer, not a sentence
/// about a body nobody sent.
fn has_declared_eval_argument_types(args: &Value) -> bool {
    if !is_json_object(args) {
        return false;
    }
    if !args.get("code").is_some_and(Value::is_string) {
        return false;
    }
    if !is_absent_or(args, "frame", Value::is_string) {
        return false;
    }
    has_declared_tab_argument(Some(args))
}

/* ------------------------------------------------------------------ helpers */

/// `params.arguments` as the caller sent it.
///
/// Three shapes stay distinct, exactly like `undefined`, `null` and a value in the
/// template: absent (`None`), present but `null` (`Some(&Value::Null)`) and a value.
/// `{"arguments": null}` is a client that wanted to send something.
fn raw_arguments(params: Option<&Value>) -> Option<&Value> {
    params.and_then(|params| params.get("arguments"))
}

/// `params.arguments ?? {}` — the shape the six tools with a hand-written payload use:
/// absent and `null` are the same thing, and everything else is judged as it arrived
/// (a string is not an object, so the type check refuses it).
fn arguments_or_empty(params: Option<&Value>) -> Cow<'_, Value> {
    match raw_arguments(params) {
        Some(value) if !value.is_null() => Cow::Borrowed(value),
        _ => Cow::Owned(Value::Object(Map::new())),
    }
}

/// Missing arguments and `{}` are the same thing; anything else is not.
///
/// `null` is not `{}`: `typeof null === "object"` is a mistake this port does not inherit.
/// `allowed_arguments` is what the tool's schema declares: nothing for `status`, exactly
/// `tab` for `focus`, `close_tab`, `screenshot` and `frames`.
fn has_no_arguments(args: Option<&Value>, allowed_arguments: &[&str]) -> bool {
    match args {
        None => true,
        Some(value) => match value.as_object() {
            Some(object) => !has_undeclared_argument(object, allowed_arguments),
            None => false,
        },
    }
}

/// True when the arguments carry no key beyond `declared_arguments` — the argument-side
/// half of `additionalProperties: false`.
///
/// Only an object can carry keys, so a non-object answers `true` here; every caller has
/// proven the shape before it asks (absent arguments, a required key that was a string).
fn declares_only(args: Option<&Value>, declared_arguments: &[&str]) -> bool {
    declares_only_object(args.and_then(Value::as_object), declared_arguments)
}

fn declares_only_object(
    args: Option<&Map<String, Value>>,
    declared_arguments: &[&str],
) -> bool {
    match args {
        None => true,
        Some(object) => !has_undeclared_argument(object, declared_arguments),
    }
}

/// True when `args` carries a key its schema does not declare.
fn has_undeclared_argument(args: &Map<String, Value>, declared_arguments: &[&str]) -> bool {
    args.keys()
        .any(|key| !declared_arguments.contains(&key.as_str()))
}

/// `tab` is optional everywhere it appears; when it is there it must be the positive
/// integer the schema declares. `null` and a string are wrong types, not "absent": the
/// extension answers `invalid_params` for both, and a wrong call is worth refusing before
/// it costs a round trip.
fn has_declared_tab_argument(args: Option<&Value>) -> bool {
    match tab_field(args) {
        None => true,
        Some(tab) => is_integer(tab) && number_at_least(tab, 1.0),
    }
}

/// `args?.tab` — present even when it is `null`, because the difference between "not sent"
/// and "sent as `null`" is the difference between accepted and `-32602`.
fn tab_field(args: Option<&Value>) -> Option<&Value> {
    args.and_then(|args| args.get(TAB_ARGUMENT))
}

/// The payload with `tab` added when — and only when — the caller sent one.
///
/// Sending `tab: null` would put the key on the wire, and the hub's `read tab=…` line would
/// then claim a tab nobody asked for.
fn with_optional_tab(mut params: Map<String, Value>, tab: Option<&Value>) -> Map<String, Value> {
    if let Some(tab) = tab {
        params.insert(TAB_ARGUMENT.to_string(), tab.clone());
    }
    params
}

/// Only the keys the caller actually set, in schema order.
fn declared_keys_of(args: &Value, declared_arguments: &[&str]) -> Map<String, Value> {
    let mut params = Map::new();
    for key in declared_arguments {
        if let Some(value) = args.get(*key) {
            params.insert((*key).to_string(), value.clone());
        }
    }
    params
}

/// Absent is not wrong: every key of these schemas is optional, and only the keys the
/// caller set are judged.
fn is_absent_or(args: &Value, key: &str, check: fn(&Value) -> bool) -> bool {
    match args.get(key) {
        None => true,
        Some(value) => check(value),
    }
}

/// `Number.isInteger`: a number with no fractional part.
///
/// `serde_json` keeps a `42.0` from the wire as a float while Node's `JSON.parse` turns it
/// into `42` — the one number shape the two differ in, and `docs/38`,
/// `### What could go wrong` names it as a known gap instead of hiding it here. Which is why
/// the sentence builders ask this function rather than `Value::as_i64`: `3.0` is an integer
/// to `Number.isInteger` too.
pub(crate) fn is_integer(value: &Value) -> bool {
    match value {
        Value::Number(number) => {
            number.as_i64().is_some()
                || number
                    .as_f64()
                    .is_some_and(|float| float.is_finite() && float.fract() == 0.0)
        }
        _ => false,
    }
}

/// `value >= bound` for a number, `false` for everything else.
fn number_at_least(value: &Value, bound: f64) -> bool {
    value.as_f64().is_some_and(|number| number >= bound)
}

/// The same rule the extension applies, checked a second time before the request leaves the
/// bridge — the double floor, not one shared function reached through the wire.
///
/// A subset of `new URL()` on purpose: the scheme must be `http` or `https` and a host must
/// follow it. What `new URL()` additionally *repairs* (`http:example.org`, `http:///x`) is
/// refused here; the extension's own check is the second floor that catches what this one
/// lets through, and a refusal on this side cannot deliver a request the operator did not
/// want. What it *accepts*, though, is accepted here too: a `"\thttps://example.org/"` the
/// browser navigates to must not be refused by the bridge that sent it.
///
/// One gap stays open by decision, not by accident: `http://user@:80` has no host after its
/// userinfo, so `new URL()` throws where this function sees the non-empty `user@:80`. Closing
/// it means implementing WHATWG host parsing — that is the extension's job, not the floor's.
fn is_http_url(value: &str) -> bool {
    let value = without_url_whitespace(value);
    let Some((scheme, rest)) = value.split_once(':') else {
        return false;
    };
    if !is_url_scheme(scheme) {
        return false;
    }
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    // For a special scheme the parser skips any number of `/` and `\`, then needs a host.
    let trimmed = rest.trim_start_matches(['/', '\\']);
    let host = trimmed.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty()
}

/// `new URL()`'s two pre-parse steps, in its order: leading and trailing C0 controls and
/// spaces are dropped, then every tab and newline is removed wherever it sits. Without them
/// this function refused `" https://example.org/"` and `"\thttps://example.org/"`, both of
/// which the browser accepts and navigates to — a bridge stricter than the browser is a
/// bridge that refuses calls the operator can see working everywhere else.
///
/// The original string is what travels to the extension (`navigateTool` does the same):
/// trimming is for the check, and the browser repeats it when it parses the URL.
fn without_url_whitespace(value: &str) -> String {
    value
        .trim_matches(|character: char| character <= ' ')
        .replace(['\t', '\n', '\r'], "")
}

/// RFC 3986's scheme: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`.
fn is_url_scheme(scheme: &str) -> bool {
    let mut characters = scheme.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    first.is_ascii_alphabetic()
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        })
}

/* ------------------------------------------------------------- answers */

/// A successful result as the indented JSON text block every tool answers with.
fn text_result_message(id: &Value, result: &Value) -> Value {
    result_message(
        id,
        json!({ "content": [{ "type": "text", "text": indented(result) }] }),
    )
}

/// The answer of `browser_screenshot`: the metadata as text, then the picture as an image
/// block.
///
/// Text first, image second — that order is the contract: a client that renders only the
/// first block still learns what the picture is, and one that renders both reads the
/// numbers above the picture instead of below it.
///
/// The base64 lives in the image block **only**: a copy in the text block would be the same
/// payload twice, and the metadata is what a model can read without decoding anything.
///
/// Returns, never panics: a formatter that threw would be reported as `BRIDGE_FAILED`, a
/// sentence about the bridge for a problem in the extension's answer. A `format` that is
/// neither `png` nor `jpeg` is our own bug or a wire that drifted, and the generic
/// screenshot sentence is the honest answer to it; guessing a MIME type would ship a lie.
fn screenshot_result_message(id: &Value, result: &Value) -> Value {
    let base64 = result.get("base64").and_then(Value::as_str);
    let format = result.get("format").and_then(Value::as_str);
    let (Some(base64), Some(mime_type)) = (base64, format.and_then(mime_type_for)) else {
        return tool_error(id, texts::SCREENSHOT_FAILED);
    };

    // The metadata keeps the order and the count the extension answered with, minus the
    // picture: a field added there arrives here without an edit.
    let mut metadata = result.as_object().cloned().unwrap_or_default();
    metadata.remove("base64");

    result_message(
        id,
        json!({
            "content": [
                { "type": "text", "text": indented(&Value::Object(metadata)) },
                { "type": "image", "mimeType": mime_type, "data": base64 },
            ],
        }),
    )
}

/// A tool result that failed: the sentence as text, flagged `isError`, and no JSON-RPC
/// error — the human should read the sentence, not a protocol code.
fn tool_error(id: &Value, text: &str) -> Value {
    result_message(
        id,
        json!({ "content": [{ "type": "text", "text": text }], "isError": true }),
    )
}

/// `JSON.stringify(value, null, 2)`: two spaces, and the keys in insertion order.
fn indented(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("a JSON value always serialises")
}

/// The two formats the ladder may deliver, mapped to the MIME type of the image block.
///
/// A table with two entries and no sniffing: the *extension* decided the format when it
/// encoded the picture.
fn mime_type_for(format: &str) -> Option<&'static str> {
    match format {
        "png" => Some("image/png"),
        "jpeg" => Some("image/jpeg"),
        _ => None,
    }
}

/// The sentence for a call that carries an argument its schema forbids.
///
/// One entry per tool instead of one sentence for all of them: `navigate` and `click` do
/// expect an argument, and a shared wording would have to lie about the rest.
fn unexpected_arguments(tool: &str) -> &'static str {
    match tool {
        BROWSER_STATUS => "browser_status erwartet keine Argumente.",
        BROWSER_NAVIGATE => "browser_navigate erwartet nur `url` und `tab`.",
        BROWSER_READ => "browser_read erwartet nur `offset`, `maxChars`, `mode`, `frame` und `tab`.",
        BROWSER_CLICK => "browser_click erwartet nur `selector`, `frame` und `tab`.",
        BROWSER_TYPE => {
            "browser_type erwartet nur `selector`, `text`, `submit`, `frame` und `tab`."
        }
        BROWSER_FOCUS => "browser_focus erwartet nur `tab`.",
        BROWSER_INSPECT => {
            "browser_inspect erwartet nur `selector`, `text`, `limit`, `includeHidden`, `frame` und `tab`."
        }
        BROWSER_OPEN_TAB => "browser_open_tab erwartet nur `url`.",
        BROWSER_CLOSE_TAB => "browser_close_tab erwartet nur `tab`.",
        BROWSER_EVAL => "browser_eval erwartet nur `code`, `frame` und `tab`.",
        BROWSER_SCREENSHOT => "browser_screenshot erwartet nur `tab`.",
        BROWSER_FRAMES => "browser_frames erwartet nur `tab`.",
        BROWSER_TRANSCRIPT => "browser_transcript erwartet nur `offset`, `maxChars` und `tab`.",
        // Unreachable: every caller passes one of the thirteen names above.
        _ => "",
    }
}

/// The answer of one allow-list tool, in the shape its spec asks for.
fn answer_message(id: &Value, result: &Value, answer: AnswerShape) -> Value {
    match answer {
        AnswerShape::Text => text_result_message(id, result),
        AnswerShape::Screenshot => screenshot_result_message(id, result),
    }
}
