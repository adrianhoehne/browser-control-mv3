//! The hub: one session, the deadlines around it, the status line, the debug block
//! and the log lines.
//!
//! The 55 cases of `test/hub.test.js` under their Node names: 2
//! `formatStatusLine_*`, 9 `debugBlockOf_*`, 3 `verifyToken_*` and 41 `hub_*`.
//!
//! The Node suite needed a real HTTP server and a real `WebSocket` client, because
//! the hub's state lived behind a socket and could only be observed by polling it.
//! Here the hub *is* socket-free: `on_message` is driven directly and its whole
//! output is read out of the `Outbound` channel. Nothing below binds a port, and no
//! clock is stubbed — the deadlines are `tokio::time`'s with the values from the
//! config, kept between 100 and 300 ms.
//!
//! The case names are the Node ones so the mapping stays readable; `docs/38`,
//! `### What could go wrong` names the allow.

#![allow(non_snake_case)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use browser_control_bridge::config::Config;
use browser_control_bridge::hub::{
    debug_block_of, format_status_line, verify_token, ConnectionId, FailureKind, Hub,
    HubRequestError, Outbound,
};
use browser_control_bridge::log::Level;
use browser_control_bridge::protocol;
use browser_control_bridge::ws::CloseInfo;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/* ------------------------------------------------------------------ helpers */

/// Long enough for a real 300 ms deadline to fire, short enough that a hub which
/// never answers fails the case instead of holding the suite open.
const STEP_TIMEOUT: Duration = Duration::from_secs(5);

/// `main.rs` logs the bare IP (`peer_address.ip()`), the template logged
/// `socket.remoteAddress` — a `host:port` literal here would prove a shape the
/// product does not produce.
const PEER: &str = "127.0.0.1";
const OTHER_PEER: &str = "127.0.0.2";

/// The one frame nothing else pins: no artefact records it, and the Node case only
/// waits for `type: welcome`. Hard-coded here so the field names cannot drift.
const WELCOME_FRAME: &str = r#"{"type":"welcome","protocol":1,"bridgeVersion":"0.1.0"}"#;

/// The token, generated per run in Node. A 32-character hex literal would trip the
/// "no secrets in the repo" grep (`CONTRIBUTING.md`), so this builds one at runtime
/// from a two-character literal — same length, same alphabet, no secret in a diff.
fn token() -> String {
    "ab".repeat(16)
}

