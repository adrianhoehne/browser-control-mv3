# Installation

There are two halves, and they are done in this order:

1. **The server** — a token file and the bridge (sections 2 and 3).
2. **The browser machine** — the Firefox extension (section 4).

If you only do one half you get either `502` (bridge missing) or nothing at all
(extension missing). Server and browser can be the same machine; in that case
you can skip the optional Caddy section entirely.

Reference: `docs/01-skelett-verbindung-und-status.md` holds the configuration
defaults and the acceptance criteria. This file says what to type.

## The shortest path: the portable zip

No compiler, no root, no service: unzip
`browser-control-<version>-linux-x86_64.zip` (or the `…-windows-x86_64.zip`),
run `start.sh` or `start.cmd`, and follow `FIREFOX.md` and `CLIENTS.md` in that
folder. The token is created in `data/token` on the first start and kept from
then on, and nothing is written outside the folder.

Sections 2 to 4 below describe the **installed** setup: a service that survives a
logout, a proxy in front of it, and the extension loaded from the repository. Use
them when the zip is not enough.

## 1. Prerequisites

| Where | What |
|---|---|
| Server | The bridge **binary**, built with `cargo build --release --target x86_64-unknown-linux-musl` (`bridge-rs/README.md`, "Building"). `./scripts/install.sh` copies it to `~/.local/bin/browser-control-bridge` |
| Server | Linux with a systemd **user** session (recommended, not required); on Windows the Task Scheduler (section 10) |
| Build machine | Rust (`rustup`) with the targets `x86_64-unknown-linux-musl` and, for the Windows build, `x86_64-pc-windows-gnu` plus `mingw-w64` |
| Tests only | **Node ≥ 22** (`node -v`) for `npm test`, `npm run check` and `scripts/parity.sh`. There are **no** dependencies — `npm install` is not needed. The service and `/mcp` never start Node |
| Browser | **Firefox** with the profile you want the agent to use |
| Both | The extension is **unsigned**; it is loaded as a *temporary* add-on |

## 2. Server: the token

The bridge does not start without a token. If the file is missing or too short
it exits with code `2` and the line
`token file missing or too short: <path>`.

```bash
install -d -m 700 ~/.config/browser-control
openssl rand -hex 32 > ~/.config/browser-control/token
chmod 600 ~/.config/browser-control/token
```

Check it:

```bash
ls -l ~/.config/browser-control/token   # -rw------- (600)
wc -c < ~/.config/browser-control/token # 65 = 64 hex characters + newline
```

**Or skip to section 3:** `./scripts/install.sh` does this step and the service
setup in one command and keeps an existing token untouched.

The trailing newline is fine: the bridge trims the content before comparing.
That path is the default of `BC_TOKEN_FILE`; if you change it, start the bridge
with the same value.

The same value goes into the extension's options page later (section 4) — never
into a URL, never into the repo. Check:

```bash
git grep --untracked -nE '[0-9a-f]{32,}' -- . ':(exclude)bridge-rs/Cargo.lock'   # no output, exit 1
git grep -nE '[0-9a-f]{32,}' -- bridge-rs/Cargo.lock | grep -v 'checksum = "'   # no output, exit 1
```

### Rotating the token

Rotating is manual work and needs **no** code change — deliberately: there is
one operator and one service, and a rotation is rare (suspected leak, new
machine). In this order, with a short interruption:

```bash
# 1. write a new token (this replaces the old file)
openssl rand -hex 32 > ~/.config/browser-control/token
chmod 600 ~/.config/browser-control/token

# 2. restart the service — it reads the token only at startup
systemctl --user restart browser-control

# 3. enter the new value in the extension's options page and save
#    (about:addons → browser control → Preferences)
```

Between steps 2 and 3 the extension is **logged out**; it retries with backoff
and connects as soon as the new token is in its options. Doing it the other way
round has the same window in the other direction, and both are harmless: nothing
is lost.

