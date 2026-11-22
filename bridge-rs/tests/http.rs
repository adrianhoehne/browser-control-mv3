//! MCP over HTTP: routing, token, body limit — the transport, not the tools.
//!
//! Stage 2e of `docs/38`; the cases are the fourteen from `test/http-transport.test.js`
//! under their Node names (prefix `http_`), plus one seam case of its own
//! (`http_withTheSameAnswerAsStdio_shouldMatch`): the same request through `/mcp` and
//! through `stdio::serve` must produce the same bytes. Without it the two ways in could
//! drift apart while both suites stay green — and "one seam, two ways in, identical
//! answers" is the whole reason the HTTP module owns no tool logic.
//!
//! Seven cases beyond the template's fourteen pin what a review measured at the binary:
//! an absolute-form target (`404`, not `200`), a request with `Content-Length` *and*
//! `Transfer-Encoding` (`400`, in both header orders), half a head against the head
//! deadline, a panicking tool layer (`500`, not a dead connection), an aborted body (no
//! answer at all), a `413` that really closes, and a `Transport::close` that ends an idle
//! keep-alive socket. Each of them was a way the transport could stay silent, hang or answer
//! the wrong status while the template answered correctly.
//!
//! The tool set is a stub on purpose. What is under test is the wiring around the seam:
//! which status a caller gets, in which order, and whether the socket is closed again
//! afterwards. The seam itself is pinned in `tests/mcp.rs`.
//!
//! The client is a raw socket writing HTTP/1.1 by hand. That is not laziness: several
//! cases end with the server closing the connection right after the status line, and a
//! client that reports what actually arrived beats one that fails to parse a library's
//! opinion of it. It also keeps the case that proves the close honest — a client that
//! asked for `Connection: close` itself would prove nothing.
//!
//! `port: 0` is not a convenience here: it is the only way to learn the address the
//! kernel picked, and the loopback case has to look at the real one.
//!
//! The case names are the Node ones so the mapping stays readable; `docs/38`,
//! `### What could go wrong` names the allow for the missing snake case.

#![allow(non_snake_case)]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use browser_control_bridge::config::Config;
use browser_control_bridge::http::{self, ToolSet};
use browser_control_bridge::hub::Hub;
use browser_control_bridge::log::Level;
use browser_control_bridge::mcp::{self, ToolContext};
use browser_control_bridge::stdio;

/// 32 hex characters, the shortest token the bridge accepts — built at runtime, because a
/// token written into the repository is a token in every clone (`CONTRIBUTING.md`).
///
/// Once per run, not once per call: several cases compare a log line against the very token
/// the transport was started with, and a value that changed between those two calls would
/// make that comparison a tautology on one side and a false alarm on the other.
fn token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| runtime_hex(0))
}

/// The same shape, a different value: a caller holding *a* secret is not a caller holding
/// the bridge's.
fn wrong_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| runtime_hex(1))
}

/// 32 hex characters derived from the process id and the wall clock.
///
/// Not a secret and not meant to be one — the length is what the bridge checks, and the
/// variation is what keeps this file from shipping a usable token.
fn runtime_hex(salt: u64) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or_default();
    let mut state = nanos ^ (u64::from(std::process::id()) << 24) ^ salt.wrapping_mul(0x9E37_79B9);

    let mut hex = String::with_capacity(32);
    for _ in 0..4 {
        // One round of the usual 64-bit mixer; four rounds give the 32 characters.
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        hex.push_str(&format!("{:08x}", (state >> 32) as u32));
    }
    hex
}

/// Spelled out on purpose, not imported from `http::MAX_BODY_BYTES`. The transport limit
/// and the socket limit are two decisions, and a derived value would silently follow the
/// module upward — turning every 413 case below into a test of a limit nobody meant to
/// raise.
const MAX_BODY_BYTES: usize = 1_048_576;

/// The bound for a case whose failure mode is a hang — a request the transport never
/// answers because the check under test is gone.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);

/// The bound for a socket that is supposed to be closed already.
const SOCKET_TIMEOUT: Duration = Duration::from_secs(2);

/// The bound for the head deadline case. Well above the one-second deadline it installs, and
/// still short enough to fail the run instead of hanging it.
const HEAD_DEADLINE_WAIT: Duration = Duration::from_secs(10);

/// The deadline that case installs. Production uses `http::HEAD_READ_TIMEOUT` (60 s); a case
/// that waited for that would be a minute long.
const TEST_HEAD_DEADLINE: Duration = Duration::from_secs(1);

/* ------------------------------------------------------------------ harness */

struct Harness {
    transport: http::Transport,
    /// The texts the stub tool set was handed.
    received: Arc<Mutex<Vec<String>>>,
    /// The lines the transport wrote, without the timestamp prefix.
    log_lines: Arc<Mutex<Vec<String>>>,
}

impl Harness {
    fn port(&self) -> u16 {
        self.transport.port
    }

    fn received(&self) -> Vec<String> {
        self.received.lock().expect("received lock").clone()
    }

