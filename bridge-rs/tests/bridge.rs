//! The life cycle of the real process: what the end of stdin means, and what it must not
//! mean.
//!
//! Stage 2f of `docs/38`. Twelve cases. The first three are the stdio contract, and each one
//! is a rule the service depends on:
//!
//! - a pipe that ends is a client saying goodbye: exit `0`, exactly one line
//!   `stdin closed, shutting down`, and nothing but JSON-RPC on stdout, without a fragment
//!   at the end;
//! - the same end with a live extension session — a socket, a `welcome`, the automatic
//!   `status` request the hub sends on its own — must not change that answer;
//! - stdin on `/dev/null`, which is exactly what `INSTALL.md` and the unit give the
//!   standalone service, is *not* a goodbye: the process keeps running, keeps listening and
//!   writes no shutdown line. Without that rule `Restart=on-failure` turns the service into
//!   a restart loop, which is the one failure a life-cycle bug can cause in production.
//!
//! The three names are the Node ones (`test/mcp.test.js`), so the mapping stays readable;
//! `docs/38`, `### What could go wrong` names the allow for the missing snake case.
//!
//! The remaining nine measure the *start* path, which `main.rs` owns and nothing else reaches:
//! the two exit codes the unit's `RestartPreventExitStatus=2` distinguishes (a token that is
//! missing, a token file that cannot be read), the two ports that can already be held (the
//! extension one and `/mcp`), the two signals, `--http` itself, the end of one extension
//! session, and an stdin that fails instead of ending. `--http` is the second surface and only
//! runs behind the flag, so a suite that never passes the flag leaves half of `main.rs`
//! unmeasured.
//!
//! **Ports.** `BC_BIND=127.0.0.1:0` is not usable here: `config::parse_bind` maps port `0`
//! to `8110` (the documented silent lie, ported and not fixed), and `8110` is the
//! operator's own bridge. So the number comes from a temporary bind — the kernel hands out
//! an ephemeral port, far above the 18110–18119 range `tests/common/mod.rs` reserves for
//! the Node suite — and that bind is closed before the child starts.
//!
//! **Cleanup is by PID.** Every child is killed through its own `Child` handle in `Drop`,
//! so a failing assertion still leaves no bridge behind. `pkill -f` is not an option
//! anywhere in this tree: the operator's service has the same command line
//! (`CONTRIBUTING.md`, "Clean up by PID, never by pattern").

#![allow(non_snake_case)]

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use browser_control_bridge::ws::opcode;

/// The binary Cargo built for this test file. A case that started `target/debug/…` by hand
/// would measure whatever happened to be lying there.
const BRIDGE_BINARY: &str = env!("CARGO_BIN_EXE_browser-control-bridge");

/// How long the child gets to end the process once stdin is closed. Generous on purpose: the
/// case is about the answer, not about speed, and a red case should mean "it never ended"
/// rather than "the machine was busy".
const EXIT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the child gets to report its listener. The token check and the bind come before
/// it, and both are local work.
const READY_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a `/dev/null` EOF gets to be acted upon. The Node template waits 300 ms; the EOF
/// is delivered with the first read, so this is a generous lower bound and not a measurement.
const IGNORED_STDIN_SETTLE: Duration = Duration::from_millis(300);

/// How long the fake extension waits for `welcome` and the automatic `status` request.
const WELCOME_TIMEOUT: Duration = Duration::from_secs(10);

/// One poll step. Ten milliseconds keeps the whole suite responsive without spinning a core.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// A single blocking socket operation may not hold the case past its own deadline.
const SOCKET_TIMEOUT: Duration = Duration::from_secs(1);

/// The exit codes `main.rs` promises, mirrored here because the binary's constants are private
/// to it. `1` is "a start that failed" (the unit restarts), `2` is "no usable token" (no
/// restart heals that).
const EXIT_OK: i32 = 0;
const EXIT_FAILURE: i32 = 1;
const EXIT_CONFIGURATION: i32 = 2;

/// The token, built at runtime instead of written as a literal: a 32-character hex string in
/// the tree would be a finding for the secret grep (`CONTRIBUTING.md`).
fn token() -> String {
    "ab".repeat(16)
}

/* --------------------------------------------------------------------- bridge */

/// Which stdin the child gets. The first two variants are the two contracts; the third is the
/// one channel that fails instead of ending.
#[derive(Clone, Copy)]
enum Stdin {
    /// A pipe: a client that speaks stdio, and whose EOF is a goodbye.
    Pipe,
    /// `/dev/null`: what the service gets under systemd, and what must never end it.
    Null,
    /// A directory: openable, and unreadable as a stream. The one stdin whose read *fails*
    /// instead of ending, which is the other arm of the stdio task — an unusable channel, not a
    /// client saying goodbye.
    #[cfg(unix)]
    Unreadable,
}

/// The child's environment and arguments.
///
/// [`Bridge::start`] is `Launch::new().spawn(stdin)` plus the wait for the listener line. A case
/// that judges a start which is meant to fail — or that needs `--http` — builds its own launch
/// and spawns without that wait, because there is no line to wait for.
struct Launch {
    directory: PathBuf,
    token_file: TokenFile,
    port: u16,
    http_port: Option<u16>,
    arguments: Vec<String>,
}

/// What sits at the child's token path. Three filesystem states, because the start path answers
/// each of them with a different exit code.
#[derive(Clone, Copy)]
enum TokenFile {
    /// A usable token, written before the spawn.
    Written,
    /// Nothing at all: the file does not exist.
    Missing,
    /// A directory where the file belongs. `read` fails with `EISDIR`, which is *not* the
    /// "missing" state and must not end with the configuration code.
    Directory,
}

impl Launch {
    /// The environment [`Bridge::start`] uses: a fresh token file, a free port, no arguments.
    fn new() -> Launch {
        Launch {
            directory: temporary_directory(),
            token_file: TokenFile::Written,
            port: free_port(),
            http_port: None,
            arguments: Vec::new(),
        }
    }

