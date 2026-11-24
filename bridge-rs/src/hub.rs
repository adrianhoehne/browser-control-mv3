//! The hub: everything that happens on one accepted connection after the frame
//! layer did its job — authentication, the requests to the extension, and the
//! deadlines around them.
//!
//! Stage 2c of `docs/38`, ported from `bridge/hub.mjs`. The hub owns no socket and
//! writes no timestamp: everything it wants on the wire leaves through one
//! [`Outbound`] channel, the `Close` frame included, and the log writer is
//! injected. That keeps every decision in here testable without a process, a clock
//! stub or a real peer — `tests/hub.rs` drives [`Hub::on_message`] directly and
//! reads the frames out of a channel. The socket lives in `main.rs`, where a
//! writer task drains [`Outbound`] and a reader task feeds the events back in.

// The error carries the extension's whole `error` object (`details`), because the
// MCP layer reads `url`, `kind` and `contentType` off it — that makes it 128 bytes,
// and clippy is right about the size while the design is right about the payload:
// boxing it would buy an allocation on a path that already has one and hide the
// object the next stage is supposed to read.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

use crate::config::Config;
use crate::log::{self, Level};
use crate::protocol;
use crate::ws::CloseInfo;

/// The version the bridge reports in the `welcome` frame.
///
/// Hard-coded on purpose, exactly like the template: the extension reads its own
/// version from its manifest, the bridge reports the version of *this* package, and
/// `Cargo.toml`'s version is not the same statement — a `cargo release` bump would
/// silently change what the extension sees on the wire.
pub const BRIDGE_VERSION: &str = "0.1.0";

/// The error code the log prints when an `ok:false` answer carried none.
const NO_ERROR_CODE: &str = "unknown";

/// Stands in for a field a broken result did not carry, so the log line keeps its
/// shape and the reader sees the hole instead of a shifted column.
const NO_FIELD: &str = "?";

/// The hole marker of the `inspect` line, deliberately not [`NO_FIELD`]: the spec
/// spells that line's holes as `selector=<selektor|->`, and a lone `?` there would
/// read like a one-character selector instead of "not set".
const UNSET_INSPECT_FIELD: &str = "-";

/// The sources the injected page code may name. Whitelisted here as well as in the
/// extension: a log line is the wrong place to find out what a broken result says.
const TEXT_SOURCES: [&str; 2] = ["innerText", "textContent"];

/// What a field nobody whitelisted is printed with. The *key* stays: dropping it
/// would make a new field look like "does not exist", and two unlisted fields would
/// silently collapse into one.
const UNLISTED: &str = "<unlisted field>";

/* ------------------------------------------------------------------ outbound */

/// Everything the hub asks the connection to put on the wire.
///
/// `Close` travels through the same channel as `Text`, which is the whole point of
/// the shape: the hub has no socket to close, only a request to make. The reason is
/// carried as text because the numeric code is the contract and the phrase is the
/// peer's — `format_close` in the log line is the only place the two are joined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outbound {
    Text(String),
    Close { code: u16, reason: String },
}

/// The channel half of a connection.
///
/// Unbounded on purpose: a bounded queue would report a *full* channel the same way
/// it reports a dead one, and "the peer is gone" is the only answer the hub acts on.
/// The template buffered without a limit for the same reason — a close frame that a
/// full queue swallowed would be a connection nobody ever ended.
pub type OutboundSender = mpsc::UnboundedSender<Outbound>;

/// What the hub writes log lines through. The timestamp prefix belongs to the
/// process (`log::log_line`), not to the hub.
pub type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

/// The seam the JSON-RPC layer of stage 2d receives the raw `status` result on.
pub type StatusSink = Arc<dyn Fn(&Value) + Send + Sync>;

/* ------------------------------------------------------------------- errors */

/// The three ways a request can fail. A `kind` instead of a type per case, because
/// the caller switches on it — the same reasoning the template had for its `name`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// Nobody to ask, or the peer went away mid-request.
    Unavailable,
    /// No answer within `BC_CALL_TIMEOUT_MS`.
    Timeout,
    /// The extension answered `ok:false` — the only case that carries a code.
    Extension,
}

/// A request that did not produce a result.
#[derive(Debug, Clone, PartialEq)]
pub struct HubRequestError {
    pub kind: FailureKind,
    pub message: String,
    /// The extension's own `code`, present only for [`FailureKind::Extension`].
    pub code: Option<String>,
    /// The extension's whole `error` object, so the MCP layer can read `url`,
    /// `kind` and `contentType` off it instead of guessing from the message.
    pub details: Option<Value>,
}

impl HubRequestError {
    fn unavailable(message: &str) -> HubRequestError {
        HubRequestError {
            kind: FailureKind::Unavailable,
            message: message.to_string(),
            code: None,
            details: None,
        }
    }

    fn timeout(message: String) -> HubRequestError {
        HubRequestError {
            kind: FailureKind::Timeout,
            message,
            code: None,
            details: None,
        }
    }

    fn extension(code: String, details: Option<Value>) -> HubRequestError {
        HubRequestError {
            kind: FailureKind::Extension,
            message: format!("the extension answered ok:false code={code}"),
            code: Some(code),
            details,
        }
    }
}

impl std::fmt::Display for HubRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for HubRequestError {}

/* ---------------------------------------------------------------------- hub */

/// The handle a caller keeps for one connection.
///
/// Opaque because the hub files its sessions under it: a connection number is not
/// something a caller should read, compare or invent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectionId(u64);

/// One connection as the hub sees it: a channel, an open flag and the peer string
/// that goes into every log line. No socket, no address, no file descriptor.
struct Connection {
    peer: String,
    outbound: OutboundSender,
    /// Set to `false` as soon as the hub closes the connection, so a message that
    /// raced with our own close frame is not worth a state change or a log line —
    /// the hello timer firing is the usual case.
    open: Arc<AtomicBool>,
}

impl Connection {
    fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Queues one text message. `false` when the peer is already gone: callers race
    /// with disconnects and should not have to wrap every send.
    fn send(&self, text: String) -> bool {
        if !self.is_open() {
            return false;
        }
        self.outbound.send(Outbound::Text(text)).is_ok()
    }

