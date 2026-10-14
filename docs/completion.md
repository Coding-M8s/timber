# Bash tab completion

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

## What Tab suggests

- `timber <Tab>` lists public commands. Type a prefix, such as `timber o<Tab>`,
  to narrow the list.
- `timber done --<Tab>` lists flags accepted by done. Other commands use their
  own flags from the same Commander definitions used for CLI parsing and help.
- `timber done <Tab>` lists registered linked worktrees by branch and absolute
  path, excluding the primary checkout. Detached worktrees use paths. Where
  several worktrees share a branch, choose an absolute path to identify one.
  Local branch names that look like remote selectors also use absolute paths.
- `timber open <Tab>` lists registered worktrees, local branches, and cached
  remote branches. Remote selectors include the remote name, such as
  `origin/feature`. Remote symbolic HEAD entries are omitted.
- `timber new --base <Tab>` and `timber new --base=<Tab>` suggest local and
  cached remote branches.

Each attempt reads fresh Git metadata, including worktrees created outside Timber.
Completion works in the primary checkout, its nested directories, and linked
checkouts. It uses no network and does not fetch; newly published remote branches
appear only after you update cached refs explicitly.

Paths containing spaces, quotes, or shell metacharacters are inserted as one
literal argument. Quote or escape shell syntax already entered in a prefix;
completion declines unescaped variable, command, history, or glob expansion
syntax instead of treating it as a literal selector.
Completion does not evaluate candidate text. It does not parse
the ls display, scan dirty-file status, load configuration, run hooks, open
editors, or launch agents. Outside a repository, command and flag suggestions
still work; repository failures quietly yield no target suggestions.

Dirty, locked, or stale worktrees remain discoverable. A suggestion says nothing
about whether cleanup is safe: executing done still applies all normal file,
commit, identity, and publication checks. Ignored files are discarded by default;
use --keep-ignored to refuse removal when they exist.

## Verified environment

Verified on Linux x86_64 with GNU Bash 5.3.15, Git 2.55.0, and Bun 1.4.2 for
source tests and standalone builds. The tests load the generated script in Bash
and press Tab in a controlling terminal, checking the resulting argument bytes.
Other Bash versions, operating systems, Zsh, and Fish have not been verified.
Zsh and Fish adapters are future work; the repository candidate service is
independent of Bash formatting.

From a checkout with the pinned Bun toolchain selected:

```bash
bun --version
bash --version
git --version
bun test tests/completion.test.ts tests/completion.integration.test.ts tests/completion-bash.test.ts
bun run typecheck
bun test
bun run build
bun run build:release
```

Release builds require exactly the packageManager version in package.json.
