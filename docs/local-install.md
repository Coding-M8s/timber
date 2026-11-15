# Install a local standalone build

Use this to replace a development `bun link` with the current checkout's Linux
x86_64 executable. Building requires Git and Bun 1.4.2.

Build before removing the working link:

```bash
bun install --frozen-lockfile
bun run build:release
(cd dist/release && sha256sum -c SHA256SUMS)
```

Use the filename printed by the build; the current version is
`timber-v0.1.1-linux-x64`. After the checksums pass, unregister the link and
install that executable:

```bash
bun unlink
install -Dm755 dist/release/timber-v0.1.1-linux-x64 "$HOME/.local/bin/timber"
export PATH="$HOME/.local/bin:$PATH"
hash -r
command -v timber
timber --version
timber --help
```

`command -v timber` should resolve to `~/.local/bin/timber`. Add the PATH export
to your shell startup file if needed. Unlinking preserves the source checkout and
Timber settings. Rebuild and reinstall to update this copy.

Configure defaults with `timber setup --global`, or run `timber setup` inside a
repository for project overrides. Existing settings survive installation.
See [setup and credentials](guide.md#guided-setup-and-machine-defaults) and
[shell completion](completion.md).

For an automated check using disposable repositories and settings:

```bash
python3 scripts/smoke-release.py \
  --binary "$HOME/.local/bin/timber" --expected-version 0.1.1
```

Update the expected version when the package version changes. Success prints
`"result": "passed"`. See [release checks](releases.md) for the container test
without Bun or Node.