    /// Closes from our side and ends the session's usefulness.
    ///
    /// The flag goes first: the frame is on its way to the writer task, and a
    /// `hello` arriving in between must not be accepted on a connection we just
    /// refused.
    fn close(&self, code: u16, reason: &str) {
        if !self.open.swap(false, Ordering::SeqCst) {
            return;
        }
        let _ = self.outbound.send(Outbound::Close {
            code,
            reason: reason.to_string(),
        });
    }
}

/// One request in flight. `params` rides along because three of the log lines
/// (`click`, `type`, `inspect`) need the *request*, not the result.
struct Pending {
    method: String,
    params: Value,
    timer: AbortHandle,
    responder: Option<oneshot::Sender<Result<Value, HubRequestError>>>,
}

/// One connection's protocol state.
struct Session {
    id: ConnectionId,
    connection: Connection,
    authenticated: bool,
    /// Request ids are counted per connection, not per hub: the first request of
    /// every connection stays `id: 1`, which the replace case and the extension's
    /// own tests both rely on.
    next_request_id: u64,
    pending: HashMap<u64, Pending>,
    hello_timer: Option<AbortHandle>,
}

#[derive(Default)]
struct State {
    sessions: HashMap<u64, Session>,
    /// The authenticated connection, if any.
    current: Option<u64>,
}

/// The hub itself. Shared as an `Arc`, because its deadlines outlive the call that
/// armed them.
pub struct Hub {
    hello_timeout: Duration,
    call_timeout: Duration,
    /// `BC_CALL_TIMEOUT_MS` as configured: the timeout text carries the number the
    /// operator set, and a `Duration` would have to be formatted back into it.
    call_timeout_ms: u64,
    log_level: Level,
    token: String,
    log: LogSink,
    on_status: Option<StatusSink>,
    state: Mutex<State>,
    next_connection_id: AtomicU64,
}

impl Hub {
    pub fn new(config: &Config, token: impl Into<String>) -> Hub {
        Hub {
            hello_timeout: Duration::from_millis(config.hello_timeout_ms),
            call_timeout: Duration::from_millis(config.call_timeout_ms),
            call_timeout_ms: config.call_timeout_ms,
            log_level: config.log_level,
            token: token.into(),
            log: Arc::new(|message: &str| log::log_line(message)),
            on_status: None,
            state: Mutex::new(State::default()),
            // `1`-based on purpose: the session map is keyed by this, and `0` is no
            // id at all.
            next_connection_id: AtomicU64::new(1),
        }
    }

    pub fn with_log(mut self, log: LogSink) -> Hub {
        self.log = log;
        self
    }

    pub fn with_status(mut self, on_status: StatusSink) -> Hub {
        self.on_status = Some(on_status);
        self
    }

    /// Attaches the hub's protocol to one accepted connection.
    ///
    /// `peer` is the socket peer as text and is used verbatim in log lines; `open`
    /// is the caller's flag for "the transport is still there", which the hub only
    /// reads. Everything the hub writes goes out through `outbound`.
    ///
    /// Spawns the `hello` deadline, so this has to be called inside a tokio runtime
    /// — which both callers (the accept loop in `main.rs` and the tests) are.
    pub fn handle_connection(
        self: &Arc<Self>,
        outbound: OutboundSender,
        open: Arc<AtomicBool>,
        peer: impl Into<String>,
    ) -> ConnectionId {
        let id = ConnectionId(self.next_connection_id.fetch_add(1, Ordering::SeqCst));
        let session = Session {
            id,
            connection: Connection {
                peer: peer.into(),
                outbound,
                open,
            },
            authenticated: false,
            next_request_id: 0,
            pending: HashMap::new(),
            hello_timer: None,
        };

        // Registered before the timer is armed: a timer that fired first would find
        // no session to close and the connection would outlive its deadline.
        self.lock().sessions.insert(id.0, session);
        let timer = spawn_hello_timer(Arc::downgrade(self), id, self.hello_timeout).abort_handle();
        if let Some(session) = self.lock().sessions.get_mut(&id.0) {
            session.hello_timer = Some(timer);
        }

        id
    }

    /// One frame from the peer. Before `hello` it is the handshake, after it a
    /// response — the same dispatch the template did on `authenticated`.
    pub fn on_message(self: &Arc<Self>, connection: ConnectionId, text: &str) {
        let authenticated = {
            let state = self.lock();
            let Some(session) = state.sessions.get(&connection.0) else {
                return;
            };
            // A message that raced with our own close frame is not worth a state
            // change or a log line.
            if !session.connection.is_open() {
                return;
            }
            session.authenticated
        };

        if authenticated {
            self.handle_response(connection, text);
        } else {
            self.handle_hello(connection, text);
        }
    }

    /// The transport is gone: the peer closed, the socket failed or the writer
    /// finished. Everything this session still had in flight fails now, and no
    /// timer of it may fire later.
    pub fn on_close(&self, connection: ConnectionId, info: &CloseInfo) {
        let authenticated = {
            let mut state = self.lock();
            let Some(mut session) = state.sessions.remove(&connection.0) else {
                return;
            };
            // Rejected before the timers are disarmed: an open request can never be
            // answered now, and waiting for a timer that is about to be cancelled
            // would leave its caller waiting forever.
            reject_all_pending(&mut session);
            clear_timers(&mut session);
            if state.current == Some(connection.0) {
                state.current = None;
            }
            session.authenticated
        };

        // Only authenticated sessions deserve a line: an unauthenticated socket that
        // timed out or failed auth already logged why it went away.
        if authenticated {
            self.log_line(&format!(
                "extension disconnected reason={}",
                describe_close(info)
            ));
        }
    }

    /// Asks the connected extension to run one request with `params`.
    ///
    /// Resolves with the `result` of the response and rejects with a
    /// [`HubRequestError`]. Callers own the rejection — the automatic request after
    /// the handshake throws its own away.
    pub async fn request(
        self: &Arc<Self>,
        method: &str,
        params: Value,
    ) -> Result<Value, HubRequestError> {
        let receiver = {
            let mut state = self.lock();
            let Some(current) = state.current else {
                return Err(HubRequestError::unavailable("no extension is connected"));
            };
            // A `current` without a session is a state this module cannot reach;
            // answering "unavailable" beats a panic on the operator's bridge.
            let Some(session) = state.sessions.get_mut(&current) else {
                return Err(HubRequestError::unavailable("no extension is connected"));
            };
            self.ask(session, method, params)
        };

        receiver
            .await
            .unwrap_or_else(|_| Err(HubRequestError::unavailable("the request went away")))
    }

