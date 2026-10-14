# Building and verifying Timber releases

The initial artifact is a Linux x86_64 executable, built with Bun 1.4.2 and
locked dependencies. Users need installed Git and, only when configured, their
editor/agent/hook tools. Bun, Node, Python, and Docker are not Timber runtime
dependencies. Python 3.10+ and Docker are verification tools.

The verified standalone environment is Ubuntu 24.04 x86_64, glibc 2.39, and Git
2.43.0. This is a tested environment, not a claim that every Linux distribution
or older Git version works. No macOS, Windows, ARM, or musl/Alpine artifact is
supported yet. Older Git may lack the virtual-merge operation used to prove
squash/rebase integration; unavailable proof fails closed rather than allowing
unsafe cleanup.

## Build and local gates

From the source checkout:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun dist/index.js --help
bun run build:release
(cd dist/release && sha256sum -c SHA256SUMS)
```

The existing `build` command creates a Bun JavaScript bundle. `build:release`
creates these additional files:

| Asset | Purpose |
| --- | --- |
| `timber-v<VERSION>-linux-x64` | Standalone executable; name follows `package.json` |
| `build-info.json` | Version, optional tag, source commit, dirty-source marker, Bun version, compile target |
| `SHA256SUMS` | SHA-256 digests for executable and build metadata |

`bun run build:release --outdir /absolute/temporary/output` builds into an
alternate directory. Untagged development builds may contain uncommitted changes;
`sourceDirty: true` explicitly marks that limitation. They do not establish a
verified tagged release. The build includes no wall-clock timestamp or environment
dump. Repeating the build with the same source/toolchain produces identical bytes
in the recorded local verification; check hashes again for each release.

The executable bundles its runtime and dependencies. Its build disables automatic
`.env` and `bunfig.toml` loading. Export credentials into the invoking process;
Timber itself reads only primary-root `.timber.toml`. Bun's source runner has
different autoload defaults; use `bun --no-env-file` for source invocations.
See the [behavioral contract](cli-contract.md) for configuration and safety.

## Verify without Bun or Node installed

Docker builds the verifier from a pinned Ubuntu base. The image contains Git,
CA certificates, Python, and the two verification scripts; it contains no product
source or JavaScript packages. The executable is mounted read-only, and the test
container runs with networking disabled. Local disposable bare remotes exercise
remote behavior.

For the current development version:

```bash
docker build -f tests/release/Dockerfile -t timber-release-smoke .
docker run --rm --network none \
  --mount "type=bind,src=$PWD/dist/release,dst=/release,readonly" \
  timber-release-smoke \
  --binary /release/timber-v0.1.0-dev.0-linux-x64 \
  --expected-version 0.1.0-dev.0 --require-no-runtime
```

Change both version arguments intentionally when the package version changes.
The verifier exits nonzero on any failed assertion and prints one JSON result
with OS, architecture, libc, Git version, executable version, and SHA-256 on
success. `--require-no-runtime` checks that Bun, Node, and npm are absent.

Without Docker, `python3 scripts/smoke-release.py --binary <absolute-path>
--expected-version <version>` runs the same workflows on the host. This is useful
diagnostic evidence but does not prove a runtime-free environment.

The core acceptance group exercises help/version, all four commands, nested and
linked discovery, local/remote materialization, offline reopen, published and
integrated cleanup, and file/ref preservation after refusals. The integration
group exercises real shell hooks and retry, literal launch arguments, foreground
agent exits/interrupts, CI behavior, and retained-state startup failures.
Ignored-file defaults and runtime autoload isolation are checked explicitly.

Jira exact lookup, active/completed status, suggestions, pagination, and HTTP
failure behavior remain covered by the source suite with mocked HTTP transport.
The standalone smoke checks missing credentials and literal/offline behavior.
Neither is described as a successful live Jira exercise. A separately performed
live Jira check records only safe outcomes, never credentials, tokens, response
bodies, or sensitive titles.

## Tagged release workflow

Git and GitHub write operations are owner-controlled. Implementing these files
does not create tags, push code, create PRs, or create/publish GitHub releases.
The workflow will create a draft only after an owner deliberately pushes a tag
to a repository containing the workflow.

1. Choose the actual source commit and release version. Set `package.json`
   deliberately before owner integration/tagging. Only exact `vMAJOR.MINOR.PATCH`
   or `vMAJOR.MINOR.PATCH-rc.N` tags are accepted; development versions are not.
   The tag must already exist, resolve to checked-out HEAD, and match the package
   version. Source must be clean, including untracked nonignored files.
2. Run local gates and obtain review. The owner creates/pushes the tag only under
   a separate explicit request. `bun run build:release --tag "$TIMBER_TAG"` verifies
   the existing local tag and builds; it never creates or fetches a tag.
3. `.github/workflows/release.yml` checks out the triggering tag, installs locked
   dependencies, runs typecheck/tests/bundle, compiles that exact source, checks
   SHA-256, and exercises the binary in the runtime-free container.
4. Only the dependent draft job has `contents: write`. It uses
   `gh release create --verify-tag --draft` with the three explicit assets.
   Before creating or reusing a draft, a read-only GitHub API check resolves
   the live lightweight/annotated tag and requires the candidate's source commit.
   It checks again after downloading assets; moved or missing tags fail closed.
   There is no implicit tag creation or automatic public publication.
5. The job downloads those actual draft assets with authenticated GitHub CLI
   into a new directory, compares the downloaded manifest/metadata with the
   verified candidate, validates checksums, restores executable permission,
   and reruns the clean-container smoke on the downloaded binary. The GitHub
   token is not passed into that container. Explicit Bash `pipefail` makes both
   smoke/logging pipelines fail when their verifier fails.
6. A repeat run may reuse an existing matching draft after comparing all assets;
   missing/mismatched assets fail rather than being overwritten. Published
   releases are never modified by this path. Inspect a partial draft before
   choosing an explicit recovery action. Tag failures leave no new draft;
   download/smoke failures leave the draft unpublished.
7. Review the workflow's `downloaded-release-verification` artifact and the
   acceptance evidence below. Only the owner publishes the verified draft.
   Publication is a separate explicit action; no CI step promotes the draft.

PR CI uses read-only repository permissions and runs local candidate gates.
It does not create a release. Workflow syntax is checked locally with actionlint;
a local syntax pass is not an actual GitHub Actions run.

For manual download verification, follow the authenticated installation chain in
the [README](../README.md), or download into a fresh directory without installing:

```bash
TIMBER_TAG=vX.Y.Z
DOWNLOAD_DIR="$(mktemp -d "timber-release-check.XXXXXX")"
gh release download "$TIMBER_TAG" --repo Coding-M8s/timber \
  --dir "$DOWNLOAD_DIR" --pattern "timber-$TIMBER_TAG-linux-x64" \
  --pattern build-info.json --pattern SHA256SUMS \
  && (cd "$DOWNLOAD_DIR" && sha256sum -c SHA256SUMS) \
  && chmod +x "$DOWNLOAD_DIR/timber-$TIMBER_TAG-linux-x64" \
  && "$DOWNLOAD_DIR/timber-$TIMBER_TAG-linux-x64" --version
