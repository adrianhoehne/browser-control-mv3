//! Entry point of the bridge: read configuration, refuse to start without a
//! usable token, bind the extension listener, serve the hub on every accepted
//! connection, serve MCP on stdin/stdout — unless stdin is a console — and stop cleanly
//! on SIGTERM/SIGINT. Windows has no SIGTERM at all and two console gestures instead:
//! Ctrl+C (`received SIGINT`) and Ctrl+Break (`received SIGBREAK`).
//!
//! Stages 2a (`docs/38`) and 2b gave this file its configuration, its listener and
//! the WebSocket codec; 2c added the socket glue for the hub — the per-connection
//! read/write loop, the HTTP head reader and the answers for a request that is not a
//! handshake. That glue lives in `link.rs` and `head.rs`, not here: a start path the
//! integration tests cannot see is a start path nothing measures, which is how a
//! swallowed `hello` and a `400` where a `426` belongs stayed invisible. 2d adds the
//! tool layer and wires the stdio loop in here; 2e adds the second surface, `/mcp` over
//! HTTP, behind the `--http` flag. Stage 3 (`docs/38`) adds no new path in this file: the
//! two Windows answers live in `platform/windows.rs` and `stdio.rs`, and what is here is
//! the one line that is genuinely platform-specific — the signal. What stays in this file
//! is the start itself — configuration, bind, accept loop, signals, exit codes.
//!
//! stdout is the JSON-RPC channel and nothing else: every line this file writes
//! goes to stderr through `log::log_line`.
//!
//! The two exit codes of the service are deliberate: `1` for a start that failed
//! (a port that could not be bound among them — systemd restarts, which is the
//! point), `2` for a missing or too short token file (no restart heals that, which
//! is what `RestartPreventExitStatus=2` in the unit is for).

use std::sync::Arc;
use std::time::Duration;

use tokio::io::BufReader;
use tokio::net::TcpListener;

use browser_control_bridge::config;
use browser_control_bridge::http;
use browser_control_bridge::hub::Hub;
use browser_control_bridge::link;
use browser_control_bridge::log;
use browser_control_bridge::mcp::{self, ToolContext};
use browser_control_bridge::platform;
use browser_control_bridge::stdio;

const EXIT_OK: i32 = 0;
const EXIT_FAILURE: i32 = 1;
const EXIT_CONFIGURATION: i32 = 2;

/// The flag that adds the second surface. A plain argument like `argv.includes("--http")`
/// in the template, so its position among the arguments does not matter.
const HTTP_FLAG: &str = "--http";

#[tokio::main]
async fn main() {
    std::process::exit(run().await);
}