    /// Thin wrapper: the automatic request after the handshake keeps its name.
    pub async fn request_status(self: &Arc<Self>) -> Result<Value, HubRequestError> {
        self.request(protocol::methods::STATUS, Value::Object(Map::new()))
            .await
    }

    /* ------------------------------------------------------------ handshake */

    fn handle_hello(self: &Arc<Self>, connection: ConnectionId, text: &str) {
        let Some(peer) = self.peer(connection) else {
            return;
        };

        let Some(hello) = parse_hello(text) else {
            self.log_line(&format!("protocol error peer={peer}"));
            self.close(connection, protocol::close::PROTOCOL_ERROR);
            return;
        };

        if !verify_token(&self.token, &hello.token) {
            self.log_line(&format!("auth failed peer={peer}"));
            self.close(connection, protocol::close::AUTH_FAILED);
            return;
        }

        self.accept(connection, hello.protocol.as_ref());
    }

    fn accept(self: &Arc<Self>, connection: ConnectionId, hello_protocol: Option<&Value>) {
        let (previous, peer) = {
            let mut state = self.lock();
            let previous = state.current;
            let peer = {
                let Some(session) = state.sessions.get_mut(&connection.0) else {
                    return;
                };
                // Timer hygiene: an armed hello timer would close a perfectly
                // healthy connection with 4408 a few seconds after `welcome`.
                if let Some(timer) = session.hello_timer.take() {
                    timer.abort();
                }
                session.authenticated = true;
                session.connection.peer.clone()
            };
            state.current = Some(connection.0);
            (previous, peer)
        };

        // Only the remembered connection is closed. Testing "is the newest one"
        // here instead would compare a session with itself and close the connection
        // that just arrived.
        if let Some(previous) = previous {
            if previous != connection.0 {
                self.close(ConnectionId(previous), protocol::close::REPLACED);
            }
        }

        self.log_line(&format!(
            "extension connected peer={peer} protocol={}",
            format_protocol(hello_protocol)
        ));
        self.send(connection, welcome_frame());

        // The automatic request is registered synchronously and only *awaited* in a
        // task: the template queued its frame before `handleConnection` returned,
        // and a spawned request that had not run yet would make "the first request
        // has id 1" a race. The rejection is thrown away — an unanswered automatic
        // request is normal operation, and a `?` here would take the process down.
        let mut state = self.lock();
        let Some(session) = state.sessions.get_mut(&connection.0) else {
            return;
        };
        let receiver = self.ask(session, protocol::methods::STATUS, Value::Object(Map::new()));
        drop(state);
        tokio::spawn(async move {
            let _ = receiver.await;
        });
    }

    /* ------------------------------------------------------------- requests */

    /// Sends one request and hands back the receiver its answer will arrive on.
    ///
    /// Called with the state lock held: registering the pending entry and writing
    /// the frame have to happen in that order and without a gap, exactly like the
    /// template's synchronous `pending.set` + `send`.
    fn ask(
        self: &Arc<Self>,
        session: &mut Session,
        method: &str,
        params: Value,
    ) -> oneshot::Receiver<Result<Value, HubRequestError>> {
        session.next_request_id += 1;
        let id = session.next_request_id;

        let (responder, receiver) = oneshot::channel();
        let timer = spawn_call_timer(Arc::downgrade(self), session.id, id, self.call_timeout)
            .abort_handle();
        session.pending.insert(
            id,
            Pending {
                method: method.to_string(),
                params: params.clone(),
                timer,
                responder: Some(responder),
            },
        );

        if !session.connection.send(request_frame(id, method, &params)) {
            // A socket that closed between the open check and this write can never
            // answer; saying so now beats waiting out the timer.
            if let Some(mut entry) = session.pending.remove(&id) {
                entry.timer.abort();
                if let Some(responder) = entry.responder.take() {
                    let _ = responder.send(Err(HubRequestError::unavailable(
                        "the request could not be sent",
                    )));
                }
            }
        }

        receiver
    }

    /// Removes a pending request and disarms its timer, and hands back the peer of
    /// the same session. Every settlement path goes through here, so no request
    /// settles twice and no timer outlives its request.
    ///
    /// The peer rides along because it is read from the same lock as the entry: taken
    /// in a second lock, a session that disappeared in the gap would produce a line
    /// ending in `peer=` — a line the template never writes.
    fn take_pending(&self, connection: ConnectionId, id: u64) -> Option<(Pending, String)> {
        let mut state = self.lock();
        let session = state.sessions.get_mut(&connection.0)?;
        let peer = session.connection.peer.clone();
        let entry = session.pending.remove(&id)?;
        entry.timer.abort();
        Some((entry, peer))
    }

    fn on_call_timeout(self: &Arc<Self>, connection: ConnectionId, id: u64) {
        // Already answered, or already rejected by the close handler. A timer that
        // outlived its request must not settle twice or log a ghost line.
        let Some((entry, peer)) = self.take_pending(connection, id) else {
            return;
        };
        let Some(responder) = entry.responder else {
            return;
        };

        // The connection stays open: a slow answer is not a broken peer, and the
        // extension keeps its live socket for the next request. The line is named
        // after the method, so `status timeout` keeps reading exactly as before.
        self.log_line(&format!("{} timeout peer={peer}", entry.method));
        let _ = responder.send(Err(HubRequestError::timeout(format!(
            "no {} answer within {} ms",
            entry.method, self.call_timeout_ms
        ))));
    }

    fn handle_hello_timeout(self: &Arc<Self>, connection: ConnectionId) {
        let mut state = self.lock();
        let Some(session) = state.sessions.get_mut(&connection.0) else {
            return;
        };
        // Disarm the field first: the template nulls it, and a stale handle in the
        // session would be aborted again by `clear_timers` for no reason.
        session.hello_timer = None;
        // A `hello` that arrived in the same tick as the deadline is a healthy
        // connection: `accept` aborts this handle, but tokio cannot cancel a task that
        // is already being polled, so the check has to be here as well. Node is immune
        // for the same reason it needs no such check — `clearTimeout` on an expired
        // timer is simply too late to matter, and the callback never runs.
        if session.authenticated {
            return;
        }
        session
            .connection
            .close(protocol::close::HELLO_TIMEOUT, "");
    }