    /// Leaves the token path empty — the state `openssl rand -hex 32 > token` should prevent.
    fn without_token_file(mut self) -> Launch {
        self.token_file = TokenFile::Missing;
        // The directory name carries the PID, and a PID comes back eventually: without this
        // the case would find a token from an earlier run and wait out its whole timeout for
        // an exit that cannot come. Both removals are best effort — the path is usually empty,
        // and a leftover file or directory is exactly what has to go.
        let path = self.token_path();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&path);
        self
    }

    /// Puts a directory at the token path: readable name, unreadable file.
    fn with_a_directory_as_token_file(mut self) -> Launch {
        self.token_file = TokenFile::Directory;
        self
    }

    fn on_port(mut self, port: u16) -> Launch {
        self.port = port;
        self
    }

    /// Adds the `--http` flag and the port it has to bind.
    fn with_http(mut self, http_port: u16) -> Launch {
        self.http_port = Some(http_port);
        self.arguments.push("--http".to_string());
        self
    }

    fn token_path(&self) -> PathBuf {
        self.directory.join("token")
    }

    /// Starts the child and drains both pipes, without waiting for anything: a case about a
    /// failed start has no line to wait for, only an exit code to read.
    fn spawn(self, stdin: Stdin) -> Bridge {
        let token_file = self.token_path();
        match self.token_file {
            TokenFile::Written => {
                std::fs::write(&token_file, token()).expect("the token file could not be written");
            }
            TokenFile::Missing => {}
            TokenFile::Directory => {
                std::fs::create_dir(&token_file)
                    .expect("the directory at the token path could not be created");
            }
        }

        let mut command = Command::new(BRIDGE_BINARY);
        command
            .env("BC_BIND", format!("127.0.0.1:{}", self.port))
            .env("BC_TOKEN_FILE", &token_file)
            .env("BC_LOG", "info")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(http_port) = self.http_port {
            command.env("BC_HTTP_PORT", http_port.to_string());
        }
        command.args(&self.arguments);
        match stdin {
            Stdin::Pipe => command.stdin(Stdio::piped()),
            // `Stdio::null()` is `/dev/null`, not a pipe to nowhere: `stdin: "ignore"` in the
            // Node suite, and the file type the shutdown rule has to read as "not a client".
            Stdin::Null => command.stdin(Stdio::null()),
            // The system temp directory is the portable "open, but not readable as a stream":
            // every platform has one, and none of them lets a `read` on it return EOF.
            #[cfg(unix)]
            Stdin::Unreadable => {
                let directory = std::fs::File::open(std::env::temp_dir())
                    .expect("the temp directory could not be opened as stdin");
                command.stdin(Stdio::from(directory))
            }
        };

        let mut process = command.spawn().expect("the bridge binary could not be started");
        let stdout = Arc::new(Mutex::new(String::new()));
        let stderr = Arc::new(Mutex::new(String::new()));
        let mut readers = Vec::new();
        if let Some(pipe) = process.stdout.take() {
            readers.push(spawn_reader(pipe, Arc::clone(&stdout)));
        }
        if let Some(pipe) = process.stderr.take() {
            readers.push(spawn_reader(pipe, Arc::clone(&stderr)));
        }

        Bridge {
            stdin: process.stdin.take(),
            process,
            port: self.port,
            directory: self.directory,
            stdout,
            stderr,
            readers,
        }
    }
}

/// One running bridge, plus everything a case needs to judge it.
///
/// stdout and stderr are drained by their own threads from the first byte: the child blocks
/// on a full pipe otherwise, and the assertions read a stream that must not be truncated. The
/// lock is held for the append only, so the polling helpers below stay lock-free between
/// reads.
struct Bridge {
    process: Child,
    stdin: Option<ChildStdin>,
    port: u16,
    directory: PathBuf,
    stdout: Arc<Mutex<String>>,
    stderr: Arc<Mutex<String>>,
    readers: Vec<JoinHandle<()>>,
}

impl Bridge {
    fn start(stdin: Stdin) -> Bridge {
        let mut bridge = Launch::new().spawn(stdin);
        bridge.wait_for_listener();
        bridge
    }

    /// Sends one signal to this child.
    ///
    /// Through the POSIX `kill` utility: `std` has no way to signal another process and this
    /// tree takes no new dependency for a test. By PID from the handle we spawned, never by
    /// pattern — the operator's own bridge has the same command line.
    #[cfg(unix)]
    fn signal(&self, name: &str) {
        let status = Command::new("kill")
            .arg(format!("-{name}"))
            .arg(self.process.id().to_string())
            .status()
            .unwrap_or_else(|error| panic!("the kill utility could not be started: {error}"));
        assert!(
            status.success(),
            "`kill -{name} {}` was refused: {status:?}",
            self.process.id(),
        );
    }

