# Building and releasing Timber

Standalone builds target Linux x86_64, with macOS beta builds for Apple Silicon
and Intel. The tested Linux release environment is Ubuntu 24.04, glibc 2.39, and
Git 2.43.0. See [macOS beta](#macos-beta) for testing limits.
Users need Git and any configured editor, agent, or hook tools. The executable
runs without a separate Bun or Node installation.

For Windows installation and platform requirements, see the [Windows guide](windows.md).

## Build and check

Use Bun 1.4.2 and the locked dependencies. Python 3 is needed for PTY tests;
install Bash, Zsh, and Fish to exercise all completion adapters.

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun dist/index.js --help
bun run build:release
(cd dist/release && sha256sum -c SHA256SUMS)
```

`build` creates a Bun JavaScript bundle. `build:release` produces:

| Asset | Contents |
| --- | --- |
| `timber-v<VERSION>-linux-x64` | Standalone executable, versioned from `package.json` |
| `build-info.json` | Version, license designation, tag if supplied, source commit, dirty marker, Bun version, target |
| `LICENSE` | Timber CLI MIT License + Commons Clause v1.0 |
| `THIRD_PARTY_NOTICES.txt` | Separate dependency terms and Bun licensing inventory |
| `SHA256SUMS` | Executable, metadata, license, and notices checksums |

`build:release --target windows-x64` selects Bun's `bun-windows-x64` compiler
target and produces `timber-v<VERSION>-windows-x64.exe`,
`build-info-windows-x64.json` and `SHA256SUMS-windows-x64` in the output directory,
with the same `LICENSE` and `THIRD_PARTY_NOTICES.txt` files covered by its checksums.
`--target linux-x64` preserves the Linux names above. Omitted target defaults to
Windows x64 on Windows, the native macOS target on macOS, and Linux x64
elsewhere. `darwin-arm64` and `darwin-x64` are
[beta](#macos-beta). Other targets are rejected.

Use `--outdir <absolute-path>` for alternate output. Untagged builds allow local
changes and mark them with `sourceDirty: true`. Tagged builds require clean source,
an existing tag at HEAD, and a matching package version. Accepted tags are
`vMAJOR.MINOR.PATCH` and `vMAJOR.MINOR.PATCH-rc.N`. The build never creates tags.

Standalone builds disable automatic `.env` and `bunfig.toml` loading. Export
credentials into the invoking environment. For the source runner, use
`bun --no-env-file src/index.ts ...` to disable Bun's `.env` loading.

## Check the standalone executable

Use the version printed by the build in these commands:

```bash
TIMBER_VERSION=0.1.0
TIMBER_COMPLETION_EXECUTABLE="$PWD/dist/release/timber-v$TIMBER_VERSION-linux-x64" \
  bun test tests/completion-bash.test.ts tests/completion-zsh.test.ts tests/completion-fish.test.ts

docker build -f tests/release/Dockerfile -t timber-release-smoke .
docker run --rm --network none \
  --mount "type=bind,src=$PWD/dist/release,dst=/release,readonly" \
  timber-release-smoke \
  --binary "/release/timber-v$TIMBER_VERSION-linux-x64" \
  --expected-version "$TIMBER_VERSION" --require-no-runtime
```

The container has Git and Python, with no Bun, Node, or npm. The smoke test uses
disposable repositories, local bare remotes, and isolated HOME/XDG directories.
It checks the core worktree lifecycle, refusal preservation, hooks, agent stubs,
setup, and runtime autoload isolation. Success prints one JSON result containing
platform, Git version, executable version, and checksum.

Without Docker, run `python3 scripts/smoke-release.py --binary <absolute-path>
--expected-version <version>` on the host. This exercises the same workflows but
does not establish runtime independence. Jira HTTP tests use doubles; they do not
establish live Jira access. Completion and Orca tests also use terminal/process
fixtures where a real external tool is unnecessary.

## macOS beta

`build:release --target darwin-arm64` or `--target darwin-x64` selects Bun's
matching compiler target and produces `timber-v<VERSION>-darwin-arm64` or
`timber-v<VERSION>-darwin-x64`. Tagged releases include both as **macOS beta**
downloads after native candidate checks. macOS beta is a platform status;
the existing stable and numbered RC tag formats remain unchanged.

The maintainer reports that the standalone executable worked on an older Mac
running an end-of-life macOS version. The exact OS version, processor and commands
were not recorded, so this does not establish a minimum supported macOS version
or verified coverage of both architectures. Broader compatibility and desktop
editor integration are open to community testing.

```bash
bun run build:release --target darwin-arm64 --outdir dist/macos-arm64
```

Each target writes `build-info-darwin-<arch>.json` and `SHA256SUMS-darwin-<arch>`
alongside its executable, so release asset names do not collide. Its checksums
also cover the shared `LICENSE` and `THIRD_PARTY_NOTICES.txt`, so keep both files
beside the executable when verifying. Cross-compilation may download Bun's target
runtime and does not execute the output.

On the matching Mac, verify with `shasum -a 256 -c SHA256SUMS-darwin-arm64`
(use `darwin-x64` for Intel), then run
`python3 -B scripts/smoke-release.py --binary <absolute-binary-path>
--expected-version <version>`. The host smoke verifies CLI/Git behavior; it does
not prove a runtime-free environment or desktop-editor handoff. Beta binaries are
unsigned and not notarized. macOS may block downloaded executables; use the normal
macOS security approval flow only after checking the download source and checksum.
Signing, notarization and manual editor smoke remain work for stable support.

Report beta problems through the repository's issue tracker. Include `sw_vers`,
`uname -m`, `git --version`, `timber --version`, the downloaded asset's build-info
file, the failing command, expected behavior and sanitized output. Exclude secrets
and private repository content. Reports from older macOS versions are welcome.

`.github/workflows/macos.yml` also runs manually on Apple Silicon and Intel runners.
It checks selected source lifecycle, preservation and runner tests, native builds,
checksums and standalone smoke. It publishes nothing. Manual triggering keeps macOS
jobs off every push; tagged releases run their own native beta checks.

## Publish a release

1. Review [licensing and the Bun runtime distribution caveat](licensing.md),
   including exact-runtime license texts and source/relink requirements, before
   publishing executables. Keep `LICENSE` and `THIRD_PARTY_NOTICES.txt` with source,
   bundles, and executable distributions. Timber is source-available under the
   combined terms, not MIT-only or OSI-approved open source.
   Choose the source commit and package version. Run the checks above and review
   the changes. Exercise the [manual workflow checklist](dogfooding.md) before
   release; record results in the PR or release notes.
2. Create and push the matching tag when ready. The tag workflow runs the source
   checks, builds that exact tag, verifies checksums, and runs the container smoke.
   A native Windows job also builds the tag and runs focused source tests and
   PowerShell acceptance. Native Apple Silicon and Intel jobs run focused source
   tests, build the exact tag, verify checksums and smoke the standalone executable.
   See the Windows guide for platform requirements.
3. The draft job depends on all four platform candidates and verifies the live
   GitHub tag still points to the built commit, then creates a draft containing
   twelve platform assets (executable, metadata and checksums for each target)
   plus the shared license and third-party notices. Only that job has write
   permission; PR CI is read-only.
4. The job downloads the draft assets, compares metadata and checksums with the
   candidate, rechecks the tag, and reruns the container smoke on the download.
   Existing drafts must match; mismatched assets fail without replacement.
   Published releases are never modified. A dependent native Windows job checks
   downloaded Windows metadata/checksums and the live tag, then runs its
   PowerShell harness against the downloaded executable. Dependent native macOS
   jobs compare downloaded metadata/checksums, recheck the live tag and smoke each
   downloaded beta executable.
5. Review the workflow results, `downloaded-release-verification` and
   `downloaded-windows-release-verification` and both
   `downloaded-darwin-<arch>-release-verification` artifacts, installation instructions,
   and unresolved bugs. Windows clean-machine and interactive checks remain
   separate owner gates. Publish the draft explicitly.
   Failed verification leaves the draft unpublished; inspect partial drafts before
   retrying.

Record the tag, source commit, commands and results, platform/toolchain, downloaded
checksums, workflow URL, and manual exercise outcome in the release notes. Keep
credentials and private task data out of those records. Historical local test
counts do not establish that a new release passes.

See [download and installation](guide.md#install-the-standalone-cli) for user steps
and [local installation](local-install.md) to replace a development link.
Checksums detect corruption; they do not independently authenticate the publisher.