    fn handle_response(self: &Arc<Self>, connection: ConnectionId, text: &str) {
        let Some(message) = parse_json_object(text) else {
            return;
        };
        // Anything that is not a response to a request we know is dropped. Only the
        // first message has a spec-defined failure mode; inventing a second close
        // path here would close connections for no documented reason.
        if text_of(message.get("type")) != Some(protocol::types::RESPONSE) {
            return;
        }

        // A response for a request that already timed out or went away is dropped
        // without a line (`docs/05`: "eine danach eintreffende Antwort verwirft
        // `#takePending` ohne Geisterzeile"). It cannot settle anything any more,
        // and nothing is waiting for it.
        let Some(id) = message.get("id").and_then(whole_number) else {
            return;
        };
        let Some((entry, peer)) = self.take_pending(connection, id) else {
            return;
        };
        let Some(responder) = entry.responder else {
            return;
        };

        if message.get("ok") == Some(&Value::Bool(true)) {
            let result = message.get("result").cloned().unwrap_or(Value::Null);
            self.report_result(&entry.method, &entry.params, &result);
            // Settled last, so the log lines of this answer are written before any
            // awaiting caller continues.
            let _ = responder.send(Ok(result));
            return;
        }

        let code = format_error_code(message.get("error"));
        // `ok:false` is a normal answer from a working extension, so the connection
        // stays; the code says what went wrong on that side.
        self.log_line(&format!("{} failed peer={peer} code={code}", entry.method));
        let _ = responder.send(Err(HubRequestError::extension(
            code,
            message.get("error").cloned(),
        )));
    }

    /* -------------------------------------------------------------- reports */

    /// One line per successful request — not just for `status`: a navigation is the
    /// only action the agent takes in the operator's browser, and without a line
    /// there is no proof of it beyond the tab itself.
    fn report_result(&self, method: &str, params: &Value, result: &Value) {
        // `return` after every arm is load-bearing: a branch that falls through is
        // how spec 08 once lost an increment, and a method this table does not name
        // writes *nothing at all*.
        if method == protocol::methods::STATUS {
            self.report_status(result);
        } else if method == protocol::methods::NAVIGATE {
            self.log_line(&format_navigate_line(result));
            self.log_debug_block(protocol::methods::NAVIGATE, result);
        } else if method == protocol::methods::READ {
            self.log_line(&format_read_line(result));
            self.log_debug_block(protocol::methods::READ, result);
        } else if method == protocol::methods::CLICK {
            // `click` is the one method whose proof line needs the request: the
            // selector lives in `params`, not in the result.
            self.log_line(&format_click_line(params, result));
            self.log_debug_block(protocol::methods::CLICK, result);
        } else if method == protocol::methods::TYPE {
            self.log_line(&format_type_line(params, result));
            self.log_debug_block(protocol::methods::TYPE, result);
        } else if method == protocol::methods::FOCUS {
            self.log_line(&format_focus_line(result));
            self.log_debug_block(protocol::methods::FOCUS, result);
        } else if method == protocol::methods::INSPECT {
            // Like `click`: the two filters live in `params`, not in the result.
            self.log_line(&format_inspect_line(params, result));
            self.log_debug_block(protocol::methods::INSPECT, result);
        } else if method == protocol::methods::OPEN_TAB {
            // No debug block: the result carries the new tab's *title*, page content
            // the line above leaves out on purpose.
            self.log_line(&format_open_tab_line(result));
        } else if method == protocol::methods::CLOSE_TAB {
            // Mandatory, not decoration: `report_result` writes nothing for a method
            // it does not know, so a missing branch would make `close_tab`
            // invisible in the operator's terminal.
            self.log_line(&format_close_tab_line(result));
        } else if method == protocol::methods::EVAL {
            // No block: the result is whatever the code produced — page content, a
            // cookie, a token. Tab id, runtime and state are the whole line.
            self.log_line(&format_eval_line(result));
        } else if method == protocol::methods::SCREENSHOT {
            // Again: no block, because a base64 string *is* the picture and
            // `BC_LOG=debug` must not turn the journal into an image store.
            self.log_line(&format_screenshot_line(result));
        }
    }

    fn report_status(&self, result: &Value) {
        self.log_line(&format_status_line(result));
        self.log_debug_block(protocol::methods::STATUS, result);
        if let Some(on_status) = &self.on_status {
            on_status(result);
        }
    }

    /// The one gate between `log_level` and a debug block.
    ///
    /// The level is read once, here, and the block itself comes from the whitelist:
    /// a method without a table entry yields `None` and writes nothing, which is how
    /// the five silent methods stay silent without a second decision in a branch.
    fn log_debug_block(&self, method: &str, result: &Value) {
        if self.log_level != Level::Debug {
            return;
        }
        if let Some(block) = debug_block_of(method, result) {
            self.log_line(&block);
        }
    }

    /* -------------------------------------------------------------- helpers */

    fn lock(&self) -> MutexGuard<'_, State> {
        // A panic in a task that held the lock must not turn the whole bridge into
        // a mutex-poisoning exercise: the state is a plain map, and continuing is
        // what the operator's browser needs.
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn log_line(&self, message: &str) {
        (self.log)(message);
    }

    fn peer(&self, connection: ConnectionId) -> Option<String> {
        self.lock()
            .sessions
            .get(&connection.0)
            .map(|session| session.connection.peer.clone())
    }

    fn send(&self, connection: ConnectionId, text: String) {
        if let Some(session) = self.lock().sessions.get(&connection.0) {
            session.connection.send(text);
        }
    }

    fn close(&self, connection: ConnectionId, code: u16) {
        if let Some(session) = self.lock().sessions.get(&connection.0) {
            session.connection.close(code, "");
        }
    }
}

/* ------------------------------------------------------------------ timers */

fn spawn_hello_timer(
    hub: Weak<Hub>,
    connection: ConnectionId,
    after: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(after).await;
        // The hub may be gone (process shutdown); a deadline nobody owns is not an
        // error.
        if let Some(hub) = hub.upgrade() {
            hub.handle_hello_timeout(connection);
        }
    })
}

fn spawn_call_timer(
    hub: Weak<Hub>,
    connection: ConnectionId,
    id: u64,
    after: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(after).await;
        if let Some(hub) = hub.upgrade() {
            hub.on_call_timeout(connection, id);
        }
    })
}