    /// Waits for the line that proves *this* child bound *this* port.
    ///
    /// Matching the log line instead of a successful connect is what keeps the case honest: a
    /// connect would also succeed against a foreign bridge that happens to hold the number, and
    /// the case would then wait for a line its own child never writes.
    fn wait_for_listener(&mut self) {
        let bound = format!("listening on 127.0.0.1:{} log=", self.port);
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if self.stderr_text().contains(&bound) {
                return;
            }
            if !self.is_running() {
                panic!(
                    "the bridge exited before it listened on port {} — is the ephemeral port taken?\n\
                     --- bridge stderr ---\n{}",
                    self.port,
                    self.stderr_text(),
                );
            }
            if Instant::now() >= deadline {
                panic!(
                    "the bridge did not report port {} as listening within {} ms\n{}",
                    self.port,
                    READY_TIMEOUT.as_millis(),
                    self.stderr_text(),
                );
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn stdout_text(&self) -> String {
        self.stdout
            .lock()
            .expect("the stdout collector was poisoned")
            .clone()
    }

    fn stderr_text(&self) -> String {
        self.stderr
            .lock()
            .expect("the stderr collector was poisoned")
            .clone()
    }

    fn is_running(&mut self) -> bool {
        self.process
            .try_wait()
            .expect("the bridge could not be waited for")
            .is_none()
    }

    /// Writes one JSON-RPC message as one line — the only shape the stdio transport reads.
    fn send(&mut self, message: &Value) {
        let stdin = self
            .stdin
            .as_mut()
            .expect("the bridge was started without a stdin pipe");
        writeln!(stdin, "{message}").expect("the bridge's stdin refused a write");
        stdin.flush().expect("the bridge's stdin refused a flush");
    }

    /// Drops the write end. The child sees EOF — the client saying goodbye.
    fn close_stdin(&mut self) {
        self.stdin.take();
    }

    /// Waits for the process to be gone and returns its exit code, or panics with the stderr
    /// transcript when it outlives the deadline. `None` is "killed by a signal", which every
    /// case here would count as the failure it is.
    fn exit_within(&mut self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self
                .process
                .try_wait()
                .expect("the bridge could not be waited for")
            {
                // Both pipes are closed now, so the readers are one `read` away from done;
                // joining them is what makes the assertions below read the final transcript.
                self.drain_output();
                return status.code();
            }
            if Instant::now() >= deadline {
                panic!(
                    "the bridge was still running {} ms after the case expected it to end\n\
                     --- bridge stderr ---\n{}",
                    timeout.as_millis(),
                    self.stderr_text(),
                );
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn drain_output(&mut self) {
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }

    /// Polls stderr for a needle, reporting the transcript when it never arrives: "nothing
    /// arrived" is the least useful thing to know about a child process.
    fn wait_for_stderr(&mut self, needle: &str, description: &str) {
        let deadline = Instant::now() + WELCOME_TIMEOUT;
        loop {
            if self.stderr_text().contains(needle) {
                return;
            }
            if !self.is_running() {
                panic!(
                    "the bridge exited while waiting for {description}\n\
                     --- bridge stderr ---\n{}",
                    self.stderr_text(),
                );
            }
            if Instant::now() >= deadline {
                panic!(
                    "timed out after {} ms waiting for {description}\n\
                     --- bridge stderr ---\n{}\n--- bridge stdout ---\n{}",
                    WELCOME_TIMEOUT.as_millis(),
                    self.stderr_text(),
                    self.stdout_text(),
                );
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    /// Proof that a finished process left no message without its newline: the fragment behind
    /// the last newline is empty.
    ///
    /// An empty transcript has an empty fragment, which is what the template's
    /// `assertNoUnfinishedTail` says as well — the rule is "no fragment", not "some bytes".
    fn assert_no_unfinished_tail(&self) {
        let stdout = self.stdout_text();
        let tail = stdout.rsplit('\n').next().unwrap_or("");
        assert_eq!(
            tail, "",
            "stdout ended with a message that has no closing newline: {stdout:?}",
        );
    }

    /// Polls stdout for the answer with `id`. Searched by `id`, never by position.
    fn wait_for_answer(&mut self, id: i64, description: &str) {
        let deadline = Instant::now() + WELCOME_TIMEOUT;
        loop {
            if self.rpc_lines().iter().any(|message| message["id"] == json!(id)) {
                return;
            }
            if !self.is_running() {
                panic!(
                    "the bridge exited while waiting for {description}\n\
                     --- bridge stdout ---\n{}",
                    self.stdout_text(),
                );
            }
            if Instant::now() >= deadline {
                panic!(
                    "timed out after {} ms waiting for {description}\n\
                     --- bridge stdout ---\n{}",
                    WELCOME_TIMEOUT.as_millis(),
                    self.stdout_text(),
                );
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    /// Every complete line on stdout, parsed.
    ///
    /// A line that is not JSON is a failure, not a "nothing yet": stdout is the protocol
    /// channel, and the whole point of this file is that nothing else reaches it.
    fn rpc_lines(&self) -> Vec<Value> {
        completed_lines(&self.stdout_text())
    }

    /// Every stderr line announcing a shutdown — there must be exactly one.
    fn shutdown_lines(&self) -> Vec<String> {
        self.stderr_text()
            .lines()
            .filter(|line| line.contains("shutting down"))
            .map(str::to_owned)
            .collect()
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // By PID, from the handle we spawned — even when a case above panicked. `kill` is
        // SIGKILL, which is the one signal a hung bridge cannot ignore.
        if self
            .process
            .try_wait()
            .ok()
            .flatten()
            .is_none()
        {
            let _ = self.process.kill();
            let _ = self.process.wait();
        }
        self.drain_output();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

/* -------------------------------------------------------------------- helpers */

/// Appends everything one pipe delivers to `sink`, until the pipe ends.
fn spawn_reader(mut pipe: impl Read + Send + 'static, sink: Arc<Mutex<String>>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut chunk = [0_u8; 4 * 1024];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => return,
                Ok(read) => {
                    let text = String::from_utf8_lossy(&chunk[..read]).into_owned();
                    if let Ok(mut sink) = sink.lock() {
                        sink.push_str(&text);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                // A refused read means the pipe is gone, which is the same news as EOF.
                Err(_) => return,
            }
        }
    })
}

/// The finished lines of a stdout transcript, parsed; the fragment after the last newline is
/// dropped and read separately by the cases that care about it.
fn completed_lines(stdout: &str) -> Vec<Value> {
    stdout
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("stdout carried a line that is not JSON: \
                                                 {line:?} ({error})"))
        })
        .collect()
}

/// A token file's directory under the system temp dir, unique per process and per call.
///
/// Deliberately not the repository: a token inside the working tree is exactly the leftover a
/// secret grep finds a month later. No `tempfile` crate either — `docs/38` allows no new
/// dependency, and a directory named after the PID is the whole of what is needed.
fn temporary_directory() -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let name = format!(
        "bc-bridge-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed),
    );
    let directory = std::env::temp_dir().join(name);
    std::fs::create_dir_all(&directory).expect("no temporary directory for the token file");
    directory
}

/// A port the OS just handed out and nobody holds any more.
///
/// A race in theory — the port could be taken between the drop and the child's bind, and the
/// case then fails on a "listener failed" line instead of on its own subject. That is the
/// price of a binary that reads its port from the environment, and a visible wrong failure
/// beats a hidden right one.
fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("no ephemeral port to test with");
    listener
        .local_addr()
        .expect("the bound port has no address")
        .port()
}

/// Two ports the OS handed out while both were held.
///
/// [`free_port`] binds and drops in one step, so two calls can return the same number: the
/// kernel may hand the second bind the port the first just released, and a case that needs two
/// ports would then die on `EADDRINUSE`. Holding both listeners until both numbers are in hand
/// makes the two distinct, and both are free again once this returns.
fn free_ports() -> (u16, u16) {
    let first = TcpListener::bind("127.0.0.1:0").expect("no ephemeral port to test with");
    let second = TcpListener::bind("127.0.0.1:0").expect("no second ephemeral port to test with");
    let first_port = first
        .local_addr()
        .expect("the first bound port has no address")
        .port();
    let second_port = second
        .local_addr()
        .expect("the second bound port has no address")
        .port();
    (first_port, second_port)
}

/// A port this process holds, and the holder that has to outlive the child's attempt.
///
/// The counterpart of [`free_port`]: the number is taken on purpose, so the child's bind fails
/// with `EADDRINUSE` instead of finding a number nobody wanted. The listener stays open until
/// the case drops it — otherwise the port would be free again before the child gets there, and
/// the case would measure the wrong thing while looking green.
fn occupied_port() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("no ephemeral port to occupy");
    let port = listener
        .local_addr()
        .expect("the occupied port has no address")
        .port();
    (listener, port)
}

fn can_connect(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("the port is not an address"),
        SOCKET_TIMEOUT,
    )
    .is_ok()
}

/// One `POST /mcp`, written by hand: there is no HTTP client in this tree, and the transport's
/// answer is a status line plus one JSON body — both readable without one.
///
/// Unix-only because the one case that uses it ends the child with a signal.
///
/// Returns head and body separately, so a case can look at the status the answer claims and at
/// the only bytes that are the message. The head is read first — it carries the one number that
/// says where the body ends — and the body is then read up to `Content-Length` instead of to the
/// server's close: a read to the close would hang on any answer that keeps the connection, and
/// whatever the socket delivered past the declared length is not part of this message.
#[cfg(unix)]
fn post_mcp(port: u16, token: &str, body: &str) -> (String, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .unwrap_or_else(|error| panic!("the /mcp port {port} refused a connection: {error}"));
    stream
        .set_read_timeout(Some(SOCKET_TIMEOUT))
        .expect("the socket refused a read timeout");
    stream
        .set_write_timeout(Some(SOCKET_TIMEOUT))
        .expect("the socket refused a write timeout");

    let request = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    stream
        .write_all(request.as_bytes())
        .expect("the /mcp socket refused the request");

    let mut chunk = [0_u8; 1024];
    let mut received = Vec::new();
    let head_end = loop {
        match stream.read(&mut chunk) {
            Ok(0) => panic!(
                "the /mcp answer ended before its head was complete: {:?}",
                String::from_utf8_lossy(&received),
            ),
            Ok(read) => {
                received.extend_from_slice(&chunk[..read]);
                if let Some(end) = find_end_of_head(&received) {
                    break end;
                }
            }
            Err(error) => panic!("the /mcp socket failed while reading the head: {error}"),
        }
    };

    let head = String::from_utf8_lossy(&received[..head_end]).into_owned();
    let length = content_length(&head);
    let mut body_bytes = received[head_end..].to_vec();
    while body_bytes.len() < length {
        match stream.read(&mut chunk) {
            Ok(0) => panic!(
                "the /mcp body ended after {} of {length} declared bytes: {:?}",
                body_bytes.len(),
                String::from_utf8_lossy(&body_bytes),
            ),
            Ok(read) => body_bytes.extend_from_slice(&chunk[..read]),
            Err(error) => panic!("the /mcp socket failed while reading the body: {error}"),
        }
    }
    body_bytes.truncate(length);
    (head, String::from_utf8_lossy(&body_bytes).into_owned())
}

/// The body length an answer declares.
///
/// Every answer this transport writes carries `Content-Length` (`respond_json`, `rejection`,
/// `respond_empty` in `http.rs`), so a missing or unreadable one is a finding about the answer
/// and not a reason to fall back to reading until the socket closes.
#[cfg(unix)]
fn content_length(head: &str) -> usize {
    let declared = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim())
        })
        .unwrap_or_else(|| panic!("the /mcp answer declares no Content-Length: {head:?}"));
    declared.parse::<usize>().unwrap_or_else(|error| {
        panic!("the /mcp answer declares an unusable Content-Length {declared:?}: {error}")
    })
}

