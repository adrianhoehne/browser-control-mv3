//! The tool layer at its seam: one `tools/call` in, a request out to the extension, an
//! answer back in, one MCP answer out — plus the stdio loop that carries both.
//!
//! Stage 2d of `docs/38`. `test/mcp.test.js` has 112 `test(` sites that run 151 leaf cases —
//! the tables inside `for` loops turn one site into several. Three of the 151 are the
//! stdin-lifecycle cases that belong to stage 2f, which leaves 148 ported cases; 37 of them
//! live in `for` loops and became table rows here, so this file names **111** of them.
//!
//! Three cases are its own, and each says why it exists:
//! `mcp_toolsCallBrowserNavigate_withWhitespaceAroundTheUrl_shouldAcceptItLikeTheBrowserDoes`
//! (the bridge was stricter than `new URL()`), the `frames: 3.0` count
//! (`Number.isInteger(3.0)` is `true`, `Value::as_i64` says otherwise) and
//! `mcp_process_theAnswerToTheLastLineBeforeStdinEof_shouldReachStdout` — a real child
//! process, because the data loss it catches is invisible to every in-process case here.
//!
//! The hub is the real one: the tool layer calls `hub.request`, the test plays the extension on
//! the other end of an `Outbound` channel, and the answer travels back through `on_message`. So
//! every case here proves the whole path — the argument checks, the wire payload, the sentences
//! and the shape of the answer — without a port, a browser or (except for the one process case)
//! a child process.
//!
//! The sentences are quoted into this file instead of imported from `mcp::texts`: a
//! test that compares a constant with itself cannot notice a changed wording. They are
//! English since `docs/54` and are the contract the agent reads, character for
//! character.
//!
//! The case names are the Node ones so the mapping stays readable; `docs/38`,
//! `### What could go wrong` names the allow for the missing snake case.

#![allow(non_snake_case)]

use std::io::Read;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use browser_control_bridge::config::Config;
use browser_control_bridge::hub::{ConnectionId, FailureKind, Hub, HubRequestError, Outbound};
use browser_control_bridge::log::Level;
use browser_control_bridge::mcp::failure::failure_text_for;
use browser_control_bridge::mcp::tools;
use browser_control_bridge::mcp::{handle_message_text, ToolContext};
use browser_control_bridge::protocol;
use browser_control_bridge::stdio;

/* ------------------------------------------------------------------ harness */

/// Long enough for a real 300 ms deadline to fire, short enough that a bridge which never
/// answers fails the case instead of holding the suite open.
const STEP_TIMEOUT: Duration = Duration::from_secs(5);

/// `main.rs` logs the bare IP (`peer_address.ip()`), the template logged
/// `socket.remoteAddress`.
const PEER: &str = "127.0.0.1";

/// The token, built at runtime instead of written as a literal: a 32-character hex string
/// in the tree would be a finding for the secret grep (`CONTRIBUTING.md`).
fn token() -> String {
    "ab".repeat(16)
}

fn test_config(hello_timeout_ms: u64, call_timeout_ms: u64, log_level: Level) -> Config {
    Config {
        host: "127.0.0.1".to_string(),
        port: 8_110,
        http_port: 8_111,
        log_level,
        hello_timeout_ms,
        call_timeout_ms,
    }
}

fn config() -> Config {
    test_config(2_000, 10_000, Level::Info)
}

fn debug_config() -> Config {
    test_config(2_000, 10_000, Level::Debug)
}

/// The 300 ms the template pins for the silent-extension case, so a timeout costs a third
/// of a second instead of ten.
fn short_call_config() -> Config {
    test_config(2_000, 300, Level::Info)
}

fn hello_frame() -> String {
    json!({
        "type": protocol::types::HELLO,
        "protocol": protocol::VERSION,
        "extensionVersion": "0.1.0",
        "browser": { "name": "Firefox", "version": "152.0.3" },
        "token": token(),
    })
    .to_string()
}

/// The extension's `ok:true` half of a response frame.
fn result_frame(result: Value) -> Value {
    json!({ "ok": true, "result": result })
}

/// The extension's `ok:false` half, with a code of its own and nothing else.
fn error_frame(code: &str) -> Value {
    json!({ "ok": false, "error": { "code": code } })
}

/// The same with the `details` the extension sends beside the code (one `error` object on
/// the wire, so `details` is merged next to `code`).
fn error_frame_with(code: &str, details: Value) -> Value {
    let mut error = details.as_object().cloned().unwrap_or_default();
    error.insert("code".to_string(), json!(code));
    json!({ "ok": false, "error": error })
}

/// One connection as the test sees it: a channel in place of a socket.
struct Peer {
    hub: Arc<Hub>,
    outbound: mpsc::UnboundedReceiver<Outbound>,
    connection: ConnectionId,
}

impl Peer {
    fn say(&self, text: &str) {
        self.hub.on_message(self.connection, text);
    }

    async fn next(&mut self) -> Outbound {
        tokio::time::timeout(STEP_TIMEOUT, self.outbound.recv())
            .await
            .expect("the tool layer sent nothing within the step timeout")
            .expect("the hub dropped its outbound channel")
    }

    async fn next_message(&mut self) -> Value {
        match self.next().await {
            Outbound::Text(text) => serde_json::from_str(&text).expect("the hub wrote a non-JSON frame"),
            other => panic!("expected a text frame, got {other:?}"),
        }
    }

    /// Searched by type, never by position: `welcome` and the automatic `status` request
    /// arrive back to back, and a case must not depend on which one it reads first.
    async fn wait_for_message(&mut self, kind: &str) -> Value {
        loop {
            let message = self.next_message().await;
            if message.get("type").and_then(Value::as_str) == Some(kind) {
                return message;
            }
        }
    }

    /// The next request to the extension, whatever its method or id.
    async fn wait_for_request(&mut self) -> Value {
        loop {
            let message = self.next_message().await;
            if message.get("type").and_then(Value::as_str) == Some(protocol::types::REQUEST) {
                return message;
            }
        }
    }

    /// `true` when the tool layer wrote anything at all — the assertion that a refused call
    /// never reached the extension.
    fn wrote_anything(&mut self) -> bool {
        self.outbound.try_recv().is_ok()
    }
}

/// The bridge as the tool layer sees it: the hub, one peer, the context and the log sink.
struct Seam {
    hub: Arc<Hub>,
    /// `None` for "nobody is connected" — the state the no-extension case is about.
    peer: Option<Peer>,
    context: ToolContext,
    log: Arc<Mutex<Vec<String>>>,
}

impl Seam {
    fn start(config: Config) -> Seam {
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&log);
        let hub = Arc::new(
            Hub::new(&config, token())
                // The timestamp prefix belongs to the process; here the raw message is
                // what the assertions look at.
                .with_log(Arc::new(move |line: &str| {
                    sink.lock().expect("log lock").push(line.to_string());
                })),
        );
        let context_sink = Arc::clone(&log);
        Seam {
            context: ToolContext {
                hub: Arc::clone(&hub),
                log: Arc::new(move |line: &str| {
                    context_sink.lock().expect("log lock").push(line.to_string());
                }),
            },
            hub,
            peer: None,
            log,
        }
    }

    /// A hub with one connection that said its `hello` and whose automatic `status` request
    /// is already answered — the state every tool case starts in.
    async fn connected(config: Config) -> Seam {
        let mut seam = Seam::start(config.clone());
        seam.connect().await;
        seam
    }

    /// Nobody connected: the whole point of the "no extension" cases.
    fn nobody(config: Config) -> Seam {
        Seam::start(config)
    }

    async fn connect(&mut self) {
        let (outbound, receiver) = mpsc::unbounded_channel();
        let connection = self.hub.handle_connection(
            outbound,
            Arc::new(AtomicBool::new(true)),
            PEER,
        );
        let mut peer = Peer {
            hub: Arc::clone(&self.hub),
            outbound: receiver,
            connection,
        };

        peer.say(&hello_frame());
        peer.wait_for_message(protocol::types::WELCOME).await;
        // The handshake fires one automatic `status` request; answering it here keeps the
        // ids of the case's own requests at 2 and up, exactly like the template.
        let status = peer.wait_for_request().await;
        let id = status
            .get("id")
            .and_then(Value::as_u64)
            .expect("the hub numbers its requests");
        peer.say(&response_frame(result_frame(status_result()), id));
        self.peer = Some(peer);
    }

    fn peer(&mut self) -> &mut Peer {
        self.peer
            .as_mut()
            .expect("this case has a connected extension")
    }

    /// `true` when the last call reached the extension. The automatic `status` request of
    /// the handshake was consumed by [`Seam::connect`], so anything here is the case's own.
    fn reached_the_extension(&mut self) -> bool {
        self.peer.as_mut().map(Peer::wrote_anything).unwrap_or(false)
    }

    fn lines(&self) -> Vec<String> {
        self.log.lock().expect("log lock").clone()
    }

    fn ask_text(&self, text: &str) -> JoinHandle<Option<Value>> {
        let context = self.context.clone();
        let text = text.to_string();
        tokio::spawn(async move { handle_message_text(&text, &context).await })
    }

    fn ask(&self, message: &Value) -> JoinHandle<Option<Value>> {
        self.ask_text(&message.to_string())
    }

    /// One `tools/call` that must be refused at the bridge: no request may reach the peer.
    async fn call(&mut self, request: Value) -> Value {
        answer_of(self.ask(&request)).await
    }

    /// One `tools/call` the extension answers: the MCP answer and the request that went
    /// out, in that order.
    async fn call_with(&mut self, request: Value, answer: Value) -> (Value, Value) {
        let handle = self.ask(&request);
        let outbound = self.peer().wait_for_request().await;
        let id = outbound
            .get("id")
            .and_then(Value::as_u64)
            .expect("the hub numbers its requests");
        self.peer().say(&response_frame(answer, id));
        (answer_of(handle).await, outbound)
    }

    /// One `tools/call` nobody answers: the hub's deadline is the only thing that ends it.
    async fn call_unanswered(&mut self, request: Value) -> (Value, Value) {
        let handle = self.ask(&request);
        let outbound = self.peer().wait_for_request().await;
        (answer_of(handle).await, outbound)
    }
}

/// The extension's answer as a wire frame the hub accepts.
fn response_frame(answer: Value, id: u64) -> String {
    let mut frame = answer.as_object().cloned().unwrap_or_default();
    frame.insert("type".to_string(), json!(protocol::types::RESPONSE));
    frame.insert("id".to_string(), json!(id));
    Value::Object(frame).to_string()
}

async fn answer_of(handle: JoinHandle<Option<Value>>) -> Value {
    tokio::time::timeout(STEP_TIMEOUT, handle)
        .await
        .expect("the tool layer did not answer within the step timeout")
        .expect("the tool task panicked")
        .expect("a request that carries an id must be answered")
}

/// One run of the stdio loop over an in-memory pipe pair: the client writes lines, the loop
/// answers, and the test reads them back the way a client would.
///
/// No process, no port: what is measured is the loop's own contract — one JSON line per
/// answer, nothing else on stdout, and the answers of two calls in one write.
struct StdioRun {
    serving: JoinHandle<std::io::Result<()>>,
    input: tokio::io::WriteHalf<tokio::io::DuplexStream>,
    answers: BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>,
    output: String,
}

impl StdioRun {
    fn start(context: ToolContext) -> StdioRun {
        let (client, server) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server);
        let (client_read, client_write) = tokio::io::split(client);
        let serving = tokio::spawn(stdio::serve(
            BufReader::new(server_read),
            server_write,
            Arc::new(context),
        ));
        StdioRun {
            serving,
            input: client_write,
            answers: BufReader::new(client_read),
            output: String::new(),
        }
    }

    /// One line into stdin, exactly as a client writes it.
    async fn send(&mut self, text: &str) {
        self.input
            .write_all(format!("{text}\n").as_bytes())
            .await
            .expect("the input pipe refused a write");
        self.input.flush().await.expect("the input pipe refused a flush");
    }

    /// The next complete answer line — the deadline is what turns "no answer" into a
    /// failure instead of a hang.
    async fn next_line(&mut self) -> Value {
        let mut line = String::new();
        tokio::time::timeout(STEP_TIMEOUT, self.answers.read_line(&mut line))
            .await
            .expect("no answer line within the step timeout")
            .expect("the answer pipe ended");
        self.output.push_str(&line);
        serde_json::from_str(line.trim_end_matches('\n'))
            .expect("stdout carried a line that is not JSON")
    }

    /// Closes stdin, waits for the loop and answers with everything it wrote.
    async fn finish(mut self) -> String {
        self.input
            .shutdown()
            .await
            .expect("the input pipe refused to close");
        self.serving
            .await
            .expect("the stdio task panicked")
            .expect("the stdio loop failed");
        let mut rest = String::new();
        tokio::time::timeout(STEP_TIMEOUT, self.answers.read_to_string(&mut rest))
            .await
            .expect("the answer pipe never ended")
            .expect("the answer pipe failed");
        format!("{}{rest}", self.output)
    }
}

/// Every complete line of a finished stdout, parsed. A line that is not JSON is a failure,
/// not a "nothing yet": stdout is the protocol channel.
fn parse_lines(output: &str) -> Vec<Value> {
    output
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|_| panic!("stdout carried a line that is not JSON: {line:?}"))
        })
        .collect()
}

/* --------------------------------------------------------------- answering */

/// The text of the one content block a text answer carries.
fn text_of(answer: &Value) -> String {
    answer["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("no text content block in {answer}"))
        .to_string()
}

/// `JSON.stringify(value, null, 2)` — the tool layer's answer format, spelled out here so a
/// changed indentation turns these cases red.
fn indented(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("a JSON value always serialises")
}

fn is_error(answer: &Value) -> bool {
    answer["result"]["isError"] == Value::Bool(true)
}

fn error_code(answer: &Value) -> Option<i64> {
    answer["error"]["code"].as_i64()
}

/// The fields of a parsed answer, in order — several case names promise all of them.
fn fields_of(value: &Value) -> Vec<String> {
    value
        .as_object()
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default()
}

fn keys_of(value: &Value) -> Vec<String> {
    value
        .as_object()
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default()
}

/* ------------------------------------------------------------ the requests */

/// `{"jsonrpc": "2.0", "id": …, "method": "tools/call", "params": {"name": …}}`, with
/// `arguments` only when the case sends some — the shape a client really produces.
fn call_request(id: i64, name: &str, arguments: Option<Value>) -> Value {
    match arguments {
        Some(arguments) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        }),
        None => json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": name },
        }),
    }
}

fn status_call(id: i64) -> Value {
    call_request(id, "browser_status", None)
}

fn navigate_call(id: i64, url: &str) -> Value {
    call_request(id, "browser_navigate", Some(json!({ "url": url })))
}

fn read_call(id: i64, arguments: Option<Value>) -> Value {
    call_request(id, "browser_read", arguments)
}

fn click_call(id: i64, selector: &str) -> Value {
    call_request(id, "browser_click", Some(json!({ "selector": selector })))
}

fn type_call(id: i64, selector: &str, text: &str) -> Value {
    call_request(
        id,
        "browser_type",
        Some(json!({ "selector": selector, "typed_text": text })),
    )
}

fn focus_call(id: i64) -> Value {
    call_request(id, "browser_focus", None)
}

fn inspect_call(id: i64, arguments: Value) -> Value {
    call_request(id, "browser_inspect", Some(arguments))
}

fn open_tab_call(id: i64, url: &str) -> Value {
    call_request(id, "browser_open_tab", Some(json!({ "url": url })))
}

fn close_tab_call(id: i64, arguments: Option<Value>) -> Value {
    call_request(id, "browser_close_tab", arguments)
}

fn eval_call(id: i64, arguments: Value) -> Value {
    call_request(id, "browser_eval", Some(arguments))
}

fn screenshot_call(id: i64, arguments: Option<Value>) -> Value {
    call_request(id, "browser_screenshot", arguments)
}

fn frames_call(id: i64, arguments: Option<Value>) -> Value {
    call_request(id, "browser_frames", arguments)
}

fn transcript_call(id: i64, arguments: Option<Value>) -> Value {
    call_request(id, "browser_transcript", arguments)
}

fn help_call(id: i64, tool: &str) -> Value {
    call_request(id, "browser_help", Some(json!({ "tool": tool })))
}

/* ---------------------------------------------------------- the results */

// The answers the extension is played back with. Shaped like the fixture of the Node suite
// (same fields, same order) but shorter where the fixture carried a whole page: what these
// cases prove is the pass-through and the sentence, not the length of a page.

fn status_result() -> Value {
    json!({
        "extension": { "version": "0.1.0", "connectedAt": "2026-10-23T09:12:31.004Z" },
        "windows": [
            {
                "id": 1,
                "focused": true,
                "type": "normal",
                "tabs": [
                    {
                        "id": 101,
                        "active": true,
                        "pinned": false,
                        "url": "https://example.org/",
                        "title": "Example Domain",
                        "agent": true,
                    },
                ],
            },
        ],
    })
}

fn navigate_result() -> Value {
    json!({
        "tabId": 42,
        "windowId": 1,
        "url": "https://example.org/",
        "title": "Example Domain",
        "complete": true,
        "settled": true,
        "waitedMs": 412,
    })
}

fn read_result() -> Value {
    json!({
        "tabId": 42,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "text": "Zeile eins\n\nZeile zwei",
        "truncated": false,
        "via": "innerText",
    })
}

fn click_result() -> Value {
    json!({
        "tabId": 42,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "clicked": "a#video-title-link",
        "text": "Zeile eins\n\nZeile zwei",
        "truncated": false,
        "via": "innerText",
        "settled": true,
        "waitedMs": 412,
    })
}

fn type_result() -> Value {
    json!({
        "tabId": 42,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "typed": "input#q",
        "submitted": false,
        "text": "Zeile eins\n\nZeile zwei",
        "truncated": false,
        "via": "innerText",
    })
}

fn focus_result() -> Value {
    json!({
        "tabId": 42,
        "windowId": 1,
        "url": "https://example.org/",
        "title": "Example Domain",
        "active": true,
        "focused": true,
    })
}

fn inspect_result() -> Value {
    json!({
        "tabId": 42,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "count": 1,
        "truncated": false,
        "elements": [
            {
                "index": 0,
                "selector": "a#cart-link",
                "tag": "a",
                "id": "cart-link",
                "classes": ["cart"],
                "href": "https://example.org/cart",
                "text": "Zeile eins",
                "visible": true,
            },
        ],
    })
}

fn open_tab_result() -> Value {
    json!({ "tabId": 31, "url": "https://example.org/", "title": "Beispiel" })
}

fn close_tab_result() -> Value {
    json!({ "tabId": 31, "closed": true })
}

fn eval_result() -> Value {
    json!({
        "tabId": 18,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "elapsedMs": 4,
        "result": "Beispielseite",
    })
}

/// A JPEG of four base64 characters — the magic and the length rule, not the pixels.
fn screenshot_result() -> Value {
    json!({
        "tabId": 20,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "format": "jpeg",
        "width": 1600,
        "height": 900,
        "bytes": 3,
        "scaled": true,
        "activated": false,
        "base64": "/9j/",
    })
}

fn frames_result() -> Value {
    json!({
        "tabId": 42,
        "url": "https://example.org/",
        "count": 2,
        "frames": [
            { "href": "https://example.org/", "top": true },
            { "href": "https://widget.example.net/kalender", "top": false },
        ],
    })
}

fn transcript_result() -> Value {
    json!({
        "requestedLanguage": "en",
        "deliveredLanguage": "en",
        "source": "ytplayer.bootstrapPlayerResponse",
        "segments": [
            { "time": 4, "timeText": "0:04", "text": "Zeile eins" },
            { "time": 6, "timeText": "0:06", "text": "Zeile zwei" },
            { "time": 14, "timeText": "0:14", "text": "Zeile drei" },
        ],
        "totalChars": 32,
        "chars": 32,
        "offset": 0,
        "truncated": false,
    })
}

/* ------------------------------------------------------------- the contract */

// The visible texts, quoted from the contract — all of them, descriptions and sentences.
// Duplicated on purpose: a test that imports the sentence it checks cannot notice a
// changed sentence. English since `docs/54`; the sentences are the contract the agent
// reads.

