//! The MCP tool layer: JSON-RPC 2.0 over one text message at a time, the fourteen
//! tools, their sentences and the `tools/call` dispatch — ported from
//! `bridge/mcp.mjs`.
//!
//! [`handle_message_text`] is the transport-independent half: one JSON-RPC text in, at
//! most one message out (`None` for a notification and for anything that must not be
//! answered). `stdio` calls it per line, and the HTTP transport of stage 2e will call it
//! per body — one seam, two ways in, identical answers. Writing stays outside: a
//! function that both decides and writes cannot be measured without a stream.
//!
//! The tools reach the extension through [`ToolContext::hub`] and write log lines
//! through [`ToolContext::log`]; both are injected, so nothing in this module prints.

pub mod failure;
pub mod help;
pub mod texts;
pub mod tools;

use std::sync::Arc;

use serde_json::{json, Value};

use crate::hub::{Hub, LogSink};
use crate::protocol;

const JSONRPC_VERSION: &str = "2.0";

/// Reported in `initialize`.
///
/// Hard-coded rather than taken from `Cargo.toml`: the version is part of the handshake
/// contract, not of the build, and a `cargo release` bump must not silently change what
/// a client reads.
const SERVER_NAME: &str = "browser-control";
const SERVER_VERSION: &str = "0.1.0";

/// Versions a client may ask for. Echoing an unknown one would make the client speak a
/// dialect this server never implemented, so an unknown request falls back to the newest
/// version we do speak.
pub const KNOWN_PROTOCOL_VERSIONS: [&str; 4] =
    ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
pub const FALLBACK_PROTOCOL_VERSION: &str = "2025-11-25";

/// The four methods this server answers. Everything else is `-32601`.
const METHOD_INITIALIZE: &str = "initialize";
const METHOD_PING: &str = "ping";
const METHOD_TOOLS_LIST: &str = "tools/list";
const METHOD_TOOLS_CALL: &str = "tools/call";

/// A JSON-RPC 2.0 error: both fields are mandatory on the wire.
///
/// The texts are English because this is the protocol layer; what a human reads is the
/// sentence inside a tool result — English too, since `docs/54`.
///
/// `Serialize` is what keeps the wire shape and the struct from drifting apart: the error
/// object goes out as this struct, so a renamed field is a compile error rather than a
/// silently different key in a response nobody compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct RpcError {
    pub code: i64,
    pub message: &'static str,
}

impl RpcError {
    pub const PARSE_ERROR: RpcError = RpcError {
        code: -32700,
        message: "parse error",
    };
    pub const INVALID_REQUEST: RpcError = RpcError {
        code: -32600,
        message: "invalid request",
    };
    pub const METHOD_NOT_FOUND: RpcError = RpcError {
        code: -32601,
        message: "method not found",
    };
    pub const INVALID_PARAMS: RpcError = RpcError {
        code: -32602,
        message: "invalid params",
    };
}

/// Everything the tool layer needs from its surroundings.
///
/// `hub` is the only path to the extension and `log` the only channel that is not
/// stdout — the same two injections the template's `{ hub, log }` context carried.
#[derive(Clone)]
pub struct ToolContext {
    pub hub: Arc<Hub>,
    pub log: LogSink,
}

/// One JSON-RPC text in, at most one message out.
///
/// Everything malformed is answered here; a notification gets no answer at all, because
/// JSON-RPC forbids one.
pub async fn handle_message_text(text: &str, context: &ToolContext) -> Option<Value> {
    // The length check limits what gets answered, not how much memory this costs: the
    // reader buffers the whole line before it hands it over. A line this long is a broken
    // client, not a request; answering keeps the session alive instead of leaving the
    // client to time out.
    if text.len() > protocol::MAX_MESSAGE_BYTES {
        return Some(error_message(&Value::Null, RpcError::PARSE_ERROR));
    }

    // One bad line is not a reason to die.
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return Some(error_message(&Value::Null, RpcError::PARSE_ERROR));
    };

    if !is_json_object(&parsed) {
        // MCP dropped JSON-RPC batches, so an array — or a bare string — is a client bug.
        // Refusing it is honest; half-processing it would be worse.
        return Some(error_message(&Value::Null, RpcError::INVALID_REQUEST));
    }

    // No `id` means notification (`notifications/initialized` is the one that always
    // arrives): answered never, handled never. The `?` *is* that early return — this
    // function's answer is `None` on both paths.
    parsed.get("id")?;

    Some(respond_to(&parsed, context).await)
}