**Remember:** a rotation touches **two** places — the file (for the bridge and
`/mcp`) and the extension's options. Change only one and you will see
`auth failed` in the bridge log.

## 3. Server: the bridge

### One command: token, unit and service

```bash
cd ~/browser-control
./scripts/install.sh
```

It writes the token (only if there is none), installs the user unit, reloads
systemd, enables and starts the service and checks that it is `active`. At the end
it prints the endpoint and the token — **once**, on stdout — together with the four
Firefox steps that remain manual work: no page and no script may touch
`about:debugging` or the extension's `storage.local`.

It needs **no root**: everything happens in your own `$HOME`, and nothing is written
outside `~/.config/browser-control/` and `~/.config/systemd/user/`.

| Option | Effect |
|---|---|
| *(none)* | install or repair, then check and say what is left to do |
| `--dry-run` | announce every step; write nothing, start nothing |
| `--print-token` | print the existing token and do nothing else |
| `--uninstall` | stop and disable the service, remove the unit; **the token stays** |
| `--help` | the options and what they do |

| Exit code | Meaning |
|---|---|
| `0` | success |
| `1` | aborted: a preflight check failed (the built binary is missing or not executable, the clone path, `$HOME`, ports `8110`/`8111`), an unknown option, the service was not `active` after the start, or a write target fell outside the allowed directories |
| `2` | the token is missing or shorter than 32 hex characters — the same code the bridge uses |

- **An existing token is never overwritten.** Rotation stays manual work (section
  2, “Rotating the token”): reinstalling must not silently log the extension out.
- **It is idempotent.** A second run changes nothing that already matches, so
  running it twice is the way to repair a setup.
- **The threshold is the bridge's:** 32 hex characters at the least. A token with
  32–63 characters is accepted with a hint; below 32 the run stops with exit `2`.

What it does is exactly the two subsections below — read them when you want to
change a single step instead of running all of them.

### Try it by hand first

The binary comes out of the build, not out of the installer:

```bash
cd ~/browser-control
. "$HOME/.cargo/env"
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl
./scripts/install.sh                  # copies it to ~/.local/bin and sets the service up
mkdir -p ~/.local/state/browser-control
nohup "$HOME/.local/bin/browser-control-bridge" --http \
  >> ~/.local/state/browser-control/bridge.log 2>&1 < /dev/null &
```

The `< /dev/null` matters, it is not decoration: when stdin ends the bridge
shuts down (that is how it disappears when an MCP client spawns it). Without the
redirect, starting it through `ssh host 'nohup … &'` hands it a pipe instead of
`/dev/null`, and it dies on the first EOF.

Check:

```bash
ss -ltn | grep 8110                # LISTEN … 127.0.0.1:8110
tail -2 ~/.local/state/browser-control/bridge.log
# 2026-…Z listening on 127.0.0.1:8110 log=info
# 2026-…Z listening on 127.0.0.1:8111 for POST /mcp
```

For a manual check that includes the tab list, start it with
`BC_LOG=debug` in front of the same command; the answer then appears as indented
JSON in the log.

Stop it by **PID**: `kill <pid>`, with the PID from `ss -ltnp | grep 8110`. For the
service, use `systemctl --user stop browser-control`. **Never** kill by pattern
(`pkill -f browser-control-bridge`): a process you started by hand has exactly the
same command line as the service, and the pattern cannot tell them apart.

### Run it as a systemd user service (recommended)

Since spec 18 the bridge runs **once** as a systemd user unit and serves MCP over
HTTP. Every client (pi and any other MCP client) shares that **one** service: no
port collisions, no orphaned bridge after a restart, and the tools are available
immediately.

```bash
mkdir -p ~/.config/systemd/user
cp ~/browser-control/deploy/browser-control.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now browser-control
systemctl --user status browser-control     # active (running)
journalctl --user -u browser-control -f     # log, including rotation
```