/* ------------------------------------------------------------- fake extension */

/// A stand-in for the extension: the handshake, the `hello`, and the answer to the one request
/// the hub sends on its own — the automatic `status` after `welcome`.
///
/// It reads the bridge with [`ServerFrames`] — the decoder in `ws::frame` is the *server*
/// side and rejects exactly the shape a server is allowed to send. Only the framing is written
/// here; the handshake bytes and the masking are the client's half, and `tests/ws.rs` pins the
/// server side against the RFC cases.
struct FakeExtension {
    stream: TcpStream,
    frames: ServerFrames,
    events: VecDeque<(u8, Vec<u8>)>,
}

impl FakeExtension {
    fn connect(port: u16, token: &str) -> FakeExtension {
        let stream = TcpStream::connect(("127.0.0.1", port))
            .unwrap_or_else(|error| panic!("the bridge did not accept a connection: {error}"));
        stream
            .set_read_timeout(Some(SOCKET_TIMEOUT))
            .expect("the socket refused a read timeout");
        stream
            .set_write_timeout(Some(SOCKET_TIMEOUT))
            .expect("the socket refused a write timeout");

        let mut extension = FakeExtension {
            stream,
            frames: ServerFrames::default(),
            events: VecDeque::new(),
        };
        extension.handshake();
        // The extension speaks first, like the browser does: the token travels in `hello`,
        // never in the URL.
        extension.send_text(&json!({
            "type": "hello",
            "protocol": 1,
            "extensionVersion": "0.1.0",
            "browser": { "name": "Firefox", "version": "152.0.3" },
            "token": token,
        })
        .to_string());
        extension
    }

    /// Sends the upgrade request and swallows the `101`, keeping the bytes behind the header
    /// for the codec — the seam stage 2c exists for.
    fn handshake(&mut self) {
        let request = "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n\
                       Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                       Sec-WebSocket-Version: 13\r\n\r\n";
        self.stream
            .write_all(request.as_bytes())
            .expect("the bridge's socket refused the handshake");

        let mut received = Vec::new();
        let mut chunk = [0_u8; 1024];
        let header_end = loop {
            let read = self
                .stream
                .read(&mut chunk)
                .expect("the handshake answer never arrived");
            assert!(read > 0, "the bridge closed the socket during the handshake");
            received.extend_from_slice(&chunk[..read]);
            if let Some(end) = find_end_of_head(&received) {
                break end;
            }
        };

        let answer = String::from_utf8_lossy(&received[..header_end]).into_owned();
        assert!(
            answer.starts_with("HTTP/1.1 101"),
            "the bridge refused the upgrade: {answer:?}"
        );

        // The bytes behind the header belong to the codec, not to the handshake.
        let rest = received[header_end..].to_vec();
        let frames = self.frames.push(&rest);
        self.events.extend(frames);
    }

    fn send_text(&mut self, text: &str) {
        let frame = masked_text_frame(text);
        self.stream
            .write_all(&frame)
            .expect("the bridge's socket refused a frame");
    }