async fn run() -> i32 {
    silence_panic_reports();

    let env = config::process_env();
    let configuration = config::load_config(&env);
    let address = log::format_address(&configuration.host, configuration.port);
    let token_file = config::token_path(&env);

    // Read before anything binds: a bridge without a token would sit on the port
    // refusing every extension, and exit 2 is what the unit's
    // `RestartPreventExitStatus=2` is written for.
    let token = match config::read_token(&token_file) {
        Ok(Some(token)) => token,
        Ok(None) => {
            log::log_line(&format!(
                "token file missing or too short: {}",
                token_file.display()
            ));
            return EXIT_CONFIGURATION;
        }
        Err(error) => {
            log::log_line(&format!("bridge failed: {error}"));
            return EXIT_FAILURE;
        }
    };

    // Installed before the bind, like `bridge.mjs` does it: a signal during startup
    // must exit 0 through the same path a signal during work does, instead of dying
    // with the default signal status.
    let mut signals = match stop::Signals::register() {
        Ok(signals) => signals,
        Err(error) => {
            log::log_line(&format!("bridge failed: {error}"));
            return EXIT_FAILURE;
        }
    };

    // A tuple, not a formatted `host:port`: the resolver wants the bare IPv6
    // literal, and `::1:8110` would be an address nobody asked for.
    let listener = match TcpListener::bind((configuration.host.as_str(), configuration.port)).await {
        Ok(listener) => listener,
        Err(error) => {
            log_bind_failure("listener", &address, configuration.port, &error);
            return EXIT_FAILURE;
        }
    };

    log::log_line(&format!(
        "listening on {address} log={}",
        configuration.log_level.as_str()
    ));

    // The one secret is needed twice from stage 2e on: the hub compares what the
    // extension says in its `hello`, the `/mcp` transport compares the bearer header. The
    // clone is the cheap half — a second hash is what `verify_token` avoids, not a second
    // copy of the token.
    let hub = Arc::new(Hub::new(&configuration, token.clone()));
    // The request head on this port is unauthenticated input, and the only deadline
    // the configuration has for unauthenticated input is the `hello` timeout. Reading
    // it once keeps both halves of "prove yourself within X" on the same number.
    let head_deadline = Duration::from_millis(configuration.hello_timeout_ms);

    // The stdio half runs beside the listener, in every mode: the tool layer and the hub
    // share this one process, and a request that waits for the extension must not stop
    // the listener from accepting the extension's next connection.
    let tool_context = Arc::new(ToolContext {
        hub: Arc::clone(&hub),
        log: Arc::new(|line: &str| log::log_line(line)),
    });
    // … but not in a console. `docs/30` is the reason: in the foreground run stdin is the
    // operator's keyboard, and the template answered the first keypress on the JSON-RPC
    // channel with a parse error. Every case that speaks stdio hands over a pipe, a
    // socketpair or `/dev/null` — pi's `command` spawn, the parity driver, systemd — and
    // all of them are "not a console", so the client path keeps its transport.
    let mut stdio = (!stdio::stdin_is_a_console()).then(|| {
        tokio::spawn(stdio::serve(
            BufReader::new(tokio::io::stdin()),
            tokio::io::stdout(),
            Arc::clone(&tool_context),
        ))
    });
    let mut stdio_ended = false;

    // The second surface, only on request. Bounded after stdio is up, for the reason the
    // template gives: a client that speaks first must not wait for a free port, and a
    // failing `/mcp` bind must not cost it the transport that already works.
    let mut http_transport = if wants_http() {
        match start_http(&configuration, &token, &tool_context).await {
            Ok(transport) => Some(transport),
            Err(()) => return EXIT_FAILURE,
        }
    } else {
        None
    };
    // Set once the accept loop has ended. Without it the branch would poll a finished
    // `JoinHandle` again on the next turn of the loop, which panics.
    let mut http_ended = false;

    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                // One task per connection: the accept loop must never wait for a
                // peer's handshake, and a browser that opens and abandons a socket
                // must not delay the next one.
                Ok((stream, peer_address)) => {
                    let hub = Arc::clone(&hub);
                    // The peer is the bare address, not `address:port`: the template
                    // logged `socket.remoteAddress`, and a port in this field would be
                    // a shape no Node line ever produced.
                    let peer = peer_address.ip().to_string();
                    tokio::spawn(async move {
                        let (reader, writer) = stream.into_split();
                        link::serve_connection(hub, reader, writer, peer, head_deadline).await;
                    });
                }
                // A connection aborted between the SYN and our accept is not an error:
                // Node ignores `ECONNABORTED` silently, and a line per aborted
                // handshake would be a log flood from any port scan.
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionAborted => {}
                // Everything else leaves a listener that cannot listen. `EMFILE` used
                // to spin here forever, writing the same failure as fast as the CPU
                // allowed; the template logs once and ends with 1, and 1 is what the
                // unit restarts for.
                Err(error) => {
                    log::log_line(&format!(
                        "listener failed on {address}: {}",
                        log::error_code(&error)
                    ));
                    return EXIT_FAILURE;
                }
            },
            signal = signals.next() => {
                log::log_line(&format!("{signal}, shutting down"));
                return EXIT_OK;
            }
            // `/mcp` stopped accepting. The extension listener ends the process the same
            // way when it fails, and for the same reason: a bridge that answers one
            // surface and not the other looks healthy in `systemctl status` while half of
            // it is dead. The `http_ended` flag keeps the branch from polling a finished
            // `JoinHandle` a second time; the guard's future is still built, so it must
            // not do anything until it is polled — that is what `join_transport` is for.
            http_result = join_transport(http_transport.as_mut()), if !http_ended => {
                http_ended = true;
                match http_result {
                    // A clean end means somebody closed the transport, which `main` never
                    // does; the extension listener keeps serving.
                    Ok(()) => {}
                    Err(_error) => return EXIT_FAILURE,
                }
            }
            // stdin ended. Whether that is a goodbye depends on what stdin *is*: a pipe or
            // a socketpair belongs to a client, `/dev/null` belongs to systemd — and a
            // service that ended on `/dev/null`'s EOF would restart in a loop.
            ended = join_stdio(stdio.as_mut()), if !stdio_ended => {
                stdio_ended = true;
                match ended {
                    Ok(Ok(())) => {
                        if stdio_is_a_shutdown_request() {
                            log::log_line("stdin closed, shutting down");
                            return EXIT_OK;
                        }
                    }
                    // A read that failed means the channel is unusable, not that the
                    // bridge failed: the extension listener keeps serving either way.
                    Ok(Err(error)) => log::log_line(&format!("mcp stdin failed: {error}")),
                    Err(error) => log::log_line(&format!("mcp task failed: {error}")),
                }
            }
        }
    }
}

