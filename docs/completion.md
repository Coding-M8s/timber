# Shell tab completion

## Bash

With Timber on PATH, activate completion in the current Bash session:

```bash
source <(timber completion bash)
```

The command prints a script. It does not edit .bashrc, run setup, or write
Timber's first-use marker. Source checkouts can generate the same script:

```bash
bun --no-env-file src/index.ts completion bash > /tmp/timber-completion.bash
source /tmp/timber-completion.bash
```

Completion calls the timber executable on PATH, so install or link the checkout
first when using the source-generated script. Standalone builds embed the script;
no separate completion asset or Bun runtime is needed.

To keep a copy and activate it manually:

```bash
mkdir -p "$HOME/.local/share/timber"
timber completion bash > "$HOME/.local/share/timber/completion.bash"
source "$HOME/.local/share/timber/completion.bash"
```

For fresh interactive terminals, add this line to .bashrc yourself:

```bash
source "$HOME/.local/share/timber/completion.bash"
```

Regenerate the saved script after upgrading Timber. To deactivate it in the current
session, run `complete -r timber`.

## Zsh

Initialize Zsh's completion system, then load Timber completion:

```zsh
autoload -Uz compinit
compinit
source <(timber completion zsh)
```

Most Zsh frameworks already run `compinit`; in that case only the `source` line
is needed. Timber does not initialize Zsh completion or edit `.zshrc`.

To keep a copy and activate it manually:

```zsh
mkdir -p "$HOME/.local/share/timber"
timber completion zsh > "$HOME/.local/share/timber/_timber"
source "$HOME/.local/share/timber/_timber"
```

Regenerate the saved script after upgrading Timber. To deactivate it in the
current session, run `compdef -d timber`.

## Fish

With Timber on PATH, activate completion in the current Fish session:

```fish
timber completion fish | source
```

For automatic loading in new terminals, save the generated script yourself:

```fish
mkdir -p "$__fish_config_dir/completions"
timber completion fish > "$__fish_config_dir/completions/timber.fish"
source "$__fish_config_dir/completions/timber.fish"
```

Fish autoloads `timber.fish` from its completion search path. The example uses
Fish's configuration directory, including an `XDG_CONFIG_HOME` override. You can
instead choose another directory in `$fish_complete_path`. Regenerate the saved
script after upgrading Timber. To deactivate it in the current session, run
`complete -e -c timber`; remove the saved file yourself to disable autoloading.

Source checkouts can generate the same script with
`bun --no-env-file src/index.ts completion fish`. Install or link Timber first
so completion can call the executable on PATH. Standalone builds embed both
adapters. Generating a script never changes shell startup files or runs setup.

## What Tab suggests

- `timber <Tab>` lists public commands. Type a prefix, such as `timber o<Tab>`,
  to narrow the list.
- `timber done --<Tab>` lists flags accepted by done. Other commands use their
  own flags from the same Commander definitions used for CLI parsing and help.
- `timber done <Tab>` lists registered linked worktrees by branch and absolute
  path, excluding the primary checkout. Detached worktrees use paths. Where
  several worktrees share a branch, only their absolute paths are suggested.
  Local branch names that look like remote selectors also use absolute paths.
- `timber open <Tab>` lists registered worktrees, local branches, and cached
  remote branches. Remote selectors include the remote name, such as
  `origin/feature`. Remote symbolic HEAD entries are omitted.
- `timber new --base <Tab>` and `timber done --base <Tab>` suggest local and
  cached remote branches. Both commands also support the `--base=<Tab>` form.

Each attempt reads fresh Git metadata, including worktrees created outside Timber.
Completion works in the primary checkout, its nested directories, and linked
checkouts. It uses no network and does not fetch; newly published remote branches
appear only after you update cached refs explicitly. The Git reads for one Tab
press share a one-second deadline and skip optional locks, so a stalled Git
yields no target suggestions instead of a hanging prompt.

Paths containing spaces, quotes, or shell metacharacters are inserted as one
literal argument. Quote or escape shell syntax already entered in a prefix.
Bash declines unescaped variable, command, history, or glob expansion syntax
instead of treating it as a literal selector. Zsh uses its native parsed
completion words and quoting. Fish uses its native tokenizer and insertion rules
without evaluating candidate text. Fish omits selectors containing tabs because
its completion API treats a tab as a description separator; select such
worktrees by branch name where available, or enter the quoted path manually.
Newlines in candidate paths remain supported.
Completion does not evaluate candidate text. It does not parse
the ls display, scan dirty-file status, load configuration, run hooks, open
editors, or launch agents. Outside a repository, command and flag suggestions
still work; repository failures quietly yield no target suggestions.

Dirty, locked, or stale worktrees remain discoverable. A suggestion says nothing
about whether cleanup is safe: executing done still applies all normal file,
commit, identity, and publication checks. Ignored files are discarded by default;
use --keep-ignored to refuse removal when they exist.

## Verified environment

Bash and Zsh were verified on Linux x86_64 with GNU Bash 5.3.9, Zsh 5.9,
Git 2.56.0, and Bun 1.4.2 for source tests and standalone builds. Fish was
verified on Ubuntu 24.04 Linux x86_64 with GNU Bash 5.2.21, Fish 3.7.0,
Git 2.43.0, Python 3.12.3, and Bun 1.4.2 in an offline Ubuntu container.
Verification loaded each generated script and pressed Tab in a controlling
terminal, checking the resulting argument bytes. Other shell versions and operating
systems have not been verified. All adapters use the same shell-independent
repository candidate service.

The Bash suite in `bun test` loads the generated script in a controlling terminal
and checks inserted argument bytes. The test suite does not start Zsh or Fish;
unit tests cover the native-word and Fish transports those scripts call.
To test the standalone executable, set `TIMBER_COMPLETION_EXECUTABLE` to its
absolute path when running `tests/completion-bash.test.ts`. See
[release checks](releases.md).

Arena completion follows the same Commander definitions: `timber arena <Tab>`
suggests subcommands, and `timber arena new --<Tab>` suggests creation flags.
`arena new --base` completes cached branch refs using the existing bounded Git
reads. Completion never loads arena presets, reads task snapshots, or writes
arena records. Built-in `--tool` values complete without reading config. Model IDs,
preset names, and prompt-file paths are not completed. Public flags derive from
Commander, including `--model`, `--default-effort`, `--effort`, `--runs`, and `--preset`.