    /// Reads until the next text message, or returns `None` once the deadline has passed or
    /// the bridge closed the socket.
    fn next_message(&mut self, deadline: Instant) -> Option<Value> {
        loop {
            while let Some((opcode, payload)) = self.events.pop_front() {
                if opcode == opcode::TEXT {
                    let text = String::from_utf8(payload)
                        .expect("the bridge sent a text frame that is not UTF-8");
                    return Some(serde_json::from_str(&text).unwrap_or_else(|error| {
                        panic!("the bridge sent a line that is not JSON: {text:?} ({error})")
                    }));
                }
                // Control frames are not answers; nothing here pings the bridge, so they are
                // simply not this helper's business.
            }
            if Instant::now() >= deadline {
                return None;
            }

            let mut chunk = [0_u8; 4 * 1024];
            match self.stream.read(&mut chunk) {
                Ok(0) => return None,
                Ok(read) => {
                    let frames = self.frames.push(&chunk[..read]);
                    self.events.extend(frames);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(error) => panic!("the bridge's socket failed: {error}"),
            }
        }
    }

    /// Waits for `welcome`, answers the automatic `status` request that follows it, and
    /// returns. That leaves the session exactly as a browser leaves it: connected, nothing
    /// pending, one socket open.
    fn answer_the_automatic_status_request(&mut self) {
        let deadline = Instant::now() + WELCOME_TIMEOUT;
        loop {
            let message = self.next_message(deadline).unwrap_or_else(|| {
                panic!("no welcome and no status request within {} ms", WELCOME_TIMEOUT.as_millis())
            });
            match message["type"].as_str() {
                Some("welcome") => {}
                Some("request") if message["method"] == json!("status") => {
                    let answer = json!({
                        "type": "response",
                        "id": message["id"].clone(),
                        "ok": true,
                        "result": status_result(),
                    });
                    self.send_text(&answer.to_string());
                    return;
                }
                _ => panic!("the bridge sent an unexpected frame: {message}"),
            }
        }
    }

    /// Waits for the `welcome` that answers the `hello` — the proof *on the socket* that the
    /// listener still speaks the extension protocol and not merely TCP.
    fn wait_for_welcome(&mut self) {
        let deadline = Instant::now() + WELCOME_TIMEOUT;
        let message = self.next_message(deadline).unwrap_or_else(|| {
            panic!("no welcome within {} ms", WELCOME_TIMEOUT.as_millis())
        });
        assert_eq!(
            message["type"],
            json!("welcome"),
            "the bridge answered the hello with {message}",
        );
    }
}

/// Two windows with two tabs between them — enough for the automatic status line to name both
/// numbers (`status windows=2 tabs=2`), which is the proof that the session really connected.
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
                        "title": "Beispiel",
                    },
                ],
            },
            {
                "id": 2,
                "focused": false,
                "type": "normal",
                "tabs": [
                    {
                        "id": 201,
                        "active": true,
                        "pinned": false,
                        "url": "",
                        "title": "Neuer Tab",
                    },
                ],
            },
        ],
    })
}

/// Reads the *server* half of the wire: unmasked frames, never fragmented (`encode_frame` in
/// `ws::frame` sends whole messages).
///
/// The library's `FrameDecoder` is the server side of this seam and rejects an unmasked frame
/// with `1002` — correctly, because a client frame must be masked. Reading what the bridge
/// writes therefore needs this small counterpart instead of a borrowed decoder.
#[derive(Default)]
struct ServerFrames {
    buffer: Vec<u8>,
}

impl ServerFrames {
    /// Consumes one chunk and returns the `(opcode, payload)` pairs it completed.
    fn push(&mut self, chunk: &[u8]) -> Vec<(u8, Vec<u8>)> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        while let Some((frame, consumed)) = self.next_frame() {
            self.buffer.drain(..consumed);
            frames.push(frame);
        }
        frames
    }

    fn next_frame(&self) -> Option<((u8, Vec<u8>), usize)> {
        let available = &self.buffer[..];
        if available.len() < 2 {
            return None;
        }

        let first = available[0];
        let second = available[1];
        assert!(
            first & 0x80 != 0,
            "the bridge sent a fragmented server frame"
        );
        assert!(second & 0x80 == 0, "the bridge masked a server frame");

        // The 7-bit length, with the two escape values the codec uses for the longer forms.
        let (length, header) = match second & 0x7f {
            value @ 0..=125 => (usize::from(value), 2),
            126 => {
                if available.len() < 4 {
                    return None;
                }
                (usize::from(u16::from_be_bytes([available[2], available[3]])), 4)
            }
            _ => {
                if available.len() < 10 {
                    return None;
                }
                let bytes: [u8; 8] = available[2..10].try_into().expect("eight bytes");
                (
                    usize::try_from(u64::from_be_bytes(bytes))
                        .expect("a length this process can hold"),
                    10,
                )
            }
        };

        if available.len() < header + length {
            return None;
        }
        let payload = available[header..header + length].to_vec();
        Some(((first & 0x0f, payload), header + length))
    }
}

/// One client text frame, masked the way a browser masks: the only shape the server accepts
/// (an unmasked client frame is a `1002`, which `tests/ws.rs` pins).
fn masked_text_frame(text: &str) -> Vec<u8> {
    const MASK_KEY: [u8; 4] = [0x37, 0xfa, 0x21, 0x3d];

    let payload = text.as_bytes();
    let mut frame = vec![0x80 | opcode::TEXT];
    if payload.len() < 126 {
        frame.push(0x80 | payload.len() as u8);
    } else {
        assert!(
            payload.len() <= usize::from(u16::MAX),
            "the case needs a short frame"
        );
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    }
    frame.extend_from_slice(&MASK_KEY);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ MASK_KEY[index & 0b11]),
    );
    frame
}

/// The offset just behind the empty line that ends an HTTP head.
fn find_end_of_head(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
}

/// A `ping` — the cheapest proof of life there is, and one line the client can wait for.
fn ping_message(id: i64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "ping" })
}

/* ---------------------------------------------------------------------- cases */

