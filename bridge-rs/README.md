# browser-control-bridge (Rust)

The Rust bridge: a `[[bin]]` named `browser-control-bridge` that builds for Linux
and Windows and ports the Node bridge — read the environment, refuse to start
without a usable token, bind the extension listener, serve the extension's
WebSocket connection and its JSON protocol, answer MCP on stdin/stdout and, with
`--http`, on `POST /mcp` as well, log what it did, and stop cleanly on
SIGTERM/SIGINT.

What it does today, in the order it happens:

1. Reads `BC_BIND` (`host:port`, default `127.0.0.1:8110`), `BC_LOG`
   (`info`|`debug`), `BC_HTTP_PORT`, `BC_HELLO_TIMEOUT_MS` and
   `BC_CALL_TIMEOUT_MS`. Invalid values fall back to the default instead of
   failing the start.
2. Reads the token from `BC_TOKEN_FILE`, else
   `$HOME/.config/browser-control/token`. A missing or unusable token — at least
   32 hexadecimal characters after trimming — exits `2`, which the systemd unit
   is written to *not* restart for.
3. Binds the extension listener and logs
   `listening on 127.0.0.1:8110 log=info`. A bind that fails logs the symbolic
   error code Node prints (`EADDRINUSE`, …), the port's owner when it can be
   found, and exits `1`, which the unit *does* restart for. An `accept` that fails
   afterwards ends the process the same way (`listener failed on …`); an aborted
   connection is ignored in silence, as Node ignores `ECONNABORTED`.
4. Reads one HTTP request head per accepted connection, bounded by the `hello`
   timeout and by a 16 KiB ceiling. A valid upgrade gets `101` and the WebSocket
   frame codec; a plain HTTP request is refused with `426 Upgrade Required` and the
   body `WebSocket upgrade required`; a head that cannot be read, or an upgrade
   that fails its checks, gets `400`.
5. Serves the hub's protocol on that connection: `hello` with the token (close
   `4401` on a mismatch, `4408` when it never arrives), `welcome`, the automatic
   `status` request, and one response per request. Results, errors and close codes
   are logged the way the Node bridge logs them.
6. Serves MCP on its own stdin/stdout, beside the listener: `initialize`, `ping`,
   `tools/list` and `tools/call` for the thirteen tools, one JSON line per answer.
   The tool table and the German sentences are copied from `bridge/mcp.mjs`
   character for character; `scripts/parity.sh` compares comparisons 1–3 against
   the recorded Node answers. A refused call never reaches the extension, and every
   failure is a tool result with `isError: true` and a German sentence — a
   protocol error is reserved for a malformed *request*. When stdin ends, the last
   answer is still written: the end of the input is not the end of the answers, so
   a single `tools/list` line piped in and followed by EOF still comes back.