/// Same length on purpose: the interesting path is the compare, not the length
/// reject.
fn flipped(current: &str) -> String {
    let replacement = if current.starts_with('a') { "b" } else { "a" };
    format!("{replacement}{}", &current[1..])
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

fn hello_frame(token: &str) -> String {
    json!({
        "type": protocol::types::HELLO,
        "protocol": protocol::VERSION,
        "extensionVersion": "0.1.0",
        "browser": { "name": "Firefox", "version": "152.0.3" },
        "token": token,
    })
    .to_string()
}

fn response_frame(result: Value, id: u64) -> String {
    json!({
        "type": protocol::types::RESPONSE,
        "id": id,
        "ok": true,
        "result": result,
    })
    .to_string()
}

fn failure_frame(error: Value, id: u64) -> String {
    json!({
        "type": protocol::types::RESPONSE,
        "id": id,
        "ok": false,
        "error": error,
    })
    .to_string()
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("the hub wrote something that is not JSON")
}

fn keys_of(value: &Value) -> Vec<String> {
    value
        .as_object()
        .expect("the block is an object")
        .keys()
        .cloned()
        .collect()
}

/// The finished block of one method, parsed — the way an operator reads it.
fn block(method: &str, result: &Value) -> Value {
    let text = debug_block_of(method, result).expect("the method has a whitelist entry");
    parse(&text)
}

fn block_text(method: &str, result: &Value) -> String {
    debug_block_of(method, result).expect("the method has a whitelist entry")
}

/// One hub, its log lines and its `status` seam. Shared by every connection of a
/// case, exactly like the template's `Hub` was shared by two sockets.
struct TestBridge {
    hub: Arc<Hub>,
    log: Arc<Mutex<Vec<String>>>,
    statuses: Arc<Mutex<Vec<Value>>>,
}

impl TestBridge {
    fn start(config: Config) -> TestBridge {
        let log = Arc::new(Mutex::new(Vec::new()));
        let statuses: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));

        let log_sink = Arc::clone(&log);
        let status_sink = Arc::clone(&statuses);
        let hub = Arc::new(
            Hub::new(&config, token())
                // The timestamp prefix belongs to the process; here the raw message
                // is what the assertions look at.
                .with_log(Arc::new(move |line: &str| {
                    log_sink.lock().expect("log lock").push(line.to_string());
                }))
                .with_status(Arc::new(move |result: &Value| {
                    status_sink.lock().expect("status lock").push(result.clone());
                })),
        );

        TestBridge { hub, log, statuses }
    }

    /// One connection: a channel in place of a socket, and the open flag the hub
    /// reads instead of asking a transport.
    fn connect(&self, peer: &str) -> Client {
        let (outbound, receiver) = mpsc::unbounded_channel();
        let open = Arc::new(AtomicBool::new(true));
        let connection = self
            .hub
            .handle_connection(outbound, Arc::clone(&open), peer);
        Client {
            hub: Arc::clone(&self.hub),
            outbound: receiver,
            open,
            connection,
        }
    }

    fn lines(&self) -> Vec<String> {
        self.log.lock().expect("log lock").clone()
    }

    fn statuses(&self) -> Vec<Value> {
        self.statuses.lock().expect("status lock").clone()
    }

    /// The first line matching `wanted`, waiting for it: a deadline's line is
    /// written by a timer task, so "not there yet" is a normal answer.
    async fn wait_for_line(&self, wanted: impl Fn(&str) -> bool) -> String {
        let deadline = tokio::time::Instant::now() + STEP_TIMEOUT;
        loop {
            if let Some(line) = self.lines().into_iter().find(|line| wanted(line)) {
                return line;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no matching log line within the step timeout; log so far: {:?}",
                self.lines(),
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn index_of(&self, line: &str) -> usize {
        self.lines()
            .iter()
            .position(|candidate| candidate == line)
            .unwrap_or_else(|| panic!("no such log line: {line}; log: {:?}", self.lines()))
    }
}

/// One connection as the test sees it.
struct Client {
    hub: Arc<Hub>,
    outbound: mpsc::UnboundedReceiver<Outbound>,
    open: Arc<AtomicBool>,
    connection: ConnectionId,
}

impl Client {
    fn say(&self, text: &str) {
        self.hub.on_message(self.connection, text);
    }

    fn hello(&self) {
        self.say(&hello_frame(&token()));
    }

    fn hello_with(&self, token: &str) {
        self.say(&hello_frame(token));
    }

    async fn next(&mut self) -> Outbound {
        tokio::time::timeout(STEP_TIMEOUT, self.outbound.recv())
            .await
            .expect("the hub wrote nothing within the step timeout")
            .expect("the hub dropped its outbound channel")
    }

    async fn next_text(&mut self) -> String {
        match self.next().await {
            Outbound::Text(text) => text,
            other => panic!("expected a text frame, got {other:?}"),
        }
    }

    async fn next_message(&mut self) -> Value {
        parse(&self.next_text().await)
    }

    /// Searched by type, never by position: `welcome` and the automatic `request`
    /// arrive back to back, and a case must not depend on which one it reads first.
    async fn wait_for_message(&mut self, kind: &str) -> Value {
        loop {
            let message = self.next_message().await;
            if message.get("type").and_then(Value::as_str) == Some(kind) {
                return message;
            }
        }
    }

    async fn wait_for_request(&mut self, id: u64) -> Value {
        loop {
            let message = self.next_message().await;
            if message.get("type").and_then(Value::as_str) == Some(protocol::types::REQUEST)
                && message.get("id").and_then(Value::as_u64) == Some(id)
            {
                return message;
            }
        }
    }

    async fn wait_for_request_method(&mut self, method: &str) -> Value {
        loop {
            let message = self.next_message().await;
            if message.get("type").and_then(Value::as_str) == Some(protocol::types::REQUEST)
                && message.get("method").and_then(Value::as_str) == Some(method)
            {
                return message;
            }
        }
    }

    async fn wait_for_close(&mut self) -> CloseInfo {
        loop {
            match self.next().await {
                Outbound::Close { code, reason } => return CloseInfo { code, reason },
                Outbound::Text(_) => continue,
            }
        }
    }

    /// What the hub wrote if it wrote anything — `None` is the assertion that the
    /// hub stayed quiet.
    fn try_next(&mut self) -> Option<Outbound> {
        self.outbound.try_recv().ok()
    }

    fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Answers the automatic `status` request the handshake fires, so that the only
    /// request in flight afterwards is the case's own.
    fn answer_automatic_status(&self) {
        self.say(&response_frame(json!({ "windows": [] }), 1));
    }
}

fn spawn_request(
    hub: &Arc<Hub>,
    method: &'static str,
    params: Value,
) -> JoinHandle<Result<Value, HubRequestError>> {
    let hub = Arc::clone(hub);
    tokio::spawn(async move { hub.request(method, params).await })
}

fn spawn_status(hub: &Arc<Hub>) -> JoinHandle<Result<Value, HubRequestError>> {
    let hub = Arc::clone(hub);
    tokio::spawn(async move { hub.request_status().await })
}

async fn result_of(handle: JoinHandle<Result<Value, HubRequestError>>) -> Value {
    match handle.await.expect("the request task panicked") {
        Ok(result) => result,
        Err(error) => panic!("the request failed: {error:?}"),
    }
}

async fn error_of(handle: JoinHandle<Result<Value, HubRequestError>>) -> HubRequestError {
    match handle.await.expect("the request task panicked") {
        Ok(result) => panic!("the request resolved with {result}"),
        Err(error) => error,
    }
}

/// `… peer=<peer>` with a peer that holds no whitespace and is not empty — the
/// shape every `peer=` token of the template has, asserted rather than assumed.
fn peer_token(line: &str, prefix: &str, suffix: &str) -> String {
    let peer = line
        .strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix(suffix))
        .unwrap_or_else(|| panic!("unexpected line: {line}"));
    assert!(!peer.is_empty(), "no peer in: {line}");
    assert!(
        !peer.contains(char::is_whitespace),
        "the peer carries whitespace: {line}"
    );
    peer.to_string()
}

fn close_info(code: u16, reason: &str) -> CloseInfo {
    CloseInfo {
        code,
        reason: reason.to_string(),
    }
}

/* --------------------------------------------------------- formatStatusLine */

#[test]
fn formatStatusLine_withTwoWindows_shouldSumTabsAcrossAllWindows() {
    // GIVEN a status result whose windows hold two and one tabs:
    let result = json!({
        "windows": [
            { "id": 1, "tabs": [{ "id": 101 }, { "id": 102 }] },
            { "id": 2, "tabs": [{ "id": 201 }] },
        ],
    });

    // WHEN the single log line is formatted,
    // THEN the tab count is the sum over all windows, not the first window's count:
    assert_eq!(format_status_line(&result), "status windows=2 tabs=3");
}

#[test]
fn formatStatusLine_withoutWindows_shouldReportZeros() {
    // GIVEN results that carry no window list at all,
    // WHEN they are formatted,
    // THEN counting nothing is not an error:
    assert_eq!(format_status_line(&json!({})), "status windows=0 tabs=0");
    assert_eq!(format_status_line(&Value::Null), "status windows=0 tabs=0");
}

/* ------------------------------------------------------------ debugBlockOf */

/*
 * The whitelist is the contract, so these cases read it the way an operator reads the
 * stderr stream: keys in table order, page text as a length, and anything the table
 * does not name as a marker — never its value, never its length.
 */

#[test]
fn debugBlockOf_withAKnownMethod_shouldPrintExactlyTheWhitelistedFieldsInTableOrder() {
    // GIVEN a read result that carries every whitelisted field, deliberately in a
    // different order than the table (a result arrives in whatever order the
    // extension serialised it):
    let result = json!({
        "waitedMs": 7,
        "settled": true,
        "fellBack": false,
        "root": null,
        "mode": "full",
        "via": "innerText",
        "truncated": false,
        "totalChars": 22,
        "chars": 22,
        "offset": 0,
        "text": "Zeile eins",
        "title": "Beispielseite",
        "url": "https://example.org/",
        "tabId": 42,
    });

    // WHEN the block is built for the read method,
    let projected = block(protocol::methods::READ, &result);

    // THEN the keys follow the table, not the result,
    assert_eq!(
        keys_of(&projected),
        [
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
    );

    // ... the two page strings appear as their lengths while the identifying fields
    // stay readable, and `null` on a `full` field is still a fact:
    assert_eq!(projected["title"], json!("<13 chars>"));
    assert_eq!(projected["text"], json!("<10 chars>"));
    assert_eq!(projected["url"], json!("https://example.org/"));
    assert_eq!(projected["root"], Value::Null);
    assert_eq!(projected["settled"], json!(true));
}

#[test]
fn debugBlockOf_withAnUnlistedField_shouldPrintTheMarkerInsteadOfValueAndLength() {
    // GIVEN a read result with a field nobody entered in the table:
    let result = json!({ "tabId": 42, "surpriseField": "geheim" });

    // WHEN the block is built,
    let text = block_text(protocol::methods::READ, &result);
    let projected = parse(&text);

    // THEN the key survives with the marker as its value,
    assert_eq!(
        projected,
        json!({ "tabId": 42, "surpriseField": "<unlisted field>" }),
    );

    // ... and neither the content nor a length of it reaches the block — a length
    // would give a short field away just as well:
    assert!(
        !text.contains("geheim"),
        "the unlisted value must not reach the block"
    );
    assert!(
        !text.contains("<6 chars>"),
        "not even the length of an unlisted field may appear"
    );
}

#[test]
fn debugBlockOf_withTwoUnlistedFields_shouldKeepBothKeys() {
    // GIVEN a result with two fields that are not in the table and would look alike
    // once their values are replaced:
    let result = json!({ "tabId": 42, "surpriseA": "geheim", "surpriseB": "auch geheim" });

    // WHEN the block is built,
    let projected = block(protocol::methods::READ, &result);

    // THEN each keeps its own key at the end of the block, so two strangers do not
    // collapse into one entry:
    assert_eq!(keys_of(&projected), ["tabId", "surpriseA", "surpriseB"]);
    assert_eq!(
        projected,
        json!({
            "tabId": 42,
            "surpriseA": "<unlisted field>",
            "surpriseB": "<unlisted field>",
        }),
    );
}

#[test]
fn debugBlockOf_withAnUnlistedFieldInsideAnElement_shouldPrintTheMarkerThere() {
    // GIVEN an inspect result whose element carries a field the element shape does
    // not name:
    let result = json!({
        "tabId": 42,
        "count": 1,
        "elements": [{ "index": 0, "text": "Kaufen", "surpriseInside": "geheim" }],
    });

    // WHEN the block is built,
    let projected = block(protocol::methods::INSPECT, &result);

    // THEN the nesting is projected field by field, so the marker lands inside the
    // element rather than the whole element being dropped or printed in full:
    assert_eq!(
        keys_of(&projected["elements"][0]),
        ["index", "text", "surpriseInside"],
    );
    assert_eq!(projected["elements"][0]["text"], json!("<6 chars>"));
    assert_eq!(
        projected["elements"][0]["surpriseInside"],
        json!("<unlisted field>"),
    );
}

#[test]
fn debugBlockOf_withScrolledAndOffscreen_shouldPrintTheValuesInsteadOfTheMarker() {
    // GIVEN a click result carrying `scrolled` and an inspect element carrying
    // `offscreen` — the two booleans that arrived in later increments (`docs/56`,
    // `docs/62`) and sit in the tables since:
    let click = json!({
        "tabId": 42,
        "clicked": "a#video-title-link",
        "scrolled": true,
    });
    let inspect = json!({
        "tabId": 42,
        "elements": [{ "index": 0, "visible": true, "offscreen": true, "disabled": false }],
    });

    // WHEN both blocks are built,
    let click_text = block_text(protocol::methods::CLICK, &click);
    let click_block = parse(&click_text);
    let inspect_block = block(protocol::methods::INSPECT, &inspect);
    let inspect_text = block_text(protocol::methods::INSPECT, &inspect);

    // THEN both print their value — a boolean is a fact about the call, not page
    // content, so neither a marker nor a length would be the truth:
    assert_eq!(click_block["scrolled"], json!(true));
    assert_eq!(inspect_block["elements"][0]["offscreen"], json!(true));
    assert!(
        !click_text.contains("<unlisted field>") && !inspect_text.contains("<unlisted field>"),
        "a listed boolean must not print the marker: {click_text} {inspect_text}",
    );

    // ... in the order the answer carries them: `scrolled` directly behind
    // `clicked`, `offscreen` between `visible` and `disabled`,
    assert_eq!(keys_of(&click_block), ["tabId", "clicked", "scrolled"]);
    assert_eq!(
        keys_of(&inspect_block["elements"][0]),
        ["index", "visible", "offscreen", "disabled"],
    );
}

#[test]
fn debugBlockOf_withAMethodWithoutATableEntry_shouldReturnNull() {
    // GIVEN the methods that are silent on purpose — eval, screenshot, open_tab,
    // close_tab and frames, which has no report branch at all — plus one name no
    // protocol knows, plus the two names every object inherits from
    // `Object.prototype`: a plain "is it undefined" lookup would hand those a block
    // full of markers, which is why the table is searched rather than indexed.
    let silent_methods = [
        protocol::methods::EVAL,
        protocol::methods::SCREENSHOT,
        protocol::methods::OPEN_TAB,
        protocol::methods::CLOSE_TAB,
        protocol::methods::FRAMES,
        "frobnicate",
        "constructor",
        "toString",
    ];

    // WHEN a block is requested for each of them,
    // THEN the answer is `None` — "write nothing", not a block full of markers:
    for method in silent_methods {
        assert_eq!(
            debug_block_of(method, &json!({ "tabId": 42, "result": "geheim" })),
            None,
            "{method} must have no block",
        );
    }
}

#[test]
fn debugBlockOf_withALengthFieldCarryingANonString_shouldPrintTheMarkerAndKeepNull() {
    // GIVEN a `length` field (`text`) carrying a number and another (`title`)
    // carrying `null`:
    let result = json!({ "tabId": 42, "title": null, "text": 42 });

    // WHEN the block is built,
    let projected = block(protocol::methods::READ, &result);

    // THEN `null` survives as the statement "there is none",
    assert_eq!(projected["title"], Value::Null);

    // ... and a number where a page string was expected is content of a kind the
    // table never judged, so it becomes the marker:
    assert_eq!(projected["text"], json!("<unlisted field>"));
}

#[test]
fn debugBlockOf_withAMissingListedField_shouldNotInventIt() {
    // GIVEN a read result carrying only two of the fourteen whitelisted fields:
    let result = json!({ "tabId": 42, "truncated": false });

    // WHEN the block is built,
    let projected = block(protocol::methods::READ, &result);

    // THEN the listed-but-absent fields are simply not there — a `null` for a field
    // the extension never sent would be an invention, and reading it as "empty"
    // would be worse than the hole:
    assert_eq!(projected, result);
    assert_eq!(keys_of(&projected), ["tabId", "truncated"]);
}

#[test]
fn debugBlockOf_withALengthEachFieldCarryingANonArray_shouldPrintTheMarker() {
    // GIVEN an inspect element whose `classes` — a `lengthEach` field — carries a
    // plain string instead of a list, the shape a broken extension would send:
    let result = json!({ "tabId": 42, "elements": [{ "index": 0, "classes": "knopf" }] });

    // WHEN the block is built,
    let projected = block(protocol::methods::INSPECT, &result);

    // THEN the field prints the marker rather than a length it cannot vouch for: the
    // string's length would describe content of a kind the table never judged, and
    // printing it in full is the one thing the whitelist exists to prevent.
    assert_eq!(projected["elements"][0]["classes"], json!("<unlisted field>"));
}

#[test]
fn debugBlockOf_withAResultThatIsNoObject_shouldPrintItAsItArrived() {
    // GIVEN a result that is no mapping — a list, the one shape no report branch
    // builds but a broken or hostile extension can send:
    let result = json!(["geheim"]);

    // WHEN the block is built for a method that does have a table entry,
    let text = block_text(protocol::methods::READ, &result);

    // THEN today the value is printed in full — a known gap, pinned rather than
    // approved (spec 28, `## Bekannte Lücken`), so it cannot widen unnoticed:
    assert_eq!(text, serde_json::to_string_pretty(&result).expect("pretty"));
    assert!(
        text.contains("geheim"),
        "the gap: a non-object result is not projected"
    );
}

/* --------------------------------------------------------------- verifyToken */

#[test]
fn verifyToken_withTheExpectedToken_shouldReturnTrue() {
    // GIVEN the configured token,
    // WHEN it is compared with itself,
    // THEN it matches:
    assert!(verify_token(&token(), &token()));
}

#[test]
fn verifyToken_withSameLengthButDifferentToken_shouldReturnFalse() {
    // GIVEN a candidate of the same length that differs in the first character,
    // WHEN it is compared,
    // THEN it is rejected — the constant-time compare is the deciding step:
    let expected = token();
    assert!(!verify_token(&expected, &flipped(&expected)));
}

#[test]
fn verifyToken_withShorterCandidate_shouldReturnFalse() {
    // GIVEN a candidate shorter than the configured token,
    // WHEN it is compared,
    // THEN it is rejected before anything is hashed:
    let expected = token();
    assert!(!verify_token(&expected, &expected[..expected.len() - 1]));
    assert!(!verify_token(&expected, ""));
}

/* -------------------------------------------------------------- hello/auth */

#[tokio::test]
async fn hub_withWrongToken_shouldCloseWith4401AndKeepTheTokenOutOfTheLog() {
    // GIVEN a running hub and a client that sends a wrong token of the right length:
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);

    // WHEN the client presents it in `hello`,
    client.hello_with(&flipped(&token()));

    // THEN the bridge closes with 4401, logs exactly one auth failure and never
    // repeats the token:
    let close = client.wait_for_close().await;
    assert_eq!(close.code, protocol::close::AUTH_FAILED);

    let auth_line = bridge
        .wait_for_line(|line| line.starts_with("auth failed"))
        .await;
    assert_eq!(peer_token(&auth_line, "auth failed peer=", ""), PEER);
    let joined = bridge.lines().join("\n");
    assert!(
        !joined.contains(&token()),
        "the log must not contain the token"
    );
}

#[tokio::test]
async fn hub_withoutHelloWithinTheHelloTimeout_shouldCloseWith4408() {
    // GIVEN a hub whose hello deadline is 200 ms,
    let bridge = TestBridge::start(test_config(200, 10_000, Level::Info));

    // WHEN a client connects and says nothing,
    let mut client = bridge.connect(PEER);
    let close = client.wait_for_close().await;

    // THEN the hub closes with 4408:
    assert_eq!(close.code, protocol::close::HELLO_TIMEOUT);
}

#[tokio::test]
async fn hub_withForeignFirstFrame_shouldCloseWith1002AndLogAProtocolError() {
    // GIVEN a running hub and a client whose first message is not a `hello`:
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);

    // WHEN that message arrives,
    client.say(&json!({ "type": "nope" }).to_string());

    // THEN the hub closes with 1002 and logs a protocol error naming the peer:
    let close = client.wait_for_close().await;
    assert_eq!(close.code, protocol::close::PROTOCOL_ERROR);

    let protocol_line = bridge
        .wait_for_line(|line| line.starts_with("protocol error"))
        .await;
    assert_eq!(peer_token(&protocol_line, "protocol error peer=", ""), PEER);
}