```

`TIMBER_TAG` is a real existing tag, not a placeholder release to invent.
Checksum failure stops the chain. Checksums detect corruption, not independent
publisher authenticity. Use GitHub authentication and the reviewed source/release
identity as well.

## Acceptance and release scope

Demonstrate the 0.1 core capability group with hooks, Jira, and agents absent
before checking 0.2 integrations. The current source already contains 0.2
features; this demonstration does not create historical 0.1 and 0.2 releases
or make the current artifact a core-only 0.1 package. A historical release or
backport requires the owner's source/version decision and separately authorized
Git work. Do not add feature gates or block useful packaging on new integrations.

Final 1.0 acceptance requires the separate team exercise described in
[dogfooding](dogfooding.md), passing source and downloaded-artifact checks,
resolved release blockers, and accurate installation/support documentation.
TIM-16 being closed is not a substitute for the missing team record.
TIM-18's setup wizard, GUI/IDE work, Rust, other platforms, and universal
packaging are not prerequisites for this ticket's packaging implementation.

Record each actual release's evidence here or in its reviewed release notes:

| Evidence | Required record |
| --- | --- |
| Identity | Date, tag, package version, source commit, clean-source state |
| Source gates | Exact commands, exit status, suite count, typecheck/build outputs |
| Artifact | Exact filenames, checksums, build metadata, rebuild comparison |
| Platform | OS, architecture, libc, Git, and Bun build version |
| Download | GitHub workflow/release URLs, downloaded checksum, isolated smoke JSON |
| Integration evidence | Distinguish mocked HTTP, compiled stubs, and any actual live checks |
| Team exercise | Participant/date, downloaded checksum, commands, results, unresolved bugs |
| Publication | Owner publication and actual supported-platform statement |

## Local implementation verification — 2026-10-12

The development candidate is `0.1.0-dev.0`, built with Bun 1.4.2 from the
TIM-17 working tree based on `be1ad45ec013ebc82625aa32183029b19d2ca5ef`.
`sourceDirty: true` means this candidate contains the uncommitted ticket changes;
it is not claimed to be a build of that base commit alone.

- `bun install --frozen-lockfile` installed 27 packages without a lockfile change.
- Before implementation, `bun run typecheck` passed and `bun test` passed 479 tests.
- Final `bun run typecheck` exited 0. Final `bun test` passed 500 tests across
  36 files (3031 assertions, 0 failures, 69.88 seconds).
- `bun run build`, `bun dist/index.js --help`, `bun run build:release`, and
  `dist/release/timber-v0.1.0-dev.0-linux-x64 --version` all exited 0;
  the executable reported `0.1.0-dev.0`.
- `(cd dist/release && sha256sum -c SHA256SUMS)` exited 0 for both assets.
  Same-input rebuild tests confirmed identical executable bytes and metadata.
- `docker build -f tests/release/Dockerfile -t timber-release-smoke .` and
  the exact development-version Docker command above exited 0. Isolated smoke
  passed on Ubuntu 24.04.5 LTS, x86_64, glibc 2.39, Git 2.43.0 with Bun, Node,
  and npm absent and container networking disabled. Executable SHA-256:
  `8e0705a6f1cbb327acbb85177d4a17f1e4dcaa4ab4e25838340b1122363811a5`.
- `.superpowers/tools/actionlint .github/workflows/ci.yml .github/workflows/release.yml`
  exited 0 (checksum-verified official actionlint 1.7.12, local tool only).
- Independent review found two release-gate issues, both fixed locally.
  Seven read-only API seam tests cover matching/moved lightweight and annotated
  tags, missing tags/API failure, invalid target types, and annotated cycles.
  Both logging pipelines were exercised with the same deliberately wrong-version
  Docker verifier under `bash --noprofile --norc -eo pipefail`; each exited 1.
  This proves local shell failure propagation, not a GitHub workflow run.
- Actual tagged GitHub Actions execution, downloaded GitHub assets, publication,
  and the separate teammate exercise remain pending owner actions.

Local evidence never substitutes for the pending downloaded-release and human
acceptance criteria. No ticket closure or Git/GitHub write was performed.
