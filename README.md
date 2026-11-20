<p align="center"><img src="docs/assets/logo.png" width="120" alt="Timber logo"></p>

# Timber

Git worktrees without the bookkeeping.

![Timber creating two worktrees, listing them, and removing one](docs/assets/demo.gif)

Work on several Git branches at once, each in its own folder. Timber creates,
opens, lists, rebases, and removes Git worktrees. It can also run setup scripts
and launch your editor or coding assistant.

## Compared with plain `git worktree`

| Task | Plain Git | Timber |
| --- | --- | --- |
| Start a branch in its own folder | `git worktree add -b fix-login-bug ../acme-worktrees/fix-login-bug main` | `timber new "Fix login bug"` |
| See every worktree and its state | `git worktree list`, then `git status` in each folder | `timber ls` |
| Clean up when finished | `git worktree remove ../acme-worktrees/fix-login-bug`, then `git branch -d fix-login-bug` | `timber done fix-login-bug` |

Timber picks the folder and branch name, remembers each branch's base for
rebases and cleanup, and applies the same safety checks every time.

## Quick start

You need Git. Linux x86_64 is the tested platform.
macOS is available in [beta for Apple Silicon and Intel](docs/releases.md#macos-beta).

```bash
curl -fsSL https://github.com/Coding-M8s/timber/releases/latest/download/install.sh | sh
timber --help
```

The installer verifies the download and puts `timber` in `~/.local/bin`. If
`timber` isn't found, add that directory to your PATH. Run the same command
again to update.

To read the script first, pin a version, or install by hand, see the
[install steps](docs/guide.md#install-the-standalone-cli). Windows x64 downloads
are provisional; see the [Windows guide](docs/windows.md). To work on Timber
itself, see [CONTRIBUTING.md](CONTRIBUTING.md).

Choose defaults in an interactive terminal:

```bash
timber setup --global
```

Skip tools you don't need. Use `timber setup` inside a repository for project
overrides. Editors and assistants launch only when enabled in setup or explicitly
requested with `--editor` or `--agent`; use `--no-editor` or `--no-agent` to skip.
Assistants normally run in the invoking terminal.

## Everyday commands

Run these inside the Git repository you want to work on:

| Command | What it does |
| --- | --- |
| `timber new "Fix login bug"` | Create branch `fix-login-bug` and a worktree |
| `timber new my-feature --base main` | Choose the starting branch |
| `timber open my-feature` | Reuse its worktree, or create one for an existing branch |
| `timber open origin/some-feature` | Open a remote branch in its own worktree |
| `timber open my-feature --editor` | Open your configured editor |
| `timber open my-feature --agent` | Start your configured assistant |
| `timber rebase my-feature` | Rebase onto its saved base; [bases and recovery](docs/worktree-bases.md) |
| `timber publish my-feature` | Push its branch and set the upstream; never force-pushes |
| `timber pr my-feature --title "Add login"` | Publish it and open a GitHub or Bitbucket pull request against its saved base |
| `timber backup create my-feature` | Privately snapshot its commit and files, including `.env`; [backups](docs/cli-contract.md#worktree-recovery-backups-119) |
| `timber backup restore <id> ../recovered` | Recover a backup into a new worktree |
| `timber backup list` | Show backups with branch, time, size, protection and expiry (`--json` for apps) |
| `timber backup done` | Delete backups one at a time after `y` then Enter (`--all` asks once) |
| `timber ls` | List paths, bases, and file status |
| `timber done my-feature` | Remove a finished worktree and its local branch |
| `timber done my-feature --base parent-feature` | Override the cleanup merge target |
| `timber arena pick search-fix --inspect` | Compare arena attempts without changes |
| `timber arena pick search-fix` | Keep a winner; archive and remove the rest |
| `timber update` | Install the latest release; [update notice and opt-outs](docs/guide.md#update-notice-and-timber-update) |

New folders normally live at `../<repository-name>-worktrees/<branch-slug>`.
Timber prints the absolute path; `cd` there yourself. Existing worktrees skip
setup scripts unless you pass `open --setup`.

## Cleanup

`done` protects the primary checkout. A confirmed deleted upstream allows removal
**including local commits and modified/untracked files**. Otherwise, unsafe cleanup
requires an interactive confirmation, defaulting to No.

**Ignored files, including `.env` and `node_modules`, are deleted by default.**
Use `--keep-ignored` to refuse cleanup when ignored files exist, and `--keep-branch`
to retain the local branch. Remote branches stay untouched.
See [cleanup details](docs/guide.md#finish-a-worktree).

**`arena pick` is an incomplete beta feature under active testing; its interface
and behavior may change.** It keeps the winner untouched and archives each other
attempt under `refs/timber/arena/` before removing it, so nothing but ignored files
is lost. See [winner selection](docs/guide.md#choose-an-arena-winner).

## More help

Use `timber <command> --help` for flags. To remove Timber, see [Remove Timber](docs/guide.md#remove-timber).

- [User guide](docs/guide.md): configuration, Jira, trusted shell hooks, and workflows
- [Arena](docs/guide.md#arena-multiple-isolated-attempts): create, resume, compare, and pick isolated attempts
- [Shell completion](docs/completion.md): Bash, Zsh, and Fish
- [Orca editor terminals](docs/editor-terminals.md)
- [Building and releasing](docs/releases.md)
- [Contributing](CONTRIBUTING.md), [development guidance](AGENTS.md), and [code map](docs/shared-contracts.md)
- [Reporting security issues](SECURITY.md)
- [CLI behavior contract](docs/cli-contract.md)

## License

Timber CLI is [MIT License + Commons Clause v1.0](LICENSE): source-available,
not OSI-approved open source. Personal, educational, and internal business use,
modification, forking, and no-charge redistribution are permitted with notices.
Selling Timber or substantially equivalent offerings is prohibited under the
clause's terms, including certain paid hosting, consulting, or support services.
See [licensing details and third-party terms](docs/licensing.md).