/// Replaces the default panic report with one that writes nothing, once per process.
///
/// The `/mcp` transport answers a panic in the tool layer with `500`, `Connection: close`
/// and the single line `http request failed, answering 500` (`http.rs`). The default hook
/// would put a multi-line, timestamp-less `panicked at …` block on the same stderr stream
/// next to that line. stderr is journald here, and every line the operability tooling reads
/// has the `toISOString() …` shape `log::log_line` writes — a stack trace with no timestamp
/// breaks that shape and adds a second, louder report for a failure that is already
/// answered. The template's `.catch(() => …)` threw its error away in the same spirit, minus
/// the trace. So the payload is dropped: the `500` and its one line are the trace.
///
/// Set in the binary and not in the library on purpose: a hook that hides panics belongs to
/// the process that answers requests, not to the code `cargo test` measures. Under
/// `cargo test` the default hook stays, and a bug in the library keeps failing the suite
/// loudly instead of becoming a passing test with a silent `500`.
fn silence_panic_reports() {
    // Idempotent and cheap to call again, because the hook is process-wide state: a second
    // install would replace the first and nobody could tell which one is live.
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        std::panic::set_hook(Box::new(|_payload| {}));
    });
}

/// True when the stop request is `--http`.
fn wants_http() -> bool {
    std::env::args().any(|argument| argument == HTTP_FLAG)
}

/// Waits for the `/mcp` accept loop, and never resolves when the bridge was started without
/// one.
///
/// `tokio::select!` builds every branch future even when its guard says no, so the absent
/// case has to be a future that says nothing instead of an `expect` that panics. Written as
/// a function because the `pending()` arm needs the return type spelled out once.
async fn join_transport(transport: Option<&mut http::Transport>) -> std::io::Result<()> {
    match transport {
        Some(transport) => transport.joined().await,
        None => std::future::pending().await,
    }
}

/// Waits for the stdio task, and never resolves on a console — where there is no such task.
///
/// The same shape as [`join_transport`], for the same reason: a branch whose subject was
/// never started needs a future that says nothing, not an `expect` that turns a quiet
/// console into a panic.
async fn join_stdio(
    stdio: Option<&mut tokio::task::JoinHandle<std::io::Result<()>>>,
) -> Result<std::io::Result<()>, tokio::task::JoinError> {
    match stdio {
        Some(stdio) => stdio.await,
        None => std::future::pending().await,
    }
}

/// Binds `/mcp` and logs the line `scripts/parity/expected/7-logs.txt` records.
///
/// `Err(())` is "the start is over": the bind failed and the owner line is already
/// written. A half-alive bridge — the extension served, `/mcp` not — is what the
/// template's `process.exit(1)` there is written against.
async fn start_http(
    configuration: &config::Config,
    token: &str,
    tool_context: &Arc<ToolContext>,
) -> Result<http::Transport, ()> {
    let address = log::format_address(http::DEFAULT_HOST, configuration.http_port);
    let tool_set = Arc::new(http::ToolSet::new({
        let tool_context = Arc::clone(tool_context);
        move |text: String| {
            let tool_context = Arc::clone(&tool_context);
            async move { Ok(mcp::handle_message_text(&text, &tool_context).await) }
        }
    }));
    let log_sink = Arc::new(|line: &str| log::log_line(line));

    match http::start(configuration.http_port, token, tool_set, log_sink).await {
        Ok(transport) => {
            log::log_line(&format!(
                "listening on {} for POST /mcp",
                log::format_address(&transport.host, transport.port)
            ));
            Ok(transport)
        }
        Err(error) => {
            log_bind_failure("http listener", &address, configuration.http_port, &error);
            Err(())
        }
    }
}

/// True when the end of stdin is the client saying goodbye.
///
/// Named here so the start path reads as a decision; the rule itself — which file type
/// descriptor 0 has, and why a pipe and a socketpair count but `/dev/null` does not —
/// lives in `stdio.rs`, next to the loop it belongs to.
fn stdio_is_a_shutdown_request() -> bool {
    stdio::stdin_is_client_channel()
}