The service binds **fixed** addresses: `127.0.0.1:8110` (extension) and
`127.0.0.1:8111` (MCP). It does **not** look for a free port: if one is taken it
exits with `1` and a line naming the owner
(`port 127.0.0.1:8111 in use, owner pid=… name=…`).

**Session and reboot — what happens without extra work:** the unit runs in
**your** systemd (`systemctl --user`), which ends with your last session. As long
as a terminal, tmux or SSH window is open, the service keeps running. After a
reboot it starts **with your login**, not before — and that is when Firefox
starts too, so the order is right.

**Only if you want it to run without a login** (for example to work remotely
through the extension after a reboot) do this once:

```bash
loginctl enable-linger "$USER"
```

That makes the user systemd start at boot and keep running after logout — at the
price of the service running **always**, even when nobody is there. If you are
logged in most of the time you do not need it; the decision on 2026-10-23 was:
**do not set it**.

**If the service does not start and the journal says `No such file or directory`
for `%h/.local/bin/browser-control-bridge`:**
the unit runs a **statically linked binary**, so there is no interpreter and no
`PATH` involved any more — the file itself is missing. It comes from the build and
from `./scripts/install.sh`, in that order:

```bash
ls -l ~/.local/bin/browser-control-bridge            # -rwxr-xr-x
cd ~/browser-control && . "$HOME/.cargo/env"
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl
./scripts/install.sh
```

An older setup may still carry the `PATH` drop-in the Node bridge needed
(`~/.config/systemd/user/browser-control.service.d/path.conf`). It is harmless but
useless now; delete it if you want a clean unit.

### Configuration

Addresses and paths can be changed through the unit's environment
(`systemctl --user edit browser-control` → `[Service] Environment=…`):

| Variable | Default | Effect |
|---|---|---|
| `BC_BIND` | `127.0.0.1:8110` | address of the extension socket (`[::1]:8110` for IPv6) |
| `BC_HTTP_PORT` | `8111` | port for `POST /mcp` |
| `BC_TOKEN_FILE` | `~/.config/browser-control/token` | where the token lives |
| `BC_LOG` | `info` | `debug` writes each request's JSON into the journal |
| `BC_CALL_TIMEOUT_MS`, `BC_HELLO_TIMEOUT_MS` | protocol values | deadlines; change them only while debugging |

## 4. Browser: the extension

The extension is **unsigned**, so it is loaded as a *temporary* add-on. There is
no XPI to download — the source is the repo:

```bash
# from GitHub (the published state)
git clone https://github.com/adrianhoehne/browser-control-mv3.git ~/browser-control

# or over SSH from your own server, if that is where you develop
git clone <user>@<host>:browser-control ~/browser-control
```

Without git, just the extension:

```bash
mkdir -p ~/browser-control-extension
rsync -av --delete <user>@<host>:browser-control/extension/ ~/browser-control-extension/
```

Then in Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **“Load Temporary Add-on…”**.
3. **Select `extension/manifest.json`** (in the clone:
   `~/browser-control/extension/manifest.json`) — not the folder, not a single
   file.
4. Open `about:addons` in a new tab, select **Browser Control**, then select
   **Preferences**. `about:debugging` shows only “Reload” and “Remove” for a
   temporary add-on — it has no link to the settings, so `about:addons` is the
   reliable route.
5. The **endpoint** field **is pre-filled with** `ws://127.0.0.1:8110` — the
   address the bridge listens on unless you set `BC_BIND`. Leave it as it is
   while bridge and Firefox run on the same machine; change it only when the
   bridge runs on **another machine**, and then to the `wss://…` address from
   section 9.
6. Enter the token: the content of `~/.config/browser-control/token` from the
   server.
7. **Save**, then **reload the extension once** in `about:debugging` — stored
   options take effect on the next connection attempt.
8. Select the **Browser Control** icon in the toolbar to switch the extension on.
   Off by default: nothing happens until you switch it on — no tab, no socket. The
   crossed-out icon means “off”, the bridge icon means “connected”, the yellow bolt
   means “on, but the bridge does not answer”.

