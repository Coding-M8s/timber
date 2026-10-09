# TIM-11 verification

Verified on Linux x86_64 with Bun 1.4.2 (`744846f84`). No other platform or standalone
release artifact is claimed. Runtime/dependency metadata was checked from npm;
the committed lockfile pins all resolved packages.

Pinned direct versions: Commander 15.0.0, Execa 10.1.0, Zod 4.6.5, smol-toml 1.9.0,
TypeScript 7.0.2, @types/bun 1.4.2. Commander declares Node >=22.12.0, Execa >=22,
and smol-toml >=18; Timber is verified with Bun, not a Node runtime target.
The compatibility suite exercises Commander parsing, Execa argument boundaries and
nonzero exits, and TOML parsing through Zod. These are bounded smoke checks, not a
claim that every dependency API or future Git operation is verified.

## Clean checkout commands and observed results

The implementation commit was cloned without reusing node_modules or build output:

```bash
git clone --no-hardlinks --branch tim-11-bootstrap /home/rafix/projects/timber /tmp/timber-tim-11-clean
cd /tmp/timber-tim-11-clean
export PATH=/tmp/timber-bun-toolchain/node_modules/.bin:$PATH
bun install --frozen-lockfile --cache-dir /tmp/timber-tim-11-clean-cache
bun run dev --help
bun run typecheck
bun test
bun run build
bun dist/index.js --help
git diff --exit-code
git status --porcelain
```

- Clean frozen install using an initially empty cache: 27 packages installed, exit 0.
- Source help: `Usage: timber [options] [command]`; all four commands labeled
  placeholders; exit 0.
- Typecheck: `tsc --noEmit`, exit 0.
- Tests: 32 pass, 0 fail, 110 assertions across 4 files, exit 0.
- Build: bundled 9 modules; `dist/index.js`, 74.13 KB; exit 0.
- Bundle help: same four placeholders, exit 0.
- Tracked diff and porcelain status: empty, exit 0; lockfile unchanged.

The `/tmp` Bun installation is test tooling only; CI installs the same pinned
version from `.bun-version`. See [Bun installation](https://bun.com/docs/installation)
and [locked installation](https://bun.sh/docs/pm/cli/install).

## Review and scope

One independent reviewer inspected the implementation, contracts, CI and lockfile,
reran typecheck/tests, and reported no blocking findings. No review fixes or
unresolved findings remain.

The test-first CLI run initially failed because the entry point was absent. The
handler suite caught Commander's default `editor: true` for omitted `--no-editor`;
normalization now leaves the editor property absent unless explicitly disabled.
Strict typecheck also caught `new(...)` being treated as a construct signature;
the handler contract now uses a named function property.

No Git engine, editor, setup hooks, agent or Jira integration has been implemented.
Real-repository mutation and preservation tests belong to the corresponding Git
implementation tickets. TIM-1 and TIM-6 can start after this PR merges; TIM-14 can
use the shared doubles while awaiting TIM-1. Remaining tickets still retain their
own prerequisites.