const TOOL_DESCRIPTION: &str = r#"Shows the windows and tabs of the operator's browser in the Default container, along with the extension's connection state, and marks the agent tab with `agent: true`."#;
const NAVIGATE_TOOL_DESCRIPTION: &str = r#"Opens an http(s) URL in the agent tab of the operator's browser (Default container), waits until the page has loaded and then until it has settled (3 s at most); reports `settled`/`waitedMs`. With `tab` exactly that tab, without `tab` the one used last."#;
const READ_TOOL_DESCRIPTION: &str = r#"Reads the **current** agent tab and takes **no** URL — call `browser_navigate` first. Reads the title, the address and the text of the agent tab; `offset` skips that many characters of the text (default 0), `maxChars` limits the excerpt (default 20 000, at most 100 000). `offset`/`maxChars` page through the text; `chars` and `totalChars` tell you where you are. `via` says whether it is visible text or text content. `mode: article` reads only the article body — without navigation, footer and cookie banner. Waits first until the page has settled (3 s at most) and reports `settled`/`waitedMs`. With `tab` exactly that tab, without `tab` the one used last."#;
const CLICK_TOOL_DESCRIPTION: &str = r#"Works on the **current** agent tab and takes **no** URL — call `browser_navigate` first. Clicks an element of the agent tab: by CSS `selector`, by `contains_text` (visible text, case-insensitive; an exact match wins over a partial one) or by both, where `selector` narrows the text search. Waits until the page has settled (3 s at most) and returns the page text afterwards (cut to 20 000 characters); reports `settled`/`waitedMs`. With `tab` exactly that tab, without `tab` the one used last."#;
const TYPE_TOOL_DESCRIPTION: &str = r#"Works on the **current** agent tab and takes **no** URL — call `browser_navigate` first. Writes text into the field that matches the CSS selector, optionally sends Enter and returns the page text afterwards (cut to 20 000 characters). With `tab` exactly that tab, without `tab` the one used last."#;
const FOCUS_TOOL_DESCRIPTION: &str = r#"Brings the agent tab to the front and its window to the foreground; the page itself is not changed, and `focused` comes from a query after focusing. With `tab` exactly that tab, without `tab` the one used last."#;
const INSPECT_TOOL_DESCRIPTION: &str = r#"Works on the **current** agent tab and takes **no** URL — call `browser_navigate` first. Lists the elements of the agent tab (by CSS selector and/or text search) with tag, id, class, link, visible text, visibility and a ready-made selector to reuse. `my-card >>> button` steps right of the `>>>` into the open shadow tree of `my-card` (several levels allowed); every step is a simple selector — type, `#id`, `.class`, `[attr="value"]` or `:nth-of-type(n)`; closed shadow trees stay out of reach, and without `>>>` nothing changes. Changes nothing on the page. With `tab` exactly that tab, without `tab` the one used last."#;
const OPEN_TAB_TOOL_DESCRIPTION: &str = r#"Opens another agent tab in the Default container (five at most) and returns `tabId`, `url` and `title`. Waits until the page has loaded, but not for it to settle — a `browser_read` afterwards should not cost `page_busy`."#;
const CLOSE_TAB_TOOL_DESCRIPTION: &str = r#"Closes an agent tab and removes it from the list; without `tab` the one used last. Returns `tabId` and `closed`."#;
const EVAL_TOOL_DESCRIPTION: &str = r#"Evaluates code in the **current** agent tab and takes **no** URL — call `browser_navigate` first. Runs code in the page context of the agent tab and returns the result as JSON; code may change the page, including filling password fields. `code` runs as a function body: the result comes back with `return`, without `return` it is `null`. Only possible when "Allow code evaluation" is switched on in the extension settings — otherwise `eval_not_allowed`. With `tab` exactly that tab, without `tab` the one used last."#;
const EVAL_FUNCTION_BODY_SENTENCE: &str = r#"`code` runs as a function body"#;
const SCREENSHOT_TOOL_DESCRIPTION: &str = r#"Works on the **current** agent tab and takes **no** URL — call `browser_navigate` first. Photographs the visible viewport of the agent tab and returns the picture as MCP image content (3 MiB at most; PNG, scaled down and re-encoded as JPEG when larger). The numbers for it — `format`, `width`, `height`, `bytes` and `scaled` — stand next to it as a text block. With `tab` exactly that tab, without `tab` the one used last."#;
const FRAMES_TOOL_DESCRIPTION: &str = r#"Lists the frames (iframes) of the agent tab with their address; `frame` in the other tools takes a substring of it. With `tab` exactly that tab, without `tab` the one used last."#;
const TRANSCRIPT_TOOL_DESCRIPTION: &str = r#"Reads the transcript of the YouTube video tab as segments with timestamp and text, taken from the video's subtitle track. `requestedLanguage` names the chosen track, `deliveredLanguage` the language of the delivered track file, `source` where the player's data model was found. `offset` skips that many characters of the concatenated segment texts (default 0), `maxChars` limits the excerpt (default 20 000, at most 100 000); `segments` holds exactly the segments of this window, `chars` and `totalChars` tell you where you are, and `truncated` pages on. The tab must be in the foreground — call browser_focus first, otherwise the tool answers `transcript_needs_focus`. With `tab` exactly that tab, without `tab` the one used last."#;
const NO_EXTENSION_TEXT: &str = r#"No extension connected — Firefox with the extension is not running, or the connection was dropped."#;
const NO_ANSWER_TEXT: &str = r#"The extension did not answer (timeout)."#;
const UNEXPECTED_ARGUMENTS_TEXT: &str = r#"browser_status takes no arguments."#;
const NAVIGATE_UNEXPECTED_ARGUMENTS_TEXT: &str = r#"browser_navigate takes only `url` and `tab`."#;
const READ_UNEXPECTED_ARGUMENTS_TEXT: &str = r#"browser_read takes only `offset`, `maxChars`, `mode`, `frame` and `tab`."#;
const CLICK_UNEXPECTED_ARGUMENTS_TEXT: &str = r#"browser_click takes only `selector`, `contains_text`, `frame` and `tab`."#;
const TYPE_UNEXPECTED_ARGUMENTS_TEXT: &str = r#"browser_type takes only `selector`, `typed_text`, `submit`, `frame` and `tab`."#;
const FOCUS_UNEXPECTED_ARGUMENTS_TEXT: &str = r#"browser_focus takes only `tab`."#;
const INSPECT_UNEXPECTED_ARGUMENTS_TEXT: &str = r#"browser_inspect takes only `selector`, `contains_text`, `limit`, `includeHidden`, `frame` and `tab`."#;
// No constant for `browser_close_tab` here: a constant no case reads would be dead weight,
// and `scripts/parity.sh` comparison 2 pins that sentence through the real process anyway.
const OPEN_TAB_UNEXPECTED_ARGUMENTS_TEXT: &str = r#"browser_open_tab takes only `url`."#;
const EVAL_UNEXPECTED_ARGUMENTS_TEXT: &str = r#"browser_eval takes only `code`, `frame` and `tab`."#;
const SCREENSHOT_UNEXPECTED_ARGUMENTS_TEXT: &str = r#"browser_screenshot takes only `tab`."#;
const FRAMES_UNEXPECTED_ARGUMENTS_TEXT: &str = r#"browser_frames takes only `tab`."#;
const TRANSCRIPT_UNEXPECTED_ARGUMENTS_TEXT: &str = r#"browser_transcript takes only `offset`, `maxChars` and `tab`."#;
const INVALID_URL_TEXT: &str = r#"Only http:// and https:// are allowed."#;
const NO_AGENT_TAB_TEXT: &str = r#"No agent tab — call browser_navigate first."#;
const TOO_MANY_TABS_TEXT: &str = r#"Five agent tabs are already open — close one first."#;
const NOT_READABLE_TEXT: &str = r#"The extension cannot read this page (internal page or special format)."#;
const PAGE_BUSY_TEXT: &str = r#"The page is still loading — try again in a moment."#;
const NOT_READABLE_URL: &str = r#"https://example.org/preisliste.pdf"#;
const NOT_READABLE_PDF_TEXT: &str = r#"The extension cannot read this page (kind: pdf). Address: https://example.org/preisliste.pdf"#;
const NOT_READABLE_WITHOUT_KIND_TEXT: &str = r#"The extension cannot read this page. Address: https://example.org/preisliste.pdf"#;
const NOT_READABLE_CONTENT_TYPE: &str = r#"application/pdf"#;
const NOT_READABLE_PDF_WITH_TYPE_TEXT: &str = r#"The extension cannot read this page (kind: pdf, content-type: application/pdf). Address: https://example.org/preisliste.pdf"#;
const NOT_READABLE_WITH_TYPE_TEXT: &str = r#"The extension cannot read this page (content-type: application/pdf). Address: https://example.org/preisliste.pdf"#;
const NOT_READABLE_AFTER_CLICK_TEXT: &str = r#"The click went through, but the page it opened cannot be read: https://example.org/preisliste.pdf. Go back with browser_navigate."#;
/// The sentence of a click whose request got no answer (`docs/63`) — one line, no address.
const CLICK_OUTCOME_UNKNOWN_TEXT: &str = r#"The page gave no answer to the click request: it may have gone through. Check the page before you click again."#;
const OFFSET_OUT_OF_RANGE_MESSAGE: &str = r#"The text has 87314 characters; offset 999999 is past its end."#;
const OFFSET_OUT_OF_RANGE_TEXT: &str = r#"`offset` is past the end of the text: The text has 87314 characters; offset 999999 is past its end."#;
const INVALID_READ_PARAMS_MESSAGE: &str = r#"maxChars must be an integer from 1 to 100000."#;
const INVALID_READ_PARAMS_TEXT: &str = r#"The parameter is invalid: maxChars must be an integer from 1 to 100000."#;
const CALL_EXTENSION_FAILED_TEXT: &str = r#"The extension could not carry out the request (code=invalid_params)."#;
const FRAME_NOT_FOUND_TEXT: &str = r#"No frame matches this `frame` — check the addresses with browser_frames."#;
const FRAME_NOT_FOUND_WITH_COUNT_TEXT: &str = r#"No frame matches this `frame` — check the addresses with browser_frames (frames that answered: 2)."#;
const FRAME_AMBIGUOUS_TEXT: &str = r#"Several frames match this `frame` — pass a longer substring of the address."#;
const FRAME_AMBIGUOUS_WITH_CANDIDATES_TEXT: &str = r#"Several frames match this `frame` — pass a longer substring of one of these addresses: https://widget.example.net/kalender/oben, https://widget.example.net/kalender/unten."#;
const FRAME_SUBSTRING: &str = r#"kalender"#;
const CLICK_SELECTOR: &str = r#"a#video-title-link"#;
/// The sentence of a click that names neither target (`docs/60`).
const CLICK_NEEDS_FILTER_TEXT: &str = r#"browser_click needs `selector` or `contains_text`."#;
/// The term the text-click cases search for.
const CLICK_TEXT: &str = r#"In den Einkaufswagen"#;
/// The term the `no_match` case searches for — a word no page carries.
const CLICK_MISSING_TERM: &str = r#"gibtsnicht"#;
const CLICK_CANDIDATE_ONE: &str = r#"div#page > ul > li:nth-of-type(1) > button"#;
const CLICK_CANDIDATE_TWO: &str = r#"div#page > ul > li:nth-of-type(2) > button"#;
/// `text_ambiguous` with two matches and two candidates (`docs/58`, `## Ziel` 5).
const CLICK_AMBIGUOUS_TEXT: &str = r#"`contains_text: "In den Einkaufswagen"` matches 2 elements (div#page > ul > li:nth-of-type(1) > button, div#page > ul > li:nth-of-type(2) > button). Narrow it with `selector` — `browser_inspect` lists each candidate with its own selector, and `browser_help({"tool":"browser_inspect"})` explains the arguments."#;
/// The same refusal after a run that stopped at the candidate cap: the count is a lower
/// bound, so the sentence says `at least`.
const CLICK_AMBIGUOUS_AT_CAP_TEXT: &str = r#"`contains_text: "In den Einkaufswagen"` matches at least 5 elements (div#page > ul > li:nth-of-type(1) > button, div#page > ul > li:nth-of-type(2) > button). Narrow it with `selector` — `browser_inspect` lists each candidate with its own selector, and `browser_help({"tool":"browser_inspect"})` explains the arguments."#;
/// `no_match` after a text search: the term, not the selector (`docs/58`, `## Ziel` 6).
const CLICK_NO_MATCH_FOR_TEXT: &str = r#"No element matches this text: gibtsnicht."#;
const INVALID_SELECTOR_TEXT: &str = r#"The selector is invalid: a#video-title-link."#;
const NO_MATCH_TEXT: &str = r#"No element matches: a#video-title-link."#;
const NOT_CLICKABLE_TEXT: &str = r#"The element is not visible or is disabled: a#video-title-link."#;
const OFFSCREEN_AFTER_SCROLL_TEXT: &str =
    r#"The element stays outside the viewport after scrolling: a#video-title-link."#;
const TYPE_SELECTOR: &str = r#"input#q"#;
const TYPE_TEXT: &str = r#"suchbegriff"#;
const TYPE_NO_MATCH_TEXT: &str = r#"No element matches: input#q."#;
const NOT_TYPEABLE_TEXT: &str = r#"The element is not a writable field or is disabled: input#q."#;
const PASSWORD_NOT_ALLOWED_TEXT: &str = r#"Password fields are locked. Unlock them in the extension options."#;
const FOCUS_FAILED_TEXT: &str = r#"The extension could not carry out the request (code=focus_failed)."#;
const INSPECT_SELECTOR: &str = r#"a#cart-link"#;
const INSPECT_NEEDS_FILTER_TEXT: &str = r#"browser_inspect needs `selector` or `contains_text`."#;
const INSPECT_INVALID_SELECTOR_TEXT: &str = r#"The selector is invalid: a#cart-link."#;
const INSPECT_INVALID_PARAMS_TEXT: &str = r#"The parameter is invalid."#;
const EVAL_CODE: &str = r#"return document.title"#;
const EVAL_NOT_ALLOWED_TEXT: &str = r#"Code evaluation is not allowed in the extension settings — enable it there first."#;
const EVAL_FAILED_TEXT: &str = r#"The code in the agent tab failed (exception or syntax error)."#;
const EVAL_TIMEOUT_TEXT: &str = r#"The code did not answer in time (timeout after 2 s)."#;
const EVAL_RESULT_TOO_LARGE_TEXT: &str = r#"The result is too large for one answer (more than 10 000 characters of JSON) — return less, for example with browser_inspect."#;
const EVAL_RESULT_UNSERIALIZABLE_TEXT: &str = r#"The result cannot be represented as JSON (circular, for example) — return plain values only."#;
const INVALID_EVAL_PARAMS_TEXT: &str = r#"The parameter is invalid."#;
const EVAL_FAILED_PAGE_MESSAGE: &str = r#"messwert-4711: Cannot read properties of null"#;
const EVAL_FAILED_WITH_MESSAGE_TEXT: &str = r#"The code in the agent tab failed: messwert-4711: Cannot read properties of null"#;
const SCREENSHOT_NOT_ALLOWED_TEXT: &str = r#"Screenshots are not allowed in the extension settings — enable them there first."#;
const SCREENSHOT_FAILED_TEXT: &str = r#"The agent tab could not be photographed."#;
const SCREENSHOT_BROWSER_MESSAGE: &str = r#"The operation failed for an unknown transient reason"#;
const SCREENSHOT_FAILED_WITH_MESSAGE_TEXT: &str = r#"The agent tab could not be photographed: The operation failed for an unknown transient reason"#;
const SCREENSHOT_TOO_LARGE_MEASUREMENT: &str = r#"The picture is too large even after scaling down: 3300000 bytes at 1200 × 675 (limit 3145728)."#;
const SCREENSHOT_TOO_LARGE_TEXT: &str = r#"The picture is too large even after scaling down — it is not delivered; another tab may come out smaller."#;
const SCREENSHOT_TOO_LARGE_WITH_MESSAGE_TEXT: &str = r#"The picture is too large even after scaling down — it is not delivered; another tab may come out smaller. Measurement: The picture is too large even after scaling down: 3300000 bytes at 1200 × 675 (limit 3145728)."#;
const INVALID_SCREENSHOT_PARAMS_TEXT: &str = r#"The parameter is invalid."#;
const TRANSCRIPT_FAILED_TEXT: &str = r#"The transcript could not be read — only YouTube watch pages have one."#;
const TRANSCRIPT_FAILURE_REASON: &str = r#"The track file for language "ja" was not found on this page."#;
const TRANSCRIPT_FAILED_WITH_MESSAGE_TEXT: &str = r#"The transcript could not be read: The track file for language "ja" was not found on this page."#;
const TRANSCRIPT_PROBE_URL: &str = r#"https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&lang=en&expire=1&signature=platzhalter"#;
const TRANSCRIPT_NEEDS_FOCUS_TEXT: &str = r#"The tab is not in the foreground, so the page is not rendered — call browser_focus first, then try again."#;
const TRANSCRIPT_FOCUS_MESSAGE: &str = r#"The tab is in the foreground (document.visibilityState: "visible"), but the page is not built yet. Another browser_focus does not help; wait a moment and try again."#;
const TRANSCRIPT_NEEDS_FOCUS_WITH_MESSAGE_TEXT: &str = r#"The page is not rendered: The tab is in the foreground (document.visibilityState: "visible"), but the page is not built yet. Another browser_focus does not help; wait a moment and try again."#;
const NO_TRANSCRIPT_PANEL_TEXT: &str = r#"No subtitle track found in the video — it has none, or the page is not built yet."#;

/* ------------------------------------------------------------- JSON-RPC */

#[tokio::test]
async fn mcp_initialize_withAKnownProtocolVersion_shouldEchoThatVersion() {
    // GIVEN a bridge with nobody connected:
    let seam = Seam::nobody(config());

    // WHEN the client initialises with a version the server knows,
    let answer = answer_of(seam.ask(&json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": { "protocolVersion": "2025-06-18" },
    })))
    .await;

    // THEN that version comes back, with the capabilities and the server name the
    // contract names:
    assert_eq!(answer["jsonrpc"], "2.0");
    assert_eq!(
        answer["result"],
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "browser-control", "version": "0.1.0" },
        })
    );
    // The order is the contract too: the parity run compares the line character for
    // character.
    assert_eq!(
        keys_of(&answer["result"]),
        ["protocolVersion", "capabilities", "serverInfo"]
    );
}

#[tokio::test]
async fn mcp_initialize_withAnUnknownProtocolVersion_shouldFallBackToTheNewestKnownVersion() {
    // GIVEN a bridge with nobody connected:
    let seam = Seam::nobody(config());

    // WHEN the client asks for a version that does not exist,
    let answer = answer_of(seam.ask(&json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": { "protocolVersion": "1999-01-01" },
    })))
    .await;

    // THEN it gets the newest version the server speaks instead of an error:
    assert_eq!(answer["result"]["protocolVersion"], "2025-11-25");
}

#[tokio::test]
async fn mcp_stdout_shouldCarryNothingButJsonRpcWhileTheLogLinesStayOnStderr() {
    // GIVEN a bridge with a connected extension, whose log lines are collected:
    let seam = Seam::connected(config()).await;
    let mut run = StdioRun::start(seam.context.clone());

    // WHEN the client runs the shortest complete dialogue there is,
    run.send(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }).to_string())
        .await;
    run.send(&json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }).to_string())
        .await;
    let output = run.finish().await;

    // THEN every complete line on stdout is a JSON-RPC message with an id,
    let messages = parse_lines(&output);
    assert_eq!(messages.len(), 2, "stdout: {output:?}");
    for message in &messages {
        assert_eq!(message["jsonrpc"], "2.0");
        assert!(message.get("id").is_some(), "every response carries an id field");
    }

    // ... the bridge's own status line went to the log channel and never to stdout,
    let lines = seam.lines();
    assert!(
        lines.iter().any(|line| line.starts_with("status windows=")),
        "no status line in the log: {lines:?}"
    );
    assert!(!output.contains("status windows="), "a log line must not reach stdout");
    assert!(!output.contains("listening on"), "a log line must not reach stdout");
}

#[tokio::test]
async fn mcp_toANotificationFollowedByAPing_shouldAnswerOnlyThePing() {
    // GIVEN a bridge with nobody connected:
    let seam = Seam::nobody(config());

    // WHEN `notifications/initialized` (no id) is followed by a `ping`,
    let notification = seam.ask(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    let ping = seam.ask(&json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" }));

    // THEN exactly one answer exists: the notification came first, so an answer to it
    // would have been written first — one answer now is proof that it was answered never.
    assert!(
        notification.await.expect("the task panicked").is_none(),
        "a notification must not be answered"
    );
    let answer = answer_of(ping).await;
    assert_eq!(answer["result"], json!({}));
    assert_eq!(answer["id"], 7);
}

#[tokio::test]
async fn mcp_forAnUnknownMethod_shouldAnswerWithMethodNotFound() {
    // GIVEN a bridge with nobody connected:
    let seam = Seam::nobody(config());

    // WHEN the client calls a method this server does not implement,
    let answer = answer_of(seam.ask(&json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/nonexistent",
    })))
    .await;

    // THEN it gets the JSON-RPC method-not-found error and no result:
    assert_eq!(error_code(&answer), Some(-32601));
    assert_eq!(answer["error"]["message"], "method not found");
    assert!(answer.get("result").is_none(), "an error response carries no result");
}

