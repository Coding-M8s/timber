# Building and releasing Timber

Standalone builds target Linux x86_64. The tested release environment is Ubuntu
24.04, glibc 2.39, and Git 2.43.0. Other platforms are not yet supported.
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
Windows x64 on Windows and Linux x64 elsewhere. Other targets are rejected.

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
TIMBER_VERSION=0.1.0-dev.0
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
   PowerShell acceptance. See the Windows guide for platform requirements.
3. The draft job depends on both platform candidates and verifies the live
   GitHub tag still points to the built commit, then creates a draft containing
   six platform assets plus the shared license and third-party notices. Only that
   job has write permission; PR CI is read-only.
4. The job downloads the draft assets, compares metadata and checksums with the
   candidate, rechecks the tag, and reruns the container smoke on the download.
   Existing drafts must match; mismatched assets fail without replacement.
   Published releases are never modified. A dependent native Windows job checks
   downloaded Windows metadata/checksums and the live tag, then runs its
   PowerShell harness against the downloaded executable.
5. Review the workflow results, `downloaded-release-verification` and
   `downloaded-windows-release-verification` artifacts, installation instructions,
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