fn reject_all_pending(session: &mut Session) {
    // One shared error value for all of them: they carry no per-request detail worth
    // duplicating.
    let error = HubRequestError::unavailable("the extension connection went away");
    for (_, mut entry) in session.pending.drain() {
        entry.timer.abort();
        if let Some(responder) = entry.responder.take() {
            let _ = responder.send(Err(error.clone()));
        }
    }
}

/// Aborts the one timer `reject_all_pending` does not own.
///
/// It drains `pending` itself — including the `timer.abort()` of every entry — so a
/// second loop over the same map would be dead code; what is left for this function
/// is the hello timer.
fn clear_timers(session: &mut Session) {
    if let Some(timer) = session.hello_timer.take() {
        timer.abort();
    }
}

/* ------------------------------------------------------------------ frames */

/// `{"type":"welcome","protocol":1,"bridgeVersion":"0.1.0"}`.
///
/// The one frame no artefact and no Node case pins, which is why `tests/hub.rs`
/// does: a `welcome` the extension cannot read is a connection that never starts
/// working, and nothing else would notice the field names drifting.
fn welcome_frame() -> String {
    let mut frame = Map::new();
    frame.insert(
        "type".to_string(),
        Value::String(protocol::types::WELCOME.to_string()),
    );
    frame.insert("protocol".to_string(), Value::from(protocol::VERSION));
    frame.insert(
        "bridgeVersion".to_string(),
        Value::String(BRIDGE_VERSION.to_string()),
    );
    Value::Object(frame).to_string()
}

/// `{"type":"request","id":7,"method":"read","params":{…}}`, in the template's key
/// order.
fn request_frame(id: u64, method: &str, params: &Value) -> String {
    let mut frame = Map::new();
    frame.insert(
        "type".to_string(),
        Value::String(protocol::types::REQUEST.to_string()),
    );
    frame.insert("id".to_string(), Value::from(id));
    frame.insert("method".to_string(), Value::String(method.to_string()));
    frame.insert("params".to_string(), params.clone());
    Value::Object(frame).to_string()
}

/* ------------------------------------------------------------ status line */

/// `status windows=2 tabs=14`, with the tab count summed over all windows.
///
/// Missing or malformed structures count as zero instead of failing: a broken result
/// must not take the connection down with it, and the log line is more useful than a
/// stack trace.
pub fn format_status_line(result: &Value) -> String {
    let windows = result
        .get("windows")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let tabs: usize = windows.iter().map(count_tabs).sum();
    format!("status windows={} tabs={tabs}", windows.len())
}

fn count_tabs(window: &Value) -> usize {
    window
        .get("tabs")
        .and_then(Value::as_array)
        .map_or(0, Vec::len)
}

/* -------------------------------------------------------------- log lines */

/// `navigate tab=42 url=https://example.org/ complete=true`.
///
/// Read as defensively as [`format_status_line`]: a navigation is the one action the
/// agent takes in the operator's browser, so its proof line has to survive a
/// malformed result rather than throw it away.
fn format_navigate_line(result: &Value) -> String {
    format!(
        "navigate tab={} url={} complete={}",
        number_field(result, "tabId"),
        string_field(result, "url"),
        flag_text(result, "complete"),
    )
}

/// `focus tab=42 window=1`.
///
/// Shorter than the `navigate` line on purpose: `focus` changes nothing the operator
/// could not see, and the only proof this line owes is *which* tab came forward, and
/// in which window. The `url` stays out even though the result carries one.
fn format_focus_line(result: &Value) -> String {
    format!(
        "focus tab={} window={}",
        number_field(result, "tabId"),
        number_field(result, "windowId"),
    )
}

/// `read tab=42 url=https://example.org/ chars=1234 truncated=false via=innerText`.
///
/// The page text never reaches this line: the operator's mailbox is not log
/// material. The character count is the whole proof — that something came back, and
/// how much.
fn format_read_line(result: &Value) -> String {
    format!(
        "read tab={} url={} chars={} truncated={} via={}",
        number_field(result, "tabId"),
        string_field(result, "url"),
        page_text_char_count(result),
        flag_text(result, "truncated"),
        text_source(result),
    )
}

/// The source name, whitelisted rather than echoed.
///
/// A whitelist keeps a broken or hostile extension from writing its own line endings
/// — and anything else — into the log: two names are the whole protocol,
/// everything else is one `?`.
fn text_source(result: &Value) -> &str {
    match text_of(result.get("via")) {
        Some(source) if TEXT_SOURCES.contains(&source) => source,
        _ => NO_FIELD,
    }
}

/// The only thing `read` may tell the log about the text: how long it was.
fn page_text_char_count(result: &Value) -> String {
    text_of(result.get("text")).map_or_else(|| NO_FIELD.to_string(), utf16_length_text)
}

/// `click selector=a#video-title-link tab=42 url=https://example.org/`.
///
/// The selector is the one field the log takes from the request instead of the
/// result: the extension answers with the element it clicked, but a rerender can
/// wipe that description away, and the selector is what the operator typed.
fn format_click_line(params: &Value, result: &Value) -> String {
    format!(
        "click selector={} tab={} url={}",
        single_line_selector(params.get("selector")),
        number_field(result, "tabId"),
        string_field(result, "url"),
    )
}

/// Collapses every line-break run into a single space, with `unset` standing in for
/// a value that is not a string.
///
/// Same reasoning as the `via` whitelist: an entry a value can split is an entry a
/// value can forge — a selector carrying `\n` could otherwise end the real line and
/// start a plausible-looking one of its own. The hole marker is a parameter because
/// the lines word their holes differently (`?` for the sub-results of
/// `click`/`type`, `-` for `inspect`'s filters) while the flattening rule has to
/// stay the same one.
fn single_line(value: Option<&Value>, unset: &str) -> String {
    match text_of(value) {
        Some(text) => collapse_line_breaks(text),
        None => unset.to_string(),
    }
}

fn single_line_selector(selector: Option<&Value>) -> String {
    single_line(selector, NO_FIELD)
}