#[tokio::test]
async fn mcp_withOneBrokenLine_shouldAnswerParseErrorAndKeepServingTheNextRequest() {
    // GIVEN a bridge with nobody connected:
    let seam = Seam::nobody(config());

    // WHEN a line arrives that is not JSON,
    let parse_error = answer_of(seam.ask_text(r#"{"jsonrpc":"2.0","id":1,"method":"#)).await;

    // THEN the answer names the parse error with `id: null`,
    assert_eq!(parse_error["jsonrpc"], "2.0");
    assert_eq!(parse_error["id"], Value::Null);
    assert_eq!(error_code(&parse_error), Some(-32700));
    assert_eq!(parse_error["error"]["message"], "parse error");

    // ... and the server keeps serving: a good line afterwards is answered.
    let answer = answer_of(seam.ask(&json!({ "jsonrpc": "2.0", "id": 11, "method": "ping" }))).await;
    assert_eq!(answer["result"], json!({}));
}

#[tokio::test]
async fn mcp_withALineThatIsNotAJsonObject_shouldAnswerInvalidRequestAndKeepServing() {
    // GIVEN a bridge with nobody connected:
    let seam = Seam::nobody(config());

    // WHEN a well-formed JSON value arrives that is not an object — a JSON-RPC batch,
    // which MCP does not use,
    let invalid_request = answer_of(seam.ask_text("[1,2]")).await;

    // THEN it is refused as an invalid request, not as a parse error,
    assert_eq!(invalid_request["id"], Value::Null);
    assert_eq!(error_code(&invalid_request), Some(-32600));
    assert_eq!(invalid_request["error"]["message"], "invalid request");

    // ... and the server keeps serving:
    let answer = answer_of(seam.ask(&json!({ "jsonrpc": "2.0", "id": 12, "method": "ping" }))).await;
    assert_eq!(answer["result"], json!({}));
}

#[tokio::test]
async fn mcp_withALineLongerThanTheMessageLimit_shouldAnswerParseErrorInsteadOfParsingItAndKeepServing() {
    // GIVEN a bridge with nobody connected:
    let seam = Seam::nobody(config());

    // WHEN a single message exceeds MAX_MESSAGE_BYTES — the server itself has to judge
    // it, because the reader hands over whatever length arrives:
    let oversized = format!("\"{}\"", "x".repeat(protocol::MAX_MESSAGE_BYTES));
    let parse_error = answer_of(seam.ask_text(&oversized)).await;

    // THEN the line is refused instead of being parsed and answered as a request,
    assert_eq!(parse_error["id"], Value::Null);
    assert_eq!(error_code(&parse_error), Some(-32700));
    assert_eq!(parse_error["error"]["message"], "parse error");

    // ... and the session survives it: the next line is answered normally.
    let answer = answer_of(seam.ask(&json!({ "jsonrpc": "2.0", "id": 13, "method": "ping" }))).await;
    assert_eq!(answer["result"], json!({}));
}

#[tokio::test]
async fn mcp_withAStringIdOrZeroAsId_shouldAnswerUnderExactlyThatId() {
    // GIVEN a bridge with nobody connected:
    let seam = Seam::nobody(config());

    // WHEN two requests carry ids that are present but not plain positive integers — a
    // string, which JSON-RPC allows, and `0`, which only `??` keeps:
    let string_id = seam.ask(&json!({ "jsonrpc": "2.0", "id": "req-7", "method": "ping" }));
    let zero_id = seam.ask(&json!({ "jsonrpc": "2.0", "id": 0, "method": "ping" }));

    // THEN each answer carries its own id unchanged. A `||` where the code has a `??`
    // would turn the zero into `null` and silently break the pairing:
    let string_answer = answer_of(string_id).await;
    assert_eq!(string_answer["id"], "req-7");
    let zero_answer = answer_of(zero_id).await;
    assert_eq!(zero_answer["id"], 0);
    assert_eq!(zero_answer["result"], json!({}));
}

#[tokio::test]
async fn mcp_toolsList_shouldOfferExactlyTheFourteenToolsOfTheContract() {
    // GIVEN a bridge with nobody connected:
    let seam = Seam::nobody(config());

    // WHEN the client asks for the tool table,
    let answer = answer_of(seam.ask(&json!({ "jsonrpc": "2.0", "id": 20, "method": "tools/list" }))).await;

    // THEN there are exactly fourteen tools, in the order the contract lists them. New
    // tools are appended, so every position is a pin: a tool inserted in the middle would
    // shift all of them.
    let tools = answer["result"]["tools"]
        .as_array()
        .expect("the answer carries a tool array")
        .clone();
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool["name"].as_str().expect("every tool has a name"))
            .collect::<Vec<&str>>(),
        [
            "browser_status",
            "browser_navigate",
            "browser_read",
            "browser_click",
            "browser_type",
            "browser_focus",
            "browser_inspect",
            "browser_open_tab",
            "browser_close_tab",
            "browser_eval",
            "browser_screenshot",
            "browser_frames",
            "browser_transcript",
            "browser_help",
        ]
    );

    assert_eq!(tools[0]["description"], TOOL_DESCRIPTION);
    assert_eq!(
        tools[0]["inputSchema"],
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    );

    assert_eq!(tools[1]["description"], NAVIGATE_TOOL_DESCRIPTION);
    assert_eq!(
        tools[1]["inputSchema"],
        json!({
            "type": "object",
            "properties": {
                "url": { "type": "string" },
                "tab": { "type": "integer", "minimum": 1 },
            },
            "required": ["url"],
            "additionalProperties": false,
        })
    );

    // Five declared properties since spec 24: the window, the `mode` that picks the
    // article body, the `frame` substring and `tab` — and no `required`, because a read
    // without a window is the default read.
    assert_eq!(tools[2]["description"], READ_TOOL_DESCRIPTION);
    assert_eq!(
        tools[2]["inputSchema"],
        json!({
            "type": "object",
            "properties": {
                "offset": { "type": "integer", "minimum": 0 },
                "maxChars": { "type": "integer", "minimum": 1, "maximum": 100000 },
                "mode": { "type": "string", "enum": ["text", "article"] },
                "frame": { "type": "string", "minLength": 1 },
                "tab": { "type": "integer", "minimum": 1 },
            },
            "additionalProperties": false,
        })
    );
    assert_eq!(
        keys_of(&tools[2]["inputSchema"]["properties"]),
        ["offset", "maxChars", "mode", "frame", "tab"]
    );

    assert_eq!(tools[3]["description"], CLICK_TOOL_DESCRIPTION);
    assert_eq!(
        tools[3]["inputSchema"],
        json!({
            "type": "object",
            "properties": {
                "selector": { "type": "string" },
                "contains_text": { "type": "string" },
                "frame": { "type": "string", "minLength": 1 },
                "tab": { "type": "integer", "minimum": 1 },
            },
            "additionalProperties": false,
        })
    );

    assert_eq!(tools[4]["description"], TYPE_TOOL_DESCRIPTION);
    assert_eq!(
        tools[4]["inputSchema"],
        json!({
            "type": "object",
            "properties": {
                "selector": { "type": "string" },
                "typed_text": { "type": "string" },
                "submit": { "type": "boolean" },
                "frame": { "type": "string", "minLength": 1 },
                "tab": { "type": "integer", "minimum": 1 },
            },
            "required": ["selector", "typed_text"],
            "additionalProperties": false,
        })
    );
    // `submit` deliberately not among the required keys: typing without Enter is the
    // normal case, and the call side fills the gap with `false`.
    assert_eq!(tools[4]["inputSchema"]["properties"]["submit"]["type"], "boolean");

    assert_eq!(tools[5]["description"], FOCUS_TOOL_DESCRIPTION);
    assert_eq!(
        tools[5]["inputSchema"],
        json!({
            "type": "object",
            "properties": { "tab": { "type": "integer", "minimum": 1 } },
            "additionalProperties": false,
        })
    );
    assert_eq!(keys_of(&tools[5]["inputSchema"]["properties"]), ["tab"]);

    // The first tool with two optional filters and no required key: a call with neither
    // is refused at the call, and `required` deliberately stays absent.
    assert_eq!(tools[6]["description"], INSPECT_TOOL_DESCRIPTION);
    assert_eq!(
        tools[6]["inputSchema"],
        json!({
            "type": "object",
            "properties": {
                "selector": { "type": "string" },
                "contains_text": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                "includeHidden": { "type": "boolean" },
                "frame": { "type": "string", "minLength": 1 },
                "tab": { "type": "integer", "minimum": 1 },
            },
            "additionalProperties": false,
        })
    );

    // `browser_open_tab` is `navigate` minus the tab: the tab it addresses does not exist
    // until it answers.
    assert_eq!(tools[7]["description"], OPEN_TAB_TOOL_DESCRIPTION);
    assert_eq!(
        tools[7]["inputSchema"],
        json!({
            "type": "object",
            "properties": { "url": { "type": "string" } },
            "required": ["url"],
            "additionalProperties": false,
        })
    );

    assert_eq!(tools[8]["description"], CLOSE_TAB_TOOL_DESCRIPTION);
    assert_eq!(
        tools[8]["inputSchema"],
        json!({
            "type": "object",
            "properties": { "tab": { "type": "integer", "minimum": 1 } },
            "additionalProperties": false,
        })
    );

    // The tenth tool: `code` is required and a string, `tab` is the optional integer seven
    // schemas already share, and there is no length — the 20 000 characters are the
    // extension's rule, not a second opinion here.
    assert_eq!(tools[9]["description"], EVAL_TOOL_DESCRIPTION);
    assert!(
        tools[9]["description"]
            .as_str()
            .expect("a description")
            .contains(EVAL_FUNCTION_BODY_SENTENCE),
        "the function-body sentence is missing: {}",
        tools[9]["description"]
    );
    assert!(
        tools[9]["description"]
            .as_str()
            .expect("a description")
            .contains("without `return` it is `null`"),
        "the `return` rule is missing: {}",
        tools[9]["description"]
    );
    assert_eq!(
        tools[9]["inputSchema"],
        json!({
            "type": "object",
            "properties": {
                "code": { "type": "string" },
                "frame": { "type": "string", "minLength": 1 },
                "tab": { "type": "integer", "minimum": 1 },
            },
            "required": ["code"],
            "additionalProperties": false,
        })
    );
    assert_eq!(keys_of(&tools[9]["inputSchema"]["properties"]), ["code", "frame", "tab"]);

    // The eleventh tool: one optional `tab` and nothing else. No `format`, no `quality`,
    // no `rect` — the ladder is the extension's contract.
    assert_eq!(tools[10]["description"], SCREENSHOT_TOOL_DESCRIPTION);
    assert_eq!(
        tools[10]["inputSchema"],
        json!({
            "type": "object",
            "properties": { "tab": { "type": "integer", "minimum": 1 } },
            "additionalProperties": false,
        })
    );

    // The twelfth: the flat frame addresses, no depth and no parent list.
    assert_eq!(tools[11]["description"], FRAMES_TOOL_DESCRIPTION);
    assert_eq!(
        tools[11]["inputSchema"],
        json!({
            "type": "object",
            "properties": { "tab": { "type": "integer", "minimum": 1 } },
            "additionalProperties": false,
        })
    );

    // The thirteenth: `read`'s window with the same bounds plus `tab`. No `mode` and no
    // `frame` — a transcript is one track file of one watch page.
    assert_eq!(tools[12]["description"], TRANSCRIPT_TOOL_DESCRIPTION);
    assert_eq!(
        tools[12]["inputSchema"],
        json!({
            "type": "object",
            "properties": {
                "offset": { "type": "integer", "minimum": 0 },
                "maxChars": { "type": "integer", "minimum": 1, "maximum": 100000 },
                "tab": { "type": "integer", "minimum": 1 },
            },
            "additionalProperties": false,
        })
    );
    assert_eq!(keys_of(&tools[12]["inputSchema"]["properties"]), ["offset", "maxChars", "tab"]);

    // No schema may be more permissive than the call side: `additionalProperties: false`
    // stands in all fourteen, and no schema gains a `required` it does not declare.
    for tool in &tools {
        assert_eq!(
            tool["inputSchema"]["additionalProperties"],
            json!(false),
            "{} must refuse undeclared arguments in its schema too",
            tool["name"]
        );
    }
    for index in [0, 2, 6, 8, 10, 11, 12] {
        assert!(
            tools[index]["inputSchema"].get("required").is_none(),
            "{} declares no required key",
            tools[index]["name"]
        );
    }

    // Eleven schemas share one `tab` property in the module; JSON makes eleven independent
    // copies on the wire, and the eleven must still agree word for word. Three take none:
    // `status` (0) reports every window, `open_tab` (7) has no tab until it answers, and
    // `browser_help` (13) answers from the bridge without touching a browser (spec 53).
    let takes_no_tab = [0, 7, 13];
    for (index, tool) in tools
        .iter()
        .enumerate()
        .filter(|(index, _)| !takes_no_tab.contains(index))
    {
        assert_eq!(
            tool["inputSchema"]["properties"]["tab"],
            json!({ "type": "integer", "minimum": 1 }),
            "{index}: {} has a different `tab`",
            tool["name"]
        );
    }
}

#[tokio::test]
async fn mcp_toolsList_shouldDeclareContainsTextAndTypedText() {
    // GIVEN a bridge with nobody connected:
    let seam = Seam::nobody(config());

    // WHEN the client asks for the tool table,
    let answer = answer_of(seam.ask(&json!({ "jsonrpc": "2.0", "id": 21, "method": "tools/list" }))).await;

    // THEN the schema of `browser_type` declares `typed_text` where it used to say `text`,
    let tools = answer["result"]["tools"].as_array().expect("a tool array");
    let schema_of = |name: &str| {
        tools
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("{name} is missing from the tool list"))
            .get("inputSchema")
            .cloned()
            .expect("every tool has a schema")
    };

    let type_schema = schema_of("browser_type");
    assert_eq!(
        keys_of(&type_schema["properties"]),
        ["selector", "typed_text", "submit", "frame", "tab"]
    );
    assert_eq!(type_schema["required"], json!(["selector", "typed_text"]));

    // ... and the schema of `browser_inspect` declares `contains_text` in its place,
    let inspect_schema = schema_of("browser_inspect");
    assert_eq!(
        keys_of(&inspect_schema["properties"]),
        ["selector", "contains_text", "limit", "includeHidden", "frame", "tab"]
    );

    // ... while no schema in the table still offers `text` as an argument: the old name is
    // gone, not a second spelling beside the new one.
    for tool in tools {
        assert!(
            tool["inputSchema"]["properties"].get("text").is_none(),
            "{} still declares `text`",
            tool["name"]
        );
    }
}

#[tokio::test]
async fn mcp_toolsListIsByteIdentical() {
    // GIVEN the recorded Node answer to `initialize` + `tools/list`:
    let artefact = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../scripts/parity/expected/1-initialize-and-tools-list.txt"
    ))
    .expect("the recorded artefact is missing — `scripts/parity/expected/1-…` is the yardstick");
    let recorded = artefact
        .lines()
        .find(|line| line.contains("\"tools\":["))
        .expect("the artefact records a tools/list answer");

    // WHEN this bridge answers the same request with the same id,
    let seam = Seam::nobody(config());
    let answer = answer_of(seam.ask(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))).await;

    // THEN the line is identical character for character — key order, backticks, the
    // two-space thousands and the schema keys included. `scripts/parity.sh`
    // comparison 1 measures the same thing through the real process; this case says why.
    assert_eq!(
        serde_json::to_string(&answer).expect("a JSON value always serialises"),
        recorded
    );
}

#[test]
fn failureTextFor_transcriptNeedsFocus_shouldUseTheExtensionMessage() {
    // GIVEN a `transcript_needs_focus` refusal with the extension's own words — the
    // visible-but-hydrating tab, whose advice is *not* "focus again":
    let with_message = HubRequestError {
        kind: FailureKind::Extension,
        message: "the extension answered ok:false code=transcript_needs_focus".to_string(),
        code: Some("transcript_needs_focus".to_string()),
        details: Some(json!({ "message": TRANSCRIPT_FOCUS_MESSAGE })),
    };

    // WHEN the sentence is built,
    // THEN the extension's message rides along, and the plain sentence is not used:
    assert_eq!(
        failure_text_for(tools::BROWSER_TRANSCRIPT, &with_message, None),
        TRANSCRIPT_NEEDS_FOCUS_WITH_MESSAGE_TEXT
    );
    assert_ne!(
        failure_text_for(tools::BROWSER_TRANSCRIPT, &with_message, None),
        TRANSCRIPT_NEEDS_FOCUS_TEXT
    );

    // ... and a refusal without a usable message keeps the plain sentence instead of
    // ending in a dangling colon.
    let without_message = HubRequestError {
        details: None,
        ..with_message
    };
    assert_eq!(
        failure_text_for(tools::BROWSER_TRANSCRIPT, &without_message, None),
        TRANSCRIPT_NEEDS_FOCUS_TEXT
    );
}

/* ----------------------------------------------------------------- status */