#[test]
fn mcp_whenStdinEnds_shouldExitZeroAfterASingleShutdownLine() {
    // GIVEN a running bridge that has answered a request:
    let mut bridge = Bridge::start(Stdin::Pipe);
    bridge.send(&ping_message(40));
    bridge.wait_for_answer(40, "the answer to ping id=40");

    // WHEN the client closes stdin — the normal way a stdio client says goodbye,
    bridge.close_stdin();
    let exit_code = bridge.exit_within(EXIT_TIMEOUT);

    // THEN the process ends with 0,
    assert_eq!(
        exit_code,
        Some(0),
        "the bridge ended with {exit_code:?} instead of 0\n{}",
        bridge.stderr_text(),
    );

    // ... exactly one shutdown line was written — the cleanup's SIGTERM must not add a
    // second one either,
    let shutdown = bridge.shutdown_lines();
    assert_eq!(
        shutdown.len(),
        1,
        "one shutdown line expected, got {shutdown:?}:\n{}",
        bridge.stderr_text(),
    );
    assert!(
        shutdown[0].ends_with(" stdin closed, shutting down"),
        "the shutdown line says something else: {:?}",
        shutdown[0],
    );

    // ... and stdout carried nothing but JSON-RPC, each line a whole message,
    let messages = bridge.rpc_lines();
    assert_eq!(messages.len(), 1, "stdout carried {messages:?}");
    for message in &messages {
        assert_eq!(message["jsonrpc"], "2.0", "a line is not JSON-RPC: {message}");
        assert!(
            message.get("id").is_some(),
            "a response without an id field: {message}"
        );
    }

    // ... with no fragment at the end — the message the client rejects by name.
    bridge.assert_no_unfinished_tail();
}

#[test]
fn mcp_whenStdinEndsWithAConnectedExtension_shouldAlsoExitZeroWithOneShutdownLine() {
    // GIVEN a bridge with a connected fake extension — a session that has a socket, a
    // `welcome`, an automatic `status` request and everything else to trip over:
    let mut bridge = Bridge::start(Stdin::Pipe);
    let mut extension = FakeExtension::connect(bridge.port, &token());
    extension.answer_the_automatic_status_request();
    bridge.wait_for_stderr("status windows=", "the automatic status line on stderr");

    // WHEN stdin ends — with the extension's socket still open,
    bridge.close_stdin();
    let exit_code = bridge.exit_within(EXIT_TIMEOUT);

    // THEN it still ends with 0 and still logs exactly once. The wording of the sentence is
    // pinned by the case above (the template compares only the count here, and one pin per
    // sentence is enough — this case is about the line *arriving* despite the session).
    assert_eq!(
        exit_code,
        Some(0),
        "the bridge ended with {exit_code:?} instead of 0\n{}",
        bridge.stderr_text(),
    );
    let shutdown = bridge.shutdown_lines();
    assert_eq!(
        shutdown.len(),
        1,
        "one shutdown line expected, got {shutdown:?}:\n{}",
        bridge.stderr_text(),
    );

    // ... and stdout stayed protocol-only, without a fragment at the end. No request travelled
    // this way in this case, so the transcript is empty — and an empty transcript is the
    // strongest form of "nothing but JSON-RPC". The session's own traffic is a hub matter:
    // its status line belongs on the log, and a line of it on stdout would make
    // `rpc_lines()` fail above.
    for message in &bridge.rpc_lines() {
        assert_eq!(message["jsonrpc"], "2.0", "a line is not JSON-RPC: {message}");
    }
    bridge.assert_no_unfinished_tail();
}

#[test]
fn mcp_withAnIgnoredStdin_shouldKeepRunningAndListeningAfterTheEof() {
    // GIVEN a bridge started the way `INSTALL.md` starts the standalone one, with stdin on
    // `/dev/null`:
    let mut bridge = Bridge::start(Stdin::Null);

    // WHEN the EOF that `/dev/null` produces has had time to be acted upon,
    std::thread::sleep(IGNORED_STDIN_SETTLE);

    // THEN the process is still alive — otherwise the standalone bridge would die seconds
    // after every start and `Restart=on-failure` would turn that into a loop:
    assert!(
        bridge.is_running(),
        "the bridge exited on its ignored stdin:\n{}",
        bridge.stderr_text(),
    );

    // ... the extension port still answers,
    assert!(
        can_connect(bridge.port),
        "the extension port {} does not accept a connection any more",
        bridge.port,
    );

    // ... it still speaks the extension protocol, not just a listening socket. The proof
    // stays on the socket on purpose: this case measures the life cycle and nothing else, so
    // a mutation that puts a log line on the wrong channel cannot make it red for a reason
    // that belongs to another case.
    let mut extension = FakeExtension::connect(bridge.port, &token());
    extension.wait_for_welcome();

    // ... and no shutdown was announced: the only line about the end of stdin would be a lie
    // here.
    assert_eq!(
        bridge.shutdown_lines(),
        Vec::<String>::new(),
        "the bridge logged a shutdown for an ignored stdin:\n{}",
        bridge.stderr_text(),
    );

    // The child is still running here on purpose — `Drop` kills it by PID, which is also the
    // proof that no case leaks a process onto the operator's machine.
    assert!(bridge.is_running(), "the bridge left the case on its own");
}

#[test]
fn bridge_withoutATokenFile_shouldExitWithTheConfigurationCode() {
    // GIVEN a start whose token path is empty — the state `openssl rand -hex 32 > token` is
    // supposed to prevent, and the one no restart heals:
    let launch = Launch::new().without_token_file();
    let token_file = launch.token_path();

    // WHEN the bridge starts,
    let mut bridge = launch.spawn(Stdin::Null);
    let exit_code = bridge.exit_within(EXIT_TIMEOUT);

    // THEN it ends with 2 — the code `RestartPreventExitStatus=2` in the unit is written for,
    assert_eq!(
        exit_code,
        Some(EXIT_CONFIGURATION),
        "the bridge ended with {exit_code:?} instead of {EXIT_CONFIGURATION}\n{}",
        bridge.stderr_text(),
    );

    let stderr = bridge.stderr_text();

    // ... says what is missing and names the exact file the operator has to write,
    let expected = format!("token file missing or too short: {}", token_file.display());
    assert!(
        stderr.contains(&expected),
        "the line {expected:?} is missing from:\n{stderr}",
    );

    // ... and bound nothing on the way: the token is read before the listener, so a bridge
    // without one never sits on the extension's port refusing every extension.
    assert!(
        !stderr.contains("listening on"),
        "the bridge bound a port without a token:\n{stderr}",
    );
}

