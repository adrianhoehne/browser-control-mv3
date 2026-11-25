# Contributing

Short version: this project is spec-driven. The spec comes before the code, it
passes a review gate, and only then is anything built. If you want a change,
write a spec in `docs/` first.

## Prerequisites

- **Node ≥ 22** (`package.json`, `engines.node`) for the tests, the syntax check
  and the parity run. There are **no** dependencies — no `npm install` needed.
  The product itself is **not** JavaScript any more: the bridge is
  `bridge-rs/`, a statically linked binary (`docs/38`). Node is a tool here, not
  a runtime.
- **Rust** (`rustup`) for `cargo test`, `cargo build` and `cargo clippy`, with the
  targets `x86_64-unknown-linux-musl` and `x86_64-pc-windows-gnu`.
- Firefox to try the extension (see `INSTALL.md`).
- For live measurements: your own browser, your own token, your own machine.
  None of that is in the repo.

## Tests and checks

```bash
npm test; echo $?       # 0; the output contains "^# fail 0" AND "^# cancelled 0"
npm run check; echo $?  # 0 — node --check over every .js/.mjs
npm run test:coverage; echo $?   # 0 — Zeilenabdeckung der Erweiterung, Schwelle 90 %
cargo test --manifest-path bridge-rs/Cargo.toml -- --test-threads=1; echo $?   # 0
```

`npm test` runs with `--test-concurrency=1 --test-timeout=90000`: a file that
hangs fails after 90 s instead of holding the run open. `--test-threads=1` in the
Rust run is the same rule for the other suite: the cases that start a real bridge
must not share a machine with each other. **The two suites and
`scripts/parity.sh` never run at the same time** — the parity run owns ports
`18115`/`18116`.

**A proof needs a case name.** `grep -c '^ok [0-9]* - '` without a name is
vacuously green — Node counts the file line `ok 1 - test/…` too. Always write
`grep -cE '^ok [0-9]+ - <name>'`, and pin the expected number.

## The loop: one increment

1. **Spec.** `docs/NN-short-description.md` with frontmatter (`description`,
   `status: proposed`) and the mandatory sections from `docs/README.md`. No code
   before the spec. If a question cannot be answered, it goes to
   `## Open questions` — nothing is guessed.
2. **Agreement.** Present the goal and `## Acceptance criteria` to the operator
   and wait for their OK. Without that agreement no dev plan is written.
3. **Dev plan.** A staged plan (build order, files, proof per stage) comes from
   someone other than the spec author and is inserted into the spec.
4. **Spec review — gate.** A reviewer checks the spec against a checklist. Only a
   `✅ Ship it` opens the gate; `🔧 Fix these` and `🤔 Needs a rethink` block it.
   **After the third block the spec is too big** — split it, do not wave it
   through.
5. **Implementation.** One stage per assignment. The implementer respects the
   touch boundary, runs the acceptance commands itself and never commits.
6. **Code review — gate.** The diff is checked against the spec. Without
   `✅ Ship it` there is no commit; the finding goes back to the **same**
   implementer with the **same** spec. Repeated blocking means the increment is
   too big: split the stage.
7. **Acceptance and commit.** The orchestrator reads the diff, runs the
   acceptance commands, checks each criterion and only then commits. They keep
   `docs/README.md` (the `Status` column) and `docs/PROJECT-STATE.md` up to date.
   The last stage sets the spec to `status: active` and describes the current
   state.

**A report is a report, not proof:** nothing is accepted on prose.

## Roles

| Role | May | May not |
|---|---|---|
| **Orchestrator** | write and cut specs, accept, commit, maintain docs | write production code |
| **Implementer** | write code and tests, run the acceptance commands | change the spec, commit, review their own work |
| **Reviewer** | check spec and diff, give a verdict | change anything |

One writer per working tree. Parallel work only in separate worktrees; reviews
may overlap.

## Acceptance

These commands must be green before every commit:

