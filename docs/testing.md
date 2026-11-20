# Running tests

Use pinned Bun 1.4.4 and locked dependencies. Git, Python 3, and Bash are needed
for real-repository, PTY, and Bash completion fixtures. The suite does not start
Zsh or Fish.

```bash
bun run test                             # all files, isolated workers
bun run test tests/done-*.test.ts        # a subset
bun run test:serial                      # one process, for debugging
bun test --changed=origin/main           # only files affected by your branch
```

`bun run test` is `bun test --parallel --timeout=30000`. Bun starts one isolated
worker per CPU core; each file gets a fresh global, module registry, environment,
and preload. Tests within a file stay sequential. Do not add `--concurrent` or
`--no-isolate`: tests change environment variables and mocks.

The 30-second per-test timeout exists because spawn-heavy tests can exceed Bun's
5-second default on a loaded machine. Bun 1.4.4 ignores a `timeout` key in
`bunfig.toml`, so the flag lives in `package.json`. Subprocess hang guards in
tests use 30 seconds for the same reason; keep short limits only where a test
checks a deadline itself.

## Keeping the suite small

The suite is CPU-bound: most cost is temporary Git repositories and CLI spawns.
Before adding a test:

- Put per-case logic in an in-process unit test. Use a real-repository CLI test
  only for behavior that needs real Git state and the full command path.
- Do not add a `test.each` row through the CLI when the new row takes the same
  code path as an existing one. Name the code path the row covers in review.
- Keep each test file under about 10 seconds when run alone; split slow files by
  theme and share fixtures through `tests/helpers/`.
- Never wait on a fixed sleep for something you can observe.

The protections in `AGENTS.md` (Git mutations, local-work preservation for `done`)
keep at least one real-repository test each.

## Manual VS Code terminal smoke

Automated tests cover the VS Code integration with a simulated extension host.
Before calling it supported, run this by hand on Linux x86_64 with a local VS
Code and record the VS Code version and results:

1. `bun run package:extension`, then
   `code --install-extension vscode-extension/timber-terminals-0.1.0.vsix`.
2. In a scratch repository, configure `[editor]` with `command = "code"`,
   `args = ["--new-window"]`, `enabled = true`, `integration = "vscode"`, an
   enabled `[agent]`, and a `post_create` hook that prints and sleeps.
3. `timber-dev new smoke-one`: a window opens on the new worktree with
   `Timber setup` and `Timber agent` terminals, both in that worktree. Both stay
   open at a shell prompt after their task ends.
4. Repeat with `wait_for_setup = true` and a failing hook: no agent terminal
   starts, and Timber prints the setup retry.
5. Uninstall or disable the extension: Timber stops before creating terminals
   and prints the install hint and a retry.
6. Check `/tmp/timber-vscode-$(id -u)` is mode 0700 and empty afterwards.

## CI

CI runs one `check` job on every push and pull request: typecheck, `bun run test`
once, then the build and standalone release checks. Windows CI runs its
focused source tests on every pull request that changes more than docs. The slower
standalone `.exe` acceptance runs on `main`, on demand, and for releases.