#[tokio::test]
async fn hub_afterWelcome_shouldKeepTheConnectionUsablePastTheHelloTimeout() {
    // GIVEN a hub whose hello deadline is 200 ms and a client that already said hello:
    let bridge = TestBridge::start(test_config(200, 2_000, Level::Info));
    let mut client = bridge.connect(PEER);

    client.hello();
    // The `welcome` frame is pinned here, byte for byte. No artefact records it and
    // no other case reads it: a field name drifting away from what the extension
    // expects would otherwise be noticed by nothing until a browser connects.
    assert_eq!(client.next_text().await, WELCOME_FRAME);
    // The automatic status request follows it: id 1, no params.
    assert_eq!(
        client.next_message().await,
        json!({
            "type": protocol::types::REQUEST,
            "id": 1,
            "method": protocol::methods::STATUS,
            "params": {},
        }),
    );

    // WHEN nothing happens for twice the hello deadline,
    tokio::time::sleep(Duration::from_millis(400)).await;

    // THEN the hello timer is gone: no close, and the connection still answers — a
    // status response is logged instead of hitting a dead socket.
    assert!(client.is_open(), "the hub closed a healthy connection");
    assert_eq!(client.try_next(), None, "the hub wrote more than expected");

    client.say(&response_frame(
        json!({ "windows": [{ "id": 1, "tabs": [{ "id": 101 }, { "id": 102 }] }] }),
        1,
    ));
    bridge
        .wait_for_line(|line| line == "status windows=1 tabs=2")
        .await;
}

/* -------------------------------------------------------------------- status */

#[tokio::test]
async fn hub_withSecondValidConnection_shouldReplaceOnlyThePreviousOneWith4409() {
    // GIVEN an authenticated client and a hub that remembered it:
    let bridge = TestBridge::start(config());
    let mut first = bridge.connect(PEER);
    first.hello();
    first.wait_for_message(protocol::types::WELCOME).await;

    // WHEN a second valid connection arrives,
    let mut second = bridge.connect(OTHER_PEER);
    second.hello();
    second.wait_for_message(protocol::types::WELCOME).await;

    // THEN the previous connection is closed with 4409 while the new one keeps
    // working — "the newest wins" must not cost the new connection its socket:
    let close = first.wait_for_close().await;
    assert_eq!(close.code, protocol::close::REPLACED);

    let request = second.wait_for_message(protocol::types::REQUEST).await;
    assert_eq!(
        request,
        json!({
            "type": protocol::types::REQUEST,
            "id": 1,
            "method": protocol::methods::STATUS,
            "params": {},
        }),
    );
    assert!(second.is_open());
    assert_eq!(second.try_next(), None);
}

#[tokio::test]
async fn hub_withoutStatusResponse_shouldLogStatusTimeoutAndKeepTheConnection() {
    // GIVEN a hub whose status deadline is 200 ms and a client that stays silent:
    let bridge = TestBridge::start(test_config(2_000, 200, Level::Info));
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;

    // WHEN no answer arrives in time,
    let timeout_line = bridge
        .wait_for_line(|line| line.starts_with("status timeout"))
        .await;

    // THEN the log says so and the connection survives:
    assert_eq!(peer_token(&timeout_line, "status timeout peer=", ""), PEER);
    assert!(client.is_open());
    assert_eq!(client.try_next(), None);
}

#[tokio::test]
async fn hub_withStatusFailureResponse_shouldLogTheCodeAndKeepTheConnection() {
    // GIVEN an authenticated client that received the status request:
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;

    // WHEN it answers with `ok:false`,
    client.say(&failure_frame(
        json!({ "code": "unsupported_method", "message": "only status is known" }),
        1,
    ));

    // THEN the code is logged and the connection stays open — a failing method is
    // not a reason to hang up:
    let failed_line = bridge
        .wait_for_line(|line| line.starts_with("status failed"))
        .await;
    assert_eq!(
        failed_line,
        format!("status failed peer={PEER} code=unsupported_method"),
    );
    assert!(client.is_open());
    assert_eq!(client.try_next(), None);
}

