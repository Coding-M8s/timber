# Timber

Work on several Git branches at once, each in its own folder.

Timber manages **Git worktrees**: create a workspace for a feature, open a branch
for review, and clean up when you're done. It can also run setup scripts and
launch your editor or coding assistant in the right folder.

## Quick start

You need **Git** and **Bun 1.4.2**. Linux x86_64 is the verified platform.
Install your editor or coding assistant separately if you want Timber to launch it.

### 1. Install from source

With repository read access:

```bash
git clone https://github.com/Coding-M8s/timber.git
cd timber
bun install --frozen-lockfile
bun link
timber --help
```

Already have the checkout? Start at `bun install`. Keep Bun installed and the
checkout in place: `bun link` makes `timber` run from this source directory.
If `timber` isn't found, add Bun's bin directory to your `PATH`
(normally `export PATH="$HOME/.bun/bin:$PATH"`).

Prefer an executable without Bun? See [standalone installation](docs/guide.md#install-the-standalone-cli)
for published Linux x86_64 releases, or [build your own](docs/local-install.md).

### 2. Choose your defaults

Run this in an interactive terminal:

```bash
timber setup --global
```

Choose your editor, assistant, and whether they launch automatically, then save.
Skip anything you don't need, including Jira. Use `timber setup` inside a
repository to override machine defaults for that project.

### 3. Start working

Run these inside the Git repository you want to work on:

```bash
timber new my-feature     # Create a branch and its workspace
timber ls                 # See workspace paths and file status
timber open my-feature    # Return to the same workspace
```

The new folder is normally `../<repository-name>-worktrees/my-feature`.
Timber prints its absolute path. It doesn't change your shell's directory:
`cd` into that folder, or use your configured editor or assistant there.

## Everyday commands

| Command | What it does |
| --- | --- |
| `timber new "Fix login bug"` | Create branch `fix-login-bug` and a worktree |
| `timber new my-feature --base main` | Choose the starting branch explicitly |
| `timber open origin/some-feature` | Check out a remote branch in its own worktree |
| `timber open my-feature --editor` | Open the worktree in your configured editor |
| `timber open my-feature --agent` | Start your configured assistant in the worktree |
| `timber rebase my-feature` | Fetch the remote base and rebase; [resolve conflicts manually](docs/cli-contract.md#rebase-an-existing-worktree-tim-28) |
| `timber ls` | List this repository's worktrees and their status |
| `timber done my-feature --base parent-feature` | Choose a one-off cleanup merge target |
| `timber done my-feature` | Remove a finished worktree and its local branch when safe |

Editors and assistants are off by default. Configure them in setup, then enable
automatic launch or pass `--editor` / `--agent` for one command. Use `--no-editor`
or `--no-agent` to skip a configured launch. Assistants normally run in your
current terminal.

`open` reuses existing worktrees. It creates one if the branch exists without a
worktree. It doesn't rerun setup scripts unless you pass `--setup`.

### Cleaning up

`done` refuses to remove modified or untracked files, protects the primary
checkout, and requires proof that commits are published or integrated.

**It deletes ignored files by default, including `.env` and `node_modules`.**
To refuse cleanup when ignored files exist:

```bash
timber done my-feature --keep-ignored
```

Add `--keep-branch` to retain the local branch. Remote branches stay untouched.

## Optional tools

- **Jira:** configure it in setup, then `timber new TIM-42` names the branch from
  the ticket. Use `timber open TIM-42` to resume it. Keep credentials out of TOML.
- **Named workflows:** `timber new my-feature --workflow review` uses a workflow
  you've defined with its own setup scripts, editor, and assistant.
- **Arena:** `timber arena new my-task` guides you through creating multiple
  isolated attempts with the same task and starting commit. Agents run one at a
  time. Resume and winner selection commands are still planned.
- **Bash completion:** run `source <(timber completion bash)` in your terminal.

## More help

Use `timber <command> --help` for flags and [the user guide](docs/guide.md)
for configuration examples, Jira, hooks, workflows, Arena, and troubleshooting.
Configured hooks run shell commands with your permissions; review them before use.
If setup or a launch fails, Timber keeps the workspace and prints retry guidance.

- [Orca editor terminals](docs/editor-terminals.md)
- [Standalone builds and release verification](docs/releases.md)
- [Development guidance](AGENTS.md) and [CLI behavior contract](docs/cli-contract.md)

For development, run these from the Timber checkout (Python 3 is needed for PTY tests):

```bash
bun run dev --help
bun run typecheck
bun test
bun run build
```