#[test]
fn bridge_withAnUnreadableTokenFile_shouldExitWithTheFailureCode() {
    // GIVEN a token path that exists but cannot be read as a file — a directory, which is what
    // a mistaken `mkdir -p ~/.config/browser-control/token` leaves behind:
    let launch = Launch::new().with_a_directory_as_token_file();

    // WHEN the bridge starts,
    let mut bridge = launch.spawn(Stdin::Null);
    let exit_code = bridge.exit_within(EXIT_TIMEOUT);

    // THEN it ends with 1, the code the unit restarts for: this is a broken installation, not a
    // missing configuration,
    assert_eq!(
        exit_code,
        Some(EXIT_FAILURE),
        "the bridge ended with {exit_code:?} instead of {EXIT_FAILURE}\n{}",
        bridge.stderr_text(),
    );

    let stderr = bridge.stderr_text();

    // ... and the failure is reported as one, with the OS error behind it,
    assert!(
        stderr.contains("bridge failed:"),
        "the line \"bridge failed:\" is missing from:\n{stderr}",
    );

    // ... and not as the missing-token case: `EISDIR` is not `ENOENT`, and the two exit codes
    // exist to keep them apart.
    assert!(
        !stderr.contains("token file missing or too short:"),
        "an unreadable token file was reported as a missing one:\n{stderr}",
    );
    assert!(
        !stderr.contains("listening on"),
        "the bridge bound a port with an unreadable token:\n{stderr}",
    );
}

#[test]
fn bridge_onATakenPort_shouldExitWithTheFailureCodeAndNameTheOwner() {
    // GIVEN an extension port this process already holds — a second start, which
    // `Restart=on-failure` is meant to survive:
    let (holder, port) = occupied_port();

    // WHEN the bridge tries to bind it,
    let mut bridge = Launch::new().on_port(port).spawn(Stdin::Null);
    let exit_code = bridge.exit_within(EXIT_TIMEOUT);

    // THEN it ends with 1,
    assert_eq!(
        exit_code,
        Some(EXIT_FAILURE),
        "the bridge ended with {exit_code:?} instead of {EXIT_FAILURE}\n{}",
        bridge.stderr_text(),
    );

    let stderr = bridge.stderr_text();

    // ... naming the bind that failed, the address and the symbolic error — the shape the
    // parity yardstick records (`EADDRINUSE`, not "Address already in use"),
    let failed = format!("listener failed on 127.0.0.1:{port}: EADDRINUSE");
    assert!(
        stderr.contains(&failed),
        "the line {failed:?} is missing from:\n{stderr}",
    );

    // ... and with the second line that makes the failure actionable: who holds the port. The
    // owner is this process, when the platform can name one at all — a kernel without `/proc`
    // (or a hardened container) legitimately says so instead.
    let in_use = format!("port 127.0.0.1:{port} in use, ");
    let owner_line = stderr
        .lines()
        .find(|line| line.contains(&in_use))
        .unwrap_or_else(|| panic!("no line {in_use:?} in:\n{stderr}"));
    assert!(
        owner_line.contains("owner pid=") || owner_line.contains("Besitzer nicht ermittelbar"),
        "the owner line names no owner: {owner_line:?}",
    );
    if let Some(pid) = owner_line
        .split("owner pid=")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
    {
        assert_eq!(
            pid,
            std::process::id().to_string(),
            "the owner line names another process than this one: {owner_line:?}",
        );
    }

    drop(holder);
}

#[cfg(unix)]
#[test]
fn bridge_onSigterm_shouldExitZeroWithTheTerminationLine() {
    // GIVEN a running bridge — stdin on `/dev/null`, so nothing but the signal can end it,
    let mut bridge = Bridge::start(Stdin::Null);

    // WHEN the service manager stops it,
    bridge.signal("TERM");
    let exit_code = bridge.exit_within(EXIT_TIMEOUT);

    // THEN the exit is 0: being stopped is not a failure, and a 1 here would make
    // `Restart=on-failure` restart a service that was asked to stop,
    assert_eq!(
        exit_code,
        Some(EXIT_OK),
        "the bridge ended with {exit_code:?} instead of {EXIT_OK}\n{}",
        bridge.stderr_text(),
    );

    // ... with exactly one shutdown line, spelled the way the Node bridge spells it,
    let shutdown = bridge.shutdown_lines();
    assert_eq!(
        shutdown.len(),
        1,
        "one shutdown line expected, got {shutdown:?}:\n{}",
        bridge.stderr_text(),
    );
    assert!(
        shutdown[0].ends_with(" received SIGTERM, shutting down"),
        "the shutdown line says something else: {:?}",
        shutdown[0],
    );

    // ... and stdout stayed protocol-only: the end of a session is a log line, never a message.
    assert_eq!(
        bridge.stdout_text(),
        "",
        "the bridge wrote to the protocol channel on its way out",
    );
}

#[cfg(unix)]
#[test]
fn bridge_onSigint_shouldExitZeroWithTheInterruptLine() {
    // GIVEN a running bridge,
    let mut bridge = Bridge::start(Stdin::Null);

    // WHEN it is interrupted — the Ctrl+C of a foreground run,
    bridge.signal("INT");
    let exit_code = bridge.exit_within(EXIT_TIMEOUT);

    // THEN it ends with 0 as well: both signals are one contract, not two,
    assert_eq!(
        exit_code,
        Some(EXIT_OK),
        "the bridge ended with {exit_code:?} instead of {EXIT_OK}\n{}",
        bridge.stderr_text(),
    );

    // ... and the line names the signal that actually arrived. A handler that logs the wrong
    // one sends the operator looking for a signal nobody sent.
    let shutdown = bridge.shutdown_lines();
    assert_eq!(
        shutdown.len(),
        1,
        "one shutdown line expected, got {shutdown:?}:\n{}",
        bridge.stderr_text(),
    );
    assert!(
        shutdown[0].ends_with(" received SIGINT, shutting down"),
        "the shutdown line says something else: {:?}",
        shutdown[0],
    );
}