#[tokio::test]
async fn hub_withDebugLogging_shouldLogTheStatusLineAndTheIndentedResult() {
    // GIVEN a hub started with BC_LOG=debug:
    let bridge = TestBridge::start(debug_config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;

    // WHEN a successful status response arrives,
    let result = json!({ "windows": [{ "id": 1, "tabs": [{ "id": 101 }] }] });
    client.say(&response_frame(result.clone(), 1));

    // THEN the summary line comes first and the full result follows as JSON, and the
    // result also reaches the `onStatus` seam. Byte-identical to the result on
    // purpose: parity comparison 7 pins this block from the outside, so `url` and
    // `title` are the only fields it prints in full.
    bridge
        .wait_for_line(|line| line == "status windows=1 tabs=1")
        .await;
    let json_line = bridge.wait_for_line(|line| line.starts_with('{')).await;
    assert_eq!(
        json_line,
        serde_json::to_string_pretty(&result).expect("pretty"),
    );
    assert_eq!(bridge.statuses(), vec![result]);
}

/* -------------------------------------------------------- requestStatus seam */

#[tokio::test]
async fn hub_withDebugLogging_shouldLogTheNavigateLineAndTheIndentedResult() {
    // GIVEN a hub started with BC_LOG=debug and an answered automatic status
    // request, so the only request in flight below is this test's own:
    let bridge = TestBridge::start(debug_config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a navigation is answered successfully,
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::NAVIGATE,
        json!({ "url": "https://example.org/" }),
    );
    let request = client.wait_for_request(2).await;
    let result = json!({
        "tabId": 42,
        "windowId": 1,
        "url": "https://example.org/",
        "title": "Example Domain",
        "complete": true,
    });
    client.say(&response_frame(result.clone(), request["id"].as_u64().expect("an id")));
    assert_eq!(result_of(pending).await, result);

    // THEN the proof line is written exactly as the spec words it,
    let navigate_line = bridge
        .wait_for_line(|line| line == "navigate tab=42 url=https://example.org/ complete=true")
        .await;

    // ... followed by the whitelist block as indented JSON — table order, `url` in
    // full, `title` as the length of the page text it is:
    let debug_entry = bridge
        .wait_for_line(|line| line.contains("\"tabId\": 42"))
        .await;
    let expected = json!({
        "tabId": 42,
        "windowId": 1,
        "url": "https://example.org/",
        "title": "<14 chars>",
        "complete": true,
    });
    assert_eq!(
        keys_of(&parse(&debug_entry)),
        keys_of(&expected),
        "table order, not result order",
    );
    assert_eq!(parse(&debug_entry), expected);
    assert!(
        debug_entry.contains("\n  \"windowId\": 1"),
        "the result must be indented, not a second one-liner",
    );
    assert!(
        bridge.index_of(&debug_entry) > bridge.index_of(&navigate_line),
        "the summary line comes before the debug block",
    );
}

/* --------------------------------------------------------------------- read */

#[tokio::test]
async fn hub_requestWithReadMethod_shouldResolveAndLogOneLineWithoutAnyPageText() {
    // GIVEN a hub started with BC_LOG=debug — the setting that writes a debug block
    // to stderr — and an answered automatic status request, so the only request in
    // flight below is this test's own:
    let bridge = TestBridge::start(debug_config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a read is answered, with an invented text so that nobody's page is in
    // this test, and with the two settle fields the extension appends:
    let pending = spawn_request(&bridge.hub, protocol::methods::READ, json!({}));
    let request = client.wait_for_request(2).await;
    let result = json!({
        "tabId": 42,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "text": "Zeile eins\n\nZeile zwei",
        "truncated": false,
        "via": "innerText",
        "settled": true,
        "waitedMs": 7,
    });
    client.say(&response_frame(result.clone(), request["id"].as_u64().expect("an id")));
    assert_eq!(result_of(pending).await, result);

    // THEN the proof line names tab, URL, length, flag and source, exactly as the
    // spec words it,
    let read_line = bridge
        .wait_for_line(|line| line.starts_with("read tab="))
        .await;
    assert_eq!(
        read_line,
        "read tab=42 url=https://example.org/ chars=22 truncated=false via=innerText",
    );

    // ... the debug block carries the count where the text was — writing the result
    // itself would put the operator's page text on stderr,
    let debug_entry = bridge
        .wait_for_line(|line| line.contains("\"text\": \"<22 chars>\""))
        .await;
    assert!(
        debug_entry.starts_with('{'),
        "the debug block is the indented JSON result",
    );

    // ... its keys follow the whitelist table in order, which is what makes the block
    // readable the same way for every answer (the listed fields this result does not
    // carry — `offset`, `chars`, `mode`, `root`, … — are absent, not null),
    let projected = parse(&debug_entry);
    assert_eq!(
        keys_of(&projected),
        [
            "tabId",
            "url",
            "title",
            "text",
            "truncated",
            "via",
            "settled",
            "waitedMs",
        ],
    );

    // ... the title is page text too and appears as its length while the URL stays
    // the operator's address,
    assert_eq!(projected["title"], json!("<13 chars>"));
    assert_eq!(projected["url"], json!("https://example.org/"));
    assert_eq!(projected["waitedMs"], json!(7));

    // ... no line anywhere contains the page text,
    assert!(
        !bridge.lines().iter().any(|line| line.contains("Zeile eins")),
        "the page text must not reach the log",
    );

    // ... and `read` does not feed the `status` seam.
    assert_eq!(bridge.statuses(), vec![json!({ "windows": [] })]);
}

#[tokio::test]
async fn hub_requestWithReadMethodAndAForeignFieldUnderDebugLogging_shouldPrintTheMarkerAndNotTheValue() {
    // GIVEN a hub started with BC_LOG=debug and an answered automatic status request:
    let bridge = TestBridge::start(debug_config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a read answer carries a field the whitelist does not know — the shape a
    // field added by a future extension version would have:
    let pending = spawn_request(&bridge.hub, protocol::methods::READ, json!({}));
    let request = client.wait_for_request(2).await;
    client.say(&response_frame(
        json!({
            "tabId": 42,
            "url": "https://example.org/",
            "title": "Beispielseite",
            "text": "Zeile eins",
            "truncated": false,
            "via": "innerText",
            "surpriseField": "geheim",
        }),
        request["id"].as_u64().expect("an id"),
    ));
    result_of(pending).await;

    // THEN the block names the field but not its value,
    let debug_entry = bridge
        .wait_for_line(|line| line.contains("\"surpriseField\": \"<unlisted field>\""))
        .await;
    let projected = parse(&debug_entry);
    assert_eq!(projected["surpriseField"], json!("<unlisted field>"));
    assert_eq!(
        keys_of(&projected).last().map(String::as_str),
        Some("surpriseField"),
        "unlisted fields hang at the end",
    );

    // ... and the value does not appear anywhere in the log — the string itself, not
    // a count of lines, is the assertion that proves the reversal of direction:
    assert!(
        !bridge.lines().iter().any(|line| line.contains("geheim")),
        "an unlisted value must never reach the log",
    );
}

#[tokio::test]
async fn hub_requestWithReadMethodUnderInfoLogging_shouldWriteNoDebugBlock() {
    // GIVEN a hub at the default log level and an answered automatic status request:
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a read is answered,
    let pending = spawn_request(&bridge.hub, protocol::methods::READ, json!({}));
    let request = client.wait_for_request(2).await;
    client.say(&response_frame(
        json!({
            "tabId": 42,
            "url": "https://example.org/",
            "title": "Beispielseite",
            "text": "Zeile eins",
            "truncated": false,
        }),
        request["id"].as_u64().expect("an id"),
    ));
    result_of(pending).await;

    // THEN the line is written and no message is a JSON block — the level stays the
    // switch, whatever the whitelist says:
    bridge
        .wait_for_line(|line| line.starts_with("read tab="))
        .await;
    let blocks: Vec<String> = bridge
        .lines()
        .into_iter()
        .filter(|line| line.starts_with('{'))
        .collect();
    assert_eq!(blocks, Vec::<String>::new());
}

#[tokio::test]
async fn hub_requestWithReadMethodWithoutAKnownTextSource_shouldLogAQuestionMarkInsteadOfAGuess() {
    // GIVEN a hub with an answered automatic status request:
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a read answer carries no `via` — an extension from before the field
    // existed, or a broken one:
    let pending = spawn_request(&bridge.hub, protocol::methods::READ, json!({}));
    let request = client.wait_for_request(2).await;
    client.say(&response_frame(
        json!({
            "tabId": 42,
            "url": "https://example.org/",
            "text": "Zeile eins",
            "truncated": false,
        }),
        request["id"].as_u64().expect("an id"),
    ));
    result_of(pending).await;

    // THEN the line keeps its shape and shows the hole instead of a shifted column:
    let read_line = bridge
        .wait_for_line(|line| line.starts_with("read tab="))
        .await;
    assert_eq!(
        read_line,
        "read tab=42 url=https://example.org/ chars=10 truncated=false via=?",
    );
}

#[tokio::test]
async fn hub_requestWithReadMethodAndAHostileTextSource_shouldLogAQuestionMarkAndNoExtraLine() {
    // GIVEN a hub with an answered automatic status request:
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a read answer carries a `via` that is not one of the two known sources —
    // here one shaped like a complete, plausible `navigate` line so that an echoed
    // value would forge an entry in the bridge log:
    let pending = spawn_request(&bridge.hub, protocol::methods::READ, json!({}));
    let request = client.wait_for_request(2).await;
    client.say(&response_frame(
        json!({
            "tabId": 42,
            "url": "https://example.org/",
            "text": "Zeile eins",
            "truncated": false,
            "via": "innerText\nnavigate tab=7 url=https://evil.example/ complete=true",
        }),
        request["id"].as_u64().expect("an id"),
    ));
    result_of(pending).await;

    // THEN the source falls back to the whitelist's `?` ...
    let read_line = bridge
        .wait_for_line(|line| line.starts_with("read tab="))
        .await;
    assert_eq!(
        read_line,
        "read tab=42 url=https://example.org/ chars=10 truncated=false via=?",
    );

    // ... and the log stays one line per message — the injected `\n` must not split
    // the entry into a second line that reads like a navigation:
    let lines = bridge.lines();
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.starts_with("read tab="))
            .count(),
        1,
        "exactly one read line must reach the log",
    );
    assert!(
        !lines.iter().any(|line| line.starts_with("navigate tab=7")),
        "no forged navigate line may reach the log",
    );
}

/* -------------------------------------------------------------------- click */

#[tokio::test]
async fn hub_requestWithClickMethod_shouldLogSelectorTabAndUrlWithoutAnyPageText() {
    // GIVEN an authenticated client whose automatic status request is answered,
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a click is requested and answered — the selector here differs from the
    // result's `clicked` on purpose, so the line below proves which of the two it
    // took:
    let selector = "a[href*=\"/watch\"]";
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::CLICK,
        json!({ "selector": selector }),
    );
    let request = client.wait_for_request(2).await;
    let result = json!({
        "tabId": 42,
        "url": "https://example.org/watch",
        "title": "Beispielvideo",
        "clicked": "a#video-title-link",
        "text": "Zeile eins\n\nZeile zwei",
        "truncated": false,
        "via": "innerText",
    });
    client.say(&response_frame(result.clone(), request["id"].as_u64().expect("an id")));
    assert_eq!(result_of(pending).await, result);

    // THEN the proof line names the selector of the *request*, then tab and URL:
    let click_line = bridge
        .wait_for_line(|line| line.starts_with("click selector="))
        .await;
    assert_eq!(
        click_line,
        "click selector=a[href*=\"/watch\"] tab=42 url=https://example.org/watch",
    );

    // ... it carries no length and no text, because a click is not a read,
    assert!(
        !click_line.contains("chars="),
        "the click line names no text length",
    );
    assert!(
        !bridge.lines().iter().any(|line| line.contains("Zeile eins")),
        "the page text must not reach the log",
    );

    // ... and `click` does not feed the `status` seam.
    assert_eq!(bridge.statuses(), vec![json!({ "windows": [] })]);
}

#[tokio::test]
async fn hub_requestWithClickMethodAndAMultilineSelector_shouldLogOneSpaceAndExactlyOnePhysicalLine() {
    // GIVEN an authenticated client whose automatic status request is answered,
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN the selector was pasted with a line break in it,
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::CLICK,
        json!({ "selector": "div\n a" }),
    );
    let request = client.wait_for_request(2).await;
    client.say(&response_frame(
        json!({
            "tabId": 42,
            "url": "https://example.org/",
            "clicked": "a",
            "text": "Zeile eins",
            "truncated": false,
            "via": "innerText",
        }),
        request["id"].as_u64().expect("an id"),
    ));
    result_of(pending).await;

    // THEN the break became a space — the selector's own space after it stays, the
    // rule replaces the break and does not rewrite the selector,
    let click_line = bridge
        .wait_for_line(|line| line.starts_with("click selector="))
        .await;
    assert_eq!(
        click_line,
        "click selector=div  a tab=42 url=https://example.org/",
    );

    // ... so the entry stays one physical line: no second line that reads like a log
    // entry of its own,
    let lines = bridge.lines();
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.starts_with("click selector="))
            .count(),
        1,
        "exactly one click line must reach the log",
    );
    assert!(
        !lines.iter().any(|line| line.starts_with(" a tab=")),
        "the selector's line break must not start a line of its own",
    );
}