    fn log_lines(&self) -> Vec<String> {
        self.log_lines.lock().expect("log lock").clone()
    }

    async fn close(self) {
        self.transport.close().await;
    }
}

/// Stands in for the real seam: records the text it was handed and answers in a shape the
/// test can recognise. `None` for a request without `id` mirrors the real rule for
/// notifications, so the 202 branch is exercised, not assumed.
async fn harness() -> Harness {
    let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let tool_set = Arc::new(ToolSet::new({
        let received = Arc::clone(&received);
        move |text: String| {
            let received = Arc::clone(&received);
            async move {
                received.lock().expect("received lock").push(text.clone());
                let request: Value =
                    serde_json::from_str(&text).expect("the stub is handed JSON");
                let Some(id) = request.get("id").cloned() else {
                    return Ok(None);
                };
                Ok(Some(json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [] } })))
            }
        }
    }));

    harness_with(tool_set, received).await
}

/// The same with a tool set the case brings along — the status the transport answers when
/// the tool layer fails can only be reached with a tool set that fails.
async fn harness_with(tool_set: Arc<ToolSet>, received: Arc<Mutex<Vec<String>>>) -> Harness {
    launch(tool_set, received, None).await
}

/// The same, with a head deadline of its own. `None` is the production path; naming one is
/// what the deadline case needs and what production deliberately cannot do.
async fn harness_with_head_deadline(head_deadline: Duration) -> Harness {
    let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let tool_set = Arc::new(ToolSet::new({
        let received = Arc::clone(&received);
        move |text: String| {
            let received = Arc::clone(&received);
            async move {
                received.lock().expect("received lock").push(text);
                Ok(None)
            }
        }
    }));

    launch(tool_set, received, Some(head_deadline)).await
}

async fn launch(
    tool_set: Arc<ToolSet>,
    received: Arc<Mutex<Vec<String>>>,
    head_deadline: Option<Duration>,
) -> Harness {
    let log_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&log_lines);
    let log: browser_control_bridge::hub::LogSink =
        Arc::new(move |line: &str| sink.lock().expect("log lock").push(line.to_string()));

    let started = match head_deadline {
        Some(deadline) => http::start_with_head_deadline(0, token(), tool_set, log, deadline).await,
        None => http::start(0, token(), tool_set, log).await,
    };
    let transport = started.expect("the transport binds an ephemeral port on loopback");

    Harness {
        transport,
        received,
        log_lines,
    }
}

/* -------------------------------------------------------------------- client */

struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header == name)
            .map(|(_, value)| value.as_str())
    }
}

/// One request, written in one go and read back by its `Content-Length`.
async fn request(port: u16, text: &str) -> Answer {
    let mut stream = connect(port).await;
    stream
        .write_all(text.as_bytes())
        .await
        .expect("the request reaches the socket");
    read_answer(&mut stream).await
}

async fn connect(port: u16) -> TcpStream {
    tokio::time::timeout(
        SOCKET_TIMEOUT,
        TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .expect("the transport accepts a connection within the socket timeout")
    .expect("the transport accepts the connection")
}

/// One request built by hand. No `Connection: close` from this side: the server deciding
/// to close is what case 14 is about, and a client that asked for it would be proving its
/// own header.
fn request_text(
    method: &str,
    path: &str,
    port: u16,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> String {
    let mut text = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
    for (name, value) in headers {
        text.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(body) = body {
        text.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    text.push_str("\r\n");
    if let Some(body) = body {
        text.push_str(body);
    }
    text
}

async fn read_answer<R>(stream: &mut R) -> Answer
where
    R: AsyncRead + Unpin,
{
    let bytes = tokio::time::timeout(ANSWER_TIMEOUT, read_answer_bytes(stream))
        .await
        .expect("the transport answers within the answer timeout")
        .expect("the socket carries a complete answer");
    parse_answer(&bytes)
}

/// Reads until the head and the body it announces have arrived.
///
/// A read error is not a failure by itself: a rejection closes the socket, and Linux may
/// report the reset while the answer still sits in the receive queue. What matters is
/// whether the answer is complete, so that is what decides the outcome — in *both* of those
/// branches, and not only on the next turn of the loop. Checking late is how a complete
/// `413` was reported as an error on a kernel that chose to send `RST`.
async fn read_answer_bytes<R>(stream: &mut R) -> std::io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];

    loop {
        if is_complete(&buffer) {
            return Ok(buffer);
        }
        match stream.read(&mut chunk).await {
            Ok(0) => {
                if is_complete(&buffer) {
                    return Ok(buffer);
                }
                return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
            }
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(error) => {
                if is_complete(&buffer) {
                    return Ok(buffer);
                }
                return Err(error);
            }
        }
    }
}

/// Whether the buffer already holds head and body.
fn is_complete(buffer: &[u8]) -> bool {
    answer_length(buffer).is_some_and(|needed| buffer.len() >= needed)
}

/// The total byte count the answer needs once its head has arrived, or `None` while the head
/// is still incomplete — or when the head announces no length at all.
///
/// A head without `Content-Length` is `None` on purpose: a chunked answer would otherwise
/// count as "complete after zero body bytes", and every assertion on its body would pass
/// against an empty string. This transport always sends a length, so a `None` after a
/// complete head is a fact worth failing on, not a value to paper over.
fn answer_length(buffer: &[u8]) -> Option<usize> {
    let head_end = position(buffer, b"\r\n\r\n")?;
    let declared = declared_length(&buffer[..head_end])?;
    Some(head_end + 4 + declared)
}

fn declared_length(head: &[u8]) -> Option<usize> {
    let head = String::from_utf8_lossy(head);
    head.split("\r\n")
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse().ok())
}

fn parse_answer(bytes: &[u8]) -> Answer {
    let head_end = position(bytes, b"\r\n\r\n").expect("the answer has a head terminator");
    let head = String::from_utf8_lossy(&bytes[..head_end]).into_owned();
    let mut lines = head.split("\r\n");

    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .expect("the status line carries a code")
        .parse()
        .expect("the status code is a number");

    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();

    let length = declared_length(&bytes[..head_end]).unwrap_or(bytes.len() - head_end - 4);
    let start = head_end + 4;
    let end = (start + length).min(bytes.len());

    Answer {
        status,
        headers,
        body: String::from_utf8_lossy(&bytes[start..end]).into_owned(),
    }
}

/// Everything the socket still carries, until the peer closes it.
async fn read_until_close<R>(stream: &mut R) -> Vec<u8>
where
    R: AsyncRead + Unpin,
{
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) => return buffer,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            // A reset after the bytes arrived is still a closed socket; the bytes are what
            // the case asserts on.
            Err(_) => return buffer,
        }
    }
}