## Firefox permissions

Firefox offers two switches per add-on under `about:addons` → the add-on →
Permissions. Neither is needed for the tools. The first is deliberately
ignored and the second does not take effect (both measured, see the table).

| Switch | What it does | Our advice |
|---|---|---|
| **Run in Private Windows** | Lets the extension run in private windows. | Leave it **off**. The tools never touch a private window: the bridge tab is created in a normal window only, and the window list excludes private ones in three places (`background.js:453`, `:466`, `bridge.js:942`). Turning it on gains nothing and widens what the extension may see. |
| **Run on sites with restrictions** | Meant to let the extension work where Mozilla restricts add-ons, e.g. `addons.mozilla.org`. | **No effect here, measured.** With the switch on and Firefox restarted, `read`, `inspect`, `eval` and `click` still answer `page_not_readable` on `addons.mozilla.org`; only `navigate` works, because navigating needs no injection. Leave it off unless you want it for another reason. |

The four permissions the manifest declares are `tabs`, `storage`, `webRequest`
and `scripting`, plus `<all_urls>` as host access. `scripting` is what carries the
page agent; without it seven of the thirteen tools and the settle wait fall away.

The extension ID is fixed (`browser-control-mv3@bergkaese.dev`), so endpoint and
token stay in `storage.local` across reloads. **After a Firefox restart** the
extension is gone and has to be loaded again — the settings survive.

Since spec 34 the manifest also carries **`webRequest`**: after the reload,
`about:addons` lists the observation of network requests as an additional
permission. It is what lets `browser_transcript` record the signed address of a
subtitle track.

Updating when the repo changes:

```bash
cd ~/browser-control && git pull
```

… then **Reload** in `about:debugging`. A changed manifest needs no second step;
the new permission appears in `about:addons`.

### Build an XPI and keep the add-on across restarts

A temporary add-on is gone after a Firefox restart. An **XPI** survives that —
but release Firefox installs only **signed** XPIs, and this one is unsigned. It
therefore works in the builds where the signature check can be switched off
(Developer Edition, Nightly, ESR).

```bash
./scripts/package.sh              # writes dist/browser-control-<version>.xpi
./scripts/package.sh --out-dir ~/xpi   # or somewhere else
```

The script needs nothing but `zip`. It reads the version from
`extension/manifest.json`, puts `manifest.json` at the archive's **root**, keeps
dotfiles out, and refuses to write an archive Firefox would reject.

1. In Developer Edition, Nightly or ESR: `about:config` →
   `xpinstall.signatures.required` = `false`.
2. `about:addons` → gear → **Install Add-on From File…** → pick the XPI.
3. Restart Firefox: the add-on is still there, and so are endpoint and token.

**Release Firefox has no such switch.** A permanent install there needs a
signature from AMO (`web-ext sign --channel=unlisted`); the manifest has been
MV3 since `docs/43`, so that is no longer the blocker — see `docs/ROADMAP.md`,
rows 23 and 24.

## 5. Check it end to end

**1. The seam, in the bridge log:**

```
2026-…Z extension connected peer=127.0.0.1 protocol=1
2026-…Z status windows=<n> tabs=<m>
```

Expect every tab of the default container, **no** tab from a multi-account
container and none from a private window.

**2. The MCP endpoint** (without printing the token):

```bash
TOKEN=$(cat ~/.config/browser-control/token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:8111/mcp \
  | grep -o '"name":"browser_[a-z_]*"' | wc -l        # must be 13
```

**3. A first call:** ask a client for `browser_status`; it returns windows and
tabs as JSON, agent tabs marked with `agent: true`.

## 6. Tools and the three switches

**Thirteen** tools, all with the `browser_` prefix: `status` (windows and tabs as
JSON, agent tabs marked `agent: true`), `open_tab` (creates an agent tab, at most
five), `close_tab`, `navigate`, `read`, `click`, `type`, `focus`, `inspect`,
`eval`, `screenshot`, `frames` (iframes of the tab) and `transcript` (subtitles
as segments with timestamps).