```bash
npm test; echo $?                    # 0, contains "^# fail 0" and "^# cancelled 0"
npm run check; echo $?               # 0
npm run test:ci; echo $?             # 0 — the CI workflow cases and the E2E seam
cargo test --manifest-path bridge-rs/Cargo.toml -- --test-threads=1; echo $?   # 0, "^test result: ok"
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl; echo $?   # 0
bash scripts/parity.sh --impl rust --check; echo $?   # 7/7 wie erwartet, 0
bash scripts/bundle.sh; echo $?      # 0 — before test:bundle, which reads the zips
npm run test:bundle; echo $?         # 0, 9 cases
git grep --untracked -nE '[0-9a-f]{32,}' -- . ':(exclude)bridge-rs/Cargo.lock'   # no output, exit 1
git grep -nE '[0-9a-f]{32,}' -- bridge-rs/Cargo.lock | grep -v 'checksum = "'   # no output, exit 1
# Two commands, one reason: Cargo.lock carries 64-character crate checksums, and a
# blanket exclusion would make the one file where a pasted token hides invisible.
# The first command covers the repository, the second covers the only file we
# exclude from it — minus the lines that are structurally checksums.

```

`bash scripts/ci-local.sh` runs the `unit` and `bundle` jobs of the CI workflow in
one go, in the order that matters (builds, then tests, then `bundle.sh` before
`test:bundle`); `node scripts/e2e/run.mjs` is the blackbox half and needs Firefox.
Both are described in `docs/40-ci-ablauf.md`.

Plus the criteria of the spec at hand. Where a criterion can only be decided in
a real browser, the spec says so and the operator ticks it off.

No commit without green acceptance **and** a `✅` from step 6.

## Touch boundary

- **No patching foreign code.** Adjustments to third-party behaviour go through
  your own wrapper in front of it — never through `node_modules`, a vendored
  package or a downloaded source.
- **No tokens, secrets or credentials in the repo** — not in tests, examples or
  logs either. A test that needs one reads it from the environment.
- **Never edit generated artefacts by hand.** What a build produces is produced
  by the build.
- Files that belong to another increment are left alone.

## Language

- **Specs and internal docs: German.** That is the project's working language.
- **Public files: English** — `README.md`, `INSTALL.md`, `CONTRIBUTING.md`,
  `LICENSE`.
- **Section names stay English** where a check script reads them:
  `## Testing`, `## Acceptance criteria`, `## Dev plan`, `## Open questions`,
  `## Additional dependencies`, `## Dependency changes`.
- **Code: English** — identifiers, comments, file names.
- **Visible text: English** in the extension's own options page (since
  2026-11-15; the project is public) and in everything the agent reads: tool
  descriptions, tool results and refusals (since 2026-11-22, `docs/54`).
  **German** stay the log lines on the operator's console, the specs and this
  file; text that appears towards a web page follows the page. One exception:
  the browser's own localized error text, appended verbatim by the
  `*_with_message` builders (`docs/54`, `## Bekannte Lücken`).

## Rules

- **Do not invent requirements.** Unclear points are asked about or noted under
  `## Open questions`.
- **One spec, one increment.** Several changes are several specs.
- **No new dependencies without asking first.**
- **The browser belongs to the operator.** The agent works in its own tab and
  hands it back as soon as the operator steps in; logins, two-factor and passkeys
  are the operator's job.
- **Clean up by PID, never by pattern.** `pkill -f browser-control-bridge` also
  kills the operator's running service: a probe process started by hand has
  exactly the same command line (`…/browser-control-bridge --http`). This
  happened on 2026-11-17 (`pkill -f bridge.mjs`, the Node entry point of the
  time) and took the bridge down mid-increment. Kill the PID you started —
  `$!`, `kill $PID`, or the PID from `ss -ltnp`; for the service use
  `systemctl --user stop browser-control.service`.

## References

- Spec format and registry: `docs/README.md`
- Installation (token, bridge, extension): `INSTALL.md`
- Project state: `docs/PROJECT-STATE.md`