#[tokio::test]
async fn hub_requestWithClickMethodUnderDebugLogging_shouldRedactTextAndClicked() {
    // GIVEN a hub started with BC_LOG=debug and an answered automatic status request:
    let bridge = TestBridge::start(debug_config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a click is answered — with an invented page text and a `clicked` shaped
    // like the `href` form, which is the one that can carry a session token:
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::CLICK,
        json!({ "selector": "a.link" }),
    );
    let request = client.wait_for_request(2).await;
    let clicked = "a[href=\"/watch?sitzungstoken\"]";
    let result = json!({
        "tabId": 42,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "clicked": clicked,
        "scrolled": true,
        "text": "Zeile eins\n\nZeile zwei",
        "truncated": false,
        "via": "innerText",
    });
    client.say(&response_frame(result.clone(), request["id"].as_u64().expect("an id")));
    assert_eq!(result_of(pending).await, result);

    // THEN the debug block carries the lengths where text and element description
    // were — two `length` rules in the table, one block,
    let debug_entry = bridge
        .wait_for_line(|line| {
            line.contains("\"text\": \"<22 chars>\"") && line.contains("\"clicked\": \"<")
        })
        .await;
    assert!(
        debug_entry.starts_with('{'),
        "the debug block is the indented JSON result",
    );
    assert!(
        debug_entry.contains(&format!("\"clicked\": \"<{} chars>\"", clicked.len())),
        "`clicked` must be redacted to its length",
    );

    // ... in table order, and only the fields this result actually carries:
    assert_eq!(
        keys_of(&parse(&debug_entry)),
        [
            "tabId",
            "url",
            "title",
            "clicked",
            "scrolled",
            "text",
            "truncated",
            "via",
        ],
    );

    // ... `scrolled` with its value, not as a marker: a boolean says where the
    // target was, not what the page says (`docs/56`),
    assert_eq!(parse(&debug_entry)["scrolled"], json!(true));
    assert!(
        !bridge
            .lines()
            .iter()
            .any(|line| line.contains("\"scrolled\": \"<unlisted field>\"")),
        "a listed boolean must not print the marker",
    );

    // ... and no line anywhere carries the text or the clicked element,
    let joined = bridge.lines().join("\n");
    assert!(!joined.contains("Zeile eins"), "the page text must not reach the log");
    assert!(!joined.contains(clicked), "the clicked element must not reach the log");
    assert!(!joined.contains("sitzungstoken"), "no token-bearing href may reach the log");

    // ... written once: a second, unredacted block would have leaked the `clicked`
    // value the line above just proved absent.
    assert_eq!(
        bridge
            .lines()
            .iter()
            .filter(|line| line.contains("\"tabId\": 42"))
            .count(),
        1,
        "exactly one debug block per result",
    );
}

/* --------------------------------------------------------------------- type */

#[tokio::test]
async fn hub_requestWithTypeMethod_shouldLogSelectorCharsAndSubmitWithoutTheTypedText() {
    // GIVEN an authenticated client whose automatic status request is answered,
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a type request is answered with a text that must never be readable in the
    // log — the value the agent writes may be a password:
    let typed_text = "geheim-testwert";
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::TYPE,
        json!({ "selector": "input[name=\"q\"]", "text": typed_text, "submit": true }),
    );
    let request = client.wait_for_request(2).await;
    // The URL carries no query on purpose: a search page that echoes the typed text
    // in its address is the known hole this increment does not close.
    let result = json!({
        "tabId": 42,
        "url": "https://example.org/suche",
        "title": "Suchergebnisse",
        "typed": "input#q",
        "submitted": true,
        "text": "Zeile eins\n\nZeile zwei",
        "truncated": false,
        "via": "innerText",
    });
    client.say(&response_frame(result.clone(), request["id"].as_u64().expect("an id")));
    assert_eq!(result_of(pending).await, result);

    // THEN the proof line names the selector, the length of the *typed* text and the
    // submit intent, then tab and URL:
    let type_line = bridge
        .wait_for_line(|line| line.starts_with("type selector="))
        .await;
    assert_eq!(
        type_line,
        "type selector=input[name=\"q\"] chars=15 submit=true tab=42 url=https://example.org/suche",
    );

    // ... so the count is the typed text's length, not the page text's,
    assert!(
        !type_line.contains("chars=22 "),
        "`chars` must not count the page text",
    );

    // ... and neither the typed text nor the page text reaches any line.
    let joined = bridge.lines().join("\n");
    assert!(!joined.contains(typed_text), "the typed text must not reach the log");
    assert!(!joined.contains("Zeile eins"), "the page text must not reach the log");

    // ... and `type` does not feed the `status` seam.
    assert_eq!(bridge.statuses(), vec![json!({ "windows": [] })]);
}

#[tokio::test]
async fn hub_requestWithTypeMethodAndAMultilineSelector_shouldLogOneSpaceAndExactlyOnePhysicalLine() {
    // GIVEN an authenticated client whose automatic status request is answered,
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN the selector arrived with a line break in it,
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::TYPE,
        json!({ "selector": "input\n[name=q]", "text": "ab" }),
    );
    let request = client.wait_for_request(2).await;
    client.say(&response_frame(
        json!({
            "tabId": 42,
            "url": "https://example.org/",
            "typed": "input",
            "submitted": false,
            "text": "x",
            "truncated": false,
            "via": "innerText",
        }),
        request["id"].as_u64().expect("an id"),
    ));
    result_of(pending).await;

    // THEN the break became a space, and a missing `submit` counts as the `false` the
    // extension would have assumed anyway,
    let type_line = bridge
        .wait_for_line(|line| line.starts_with("type selector="))
        .await;
    assert_eq!(
        type_line,
        "type selector=input [name=q] chars=2 submit=false tab=42 url=https://example.org/",
    );

    // ... so exactly one physical line starts with the method name.
    assert_eq!(
        bridge
            .lines()
            .iter()
            .filter(|line| line.starts_with("type selector="))
            .count(),
        1,
        "exactly one type line must reach the log",
    );
}

#[tokio::test]
async fn hub_requestWithTypeMethodUnderDebugLogging_shouldRedactThePageTextAndTheElementDescription() {
    // GIVEN a hub started with BC_LOG=debug and an answered automatic status request:
    let bridge = TestBridge::start(debug_config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a type request is answered — with an invented page text and a `typed`
    // shaped like the `aria-label` form, which is the one that can carry a session
    // token:
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::TYPE,
        json!({ "selector": "input#q", "text": "geheim-testwert", "submit": true }),
    );
    let request = client.wait_for_request(2).await;
    let typed = "input[aria-label=\"suchfeld-sitzungstoken\"]";
    let result = json!({
        "tabId": 42,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "typed": typed,
        "submitted": true,
        "text": "Zeile eins\n\nZeile zwei",
        "truncated": false,
        "via": "innerText",
    });
    client.say(&response_frame(result.clone(), request["id"].as_u64().expect("an id")));
    assert_eq!(result_of(pending).await, result);

    // THEN the debug block carries the lengths where the page text and the element
    // description were — two `length` rules in the table, one block,
    let debug_entry = bridge
        .wait_for_line(|line| line.contains("\"text\": \"<22 chars>\"") && line.contains("\"typed\": \"<"))
        .await;
    assert!(
        debug_entry.starts_with('{'),
        "the debug block is the indented JSON result",
    );
    assert!(
        debug_entry.contains(&format!("\"typed\": \"<{} chars>\"", typed.len())),
        "`typed` must be redacted to its length",
    );

    // ... in table order, and only the fields this result carries:
    assert_eq!(
        keys_of(&parse(&debug_entry)),
        [
            "tabId", "url", "title", "typed", "submitted", "text", "truncated", "via",
        ],
    );

    // ... and no line anywhere carries the typed text, the page text or the element
    // description,
    let joined = bridge.lines().join("\n");
    assert!(!joined.contains("geheim-testwert"), "the typed text must not reach the log");
    assert!(!joined.contains("Zeile eins"), "the page text must not reach the log");
    assert!(!joined.contains(typed), "the element description must not reach the log");
    assert!(!joined.contains("sitzungstoken"), "no token-bearing aria-label may reach the log");

    // ... written once: the branch has no second writer.
    assert_eq!(
        bridge
            .lines()
            .iter()
            .filter(|line| line.contains("\"tabId\": 42"))
            .count(),
        1,
        "exactly one debug block per result",
    );
}

/* -------------------------------------------------------------------- focus */