#[cfg(unix)]
#[test]
fn bridge_withTheHttpFlag_shouldServeMcpUntilASigterm() {
    // GIVEN a start with `--http` and a `/mcp` port of its own — the second surface exists only
    // behind this flag, so this case is the only thing that measures it. Both numbers come from
    // one call, so the extension port and the `/mcp` port cannot turn out to be the same:
    let (extension_port, http_port) = free_ports();
    let mut bridge = Launch::new()
        .on_port(extension_port)
        .with_http(http_port)
        .spawn(Stdin::Null);
    bridge.wait_for_listener();

    // WHEN the transport has reported itself,
    let listening = format!("listening on 127.0.0.1:{http_port} for POST /mcp");
    bridge.wait_for_stderr(&listening, "the /mcp listener line");

    // THEN it really accepts connections on that port — the line is a claim, this is the proof,
    assert!(
        can_connect(http_port),
        "the /mcp port {http_port} does not accept a connection:\n{}",
        bridge.stderr_text(),
    );

    // ... the extension port kept working beside it, which is the whole reason the second
    // surface got its own listener,
    assert!(
        can_connect(bridge.port),
        "the extension port {} stopped accepting connections:\n{}",
        bridge.port,
        bridge.stderr_text(),
    );

    // ... a request is answered: the tool seam `main.rs` wires into the transport is where the
    // protocol layer and the second surface meet, and a `/mcp` that accepts but cannot answer
    // would pass every check above,
    let (head, body) = post_mcp(http_port, &token(), &ping_message(41).to_string());
    assert!(
        head.starts_with("HTTP/1.1 200"),
        "the /mcp answer is not a 200: {head:?}",
    );
    let message: Value = serde_json::from_str(body.trim())
        .unwrap_or_else(|error| panic!("the /mcp body is not JSON: {body:?} ({error})"));
    assert_eq!(
        message["id"],
        json!(41),
        "the /mcp answer carries another id: {message}",
    );
    assert_eq!(
        message["jsonrpc"],
        json!("2.0"),
        "the /mcp answer is not JSON-RPC: {message}",
    );

    // ... with a *result*, not merely an envelope: `ping` answers the empty object
    // (`mcp::respond_to`), and an envelope carrying `-32601` instead would pass every check
    // above while proving that nothing behind the transport works at all,
    assert_eq!(
        message["result"],
        json!({}),
        "the /mcp answer carries no result: {message}",
    );
    assert!(
        message.get("error").is_none(),
        "the /mcp answer is an error instead of a result: {message}",
    );

    // ... and the stop still ends the process through the one signal path, with 0.
    bridge.signal("TERM");
    let exit_code = bridge.exit_within(EXIT_TIMEOUT);
    assert_eq!(
        exit_code,
        Some(EXIT_OK),
        "the bridge ended with {exit_code:?} instead of {EXIT_OK}\n{}",
        bridge.stderr_text(),
    );
    let shutdown = bridge.shutdown_lines();
    assert_eq!(
        shutdown.len(),
        1,
        "one shutdown line expected, got {shutdown:?}:\n{}",
        bridge.stderr_text(),
    );
}

#[test]
fn bridge_withTheHttpFlagOnATakenPort_shouldExitWithTheFailureCode() {
    // GIVEN a `/mcp` port this process already holds,
    let (holder, http_port) = occupied_port();

    // WHEN the bridge starts with `--http`,
    let mut bridge = Launch::new().with_http(http_port).spawn(Stdin::Null);
    let exit_code = bridge.exit_within(EXIT_TIMEOUT);

    // THEN the start is over instead of half alive: the extension served but `/mcp` not is the
    // "looks healthy in `systemctl status`" failure the failure code prevents,
    assert_eq!(
        exit_code,
        Some(EXIT_FAILURE),
        "the bridge ended with {exit_code:?} instead of {EXIT_FAILURE}\n{}",
        bridge.stderr_text(),
    );

    let stderr = bridge.stderr_text();

    // ... the failing bind is named as the `/mcp` one, not as the extension one,
    let failed = format!("http listener failed on 127.0.0.1:{http_port}: EADDRINUSE");
    assert!(
        stderr.contains(&failed),
        "the line {failed:?} is missing from:\n{stderr}",
    );
    assert!(
        stderr.contains(&format!("port 127.0.0.1:{http_port} in use, ")),
        "no owner line for the /mcp port in:\n{stderr}",
    );

    // ... and the extension port went with the process. A listener left behind here would be a
    // bridge that answers the extension while `/mcp` is dead.
    assert!(
        !can_connect(bridge.port),
        "the extension port {} still accepts connections after the failed start",
        bridge.port,
    );

    drop(holder);
}

#[test]
fn bridge_whenTheExtensionSocketCloses_shouldKeepListening() {
    // GIVEN a bridge with a session that ends — a browser tab closed, a socket lost, the
    // ordinary way an extension disconnects. stdin is a pipe the case holds open, so nothing
    // but the closed socket can end anything here:
    let mut bridge = Bridge::start(Stdin::Pipe);
    {
        let mut extension = FakeExtension::connect(bridge.port, &token());
        extension.wait_for_welcome();
    }
    std::thread::sleep(IGNORED_STDIN_SETTLE);

    // WHEN the end of that session has been handled,
    // THEN the process is still there. A bridge that ended with its last socket would leave the
    // stdio client of a shared process without a tool layer,
    assert!(
        bridge.is_running(),
        "the bridge ended with its extension session:\n{}",
        bridge.stderr_text(),
    );

    // ... and the next extension finds a listener again.
    assert!(
        can_connect(bridge.port),
        "the extension port {} does not accept a connection any more",
        bridge.port,
    );
    let mut extension = FakeExtension::connect(bridge.port, &token());
    extension.wait_for_welcome();

    // ... and the client's own goodbye still ends the process the way it always does — the end
    // of a session changes nothing about the life cycle.
    bridge.close_stdin();
    assert_eq!(
        bridge.exit_within(EXIT_TIMEOUT),
        Some(EXIT_OK),
        "the bridge ended with another code than 0 after the session's end\n{}",
        bridge.stderr_text(),
    );
}

#[cfg(unix)]
#[test]
fn bridge_withAnUnreadableStdin_shouldKeepServingAndLogTheFailure() {
    // GIVEN a bridge whose stdin cannot be read at all — a directory descriptor, which is the
    // one stdin that fails the read instead of ending it:
    let mut bridge = Bridge::start(Stdin::Unreadable);

    // WHEN the failed read has been reported,
    bridge.wait_for_stderr("mcp stdin failed:", "the failed read on stdin");

    // THEN the extension listener keeps serving. An unusable stdio channel is not a bridge that
    // failed: the client of a shared process may lose its pipe while the browser keeps talking.
    assert!(
        bridge.is_running(),
        "the bridge ended on a failed read of its stdin:\n{}",
        bridge.stderr_text(),
    );
    assert!(
        can_connect(bridge.port),
        "the extension port {} does not accept a connection any more",
        bridge.port,
    );

    // ... and the failure was not dressed up as a shutdown: the operator greps two different
    // lines for two different things.
    assert_eq!(
        bridge.shutdown_lines(),
        Vec::<String>::new(),
        "the bridge logged a shutdown for an unusable stdin:\n{}",
        bridge.stderr_text(),
    );

    // ... and the case ends the child the way a service is ended, not with the harness's
    // SIGKILL: the one path out of this process is the signal path.
    bridge.signal("TERM");
    assert_eq!(
        bridge.exit_within(EXIT_TIMEOUT),
        Some(EXIT_OK),
        "the bridge ended with another code than 0 on SIGTERM\n{}",
        bridge.stderr_text(),
    );
}