/// JavaScript's `/[\r\n]+/g` with a single space: every maximal run of CR and LF
/// becomes one space, and the selector's own spaces beside it stay as typed.
fn collapse_line_breaks(text: &str) -> String {
    let mut collapsed = String::with_capacity(text.len());
    let mut in_break_run = false;
    for character in text.chars() {
        if character == '\r' || character == '\n' {
            in_break_run = true;
            continue;
        }
        if in_break_run {
            collapsed.push(' ');
            in_break_run = false;
        }
        collapsed.push(character);
    }
    if in_break_run {
        collapsed.push(' ');
    }
    collapsed
}

/// `type selector=input[name="q"] chars=15 submit=true tab=42 url=…`.
///
/// `chars` is the length of the text the agent *typed* — the request's `text`, not
/// the page text beside it. The text itself never appears: it may be a password.
/// `submit` is the intent from the request for the same reason the selector is.
fn format_type_line(params: &Value, result: &Value) -> String {
    format!(
        "type selector={} chars={} submit={} tab={} url={}",
        single_line_selector(params.get("selector")),
        typed_input_char_count(params),
        flag_text(params, "submit"),
        number_field(result, "tabId"),
        string_field(result, "url"),
    )
}

/// The length of the text that was typed. It lives in the request, not the result.
///
/// This method has two lengths — the input the agent asked for and the page text that
/// came back — and reading them swapped logs the page's length where the typed one
/// belongs.
fn typed_input_char_count(params: &Value) -> String {
    text_of(params.get("text")).map_or_else(|| NO_FIELD.to_string(), utf16_length_text)
}

/// `inspect selector=a#cart-link text=- found=1`.
///
/// Both filters come from the *request*: they are the caller's input, not page
/// content, and they stay raw here on purpose — the operator needs the exact filter
/// back to know what was asked.
fn format_inspect_line(params: &Value, result: &Value) -> String {
    format!(
        "inspect selector={} text={} found={}",
        single_line(params.get("selector"), UNSET_INSPECT_FIELD),
        single_line(params.get("text"), UNSET_INSPECT_FIELD),
        inspect_count(result),
    )
}

/// The number of hits the page had, not the number of delivered elements.
fn inspect_count(result: &Value) -> String {
    result
        .get("count")
        .and_then(integer_text)
        .unwrap_or_else(|| UNSET_INSPECT_FIELD.to_string())
}

/// `open tab=42 url=https://example.org/`. Neither field is the title: what this line
/// owes the operator is the proof that a tab came into being, not what it displays.
fn format_open_tab_line(result: &Value) -> String {
    format!(
        "open tab={} url={}",
        number_field(result, "tabId"),
        string_field(result, "url"),
    )
}

/// `close tab=42`. The id comes from the *result*, never from the request: a
/// `close_tab` without a `tab` closes the last used one, so the caller needs to know
/// *which* tab went away.
fn format_close_tab_line(result: &Value) -> String {
    format!("close tab={}", number_field(result, "tabId"))
}

/// `eval tab=18 elapsedMs=4 ok=true`.
///
/// `ok` is the literal `true`, not a field: this branch runs for an answer that said
/// `ok:true`, and the result carries no `ok` of its own — printing it would log `?`
/// on every successful call.
fn format_eval_line(result: &Value) -> String {
    format!(
        "eval tab={} elapsedMs={} ok=true",
        number_field(result, "tabId"),
        number_field(result, "elapsedMs"),
    )
}

/// `screenshot tab=4 bytes=214311 format=jpeg scaled=true ok=true`.
///
/// The picture itself is the one thing this line must never carry. `scaled` on the
/// other hand *is* a field, and `false` is a fact — a missing value stays `?`
/// instead of being folded into the boolean it most resembles.
fn format_screenshot_line(result: &Value) -> String {
    let scaled = match result.get("scaled") {
        Some(Value::Bool(scaled)) => scaled.to_string(),
        _ => NO_FIELD.to_string(),
    };
    format!(
        "screenshot tab={} bytes={} format={} scaled={scaled} ok=true",
        number_field(result, "tabId"),
        number_field(result, "bytes"),
        string_field(result, "format"),
    )
}

/* ------------------------------------------------------------------ fields */

/// A field the log prints as a number: an integer as its digits, everything else —
/// a string included — as `?`.
///
/// The split from [`string_field`] is the template's `Number.isInteger`: a result
/// that sends `"42"` instead of `42` is a broken extension, and printing `42` for it
/// would hide the breakage behind a plausible line. One accessor for both types used
/// to do exactly that.
fn number_field(result: &Value, field: &str) -> String {
    result
        .get(field)
        .and_then(integer_text)
        .unwrap_or_else(|| NO_FIELD.to_string())
}

/// A field the log prints verbatim: a string as it arrived, everything else as `?`.
///
/// The value is not flattened here — that is [`single_line`]'s job for the fields a
/// page can fill. A `url` keeps its line breaks exactly as long as nothing posts a
/// header value with one; the log writer escapes them.
fn string_field(result: &Value, field: &str) -> String {
    text_of(result.get(field)).map_or_else(|| NO_FIELD.to_string(), str::to_string)
}

/// A boolean field as `true`/`false`; anything else is `false`, which is the value
/// the extension would have assumed anyway.
fn flag_text(result: &Value, field: &str) -> &'static str {
    if result.get(field) == Some(&Value::Bool(true)) {
        "true"
    } else {
        "false"
    }
}

fn text_of(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// JavaScript's `Number.isInteger` → `String(value)`: the digits of an integral
/// number, `None` for everything else.
///
/// The `f64` arm is not decoration: `JSON.parse("1.0")` is the integer `1` in
/// JavaScript, and `serde_json` keeps it as a float — a tab id written as `42.0` must
/// not turn into a hole in the line.
fn integer_text(value: &Value) -> Option<String> {
    if let Some(number) = value.as_i64() {
        return Some(number.to_string());
    }
    if let Some(number) = value.as_u64() {
        return Some(number.to_string());
    }
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0).then(|| format!("{number}"))
}

/// The same rule where an id is needed rather than printed: a whole, non-negative
/// number.
fn whole_number(value: &Value) -> Option<u64> {
    if let Some(number) = value.as_u64() {
        return Some(number);
    }
    let number = value.as_i64()?;
    (number >= 0).then_some(number as u64)
}

/// JavaScript's `String.prototype.length`: UTF-16 code units, not bytes and not
/// scalar values. A page text with an emoji in it is two units long there and four
/// bytes here, and the log line would silently disagree with the extension.
fn utf16_length(text: &str) -> usize {
    text.encode_utf16().count()
}