#[tokio::test]
async fn hub_requestWithFocusMethod_shouldLogOneLineAndOnlyTheWhitelistedFields() {
    // GIVEN a hub started with BC_LOG=debug and an answered automatic status request:
    let bridge = TestBridge::start(debug_config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a focus is answered with the six fields the extension promises:
    let pending = spawn_request(&bridge.hub, protocol::methods::FOCUS, json!({}));
    let request = client.wait_for_request(2).await;
    let result = json!({
        "tabId": 42,
        "windowId": 1,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "active": true,
        "focused": true,
    });
    client.say(&response_frame(result.clone(), request["id"].as_u64().expect("an id")));
    assert_eq!(result_of(pending).await, result);

    // THEN exactly one proof line names the tab and its window — and nothing else:
    let focus_lines: Vec<String> = bridge
        .lines()
        .into_iter()
        .filter(|line| line.starts_with("focus "))
        .collect();
    assert_eq!(focus_lines.len(), 1, "exactly one focus line");
    assert_eq!(focus_lines[0], "focus tab=42 window=1");

    // ... the debug block is the whitelist, not the arrived result: `url` in full,
    // `title` as its length.
    let debug_entry = bridge
        .wait_for_line(|line| line.contains("\"focused\": true"))
        .await;
    let expected = json!({
        "tabId": 42,
        "windowId": 1,
        "url": "https://example.org/",
        "title": "<13 chars>",
        "active": true,
        "focused": true,
    });
    assert_eq!(parse(&debug_entry), expected);
    assert_eq!(
        keys_of(&parse(&debug_entry)),
        keys_of(&expected),
        "table order, not result order",
    );

    // ... and `focus` does not feed the `status` seam.
    assert_eq!(bridge.statuses(), vec![json!({ "windows": [] })]);
}

/* ------------------------------------------------------ open_tab / close_tab */

#[tokio::test]
async fn hub_requestWithOpenTabMethod_shouldLogTabAndUrlWithoutTheTitle() {
    // GIVEN a hub started with BC_LOG=debug — the setting that would write a whole
    // result to stderr — and an answered automatic status request:
    let bridge = TestBridge::start(debug_config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN an `open_tab` is answered with the three fields the extension promises,
    // and the title is one that would stand out anywhere in the log:
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::OPEN_TAB,
        json!({ "url": "https://example.org/" }),
    );
    let request = client.wait_for_request(2).await;
    let result = json!({
        "tabId": 31,
        "url": "https://example.org/",
        "title": "Kontoauszug Maerz",
    });
    client.say(&response_frame(result.clone(), request["id"].as_u64().expect("an id")));
    assert_eq!(result_of(pending).await, result);

    // THEN exactly one proof line names the new tab and the address,
    let open_lines: Vec<String> = bridge
        .lines()
        .into_iter()
        .filter(|line| line.starts_with("open "))
        .collect();
    assert_eq!(open_lines.len(), 1, "exactly one open line");
    assert_eq!(open_lines[0], "open tab=31 url=https://example.org/");

    // ... the title is nowhere: it is page content, and this holds under debug
    // logging too, which is the half a block in the branch would break,
    assert!(
        !bridge.lines().iter().any(|line| line.contains("Kontoauszug")),
        "the tab title must not reach the log",
    );

    // ... and `open_tab` does not feed the `status` seam.
    assert_eq!(bridge.statuses(), vec![json!({ "windows": [] })]);
}

#[tokio::test]
async fn hub_requestWithCloseTabMethod_shouldLogTheTabOfTheResultAndNoDebugBlock() {
    // GIVEN the same debug-logging hub with an answered status request:
    let bridge = TestBridge::start(debug_config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a `close_tab` without a `tab` is answered — the request names no id at
    // all, so the line can only come from the result:
    let pending = spawn_request(&bridge.hub, protocol::methods::CLOSE_TAB, json!({}));
    let request = client.wait_for_request(2).await;
    let result = json!({ "tabId": 31, "closed": true });
    client.say(&response_frame(result.clone(), request["id"].as_u64().expect("an id")));
    assert_eq!(result_of(pending).await, result);

    // THEN exactly one proof line names the tab that went away,
    let close_lines: Vec<String> = bridge
        .lines()
        .into_iter()
        .filter(|line| line.starts_with("close "))
        .collect();
    assert_eq!(
        close_lines.len(),
        1,
        "exactly one close line — the branch must not be missing",
    );
    assert_eq!(close_lines[0], "close tab=31");

    // ... and no debug block accompanies it: the line is the whole report.
    assert!(
        !bridge.lines().iter().any(|line| line.contains("\"closed\": true")),
        "close_tab must write no debug block",
    );
}

#[tokio::test]
async fn hub_requestStatus_withTwoRequestsInFlightAndReversedAnswers_shouldResolveEachPromiseWithItsOwnResult() {
    // GIVEN an authenticated client whose automatic status request is still open:
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;

    // WHEN two further requests start before either of them is answered,
    let first = spawn_status(&bridge.hub);
    let second = spawn_status(&bridge.hub);
    let first_request = client.wait_for_request(2).await;
    let second_request = client.wait_for_request(3).await;

    // THEN each drew its own id from the per-session counter:
    assert_eq!(first_request["id"], json!(2));
    assert_eq!(second_request["id"], json!(3));
    assert_eq!(first_request["params"], json!({}));
    assert_eq!(second_request["params"], json!({}));

    // WHEN the answers arrive in reverse order relative to the requests,
    let second_result = json!({ "windows": [{ "id": 2, "tabs": [{ "id": 201 }] }] });
    let first_result = json!({
        "windows": [{ "id": 1, "tabs": [{ "id": 101 }, { "id": 102 }] }],
    });
    client.say(&response_frame(second_result.clone(), 3));
    client.say(&response_frame(first_result.clone(), 2));

    // THEN each promise resolves with the result that belongs to its own id:
    assert_eq!(result_of(second).await, second_result);
    assert_eq!(result_of(first).await, first_result);
}

#[tokio::test]
async fn hub_requestStatusWithoutAnyConnectedExtension_shouldRejectWithExtensionUnavailable() {
    // GIVEN a hub nobody has connected to,
    let bridge = TestBridge::start(config());

    // WHEN a status request is made,
    let error = bridge
        .hub
        .request_status()
        .await
        .expect_err("a request without a peer must fail");

    // THEN it is rejected as unavailable instead of hanging until a timer:
    assert_eq!(error.kind, FailureKind::Unavailable);
    assert_eq!(error.message, "no extension is connected");
    // Only `Extension` carries a code, so an absent one is part of the shape:
    assert_eq!(error.code, None);
}

#[tokio::test]
async fn hub_requestStatusWithoutAnAnswerWithinTheCallTimeout_shouldRejectWithExtensionTimeoutAndStillLogTheTimeout() {
    // GIVEN a hub with a 200 ms status deadline and a client that stays silent:
    let bridge = TestBridge::start(test_config(2_000, 200, Level::Info));
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;

    // WHEN a status request gets no answer in time,
    let error = bridge
        .hub
        .request_status()
        .await
        .expect_err("an unanswered request must fail");

    // THEN the promise rejects as a timeout,
    assert_eq!(error.kind, FailureKind::Timeout);
    assert_eq!(error.message, "no status answer within 200 ms");

    // ... the log line of the old increment still appears, and the connection is kept
    // — a slow answer is not a broken peer:
    let timeout_line = bridge
        .wait_for_line(|line| line.starts_with("status timeout"))
        .await;
    assert_eq!(peer_token(&timeout_line, "status timeout peer=", ""), PEER);
    assert!(client.is_open());
}

#[tokio::test]
async fn hub_requestStatusAnsweredWithOkFalse_shouldRejectWithExtensionErrorCarryingTheCode() {
    // GIVEN an authenticated client and a status request in flight,
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    let pending = spawn_status(&bridge.hub);
    let request = client.wait_for_request(2).await;

    // WHEN it answers `ok:false` with the extension's own code,
    client.say(&failure_frame(
        json!({ "code": "permission_denied", "message": "the operator said no" }),
        request["id"].as_u64().expect("an id"),
    ));

    // THEN the promise carries both the failure kind and that code,
    let error = error_of(pending).await;
    assert_eq!(error.kind, FailureKind::Extension);
    assert_eq!(error.code.as_deref(), Some("permission_denied"));

    // ... the log line stays as it was, and the connection survives:
    let failed_line = bridge
        .wait_for_line(|line| line.starts_with("status failed"))
        .await;
    assert_eq!(
        failed_line,
        format!("status failed peer={PEER} code=permission_denied"),
    );
    assert!(client.is_open());
}

#[tokio::test]
async fn hub_requestAnsweredWithOkFalse_shouldRejectWithTheExtensionErrorAttached() {
    // GIVEN an authenticated client and a read request in flight,
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();

    // The peer comes from an earlier line of the same connection, so the expected
    // failure line below can be a literal comparison instead of a pattern that would
    // tolerate an appended address:
    let connected_line = bridge
        .wait_for_line(|line| line.starts_with("extension connected"))
        .await;
    let peer = peer_token(&connected_line, "extension connected peer=", " protocol=1");

    let pending = spawn_request(&bridge.hub, protocol::methods::READ, json!({ "tabId": 5 }));
    let request = client.wait_for_request(2).await;

    // WHEN the extension answers `ok:false` with the three extra fields it sends for
    // an unreadable page (an invented address — this repo carries no real one),
    let extension_error = json!({
        "code": "not_readable",
        "message": "the page could not be read",
        "url": "https://example.org/preisliste.pdf?token=1",
        "kind": "pdf",
        "contentType": "application/pdf",
    });
    client.say(&failure_frame(
        extension_error.clone(),
        request["id"].as_u64().expect("an id"),
    ));

    // THEN the rejection hands the extension's whole error object through as
    // `details`, so the MCP layer can read `url`, `kind` and `contentType` off it:
    let error = error_of(pending).await;
    assert_eq!(error.kind, FailureKind::Extension);
    assert_eq!(error.code.as_deref(), Some("not_readable"));
    assert_eq!(error.details, Some(extension_error));

    // ... while the log line is byte for byte the line it was before the details
    // existed. The address may carry credentials in its query, so it is the one thing
    // that must never appear here:
    let failed_line = bridge
        .wait_for_line(|line| line.starts_with("read failed"))
        .await;
    assert_eq!(failed_line, format!("read failed peer={peer} code=not_readable"));
}

#[tokio::test]
async fn hub_withAnOpenRequestWhenThePeerDisconnects_shouldRejectWithExtensionUnavailableAndLogNoGhostTimeout() {
    // GIVEN a hub with a 200 ms status deadline — short enough that a timer which
    // survived the close would fire inside this test:
    let bridge = TestBridge::start(test_config(2_000, 200, Level::Info));
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;

    // The automatic request is answered *before* the second one starts, so exactly
    // one armed timer is left — the one of the request below. "No ghost timeout" is
    // then a statement about the close, not about winning a 200 ms race.
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a status request is in flight and the peer then disconnects,
    let pending = spawn_status(&bridge.hub);
    client.wait_for_request(2).await;

    bridge.hub.on_close(client.connection, &close_info(1000, ""));

    // THEN the request fails immediately instead of staying pending until the timer
    // would have fired,
    let error = error_of(pending).await;
    assert_eq!(error.kind, FailureKind::Unavailable);

    // ... and no timer survived the close: well past the deadline there is not a
    // single "status timeout" line, which is where a ghost of the closed request's
    // timer would show up.
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        !bridge
            .lines()
            .iter()
            .any(|line| line.starts_with("status timeout")),
        "a ghost timeout line reached the log: {:?}",
        bridge.lines(),
    );
}

#[tokio::test]
async fn hub_requestStatusWhenTheRequestCannotBeSent_shouldRejectImmediatelyWithExtensionUnavailable() {
    // GIVEN a hub whose connection drops writes on demand — the window between the
    // hub's open check and its write, which a real socket only opens by luck. A
    // closed outbound channel is that window: the flag stays `true`, the send fails.
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    // Answered first, so the only request in flight below is this test's own:
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;
    client.outbound.close();

    // WHEN the socket is gone by the time the request is written,
    let error = bridge
        .hub
        .request_status()
        .await
        .expect_err("a request that could not be sent must fail");

    // THEN the promise is rejected right away instead of waiting out the 10 s timer
    // for an answer that can never come:
    assert_eq!(error.kind, FailureKind::Unavailable);
    assert!(
        error.message.contains("could not be sent"),
        "unexpected message: {}",
        error.message,
    );
}

/* ----------------------------------------------------------------- navigate */

#[tokio::test]
async fn hub_requestWithNavigateMethod_shouldResolveByItsIdLogOneLineAndLeaveOnStatusAlone() {
    // GIVEN an authenticated client whose automatic status request is answered,
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a navigate request is made,
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::NAVIGATE,
        json!({ "url": "https://example.org/" }),
    );
    let request = client.wait_for_request(2).await;

    // THEN it goes out under its own method with its own params:
    assert_eq!(
        request,
        json!({
            "type": protocol::types::REQUEST,
            "id": 2,
            "method": protocol::methods::NAVIGATE,
            "params": { "url": "https://example.org/" },
        }),
    );

    // WHEN the answer arrives addressed by that id,
    let result = json!({
        "tabId": 42,
        "windowId": 1,
        "url": "https://example.org/",
        "title": "Example Domain",
        "complete": true,
    });
    client.say(&response_frame(result.clone(), 2));

    // THEN the promise resolves with the result and the proof line is written — while
    // `onStatus` stays a `status`-only seam and must not see a navigation:
    assert_eq!(result_of(pending).await, result);
    bridge
        .wait_for_line(|line| line == "navigate tab=42 url=https://example.org/ complete=true")
        .await;
    assert_eq!(bridge.statuses(), vec![json!({ "windows": [] })]);
}

