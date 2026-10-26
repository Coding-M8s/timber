> [!IMPORTANT]
> Remove this line to confirm you've reviewed this PR before submitting.
# Timber

Work on several Git branches at once, each in its own folder. Timber creates,
opens, lists, rebases, and removes Git worktrees. It can also run setup scripts
and launch your editor or coding assistant.

## Quick start

You need Git and Bun 1.4.2. Linux x86_64 is the tested platform.
macOS is available in [beta for Apple Silicon and Intel](docs/releases.md#macos-beta).

```bash
git clone https://github.com/Coding-M8s/timber.git
cd timber
bun install --frozen-lockfile
bun link
timber --help
```

Keep Bun and the checkout in place when using `bun link`. If `timber` isn't
found, add `~/.bun/bin` to your PATH. For an executable without Bun, see
[release downloads](docs/guide.md#install-the-standalone-cli) or
[build and install locally](docs/local-install.md).

Windows x64 candidate work and pending native checks are documented in the
[Windows guide](docs/windows.md).

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
| `timber ls` | List paths, bases, workflows, and file status |
| `timber done my-feature` | Remove a finished worktree and its local branch |
| `timber done my-feature --base parent-feature` | Override the cleanup merge target |

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

## More help

Use `timber <command> --help` for flags.

- [User guide](docs/guide.md): configuration, Jira, trusted shell hooks, and workflows
- [Arena](docs/guide.md#arena-multiple-isolated-attempts): create and resume isolated agent attempts
- [Shell completion](docs/completion.md): Bash, Zsh, and Fish
- [Orca editor terminals](docs/editor-terminals.md)
- [Building and releasing](docs/releases.md)
- [Development guidance](AGENTS.md) and [code map](docs/shared-contracts.md)
- [CLI behavior contract](docs/cli-contract.md)

## License

Timber CLI is [MIT License + Commons Clause v1.0](LICENSE): source-available,
not OSI-approved open source. Personal, educational, and internal business use,
modification, forking, and no-charge redistribution are permitted with notices.
Selling Timber or substantially equivalent offerings is prohibited under the
clause's terms, including certain paid hosting, consulting, or support services.
See [licensing details and third-party terms](docs/licensing.md).
