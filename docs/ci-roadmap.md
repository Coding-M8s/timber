# Timber CI roadmap

Team discussion brief • 18 October 2026

Companion to the [Arena and future workflow roadmap](arena-workflow-research.md). These tickets cover repository quality gates for the Bun CLI. They use their own numbering and do not change Arena tickets 1–10, documentation tickets 11–12, or release tickets 13–17.

## Recommendation

Keep the current GitHub Actions path: frozen install, TypeScript check, `bun test`, bundle, `--help`, release binary, checksums, and a runtime-free Docker smoke. Add the pieces a Laravel web pipeline uses that still fit a Bun CLI: one formatter/linter, one local command that matches CI, unused-code review, workflow lint on every pull request, and a written dependency-advisory policy.

Browser end-to-end, a second JavaScript test runner, stylesheet and template lint, and server deploy pipelines stay out. Marathon DevOps is infrastructure automation with a thin local Ansible lint. Useful habits already here, inspired by that repo's discipline: a pinned toolchain, config at the repo root, and a split between verify and publish.

The proposed gate order is informed by the reviewed AbuseIPDB CI workflow: static checks, unit and integration tests, format check, then one script that CI runs unchanged. That sequence lives in `all_tests.sh` and Bitbucket Pipelines. Timber's own equivalent should be a `bun run check` script and the existing `.github/workflows/ci.yml` job. The PHP tools remain reference points for the comparison.

## What already runs

Pull-request CI (`.github/workflows/ci.yml`) and the tag workflow (`.github/workflows/release.yml`) already do this on Ubuntu 24.04:

| Step | Command / behavior | Role |
| --- | --- | --- |
| Toolchain pin | `oven-sh/setup-bun` reads `.bun-version`; `bun install --frozen-lockfile` | Same dependencies locally and in CI |
| Types | `bun run typecheck` (`tsc --noEmit`) | Static check; PHPStan-shaped |
| Tests | `bun test` | Unit and integration, including temporary real Git repositories |
| Bundle smoke | `bun run build` then `bun dist/index.js --help` | The built entry starts |
| Release binary | `bun run build:release`, `sha256sum -c SHA256SUMS` | Standalone Linux x86_64 artifact |
| Isolated smoke | Docker image from `tests/release/Dockerfile`; container has no Bun or Node and no network | Downloaded-style execution of the binary |

Local release instructions in [releases.md](releases.md) match those source gates. `actionlint` has been run locally against both workflow files; that pass is not yet a CI job. Bash completion tests run inside `bun test` against the source entry. The extra completion run against the built executable is documented as a manual follow-up in [releases.md](releases.md).

Publication stays separate. CI permissions are read-only. The release workflow may open a draft; an owner publishes it. See [releases.md](releases.md).

## Attribution and safety

Practices below are informed by the reviewed AbuseIPDB and Marathon DevOps workflows. These references describe inspiration for Timber-specific scripts, configuration, and gates; their inclusion does not assert that the reference repositories are public or authorize reuse of their source files. Any reuse of source code or documentation requires a separate review of applicable permissions and license terms.

Those references do not relax product safety:

- Dirty, untracked, ignored, unpublished, and unproven work stays intact. CI and tests do not add a destructive force bypass.
- Git mutations in tests use temporary real repositories. Failure cases assert that files and refs remain intact.
- Git is invoked as an executable plus argument arrays. User input is not interpolated into a shell command.
- Secrets stay out of repository config, logs, tickets, workflow output, and commits. Advisory ignore lists name IDs and reasons, not credentials.
- Pull-request CI keeps read-only `contents` permission. Format and lint checks fail on drift. They do not rewrite the tree in CI.
- A new gate (Biome, Knip, `actionlint`, `bun audit`) must not weaken preservation tests or print config values, task text, or command arguments.
- Release publication stays a separate owner action, as in [releases.md](releases.md).

## Reference practices and proposed Timber adaptations

The table names the outside practice, what it protects, and the Timber behavior inspired by it.

| Existing practice | What it protects | Timber equivalent | This roadmap |
| --- | --- | --- | --- |
| PHPStan | Type and API mistakes before tests | `tsc --noEmit` | Keep |
| PHPUnit, including parallel workers and migration checks | Behavior and data safety | `bun test` with temporary repositories | Keep; add workers only if the suite gets slow |
| Vitest | JavaScript unit tests beside PHP | `bun test` | Keep Bun as the only runner |
| PHP CS Fixer and Blade formatter, CI `--check-formatting` | Consistent source | Biome check | Ticket CI-1 |
| `all_tests.sh` equals the CI script | Local and CI run the same gate | `bun run check` called by CI | Ticket CI-2 |
| Fallow dead-code and health audits, outside the blocking gate | Unused code during review | Knip, report first | Ticket CI-3 |
| Local `actionlint` evidence | Workflow files parse | `actionlint` in CI | Ticket CI-4 |
| Composer advisory ignore list | Known dependency risk, without a blocking `composer audit` step | Dependabot plus `bun audit` and an explicit ignore list | Ticket CI-5 |
| Dusk | Browser flows | — | Omit; Timber has no UI |
| Stylelint, unused SCSS, SCSS duplication, Mix production build | Front-end assets | — | Omit |
| Bitbucket deploy, ChromeDriver, migrate refresh | Server release | Release draft plus runtime-free smoke | Already split; see release tickets 13–17 |
| ansible-lint, OpenTofu plan/apply | Host and cloud changes | — | Omit |