fn utf16_length_text(text: &str) -> String {
    utf16_length(text).to_string()
}

/* -------------------------------------------------------- debug whitelist */

/*
 * What may appear on stderr when `log_level` is `debug` is a whitelist, not a list
 * of redactions (spec 28).
 *
 * The block used to be built by seven report branches, four of which replaced a
 * field or two themselves while the other three printed whatever arrived — a
 * blacklist counts what somebody remembered to hide. Here the table below is the
 * only place that decides: a field it does not name prints a marker, never its
 * value and never its length (a length gives a short field away as well).
 */

/// How one field is printed.
#[derive(Clone, Copy)]
enum Rule {
    /// The field arrives exactly as the extension sent it.
    Full,
    /// A string becomes `<n chars>`, `null` stays `null`, anything else becomes
    /// [`UNLISTED`].
    Length,
    /// A list of strings, each entry through the [`Rule::Length`] rule.
    LengthEach,
    /// An object — or a list of objects — with known fields.
    Shape(&'static [(&'static str, Rule)]),
}

type FieldTable = &'static [(&'static str, Rule)];

const EXTENSION_FIELDS: FieldTable = &[("version", Rule::Full), ("connectedAt", Rule::Full)];

const TAB_FIELDS: FieldTable = &[
    ("id", Rule::Full),
    ("active", Rule::Full),
    ("pinned", Rule::Full),
    ("agent", Rule::Full),
    ("url", Rule::Full),
    ("title", Rule::Full),
];

const WINDOW_FIELDS: FieldTable = &[
    ("id", Rule::Full),
    ("focused", Rule::Full),
    ("type", Rule::Full),
    ("tabs", Rule::Shape(TAB_FIELDS)),
];

/// The whitelist, one entry per method that has a debug block, keyed by the
/// *protocol* method name: this module never sees the MCP tool name (`browser_read`).
///
/// Absent on purpose, and not an oversight in the direction reversal: `eval` (its
/// result is arbitrary page JSON, spec 19), `screenshot` (the base64 *is* the
/// picture, spec 20/21), `open_tab` and `close_tab` (the line is the whole report),
/// and `frames`, which has no report branch at all. `debug_block_of` returns `None`
/// for them — the one place where "unknown" writes nothing instead of a marker,
/// because an unknown *method* has no field that was ever judged safe.
const DEBUG_WHITELIST: &[(&str, FieldTable)] = &[
    (
        protocol::methods::STATUS,
        &[
            ("extension", Rule::Shape(EXTENSION_FIELDS)),
            ("windows", Rule::Shape(WINDOW_FIELDS)),
        ],
    ),
    (
        protocol::methods::NAVIGATE,
        &[
            ("tabId", Rule::Full),
            ("windowId", Rule::Full),
            ("url", Rule::Full),
            ("title", Rule::Length),
            ("complete", Rule::Full),
            ("settled", Rule::Full),
            ("waitedMs", Rule::Full),
        ],
    ),
    (
        protocol::methods::READ,
        &[
            ("tabId", Rule::Full),
            ("url", Rule::Full),
            ("title", Rule::Length),
            ("text", Rule::Length),
            ("offset", Rule::Full),
            ("chars", Rule::Full),
            ("totalChars", Rule::Full),
            ("truncated", Rule::Full),
            ("via", Rule::Full),
            ("mode", Rule::Full),
            ("root", Rule::Full),
            ("fellBack", Rule::Full),
            // `readAgentTabPage` answers `{...page, ...settle}`, so the settle fields
            // come last.
            ("settled", Rule::Full),
            ("waitedMs", Rule::Full),
        ],
    ),
    (
        protocol::methods::CLICK,
        &[
            ("tabId", Rule::Full),
            ("url", Rule::Full),
            ("title", Rule::Length),
            ("clicked", Rule::Length),
            // Directly behind `clicked`, like the answer itself: `clickResult` places
            // the field there on purpose (`docs/56`), and a boolean needs no rule
            // beyond `full`.
            ("scrolled", Rule::Full),
            ("text", Rule::Length),
            ("truncated", Rule::Full),
            ("via", Rule::Full),
            ("settled", Rule::Full),
            ("waitedMs", Rule::Full),
        ],
    ),
    (
        protocol::methods::TYPE,
        &[
            ("tabId", Rule::Full),
            ("url", Rule::Full),
            ("title", Rule::Length),
            ("typed", Rule::Length),
            ("submitted", Rule::Full),
            ("text", Rule::Length),
            ("truncated", Rule::Full),
            ("via", Rule::Full),
        ],
    ),
    (
        protocol::methods::FOCUS,
        &[
            ("tabId", Rule::Full),
            ("windowId", Rule::Full),
            ("url", Rule::Full),
            ("title", Rule::Length),
            ("active", Rule::Full),
            ("focused", Rule::Full),
        ],
    ),
    (
        protocol::methods::INSPECT,
        &[
            ("tabId", Rule::Full),
            ("url", Rule::Full),
            ("title", Rule::Length),
            ("count", Rule::Full),
            ("truncated", Rule::Full),
            ("elements", Rule::Shape(ELEMENT_FIELDS)),
        ],
    ),
];

const ELEMENT_FIELDS: FieldTable = &[
    ("index", Rule::Full),
    ("selector", Rule::Length),
    ("tag", Rule::Full),
    ("id", Rule::Length),
    ("classes", Rule::LengthEach),
    ("text", Rule::Length),
    ("href", Rule::Length),
    ("ariaLabel", Rule::Length),
    ("visible", Rule::Full),
    // Behind `visible`, before `disabled` — the order both copies of `described`
    // build the element in (`docs/62`). A boolean, so no rule beyond `full`.
    ("offscreen", Rule::Full),
    ("disabled", Rule::Full),
    (
        "rect",
        Rule::Shape(&[
            ("x", Rule::Full),
            ("y", Rule::Full),
            ("width", Rule::Full),
            ("height", Rule::Full),
        ]),
    ),
];

