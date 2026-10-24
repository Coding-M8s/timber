# Roadmap ticket: test autocomplete with Fisher and Oh My Fish

Proposed future work. Unscheduled; this document does not create a GitHub issue,
change release requirements, or claim framework compatibility has been verified.

## Goal

Verify Timber Fish completion with Fisher and Oh My Fish in separate profiles,
including persistent completion autoloading and real Tab insertion. Keep the
profiles available for later testing without mixing their user configuration or
changing the user's default shell.

Related: [shell completion guide](completion.md), Fish completion issue #85,
`src/completion/fish.ts`, and `tests/completion-fish.test.ts`.

Existing Fish tests deliberately start Fish with `--no-config`. They verify
native shell behavior but do not establish compatibility with plugin-manager or
framework startup. This ticket adds that separate proof.

## Scope and acceptance criteria

- [ ] Test plain Fish as a baseline, Fisher in its own profile, and Oh My Fish in
  another profile. Never install both frameworks into the same test profile.
- [ ] Start configured sessions normally, without `--no-config`, and verify each
  framework actually loads before evaluating Timber completion.
- [ ] Save `timber.fish`, close Fish, reopen the same profile, and verify completion
  autoloads without manually sourcing the script.
- [ ] Verify public commands, command-specific flags, nested Arena commands,
  worktree selectors, cached branches, and separate/equals `--base` values.
- [ ] Press Tab in real terminal sessions and check inserted argument bytes for
  spaces, quotes, shell metacharacters, Unicode, and multiline input. Preserve the
  documented omission of tab-containing selectors rather than truncating paths.
- [ ] Verify primary-worktree exclusion for `done`, fresh inventory between
  requests, quiet completion outside repositories, and unchanged repository files
  and refs. Never execute `done` merely to test its suggestions.
- [ ] Exercise source and standalone builds. Keep the native Fish suite intact;
  framework testing must not replace its coverage or silently bypass startup.
- [ ] Record Linux distribution/architecture, Fish, Bun, Git, framework revisions,
  any enabled plugins, exact commands, results, and whether failures belong to
  Timber, framework installation, or the test environment.
- [ ] Reopen both retained profiles and confirm their framework state remains
  separate. Keep user configuration, default shell, and unrelated files intact.

Recheck upstream maintenance before execution. Fisher and Oh My Fish serve
different compatibility cases; a framework installation failure is not by itself
evidence of a Timber completion regression. Do not claim compatibility with every
plugin based on testing an otherwise empty framework profile.

## Manual installation and testing recipe

Prerequisites: a Linux x86_64 checkout containing the merged Fish adapter, the
project's pinned Bun toolchain, Fish, curl, and Git. Install prerequisites through
your platform's package manager. The commands below are proposed verification
steps, not a record that this ticket has already been completed.

### 1. Prepare persistent, isolated profiles

From **your shell**, enter the Timber checkout and run:

```sh
sh
```

Paste the remaining `sh` blocks into that setup session. Using `sh` makes their
syntax independent of your usual shell. Do not change your default shell.

```sh
bun install --frozen-lockfile
bun run build:release

timber_test_parent="${XDG_DATA_HOME:-"$HOME/.local/share"}/timber"
mkdir -p "$timber_test_parent"
timber_framework_test="$(mktemp -d "$timber_test_parent/completion-frameworks.XXXXXX")"
mkdir -p "$timber_framework_test/bin"

timber_test_version="$(bun --no-env-file -p 'require("./package.json").version')"
cp "$PWD/dist/release/timber-v$timber_test_version-linux-x64" \
  "$timber_framework_test/bin/timber"

tfish() (
  timber_test_profile="$1"
  shift
  unset OMF_PATH OMF_CONFIG
  exec env \
    PATH="$timber_framework_test/bin:$PATH" \
    XDG_CONFIG_HOME="$timber_framework_test/$timber_test_profile/config" \
    XDG_DATA_HOME="$timber_framework_test/$timber_test_profile/data" \
    XDG_CACHE_HOME="$timber_framework_test/$timber_test_profile/cache" \
    XDG_STATE_HOME="$timber_framework_test/$timber_test_profile/state" \
    fish --private "$@"
)

printf 'Keep this test-profile path: %s\n' "$timber_framework_test"
```

The copied binary and framework profiles live in persistent user data, not
`/tmp`. Each launcher invocation scopes its environment to that Fish process;
it does not export a replacement configuration into your usual shell. System-wide
Fish vendor configuration may still load, so record it if it affects results.