## Proposed CI tickets

These are proposed follow-up tickets, not newly created GitHub issues. CI-1 is the first. Later rows can land independently once CI-1 and CI-2 exist.

### CI-1. Formatter and linter

**Goal:** One committed tool checks style and common bugs, the way PHP CS Fixer checks PHP in the AbuseIPDB gate.

Proposed tool: **Biome**, covering format and lint. One config at the repo root. CI runs check mode and fails on drift. A fix command stays local.

Acceptance:

- Add Biome as a dev dependency, pin it, and commit the lockfile change.
- Format and lint TypeScript, JSON, and Markdown that the project already treats as source. Leave generated `dist/` and release artifacts out.
- `bun run lint` fails when the tree would change or a lint rule fails. Document the local fix command next to the other scripts in `package.json`.
- Wire the check into ticket CI-2 and into `.github/workflows/ci.yml` and the verify job in `release.yml`.
- Record any rule disables with a reason in the config. Broad silence needs a ticket note, the same way Ansible lint skips are explicit.

If Biome cannot cover a rule the team needs, the ticket may switch to oxlint plus a formatter before merging. The outcome is still one lint command and one format check, not two competing setups.

### CI-2. One local gate

**Goal:** Developers and CI run the same sequence. AbuseIPDB documents that the CI tests are the local `all_tests.sh` tests.

Acceptance:

- Add `bun run check` that runs, in order: format/lint check, typecheck, `bun test`, `bun run build`, and `bun dist/index.js --help`.
- Pull-request CI calls that script for those steps, then keeps the release-binary, checksum, and Docker smoke steps that need CI-only layout.
- The release verify job uses the same script before `build:release`.
- Failure stops the sequence. The script does not auto-fix.
- Document the command in [releases.md](releases.md) where the local gate list lives today.

Release compilation, checksums, and the runtime-free container stay in the workflow after `check`. They are slower and depend on Docker; they remain the proof that the standalone binary runs.

### CI-3. Unused exports and dependencies

**Goal:** Fallow's dead-code pass, aimed at a CLI package: unused files, exports, and dependencies.

Proposed tool: **Knip**. First landing is a report with a baseline. Promote it to a failing check after the baseline is empty or every remaining entry has a written reason.

Acceptance:

- Knip reads the Timber entry points (`src/index.ts`, tests, scripts, package `bin`) and ignores build output.
- Document how to refresh the baseline and when a new ignore is allowed.
- CI prints the report. It fails the job only after the team marks the gate blocking.

### CI-4. Workflow and script lint in CI

**Goal:** Workflow syntax is checked on every pull request. Today `actionlint` 1.7.12 is a local-only evidence note in [releases.md](releases.md).

Acceptance:

- CI runs `actionlint` on `.github/workflows/ci.yml` and `.github/workflows/release.yml`.
- Pin the actionlint version. A local syntax pass remains useful; CI is the run that counts.
- If `scripts/` grows shell beyond the TypeScript release script, add ShellCheck for those files in the same job. Skip ShellCheck while the scripts stay TypeScript.

### CI-5. Dependency advisories

**Goal:** A visible policy for known vulnerable packages. AbuseIPDB records ignored Packagist advisory IDs and does not run `composer audit` as a merge blocker. Match that honesty: alert first, block only on advisories the policy says are unacceptable.

Acceptance:

- Enable Dependabot for Bun/npm and for GitHub Actions.
- Add `bun audit` to CI as a report. Document the ignore file and the review needed to add an ID.
- Failing the job on high-severity issues is a follow-up inside this ticket after one clean report, not an unlabeled flip.

### CI-6. Optional coverage report

**Goal:** Measure `bun test --coverage` once. Publish or archive the report if it is cheap. Do not set a coverage threshold in the first change. AbuseIPDB configures coverage and leaves it outside the blocking gate; do the same until a real gap shows up.

### Later, only with evidence

| Idea | When |
| --- | --- |
| Parallel test workers | The suite's wall time becomes the slow part of CI |
| Completion tests against the built executable inside CI | Ticket CI-2's smoke is not enough to cover the bundled completion route |
| Multi-OS and multi-arch runners | Release tickets 14–16, after a target is actually tested |
| Mutation testing | A specific suite is suspected of weak assertions |

## Omit

These belong to the web app or to host automation. They are not Timber CI work:

- Playwright, Cypress, or Laravel Dusk
- Vitest as a second runner beside `bun test`
- Stylelint, SCSS audits, Blade formatting, Laravel Mix or Vite asset builds
- ChromeDriver, migrate refresh, or deploy-to-server jobs
- Ansible Lint, Molecule, OpenTofu validate, or TFLint
- A daemon, local API, or provider plugin framework (already excluded by project guidance)

## Suggested delivery

1. CI-1 Biome check.
2. CI-2 `bun run check`, then point both workflows at it.
3. CI-4 actionlint in CI (small, independent of product code).
4. CI-3 Knip as a report.
5. CI-5 Dependabot and `bun audit` policy.
6. CI-6 coverage measurement when someone is already in the test job.

None of these wait on Arena modes, man pages, or macOS/Windows binaries. None of them replace the runtime-free release smoke.
