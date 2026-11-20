# browser-control

A Firefox extension drives your **visible, logged-in browser**, and a small
bridge exposes that browser as an **MCP server** for agents. The agent works in
its own tab — one you can watch — with your logins, your cookies and your
profile. No headless browser, no second profile, no automated login.

```
Agent  ──MCP over HTTP──▶  Bridge (Node)  ──WebSocket──▶  Firefox extension
        (bearer token)     127.0.0.1:8111                  agent tab
```

The extension dials **out** to the bridge. That is why the bridge needs no
inbound port, and why the agent can only see tabs it created itself.

## What it does

**Thirteen tools**, all with the `browser_` prefix:

| Tool | Purpose |
|---|---|
| `status` | windows and tabs as JSON, agent tabs marked |
| `navigate`, `read` | open a page (waits for it to settle), read its content as text |
| `click`, `type`, `focus` | interact, type, bring the tab to the front |
| `inspect` | query the DOM, selector and attributes |
| `open_tab`, `close_tab` | manage agent tabs (at most five) |
| `eval` | run code in the page context (**off by default**) |
| `screenshot` | the visible part of the tab (**off by default**) |
| `frames` | list and address iframes |
| `transcript` | a YouTube transcript as segments with timestamps, in the video's original track |

Plus: settle detection instead of fixed sleeps, shadow DOM and frames,
persistence across a background tab, and a log that does not copy page text.

## Security

- **One token**, kept on the operator's filesystem and never in the repo; the
  bridge checks it on every MCP request.
- **Loopback only.** The MCP port is bound to `127.0.0.1` and does not belong
  behind a public proxy.
- **Three switches**, all off by default: password fields, code evaluation,
  screenshots. The agent never flips them itself.
- **The agent only sees its own tabs.** It does not drive yours.

### What the extension may do, and what it does

A signed build ships with these permissions. The right column is the promise that
comes with them.

| Permission | Allows | What this extension does with it |
|---|---|---|
| `<all_urls>` (host access) | reach any page the operator opens | reads and drives **only the agent tab**, never the operator's tabs; the filter is in the code |
| `scripting` | run code in pages | injects `page-agent.js` only, only into the agent tab, only on a tool call |
| `tabs` | list, focus, close tabs | manages the agent tab and keeps the bridge tab alive |
| `storage` | local settings | the endpoint, the token and three switches |
| `webRequest` | observe requests | watches `youtube.com/api/timedtext` to capture the signed caption address; blocks nothing |

**Data transmission:** the extension sends page text, DOM results and — only with
its own switch — screenshots to the bridge address the operator configures. It
sends nothing to Mozilla and nothing to any third party. There is no analytics,
no telemetry and no remote code fetched by the extension.

## Quick start

**Portable, no installation.** Download the zip of your platform
(`browser-control-<version>-linux-x86_64.zip` or
`browser-control-<version>-windows-x86_64.zip`), unzip it anywhere, and run
`start.sh` (Linux) or `start.cmd` (Windows). That window shows the endpoint, the
MCP address and the token, and the folder holds the two guides `FIREFOX.md` and
`CLIENTS.md`. Nothing is installed, nothing is written outside that folder, and
the token is created in `data/token` on the first start.

The full guide is **[INSTALL.md](INSTALL.md)**: token file, bridge as a systemd
user service, loading the extension. A reverse proxy is optional and covered at
the end.

Short version for one machine without a proxy:

```bash
# 1. server side: token file, systemd user unit, service start — one command
cd ~/browser-control
./scripts/install.sh

# 2. extension: about:debugging#/runtime/this-firefox → "Load Temporary Add-on…"
#    → pick extension/manifest.json, then paste the token under Preferences.
#      The endpoint is pre-filled with ws://127.0.0.1:8110.
```

`./scripts/install.sh --dry-run` shows what the first step would do without writing
anything. The manual equivalent — `openssl rand -hex 32` for the token, `cp` of the
unit plus `systemctl --user enable --now` — is in [INSTALL.md](INSTALL.md)
sections 2 and 3, for when you want to see or change a single step.

The extension is **unsigned**. After a Firefox restart it is gone and has to be
loaded again; signing through AMO is not set up.

## Development

There are **no dependencies** — Node ≥ 22 is enough:

```bash
npm test        # 757 cases, TAP output, ~95 s
npm run check   # node --check over every .js/.mjs
./scripts/package.sh   # builds dist/browser-control-<version>.xpi (unsigned)
./scripts/bundle.sh    # builds both portable zips into dist/ (needs built binaries)
npm run test:bundle    # the zip cases; not part of `npm test` (it needs a built binary)
```

How changes happen (spec → gate → dev plan → review → acceptance) is described
in **[CONTRIBUTING.md](CONTRIBUTING.md)**; the design and measurement history
lives in [`docs/`](docs/README.md) — 34 specs, each with its measurements and the
decisions that followed.

## Known limits

- **Unsigned**: temporary load, again after every Firefox restart. An unsigned
  XPI (`./scripts/package.sh`) keeps it installed only in Developer Edition,
  Nightly or ESR with the signature check switched off — see `INSTALL.md` §4.
- **Windows** is only partly covered (`docs/29`, `docs/30`).
- **YouTube labels can lie**: `browser_transcript` reads the track YouTube calls
  the original; language detection is deliberately out of scope.
- **One operator, one browser**: the bridge serves the extension that is
  connected.

## License

[MIT](LICENSE).