### 2. Verify plain Fish first

```sh
tfish plain -c '
  mkdir -p "$__fish_config_dir/completions"
  and timber completion fish > "$__fish_config_dir/completions/timber.fish"
'

tfish plain --interactive
```

Run the shared checks below. Use `exit` to return to the setup session afterward.

### 3. Install and test Fisher

This uses the [upstream Fisher installation procedure](https://github.com/jorgebucaran/fisher#installation)
inside the dedicated profile. Downloading and sourcing an installer executes its
code with your permissions; review the upstream source before running it.

```sh
tfish fisher -c '
  curl -fsSL https://raw.githubusercontent.com/jorgebucaran/fisher/main/functions/fisher.fish | source
  and fisher install jorgebucaran/fisher
'

tfish fisher -c '
  mkdir -p "$__fish_config_dir/completions"
  and timber completion fish > "$__fish_config_dir/completions/timber.fish"
'

tfish fisher --interactive --init-command 'fisher list'
```

Confirm `fisher list` includes Fisher. Run the shared checks, then `exit`.
Reopen with `tfish fisher --interactive` and repeat the checks to prove autoloading
and retained profile state.

### 4. Install and test Oh My Fish separately

This uses the [upstream Oh My Fish installer](https://github.com/oh-my-fish/oh-my-fish#installation).
The installer supports `--noninteractive --yes`; the configuration and installation
paths follow this profile's XDG directories. Record the installed revision and
maintenance status, including upstream warnings.

```sh
curl -fsSL \
  https://raw.githubusercontent.com/oh-my-fish/oh-my-fish/master/bin/install \
  -o "$timber_framework_test/install-omf.fish"

tfish omf "$timber_framework_test/install-omf.fish" \
  --noninteractive --yes

tfish omf -c '
  mkdir -p "$__fish_config_dir/completions"
  and timber completion fish > "$__fish_config_dir/completions/timber.fish"
'

tfish omf --interactive --init-command 'omf version'
```

Confirm `omf version` succeeds. Run the shared checks, then `exit`.
Reopen with `tfish omf --interactive` and repeat. Revisit the Fisher profile to
check that installing Oh My Fish did not change its framework state.

### 5. Shared checks inside each Fish session

```fish
fish --version
type -p timber

complete -C 'timber o'
complete -C 'timber done --keep-'
complete -C 'timber arena '
complete -C 'timber open '
complete -C 'timber done '
complete -C 'timber new --base '
complete -C 'timber new --base=ma'
```

Expected: `open`; both `--keep-*` flags; public Arena subcommands; repository
branches/worktrees; and matching base refs. Target results depend on the current
repository. `done` must exclude its primary checkout. Outside Git, command and
flag candidates remain available and target requests stay quiet.

For an actual keyboard check, type `timber o` and press Tab. It should become
`timber open`. Press Ctrl+C to clear the line. Repeat with flag and target
prefixes, clearing each line rather than executing a cleanup command.

Use temporary real repositories for unusual filenames and inventory changes;
capture the executed argv through a test shim instead of invoking destructive
commands. The future framework test harness should cover these cases through
real PTYs, as the existing native suite does.

```fish
exit
```

This returns to the setup `sh` session. A further `exit` returns to your original
shell. These configured sessions intentionally load startup files: do not add
`--no-config`, since that would bypass what you are testing.

## Keep the profiles for later

Keep the printed `timber_framework_test` directory. To resume from another shell,
start `sh`, set `timber_framework_test` to that saved path, and paste only the
`tfish` function definition from step 1. Do not create a new directory if you want
to reuse the old profiles.

Then launch `tfish fisher --interactive` or `tfish omf --interactive`. Each session
loads one framework's profile; installing both into the same normal Fish profile
is outside this recipe. These installations are not enabled in your ordinary
Fish configuration, and your default shell is unchanged.

The retained binary is a snapshot of the build used for testing. Deliberately
replace it with a newly built artifact when testing a later revision, and record
that revision. Profile deletion or migration into everyday shell configuration
is a separate user decision.

## Future automation boundary

If this becomes automated coverage, use disposable isolated profiles, reviewed
framework revisions, and a separate optional job. Keep framework downloads out
of ordinary offline candidate lookup and do not add framework dependencies to
Timber's runtime or normal completion activation. Record a baseline before
deciding whether framework smoke tests should become a required CI gate.