/// Turns one request into its response.
///
/// A protocol-level failure (`-32601`, `-32602`) says the *request* is wrong; a tool that
/// fails later reports inside `result.content` with `isError`, so the client can show the
/// message instead of a protocol error.
async fn respond_to(request: &Value, context: &ToolContext) -> Value {
    // `id: null` for a request that carries none — JSON-RPC's way of saying "I could not
    // read your id". `0` and `""` survive: only a missing key falls back, which is the
    // difference between `??` and `||`.
    let id = request.get("id").cloned().unwrap_or(Value::Null);

    match request.get("method").and_then(Value::as_str) {
        Some(METHOD_INITIALIZE) => {
            result_message(&id, initialize_result(request.get("params")))
        }
        Some(METHOD_PING) => result_message(&id, json!({})),
        Some(METHOD_TOOLS_LIST) => result_message(&id, json!({ "tools": tools::tool_list() })),
        Some(METHOD_TOOLS_CALL) => tools::call_tool(&id, request.get("params"), context).await,
        _ => error_message(&id, RpcError::METHOD_NOT_FOUND),
    }
}

/// The `initialize` result: the version the client asked for (or the newest we speak), the
/// capabilities this server has, and its own name and version.
fn initialize_result(params: Option<&Value>) -> Value {
    let requested = params.and_then(|params| params.get("protocolVersion"));
    json!({
        "protocolVersion": protocol_version_for(requested),
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
    })
}

/// The requested version when it is one of [`KNOWN_PROTOCOL_VERSIONS`], the newest known
/// one otherwise.
fn protocol_version_for(requested: Option<&Value>) -> &'static str {
    match requested.and_then(Value::as_str) {
        Some(version) => KNOWN_PROTOCOL_VERSIONS
            .iter()
            .find(|known| **known == version)
            .copied()
            .unwrap_or(FALLBACK_PROTOCOL_VERSION),
        None => FALLBACK_PROTOCOL_VERSION,
    }
}

/// `{"jsonrpc": "2.0", "id": …, "result": …}` — key order included, because the parity
/// run compares the line character for character.
pub fn result_message(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": JSONRPC_VERSION, "id": id, "result": result })
}

/// `{"jsonrpc": "2.0", "id": …, "error": {"code": …, "message": …}}`.
pub fn error_message(id: &Value, error: RpcError) -> Value {
    // `code` before `message`, in that order: the struct's declaration order is what
    // `Serialize` writes, and the parity run compares the line character for character.
    json!({ "jsonrpc": JSONRPC_VERSION, "id": id, "error": error })
}

/// `value !== null && typeof value === "object" && !Array.isArray(value)`.
///
/// A JSON-RPC request must be an object: `[1,2]` is a batch MCP does not use, and a bare
/// string is a client bug.
pub fn is_json_object(value: &Value) -> bool {
    value.is_object()
}

#[cfg(test)]
mod tests {
    // The case names carry the Node suite's spelling so the mapping stays readable;
    // `docs/38`, `### What could go wrong` names the allow.
    #![allow(non_snake_case)]

    use super::*;

    /// The fallback is the *newest* version, not the oldest and not an error: a client
    /// that asks for something this server never implemented gets a dialect it does speak.
    #[test]
    fn protocolVersionFor_withAnUnknownVersion_shouldFallBackToTheNewestKnownOne() {
        // GIVEN the four versions the server knows and two it does not:
        let known = KNOWN_PROTOCOL_VERSIONS.map(|version| (json!(version), version));
        let unknown = [json!("1999-01-01"), json!(2_025)];

        // WHEN each is asked for,
        // THEN the known ones are echoed and the unknown ones fall back:
        for (requested, expected) in known {
            assert_eq!(protocol_version_for(Some(&requested)), expected);
        }
        for requested in unknown {
            assert_eq!(
                protocol_version_for(Some(&requested)),
                FALLBACK_PROTOCOL_VERSION
            );
        }

        // ... and no version at all is the same as an unknown one.
        assert_eq!(protocol_version_for(None), FALLBACK_PROTOCOL_VERSION);
    }
}