fn position(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/* -------------------------------------------------------------------- cases */

#[tokio::test]
async fn http_startHttpTransport_withToolsListAndValidToken_shouldAnswer200WithApplicationJson() {
    // GIVEN a caller holding the token and one well-formed JSON-RPC object,
    let harness = harness().await;
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }).to_string();
    let authorization = format!("Bearer {}", token());

    // WHEN it posts that object to /mcp,
    let answer = request(
        harness.port(),
        &request_text(
            "POST",
            "/mcp",
            harness.port(),
            &[
                ("Authorization", authorization.as_str()),
                ("Content-Type", "application/json"),
            ],
            Some(&body),
        ),
    )
    .await;

    // THEN the answer is 200 with JSON, and it is exactly what the tool set returned — the
    // transport adds no envelope of its own:
    assert_eq!(answer.status, 200);
    assert_eq!(answer.header("content-type"), Some("application/json"));
    assert_eq!(
        serde_json::from_str::<Value>(&answer.body).expect("the answer is JSON"),
        json!({ "jsonrpc": "2.0", "id": 1, "result": { "tools": [] } }),
    );
    assert_eq!(harness.received(), vec![body]);

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_withoutToken_shouldAnswer401WithBearerChallengeAndEmptyBody() {
    // GIVEN a caller with a perfectly good request but no Authorization header,
    let harness = harness().await;
    let body = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }).to_string();

    // WHEN it posts to /mcp,
    let answer = request(
        harness.port(),
        &request_text(
            "POST",
            "/mcp",
            harness.port(),
            &[("Content-Type", "application/json")],
            Some(&body),
        ),
    )
    .await;

    // THEN it gets 401 with the challenge, an empty body — no reason, no tool data — and
    // the body never reached the tool set:
    assert_eq!(answer.status, 401);
    assert_eq!(answer.header("www-authenticate"), Some("Bearer"));
    assert_eq!(answer.body, "");
    assert!(harness.received().is_empty());

    // And the log says neither the body nor the header:
    for line in harness.log_lines() {
        assert!(
            !line.contains(&body),
            "the log carries the request body: {line}"
        );
        assert!(
            !line.contains("jsonrpc"),
            "the log carries the request body: {line}"
        );
        assert!(
            !line.contains(token()),
            "the log carries the token: {line}"
        );
    }

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_withWrongToken_shouldAnswer401WithBearerChallenge() {
    // GIVEN a caller with the right header shape and the wrong secret,
    let harness = harness().await;
    let body = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }).to_string();
    let authorization = format!("Bearer {}", wrong_token());

    // WHEN it posts to /mcp,
    let answer = request(
        harness.port(),
        &request_text(
            "POST",
            "/mcp",
            harness.port(),
            &[
                ("Authorization", authorization.as_str()),
                ("Content-Type", "application/json"),
            ],
            Some(&body),
        ),
    )
    .await;

    // THEN the rejection looks exactly like the missing-token one: a caller learns nothing
    // about how close it was, and no tool data leaks:
    assert_eq!(answer.status, 401);
    assert_eq!(answer.header("www-authenticate"), Some("Bearer"));
    assert_eq!(answer.body, "");
    assert!(harness.received().is_empty());

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_withBasicScheme_shouldAnswer401WithBearerChallenge() {
    // GIVEN a caller that carries the correct secret in the wrong scheme,
    let harness = harness().await;
    let body = json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" }).to_string();
    let authorization = format!("Basic {}", token());

    // WHEN it posts to /mcp,
    let answer = request(
        harness.port(),
        &request_text(
            "POST",
            "/mcp",
            harness.port(),
            &[
                ("Authorization", authorization.as_str()),
                ("Content-Type", "application/json"),
            ],
            Some(&body),
        ),
    )
    .await;

    // THEN the scheme check fails before the token ever matters:
    assert_eq!(answer.status, 401);
    assert_eq!(answer.header("www-authenticate"), Some("Bearer"));
    assert_eq!(answer.body, "");
    assert!(harness.received().is_empty());

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_withGetOnMcpAndNoToken_shouldAnswer405WithAllowPost() {
    // GIVEN an unauthenticated caller — no `Authorization` header at all,
    let harness = harness().await;

    // WHEN it uses GET on /mcp,
    let answer = request(
        harness.port(),
        &request_text("GET", "/mcp", harness.port(), &[], None),
    )
    .await;

    // THEN it gets 405 and is told which method would have worked. The method check comes
    // before the token check, so a regression that swapped that order would answer 401
    // here and this case would notice:
    assert_eq!(answer.status, 405);
    assert_eq!(answer.header("allow"), Some("POST"));
    assert_eq!(answer.body, "");

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_withUnknownPath_shouldAnswer404() {
    // GIVEN a request to a path this transport does not serve,
    let harness = harness().await;
    let body = json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/list" }).to_string();
    let authorization = format!("Bearer {}", token());

    // WHEN it is posted with a valid token,
    let answer = request(
        harness.port(),
        &request_text(
            "POST",
            "/x",
            harness.port(),
            &[
                ("Authorization", authorization.as_str()),
                ("Content-Type", "application/json"),
            ],
            Some(&body),
        ),
    )
    .await;

    // THEN the path decides first — 404, not 200 and not 401:
    assert_eq!(answer.status, 404);
    assert_eq!(answer.body, "");
    assert!(harness.received().is_empty());

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_withOversizedContentLength_shouldAnswer413BeforeAnyBodyArrives() {
    // GIVEN a caller that announces twice the allowed body and never sends it,
    let harness = harness().await;
    let authorization = format!("Bearer {}", token());
    let declared = (2 * MAX_BODY_BYTES).to_string();
    let text = request_text(
        "POST",
        "/mcp",
        harness.port(),
        &[
            ("Authorization", authorization.as_str()),
            ("Content-Type", "application/json"),
            ("Content-Length", declared.as_str()),
        ],
        None,
    );
    // The head terminator, and then nothing: without the header check the transport waits
    // for a body that never comes, and the answer timeout is what makes that a red case by
    // name instead of a hang.
    assert!(text.ends_with("\r\n\r\n"));

    // WHEN the transport answers,
    let answer = request(harness.port(), &text).await;

    // THEN it is 413 with an empty body, decided from the header alone:
    assert_eq!(answer.status, 413);
    assert_eq!(answer.body, "");
    assert!(harness.received().is_empty());

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_withABodyOfOneByteOverTheRequestLimit_shouldAnswer413WhileTheSocketAllowsFiveMebibytes(
) {
    // GIVEN a caller that announces one byte more than a request may carry. The socket
    // limit is 5 242 880, so this only answers 413 if the request limit is its own number
    // and was not dragged along with it:
    let harness = harness().await;
    let authorization = format!("Bearer {}", token());
    // Literal for the same reason `MAX_BODY_BYTES` is: a derived value here would follow
    // the socket limit and keep this case green by accident.
    let declared = (MAX_BODY_BYTES + 1).to_string();

    // WHEN the transport answers,
    let answer = request(
        harness.port(),
        &request_text(
            "POST",
            "/mcp",
            harness.port(),
            &[
                ("Authorization", authorization.as_str()),
                ("Content-Type", "application/json"),
                ("Content-Length", declared.as_str()),
            ],
            None,
        ),
    )
    .await;

    // THEN it is 413, decided from the header alone, and nothing reaches the tool layer:
    assert_eq!(declared, "1048577");
    assert_eq!(answer.status, 413);
    assert_eq!(answer.body, "");
    assert!(harness.received().is_empty());

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_withOversizedChunkedBody_shouldAnswer413BeforeTheBodyFinishes() {
    // GIVEN a chunked body — no Content-Length to inspect — of twice the allowed size,
    // written in chunks,
    let harness = harness().await;
    let authorization = format!("Bearer {}", token());
    let total_bytes = 2 * MAX_BODY_BYTES;
    // Deliberately smaller than a socket read, for the reason the template's case gives:
    // the transport answers as soon as the counter crosses the limit, and a chunk that
    // fits one read leaves nothing in the receive queue, so the close arrives as a FIN and
    // the status line survives.
    let chunk = vec![0x20_u8; 16 * 1024];
    let pause_between_chunks = Duration::from_millis(2);

    let stream = connect(harness.port()).await;
    let (mut reader, mut writer) = stream.into_split();
    writer
        .write_all(
            format!(
                "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\
                 Authorization: {authorization}\r\n\
                 Content-Type: application/json\r\n\
                 Transfer-Encoding: chunked\r\n\r\n",
                harness.port(),
            )
            .as_bytes(),
        )
        .await
        .expect("the head reaches the socket");

    let written = Arc::new(AtomicUsize::new(0));
    let stopped = Arc::new(AtomicBool::new(false));
    let mut framed = Vec::with_capacity(chunk.len() + 16);
    framed.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
    framed.extend_from_slice(&chunk);
    framed.extend_from_slice(b"\r\n");
    let uploaded_bytes = chunk.len();

    // WHEN we keep writing until the transport answers,
    let upload = {
        let written = Arc::clone(&written);
        let stopped = Arc::clone(&stopped);
        tokio::spawn(async move {
            while !stopped.load(Ordering::Relaxed) && written.load(Ordering::Relaxed) < total_bytes
            {
                if writer.write_all(&framed).await.is_err() {
                    break;
                }
                written.fetch_add(uploaded_bytes, Ordering::Relaxed);
                // Paced on purpose: a loopback socket swallows megabytes faster than any
                // server can answer, and an unpaced upload would prove nothing about where
                // the limit fired.
                tokio::time::sleep(pause_between_chunks).await;
            }
        })
    };

    let answer = read_answer(&mut reader).await;
    // Only meaningful at the moment of the answer: afterwards the upload is still counting.
    let written_when_answered = written.load(Ordering::Relaxed);
    stopped.store(true, Ordering::Relaxed);
    upload.abort();

    // THEN the 413 arrives while most of the body is still unsent — the limit fires on the
    // stream instead of after buffering 2 MiB:
    assert_eq!(answer.status, 413);
    assert_eq!(answer.body, "");
    assert!(
        written_when_answered < total_bytes,
        "the 413 arrived only after all {written_when_answered} bytes were written",
    );
    assert!(
        written_when_answered <= MAX_BODY_BYTES + 512 * 1024,
        "the 413 was decided only after {written_when_answered} bytes, far beyond the limit",
    );
    assert!(harness.received().is_empty());

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_afterARejection_shouldStillAnswerTheNextRequest() {
    // GIVEN a request that was rejected for its declared size — the same never-sent body
    // as above, so the same bound applies,
    let harness = harness().await;
    let authorization = format!("Bearer {}", token());
    let declared = (2 * MAX_BODY_BYTES).to_string();
    let rejected = request(
        harness.port(),
        &request_text(
            "POST",
            "/mcp",
            harness.port(),
            &[
                ("Authorization", authorization.as_str()),
                ("Content-Type", "application/json"),
                ("Content-Length", declared.as_str()),
            ],
            None,
        ),
    )
    .await;
    assert_eq!(rejected.status, 413);

    // WHEN the next request arrives with a valid token and a small body,
    let body = json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/list" }).to_string();
    let answer = request(
        harness.port(),
        &request_text(
            "POST",
            "/mcp",
            harness.port(),
            &[
                ("Authorization", authorization.as_str()),
                ("Content-Type", "application/json"),
            ],
            Some(&body),
        ),
    )
    .await;

    // THEN the transport served it — one rejection is not a broken listener:
    assert_eq!(answer.status, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&answer.body)
            .expect("the answer is JSON")
            .get("id")
            .cloned()
            .expect("the answer carries the id"),
        json!(6),
    );

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_withNotification_shouldAnswer202WithEmptyBody() {
    // GIVEN a notification — a JSON-RPC object without `id`,
    let harness = harness().await;
    let body = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string();
    let authorization = format!("Bearer {}", token());

    // WHEN it is posted,
    let answer = request(
        harness.port(),
        &request_text(
            "POST",
            "/mcp",
            harness.port(),
            &[
                ("Authorization", authorization.as_str()),
                ("Content-Type", "application/json"),
            ],
            Some(&body),
        ),
    )
    .await;

    // THEN JSON-RPC forbids a response, so HTTP gets an accepted empty one:
    assert_eq!(answer.status, 202);
    assert_eq!(answer.body, "");
    assert_eq!(harness.received(), vec![body]);

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_whenTheToolSetThrows_shouldAnswer500AndLogTheStatusInsteadOfTheMessage(
) {
    // GIVEN a tool set that fails with a message quoting a fragment of the body, the way a
    // `JSON.parse` failure does,
    let message_body = "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"tools/call\",\
                        \"params\":{\"text\":\"operator was reading this\"}}";
    let quoted = message_body.to_string();
    let tool_set = Arc::new(ToolSet::new(move |_text: String| {
        let quoted = quoted.clone();
        async move { Err(format!("Unexpected token in {quoted}").into()) }
    }));
    let harness = harness_with(tool_set, Arc::new(Mutex::new(Vec::new()))).await;
    let authorization = format!("Bearer {}", token());

    // WHEN a validly authenticated request reaches that tool set,
    let answer = request(
        harness.port(),
        &request_text(
            "POST",
            "/mcp",
            harness.port(),
            &[
                ("Authorization", authorization.as_str()),
                ("Content-Type", "application/json"),
            ],
            Some(message_body),
        ),
    )
    .await;

    // THEN the caller gets an answer instead of a dead listener,
    assert_eq!(answer.status, 500);
    assert_eq!(answer.body, "");

    // ... and the log names the status, never the failure's text: that text can be request
    // content, and stderr goes to journald where it stays:
    let failure_line = harness
        .log_lines()
        .into_iter()
        .find(|line| line.starts_with("http request failed"))
        .unwrap_or_else(|| panic!("no failure line in the log: {:?}", harness.log_lines()));
    assert!(
        failure_line.contains("500"),
        "the failure line does not name the status: {failure_line}"
    );
    assert!(
        !failure_line.contains("operator was reading this"),
        "the log quotes the request body: {failure_line}"
    );
    assert!(
        !failure_line.contains("Unexpected token"),
        "the log carries the failure message: {failure_line}"
    );

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_onDefaultHost_shouldBindLoopbackOnly() {
    // GIVEN a transport started without an explicit host,
    // WHEN we read back the address the kernel actually bound,
    // THEN it is loopback, on a port the kernel really assigned:
    let harness = harness().await;
    assert_eq!(harness.transport.host, "127.0.0.1");
    assert!(harness.transport.port > 0);

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_afterARejection_shouldCloseTheSocketInsteadOfHoldingIt() {
    // GIVEN a caller with the wrong token that announces a chunked body and then sends one
    // small piece — the trickle that would hold the connection forever if the transport
    // answered and kept the socket open,
    let harness = harness().await;
    let authorization = format!("Bearer {}", wrong_token());
    let mut stream = connect(harness.port()).await;
    stream
        .write_all(
            format!(
                "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\
                 Authorization: {authorization}\r\n\
                 Content-Type: application/json\r\n\
                 Transfer-Encoding: chunked\r\n\r\n\
                 5\r\n{{\"jso\r\n",
                harness.port(),
            )
            .as_bytes(),
        )
        .await
        .expect("the head and the first chunk reach the socket");

    // WHEN we wait without ever sending the rest,
    let answer = tokio::time::timeout(SOCKET_TIMEOUT, read_until_close(&mut stream))
        .await
        .unwrap_or_else(|_| {
            panic!("the socket was still open after {SOCKET_TIMEOUT:?}")
        });
    let answer = String::from_utf8_lossy(&answer).into_owned();

    // THEN the server answered 401 and closed its end instead of waiting for a body it
    // would never accept. The close is the case: `read_until_close` only returned because
    // the peer sent FIN or RST.
    assert!(
        answer.starts_with("HTTP/1.1 401 "),
        "the answer is not a 401: {answer}"
    );
    assert!(
        answer.to_ascii_lowercase().contains("\r\nconnection: close\r\n"),
        "the rejection does not announce the close: {answer}"
    );

    harness.close().await;
}

#[tokio::test]
async fn http_withTheSameAnswerAsStdio_shouldMatch() {
    // GIVEN one request, a real hub and the tool layer — the seam both transports use,
    let seam_request = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/list" }).to_string();
    let log_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let context = Arc::new(ToolContext {
        hub: Arc::new(Hub::new(&test_config(), token())),
        log: Arc::new(move |line: &str| {
            log_lines
                .lock()
                .expect("log lock")
                .push(line.to_string());
        }),
    });

    // WHEN it goes in over HTTP and over stdio,
    let tool_set = Arc::new(ToolSet::new({
        let context = Arc::clone(&context);
        move |text: String| {
            let context = Arc::clone(&context);
            async move { Ok(mcp::handle_message_text(&text, &context).await) }
        }
    }));
    let authorization = format!("Bearer {}", token());
    let transport = http::start(0, token(), tool_set, Arc::new(|_| {}))
        .await
        .expect("the transport binds an ephemeral port on loopback");
    let answer = request(
        transport.port,
        &request_text(
            "POST",
            "/mcp",
            transport.port,
            &[
                ("Authorization", authorization.as_str()),
                ("Content-Type", "application/json"),
            ],
            Some(&seam_request),
        ),
    )
    .await;
    transport.close().await;

    let (server, client) = tokio::io::duplex(64 * 1024);
    let (server_read, server_write) = tokio::io::split(server);
    let serving = tokio::spawn(stdio::serve(
        BufReader::new(server_read),
        server_write,
        Arc::clone(&context),
    ));
    let (client_read, mut client_write) = tokio::io::split(client);
    client_write
        .write_all(format!("{seam_request}\n").as_bytes())
        .await
        .expect("the request reaches the stdio seam");
    let mut from_stdio = String::new();
    tokio::time::timeout(
        ANSWER_TIMEOUT,
        BufReader::new(client_read).read_line(&mut from_stdio),
    )
    .await
    .expect("stdio answers within the answer timeout")
    .expect("the stdio answer arrives");
    serving.abort();

    // THEN the two answers are the same text, not merely two texts that parse alike:
    assert_eq!(answer.status, 200);
    assert_eq!(answer.body, from_stdio.trim_end());
    // ... and it is the real `tools/list` answer, so the equality is not the equality of
    // two empty strings:
    assert_eq!(
        serde_json::from_str::<Value>(&answer.body)
            .expect("the answer is JSON")
            .get("result")
            .and_then(|result| result.get("tools"))
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(14),
    );
}

#[tokio::test]
async fn http_startHttpTransport_withAnAbsoluteFormTarget_shouldAnswer404() {
    // GIVEN a caller that spells the target as an absolute URI — legal to send, and the form
    // a proxy would forward,
    let harness = harness().await;
    let body = json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/list" }).to_string();
    let authorization = format!("Bearer {}", token());
    let target = format!("http://127.0.0.1:{}/mcp", harness.port());

    // WHEN it posts that target with a valid token and a valid body,
    let answer = request(
        harness.port(),
        &request_text(
            "POST",
            &target,
            harness.port(),
            &[
                ("Authorization", authorization.as_str()),
                ("Content-Type", "application/json"),
            ],
            Some(&body),
        ),
    )
    .await;

    // THEN nothing is served: the template compares the whole request target with `/mcp` and
    // an absolute target never equals it, so this is a `404` and not the `200` a path-only
    // check hands out:
    assert_eq!(answer.status, 404);
    assert_eq!(answer.body, "");
    assert!(harness.received().is_empty());

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_withContentLengthAndChunked_shouldAnswer400BeforeTheSizeCheck() {
    // GIVEN a request that announces a length and a chunking at the same time — the framing
    // RFC 7230 §3.3.3 forbids, because two readers may disagree about where the body ends —
    // and a declared length that is oversized, so the two checks would answer differently,
    let harness = harness().await;
    let authorization = format!("Bearer {}", token());
    let declared = (2 * MAX_BODY_BYTES).to_string();

    // WHEN both header orders are sent — and the order matters: hyper deletes the
    // `Content-Length` line from the request map when `Transfer-Encoding` follows it, so a
    // check that only reads the map answers 200 for the first of these two,
    for framing in [
        format!("Content-Length: {declared}\r\nTransfer-Encoding: chunked\r\n"),
        format!("Transfer-Encoding: chunked\r\nContent-Length: {declared}\r\n"),
    ] {
        let text = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\
             Authorization: {authorization}\r\n\
             Content-Type: application/json\r\n\
             {framing}\r\n\
             5\r\nhello\r\n0\r\n\r\n",
            harness.port(),
        );
        let answer = request(harness.port(), &text).await;

        // THEN the ambiguity decides first: `400`, not the `413` the declared length would
        // earn on its own, and not a `200` from a body read with the wrong decoder:
        assert_eq!(
            answer.status, 400,
            "the framing [{framing}] was not refused as ambiguous"
        );
        assert_eq!(answer.body, "");
    }
    assert!(harness.received().is_empty());

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_withOversizedLength_shouldAnswer413WithConnectionCloseAndEndTheSocket(
) {
    // GIVEN a caller that announces twice the allowed body and never sends it,
    let harness = harness().await;
    let authorization = format!("Bearer {}", token());
    let declared = (2 * MAX_BODY_BYTES).to_string();
    let mut stream = connect(harness.port()).await;
    stream
        .write_all(
            request_text(
                "POST",
                "/mcp",
                harness.port(),
                &[
                    ("Authorization", authorization.as_str()),
                    ("Content-Type", "application/json"),
                    ("Content-Length", declared.as_str()),
                ],
                None,
            )
            .as_bytes(),
        )
        .await
        .expect("the head reaches the socket");

    // WHEN the transport answers and the socket is read on to its end,
    let answer = read_answer(&mut stream).await;
    let rest = tokio::time::timeout(SOCKET_TIMEOUT, read_until_close(&mut stream))
        .await
        .expect("the rejection closes the socket instead of leaving it open");

    // THEN the `413` announces the close and the close really happens — a rejection a client
    // could keep talking on would be a socket held open by a body that trickles in forever:
    assert_eq!(answer.status, 413);
    assert_eq!(answer.header("connection"), Some("close"));
    assert!(rest.is_empty(), "the closed socket carried {rest:?}");

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_withHalfAHead_shouldEndTheSocketAtTheHeadDeadline() {
    // GIVEN a transport holding the head deadline the production path has (60 s, Node's
    // `headersTimeout`), named as one second so this case does not take a minute,
    let harness = harness_with_head_deadline(TEST_HEAD_DEADLINE).await;
    let mut stream = connect(harness.port()).await;

    // WHEN a client sends half a head and then nothing at all,
    stream
        .write_all(
            format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n", harness.port()).as_bytes(),
        )
        .await
        .expect("the half head reaches the socket");
    let answer = tokio::time::timeout(HEAD_DEADLINE_WAIT, read_until_close(&mut stream))
        .await
        .expect("the connection ends at the head deadline instead of waiting forever");

    // THEN the socket ends and nothing is written: the deadline closes, it does not answer,
    // which is what the template's `headersTimeout` does:
    assert!(
        answer.is_empty(),
        "the transport answered a head it never finished reading: {}",
        String::from_utf8_lossy(&answer)
    );
    assert!(harness.received().is_empty());

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_whenTheToolSetPanics_shouldAnswer500AndLogTheStatus() {
    // GIVEN a tool layer that panics instead of answering — the production wiring hands the
    // transport `Ok(mcp::handle_message_text(…))`, which cannot fail, so a panic is the only
    // way the `500` can be reached at all,
    let tool_set = Arc::new(ToolSet::new(|_text: String| async move {
        // After an await point, the way a panic inside a deep call arrives: the catch has to
        // hold across polls, not only around the first one.
        tokio::task::yield_now().await;
        panic!("the tool layer hit a broken invariant")
    }));
    let harness = harness_with(tool_set, Arc::new(Mutex::new(Vec::new()))).await;
    let authorization = format!("Bearer {}", token());
    let body = json!({ "jsonrpc": "2.0", "id": 10, "method": "tools/list" }).to_string();

    // WHEN a validly authenticated request reaches that tool layer,
    let answer = request(
        harness.port(),
        &request_text(
            "POST",
            "/mcp",
            harness.port(),
            &[
                ("Authorization", authorization.as_str()),
                ("Content-Type", "application/json"),
            ],
            Some(&body),
        ),
    )
    .await;

    // THEN the caller gets `500` with `Connection: close` instead of a connection that dies
    // without a word, and the log carries exactly one line naming the status:
    assert_eq!(answer.status, 500);
    assert_eq!(answer.header("connection"), Some("close"));
    assert_eq!(answer.body, "");
    assert_eq!(
        harness.log_lines(),
        vec!["http request failed, answering 500".to_string()]
    );

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_whenTheClientAbortsTheBody_shouldAnswerNothingAtAll() {
    // GIVEN a caller that announces a hundred bytes, sends five of them and then shuts its
    // write half — the truncated upload,
    let harness = harness().await;
    let authorization = format!("Bearer {}", token());
    let mut stream = connect(harness.port()).await;
    stream
        .write_all(
            format!(
                "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\
                 Authorization: {authorization}\r\n\
                 Content-Type: application/json\r\n\
                 Content-Length: 100\r\n\r\n{{\"jso",
                harness.port(),
            )
            .as_bytes(),
        )
        .await
        .expect("the head and five body bytes reach the socket");
    stream
        .shutdown()
        .await
        .expect("the write half closes, so the read half still carries a late answer");

    // WHEN the transport notices that the body ended early,
    let answer = tokio::time::timeout(SOCKET_TIMEOUT, read_until_close(&mut stream))
        .await
        .expect("the transport ends the connection");

    // THEN no status is invented: the template answers nothing here ("inventing a status
    // would only add a line to the log"), and a client that half-closed can still read, so
    // this asserts on the bytes rather than on the socket merely being gone:
    assert!(
        answer.is_empty(),
        "the transport invented an answer for an aborted body: {}",
        String::from_utf8_lossy(&answer)
    );
    assert!(harness.log_lines().is_empty(), "{:?}", harness.log_lines());

    harness.close().await;
}

#[tokio::test]
async fn http_startHttpTransport_whenClosedWithAnIdleKeepAliveSocket_shouldEndThatSocketToo() {
    // GIVEN a caller that keeps its connection open for a second request — keep-alive, no
    // `Connection: close` in its own head,
    let harness = harness().await;
    let authorization = format!("Bearer {}", token());
    let body = json!({ "jsonrpc": "2.0", "id": 11, "method": "tools/list" }).to_string();
    let mut stream = connect(harness.port()).await;
    stream
        .write_all(
            request_text(
                "POST",
                "/mcp",
                harness.port(),
                &[
                    ("Authorization", authorization.as_str()),
                    ("Content-Type", "application/json"),
                ],
                Some(&body),
            )
            .as_bytes(),
        )
        .await
        .expect("the request reaches the socket");
    let first = read_answer(&mut stream).await;
    assert_eq!(first.status, 200);

    // WHEN the transport is closed,
    harness.close().await;

    // THEN the idle socket ends with it instead of outliving the listener: the template's
    // `closeAllConnections()` exists for exactly this, because `close()` alone would wait for
    // the client to go away first.
    let rest = tokio::time::timeout(SOCKET_TIMEOUT, read_until_close(&mut stream))
        .await
        .expect("the idle keep-alive socket ended with the transport");
    assert!(
        rest.is_empty(),
        "the socket carried {:?} after the close",
        String::from_utf8_lossy(&rest)
    );
}

fn test_config() -> Config {
    Config {
        host: "127.0.0.1".to_string(),
        port: 8_110,
        http_port: 8_111,
        log_level: Level::Info,
        hello_timeout_ms: 2_000,
        call_timeout_ms: 10_000,
    }
}