**Three behaviours are off by default** and answer with a named error until you
enable them (`eval_not_allowed`, `screenshot_not_allowed`, password field
refused). The switches live in the extension's preferences:

| Switch (key) | What it allows |
|---|---|
| “Allow password fields” (`allowPasswordFields`) | `browser_type` may fill `input[type=password]` |
| “Allow code evaluation” (`allowEval`) | `browser_eval` runs code in the agent tab — including `document.cookie`, `localStorage` and `fetch` with the profile's cookies; also lifts the password-field block |
| “Allow screenshots” (`allowScreenshot`) | `browser_screenshot` captures the visible part of the agent tab — the logged-in profile |

A change takes effect immediately (the value is read on every call). The agent
never flips these switches itself; that is the operator's decision.

## 7. MCP client configuration

Every MCP client that speaks streamable HTTP and can send an `Authorization`
header:

```json
{
  "mcpServers": {
    "browser-control": {
      "url": "http://127.0.0.1:8111/mcp",
      "headers": { "Authorization": "Bearer ${BROWSER_CONTROL_TOKEN}" }
    }
  }
}
```

The token comes from the **environment** (`BROWSER_CONTROL_TOKEN`); it is the
same one that sits in `~/.config/browser-control/token`. A client that does not
expand the variable sets it in its own configuration.

That is how it looks for pi (`~/.pi/agent/mcp.json`, under `mcpServers`):

```json
{
  "mcpServers": {
    "browser-control": {
      "url": "http://127.0.0.1:8111/mcp",
      "headers": { "Authorization": "Bearer ${BROWSER_CONTROL_TOKEN}" }
    }
  }
}
```

### Fallback: stdio (the old entry stays valid)

Clients that can only spawn a process start the bridge themselves:

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "/home/<you>/.local/bin/browser-control-bridge"
    }
  }
}
```

An **absolute** path, spelled out: most clients do not expand `~` in `command`, and
the bridge then fails to start with no useful message. Without `--http` it does not
bind `8111`; the extension socket on `8110` stays.

This path does **not** run next to the service: port `8110` would be taken twice
and the spawned bridge exits with `1`. For stdio, stop the service first
(`systemctl --user stop browser-control`).

**`/mcp` is loopback-only and must never be published through a proxy.** Whoever
exposes that port hands the world an entry to the logged-in Firefox plus its
token.

## 8. Troubleshooting

| Symptom | Look here |
|---|---|
| `No such file or directory` for the binary in the journal | the binary was never installed — build it and run `./scripts/install.sh` (section 3) |
| `env: node: No such file` in the journal | an old unit from before the Rust port; replace it: `cp ~/browser-control/deploy/browser-control.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user restart browser-control` |
| `status windows=… tabs=0` | Firefox has no agent tab yet; `browser_navigate` creates one |
| Nothing in the log, no `extension connected` | **first** the switch in the toolbar: a crossed-out icon means off, and that is the normal state after loading the extension. Then the extension console (`about:debugging` → “Inspect”), not the page console: `bc: background page started`, `bc: endpoint invalid: …`, or nothing at all. Silence after a switch-on usually means: the token is empty, or step 4.7 (the reload) was skipped |
| `auth failed` in the bridge log | the token differs between file and extension options — section 2, “Rotating the token” |
| `502` from a proxy | bridge not listening, or the upstream is `localhost` instead of `127.0.0.1` — section 9 |
| `bc: ws:// ist nur für 127.0.0.1 erlaubt …` in the extension console | the endpoint names another machine over plain `ws://`, and the extension refuses that dial on purpose. Use `wss://` through Caddy, or the SSH tunnel in section 9 |
| Tools missing in the client | the service or the extension still runs the old code: restart it / reload the extension |

## 9. Optional: a public endpoint via Caddy

