# Timber Terminals for VS Code

This extension lets the [Timber](https://github.com/Coding-M8s/timber) CLI run
setup scripts and a coding assistant in integrated terminals of the exact
worktree window, when the editor is configured with `integration = "vscode"`.

It only opens terminals that Timber requests. It adds no commands, views,
settings, or tasks, and it never edits `tasks.json` or sends keystrokes.

## How it works

- Timber writes a private request file to `/tmp/timber-vscode-<uid>/`. The
  directory and every file must be owned by you and closed to other users, or
  the extension ignores them.
- A local window whose workspace folder is exactly the requested worktree
  claims the request with an atomic rename. Timber cancels with the same rename,
  so a request is either claimed once or cancelled, never both.
- The extension accepts only Timber's runner invocation
  (`/tmp/timber-launch-*/runtime ... __editor-task <dir>`) and starts it with
  `createTerminal({ cwd, shellPath, shellArgs })`. All user values stay in the
  runner's private request file.
- Remote, container, and virtual workspaces are ignored.

## Install

Release archives do not include the extension yet. Build and install it from a
Timber checkout (packaging downloads the pinned `@vscode/vsce` tool):

```bash
bun install --frozen-lockfile
bun run package:extension
code --install-extension vscode-extension/timber-terminals-0.1.0.vsix
```

Timber never installs the extension for you. See
[editor terminals](../docs/editor-terminals.md) for configuration and failure
handling.