7. Serves `/mcp` over HTTP when the process was started with `--http`: `POST /mcp`
   on `127.0.0.1:$BC_HTTP_PORT` (default `8111`), next to the extension listener and
   not instead of it. The routing order is the contract — path, method, token, body:
   another path answers `404`, an absolute target (`POST http://host/mcp`) does too (the
   template compares the whole request target with `/mcp`), a method other than `POST`
   answers `405` with `Allow: POST` (even without a token), a missing or wrong bearer
   token answers `401` with `WWW-Authenticate: Bearer` (a `Basic …` header does too), a
   request that declares a `Content-Length` *and* a `Transfer-Encoding` answers `400`
   (RFC 7230 §3.3.3 — the request-smuggling shape), a `Content-Length` over 1 MiB
   answers `413` before a single body byte arrives, and a chunked body over the limit
   gets its `413` while it is still being uploaded. A valid call answers `200
   application/json` with nothing but the tool layer's answer; a notification (`id`
   missing) answers `202` with an empty body; a tool layer that fails answers `500` and
   one log line that names the status, never the failure's message.

   Two details of that surface are not the obvious ones, and both are deliberate. A
   request whose body the client abandons mid-way gets **no answer at all** — the handler
   returns an error and hyper closes the connection without a byte, which is what the
   template does; inventing a status would only add a line to the log. And a head that
   is not complete after 60 s (`HEAD_READ_TIMEOUT`, Node's `headersTimeout`) ends the
   connection: hyper reads a head deadline only when a timer is installed, and without
   one it installs none.

   The framing check needs the raw head, because hyper deletes the `Content-Length`
   header from a request map as soon as a later `Transfer-Encoding` line shows up. A
   `HeadTap` in front of hyper's reader keeps the head bytes of the connection and scans
   them for those two header names; hyper still parses, still owns the body, still
   answers.

   Every rejection closes the connection — a client could otherwise hold a socket with a
   body that trickles in just under the limit. Only that surface uses `hyper`; the
   extension port keeps its own head reader, because the bytes behind the handshake
   belong to the frame codec.
8. Stops on SIGTERM/SIGINT, and on a stdin that belongs to a client. Under systemd
   stdin is `/dev/null`, and its EOF is not a shutdown request: a pipe or a
   socketpair is, `/dev/null` and a terminal are not (`std::fs::metadata` on
   `/proc/self/fd/0`; on Windows `GetFileType`, see [Windows](#windows)). Without that
   distinction `Restart=on-failure` would turn the service into a restart loop.

Stages 2a–2f and 3 of `docs/38` are built, so all seven comparisons of
`scripts/parity.sh` are green and the binary is the parity-checked port of
`../bridge/`, not a work in progress. What is still open is named in `docs/38`: the
switch-over (`4a`/`4b`), the operator's live measurement of the extension connection
and the Windows measurement of everything the cross-build can only compile (see
[Windows](#windows)).

stdout is the JSON-RPC channel and nothing else: one JSON line per answer, no BOM,
no blank line, no log line. Everything diagnostic goes to stderr, timestamped with
`toISOString()`'s format.

## Toolchain

Cross-built from Linux, no `.cargo/config.toml` in this directory (see below).

| Piece | Why |
|---|---|
| `rustup` / `rustc` (stable) | compiler; installed into `$HOME` |
| target `x86_64-unknown-linux-musl` | statically linked Linux binary (musl lands in the binary) |
| target `x86_64-pc-windows-gnu` | Windows binary |
| `x86_64-w64-mingw32-gcc` (GCC 13) | **linker only** for the Windows target; no code in the product |
| `clippy` (rustup component) | lints, run with `--all-targets` |

Setup:

```bash
rustup toolchain install stable
rustup target add x86_64-unknown-linux-musl x86_64-pc-windows-gnu
rustup component add clippy
sudo apt install gcc-mingw-w64-x86-64   # provides x86_64-w64-mingw32-gcc
```

## Dependencies

Eleven crates, all named in `docs/38`, `## Dependency changes`:

| Crate | Why |
|---|---|
| `tokio` (`rt-multi-thread`, `net`, `time`, `signal`, `sync`, `io-util`, `io-std`, `process`, `macros`) | async runtime, listener, deadlines, signals, channels |
| `sha1` + `base64` | `Sec-WebSocket-Accept` = Base64 of SHA-1(key + GUID) |
| `sha2` + `subtle` | the token compare: SHA-256 of both sides, then a constant-time compare |
| `serde_json` (`preserve_order`) | the hub's JSON protocol and the tool layer's answers; `preserve_order` pulls `indexmap` in, because the unlisted fields of a debug block keep result order and the tool table keeps the order of `bridge/mcp.mjs` |
| `serde` (`derive`) | the JSON-RPC error object serialises itself, so its wire names cannot drift from its fields |
| `hyper` (`server`, `http1`) + `hyper-util` (`tokio`) + `http-body-util` | `POST /mcp`: chunked request bodies, `Content-Length`, keep-alive and `Connection: close` are HTTP/1.1 details nobody should re-derive by hand; `hyper-util`'s `tokio` feature is what supplies `TokioTimer` and with it the header deadline |
| `windows-sys` (`Win32_NetworkManagement_IpHelper`, `Win32_Storage_FileSystem`, `Win32_System_Threading`, `Win32_Foundation`) | **`cfg(windows)` only**: `GetExtendedTcpTable` for the port owner, `GetFileType` for stdin, `OpenProcess`/`QueryFullProcessImageNameW` for the process name. `Win32_System_Console` is deliberately absent — `std::io::Stdin::as_raw_handle` hands the handle over, so `GetStdHandle` is not needed |

No WebSocket crate: the frame codec, the head reader of the extension port and the
two refusal answers there are ours, because the close codes, the message limit and
the bytes behind the handshake are part of the contract.

`Cargo.lock` is committed, so a build uses the versions the measurements used
unless someone updates them on purpose.

## Building

```bash
. "$HOME/.cargo/env"

cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-pc-windows-gnu
```

The artefacts land in `target/<target>/release/`:

- `bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge`
- `bridge-rs/target/x86_64-pc-windows-gnu/release/browser-control-bridge.exe`

`scripts/install.sh` copies the Linux binary from exactly the first path to
`$HOME/.local/bin`, so the artefact name is load-bearing. On Windows the second
path is the file `deploy/windows/browser-control-bridge.xml` points at — copied to
`%LOCALAPPDATA%\browser-control\`, see [Windows](#windows).

## Why `--target` is in every command

Cargo reads its configuration starting at the **working directory** and walking
upwards. A `[build] target = …` in `bridge-rs/.cargo/config.toml` would
therefore be invisible to a command run from the repository root with
`--manifest-path bridge-rs/Cargo.toml`, and the build would silently produce a
host binary instead of the musl one. There is no `.cargo/config.toml` here for
that reason; every command names its `--target` explicitly.

## Tests

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path bridge-rs/Cargo.toml
```

Unit tests live next to the modules (`src/*.rs`), integration tests under
`tests/`. They need no Node, no network and no port of the reserved range: the
`protocol.rs` case reads `extension/protocol.js` as text, the cases that need a
socket bind an ephemeral one on loopback, and `tests/mcp.rs` puts the tool layer in
front of a real hub whose "extension" is the test itself — a request goes out, an
answer comes back, and the MCP answer is what is compared.

`tests/http.rs` binds its own ephemeral port per case (`port: 0`, exactly like
`test/http-transport.test.js`), speaks HTTP/1.1 over a raw socket and compares status,
headers and body — including the cases that prove a rejection closes the socket, that a
`Transport::close` also ends an idle keep-alive socket, that half a head ends at the head
deadline, and that a panicking tool layer answers `500` instead of a dead connection. One
case there goes the other way in: the same request through `/mcp` and through the
stdio loop must produce the same bytes.

The token those cases use is built at runtime from the process id and the clock, never
written into the file: 32 hex characters, the shortest the bridge accepts.

`tests/mcp.rs` also reads `scripts/parity/expected/1-initialize-and-tools-list.txt`
and compares the whole `tools/list` answer with it byte for byte; that file is the
yardstick of `docs/37` and must stay in the tree.

One case in `tests/mcp.rs` starts the real binary (`CARGO_BIN_EXE_…`) rather than
the library: it writes one `tools/list` line to the child's stdin, closes it and
reads stdout. That is the only place where the answer to the last line before EOF
can be measured, because a test runtime outlives `serve()` and a process runtime
does not. It needs a token file and a port of its own — a temporary one and an
ephemeral one, never the reserved range — and it runs the same in `cargo test`.

`tests/bridge.rs` starts the binary three times for the three life-cycle contracts:
a pipe whose end is a client saying goodbye, the same end with a connected
extension session, and `/dev/null` on stdin, which is what the unit gives the
service and which must **not** end it. Every child is killed through its own
`Child` handle, so a failing case leaves no process behind; `pkill -f` is not used
anywhere in this tree (`CONTRIBUTING.md`).

**The port of a process case cannot come from `BC_BIND=127.0.0.1:0`.**
`config::parse_bind` maps port `0` to the default `8110` (the documented silent lie,
ported and not fixed), and `8110` is the operator's own bridge. The number therefore
comes from a temporary bind that is closed again before the child starts: the kernel
hands out an ephemeral port, which is also well above the 18110–18119 range
`tests/common/mod.rs` reserves for the Node suite.

The port numbers in `tests/common/mod.rs` are the same as in `test/ports.js`, so
`cargo test` and `npm test` must not run side by side — the second run's bridge
would find the first run's port taken. `tests/ports.rs` keeps that table honest.

`scripts/parity.sh` is the yardstick that compares this binary with the Node
bridge; it does not build anything, so build the musl release first. With `--http`
the binary answers on two ports; comparison 7 records the second line,
`listening on <host>:<BC_HTTP_PORT> for POST /mcp`, right after the first one.

## Windows

Linux answers two questions by reading `/proc`: who holds a port, and what stdin is. Windows
has no `/proc`, so stage 3 of `docs/38` asks the operating system instead, and adds a start
path that survives a logoff.

| Piece | Windows |
|---|---|
| port owner | `GetExtendedTcpTable` (`TCP_TABLE_OWNER_PID_ALL`, IPv4 **and** IPv6) for the PID of a row in state `LISTEN`/`ESTABLISHED`, then `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `QueryFullProcessImageNameW` for the name |
| stdin | `GetFileType(stdin)` — `FILE_TYPE_PIPE` is a client channel, `FILE_TYPE_CHAR` (console, `NUL`) is not, `FILE_TYPE_DISK` (a redirected file) is not either |
| stop | `tokio::signal::ctrl_c()` ⇒ `received SIGINT, shutting down`, exit `0` |
| start | `deploy/windows/browser-control-bridge.xml`, a Task Scheduler task, see below |

The owner line is the Linux line, character for character: `port 127.0.0.1:8110 in use,
owner pid=1234 name=browser-control-bridge.exe` — or `… in use, Besitzer nicht ermittelbar`
when any step of the lookup is in doubt. Every doubt answers `None`: a table that cannot be
read, a second `ERROR_INSUFFICIENT_BUFFER` after three tries, a process whose image cannot be
opened. A guessed PID would send the operator hunting the wrong process. The `name` is the
image's file name and not its full path, because the Linux side reads `/proc/<pid>/comm`,
which is a bare name too; both `\` and `/` count as separators.

Two places where this differs from `../bridge/` — the first because the template had no
Windows answer at all, the second on purpose:

- `bridge/port-owner.mjs` reads `/proc` and returned `null` on Windows, so every failed bind
  there said "Besitzer nicht ermittelbar". This binary names the PID — a capability the
  template never had, which is why `docs/30`, `## Non-goals` listed it as missing.
- `bridge/bridge.mjs` asks `fstatSync(0).isFIFO() || isSocket()`, and Node answers `false` for
  both on Windows even when descriptor 0 **is** a pipe. The Node bridge therefore never ends
  on a stdin EOF on Windows, and `docs/38` calls the two implementations "deckungsgleich" for
  exactly that reason — both said `false`. `GetFileType` answers truthfully instead: a
  Windows client that closes stdin ends the bridge, a `NUL` stdin does not. **This is a
  deliberate deviation from the template**, in the safe direction (a service that ends when
  its client leaves, and one that keeps running on a null device). `scripts/parity.sh`
  cannot see the difference, because it only ever runs on Linux.

Ctrl+Break is wired up since `docs/30`: `tokio::signal::windows::ctrl_break` runs next to
`ctrl_c` and ends the same way, because the operator starts the bridge from a console and
`Strg+Untbr` is the second signal that console produces. The line for a console interrupt
is `received SIGINT`, not `received SIGTERM` — claiming a signal the platform does not
have would be a lie in the journal.

### Installing the start path

A scheduled task and not a service: the bridge speaks to the operator's Firefox, and
Firefox and pi run in the operator's session. A Windows service runs in session 0 and would
see neither the browser nor the desktop. So: `AtLogOn`, `InteractiveToken`,
`LeastPrivilege` — no Administrator prompt, no password, no elevation.

The binary lives in `%LOCALAPPDATA%\browser-control\` — that directory belongs to the
account, needs no elevation, and Task Scheduler expands the variable in the session it
starts the task in. `%ProgramFiles%` would need Administrator rights to write.

In `cmd.exe`, as the account that will run the bridge, from the repository root:

```bat
mkdir "%LOCALAPPDATA%\browser-control"
copy bridge-rs\target\x86_64-pc-windows-gnu\release\browser-control-bridge.exe "%LOCALAPPDATA%\browser-control\"
schtasks /Create /TN browser-control-bridge /XML deploy\windows\browser-control-bridge.xml
schtasks /Run /TN browser-control-bridge
```

Undo — the bridge and the task, in that order:

```bat
schtasks /End /TN browser-control-bridge
schtasks /Delete /TN browser-control-bridge /F
```

What the task deliberately does **not** do:

- **No restart on failure.** Exit `2` is "token file missing or too short", and no restart
  heals that; the Linux unit pins the same decision with `RestartPreventExitStatus=2`.
- **No second instance.** `MultipleInstancesPolicy=IgnoreNew`: a second logon with the task
  still running does nothing, instead of a second bridge that would fail on the port and
  leave two processes behind.
- **No environment.** The token file is the default
  `%USERPROFILE%\.config\browser-control\token`, so `BC_TOKEN_FILE` is not needed. `BC_LOG`,
  `BC_BIND` and `BC_HTTP_PORT` follow their defaults (`info`, `127.0.0.1:8110`, `8111`).

Success looks like this: `schtasks /Query /TN browser-control-bridge /V /FO LIST` says
`Running`, and `Get-Process browser-control-bridge` names the PID. `schtasks /Query /XML`
shows `%LOCALAPPDATA%` unexpanded — that is the stored form, not a broken path.

One property of that start path is worth knowing before it surprises anyone: **Task
Scheduler discards stdout and stderr.** Under the task there is no journal, so the two
`listening on …` lines and the owner line of a failed bind are simply gone. Diagnosing a
task that does not work therefore means starting the same binary by hand in a console —
`%LOCALAPPDATA%\browser-control\browser-control-bridge.exe --http` — and reading what it
writes.

**Measured for this stage:** the cross-build and clippy for `x86_64-pc-windows-gnu`, the
`PE32+` file type, and the four unit cases in `src/platform/windows.rs` (which are
compiled for the Windows target, not run there). **Not measured:** `GetExtendedTcpTable`,
`GetFileType`, `ctrl_c` and the task import on a real Windows machine — `docs/38`,
`## Bekannte Lücken` says so, and `docs/30` criterion 1 is the operator's check. A quick
first measurement: start the bridge twice (once by hand, once through the task) — the
second start must print `port 127.0.0.1:8110 in use, owner pid=<pid> name=<name>` with the
first process' PID, not `Besitzer nicht ermittelbar`.

## Checking the build

```bash
file -b bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge
file -b bridge-rs/target/x86_64-pc-windows-gnu/release/browser-control-bridge.exe
```

The first should report `statically linked` (or `static-pie linked`), the second
`PE32+ executable (console) x86-64`.