#[tokio::test]
async fn hub_requestNavigateAnsweredWithOkFalse_shouldRejectWithExtensionErrorCarryingTheCode() {
    // GIVEN an authenticated client and a navigate request in flight,
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::NAVIGATE,
        json!({ "url": "https://example.org/" }),
    );
    let request = client.wait_for_request(2).await;

    // WHEN the extension answers `ok:false` with its own code,
    client.say(&failure_frame(
        json!({ "code": "navigate_failed", "message": "tabs.create failed" }),
        request["id"].as_u64().expect("an id"),
    ));

    // THEN the rejection is an `ExtensionError` carrying exactly that code,
    let error = error_of(pending).await;
    assert_eq!(error.kind, FailureKind::Extension);
    assert_eq!(error.code.as_deref(), Some("navigate_failed"));

    // ... the failure line is named after the method, and the connection lives on:
    let failed_line = bridge
        .wait_for_line(|line| line.starts_with("navigate failed"))
        .await;
    assert_eq!(
        failed_line,
        format!("navigate failed peer={PEER} code=navigate_failed"),
    );
    assert!(client.is_open());
}

#[tokio::test]
async fn hub_withStatusAndNavigateInFlight_shouldResolveEachByItsIdWhenTheAnswersArriveInReverse() {
    // GIVEN an authenticated client whose automatic status request is answered,
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a status and a navigate request overlap,
    let status_pending = spawn_status(&bridge.hub);
    let navigate_pending = spawn_request(
        &bridge.hub,
        protocol::methods::NAVIGATE,
        json!({ "url": "https://example.org/" }),
    );
    // Read by method, not by id: two spawned tasks draw their ids in whatever order
    // the scheduler runs them, and a case that assumes one is asserting the runtime.
    let status_request = client.wait_for_request_method(protocol::methods::STATUS).await;
    let navigate_request = client.wait_for_request_method(protocol::methods::NAVIGATE).await;

    // THEN each carries the method it was asked for:
    assert_eq!(status_request["method"], json!(protocol::methods::STATUS));
    assert_eq!(
        navigate_request["method"],
        json!(protocol::methods::NAVIGATE),
    );

    // WHEN the answers arrive in reverse order relative to the requests,
    let navigate_result = json!({
        "tabId": 7,
        "windowId": 1,
        "url": "https://example.org/",
        "title": "Example Domain",
        "complete": false,
    });
    let status_result = json!({ "windows": [{ "id": 1, "tabs": [{ "id": 101 }] }] });
    client.say(&response_frame(
        navigate_result.clone(),
        navigate_request["id"].as_u64().expect("an id"),
    ));
    client.say(&response_frame(
        status_result.clone(),
        status_request["id"].as_u64().expect("an id"),
    ));

    // THEN each promise gets the result of its own id, and each answer is logged
    // under the method its pending entry remembered — not under a shared name:
    assert_eq!(result_of(navigate_pending).await, navigate_result);
    assert_eq!(result_of(status_pending).await, status_result);
    bridge
        .wait_for_line(|line| line.starts_with("navigate tab=7"))
        .await;
    bridge
        .wait_for_line(|line| line == "status windows=1 tabs=1")
        .await;
    assert_eq!(
        bridge.statuses(),
        vec![json!({ "windows": [] }), status_result],
    );
}

/* ------------------------------------------------------------------ inspect */

#[tokio::test]
async fn hub_requestWithInspectMethod_shouldLogOneLineWithoutElementText() {
    // GIVEN an authenticated client whose automatic status request is answered,
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN an inspect goes out with a selector and without a text filter — the
    // element is invented, so nobody's page is in this test:
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::INSPECT,
        json!({ "selector": "a#cart-link" }),
    );
    let request = client.wait_for_request(2).await;
    let element = json!({
        "index": 0,
        "tag": "a",
        "text": "Erfundene Warenkorbaufschrift",
        "id": "cart-link",
        "classes": ["knopf"],
        "href": "https://example.org/erfunden",
        "ariaLabel": "",
        "selector": "a#cart-link",
        "visible": true,
        "disabled": false,
        "rect": { "x": 1, "y": 2, "width": 3, "height": 4 },
    });
    let result = json!({
        "tabId": 42,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "count": 1,
        "truncated": false,
        "elements": [element],
    });
    client.say(&response_frame(result.clone(), request["id"].as_u64().expect("an id")));
    assert_eq!(result_of(pending).await, result);

    // THEN exactly one line names the filter of the request, the unset one as the
    // spec's `-`, and the hit count,
    let inspect_lines: Vec<String> = bridge
        .lines()
        .into_iter()
        .filter(|line| line.starts_with("inspect "))
        .collect();
    assert_eq!(inspect_lines.len(), 1, "exactly one inspect line");
    assert_eq!(inspect_lines[0], "inspect selector=a#cart-link text=- found=1");

    // ... and the element text reaches no logged line at all,
    let joined = bridge.lines().join("\n");
    assert!(
        !joined.contains("Erfundene Warenkorbaufschrift"),
        "the element text must not reach the log",
    );
    assert!(
        !joined.contains("Erfundene"),
        "no fragment of the element text may reach the log",
    );

    // ... and `inspect` does not feed the `status` seam.
    assert_eq!(bridge.statuses(), vec![json!({ "windows": [] })]);
}

#[tokio::test]
async fn hub_requestWithInspectMethodWithDebugLog_shouldRedactEveryPageString() {
    // GIVEN a hub started with BC_LOG=debug and an answered automatic status request:
    let bridge = TestBridge::start(debug_config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN an inspect is answered with an element whose strings are all invented page
    // content — including a `selector` built from an `aria-label`, the one field that
    // hides page text inside a selector string:
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::INSPECT,
        json!({ "text": "warenkorb" }),
    );
    let request = client.wait_for_request(2).await;
    let element_text = "Erfundene Aufschrift";
    let aria_label = "Erfundene Aufschrift im Warenkorb";
    let selector = "a[aria-label=\"Erfundene Aufschrift im Warenkorb\"]";
    let href = "https://example.org/erfunden";
    let id = "cart-link";
    let classes = ["knopf", "knopf--gross"];
    let element = json!({
        "index": 0,
        "tag": "a",
        "text": element_text,
        "id": id,
        "classes": classes,
        "href": href,
        "ariaLabel": aria_label,
        "selector": selector,
        "visible": true,
        "offscreen": true,
        "disabled": false,
        "rect": { "x": 1, "y": 2, "width": 3, "height": 4 },
    });
    let result = json!({
        "tabId": 42,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "count": 1,
        "truncated": false,
        "elements": [element],
    });
    client.say(&response_frame(result.clone(), request["id"].as_u64().expect("an id")));
    assert_eq!(result_of(pending).await, result);

    // THEN exactly one debug block is written for this result,
    let debug_entries: Vec<String> = bridge
        .lines()
        .into_iter()
        .filter(|line| line.contains("\"tabId\": 42"))
        .collect();
    assert_eq!(debug_entries.len(), 1, "exactly one debug block per result");
    let debugged = parse(&debug_entries[0]);
    let debugged_element = &debugged["elements"][0];

    // ... every page string of the element is now a length,
    assert_eq!(
        debugged_element["text"],
        json!(format!("<{} chars>", element_text.len())),
    );
    assert_eq!(
        debugged_element["href"],
        json!(format!("<{} chars>", href.len())),
    );
    assert_eq!(debugged_element["id"], json!(format!("<{} chars>", id.len())));
    assert_eq!(
        debugged_element["ariaLabel"],
        json!(format!("<{} chars>", aria_label.len())),
    );
    assert_eq!(
        debugged_element["selector"],
        json!(format!("<{} chars>", selector.len())),
    );

    // ... the class list too, entry by entry,
    assert_eq!(
        debugged_element["classes"],
        json!([
            format!("<{} chars>", classes[0].len()),
            format!("<{} chars>", classes[1].len()),
        ]),
        "each class name must be redacted",
    );

    // ... while the shape of the hit and the tab stay readable — `url` in full
    // because six log lines print it beside the block anyway, `title` as its length:
    assert_eq!(debugged_element["index"], json!(0));
    assert_eq!(debugged_element["tag"], json!("a"));
    assert_eq!(debugged_element["visible"], json!(true));
    assert_eq!(debugged_element["disabled"], json!(false));
    // `offscreen` is a fact about the layer, not page content: it prints its value,
    // and it prints it between `visible` and `disabled` — the order of the answer
    // (`docs/62`). The whole element order is pinned here, so a new field cannot
    // silently land in the wrong place:
    assert_eq!(debugged_element["offscreen"], json!(true));
    assert_eq!(
        keys_of(debugged_element),
        [
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
    );
    assert!(
        !debug_entries[0].contains("<unlisted field>"),
        "a listed boolean must not print the marker: {}",
        debug_entries[0],
    );
    assert_eq!(
        debugged_element["rect"],
        json!({ "x": 1, "y": 2, "width": 3, "height": 4 }),
    );
    assert_eq!(debugged["url"], json!("https://example.org/"));
    assert_eq!(debugged["title"], json!("<13 chars>"));

    // ... and no logged line carries any of the page strings. The filter from the
    // request is allowed to appear — it is input, not page content:
    let joined = bridge.lines().join("\n");
    assert!(!joined.contains("Erfundene"), "text, ariaLabel and selector must not reach the log");
    assert!(!joined.contains("example.org/erfunden"), "the element href must not reach the log");
    assert!(!joined.contains("cart-link"), "the element id must not reach the log");
    assert!(!joined.contains("knopf"), "the class names must not reach the log");
    assert!(
        joined.contains("inspect selector=- text=warenkorb found=1"),
        "the filter itself stays raw",
    );
}

#[tokio::test]
async fn hub_requestWithInspectMethodWithAnUnlistedElementFieldUnderDebugLog_shouldPrintTheMarkerThere() {
    // GIVEN a hub started with BC_LOG=debug and an answered automatic status request:
    let bridge = TestBridge::start(debug_config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN an inspect answer carries an element field the element shape does not
    // name — the shape a field added by a future extension version would have:
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::INSPECT,
        json!({ "text": "warenkorb" }),
    );
    let request = client.wait_for_request(2).await;
    client.say(&response_frame(
        json!({
            "tabId": 42,
            "url": "https://example.org/",
            "title": "Beispielseite",
            "count": 1,
            "truncated": false,
            "elements": [{
                "index": 0,
                "tag": "a",
                "text": "Erfundene Aufschrift",
                "surpriseInside": "geheim",
            }],
        }),
        request["id"].as_u64().expect("an id"),
    ));
    result_of(pending).await;

    // THEN the marker lands *inside* the element — the nesting is projected field by
    // field, so one unknown field does not turn the whole hit into a marker,
    let debug_entry = bridge
        .wait_for_line(|line| line.contains("\"surpriseInside\": \"<unlisted field>\""))
        .await;
    let debugged = parse(&debug_entry);
    let debugged_element = &debugged["elements"][0];
    assert_eq!(debugged_element["surpriseInside"], json!("<unlisted field>"));
    assert_eq!(
        keys_of(debugged_element).last().map(String::as_str),
        Some("surpriseInside"),
        "unlisted fields hang at the end of the element",
    );

    // ... and it does not drag a value or a length of its own onto stderr:
    let joined = bridge.lines().join("\n");
    assert!(!joined.contains("geheim"), "an unlisted element value must never reach the log");
    assert!(!joined.contains("Erfundene"), "the element text must not reach the log either");
}

/* --------------------------------------------------------------------- eval */

// The code and the result of the log-hygiene case are two markers, not the same
// string: one assertion that misses both would look like two that pass.
const EVAL_CODE_MARKER: &str = "data-probe";
const EVAL_RESULT_MARKER: &str = "probe-antwort";

#[tokio::test]
async fn hub_eval_shouldResolveByItsIdAndKeepOnStatusQuiet() {
    // GIVEN an authenticated client whose automatic status request is answered,
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN an eval request is made with a code body,
    let code = format!("document.body.dataset.probe = \"{EVAL_CODE_MARKER}\"; return 1");
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::EVAL,
        json!({ "code": code }),
    );
    let request = client.wait_for_request(2).await;

    // THEN it goes out under its own method, carrying the code as sent — the hub
    // passes the body through instead of judging it:
    assert_eq!(
        request,
        json!({
            "type": protocol::types::REQUEST,
            "id": 2,
            "method": protocol::methods::EVAL,
            "params": { "code": code },
        }),
    );

    // WHEN the answer arrives addressed by that id,
    let result = json!({
        "tabId": 18,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "elapsedMs": 4,
        "result": 1,
    });
    client.say(&response_frame(result.clone(), 2));

    // THEN the promise resolves with the result as it came, and the `status` seam
    // stays a `status`-only seam:
    assert_eq!(result_of(pending).await, result);
    bridge
        .wait_for_line(|line| line == "eval tab=18 elapsedMs=4 ok=true")
        .await;
    assert_eq!(bridge.statuses(), vec![json!({ "windows": [] })]);
}