#[tokio::test]
async fn mcp_toolsCallBrowserStatus_withAConnectedExtension_shouldReturnTheStatusAsIndentedJsonText() {
    // GIVEN a bridge with a fake extension connected and its automatic status request
    // already answered:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client calls the one tool,
    let (answer, request) = seam
        .call_with(status_call(21), result_frame(status_result()))
        .await;

    // THEN the request that went out is the hub's own `status`, with an empty payload,
    assert_eq!(request["method"], protocol::methods::STATUS);
    assert_eq!(request["params"], json!({}));

    // ... and the answer is a text content block whose text is the result, indented with
    // two spaces and without an error flag:
    assert!(!is_error(&answer));
    assert_eq!(answer["result"]["content"].as_array().expect("content blocks").len(), 1);
    assert_eq!(answer["result"]["content"][0]["type"], "text");
    let text = text_of(&answer);
    assert_eq!(text, indented(&status_result()));
    assert!(
        text.contains("\"windows\""),
        "at least one window is expected: {text}"
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserStatus_withoutAnExtension_shouldReturnTheNoExtensionSentenceAsToolError() {
    // GIVEN a bridge with nobody on the other end:
    let mut seam = Seam::nobody(config());

    // WHEN the client calls the tool anyway,
    let answer = seam.call(status_call(22)).await;

    // THEN it gets the sentence from the contract, flagged as an error — not a JSON-RPC
    // error, because the caller should read the sentence:
    assert!(is_error(&answer));
    assert_eq!(answer["result"]["content"], json!([{ "type": "text", "text": NO_EXTENSION_TEXT }]));
    assert!(answer.get("error").is_none());
}

#[tokio::test]
async fn mcp_toolsCallBrowserStatus_whenTheExtensionStaysSilent_shouldReturnTheTimeoutSentence() {
    // GIVEN a bridge with a 300 ms call timeout and an extension that never answers:
    let mut seam = Seam::connected(short_call_config()).await;

    // WHEN the client calls the tool,
    let (answer, request) = seam.call_unanswered(status_call(23)).await;

    // THEN the timeout is reported as a tool error instead of hanging the call:
    assert_eq!(request["method"], protocol::methods::STATUS);
    assert!(is_error(&answer));
    assert_eq!(answer["result"]["content"], json!([{ "type": "text", "text": NO_ANSWER_TEXT }]));
}

#[tokio::test]
async fn mcp_toolsCallBrowserStatus_whenTheExtensionAnswersOkFalse_shouldReturnTheExtensionFailedSentenceWithTheCode() {
    // GIVEN an extension that refuses the status request with a code of its own:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client calls the tool,
    let (answer, _) = seam
        .call_with(status_call(28), error_frame("permission_denied"))
        .await;

    // THEN it gets the sentence from the contract word for word, with the code inside it:
    assert!(is_error(&answer));
    assert_eq!(
        answer["result"]["content"],
        json!([{
            "type": "text",
            "text": "The extension could not deliver the status (code=permission_denied).",
        }])
    );
    assert!(answer.get("error").is_none());
}

/* --------------------------------------------------------------- navigate */

#[tokio::test]
async fn mcp_toolsCallBrowserNavigate_withAConnectedExtension_shouldReturnAllSevenFieldsAsIndentedJsonText() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client calls `browser_navigate`,
    let (answer, request) = seam
        .call_with(
            navigate_call(50, "https://example.org/"),
            result_frame(navigate_result()),
        )
        .await;

    // THEN the request carries the URL and no tab,
    assert_eq!(request["method"], protocol::methods::NAVIGATE);
    assert_eq!(request["params"], json!({ "url": "https://example.org/" }));

    // ... and the answer is the extension's result as indented JSON, without an error
    // flag, with all five documented fields plus the settle pair:
    assert!(!is_error(&answer));
    let text = text_of(&answer);
    assert_eq!(text, indented(&navigate_result()));
    let parsed: Value = serde_json::from_str(&text).expect("the text is JSON");
    assert_eq!(
        fields_of(&parsed),
        ["tabId", "windowId", "url", "title", "complete", "settled", "waitedMs"]
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserNavigate_withoutAUrl_shouldAnswerInvalidParams() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the required `url` is missing — once not sent at all, once as a number,
    for (id, arguments) in [(51, json!({})), (52, json!({ "url": 42 }))] {
        let answer = seam
            .call(call_request(id, "browser_navigate", Some(arguments.clone())))
            .await;

        // THEN this is a malformed request, not a tool result: the schema declares `url`
        // required, so the client broke the contract before the tool ran.
        assert_eq!(error_code(&answer), Some(-32602), "{arguments}");
        assert_eq!(answer["error"]["message"], "invalid params");
        assert!(answer.get("result").is_none(), "{arguments}");
    }
    assert!(!seam.reached_the_extension(), "a malformed request costs no round trip");
}

#[tokio::test]
async fn mcp_toolsCallBrowserNavigate_withASecondArgument_shouldReturnTheOnlyUrlAndTabSentence() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call carries an argument the schema forbids — `windowId` spells the `tab`
    // intent in a name this server does not read,
    let answer = seam
        .call(call_request(
            53,
            "browser_navigate",
            Some(json!({ "url": "https://example.org/", "windowId": 1 })),
        ))
        .await;

    // THEN it is a tool error with the sentence from the contract — same precedence as
    // `browser_status`: a message for the client, not a protocol error.
    assert!(is_error(&answer));
    assert_eq!(
        answer["result"]["content"],
        json!([{ "type": "text", "text": NAVIGATE_UNEXPECTED_ARGUMENTS_TEXT }])
    );
    assert!(answer.get("error").is_none());
    assert!(
        !seam.reached_the_extension(),
        "the refused call must not reach the extension"
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserNavigate_withAFileUrl_shouldRefuseItWithoutAskingTheExtension() {
    // GIVEN a bridge with a connected extension — the counter can only prove a zero when
    // something is there to count requests:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client asks for a local file,
    let answer = seam.call(navigate_call(54, "file:///etc/passwd")).await;

    // THEN the bridge refuses it itself — the extension never hears about it:
    assert!(is_error(&answer));
    assert_eq!(answer["result"]["content"], json!([{ "type": "text", "text": INVALID_URL_TEXT }]));
    assert!(answer.get("error").is_none());
    assert!(
        !seam.reached_the_extension(),
        "the refused call must not reach the extension"
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserNavigate_withWhitespaceAroundTheUrl_shouldAcceptItLikeTheBrowserDoes() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the URL is padded the way `new URL()` trims it away — a leading space, and for the
    // open-tab shape the same value with a tab in front, which WHATWG deletes wherever it
    // sits. Both are values the browser accepted and navigated to,
    for (id, url) in [(63, " https://example.org/"), (64, "\thttps://example.org/")] {
        let (answer, request) = seam
            .call_with(navigate_call(id, url), result_frame(navigate_result()))
            .await;

        // THEN the bridge does not refuse what the browser would have loaded,
        assert!(!is_error(&answer), "{url}");
        assert_eq!(
            serde_json::from_str::<Value>(&text_of(&answer)).expect("the text is JSON"),
            navigate_result(),
            "{url}"
        );

        // ... and it sends the string as the client wrote it: trimming belongs to the check,
        // the browser parses the payload again anyway. Same payload as `navigateTool`.
        assert_eq!(request["params"]["url"], url, "{url}");
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserNavigate_whenTheExtensionRefusesTheUrl_shouldReturnTheSameSentenceFromTheContract() {
    // GIVEN an extension that refuses every navigate request with its own `invalid_url` —
    // the second floor of the same rule:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client navigates,
    let (answer, _) = seam
        .call_with(
            navigate_call(55, "https://example.org/"),
            error_frame("invalid_url"),
        )
        .await;

    // THEN the sentence is the same as the bridge's own refusal: which of the two floors
    // caught it is not the operator's problem.
    assert!(is_error(&answer));
    assert_eq!(answer["result"]["content"], json!([{ "type": "text", "text": INVALID_URL_TEXT }]));
}

#[tokio::test]
async fn mcp_toolsCallBrowserNavigate_whenTheExtensionFails_shouldReturnTheGenericSentenceWithTheCode() {
    // GIVEN an extension whose navigation fails on its side:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client navigates,
    let (answer, _) = seam
        .call_with(
            navigate_call(56, "https://example.org/"),
            error_frame("navigate_failed"),
        )
        .await;

    // THEN it gets the generic sentence with the code inside it:
    assert!(is_error(&answer));
    assert_eq!(
        answer["result"]["content"],
        json!([{ "type": "text", "text": call_extension_failed("navigate_failed") }])
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserNavigate_shouldNotSendRefusedCallsToTheExtension() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN two calls are refused — one without a URL, one with a local file,
    let missing_url = seam
        .call(call_request(60, "browser_navigate", Some(json!({}))))
        .await;
    let file_url = seam.call(navigate_call(61, "file:///etc/passwd")).await;

    // ... the first as a protocol error, the second as a tool error with the sentence
    // from the contract,
    assert_eq!(error_code(&missing_url), Some(-32602));
    assert!(is_error(&file_url));
    assert_eq!(file_url["result"]["content"], json!([{ "type": "text", "text": INVALID_URL_TEXT }]));

    // THEN neither of them reached the extension,
    assert!(
        !seam.reached_the_extension(),
        "no refused navigate request may reach the extension"
    );

    // ... and the one allowed call afterwards is the only one that does.
    let (success, request) = seam
        .call_with(
            navigate_call(62, "https://example.org/"),
            result_frame(navigate_result()),
        )
        .await;
    assert_eq!(request["method"], protocol::methods::NAVIGATE);
    assert_eq!(
        serde_json::from_str::<Value>(&text_of(&success)).expect("the text is JSON"),
        navigate_result()
    );
}

/* ------------------------------------------------------------------- read */

#[tokio::test]
async fn mcp_toolsCallBrowserRead_withAConnectedExtension_shouldReturnAllSixFieldsAsIndentedJsonText() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client calls `browser_read`,
    let (answer, request) = seam
        .call_with(read_call(70, None), result_frame(read_result()))
        .await;

    // THEN the request carries no key at all — the extension's defaults are what the
    // absent window falls back to,
    assert_eq!(request["method"], protocol::methods::READ);
    assert_eq!(request["params"], json!({}));

    // ... and the answer is the extension's result as indented JSON, with every field the
    // contract promises:
    assert!(!is_error(&answer));
    let text = text_of(&answer);
    assert_eq!(text, indented(&read_result()));
    assert_eq!(
        fields_of(&serde_json::from_str(&text).expect("the text is JSON")),
        ["tabId", "url", "title", "text", "truncated", "via"]
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_withTabIdInsteadOfTab_shouldReturnTheOnlyTabSentence() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the calls name the tab by the key the *extension answers* with (`tabId`) and
    // by a key nobody declares — `tabId` is the near-miss this case exists for;
    for (id, arguments) in [(71, json!({ "tabId": 42 })), (121, json!({ "x": 1 }))] {
        let answer = seam.call(read_call(id, Some(arguments.clone()))).await;

        // THEN each is a tool error with the sentence from the contract, not a protocol
        // error — same precedence as `browser_status`,
        assert!(is_error(&answer), "{arguments}");
        assert_eq!(
            answer["result"]["content"],
            json!([{ "type": "text", "text": READ_UNEXPECTED_ARGUMENTS_TEXT }]),
            "{arguments}"
        );
        assert!(answer.get("error").is_none(), "{arguments}");
    }

    // ... and neither refused call reached the extension.
    assert!(
        !seam.reached_the_extension(),
        "the refused call must not reach the extension"
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_whenThereIsNoAgentTab_shouldReturnTheNavigateFirstSentence() {
    // GIVEN an extension that has no agent tab to read:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads,
    let (answer, request) = seam
        .call_with(read_call(72, None), error_frame("no_agent_tab"))
        .await;

    // THEN it is advice, not a failure: the sentence names the call that fixes it,
    // ... and `call_with` only returned because a request really went to the extension:
    // the sentence comes from its code, not from the bridge guessing.
    assert_eq!(request["method"], protocol::methods::READ);
    assert!(is_error(&answer));
    assert_eq!(answer["result"]["content"], json!([{ "type": "text", "text": NO_AGENT_TAB_TEXT }]));
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_whenThePageCannotBeRead_shouldReturnTheNotReadableSentence() {
    // GIVEN a page the extension cannot inject into:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads,
    let (answer, _) = seam
        .call_with(read_call(73, None), error_frame("not_readable"))
        .await;

    // THEN the sentence explains the kind of page instead of leaking the code,
    assert!(is_error(&answer));
    assert_eq!(answer["result"]["content"], json!([{ "type": "text", "text": NOT_READABLE_TEXT }]));
    assert!(answer.get("error").is_none());
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_whenThePageIsStillLoading_shouldReturnThePageBusySentence() {
    // GIVEN an extension whose tab has not finished loading:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads,
    let (answer, _) = seam
        .call_with(read_call(116, None), error_frame("page_busy"))
        .await;

    // THEN the sentence asks for the retry that is the whole fix — and not the
    // `not_readable` sentence, which would claim the page cannot be read at all,
    assert!(is_error(&answer));
    assert_eq!(answer["result"]["content"], json!([{ "type": "text", "text": PAGE_BUSY_TEXT }]));
    assert_ne!(text_of(&answer), NOT_READABLE_TEXT);
}

/// The five shapes of a `not_readable` refusal the template table-drives: the details the
/// extension adds, and the sentence they have to produce.
fn not_readable_detail_cases() -> Vec<(&'static str, Value, &'static str)> {
    vec![
        (
            "WithAKnownKind",
            json!({ "kind": "pdf", "url": NOT_READABLE_URL }),
            NOT_READABLE_PDF_TEXT,
        ),
        (
            "WithAnUnknownKind",
            json!({ "kind": "unknown", "url": NOT_READABLE_URL }),
            NOT_READABLE_WITHOUT_KIND_TEXT,
        ),
        (
            "WithAKindOutsideTheWhitelist",
            json!({ "kind": "quatsch", "url": NOT_READABLE_URL }),
            NOT_READABLE_WITHOUT_KIND_TEXT,
        ),
        (
            "WithAKindAndAContentType",
            json!({
                "kind": "pdf",
                "url": NOT_READABLE_URL,
                "contentType": NOT_READABLE_CONTENT_TYPE,
            }),
            NOT_READABLE_PDF_WITH_TYPE_TEXT,
        ),
        (
            "WithAContentTypeButNoKind",
            json!({
                "kind": "unknown",
                "url": NOT_READABLE_URL,
                "contentType": NOT_READABLE_CONTENT_TYPE,
            }),
            NOT_READABLE_WITH_TYPE_TEXT,
        ),
    ]
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_whenNotReadableArrivesWithDetails_shouldReturnASentenceWithTheAddress() {
    for (case_name, details, sentence) in not_readable_detail_cases() {
        // GIVEN an extension that refuses the read and names the page it refused:
        let mut seam = Seam::connected(config()).await;

        // WHEN the client reads,
        let (answer, _) = seam
            .call_with(
                read_call(74, None),
                error_frame_with("not_readable", details.clone()),
            )
            .await;

        // THEN the facts the extension sent end up in the sentence — and a `kind` outside
        // the whitelist loses its type instead of gaining a soapbox:
        assert!(is_error(&answer), "{case_name}");
        assert_eq!(text_of(&answer), sentence, "{case_name}");
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_withAWindow_shouldPassExactlyTheSetKeysToTheExtension() {
    // GIVEN the window of the spec's example, and a second caller that names no window:
    let mut seam = Seam::connected(config()).await;
    let with_window = json!({ "offset": 20000, "maxChars": 100 });

    // WHEN both reads go through the tool layer,
    let (windowed_answer, windowed) = seam
        .call_with(read_call(300, Some(with_window.clone())), result_frame(read_result()))
        .await;
    let (bare_answer, bare) = seam
        .call_with(read_call(301, None), result_frame(read_result()))
        .await;

    // THEN the request carries exactly the two keys the caller set, in schema order,
    assert_eq!(windowed["method"], protocol::methods::READ);
    assert_eq!(windowed["params"], with_window);
    assert_eq!(keys_of(&windowed["params"]), ["offset", "maxChars"]);

    // ... and a read without them puts no key on the wire at all: absent, not `null` and
    // not the default, because a request that named them would claim a window nobody asked
    // for — the hub's `read` line included.
    assert_eq!(bare["params"], json!({}));
    assert!(keys_of(&bare["params"]).is_empty());

    // ... and both answers are the tool's ordinary indented JSON.
    assert_eq!(text_of(&windowed_answer), indented(&read_result()));
    assert_eq!(text_of(&bare_answer), indented(&read_result()));
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_withAWindowOfTheWrongType_shouldAnswerInvalidParamsAndReachNoExtension() {
    // GIVEN the values that look like numbers but are not the `integer` the schema
    // declares — a string and a fraction, for both window parameters:
    for arguments in [
        json!({ "offset": "5" }),
        json!({ "offset": 1.5 }),
        json!({ "maxChars": "100" }),
        json!({ "maxChars": 1.5 }),
    ] {
        // GIVEN a fresh bridge per value, so a leaked request cannot hide behind the
        // previous iteration:
        let mut seam = Seam::connected(config()).await;

        // WHEN the client reads with that argument,
        let answer = seam.call(read_call(302, Some(arguments.clone()))).await;

        // THEN it is a malformed *request* (`-32602`), because the schema says `integer`,
        assert_eq!(error_code(&answer), Some(-32602), "{arguments} must answer -32602");
        assert!(answer.get("result").is_none(), "{arguments} must not be a tool result");

        // ... and nothing reached the extension.
        assert!(
            !seam.reached_the_extension(),
            "{arguments} must not reach the extension"
        );
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_withARangeOnlyTheExtensionChecks_shouldPassItThrough() {
    // GIVEN the three values that are integers but outside the extension's ranges:
    for arguments in [json!({ "offset": -1 }), json!({ "maxChars": 0 }), json!({ "maxChars": 100001 })] {
        // GIVEN a fresh bridge per value:
        let mut seam = Seam::connected(config()).await;

        // WHEN the client reads with one of them,
        let (answer, request) = seam
            .call_with(read_call(303, Some(arguments.clone())), result_frame(read_result()))
            .await;

        // THEN the request really goes to the extension: the range check sits there, and a
        // second copy here would be a second opinion with its own drift.
        assert_eq!(request["params"], arguments, "{arguments} must travel");
        assert!(!is_error(&answer), "{arguments}");
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_withOnlyAMode_shouldPassThatOneKeyAndNoDefault() {
    // GIVEN a caller that asks for the article body and names no window:
    let mut seam = Seam::connected(config()).await;

    // WHEN the read goes through the tool layer,
    let (answer, request) = seam
        .call_with(
            read_call(304, Some(json!({ "mode": "article" }))),
            result_frame(read_result()),
        )
        .await;

    // THEN the request carries the one key the caller set — absent, not `null` and not the
    // `"text"` the extension would fall back to:
    assert_eq!(request["params"], json!({ "mode": "article" }));
    assert_eq!(keys_of(&request["params"]), ["mode"]);
    assert_eq!(text_of(&answer), indented(&read_result()));
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_withWindowAndMode_shouldPassTheThreeKeysInSchemaOrder() {
    // GIVEN a caller that names the window and the mode together — `offset: 0` is set on
    // purpose: the default has to survive as a *sent* value, not be swallowed as absent:
    let mut seam = Seam::connected(config()).await;

    // WHEN the read goes through the tool layer,
    let (_, request) = seam
        .call_with(
            read_call(
                305,
                Some(json!({ "offset": 0, "maxChars": 100, "mode": "article" })),
            ),
            result_frame(read_result()),
        )
        .await;

    // THEN exactly these three keys travel, in the order the schema declares them — the
    // wire payload reads like the tool description instead of like the caller's key order.
    assert_eq!(
        keys_of(&request["params"]),
        ["offset", "maxChars", "mode"]
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_withAModeOfTheWrongType_shouldAnswerInvalidParamsAndReachNoExtension() {
    // GIVEN the values that are not the `string` the schema declares — a number, `null`
    // and an array. A string that is not one of the two modes is *not* here: the bridge
    // checks the type, the extension checks the enum.
    for arguments in [json!({ "mode": 1 }), json!({ "mode": null }), json!({ "mode": ["article"] })] {
        let mut seam = Seam::connected(config()).await;

        // WHEN the client reads with that argument,
        let answer = seam.call(read_call(306, Some(arguments.clone()))).await;

        // THEN it is a malformed *request* (`-32602`),
        assert_eq!(error_code(&answer), Some(-32602), "{arguments} must answer -32602");
        assert!(answer.get("result").is_none(), "{arguments} must not be a tool result");

        // ... and nothing reached the extension.
        assert!(
            !seam.reached_the_extension(),
            "{arguments} must not reach the extension"
        );
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_withAnUndeclaredArgument_shouldAnswerTheFullArgumentSet() {
    // GIVEN a caller that guesses the German key instead of `mode`:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call goes through the tool layer,
    let answer = seam
        .call(read_call(307, Some(json!({ "artikel": true }))))
        .await;

    // THEN it is a tool error naming every argument the tool does accept — the sentence is
    // the caller's map back to the schema, so each key has to be in it:
    assert!(is_error(&answer));
    assert_eq!(
        answer["result"]["content"],
        json!([{ "type": "text", "text": READ_UNEXPECTED_ARGUMENTS_TEXT }])
    );
    assert!(answer.get("error").is_none());

    // ... and a forbidden key costs no round trip.
    assert!(!seam.reached_the_extension());
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_whenTheOffsetIsBehindTheText_shouldReturnASentenceNamingTheLength() {
    // GIVEN an extension that refuses the read the way the page does, with the length of
    // the whole text in the message — the number the caller pages by:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads from a place behind the end,
    let (answer, request) = seam
        .call_with(
            read_call(117, Some(json!({ "offset": 999999 }))),
            error_frame_with(
                "offset_out_of_range",
                json!({ "totalChars": 87314, "message": OFFSET_OUT_OF_RANGE_MESSAGE }),
            ),
        )
        .await;

    // THEN the sentence repeats the extension's message verbatim — a number invented here
    // would be a second measurement of a text the bridge never saw:
    assert_eq!(request["params"], json!({ "offset": 999999 }));
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), OFFSET_OUT_OF_RANGE_TEXT);
    assert!(
        text_of(&answer).contains(OFFSET_OUT_OF_RANGE_MESSAGE),
        "the length must be in the sentence"
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_whenTheWindowIsRefused_shouldReturnASentenceNamingTheBound() {
    // GIVEN an extension that refuses the window with the field and the bounds in its own
    // words:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads with a `maxChars` outside the range,
    let (answer, _) = seam
        .call_with(
            read_call(118, Some(json!({ "maxChars": 0 }))),
            error_frame_with(
                "invalid_params",
                json!({ "message": INVALID_READ_PARAMS_MESSAGE }),
            ),
        )
        .await;

    // THEN the sentence carries the extension's message — the generic `code=invalid_params`
    // catch-all names neither the field nor the bound:
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), INVALID_READ_PARAMS_TEXT);
    assert_ne!(text_of(&answer), CALL_EXTENSION_FAILED_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_withAFrame_shouldPassTheSubstringInSchemaOrder() {
    // GIVEN a caller that addresses an iframe, with the window beside it — and a second
    // one that sends the empty string, which the bridge does not judge:
    let mut seam = Seam::connected(config()).await;

    // WHEN both reads go through the tool layer,
    let (windowed_answer, windowed) = seam
        .call_with(
            read_call(
                320,
                Some(json!({ "maxChars": 100, "frame": FRAME_SUBSTRING })),
            ),
            result_frame(read_result()),
        )
        .await;
    let (_, blank) = seam
        .call_with(read_call(321, Some(json!({ "frame": "" }))), result_frame(read_result()))
        .await;

    // THEN the substring travels after `mode` and before `tab`, exactly where the schema
    // declares it:
    assert_eq!(windowed["method"], protocol::methods::READ);
    assert_eq!(
        windowed["params"],
        json!({ "maxChars": 100, "frame": FRAME_SUBSTRING })
    );
    assert_eq!(keys_of(&windowed["params"]), ["maxChars", "frame"]);

    // ... and `""` really is sent: `minLength: 1` is the schema's statement, the extension
    // is what refuses an empty substring with `invalid_params`.
    assert_eq!(blank["params"], json!({ "frame": "" }));

    // ... and the answer is the tool's ordinary indented JSON.
    assert_eq!(text_of(&windowed_answer), indented(&read_result()));
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_withAFrameOfTheWrongType_shouldAnswerInvalidParamsAndReachNoExtension() {
    // GIVEN the values that are not the `string` the schema declares — a number, `null`
    // and an array:
    for arguments in [
        json!({ "frame": 1 }),
        json!({ "frame": null }),
        json!({ "frame": [FRAME_SUBSTRING] }),
    ] {
        let mut seam = Seam::connected(config()).await;

        // WHEN the client reads with that argument,
        let answer = seam.call(read_call(322, Some(arguments.clone()))).await;

        // THEN it is a malformed *request* (`-32602`),
        assert_eq!(error_code(&answer), Some(-32602), "{arguments} must answer -32602");
        assert!(answer.get("result").is_none(), "{arguments} must not be a tool result");

        // ... and nothing reached the extension.
        assert!(
            !seam.reached_the_extension(),
            "{arguments} must not reach the extension"
        );
    }
}

/// The two colliding frame addresses a `frame_ambiguous` sentence prints.
fn frame_candidates() -> Value {
    json!([
        "https://widget.example.net/kalender/oben",
        "https://widget.example.net/kalender/unten",
    ])
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_whenTheFrameMatchesNothing_shouldReturnASentenceNamingTheAnsweredCount() {
    // GIVEN an extension that refuses the read the way the filter does, and says how many
    // frames answered:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads with a substring no frame matches, naming the tab as well,
    let (answer, request) = seam
        .call_with(
            read_call(119, Some(json!({ "tab": 42, "frame": FRAME_SUBSTRING }))),
            error_frame_with("frame_not_found", json!({ "frames": 2 })),
        )
        .await;

    // THEN the sentence is that code's own, with the count as the extension sent it —
    // not the generic catch-all, and not the shorter sentence:
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), FRAME_NOT_FOUND_WITH_COUNT_TEXT);
    assert_ne!(text_of(&answer), FRAME_NOT_FOUND_TEXT);
    assert!(answer.get("error").is_none());

    // ... and the request carried both arguments, in schema order.
    assert_eq!(request["params"], json!({ "frame": FRAME_SUBSTRING, "tab": 42 }));
    assert_eq!(keys_of(&request["params"]), ["frame", "tab"]);
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_whenTheAnsweredFrameCountIsAWholeFloat_shouldStillPrintIt() {
    // GIVEN an extension that sends the count as `3.0` — `serde_json` keeps it a float where
    // `JSON.parse` makes it the integer `3`, and `Number.isInteger(3.0)` is `true`:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads with a substring no frame matches,
    let (answer, _) = seam
        .call_with(
            read_call(120, Some(json!({ "frame": FRAME_SUBSTRING }))),
            error_frame_with("frame_not_found", json!({ "frames": 3.0 })),
        )
        .await;

    // THEN the count is printed, the way the template prints it, instead of falling back to
    // the shorter sentence that claims the extension sent no count at all,
    assert!(is_error(&answer));
    assert_eq!(
        text_of(&answer),
        r#"No frame matches this `frame` — check the addresses with browser_frames (frames that answered: 3)."#
    );
    assert_ne!(text_of(&answer), FRAME_NOT_FOUND_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_whenTwoFramesMatch_shouldReturnASentenceNamingTheCandidates() {
    // GIVEN an extension that refuses the read because the substring is ambiguous, with the
    // addresses that collided:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads with it,
    let (answer, request) = seam
        .call_with(
            read_call(120, Some(json!({ "frame": FRAME_SUBSTRING }))),
            error_frame_with("frame_ambiguous", json!({ "candidates": frame_candidates() })),
        )
        .await;

    // THEN the sentence names them, separated by a comma and a space,
    assert_eq!(request["params"], json!({ "frame": FRAME_SUBSTRING }));
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), FRAME_AMBIGUOUS_WITH_CANDIDATES_TEXT);
    assert_ne!(text_of(&answer), FRAME_AMBIGUOUS_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserRead_withAFrameAndNoDetailsInTheRefusal_shouldAnswerTheShorterSentence() {
    // GIVEN an extension that refuses the read without saying anything about the frames:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads with a frame substring,
    let (answer, _) = seam
        .call_with(
            read_call(121, Some(json!({ "frame": FRAME_SUBSTRING }))),
            error_frame("frame_not_found"),
        )
        .await;

    // THEN the shorter sentence stands: the bridge never counts frames it cannot see.
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), FRAME_NOT_FOUND_TEXT);
    assert_ne!(text_of(&answer), FRAME_NOT_FOUND_WITH_COUNT_TEXT);
}

/* ------------------------------------------------------------------ click */

/// `The extension could not carry out the request (code=…).` — the generic sentence, with
/// the code the extension answered. Spelled out here, not imported.
fn call_extension_failed(code: &str) -> String {
    format!("The extension could not carry out the request (code={code}).")
}

/// The four codes a refused click answers with, each naming the selector the caller sent.
const CLICK_REFUSAL_CASES: [(&str, &str); 4] = [
    ("invalid_selector", INVALID_SELECTOR_TEXT),
    ("no_match", NO_MATCH_TEXT),
    ("not_clickable", NOT_CLICKABLE_TEXT),
    ("offscreen_after_scroll", OFFSCREEN_AFTER_SCROLL_TEXT),
];

#[tokio::test]
async fn mcp_toolsCallBrowserClick_withAConnectedExtension_shouldReturnAllNineFieldsAsIndentedJsonText() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client clicks a selector,
    let (answer, request) = seam
        .call_with(
            click_call(80, CLICK_SELECTOR),
            result_frame(click_result()),
        )
        .await;

    // THEN the request carries the selector and nothing else,
    assert_eq!(request["method"], protocol::methods::CLICK);
    assert_eq!(request["params"], json!({ "selector": CLICK_SELECTOR }));

    // ... and the answer is the extension's result as indented JSON, with all nine fields
    // the contract promises:
    assert!(!is_error(&answer));
    let text = text_of(&answer);
    assert_eq!(text, indented(&click_result()));
    assert_eq!(
        fields_of(&serde_json::from_str(&text).expect("the text is JSON")),
        ["tabId", "url", "title", "clicked", "text", "truncated", "via", "settled", "waitedMs"]
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserClick_withoutAUsableSelector_shouldAnswerInvalidParamsAndNeverReachTheExtension() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call carries a selector that is not the string the schema declares (the
    // missing target is a tool error now, `docs/60`),
    let arguments = json!({ "selector": 7 });
    let answer = seam
        .call(call_request(81, "browser_click", Some(arguments.clone())))
        .await;

    // THEN it is a protocol error: the schema states the type,
    assert_eq!(error_code(&answer), Some(-32602), "{arguments}");
    assert!(answer.get("result").is_none(), "{arguments}");

    // ... and it did not reach the extension,
    assert!(!seam.reached_the_extension(), "no click request may reach the extension");

    // ... while the allowed call afterwards is the one that does.
    let (success, _) = seam
        .call_with(
            click_call(83, CLICK_SELECTOR),
            result_frame(click_result()),
        )
        .await;
    assert_eq!(
        serde_json::from_str::<Value>(&text_of(&success)).expect("the text is JSON"),
        click_result()
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserClick_withAnUnknownArgument_shouldReturnTheOnlySelectorAndTabSentence() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call carries an argument the schema forbids,
    let answer = seam
        .call(call_request(
            84,
            "browser_click",
            Some(json!({ "selector": CLICK_SELECTOR, "x": 1 })),
        ))
        .await;

    // THEN it is a tool error with the sentence from the contract, not a protocol error —
    // the request itself was well-formed,
    assert!(is_error(&answer));
    assert_eq!(
        answer["result"]["content"],
        json!([{ "type": "text", "text": CLICK_UNEXPECTED_ARGUMENTS_TEXT }])
    );
    assert!(answer.get("error").is_none());

    // ... and the refused call never reached the extension.
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

#[tokio::test]
async fn mcp_toolsCallBrowserClick_withContainsText_shouldSendTextOnTheWire() {
    // GIVEN a bridge with a connected extension, and the term a caller clicks by:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client clicks with the name the schema declares,
    let (answer, request) = seam
        .call_with(
            call_request(
                370,
                "browser_click",
                Some(json!({ "contains_text": CLICK_TEXT })),
            ),
            result_frame(click_result()),
        )
        .await;

    // THEN the wire carries `text` — the page op's name (`docs/58`, `docs/60`) — while the
    // MCP name stays behind in the bridge,
    assert_eq!(request["method"], protocol::methods::CLICK);
    assert_eq!(request["params"], json!({ "text": CLICK_TEXT }));
    assert_eq!(keys_of(&request["params"]), ["text"]);
    assert!(
        request["params"].get("contains_text").is_none(),
        "the MCP name must not reach the wire: {request}"
    );

    // ... and the call is a normal answer, not a sentence about a missing target.
    assert!(!is_error(&answer));
}

#[tokio::test]
async fn mcp_toolsCallBrowserClick_withSelectorAndContainsText_shouldSendBoth() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client names both targets — allowed since `docs/60`, the selector narrows
    // the text search in the page,
    let (answer, request) = seam
        .call_with(
            call_request(
                371,
                "browser_click",
                Some(json!({ "selector": CLICK_SELECTOR, "contains_text": CLICK_TEXT })),
            ),
            result_frame(click_result()),
        )
        .await;

    // THEN both keys travel, in schema order, and only the term under its wire name,
    assert_eq!(
        request["params"],
        json!({ "selector": CLICK_SELECTOR, "text": CLICK_TEXT })
    );
    assert_eq!(keys_of(&request["params"]), ["selector", "text"]);
    assert!(!is_error(&answer));
}

#[tokio::test]
async fn mcp_toolsCallBrowserClick_withoutAnyTarget_shouldSayClickNeedsFilter() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call names no target at all (this is the `{}` half of the invalid-params case,
    // moved here by `docs/60`: the request is well-formed, the sentence is the answer),
    let answer = seam
        .call(call_request(372, "browser_click", Some(json!({}))))
        .await;

    // THEN it is a tool error whose sentence names both arguments, not a protocol error,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), CLICK_NEEDS_FILTER_TEXT);
    assert_ne!(text_of(&answer), CLICK_UNEXPECTED_ARGUMENTS_TEXT);
    assert!(answer.get("error").is_none());
    assert!(text_of(&answer).contains("`selector`"));
    assert!(text_of(&answer).contains("`contains_text`"));

    // ... and the refused call never reached the extension: the hub counts no request.
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

#[tokio::test]
async fn mcp_toolsCallBrowserClick_withAnEmptyContainsText_shouldSayClickNeedsFilter() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the term is the empty string — a click target without text is none (`docs/58`),
    let answer = seam
        .call(call_request(
            373,
            "browser_click",
            Some(json!({ "contains_text": "" })),
        ))
        .await;

    // THEN the sentence names the two arguments before anything is sent,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), CLICK_NEEDS_FILTER_TEXT);
    assert!(answer.get("error").is_none());
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

#[tokio::test]
async fn mcp_toolsCallBrowserClick_withTextAmbiguous_shouldNameCountCandidatesAndAdvice() {
    // GIVEN an extension that found two elements carrying the term, and names both:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client clicks by that term,
    let (answer, request) = seam
        .call_with(
            call_request(
                374,
                "browser_click",
                Some(json!({ "contains_text": CLICK_TEXT })),
            ),
            error_frame_with(
                "text_ambiguous",
                json!({ "matches": 2, "candidates": [CLICK_CANDIDATE_ONE, CLICK_CANDIDATE_TWO] }),
            ),
        )
        .await;

    // THEN the request carried the term the sentence has to quote,
    assert_eq!(request["params"], json!({ "text": CLICK_TEXT }));

    // ... and the sentence carries the evidence as prose: term, count, both candidates and
    // the advice — a tool error is one text block, so fields would never reach the agent,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), CLICK_AMBIGUOUS_TEXT);
    assert!(text_of(&answer).contains(CLICK_TEXT));
    assert!(text_of(&answer).contains(CLICK_CANDIDATE_ONE));
    assert!(text_of(&answer).contains(CLICK_CANDIDATE_TWO));
    assert!(text_of(&answer).contains("browser_inspect"));
    assert_ne!(text_of(&answer), call_extension_failed("text_ambiguous"));

    // WHEN the run stopped at the candidate cap and the frame says so,
    let (at_cap, _) = seam
        .call_with(
            call_request(
                375,
                "browser_click",
                Some(json!({ "contains_text": CLICK_TEXT })),
            ),
            error_frame_with(
                "text_ambiguous",
                json!({
                    "matches": 5,
                    "candidates": [CLICK_CANDIDATE_ONE, CLICK_CANDIDATE_TWO],
                    "truncated": true,
                }),
            ),
        )
        .await;

    // THEN the same sentence words the count as a lower bound (`docs/58`, `## Ziel` 5),
    assert!(is_error(&at_cap));
    assert_eq!(text_of(&at_cap), CLICK_AMBIGUOUS_AT_CAP_TEXT);
    assert!(text_of(&at_cap).contains("at least 5"));
}

#[tokio::test]
async fn mcp_toolsCallBrowserClick_withNoMatchForATerm_shouldNameTheTerm() {
    // GIVEN an extension whose text search found nothing:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client clicks by a term alone,
    let (answer, request) = seam
        .call_with(
            call_request(
                376,
                "browser_click",
                Some(json!({ "contains_text": CLICK_MISSING_TERM })),
            ),
            error_frame("no_match"),
        )
        .await;

    // THEN the request carried only the term,
    assert_eq!(request["params"], json!({ "text": CLICK_MISSING_TERM }));

    // ... and the sentence names the term, not the selector the caller never sent — the
    // word `undefined` is what the selector form would print (`docs/60`, criterion 5),
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), CLICK_NO_MATCH_FOR_TEXT);
    assert!(text_of(&answer).contains(CLICK_MISSING_TERM));
    assert!(!text_of(&answer).contains("undefined"));
}

#[tokio::test]
async fn mcp_toolsList_shouldDeclareContainsTextForClick() {
    // GIVEN a bridge with nobody connected:
    let seam = Seam::nobody(config());

    // WHEN the client asks for the tool table,
    let answer = answer_of(seam.ask(&json!({ "jsonrpc": "2.0", "id": 377, "method": "tools/list" }))).await;

    // THEN `browser_click` declares the term as a string, in schema order after `selector`,
    let click = answer["result"]["tools"]
        .as_array()
        .expect("the answer carries a tool array")
        .iter()
        .find(|tool| tool["name"] == "browser_click")
        .cloned()
        .expect("the tool table carries browser_click");
    assert_eq!(
        keys_of(&click["inputSchema"]["properties"]),
        ["selector", "contains_text", "frame", "tab"]
    );
    assert_eq!(
        click["inputSchema"]["properties"]["contains_text"],
        json!({ "type": "string" })
    );

    // ... and neither target is required: `{}` is the schema's business no longer, the
    // sentence is (`docs/60`, `## Der Vertrag`).
    assert!(click["inputSchema"].get("required").is_none());
}

#[tokio::test]
async fn mcp_toolsCallBrowserClick_whenTheExtensionAnswersARefusal_shouldReturnTheSentenceForThatCode() {
    for (code, sentence) in CLICK_REFUSAL_CASES {
        // GIVEN an extension that refuses the click with exactly this code:
        let mut seam = Seam::connected(config()).await;

        // WHEN the client clicks,
        let (answer, request) = seam
            .call_with(click_call(85, CLICK_SELECTOR), error_frame(code))
            .await;

        // THEN it gets the sentence that names the selector it sent — not the code, and not
        // the generic catch-all,
        assert_eq!(request["params"], json!({ "selector": CLICK_SELECTOR }), "{code}");
        assert!(is_error(&answer), "{code}");
        assert_eq!(text_of(&answer), sentence, "{code}");
        assert!(answer.get("error").is_none(), "{code}");
    }
}

// No `mcp_toolsCallBrowser…` prefix on purpose: criterion 5 of `docs/56` filters this
// case with `--exact`, so the name is a contract as it stands.
#[tokio::test]
async fn click_withOffscreenAfterScroll_shouldNameTheTarget() {
    // GIVEN an extension whose click scrolled the page and still did not reach the target —
    // the Amazon case of `docs/56`, where the element sits at `x = -9966` and stays there:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client clicks,
    let (answer, request) = seam
        .call_with(
            click_call(118, CLICK_SELECTOR),
            error_frame("offscreen_after_scroll"),
        )
        .await;

    // THEN the request carried the selector the sentence has to name,
    assert_eq!(request["params"], json!({ "selector": CLICK_SELECTOR }));

    // ... and the sentence names the target instead of falling back to the generic one that
    // only repeats the code — the fourth refusal reason has a sentence of its own,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), OFFSCREEN_AFTER_SCROLL_TEXT);
    assert_ne!(text_of(&answer), call_extension_failed("offscreen_after_scroll"));

    // ... and it is a tool error with a sentence, not a protocol error with an error object.
    assert!(answer.get("error").is_none());
}

#[tokio::test]
async fn click_withNotReadableAfterClick_shouldNameTheReturnPath() {
    // GIVEN a click that went through onto a page the extension cannot inject into — the
    // ad server of `docs/61`, whose viewer is unreadable while the click itself worked:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client clicks and the extension answers with the code it minted after the
    // click, the address it landed on and the kind that address names,
    let (answer, request) = seam
        .call_with(
            click_call(119, CLICK_SELECTOR),
            error_frame_with(
                "not_readable_after_click",
                json!({ "url": NOT_READABLE_URL, "kind": "pdf" }),
            ),
        )
        .await;

    // THEN the request was the plain click the sentence must not talk about,
    assert_eq!(request["params"], json!({ "selector": CLICK_SELECTOR }));

    // ... and the sentence says the click went through and names the way back, instead of
    // the plain `not_readable` sentence `read` keeps — those two would send the agent
    // back to the same selector. The comparison is against the sentence `not_readable`
    // would give for *these* details (`url` and `kind`), not against the bare one: with
    // the frame carrying both fields, the fallback `NOT_READABLE_TEXT` cannot appear and
    // a `assert_ne!` on it would hold whatever the text said.
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), NOT_READABLE_AFTER_CLICK_TEXT);
    assert_ne!(text_of(&answer), NOT_READABLE_PDF_TEXT);

    // ... as a tool error with a sentence, not a protocol error with an error object.
    assert!(answer.get("error").is_none());
}

// No `mcp_toolsCallBrowser…` prefix on purpose: criterion 3 of `docs/63` filters this case
// with `--exact`, so the name is a contract as it stands.
#[tokio::test]
async fn click_withClickOutcomeUnknown_shouldNameTheUncertainty() {
    // GIVEN a click whose own request got no answer — the page may have been clicked, and
    // the extension cannot tell whether it was (`docs/63`):
    let mut seam = Seam::connected(config()).await;

    // WHEN the client clicks and the extension answers with that code, the address it
    // attempted and no `clicked` at all,
    let (answer, request) = seam
        .call_with(
            click_call(120, CLICK_SELECTOR),
            error_frame_with("click_outcome_unknown", json!({ "url": "https://example.org/" })),
        )
        .await;

    // THEN the request was the plain click the sentence must not talk about,
    assert_eq!(request["params"], json!({ "selector": CLICK_SELECTOR }));

    // ... and the sentence names the uncertainty and the check before the next click,
    // instead of the generic "could not carry out" that would invite a blind repeat,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), CLICK_OUTCOME_UNKNOWN_TEXT);
    assert_ne!(text_of(&answer), call_extension_failed("click_outcome_unknown"));

    // ... as a tool error with a sentence, not a protocol error with an error object.
    assert!(answer.get("error").is_none());
}

#[tokio::test]
async fn mcp_toolsCallBrowserClick_whenThereIsNoAgentTab_shouldReturnTheSameSentenceAsBrowserRead() {
    // GIVEN an extension that has no agent tab to click in:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client clicks,
    let (answer, _) = seam
        .call_with(click_call(86, CLICK_SELECTOR), error_frame("no_agent_tab"))
        .await;

    // THEN it is the advice `browser_read` gives, word for word:
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), NO_AGENT_TAB_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserClick_whenThePageIsStillLoading_shouldReturnThePageBusySentence() {
    // GIVEN an extension whose tab has not finished loading:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client clicks,
    let (answer, _) = seam
        .call_with(click_call(117, CLICK_SELECTOR), error_frame("page_busy"))
        .await;

    // THEN it gets the same sentence `browser_read` gives:
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), PAGE_BUSY_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserClick_whenTheClickWasSuperseded_shouldReturnTheGenericSentenceWithTheCode() {
    // GIVEN an extension whose click was replaced by a newer one:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client clicks,
    let (answer, _) = seam
        .call_with(click_call(87, CLICK_SELECTOR), error_frame("superseded"))
        .await;

    // THEN it gets the generic sentence with the code inside it — `superseded` is not
    // advice the operator could act on, so it keeps its code:
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), call_extension_failed("superseded"));
}

/* ------------------------------------------------------------------- type */

/// The three refusals `type` translates, and the sentence each one produces.
const TYPE_REFUSAL_CASES: [(&str, &str); 3] = [
    ("no_match", TYPE_NO_MATCH_TEXT),
    ("not_typeable", NOT_TYPEABLE_TEXT),
    ("password_not_allowed", PASSWORD_NOT_ALLOWED_TEXT),
];

#[tokio::test]
async fn mcp_toolsCallBrowserType_withTypedText_shouldSendTextOnTheWire() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client writes with the name from the contract,
    let (answer, request) = seam
        .call_with(
            type_call(347, TYPE_SELECTOR, TYPE_TEXT),
            result_frame(type_result()),
        )
        .await;

    // THEN the wire carries `text` — the name the extension reads — in the schema order,
    assert_eq!(request["method"], protocol::methods::TYPE);
    assert_eq!(
        request["params"],
        json!({ "selector": TYPE_SELECTOR, "text": TYPE_TEXT, "submit": false })
    );
    assert_eq!(keys_of(&request["params"]), ["selector", "text", "submit"]);
    assert!(
        request["params"].get("typed_text").is_none(),
        "the new name must not reach the wire: {request}"
    );

    // ... and the writing call is a normal answer, not a refusal about an argument.
    assert!(!is_error(&answer));
}

#[tokio::test]
async fn mcp_toolsCallBrowserType_withAConnectedExtension_shouldReturnAllEightFieldsAsIndentedJsonText() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client types into a field — without `submit`, which is the normal case and
    // has to work without a third argument:
    let (answer, request) = seam
        .call_with(
            type_call(90, TYPE_SELECTOR, TYPE_TEXT),
            result_frame(type_result()),
        )
        .await;

    // THEN the request names the missing `submit` as `false` rather than leaving it out —
    // the wire format documents that default, and a request that names all three keys is
    // easier to read in a log,
    assert_eq!(request["method"], protocol::methods::TYPE);
    assert_eq!(
        request["params"],
        json!({ "selector": TYPE_SELECTOR, "text": TYPE_TEXT, "submit": false })
    );

    // ... and the answer is the extension's result as indented JSON, with every field:
    assert!(!is_error(&answer));
    let text = text_of(&answer);
    assert_eq!(text, indented(&type_result()));
    assert_eq!(
        fields_of(&serde_json::from_str(&text).expect("the text is JSON")),
        ["tabId", "url", "title", "typed", "submitted", "text", "truncated", "via"]
    );

    // ... and the text that was typed is not in it: `typed` describes the element, never
    // the value, so the answer cannot become a second log of the input.
    assert!(!text.contains(TYPE_TEXT), "the typed text must not appear in the answer");
}

#[tokio::test]
async fn mcp_toolsCallBrowserType_withoutAUsableText_shouldAnswerInvalidParamsAndNeverReachTheExtension() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN two calls are refused — one without a text, one with a text that is not a string,
    for (id, arguments) in [
        (91, json!({ "selector": TYPE_SELECTOR })),
        (92, json!({ "selector": TYPE_SELECTOR, "typed_text": 7 })),
    ] {
        let answer = seam.call(call_request(id, "browser_type", Some(arguments.clone()))).await;

        // THEN both are protocol errors: the schema declares `text` required,
        assert_eq!(error_code(&answer), Some(-32602), "{arguments}");
        assert!(answer.get("result").is_none(), "{arguments}");
    }

    // ... and neither of them reached the extension,
    assert!(!seam.reached_the_extension(), "no type request may reach the extension");

    // ... while the allowed call afterwards is the one that does.
    let (success, _) = seam
        .call_with(
            type_call(93, TYPE_SELECTOR, TYPE_TEXT),
            result_frame(type_result()),
        )
        .await;
    assert_eq!(
        serde_json::from_str::<Value>(&text_of(&success)).expect("the text is JSON"),
        type_result()
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserType_withASubmitThatIsNotABoolean_shouldAnswerInvalidParamsInsteadOfBlamingTheExtension() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN `submit` arrives as the string a sloppy client likes to send,
    let answer = seam
        .call(call_request(
            94,
            "browser_type",
            Some(json!({ "selector": TYPE_SELECTOR, "typed_text": TYPE_TEXT, "submit": "true" })),
        ))
        .await;

    // THEN it is a malformed request, not a tool error: letting it through would come back
    // as "the extension could not run the request", which blames the wrong side of the wire
    // for a client mistake,
    assert_eq!(error_code(&answer), Some(-32602));
    assert_eq!(answer["error"]["message"], "invalid params");
    assert!(answer.get("result").is_none());

    // ... and the refused call never reached the extension,
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");

    // ... while the same call with a real boolean is the one that does.
    let (accepted, request) = seam
        .call_with(
            call_request(
                95,
                "browser_type",
                Some(json!({ "selector": TYPE_SELECTOR, "typed_text": TYPE_TEXT, "submit": true })),
            ),
            result_frame(type_result()),
        )
        .await;
    assert_eq!(request["params"]["submit"], json!(true));
    assert_eq!(
        serde_json::from_str::<Value>(&text_of(&accepted)).expect("the text is JSON"),
        type_result()
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserType_withAnUnknownArgument_shouldNameTypedText() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call carries an argument the schema forbids — `text` is the name this tool
    // took before `docs/59` (alone, as the sloppy client of the spec writes it, and beside
    // the new name), and `enter` spells the intent of `submit`:
    for (id, arguments) in [
        (117, json!({ "selector": TYPE_SELECTOR, "text": TYPE_TEXT })),
        (
            96,
            json!({ "selector": TYPE_SELECTOR, "typed_text": TYPE_TEXT, "text": TYPE_TEXT }),
        ),
        (
            116,
            json!({ "selector": TYPE_SELECTOR, "typed_text": TYPE_TEXT, "enter": true }),
        ),
    ] {
        let answer = seam
            .call(call_request(id, "browser_type", Some(arguments.clone())))
            .await;

        // THEN it is a tool error with the sentence from the contract, and that sentence
        // names the argument that writes — `typed_text`, not the old name:
        assert!(is_error(&answer), "{arguments}");
        assert_eq!(text_of(&answer), TYPE_UNEXPECTED_ARGUMENTS_TEXT, "{arguments}");
        assert!(text_of(&answer).contains("`typed_text`"), "{arguments}");
        assert!(answer.get("error").is_none(), "{arguments}");
    }

    // ... and none of the refused calls reached the extension.
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

#[tokio::test]
async fn mcp_toolsCallBrowserType_whenTheExtensionAnswersARefusal_shouldReturnTheSentenceForThatCode() {
    for (code, sentence) in TYPE_REFUSAL_CASES {
        // GIVEN an extension that refuses the type call with exactly this code:
        let mut seam = Seam::connected(config()).await;

        // WHEN the client types,
        let (answer, _) = seam
            .call_with(
                type_call(97, TYPE_SELECTOR, TYPE_TEXT),
                error_frame(code),
            )
            .await;

        // THEN it gets the sentence for that code — not the code, and not the generic
        // catch-all,
        assert!(is_error(&answer), "{code}");
        assert_eq!(text_of(&answer), sentence, "{code}");
        assert!(answer.get("error").is_none(), "{code}");
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserType_whenThereIsNoAgentTab_shouldReturnTheSameSentenceAsBrowserRead() {
    // GIVEN an extension that has no agent tab to type in:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client types,
    let (answer, _) = seam
        .call_with(
            type_call(98, TYPE_SELECTOR, TYPE_TEXT),
            error_frame("no_agent_tab"),
        )
        .await;

    // THEN it is the advice `browser_read` gives, word for word:
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), NO_AGENT_TAB_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserType_whenThePageIsStillLoading_shouldReturnThePageBusySentence() {
    // GIVEN an extension whose tab has not finished loading:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client types,
    let (answer, _) = seam
        .call_with(
            type_call(118, TYPE_SELECTOR, TYPE_TEXT),
            error_frame("page_busy"),
        )
        .await;

    // THEN it gets the same sentence `browser_read` and `browser_click` give:
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), PAGE_BUSY_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserType_whenTheTypeCallWasSuperseded_shouldReturnTheGenericSentenceWithTheCode() {
    // GIVEN an extension whose type call is replaced by a newer one:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client types,
    let (answer, _) = seam
        .call_with(
            type_call(99, TYPE_SELECTOR, TYPE_TEXT),
            error_frame("superseded"),
        )
        .await;

    // THEN it gets the generic sentence with the code inside it:
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), call_extension_failed("superseded"));
}

/* ------------------------------------------------------------------ focus */

#[tokio::test]
async fn mcp_toolsCallBrowserFocus_withAConnectedExtension_shouldReturnAllSixFieldsAsIndentedJsonText() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client calls `browser_focus`,
    let (answer, request) = seam
        .call_with(focus_call(100), result_frame(focus_result()))
        .await;

    // THEN an otherwise empty payload goes out — no tab was named,
    assert_eq!(request["method"], protocol::methods::FOCUS);
    assert_eq!(request["params"], json!({}));

    // ... and the answer is the extension's result as indented JSON, with every field:
    assert!(!is_error(&answer));
    let text = text_of(&answer);
    assert_eq!(text, indented(&focus_result()));
    assert_eq!(
        fields_of(&serde_json::from_str(&text).expect("the text is JSON")),
        ["tabId", "windowId", "url", "title", "active", "focused"]
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserFocus_withAnArgument_shouldReturnTheOnlyTabSentence() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call carries an argument the schema forbids,
    let answer = seam
        .call(call_request(101, "browser_focus", Some(json!({ "x": 1 }))))
        .await;

    // THEN it is a tool error with the sentence from the contract,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), FOCUS_UNEXPECTED_ARGUMENTS_TEXT);
    assert!(answer.get("error").is_none());

    // ... and the refused call never reached the extension.
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

#[tokio::test]
async fn mcp_toolsCallBrowserFocus_whenThereIsNoAgentTab_shouldReturnTheSameSentenceAsBrowserRead() {
    // GIVEN an extension with no agent tab to bring forward:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client focuses,
    let (answer, _) = seam
        .call_with(focus_call(102), error_frame("no_agent_tab"))
        .await;

    // THEN it is advice, not a failure:
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), NO_AGENT_TAB_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserFocus_whenTheFocusFailed_shouldReturnTheGenericSentenceWithTheCode() {
    // GIVEN an extension whose `tabs.update` threw:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client focuses,
    let (answer, _) = seam
        .call_with(focus_call(103), error_frame("focus_failed"))
        .await;

    // THEN the generic sentence carries the code: the bridge cannot tell why the tab did not
    // come forward, and inventing advice would be a guess,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), FOCUS_FAILED_TEXT);
    assert_eq!(text_of(&answer), call_extension_failed("focus_failed"));
}

/* ---------------------------------------------------------------- inspect */

#[tokio::test]
async fn mcp_toolsCallBrowserInspect_withAConnectedExtension_shouldReturnAllSixResultFieldsAndEveryElementField() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client asks for the elements behind a selector,
    let (answer, request) = seam
        .call_with(
            inspect_call(110, json!({ "selector": INSPECT_SELECTOR })),
            result_frame(inspect_result()),
        )
        .await;

    // THEN only the key the caller set travels — the extension fills `limit` and
    // `includeHidden` with its defaults, and a request that named them would make the hub's
    // log line claim a limit nobody asked for,
    assert_eq!(request["method"], protocol::methods::INSPECT);
    assert_eq!(request["params"], json!({ "selector": INSPECT_SELECTOR }));

    // ... and the answer is the extension's result as indented JSON, down to the element:
    assert!(!is_error(&answer));
    let text = text_of(&answer);
    assert_eq!(text, indented(&inspect_result()));
    let parsed: Value = serde_json::from_str(&text).expect("the text is JSON");
    assert_eq!(
        fields_of(&parsed),
        ["tabId", "url", "title", "count", "truncated", "elements"]
    );
    assert_eq!(
        fields_of(&parsed["elements"][0]),
        [
            "index", "selector", "tag", "id", "classes", "href", "text", "visible",
        ]
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserInspect_withoutAnyFilter_shouldSayContainsText() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN two calls arrive with nothing to search for — one with `{}`, one with no
    // arguments at all,
    for (id, arguments) in [(111, Some(json!({}))), (112, None)] {
        let answer = seam
            .call(call_request(id, "browser_inspect", arguments.clone()))
            .await;

        // THEN it is a tool error naming the two arguments the tool needs, with the search
        // filter under the name from the contract:
        assert!(is_error(&answer), "{arguments:?}");
        assert_eq!(text_of(&answer), INSPECT_NEEDS_FILTER_TEXT, "{arguments:?}");
        assert!(text_of(&answer).contains("`contains_text`"), "{arguments:?}");
        assert!(answer.get("error").is_none(), "{arguments:?}");
    }

    // ... and no call with nothing to search for reached the page.
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

#[tokio::test]
async fn mcp_toolsCallBrowserInspect_whenTheExtensionAnswersInvalidSelector_shouldReturnTheSentenceWithTheSelector() {
    // GIVEN an extension whose `querySelector` threw:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client inspects,
    let (answer, _) = seam
        .call_with(
            inspect_call(113, json!({ "selector": INSPECT_SELECTOR })),
            error_frame("invalid_selector"),
        )
        .await;

    // THEN the sentence names the selector the caller sent — the value it has to correct,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), INSPECT_INVALID_SELECTOR_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserInspect_whenTheExtensionAnswersInvalidParams_shouldReturnItsOwnSentenceInsteadOfTheGenericOne() {
    // GIVEN an extension that refuses a `limit` outside 1–200:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client inspects with that limit,
    let (answer, request) = seam
        .call_with(
            inspect_call(
                115,
                json!({ "selector": INSPECT_SELECTOR, "limit": 201 }),
            ),
            error_frame("invalid_params"),
        )
        .await;

    // THEN it is the tool's own sentence, which names no field at all — the hub forwards only
    // the code, and the bridge refuses to invent a field name it did not check,
    assert_eq!(request["params"], json!({ "selector": INSPECT_SELECTOR, "limit": 201 }));
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), INSPECT_INVALID_PARAMS_TEXT);
    assert_ne!(text_of(&answer), call_extension_failed("invalid_params"));
}

#[tokio::test]
async fn mcp_toolsCallBrowserInspect_whenNotReadableArrivesWithDetails_shouldReturnASentenceWithTheAddress() {
    for (case_name, details, sentence) in not_readable_detail_cases() {
        // GIVEN an extension that refuses the inspect with the page's details:
        let mut seam = Seam::connected(config()).await;

        // WHEN the client inspects,
        let (answer, _) = seam
            .call_with(
                inspect_call(114, json!({ "selector": INSPECT_SELECTOR })),
                error_frame_with("not_readable", details.clone()),
            )
            .await;

        // THEN one page, one sentence, whichever tool walked into it:
        assert!(is_error(&answer), "{case_name}");
        assert_eq!(text_of(&answer), sentence, "{case_name}");
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserInspect_whenThereIsNoAgentTab_shouldReturnTheSameSentenceAsBrowserRead() {
    // GIVEN an extension with no agent tab to inspect:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client inspects,
    let (answer, _) = seam
        .call_with(
            inspect_call(114, json!({ "selector": INSPECT_SELECTOR })),
            error_frame("no_agent_tab"),
        )
        .await;

    // THEN it is the advice `browser_read` gives:
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), NO_AGENT_TAB_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserInspect_whenThePageIsStillLoading_shouldReturnThePageBusySentence() {
    // GIVEN an extension whose tab has not finished loading:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client inspects,
    let (answer, _) = seam
        .call_with(
            inspect_call(119, json!({ "selector": INSPECT_SELECTOR })),
            error_frame("page_busy"),
        )
        .await;

    // THEN it gets the same sentence the other page-reading tools give:
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), PAGE_BUSY_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserInspect_withAFrame_shouldPassTheSubstringInSchemaOrder() {
    // GIVEN a caller that addresses an iframe beside its other filters, and a second one
    // that names no frame at all:
    let mut seam = Seam::connected(config()).await;

    // WHEN both calls go through the tool layer,
    let (_, framed) = seam
        .call_with(
            inspect_call(
                340,
                json!({ "selector": INSPECT_SELECTOR, "limit": 5, "frame": FRAME_SUBSTRING }),
            ),
            result_frame(inspect_result()),
        )
        .await;
    let (_, bare) = seam
        .call_with(
            inspect_call(341, json!({ "selector": INSPECT_SELECTOR })),
            result_frame(inspect_result()),
        )
        .await;

    // THEN the substring travels after `includeHidden` and before `tab`, exactly where the
    // schema declares it,
    assert_eq!(framed["method"], protocol::methods::INSPECT);
    assert_eq!(
        framed["params"],
        json!({ "selector": INSPECT_SELECTOR, "limit": 5, "frame": FRAME_SUBSTRING })
    );
    assert_eq!(keys_of(&framed["params"]), ["selector", "limit", "frame"]);

    // ... and a call without a frame puts no key on the wire at all.
    assert_eq!(bare["params"], json!({ "selector": INSPECT_SELECTOR }));
    assert_eq!(keys_of(&bare["params"]), ["selector"]);
}

#[tokio::test]
async fn mcp_toolsCallBrowserInspect_withContainsText_shouldSendTextOnTheWire() {
    // GIVEN a bridge with a connected extension, and the substring a caller searches for:
    let mut seam = Seam::connected(config()).await;
    let needle = "Login";

    // WHEN the client searches with the name from the contract,
    let (answer, request) = seam
        .call_with(
            inspect_call(344, json!({ "contains_text": needle })),
            result_frame(inspect_result()),
        )
        .await;

    // THEN the wire carries `text` — the name the extension reads, and the one the log
    // line prints (`docs/59`, goal 6) — while the new name stays behind in the bridge,
    assert_eq!(request["method"], protocol::methods::INSPECT);
    assert_eq!(request["params"], json!({ "text": needle }));
    assert_eq!(keys_of(&request["params"]), ["text"]);
    assert!(
        request["params"].get("contains_text").is_none(),
        "the new name must not reach the wire: {request}"
    );

    // ... and the call is a normal answer, not a sentence about a missing filter.
    assert!(!is_error(&answer));

    // WHEN the caller sends the search term beside the other filters,
    let (_, ordered) = seam
        .call_with(
            inspect_call(
                345,
                json!({
                    "selector": INSPECT_SELECTOR,
                    "contains_text": needle,
                    "limit": 5,
                    "frame": FRAME_SUBSTRING,
                }),
            ),
            result_frame(inspect_result()),
        )
        .await;

    // THEN `text` stands exactly where `contains_text` stands in the schema: after
    // `selector` and before `limit`,
    assert_eq!(
        ordered["params"],
        json!({
            "selector": INSPECT_SELECTOR,
            "text": needle,
            "limit": 5,
            "frame": FRAME_SUBSTRING,
        })
    );
    assert_eq!(keys_of(&ordered["params"]), ["selector", "text", "limit", "frame"]);
}

#[tokio::test]
async fn mcp_toolsCallBrowserInspect_withAnUnknownArgument_shouldNameContainsText() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call still uses the old name — the mistake `docs/59` is about, written alone
    // as the spec's example does and beside the name the schema declares,
    for (id, arguments) in [
        (346, json!({ "selector": INSPECT_SELECTOR, "text": "Login" })),
        (
            347,
            json!({ "selector": INSPECT_SELECTOR, "contains_text": "Login", "text": "Login" }),
        ),
    ] {
        let answer = seam.call(inspect_call(id, arguments.clone())).await;

        // THEN it is a tool error whose sentence names the argument that searches,
        assert!(is_error(&answer), "{arguments}");
        assert_eq!(text_of(&answer), INSPECT_UNEXPECTED_ARGUMENTS_TEXT, "{arguments}");
        assert!(text_of(&answer).contains("`contains_text`"), "{arguments}");
        assert!(answer.get("error").is_none(), "{arguments}");
    }

    // ... and none of the refused calls reached the extension.
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

#[tokio::test]
async fn mcp_toolsCallBrowserInspect_withAFrameOfTheWrongType_shouldAnswerInvalidParamsAndReachNoExtension() {
    // GIVEN the values that are not the `string` the schema declares — a number and `null`:
    for arguments in [
        json!({ "selector": INSPECT_SELECTOR, "frame": 1 }),
        json!({ "selector": INSPECT_SELECTOR, "frame": null }),
    ] {
        let mut seam = Seam::connected(config()).await;

        // WHEN the client inspects with that argument,
        let answer = seam.call(inspect_call(342, arguments.clone())).await;

        // THEN it is a malformed *request* (`-32602`),
        assert_eq!(error_code(&answer), Some(-32602), "{arguments} must answer -32602");
        assert!(answer.get("result").is_none(), "{arguments} must not be a tool result");

        // ... and nothing reached the extension.
        assert!(
            !seam.reached_the_extension(),
            "{arguments} must not reach the extension"
        );
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserInspect_whenTheExtensionAnswersAFrameRefusal_shouldReturnThatCodesFrameSentence() {
    // GIVEN the two frame codes with the details both longer sentences need:
    let cases = [
        (
            "frame_not_found",
            json!({ "frames": 2 }),
            FRAME_NOT_FOUND_WITH_COUNT_TEXT,
            FRAME_AMBIGUOUS_WITH_CANDIDATES_TEXT,
        ),
        (
            "frame_ambiguous",
            json!({ "candidates": frame_candidates() }),
            FRAME_AMBIGUOUS_WITH_CANDIDATES_TEXT,
            FRAME_NOT_FOUND_WITH_COUNT_TEXT,
        ),
    ];

    for (code, details, sentence, not_the_sentence) in cases {
        // GIVEN an extension that refuses the inspect with exactly this code:
        let mut seam = Seam::connected(config()).await;

        // WHEN the client inspects through a substring the filter rejects,
        let (answer, _) = seam
            .call_with(
                inspect_call(
                    343,
                    json!({ "selector": INSPECT_SELECTOR, "frame": FRAME_SUBSTRING }),
                ),
                error_frame_with(code, details),
            )
            .await;

        // THEN it gets its own code's sentence — not the generic catch-all, not the other
        // code's sentence,
        assert!(is_error(&answer), "{code}");
        assert_eq!(text_of(&answer), sentence, "{code}");
        assert_ne!(text_of(&answer), not_the_sentence, "{code}");
        assert!(answer.get("error").is_none(), "{code}");
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserInspect_withAPiercingSelector_shouldPassItThroughUnchanged() {
    // GIVEN a selector that jumps into an open shadow tree — syntax inside the string, which
    // the bridge has no opinion on:
    let piercing = "my-card >>> button";
    let mut seam = Seam::connected(config()).await;

    // WHEN the call goes through the tool layer,
    let (_, request) = seam
        .call_with(
            inspect_call(344, json!({ "selector": piercing })),
            result_frame(inspect_result()),
        )
        .await;

    // THEN it travels character for character,
    assert_eq!(request["params"], json!({ "selector": piercing }));
    assert_eq!(request["params"]["selector"], piercing);
}

/* --------------------------------------------------------- open/close tab */

#[tokio::test]
async fn mcp_toolsCallBrowserOpenTab_withAConnectedExtension_shouldReturnTabIdUrlAndTitleAsIndentedJsonText() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client opens a tab,
    let (answer, request) = seam
        .call_with(
            open_tab_call(130, "https://example.org/"),
            result_frame(open_tab_result()),
        )
        .await;

    // THEN the request carries the URL and nothing else — the tab it addresses does not
    // exist yet,
    assert_eq!(request["method"], protocol::methods::OPEN_TAB);
    assert_eq!(request["params"], json!({ "url": "https://example.org/" }));

    // ... and the answer is the three fields the contract promises:
    assert!(!is_error(&answer));
    assert_eq!(text_of(&answer), indented(&open_tab_result()));
    assert_eq!(
        fields_of(&serde_json::from_str::<Value>(&text_of(&answer)).expect("the text is JSON")),
        ["tabId", "url", "title"]
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserOpenTab_atTheTabLimit_shouldReturnTheTooManyTabsSentence() {
    // GIVEN an extension that has five agent tabs open already:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client opens a sixth,
    let (answer, _) = seam
        .call_with(
            open_tab_call(131, "https://example.org/"),
            error_frame("too_many_tabs"),
        )
        .await;

    // THEN the sentence asks for a close rather than for a retry — the fifth tab is the
    // limit, and closing one is the only thing that unblocks the call,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), TOO_MANY_TABS_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserCloseTab_withoutTab_shouldReturnTabIdAndClosedAsIndentedJsonText() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client closes a tab without naming one,
    let (answer, request) = seam
        .call_with(close_tab_call(132, None), result_frame(close_tab_result()))
        .await;

    // THEN the payload is empty,
    assert_eq!(request["method"], protocol::methods::CLOSE_TAB);
    assert_eq!(request["params"], json!({}));

    // ... and the answer carries `tabId` and `closed`:
    assert!(!is_error(&answer));
    assert_eq!(text_of(&answer), indented(&close_tab_result()));
    assert_eq!(
        fields_of(&serde_json::from_str::<Value>(&text_of(&answer)).expect("the text is JSON")),
        ["tabId", "closed"]
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserCloseTab_withAForeignTabId_shouldReturnTheNavigateFirstSentence() {
    // GIVEN an extension that does not know the tab id — a foreign or already-gone id:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client closes tab 99,
    let (answer, request) = seam
        .call_with(
            close_tab_call(133, Some(json!({ "tab": 99 }))),
            error_frame("no_agent_tab"),
        )
        .await;

    // THEN the tab really travelled,
    assert_eq!(request["params"], json!({ "tab": 99 }));

    // ... and the answer is the advice `browser_read` gives, because the call that fixes it
    // is the same one:
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), NO_AGENT_TAB_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserOpenTab_withASecondArgument_shouldReturnTheOnlyUrlSentence() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call tries to hand over a tab that does not exist yet — the near-miss this
    // tool has to refuse, because `open_tab` creates the tab it addresses,
    let answer = seam
        .call(call_request(
            134,
            "browser_open_tab",
            Some(json!({ "url": "https://example.org/", "tab": 42 })),
        ))
        .await;

    // THEN the sentence names `url` as the only argument the tool takes,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), OPEN_TAB_UNEXPECTED_ARGUMENTS_TEXT);
    assert!(answer.get("error").is_none());

    // ... and the refused call never reached the extension.
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

/* -------------------------------------------------------------------- tab */

#[tokio::test]
async fn mcp_toolsCallBrowserRead_withTab_shouldForwardTheCallInsteadOfRefusingIt() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN one call names the tab with the declared key `tab` and one names it with a
    // string, which the schema does not allow,
    let (accepted, request) = seam
        .call_with(
            read_call(135, Some(json!({ "tab": 42 }))),
            result_frame(read_result()),
        )
        .await;
    let refused = seam
        .call(read_call(136, Some(json!({ "tab": "42" }))))
        .await;

    // THEN the first is answered exactly like a call without a tab, with `tab` on the wire,
    assert!(!is_error(&accepted));
    assert_eq!(text_of(&accepted), indented(&read_result()));
    assert_eq!(request["params"], json!({ "tab": 42 }));

    // ... the second is a malformed request, because the schema says `integer` and a string
    // tab would only come back as the extension's `invalid_params`,
    assert_eq!(error_code(&refused), Some(-32602));
    assert_eq!(refused["error"]["message"], "invalid params");
    assert!(refused.get("result").is_none());
}

#[tokio::test]
async fn mcp_toolsCallBrowserClick_withTab_shouldPutTheTabOnTheWireNextToTheSelector() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client clicks a selector in tab 42,
    let (answer, request) = seam
        .call_with(
            call_request(
                138,
                "browser_click",
                Some(json!({ "selector": CLICK_SELECTOR, "tab": 42 })),
            ),
            result_frame(click_result()),
        )
        .await;

    // THEN the answer is the ordinary click answer — naming a tab costs no shape,
    assert!(!is_error(&answer));
    assert_eq!(text_of(&answer), indented(&click_result()));

    // ... and the tab travels next to the selector, in schema order. Dropping it would click
    // the newest agent tab instead: a different page, and the operator would never be told.
    assert_eq!(
        request["params"],
        json!({ "selector": CLICK_SELECTOR, "tab": 42 })
    );
    assert_eq!(keys_of(&request["params"]), ["selector", "tab"]);
}

#[tokio::test]
async fn mcp_toolsCallBrowserStatus_withATab_shouldStillReturnTheNoArgumentsSentence() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN a call hands `status` the argument its sibling tools take — the "one more tool
    // takes a tab, so this one must too" guess,
    let answer = seam
        .call(call_request(137, "browser_status", Some(json!({ "tab": 42 }))))
        .await;

    // THEN it is refused with the old sentence, unchanged: `status` reports every window, so
    // a tab it could only ignore is an argument the schema forbids,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), UNEXPECTED_ARGUMENTS_TEXT);
    assert!(answer.get("error").is_none());
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

/* ------------------------------------------------------------------- eval */

/// The twelve codes `eval` translates: five of its own, the page triangle and the two frame
/// codes, each with the details its sentence needs.
fn eval_refusal_cases() -> Vec<(&'static str, Option<Value>, &'static str)> {
    vec![
        ("eval_not_allowed", None, EVAL_NOT_ALLOWED_TEXT),
        // The page said nothing the bridge can print: old sentence, no dangling `: `.
        ("eval_failed", Some(json!({ "message": "" })), EVAL_FAILED_TEXT),
        // The page named its own mistake: the sentence has to repeat it verbatim.
        (
            "eval_failed",
            Some(json!({ "message": EVAL_FAILED_PAGE_MESSAGE })),
            EVAL_FAILED_WITH_MESSAGE_TEXT,
        ),
        ("eval_timeout", None, EVAL_TIMEOUT_TEXT),
        ("eval_result_too_large", None, EVAL_RESULT_TOO_LARGE_TEXT),
        ("eval_result_unserializable", None, EVAL_RESULT_UNSERIALIZABLE_TEXT),
        ("invalid_params", None, INVALID_EVAL_PARAMS_TEXT),
        ("no_agent_tab", None, NO_AGENT_TAB_TEXT),
        ("page_busy", None, PAGE_BUSY_TEXT),
        ("not_readable", None, NOT_READABLE_TEXT),
        (
            "frame_not_found",
            Some(json!({ "frames": 2 })),
            FRAME_NOT_FOUND_WITH_COUNT_TEXT,
        ),
        (
            "frame_ambiguous",
            Some(json!({ "candidates": frame_candidates() })),
            FRAME_AMBIGUOUS_WITH_CANDIDATES_TEXT,
        ),
    ]
}

#[tokio::test]
async fn mcp_toolsCallBrowserEval_withAConnectedExtension_shouldReturnTheResultAsIndentedJsonText() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client runs a code body in tab 42,
    let (answer, request) = seam
        .call_with(
            eval_call(150, json!({ "code": EVAL_CODE, "tab": 42 })),
            result_frame(eval_result()),
        )
        .await;

    // THEN the code and the tab travel, in schema order,
    assert_eq!(request["method"], protocol::methods::EVAL);
    assert_eq!(request["params"], json!({ "code": EVAL_CODE, "tab": 42 }));

    // ... and the answer is the extension's result as indented JSON — `elapsedMs` included,
    // because it is the only field that proves the call was measured rather than invented:
    assert!(!is_error(&answer));
    assert_eq!(text_of(&answer), indented(&eval_result()));
}

#[tokio::test]
async fn mcp_toolsCallBrowserEval_withoutTheCode_shouldAnswerInvalidParamsAndNeverReachTheExtension() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call carries no code — once as `{}`, once with no arguments at all,
    for (id, arguments) in [(151, Some(json!({}))), (152, None)] {
        let answer = seam.call(call_request(id, "browser_eval", arguments.clone())).await;

        // THEN it is a malformed request: the schema requires `code`, and a call without it
        // has nothing to run,
        assert_eq!(error_code(&answer), Some(-32602), "{arguments:?}");
        assert!(answer.get("result").is_none(), "{arguments:?}");
    }

    // ... and nothing reached the extension.
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

#[tokio::test]
async fn mcp_toolsCallBrowserEval_withAFrame_shouldPassTheSubstringBehindTheCode() {
    // GIVEN a caller that runs the code in an addressed frame, and one that names no frame:
    let mut seam = Seam::connected(config()).await;

    // WHEN both calls go through the tool layer,
    let (_, framed) = seam
        .call_with(
            eval_call(350, json!({ "code": EVAL_CODE, "frame": FRAME_SUBSTRING })),
            result_frame(eval_result()),
        )
        .await;
    let (_, bare) = seam
        .call_with(
            eval_call(351, json!({ "code": EVAL_CODE })),
            result_frame(eval_result()),
        )
        .await;

    // THEN the frame follows the code and sits before `tab`,
    assert_eq!(
        framed["params"],
        json!({ "code": EVAL_CODE, "frame": FRAME_SUBSTRING })
    );
    assert_eq!(keys_of(&framed["params"]), ["code", "frame"]);

    // ... and an `eval` without a frame puts no key on the wire at all.
    assert_eq!(bare["params"], json!({ "code": EVAL_CODE }));
    assert_eq!(keys_of(&bare["params"]), ["code"]);
}

#[tokio::test]
async fn mcp_toolsCallBrowserEval_withAFrameOfTheWrongType_shouldAnswerInvalidParamsAndReachNoExtension() {
    // GIVEN the values that are not the `string` the schema declares:
    for arguments in [
        json!({ "code": EVAL_CODE, "frame": 1 }),
        json!({ "code": EVAL_CODE, "frame": null }),
    ] {
        let mut seam = Seam::connected(config()).await;

        // WHEN the client runs code with that argument,
        let answer = seam.call(eval_call(352, arguments.clone())).await;

        // THEN it is a malformed *request* (`-32602`),
        assert_eq!(error_code(&answer), Some(-32602), "{arguments} must answer -32602");
        assert!(answer.get("result").is_none(), "{arguments} must not be a tool result");

        // ... and nothing reached the extension.
        assert!(
            !seam.reached_the_extension(),
            "{arguments} must not reach the extension"
        );
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserEval_withANumericCode_shouldAnswerInvalidParams() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the code arrives as a number,
    let answer = seam.call(eval_call(153, json!({ "code": 3 }))).await;

    // THEN it is a malformed request — the schema says `string`,
    assert_eq!(error_code(&answer), Some(-32602));
    assert!(answer.get("result").is_none());

    // ... and nothing reached the extension.
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

#[tokio::test]
async fn mcp_toolsCallBrowserEval_withAnUndeclaredArgument_shouldReturnTheOnlyTwoKeysSentence() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call carries a timeout the schema does not declare — the near-miss of a
    // client that wants to set a deadline the bridge owns,
    let answer = seam
        .call(eval_call(
            154,
            json!({ "code": EVAL_CODE, "timeoutMs": 3000 }),
        ))
        .await;

    // THEN it is a tool error naming the declared arguments,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), EVAL_UNEXPECTED_ARGUMENTS_TEXT);
    assert!(answer.get("error").is_none());

    // ... and the refused call never reached the extension.
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

#[tokio::test]
async fn mcp_toolsCallBrowserEval_whenTheExtensionAnswersARefusal_shouldReturnTheSentenceForThatCode() {
    for (code, details, sentence) in eval_refusal_cases() {
        // GIVEN an extension that refuses the eval call with exactly this code:
        let mut seam = Seam::connected(config()).await;

        // WHEN the client runs a code body,
        let (answer, _) = seam
            .call_with(
                eval_call(155, json!({ "code": EVAL_CODE })),
                match details.clone() {
                    Some(details) => error_frame_with(code, details),
                    None => error_frame(code),
                },
            )
            .await;

        // THEN it gets the sentence for that code — not the code, and not the generic
        // catch-all (`{code}` names the code, `{details:?}` the details that went with it),
        assert!(is_error(&answer), "{code} {details:?}");
        assert_eq!(text_of(&answer), sentence, "{code} {details:?}");
        assert!(answer.get("error").is_none(), "{code}");
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserClickAndType_whenTheFilterRefuses_shouldReturnThatCodesFrameSentence() {
    // GIVEN an extension that refuses the click with the first code and the typing with the
    // second, plus the details both longer sentences need:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client clicks and types through a substring the filter rejects,
    let (clicked, click_request) = seam
        .call_with(
            call_request(
                363,
                "browser_click",
                Some(json!({ "selector": CLICK_SELECTOR, "frame": FRAME_SUBSTRING })),
            ),
            error_frame_with("frame_not_found", json!({ "frames": 2 })),
        )
        .await;
    let (typed, type_request) = seam
        .call_with(
            call_request(
                364,
                "browser_type",
                Some(json!({
                    "selector": TYPE_SELECTOR,
                    "typed_text": TYPE_TEXT,
                    "frame": FRAME_SUBSTRING,
                })),
            ),
            error_frame_with("frame_ambiguous", json!({ "candidates": frame_candidates() })),
        )
        .await;

    // THEN each call gets its own code's sentence — not the generic catch-all, not the other
    // code's sentence, and not the tool's own failure sentence,
    assert_eq!(click_request["params"]["frame"], FRAME_SUBSTRING);
    assert_eq!(type_request["params"]["frame"], FRAME_SUBSTRING);
    assert!(is_error(&clicked));
    assert_eq!(text_of(&clicked), FRAME_NOT_FOUND_WITH_COUNT_TEXT);
    assert_ne!(text_of(&clicked), FRAME_AMBIGUOUS_WITH_CANDIDATES_TEXT);
    assert!(is_error(&typed));
    assert_eq!(text_of(&typed), FRAME_AMBIGUOUS_WITH_CANDIDATES_TEXT);
    assert_ne!(text_of(&typed), FRAME_NOT_FOUND_WITH_COUNT_TEXT);
}

/* ------------------------------------------------------------- screenshot */

/// The two tools whose payload is built by hand rather than copied from the declared keys —
/// the place where a forgotten `frame` line would drop the filter silently.
struct FramedTool {
    name: &'static str,
    method: &'static str,
    framed: Value,
    plain: Value,
    params_framed: Value,
    params_plain: Value,
}

fn framed_acting_tools() -> [FramedTool; 2] {
    [
        FramedTool {
            name: "browser_click",
            method: protocol::methods::CLICK,
            framed: json!({ "selector": CLICK_SELECTOR, "frame": FRAME_SUBSTRING }),
            plain: json!({ "selector": CLICK_SELECTOR }),
            params_framed: json!({ "selector": CLICK_SELECTOR, "frame": FRAME_SUBSTRING }),
            params_plain: json!({ "selector": CLICK_SELECTOR }),
        },
        FramedTool {
            name: "browser_type",
            method: protocol::methods::TYPE,
            framed: json!({
                "selector": TYPE_SELECTOR,
                "typed_text": TYPE_TEXT,
                "frame": FRAME_SUBSTRING,
            }),
            plain: json!({ "selector": TYPE_SELECTOR, "typed_text": TYPE_TEXT }),
            params_framed: json!({
                "selector": TYPE_SELECTOR,
                "text": TYPE_TEXT,
                "submit": false,
                "frame": FRAME_SUBSTRING,
            }),
            params_plain: json!({ "selector": TYPE_SELECTOR, "text": TYPE_TEXT, "submit": false }),
        },
    ]
}

#[tokio::test]
async fn mcp_toolsCallBrowserClickAndType_withAFrame_shouldPassTheSubstringInSchemaOrder() {
    // GIVEN a caller that addresses an iframe, and a second one that names none:
    for tool in framed_acting_tools() {
        let mut seam = Seam::connected(config()).await;

        // WHEN both calls go through the tool layer,
        let (_, framed) = seam
            .call_with(
                call_request(360, tool.name, Some(tool.framed.clone())),
                result_frame(json!({})),
            )
            .await;
        let (_, plain) = seam
            .call_with(
                call_request(361, tool.name, Some(tool.plain.clone())),
                result_frame(json!({})),
            )
            .await;

        // THEN the substring travels after the tool's own arguments and before `tab`: the
        // hand-built payload really carries it, which is the half a missing copy line would
        // lose silently,
        assert_eq!(framed["method"], tool.method, "{}", tool.name);
        assert_eq!(framed["params"], tool.params_framed, "{}", tool.name);
        assert_eq!(framed["params"]["frame"], FRAME_SUBSTRING, "{}", tool.name);

        // ... and a call without a frame puts no key on the wire at all: absent, not `null`,
        // because a request that named it would claim a filter nobody sent.
        assert_eq!(plain["params"], tool.params_plain, "{}", tool.name);
        assert_eq!(
            keys_of(&plain["params"]),
            keys_of(&tool.params_plain),
            "{}",
            tool.name
        );
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserClickAndType_withAFrameOfTheWrongType_shouldAnswerInvalidParamsAndReachNoExtension() {
    // GIVEN the values that are not the `string` the schema declares — a number, `null` and
    // an array:
    for tool in framed_acting_tools() {
        for frame in [json!(1), Value::Null, json!([FRAME_SUBSTRING])] {
            let mut seam = Seam::connected(config()).await;
            let mut arguments = tool.plain.clone();
            arguments["frame"] = frame.clone();

            // WHEN the client calls the tool with that argument,
            let answer = seam
                .call(call_request(362, tool.name, Some(arguments.clone())))
                .await;

            // THEN it is a malformed *request* (`-32602`),
            assert_eq!(
                error_code(&answer),
                Some(-32602),
                "{} with frame {frame} must answer -32602",
                tool.name
            );
            assert!(
                answer.get("result").is_none(),
                "{} with frame {frame} must not be a tool result",
                tool.name
            );

            // ... and nothing reached the extension.
            assert!(
                !seam.reached_the_extension(),
                "{} with frame {frame} must not reach the extension",
                tool.name
            );
        }
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserScreenshot_shouldReturnTheMetadataAsTextAndThenTheImage() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client photographs the visible area of tab 42,
    let (answer, request) = seam
        .call_with(
            screenshot_call(156, Some(json!({ "tab": 42 }))),
            result_frame(screenshot_result()),
        )
        .await;

    // THEN the request carried the tab the caller named,
    assert_eq!(request["method"], protocol::methods::SCREENSHOT);
    assert_eq!(request["params"], json!({ "tab": 42 }));

    // ... and the answer has two blocks in exactly one order — the numbers first, the
    // picture after them:
    assert!(!is_error(&answer));
    let content = answer["result"]["content"].as_array().expect("content blocks");
    assert_eq!(content.len(), 2);
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[1]["type"], "image");

    // ... the text block is the whole result minus its picture, so the caller can read what
    // the picture is without decoding it and the payload is not sent twice:
    let text = text_of(&answer);
    let mut metadata = screenshot_result();
    metadata.as_object_mut().expect("an object").remove("base64");
    assert_eq!(text, indented(&metadata));
    assert!(!text.contains("base64"), "the text block must not carry the picture");
    assert_eq!(fields_of(&serde_json::from_str::<Value>(&text).expect("the text is JSON")).len(), 9);

    // ... and the image block is the picture itself: `mimeType` from the result's `format`,
    // `data` the bare base64 with no `data:` prefix.
    let image = &content[1];
    assert_eq!(image["mimeType"], "image/jpeg");
    assert_eq!(image["data"], "/9j/");
    assert!(
        image["data"].as_str().expect("a base64 streak").starts_with("/9j/"),
        "the data must be the JPEG"
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserScreenshot_withAPng_shouldNameThePngMimeType() {
    // GIVEN an extension whose picture is a PNG — the 1×1 passthrough capture a small tab
    // really produces:
    let png = json!({
        "tabId": 20,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "format": "png",
        "width": 1,
        "height": 1,
        "bytes": 3,
        "scaled": false,
        "activated": false,
        "base64": "iVBORw0",
    });
    let mut seam = Seam::connected(config()).await;

    // WHEN the client asks for a picture,
    let (answer, _) = seam
        .call_with(screenshot_call(159, None), result_frame(png.clone()))
        .await;

    // THEN the MIME type follows the format the extension reported,
    let content = answer["result"]["content"].as_array().expect("content blocks");
    assert_eq!(content[1]["type"], "image");
    assert_eq!(content[1]["mimeType"], "image/png");
    assert!(
        content[1]["data"].as_str().expect("a base64 streak").starts_with("iVBORw0"),
        "the data must be the PNG"
    );

    // ... while the text block beside it carries the numbers of that same picture,
    let mut metadata = png;
    metadata.as_object_mut().expect("an object").remove("base64");
    assert_eq!(text_of(&answer), indented(&metadata));
}

#[tokio::test]
async fn mcp_toolsCallBrowserScreenshot_withAnUnknownFormat_shouldAnswerAnErrorWithoutAnImage() {
    // GIVEN an extension that names a format the bridge knows no MIME type for:
    let mut gif = screenshot_result();
    gif["format"] = json!("gif");
    let mut seam = Seam::connected(config()).await;

    // WHEN the client asks for a picture,
    let (answer, _) = seam
        .call_with(screenshot_call(160, None), result_frame(gif))
        .await;

    // THEN it is a tool error with the generic screenshot sentence and exactly one text
    // block — the call did reach the extension, the answer was unusable:
    assert!(is_error(&answer));
    let content = answer["result"]["content"].as_array().expect("content blocks");
    assert_eq!(content.len(), 1);
    assert_eq!(text_of(&answer), SCREENSHOT_FAILED_TEXT);
    assert!(answer.get("error").is_none());

    // ... and no image block was sent at all, with no guessed MIME type in it.
    assert!(
        content.iter().all(|block| block["type"] != "image"),
        "an unknown format must not become an image block"
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserScreenshot_withAnArgument_shouldReturnTheOnlyTabSentence() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call carries an argument the schema forbids,
    let answer = seam
        .call(screenshot_call(158, Some(json!({ "x": 1 }))))
        .await;

    // THEN it is a tool error with the sentence from the contract,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), SCREENSHOT_UNEXPECTED_ARGUMENTS_TEXT);
    assert!(answer.get("error").is_none());

    // ... and the refused call never reached the extension.
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

/// The seven refusals `screenshot` translates — its three codes, the one it inherits, and
/// both message-carrying codes twice (with and without the extension's message).
fn screenshot_refusal_cases() -> Vec<(&'static str, Option<Value>, &'static str)> {
    vec![
        ("screenshot_not_allowed", None, SCREENSHOT_NOT_ALLOWED_TEXT),
        // Nothing the bridge can print: the generic sentence, no dangling colon.
        (
            "screenshot_failed",
            Some(json!({ "message": "" })),
            SCREENSHOT_FAILED_TEXT,
        ),
        // The browser named its reason, so the sentence repeats it.
        (
            "screenshot_failed",
            Some(json!({ "message": SCREENSHOT_BROWSER_MESSAGE })),
            SCREENSHOT_FAILED_WITH_MESSAGE_TEXT,
        ),
        // The measurement — bytes, dimensions, limit — is the extension's, and the tool text
        // has to carry it verbatim.
        (
            "screenshot_too_large",
            Some(json!({ "message": SCREENSHOT_TOO_LARGE_MEASUREMENT })),
            SCREENSHOT_TOO_LARGE_WITH_MESSAGE_TEXT,
        ),
        // The fallback for a frame that carries no measurement at all.
        (
            "screenshot_too_large",
            Some(json!({ "message": "" })),
            SCREENSHOT_TOO_LARGE_TEXT,
        ),
        ("invalid_params", None, INVALID_SCREENSHOT_PARAMS_TEXT),
        ("no_agent_tab", None, NO_AGENT_TAB_TEXT),
    ]
}

#[tokio::test]
async fn mcp_toolsCallBrowserScreenshot_whenTheExtensionAnswersARefusal_shouldReturnTheSentenceForThatCode() {
    for (code, details, sentence) in screenshot_refusal_cases() {
        // GIVEN an extension that refuses the screenshot with exactly this code:
        let mut seam = Seam::connected(config()).await;

        // WHEN the client asks for a picture,
        let (answer, _) = seam
            .call_with(
                screenshot_call(157, None),
                match details.clone() {
                    Some(details) => error_frame_with(code, details),
                    None => error_frame(code),
                },
            )
            .await;

        // THEN it gets the sentence for that code,
        assert!(is_error(&answer), "{code} {details:?}");
        assert_eq!(text_of(&answer), sentence, "{code} {details:?}");
        assert!(answer.get("error").is_none(), "{code}");

        // ... and it is a text-only answer: a picture block next to an error would be a
        // picture the client renders for a call that failed.
        let content = answer["result"]["content"].as_array().expect("content blocks");
        assert_eq!(content.len(), 1, "{code}");
        assert_eq!(content[0]["type"], "text", "{code}");
    }
}

/* ----------------------------------------------------------------- frames */

/// The three refusals `frames` inherits from `read`.
const FRAMES_REFUSAL_CASES: [(&str, &str); 3] = [
    ("no_agent_tab", NO_AGENT_TAB_TEXT),
    ("page_busy", PAGE_BUSY_TEXT),
    ("not_readable", NOT_READABLE_TEXT),
];

#[tokio::test]
async fn mcp_toolsCallBrowserFrames_shouldReturnTheFrameListAsIndentedJsonText() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client lists the frames of tab 42,
    let (answer, request) = seam
        .call_with(
            frames_call(161, Some(json!({ "tab": 42 }))),
            result_frame(frames_result()),
        )
        .await;

    // THEN the tab travels and nothing else,
    assert_eq!(request["method"], protocol::methods::FRAMES);
    assert_eq!(request["params"], json!({ "tab": 42 }));

    // ... and the answer is the flat list of addresses:
    assert!(!is_error(&answer));
    assert_eq!(text_of(&answer), indented(&frames_result()));
    assert_eq!(
        fields_of(&serde_json::from_str::<Value>(&text_of(&answer)).expect("the text is JSON")),
        ["tabId", "url", "count", "frames"]
    );
}

#[tokio::test]
async fn mcp_toolsCallBrowserFrames_whenTheExtensionAnswersARefusal_shouldReturnTheReadSentence() {
    for (code, sentence) in FRAMES_REFUSAL_CASES {
        // GIVEN an extension that refuses the frames call with exactly this code — all three
        // are codes `read` answers with too:
        let mut seam = Seam::connected(config()).await;

        // WHEN the client lists the frames of the last used agent tab,
        let (answer, _) = seam
            .call_with(frames_call(162, Some(json!({}))), error_frame(code))
            .await;

        // THEN it gets the sentence `read` gives for that code — not the code, and not the
        // catch-all sentence that names the wrong action,
        assert!(is_error(&answer), "{code}");
        assert_eq!(text_of(&answer), sentence, "{code}");
        assert!(answer.get("error").is_none(), "{code}");
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserFrames_withAnArgument_shouldReturnTheOnlyTabSentence() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call carries an argument the schema forbids — `frame` is the one `read`
    // declares and this tool deliberately does not:
    let answer = seam
        .call(frames_call(163, Some(json!({ "frame": "widget" }))))
        .await;

    // THEN it is a tool error with the sentence from the contract,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), FRAMES_UNEXPECTED_ARGUMENTS_TEXT);
    assert!(answer.get("error").is_none());

    // ... and the refused call never reached the extension.
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

/* ------------------------------------------------------------- transcript */

/// The six refusals `transcript` translates, including the two that carry the extension's
/// message and the two `read` sentences it inherits.
fn transcript_refusal_cases() -> Vec<(&'static str, Option<Value>, &'static str)> {
    vec![
        (
            "transcript_failed",
            Some(json!({ "message": null })),
            TRANSCRIPT_FAILED_TEXT,
        ),
        (
            "offset_out_of_range",
            Some(json!({ "totalChars": 87314, "message": OFFSET_OUT_OF_RANGE_MESSAGE })),
            OFFSET_OUT_OF_RANGE_TEXT,
        ),
        ("page_busy", None, PAGE_BUSY_TEXT),
        ("not_readable", None, NOT_READABLE_TEXT),
        (
            "transcript_needs_focus",
            Some(json!({ "message": null })),
            TRANSCRIPT_NEEDS_FOCUS_TEXT,
        ),
        (
            "transcript_needs_focus",
            Some(json!({ "message": TRANSCRIPT_FOCUS_MESSAGE })),
            TRANSCRIPT_NEEDS_FOCUS_WITH_MESSAGE_TEXT,
        ),
    ]
}

#[tokio::test]
async fn mcp_toolsCallBrowserTranscript_withAConnectedExtension_shouldReturnTheFieldsAsIndentedJsonText() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads a window of the transcript,
    let (answer, request) = seam
        .call_with(
            transcript_call(171, Some(json!({ "tab": 42, "offset": 5, "maxChars": 10 }))),
            result_frame(transcript_result()),
        )
        .await;

    // THEN the request carries the window in schema order and the tab last,
    assert_eq!(request["method"], protocol::methods::TRANSCRIPT);
    assert_eq!(request["params"], json!({ "offset": 5, "maxChars": 10, "tab": 42 }));
    assert_eq!(keys_of(&request["params"]), ["offset", "maxChars", "tab"]);

    // ... and the answer is the extension's result as indented JSON:
    assert!(!is_error(&answer));
    assert_eq!(text_of(&answer), indented(&transcript_result()));
}

#[tokio::test]
async fn mcp_toolsCallBrowserTranscript_whenTheVideoHasNoCaptionTrack_shouldReturnTheNoTranscriptSentence() {
    // GIVEN an extension whose video has no caption track:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads the transcript,
    let (answer, _) = seam
        .call_with(
            transcript_call(172, Some(json!({}))),
            error_frame("no_transcript_panel"),
        )
        .await;

    // THEN it gets that code's own sentence,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), NO_TRANSCRIPT_PANEL_TEXT);
}

#[tokio::test]
async fn mcp_toolsCallBrowserTranscript_whenTheExtensionAnswersARefusal_shouldReturnTheSentenceForThatCode() {
    for (code, details, sentence) in transcript_refusal_cases() {
        // GIVEN an extension that refuses the transcript call with exactly this code:
        let mut seam = Seam::connected(config()).await;

        // WHEN the client reads the transcript,
        let (answer, _) = seam
            .call_with(
                transcript_call(173, Some(json!({}))),
                match details.clone() {
                    Some(details) => error_frame_with(code, details),
                    None => error_frame(code),
                },
            )
            .await;

        // THEN it gets the sentence for that code — `offset_out_of_range` and
        // `invalid_params` take `read`'s sentences, because the extension checks both tools
        // with the same helper,
        assert!(is_error(&answer), "{code} {details:?}");
        assert_eq!(text_of(&answer), sentence, "{code} {details:?}");
        assert!(answer.get("error").is_none(), "{code}");
    }
}

#[tokio::test]
async fn mcp_toolsCallBrowserTranscript_shouldCarryTheLanguageFields() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads the transcript of the last used agent tab,
    let (answer, _) = seam
        .call_with(transcript_call(175, Some(json!({}))), result_frame(transcript_result()))
        .await;

    // THEN the answer opens with the three language fields, key and value both in the text,
    // in the extension's order:
    let text = text_of(&answer);
    let opening: Vec<&str> = text.lines().take(4).collect();
    assert_eq!(
        opening,
        [
            "{",
            "  \"requestedLanguage\": \"en\",",
            "  \"deliveredLanguage\": \"en\",",
            "  \"source\": \"ytplayer.bootstrapPlayerResponse\",",
        ]
    );

    // ... and the parsed answer agrees with the extension field by field: the bridge
    // forwards them, it does not invent or rename one on the way.
    let parsed: Value = serde_json::from_str(&text).expect("the text is JSON");
    assert_eq!(parsed["requestedLanguage"], transcript_result()["requestedLanguage"]);
    assert_eq!(parsed["deliveredLanguage"], transcript_result()["deliveredLanguage"]);
    assert_eq!(parsed["source"], transcript_result()["source"]);
}

#[tokio::test]
async fn mcp_toolsCallBrowserTranscript_shouldNotLeakTheUrl() {
    // GIVEN an extension that refuses with a reason and, beside it, the signed track address
    // the player had fetched — the shape a careless extension would hand over:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads the transcript,
    let (answer, _) = seam
        .call_with(
            transcript_call(176, Some(json!({}))),
            error_frame_with(
                "transcript_failed",
                json!({ "url": TRANSCRIPT_PROBE_URL, "message": TRANSCRIPT_FAILURE_REASON }),
            ),
        )
        .await;

    // THEN the reason arrives, and the address does not: no endpoint, no signature.
    let text = text_of(&answer);
    assert_eq!(text, TRANSCRIPT_FAILED_WITH_MESSAGE_TEXT);
    assert!(!text.contains("timedtext"), "{text}");
    assert!(!text.contains("signature"), "{text}");
}

#[tokio::test]
async fn mcp_toolsCallBrowserTranscript_shouldPassTheFailureDetail() {
    // GIVEN an extension that refuses `transcript_failed` with the sentence it would use for
    // a video whose target track has no file on this page:
    let mut seam = Seam::connected(config()).await;

    // WHEN the client reads the transcript,
    let (answer, _) = seam
        .call_with(
            transcript_call(177, Some(json!({}))),
            error_frame_with(
                "transcript_failed",
                json!({ "message": TRANSCRIPT_FAILURE_REASON }),
            ),
        )
        .await;

    // THEN the answer carries the extension's reason and not the generic sentence — not the
    // code either, which would send the caller looking at its own call:
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), TRANSCRIPT_FAILED_WITH_MESSAGE_TEXT);
    assert_ne!(text_of(&answer), TRANSCRIPT_FAILED_TEXT);
    assert!(answer.get("error").is_none());
}

#[tokio::test]
async fn mcp_toolsCallBrowserTranscript_withAnArgument_shouldReturnTheDeclaredArgumentsSentence() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN the call carries an argument the schema forbids,
    let answer = seam
        .call(transcript_call(174, Some(json!({ "frame": "widget" }))))
        .await;

    // THEN it is a tool error naming the declared arguments,
    assert!(is_error(&answer));
    assert_eq!(text_of(&answer), TRANSCRIPT_UNEXPECTED_ARGUMENTS_TEXT);
    assert!(answer.get("error").is_none());

    // ... and the refused call never reached the extension.
    assert!(!seam.reached_the_extension(), "the refused call must not reach the extension");
}

/* -------------------------------------------------------------- tools/call */

#[tokio::test]
async fn mcp_toolsCall_withAnUnknownToolName_shouldReturnAnUnknownToolToolError() {
    // GIVEN a bridge with nobody connected:
    let mut seam = Seam::nobody(config());

    // WHEN the client calls a tool this server does not have,
    let answer = seam
        .call(call_request(24, "navigate", None))
        .await;

    // THEN the name is echoed in a tool error, so the client can show it:
    assert!(is_error(&answer));
    assert_eq!(
        answer["result"]["content"],
        json!([{ "type": "text", "text": "Unknown tool: navigate" }])
    );
    assert!(answer.get("error").is_none());
}

#[tokio::test]
async fn mcp_toolsCall_withArguments_shouldRefuseThemInsteadOfIgnoringThem() {
    // GIVEN a bridge with a connected extension:
    let mut seam = Seam::connected(config()).await;

    // WHEN a call carries arguments — once as an object with a key, once as a value that is
    // not an object at all,
    for (id, arguments) in [(25, json!({ "x": 1 })), (26, json!("x"))] {
        let answer = seam
            .call(call_request(id, "browser_status", Some(arguments.clone())))
            .await;

        // THEN both are refused with the same sentence, because the schema says there is
        // nothing to pass:
        assert!(is_error(&answer), "{arguments}");
        assert_eq!(
            answer["result"]["content"],
            json!([{ "type": "text", "text": UNEXPECTED_ARGUMENTS_TEXT }]),
            "{arguments}"
        );
    }
}

#[tokio::test]
async fn mcp_toolsCall_withoutAUsableName_shouldAnswerInvalidParams() {
    // GIVEN a bridge with nobody connected:
    let mut seam = Seam::nobody(config());

    // WHEN a `tools/call` arrives with no `name` at all,
    let answer = seam.call(call_request(27, "", Some(json!({})))).await;

    // THEN this is a malformed request, not an unknown tool: the server cannot say which
    // tool the client meant, so it says that much in protocol terms —
    assert_eq!(error_code(&answer), Some(-32602));
    assert_eq!(answer["error"]["message"], "invalid params");
    assert!(answer.get("result").is_none());
}

/* ------------------------------------------------------------------ stdio */

#[tokio::test]
async fn mcp_withTwoToolCallsInOneWrite_shouldAnswerBothUnderTheirOwnIds() {
    // GIVEN a bridge with a connected extension and a stdio loop in front of it:
    let mut seam = Seam::connected(config()).await;
    let mut run = StdioRun::start(seam.context.clone());

    // WHEN two calls arrive in a single write — no queue, two independent tasks,
    run.send(&status_call(31).to_string()).await;
    run.send(&status_call(32).to_string()).await;

    // ... the hub asks twice, and the extension answers both,
    for _ in 0..2 {
        let request = seam.peer().wait_for_request().await;
        let id = request
            .get("id")
            .and_then(Value::as_u64)
            .expect("the hub numbers its requests");
        seam.peer()
            .say(&response_frame(result_frame(status_result()), id));
    }

    // THEN both are answered, each under its own id, in whatever order they finished —
    // which is why this is searched by id and never by position:
    let first = run.next_line().await;
    let second = run.next_line().await;
    for answer in [&first, &second] {
        assert_eq!(
            serde_json::from_str::<Value>(&text_of(answer)).expect("the text is JSON"),
            status_result()
        );
    }
    let ids = [first["id"].clone(), second["id"].clone()];
    assert_eq!(ids.iter().filter(|id| **id == json!(31)).count(), 1);
    assert_eq!(ids.iter().filter(|id| **id == json!(32)).count(), 1);

    // ... and the loop ends with no unfinished line when the client closes stdin.
    let output = run.finish().await;
    assert!(output.ends_with('\n'), "stdout ended with a message without its newline");
}

#[tokio::test]
async fn mcp_withDebugLoggingAndAConnectedExtension_shouldKeepTheIndentedJsonOnStderrOnly() {
    // GIVEN a bridge that logs at debug level and an extension that answers:
    let mut seam = Seam::connected(debug_config()).await;

    // WHEN the client calls the tool as well,
    let (answer, _) = seam
        .call_with(status_call(33), result_frame(status_result()))
        .await;

    // THEN the multi-line debug output stayed on the log channel — the status block is
    // indented JSON, and it went where the log goes:
    let lines = seam.lines();
    assert!(
        lines.iter().any(|line| line.starts_with('{') && line.contains("\"windows\"")),
        "no indented status block in the log: {lines:?}"
    );
    assert!(
        lines.iter().any(|line| line.starts_with("status windows=")),
        "no status line in the log: {lines:?}"
    );

    // ... and the answer the client reads is the same indented JSON, in a `text` block and
    // nowhere else.
    assert!(!is_error(&answer));
    assert_eq!(answer["result"]["content"].as_array().expect("content blocks").len(), 1);
    assert_eq!(text_of(&answer), indented(&status_result()));
}

/* ---------------------------------------------------------- the real process */

/// The binary Cargo built for this test file. `[[bin]]` is a target of this package, so
/// Cargo provides the variable; a case that started `target/debug/…` by hand would measure
/// whatever happened to be lying there.
const BRIDGE_BINARY: &str = env!("CARGO_BIN_EXE_browser-control-bridge");

/// How long the whole child process gets. Generous on purpose: the case is about the last
/// bytes before the exit, not about speed, and a red test should mean "the answer never came"
/// rather than "the machine was busy".
const PROCESS_TIMEOUT: Duration = Duration::from_secs(30);

/// One run of the real binary: `input` as one line into stdin, then stdin closed, then
/// everything the process wrote to stdout before it exited — with the exit code.
///
/// The bridge reads a token and binds a port before it ever looks at stdin, so a case that
/// skipped this would measure exit 2. Both are arranged here: a token file in a temporary
/// directory of our own and a port the OS just handed out.
fn run_bridge_process(input: &str) -> (Vec<u8>, i32) {
    let directory = std::env::temp_dir().join(format!(
        "bc-stdio-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&directory).expect("no temporary directory for the token file");
    let token_file = directory.join("token");
    std::fs::write(&token_file, token()).expect("the token file could not be written");

    let mut child = std::process::Command::new(BRIDGE_BINARY)
        .env("BC_TOKEN_FILE", &token_file)
        .env("BC_BIND", format!("127.0.0.1:{}", free_port()))
        .env("BC_LOG", "info")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        // Empty on purpose: a full stderr pipe would block the child, and this case is not
        // about the log lines.
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("the bridge binary could not be started");

    // Closing the handle is the EOF, so the block is the write and the close together.
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        stdin
            .write_all(format!("{input}\n").as_bytes())
            .expect("the child's stdin refused a write");
        stdin.flush().expect("the child's stdin refused a flush");
    }

    // Reading and waiting in this order would deadlock on a full stdout pipe, and reading on
    // this thread would hang the test on a bridge that never exits — hence a reader thread and
    // a deadline that kills the child instead.
    let mut stdout = child.stdout.take().expect("stdout was piped");
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut written = Vec::new();
        let _ = stdout.read_to_end(&mut written);
        let _ = sender.send(written);
    });

    let written = match receiver.recv_timeout(PROCESS_TIMEOUT) {
        Ok(written) => written,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the bridge wrote no complete stdout within the process timeout");
        }
    };
    let status = child.wait().expect("the bridge could not be waited for");
    let _ = std::fs::remove_dir_all(&directory);

    (
        written,
        status.code().expect("the bridge was killed by a signal"),
    )
}

/// A port the OS just handed out and nobody holds any more. A race in theory — the port could
/// be taken between the drop and the child's bind, and the case then fails on a "listener
/// failed" line instead of on its own subject. That is the price of a binary that reads its
/// port from the environment, and a visible wrong failure beats a hidden right one.
fn free_port() -> u16 {
    let listener =
        std::net::TcpListener::bind("127.0.0.1:0").expect("no ephemeral port to test with");
    listener
        .local_addr()
        .expect("the bound port has no address")
        .port()
}

/// The case no in-process test can see: the answer to the last line before stdin's EOF.
///
/// `StdioRun` keeps the test's runtime alive after `serve` returns, so a bridge that drops its
/// writer there still passes in process. In the real process `main` returns, `#[tokio::main]`
/// tears the runtime down, and every answer that was not written yet goes with it — measured
/// as 0 bytes for `printf '…tools/list…\n' | browser-control-bridge`.
#[test]
fn mcp_process_theAnswerToTheLastLineBeforeStdinEof_shouldReachStdout() {
    // WHEN the client asks for the tool list and closes stdin immediately,
    let (stdout, exit_code) =
        run_bridge_process(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);

    // THEN stdout carries exactly one line, and it is the answer,
    let output = String::from_utf8_lossy(&stdout);
    let lines: Vec<&str> = output.lines().filter(|line| !line.is_empty()).collect();
    assert_eq!(lines.len(), 1, "stdout carried {} line(s): {output:?}", lines.len());
    let answer: Value =
        serde_json::from_str(lines[0]).expect("stdout carried a line that is not JSON");
    assert_eq!(answer["jsonrpc"], "2.0");
    assert_eq!(answer["id"], 2);
    assert!(
        answer["result"]["tools"]
            .as_array()
            .is_some_and(|tools| !tools.is_empty()),
        "no tool list in {answer}"
    );

    // ... it is the whole list and not a fragment of one,
    assert!(
        stdout.len() >= 7_000,
        "stdout carried only {} bytes: {output:?}",
        stdout.len()
    );

    // ... and everything was written before the process said goodbye with 0.
    assert_eq!(exit_code, 0);
}

/// `browser_help` liefert fuer jedes Werkzeug die sechs Abschnitte — und es antwortet
/// ohne verbundene Extension, weil Lesen keinen Browser braucht (spec 53).
#[tokio::test]
async fn help_forEveryTool_shouldAnswerWithTheSixSections() {
    // GIVEN a bridge with nobody connected, and the names the tool table offers,
    let names: Vec<String> = {
        let seam = Seam::nobody(config());
        let answer = answer_of(seam.ask(&json!({ "jsonrpc": "2.0", "id": 30, "method": "tools/list" }))).await;
        answer["result"]["tools"]
            .as_array()
            .expect("a tool array")
            .iter()
            .map(|tool| tool["name"].as_str().expect("a name").to_string())
            .collect()
    };

    // WHEN every name is asked for its manual,
    for name in names {
        let mut seam = Seam::nobody(config());
        let answer = seam.call(help_call(31, &name)).await;
        let text = answer["result"]["content"][0]["text"].as_str().unwrap_or_default();

        // THEN all six sections are there — no tool may ship a half manual,
        for section in ["## Purpose", "## Arguments", "## Returns", "## Example", "## Pitfalls", "## Related"] {
            assert!(text.contains(section), "{name} is missing {section}");
        }
    }
}

/// Ein unbekannter Name nennt die gueltigen: ein Aufruf genuegt zur Korrektur.
#[tokio::test]
async fn help_withAnUnknownTool_shouldNameTheValidOnes() {
    // GIVEN a bridge with nobody connected,
    let mut seam = Seam::nobody(config());

    // WHEN a name outside the contract is asked for,
    let answer = seam.call(help_call(32, "gibtsnicht")).await;

    // THEN the refusal names the wrong name and every valid one,
    let text = answer["result"]["content"][0]["text"].as_str().unwrap_or_default();
    assert_eq!(answer["result"]["isError"], true);
    assert!(text.contains("gibtsnicht"));
    assert!(text.contains("browser_read"));
}

/// Der Satz, der den Anlassfall verhindert haette: `browser_read` nimmt keine URL.
#[tokio::test]
async fn help_forRead_shouldSayThatItTakesNoUrl() {
    let mut seam = Seam::nobody(config());
    let answer = seam.call(help_call(33, "browser_read")).await;
    let text = answer["result"]["content"][0]["text"].as_str().unwrap_or_default();
    assert!(text.contains("no URL"), "the manual has to say it: {text}");
    assert!(text.contains("browser_navigate"));
}

/// Die Anleitung nennt jedes Feld der Leseantwort, in der Reihenfolge, in der es kommt:
/// `offset`, `truncated`, `mode` und die beiden Artikel-Felder standen lange nicht darin,
/// obwohl `readPageSource` (`extension/page-agent.js`) und `isUsablePageResult`
/// (`extension/bridge.js`) sie immer liefern. Ein Feld, das die Anleitung vergisst, ist
/// fuer den Agenten nicht vorhanden — dieselbe Luecke, die `docs/62` fuer `inspect`
/// geschlossen hat.
#[tokio::test]
async fn help_forRead_shouldNameEveryPageField() {
    // GIVEN a bridge with nobody connected — a manual needs no browser (`docs/53`):
    let mut seam = Seam::nobody(config());

    // WHEN the manual of `browser_read` is asked for,
    let answer = seam.call(help_call(37, "browser_read")).await;
    let text = answer["result"]["content"][0]["text"].as_str().unwrap_or_default();

    // THEN the returns section names every field — checked inside that section, because a
    // word anywhere in the manual would not be the field list,
    let returns = text
        .split("## Returns")
        .nth(1)
        .expect("the manual has a Returns section");
    let returns = returns.split("## ").next().unwrap_or(returns);

    // ... in the order the answer has: the fields of `pageResultOf`
    // (`extension/bridge.js`) and the settle pair behind them, `root`/`fellBack` between
    // `mode` and `settled` because that is where the article fields ride.
    let fields = [
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
    ];
    let mut cursor = 0;
    for field in fields {
        let quoted = format!("`{field}`");
        let found = returns[cursor..]
            .find(&quoted)
            .unwrap_or_else(|| panic!("the returns section has to name `{field}`: {returns}"));
        cursor += found + quoted.len();
    }
}

/// Die Engste-Regel und ihre zwei Ausnahmen stehen in der Anleitung: wer `contains_text`
/// sucht, bekommt das Ziel statt der Containerseite (`docs/57`, `## Ziel`, 4 und 5).
#[tokio::test]
async fn help_forInspect_shouldNameTheInnermostRule() {
    // GIVEN a bridge with nobody connected — a manual needs no browser (`docs/53`):
    let mut seam = Seam::nobody(config());

    // WHEN the manual of `browser_inspect` is asked for,
    let answer = seam.call(help_call(35, "browser_inspect")).await;
    let text = answer["result"]["content"][0]["text"].as_str().unwrap_or_default();

    // THEN its pitfalls name the rule — checked inside that section, because `selector`
    // stands in the argument table of every manual and would pass there for free:
    let pitfalls = text
        .split("## Pitfalls")
        .nth(1)
        .expect("the manual has a Pitfalls section");
    assert!(
        pitfalls.contains("innermost"),
        "the pitfalls have to name the innermost rule: {pitfalls}"
    );

    // ... and both exceptions: a selector without text keeps the ancestors, and
    // `includeHidden: true` hands out the raw list.
    assert!(
        pitfalls.contains("`selector` without `contains_text`"),
        "the selector exception is missing: {pitfalls}"
    );
    assert!(
        pitfalls.contains("`includeHidden: true`"),
        "the includeHidden exception is missing: {pitfalls}"
    );
}

/// Die zwoelf Elementfelder, in der Reihenfolge der Antwort — dieselbe Liste wie
/// `ELEMENT_FIELDS` in `hub.rs`. Sie steht hier als eigener Wert, weil die Anleitung sonst
/// nur gegen sich selbst geprueft wuerde: ein dreizehntes Feld, das sie vergisst, faellt
/// gegen diese Liste auf.
const ELEMENT_FIELDS: [&str; 12] = [
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
];

/// Die Anleitung nennt jedes Elementfeld: `browser_inspect` liefert `offscreen` in der
/// Rueckgabe (`docs/62`, `## Ziel`, 1 und `## Amendments` zu `docs/53`), und sie nennt
/// die drei Felder, die sie lange verschwieg, obwohl das Werkzeug sie immer liefert
/// (`docs/62`, `## Bekannte Luecken`: `index`, `ariaLabel`, `disabled`). Alle zwoelf, in
/// der Reihenfolge der Antwort.
#[tokio::test]
async fn help_forInspect_shouldNameEveryElementField() {
    // GIVEN a bridge with nobody connected — a manual needs no browser (`docs/53`):
    let mut seam = Seam::nobody(config());

    // WHEN the manual of `browser_inspect` is asked for,
    let answer = seam.call(help_call(36, "browser_inspect")).await;
    let text = answer["result"]["content"][0]["text"].as_str().unwrap_or_default();

    // THEN the returns section names the field — checked inside that section, because a
    // word anywhere in the manual would not be the field list,
    let returns = text
        .split("## Returns")
        .nth(1)
        .expect("the manual has a Returns section");
    let returns = returns.split("## ").next().unwrap_or(returns);
    assert!(
        returns.contains("`offscreen`"),
        "the returns section has to name the field: {returns}"
    );

    // ... and it is the field, not the error code of another tool.
    assert!(
        !returns.contains("offscreen_after_scroll"),
        "the returns section lists fields, not error codes: {returns}"
    );

    // ... and the whole list decides, not only this one field: exactly the twelve names
    // of `ELEMENT_FIELDS`, in the wire order. An ordered-subsequence check would let a
    // thirteenth field through that the manual forgets, and so would a bare count — the
    // parsed list is compared as a whole, one name per place (`docs/62`: `offscreen`
    // vor `disabled`).
    let list = returns
        .split("each with ")
        .nth(1)
        .and_then(|rest| rest.split(')').next())
        .unwrap_or_else(|| panic!("the returns section lists the element fields: {returns}"));
    let named: Vec<&str> = list
        .split(',')
        .map(|name| name.trim().trim_matches('`'))
        .collect();
    assert_eq!(
        named, ELEMENT_FIELDS,
        "the returns section has to name every element field once, in the wire order: {returns}"
    );
}

/// Die Anleitung nennt dieselben Namen wie das Schema — sie ist Produktivcode, kein
/// Doku-Nachtrag (`docs/59`, Ziel 5).
#[tokio::test]
async fn help_forInspectAndType_shouldNameTheNewArguments() {
    // GIVEN a bridge with nobody connected — a manual needs no browser (`docs/53`):
    for (tool, argument) in [
        ("browser_inspect", "contains_text"),
        ("browser_type", "typed_text"),
    ] {
        let mut seam = Seam::nobody(config());

        // WHEN the manual is asked for,
        let answer = seam.call(help_call(34, tool)).await;
        let text = answer["result"]["content"][0]["text"].as_str().unwrap_or_default();

        // THEN the argument table names it,
        assert!(
            text.contains(&format!("| `{argument}` |")),
            "{tool} does not list {argument}: {text}"
        );

        // ... and so does the example, in the JSON form a caller copies.
        assert!(
            text.contains(&format!("\"{argument}\":")),
            "{tool} does not show {argument} in its example: {text}"
        );
    }
}