Only needed if the browser is on a **different** machine than the bridge and you
want the connection to cross the network. Everything above works without Caddy
(plain `ws://127.0.0.1:8110`). If only **your own** browser has to reach the
bridge, skip the certificate and use the SSH tunnel at the end of this section.

The extension connects to `wss://example.com/browser-control/ws`; Caddy
terminates TLS and forwards to the bridge on `127.0.0.1:8110`. The site block
serves basic auth today, and a browser `WebSocket` cannot set an
`Authorization` header — so the path has to sit outside the auth.

The shape matters: **one `handle` alone is not enough.** In Caddy's directive
order `basic_auth` runs before `handle`, so a site-wide auth also runs before the
WS branch; two `handle` blocks below it change nothing. The auth has to move
**into the second `handle`**; then the branches exclude each other (same group,
first match wins) and the WS branch comes first:

```
example.com {
    # the extension authenticates with the token in the hello frame
    handle /browser-control/ws {
        reverse_proxy 127.0.0.1:8110
    }

    handle {
        # … your existing configuration, including basic_auth …
    }
}
```

The upstream must say **`127.0.0.1`**, not `localhost`: Caddy may resolve
`localhost` to `[::1]`, the bridge listens on `127.0.0.1` only, and the result is
a `502` while the bridge is running fine (in the Caddy log:
`dial tcp [::1]:8110: connect: connection refused`).

Validate and reload:

```bash
caddy validate --config /etc/caddy/Caddyfile   # exit 0
systemctl reload caddy
```

Check the seam without Firefox:

```bash
curl -isS --http1.1 -o /dev/null -w '%{http_code}\n' --max-time 10 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://example.com/browser-control/ws
```

`--http1.1` is mandatory, not cosmetic: curl would otherwise negotiate HTTP/2
with Caddy, and an h2 request is passed on to the h1 upstream as an ordinary
request. Firefox speaks HTTP/1.1 for `wss://` anyway.

| Output | Meaning |
|---|---|
| `101` | the seam works |
| `401` | basic auth still catches it (auth at site level instead of the second `handle`) |
| `426` | bridge alive, but it saw no upgrade request — almost always the missing `--http1.1` |
| `502` | Caddy gets through, but the bridge is not listening on the upstream |

### No certificate? Tunnel it.

A TLS certificate for a bridge on another machine is work: a domain, a port 80
challenge or a DNS record, a proxy that has to be kept running. If you only need
**your own** browser to reach **your own** bridge, an SSH tunnel does the same
job with one command and no certificate at all.

Nothing extra runs on the machine with the bridge. On the **browser machine**:

```bash
ssh -N -L 8110:127.0.0.1:8110 <user>@<server>
```

- `-N` — open no shell, just the tunnel.
- `-L 8110:127.0.0.1:8110` — local port `8110` on this machine is forwarded to
  `127.0.0.1:8110` **as seen from the server**, i.e. to the bridge.
- The command **stays open**. It is the tunnel. Run it in a second terminal, or
  keep it alive with `tmux` or `autossh -M 0 -N -L 8110:127.0.0.1:8110
  <user>@<server>` if it has to survive a dropped connection.

Then enter `ws://127.0.0.1:8110` in the extension (section 4) — the same value as
on a single machine. The extension allows plain `ws://` for loopback only, and
that is exactly what it sees: the traffic leaves the browser towards `127.0.0.1`,
and SSH encrypts it from there to the server. The token travels inside the
tunnel. If the extension refuses the dial with
`bc: ws:// ist nur für 127.0.0.1 erlaubt`, the endpoint still names the remote
machine instead of the tunnel.

Two limits worth knowing: the tunnel is per machine and per login — it replaces
a certificate for **your** browser, not for several clients that should reach the
same bridge. And it does not make the bridge reachable for anyone else; the
bridge keeps listening on the server's loopback only.

If nothing connects, check whether the tunnel is listening at all:

```bash
ss -ltn | grep 8110     # a line with 127.0.0.1:8110 means the tunnel is up
```

