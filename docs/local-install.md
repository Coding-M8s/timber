# Install a local standalone build

Use this to install the current checkout's Linux x86_64 executable as `timber`,
for example to try an unreleased build. Building requires Git and Bun 1.4.4.
For a published release, use the
[one-line install](guide.md#one-line-install) instead.

Build and verify:

```bash
bun install --frozen-lockfile
bun run build:release
(cd dist/release && sha256sum -c SHA256SUMS)
```

Use the filename printed by the build; the current version is
`timber-v0.1.2-linux-x64`. After the checksums pass, install that executable.
If you registered a `bun link` in the past, run `bun unlink` in the checkout
first so it cannot hide this install.

```bash
install -Dm755 dist/release/timber-v0.1.2-linux-x64 "$HOME/.local/bin/timber"
export PATH="$HOME/.local/bin:$PATH"
hash -r
command -v timber
timber --version
timber --help
```

`command -v timber` should resolve to `~/.local/bin/timber`. Add the PATH export
to your shell startup file if needed. Installing preserves the source checkout and
Timber settings. Rebuild and reinstall to update this copy.

Configure defaults with `timber setup --global`, or run `timber setup` inside a
repository for project overrides. Existing settings survive installation.
See [setup and credentials](guide.md#guided-setup-and-machine-defaults) and
[shell completion](completion.md).

For an automated check using disposable repositories and settings:

```bash
python3 scripts/smoke-release.py \
  --binary "$HOME/.local/bin/timber" --expected-version 0.1.2
```

Update the expected version when the package version changes. Success prints
`"result": "passed"`. See [release checks](releases.md) for the container test
without Bun or Node.