/// The two lines a failed bind writes: what failed, and who owns the port.
///
/// The second line costs a `/proc` walk and only runs on a failed start, which is
/// exactly why it can afford to be helpful.
fn log_bind_failure(label: &str, address: &str, port: u16, error: &std::io::Error) {
    log::log_line(&format!(
        "{label} failed on {address}: {}",
        log::error_code(error)
    ));

    let owner = match platform::find_port_owner(port) {
        Some(owner) => format!("owner pid={} name={}", owner.pid, owner.name),
        None => "Besitzer nicht ermittelbar".to_string(),
    };
    log::log_line(&format!("port {address} in use, {owner}"));
}

/// The shutdown contract: SIGTERM and SIGINT are the only two ways this process is
/// asked to stop, and both end with 0 — the service is not failing, it is being
/// stopped.
#[cfg(unix)]
mod stop {
    use tokio::signal::unix::{signal, Signal, SignalKind};

    /// Both handlers, registered the moment this returns. Registering eagerly is
    /// the point: a signal that arrives while the listener binds must still end the
    /// process with 0.
    pub struct Signals {
        terminate: Signal,
        interrupt: Signal,
    }

    impl Signals {
        pub fn register() -> std::io::Result<Signals> {
            Ok(Signals {
                terminate: signal(SignalKind::terminate())?,
                interrupt: signal(SignalKind::interrupt())?,
            })
        }

        /// The reason `main` logs, spelled the way the Node bridge spells it.
        pub async fn next(&mut self) -> &'static str {
            tokio::select! {
                _ = self.terminate.recv() => "received SIGTERM",
                _ = self.interrupt.recv() => "received SIGINT",
            }
        }
    }
}

/// Windows has no SIGTERM, and Node never sees one there: `bridge/bridge.mjs:161`–`:162`
/// registers `SIGTERM` and `SIGINT`, and only the second one ever fires on a console. So
/// the line here is **`received SIGINT`** — the template's own spelling for the signal a
/// console produces most often — and not `received SIGTERM`, which would claim a signal the
/// platform does not have. `tokio::signal::ctrl_c()` is Ctrl+C, and it also fires when a
/// console window is closed.
///
/// **Ctrl+Break is wired up too** (`docs/30`, criterion 1): Windows produces `SIGBREAK` on
/// the second console gesture, and the operator asked for the same ordered end on both.
/// `docs/38`, stage 3 left it out to stay identical to the template, which handled no
/// `SIGBREAK`; that was a parity decision, and the parity yardstick runs on Linux and
/// cannot see either gesture. Both handlers log the same sentence and both end with 0 —
/// the exit path is one line of `main`, so nothing new can rot. What is *not* locally
/// measured is the keypress itself: it needs a real console window (Windows Terminal or
/// `cmd.exe`; in mintty no `SIGBREAK` arrives) and stays the operator's measurement.
#[cfg(not(unix))]
mod stop {
    /// The Ctrl+Break handler, on the one family of targets that has one. Everywhere else
    /// the signal does not exist, and a `cfg` in the field is cheaper than a second module
    /// for a target this tree never builds.
    #[cfg(windows)]
    use tokio::signal::windows::CtrlBreak;

    pub struct Signals {
        #[cfg(windows)]
        brk: CtrlBreak,
    }

    impl Signals {
        pub fn register() -> std::io::Result<Signals> {
            Ok(Signals {
                // Registered eagerly, like the unix twin: a `Ctrl+Break` during the bind
                // must end the process with 0 as well. `ctrl_c` needs no registration —
                // tokio installs it on first poll, and a signal cannot arrive before that
                // on a console anyway, because the process is the one holding the terminal.
                #[cfg(windows)]
                brk: tokio::signal::windows::ctrl_break()?,
            })
        }

        /// The reason `main` logs, spelled the way the environment spells it: the Node
        /// names, not "SIGINT" and "break".
        pub async fn next(&mut self) -> &'static str {
            #[cfg(windows)]
            let received = tokio::select! {
                _ = tokio::signal::ctrl_c() => "received SIGINT",
                _ = self.brk.recv() => "received SIGBREAK",
            };
            #[cfg(not(windows))]
            let received = {
                let _ = tokio::signal::ctrl_c().await;
                "received SIGINT"
            };
            received
        }
    }
}