An empty answer means the `ssh` command is not running (or died) — the
extension is then dialling a port nobody holds, and the bridge log stays silent
because no connection ever arrives.


## 10. Windows: the binary and the Task Scheduler

Everything above describes a Linux host. On Windows the bridge is the same program
as `browser-control-bridge.exe`: no systemd, no WSL, no service wrapper.

1. **Build it** (on the machine or cross-compiled on Linux):

   ```bash
   cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-pc-windows-gnu
   ```

   The result is `bridge-rs/target/x86_64-pc-windows-gnu/release/browser-control-bridge.exe`.

2. **Copy it to the place the task expects** (`%LOCALAPPDATA%\browser-control\` —
   the operator's own directory, no admin rights involved). Repeat after every
   rebuild:

   ```powershell
   New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\browser-control"
   Copy-Item bridge-rs\target\x86_64-pc-windows-gnu\release\browser-control-bridge.exe "$env:LOCALAPPDATA\browser-control\"
   ```

3. **Write the token** (section 2, same path under `%USERPROFILE%`). Do **not** use
   PowerShell's `>`: it writes UTF-16 with a BOM, and the bridge needs plain hex.

   ```powershell
   $d = Join-Path $env:USERPROFILE ".config\browser-control"
   New-Item -ItemType Directory -Force $d | Out-Null
   $bytes = New-Object byte[] 32
   [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
   -join ($bytes | ForEach-Object { $_.ToString("x2") }) | Set-Content -NoNewline (Join-Path $d "token")
   ```

   Spelled out instead of `[Convert]::ToHexString`: that method exists only from
   PowerShell 7 on, and the older Windows PowerShell 5.1 is what ships with Windows.

4. **Try it in a console first** — the console is the normal case, the task is the
   comfortable one:

   ```powershell
   & "$env:LOCALAPPDATA\browser-control\browser-control-bridge.exe" --http
   ```

   Two lines appear (`listening on 127.0.0.1:8110 log=info` and
   `listening on 127.0.0.1:8111 for POST /mcp`), **stdout stays empty**, and
   `Ctrl+C` ends it with `received SIGINT, shutting down` and exit `0`.

5. **Register the scheduled task** — `AtLogOn`, `InteractiveToken`,
   `LeastPrivilege`, no restart on failure (the equivalent of
   `RestartPreventExitStatus=2`: a missing token heals no restart):

   ```powershell
   schtasks /Create /XML "$env:USERPROFILE\browser-control\deploy\windows\browser-control-bridge.xml" /TN browser-control-bridge
   schtasks /Run /TN browser-control-bridge
   schtasks /Query /TN browser-control-bridge /FO LIST     # Status: Running
   ```

6. **Check it** like section 5, with `curl` from PowerShell:

   ```powershell
   $t = Get-Content "$env:USERPROFILE\.config\browser-control\token" -Raw
   curl.exe -s -X POST -H "Authorization: Bearer $t" -H 'Content-Type: application/json' `
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:8111/mcp
   ```

   The extension uses `ws://127.0.0.1:8110` (section 4) — the local default, no
   Caddy needed on a single machine. Stop the task with
   `schtasks /End /TN browser-control-bridge`.

**What is measured and what is not:** the Windows build is compiled
(`docs/38`, stage 3) and the pure decoding of the port owner is tested on Linux;
the Task Scheduler definition, `GetExtendedTcpTable` and `GetFileType` at runtime
are the operator's measurement. `bridge-rs/README.md` (`## Windows`) lists the
four probes.

## Not covered

- **Signing and XPI distribution** — the extension is temporary; after a Firefox
  restart it has to be loaded again.
- **The stdio fallback next to the service** — port `8110` would be taken twice
  (see section 7); either the service or stdio.
- **Token rotation across several machines** — one token, one extension; whoever
  replaces it has to change it on both sides.
- **Reloading the extension automatically after an option change** — hence step
  4.7.