#[tokio::test]
async fn hub_eval_shouldLogOnlyTabElapsedAndOk() {
    // GIVEN a hub started with BC_LOG=debug — the setting that writes whole results
    // to stderr, and the only level at which a debug block could leak what the line
    // leaves out:
    let bridge = TestBridge::start(debug_config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN an eval is answered with a code and a result that both carry page-shaped
    // content — the code writes a marker into the DOM, the result is that marker:
    let code = format!(
        "document.body.dataset.probe = \"{EVAL_CODE_MARKER}\"; return \"{EVAL_RESULT_MARKER}\"",
    );
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::EVAL,
        json!({ "code": code }),
    );
    let request = client.wait_for_request(2).await;
    let result = json!({
        "tabId": 18,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "elapsedMs": 4,
        "result": EVAL_RESULT_MARKER,
    });
    client.say(&response_frame(result.clone(), request["id"].as_u64().expect("an id")));
    assert_eq!(result_of(pending).await, result);
    bridge
        .wait_for_line(|line| line == "eval tab=18 elapsedMs=4 ok=true")
        .await;

    // THEN exactly one line is written for this answer — no debug block beside it,
    let eval_lines: Vec<String> = bridge
        .lines()
        .into_iter()
        .filter(|line| line.starts_with("eval "))
        .collect();
    assert_eq!(eval_lines.len(), 1, "exactly one eval line and no debug block");
    assert_eq!(eval_lines[0], "eval tab=18 elapsedMs=4 ok=true");

    // ... and neither the code nor the result reaches any logged line, not even at
    // the debug level the hub was started with:
    let joined = bridge.lines().join("\n");
    assert!(!joined.contains(EVAL_CODE_MARKER), "the code must not reach the log");
    assert!(!joined.contains(EVAL_RESULT_MARKER), "the result must not reach the log");
}

#[tokio::test]
async fn hub_eval_withOkFalse_shouldRejectWithTheExtensionsCode() {
    // GIVEN an authenticated client and an eval request in flight,
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::EVAL,
        json!({ "code": "return 1" }),
    );
    let request = client.wait_for_request(2).await;

    // WHEN the extension answers `ok:false` with its own code,
    client.say(&failure_frame(
        json!({
            "code": "eval_not_allowed",
            "message": "Code-Auswertung ist in den Einstellungen der Erweiterung nicht erlaubt.",
        }),
        request["id"].as_u64().expect("an id"),
    ));

    // THEN the rejection is an `ExtensionError` carrying exactly that code,
    let error = error_of(pending).await;
    assert_eq!(error.kind, FailureKind::Extension);
    assert_eq!(error.code.as_deref(), Some("eval_not_allowed"));

    // ... the failure line is named after the method, no `eval tab=` line is written
    // for a refusal, and the connection lives on:
    let failed_line = bridge
        .wait_for_line(|line| line.starts_with("eval failed"))
        .await;
    assert_eq!(
        failed_line,
        format!("eval failed peer={PEER} code=eval_not_allowed"),
    );
    assert!(
        !bridge.lines().iter().any(|line| line.starts_with("eval tab=")),
        "a refusal writes no proof line",
    );
    assert!(client.is_open());
}

/* ----------------------------------------------------------------- screenshot */

// Both format magics in one invented string on purpose: a debug block that printed
// the base64 of a *successful* screenshot would carry whichever one the picture
// happened to be, and a needle that can only ever match one of them would leave half
// the leak unpinned. Nothing here is a real image.
const SCREENSHOT_BASE64_MARKER: &str = "iVBORw0KGgoAAAANSUhEUg/9j/4AAQSkZJRg";

#[tokio::test]
async fn hub_screenshot_shouldResolveByItsIdAndLogOneLineWithoutThePicture() {
    // GIVEN an authenticated client whose automatic status request is answered,
    let bridge = TestBridge::start(config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a screenshot is requested for tab 4,
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::SCREENSHOT,
        json!({ "tab": 4 }),
    );
    let request = client.wait_for_request(2).await;

    // THEN it goes out under its own method with the tab as sent — the hub adds no
    // parameter of its own, and `format`/`quality` are the extension's ladder:
    assert_eq!(
        request,
        json!({
            "type": protocol::types::REQUEST,
            "id": 2,
            "method": protocol::methods::SCREENSHOT,
            "params": { "tab": 4 },
        }),
    );

    // WHEN the extension answers with the picture addressed by that id,
    let result = json!({
        "tabId": 4,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "format": "jpeg",
        "width": 1600,
        "height": 900,
        "bytes": 214311,
        "scaled": true,
        "activated": false,
        "base64": SCREENSHOT_BASE64_MARKER,
    });
    client.say(&response_frame(result.clone(), 2));

    // THEN the promise resolves with the result as it came — the base64 included,
    // because the caller needs the picture and only the log must not have it,
    assert_eq!(result_of(pending).await, result);

    // ... and the one line says tab, size, format and state, in that order:
    bridge
        .wait_for_line(|line| line == "screenshot tab=4 bytes=214311 format=jpeg scaled=true ok=true")
        .await;
}

#[tokio::test]
async fn hub_screenshot_shouldLogExactlyOneLineAndNoBase64EvenAtTheDebugLevel() {
    // GIVEN a hub started with BC_LOG=debug — the only level at which a debug block
    // could leak the picture:
    let bridge = TestBridge::start(debug_config());
    let mut client = bridge.connect(PEER);
    client.hello();
    client.wait_for_message(protocol::types::REQUEST).await;
    client.answer_automatic_status();
    bridge
        .wait_for_line(|line| line == "status windows=0 tabs=0")
        .await;

    // WHEN a screenshot is answered with a picture-shaped result,
    let pending = spawn_request(
        &bridge.hub,
        protocol::methods::SCREENSHOT,
        json!({ "tab": 4 }),
    );
    let request = client.wait_for_request(2).await;
    let result = json!({
        "tabId": 4,
        "url": "https://example.org/",
        "title": "Beispielseite",
        "format": "png",
        "width": 1280,
        "height": 720,
        "bytes": 48211,
        "scaled": false,
        "activated": false,
        "base64": SCREENSHOT_BASE64_MARKER,
    });
    client.say(&response_frame(result.clone(), request["id"].as_u64().expect("an id")));
    assert_eq!(result_of(pending).await, result);
    bridge
        .wait_for_line(|line| line == "screenshot tab=4 bytes=48211 format=png scaled=false ok=true")
        .await;

    // THEN exactly one line is written for this answer — no debug block beside it,
    let screenshot_lines: Vec<String> = bridge
        .lines()
        .into_iter()
        .filter(|line| line.starts_with("screenshot "))
        .collect();
    assert_eq!(
        screenshot_lines.len(),
        1,
        "exactly one screenshot line and no debug block",
    );
    assert_eq!(
        screenshot_lines[0],
        "screenshot tab=4 bytes=48211 format=png scaled=false ok=true",
    );

    // ... and no logged line carries a base64 fragment, in either format magic:
    let joined = bridge.lines().join("\n");
    assert!(!joined.contains("iVBORw0"), "the PNG magic must not reach the log");
    assert!(!joined.contains("/9j/"), "the JPEG magic must not reach the log");
}
