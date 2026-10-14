# Replace a Bun link with a standalone Timber build

Use this guide to test the current checkout on Linux x86_64. Building requires
Bun 1.4.2 and installed Git. Python 3 is needed only for the automated smoke
check. The resulting executable runs without a separate Bun or Node installation.
Keep the checkout on the branch you want to test; a published download might
contain an older implementation.

1. **Build before removing the working development link.** From the Timber
   checkout, run:

   ```bash
   bun --version
   git branch --show-current
   bun install --frozen-lockfile
   bun run build:release
   (cd dist/release && sha256sum -c SHA256SUMS)
   ```

   Bun should report `1.4.2`. All checksum lines must say `OK`. The current
   package version creates `dist/release/timber-v0.1.0-dev.0-linux-x64`.
   When the package version changes, use the filename printed by the build.

2. **Unregister the development link.** Stay in the same checkout:

   ```bash
   bun unlink
   hash -r
   type -a timber
   ```

   `bun unlink` removes the registered package and its CLI link; it preserves
   the source checkout and Timber settings. `type` may report that Timber is
   missing at this point. If it lists another installation, inspect that path
   before deciding which copy to use. These shell commands assume Bash.

3. **Install the executable and put it first on PATH.**

   ```bash
   install -Dm755 dist/release/timber-v0.1.0-dev.0-linux-x64 "$HOME/.local/bin/timber"
   export PATH="$HOME/.local/bin:$PATH"
   hash -r
   command -v timber
   timber --version
   timber --help
   timber setup --help
   ```

   `command -v timber` should resolve to your home directory's `.local/bin/timber`.
   The expected version is currently `0.1.0-dev.0`, and help should list `setup`.
   Add `export PATH="$HOME/.local/bin:$PATH"` to `~/.bashrc` once if that directory
   is not already on PATH in fresh terminals.

4. **Configure machine defaults.** In a normal interactive terminal:

   ```bash
   timber setup --global
   ```

   Choose an installed editor or assistant with arrows plus Enter, or press a
   numbered shortcut to choose immediately without Enter.
   Enter skips new settings or keeps current values. Skip Jira and advanced
   settings if you do not need them. Review the summary, then choose Save (`1`).
   You can also select any section to revise just those answers and return to
   review; Cancel leaves your settings unchanged.
   Setup prints the destination, normally `~/.config/timber/config.toml`.
   CI must be off; use `env -u CI timber setup --global` if your terminal carries
   a CI variable. Existing configuration and the first-use marker survive
   reinstalling, so the initial hint may already have been shown.

5. **Optionally configure one repository.** From its primary checkout:

   ```bash
   git status --short
   timber setup
   git check-ignore -v .timber.toml
   git status --short
   timber ls
   ```

   Repository settings override machine defaults; skipped values inherit them.
   The ignore check should show a rule for `.timber.toml`, and saving should add
   no configuration entry to normal Git status. An already-tracked config needs
   an explicit editing/global choice because ignore rules cannot hide its changes.

6. **Run the installed executable through the automated checks.** Return to the
   Timber source checkout:

   ```bash
   python3 scripts/smoke-release.py \
     --binary "$HOME/.local/bin/timber" \
     --expected-version 0.1.0-dev.0
   ```

   Expect a JSON result containing `"result": "passed"`. This uses disposable
   repositories and HOME/XDG folders, exercising worktree creation/open/list/safe
   cleanup, hooks, agent stubs, failure preservation, and first-use guidance.
   Your real repositories and settings are not used by the smoke test. Running
   it on a host with Bun installed does not prove a runtime-free environment;
   see the [release verification guide](releases.md) for the isolated Docker gate.

   To check your chosen editor in a real repository without starting an agent:

   ```bash
   timber open "$(git rev-parse --show-toplevel)" --no-agent
   ```

   Add `--agent` instead when deliberately testing a configured coding assistant.
   Live Jira access needs `JIRA_EMAIL` and `JIRA_API_TOKEN` exported separately;
   the automated smoke does not perform a live Jira request.