/// The finished debug block of one result, or `None` when the method has no entry.
///
/// Text, not a [`Value`], because every caller hands it to the injected log writer
/// unchanged — and one serialisation is what keeps a smuggled `\n` inside a value an
/// escaped `\\n` instead of a forged second log line.
pub fn debug_block_of(method: &str, result: &Value) -> Option<String> {
    // `None` means "write nothing", not "empty block": see the table's comment. The
    // template's `Object.hasOwn` guard has no analogue here — a table lookup cannot
    // reach `Object.prototype`, so `"constructor"` is simply not in it.
    let fields = DEBUG_WHITELIST
        .iter()
        .find(|(name, _)| *name == method)
        .map(|(_, fields)| *fields)?;
    Some(
        serde_json::to_string_pretty(&project(result, fields))
            // Every `Value` has a JSON form, and this one is a `Value` this module
            // built itself: a failure here is a bug in `project`, not input. A silent
            // empty line would turn that bug into a missing debug block on the
            // operator's terminal, where nobody could see it.
            .expect("a Value built by `project` always serialises"),
    )
}

/// The result cut down to the whitelisted fields, in table order.
///
/// Table order rather than result order, so the same method reads the same way on
/// every answer. Fields the result carries but nobody listed come last, each with its
/// key and the marker. Listed fields it does not carry are simply absent: the block
/// must not invent a `null` for a field the extension never sent.
fn project(result: &Value, whitelist: FieldTable) -> Value {
    // Only a mapping can be projected. Anything else — a list, a scalar, `null` — is
    // printed as it arrived; reshaping it would mean inventing rules for content
    // nobody whitelisted. A known gap, pinned by a case rather than approved
    // (spec 28, `## Bekannte Lücken`).
    let Value::Object(fields) = result else {
        return result.clone();
    };

    let mut projected = Map::new();
    for (field, rule) in whitelist {
        if let Some(value) = fields.get(*field) {
            projected.insert(field.to_string(), apply_rule(value, rule));
        }
    }
    for (field, _) in fields {
        if whitelist.iter().any(|(name, _)| name == field) {
            continue;
        }
        projected.insert(field.clone(), Value::String(UNLISTED.to_string()));
    }
    Value::Object(projected)
}

fn apply_rule(value: &Value, rule: &Rule) -> Value {
    match rule {
        Rule::Full => value.clone(),
        Rule::Length => length_of(value),
        Rule::LengthEach => lengths_of(value),
        Rule::Shape(fields) => project_nested(value, fields),
    }
}

fn length_of(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(format!("<{} chars>", utf16_length(text))),
        // `null` is a statement worth keeping (`"ariaLabel": null` means "no label"),
        // every other non-string is content of a kind the table did not judge.
        Value::Null => Value::Null,
        _ => Value::String(UNLISTED.to_string()),
    }
}

fn lengths_of(value: &Value) -> Value {
    // Not a list: nothing here says how to shorten it, so it prints the marker.
    match value {
        Value::Array(entries) => Value::Array(entries.iter().map(length_of).collect()),
        _ => Value::String(UNLISTED.to_string()),
    }
}

/// A `shape` field: one object with these fields, or a list of them, field by field.
fn project_nested(value: &Value, fields: FieldTable) -> Value {
    fn project_element(entry: &Value, fields: FieldTable) -> Value {
        match entry {
            Value::Object(_) => project(entry, fields),
            _ => Value::String(UNLISTED.to_string()),
        }
    }

    match value {
        Value::Array(entries) => Value::Array(
            entries
                .iter()
                .map(|entry| project_element(entry, fields))
                .collect(),
        ),
        other => project_element(other, fields),
    }
}

/* ------------------------------------------------------------- token compare */

/// Constant-time token comparison.
///
/// Both sides are hashed first, so the compare always sees two 32-byte values — a
/// compare of unequal lengths bails out at the first byte and leaks exactly the
/// information a constant-time compare is there to hide. The length check in front
/// is still worth its line: it rejects an obviously wrong candidate without hashing
/// anything.
///
/// The template's `typeof candidate !== "string"` guard has no analogue here: the only
/// caller reads the token out of a parsed `hello`, so a non-string never reaches this
/// function. A "broken" candidate is a short, long or wrong one, and both are `false`
/// without a panic.
pub fn verify_token(expected: &str, candidate: &str) -> bool {
    if utf16_length(candidate) != utf16_length(expected) {
        return false;
    }
    let expected_hash = sha256(expected);
    let candidate_hash = sha256(candidate);
    expected_hash[..].ct_eq(&candidate_hash[..]).into()
}

fn sha256(value: &str) -> [u8; 32] {
    let digest = Sha256::digest(value.as_bytes());
    let mut bytes = [0_u8; 32];
    bytes.copy_from_slice(&digest);
    bytes
}

/* -------------------------------------------------------------------- hello */

/// The parts of a `hello` the hub reads.
struct Hello {
    /// Deliberately not validated: rejecting an extension that reports a newer
    /// protocol version would lock out the operator's own reload. It is logged, so a
    /// mismatch stays visible.
    protocol: Option<Value>,
    token: String,
}

/// Returns the hello message, or `None` when the first message is not one.
///
/// Only what the spec names is checked: JSON object, `type`, non-empty string
/// `token`. The browser metadata is not read at all.
fn parse_hello(text: &str) -> Option<Hello> {
    let message = parse_json_object(text)?;
    if text_of(message.get("type")) != Some(protocol::types::HELLO) {
        return None;
    }
    let token = text_of(message.get("token"))?;
    if token.is_empty() {
        return None;
    }
    Some(Hello {
        protocol: message.get("protocol").cloned(),
        token: token.to_string(),
    })
}

fn parse_json_object(text: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(message)) => Some(message),
        // A scalar, a list, `null` or invalid JSON: all four are "not a message",
        // and the template folded them into one `null` for the same reason.
        _ => None,
    }
}

/// `Number.isInteger(value) ? String(value) : "unknown"`.
fn format_protocol(value: Option<&Value>) -> String {
    value
        .and_then(integer_text)
        .unwrap_or_else(|| "unknown".to_string())
}

/// `reason` is the peer's close phrase when it sent one; the numeric code carries
/// the meaning, so it always comes first.
fn describe_close(info: &CloseInfo) -> String {
    if info.reason.is_empty() {
        info.code.to_string()
    } else {
        format!("{} {}", info.code, info.reason)
    }
}

fn format_error_code(error: Option<&Value>) -> String {
    match error.and_then(|error| error.get("code")).and_then(Value::as_str) {
        Some(code) if !code.is_empty() => code.to_string(),
        _ => NO_ERROR_CODE.to_string(),
    }
}
