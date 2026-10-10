# Timber CLI behavioral contract

1. Discover repositories from nested directories and linked worktrees; distinguish the current worktree root from the common Git directory.
2. Git operations use the detected repository, not a hardcoded current directory.
3. `new <branch>` creates a new branch from the configured or explicit base. If the branch exists, report it and suggest `open`.
4. `open <input>` resolves an existing worktree, exact local branch, then exact remote branch. An explicit remote such as `origin/feature/foo` selects that remote.
5. A ticket prefix such as `ABU-834` may match branch names on a delimiter boundary. Exactly one match may be selected; multiple matches must show candidates and require an exact selection. Do not use arbitrary substring matching.
6. Refresh the selected remote before creating from a remote branch. An existing local worktree can open offline. A failed remote refresh must not be reported as success.
7. Base selection: `--base`, repository config, configured remote's default branch, then an unambiguous existing `main` or `master`. Never guess if resolution is ambiguous.
8. Worktree paths default to a sibling directory, `../<repository-name>-worktrees/<safe-branch-slug>`. Resolve config paths relative to the primary repository root. Reject collisions, path traversal, and attempts to target the primary repository.
9. `ls` lists the current repository's primary and linked worktrees, including ones created outside Timber, and identifies the primary worktree.
10. `done` never removes the primary worktree. Modified or untracked files always block cleanup. Unpublished or unknown publication blocks cleanup unless commits are contained in the validated base or Git proves that merging the local branch into that base adds no file changes.
11. Delete a local branch only when its commits are contained in the validated base or a successful Git virtual merge produces exactly the validated base tree. The latter proves content integration after a squash/rebase merge without requiring the original commit IDs or a live feature upstream. Recheck the target, base, and integration evidence before removal and branch deletion. Use only built-in merge behavior: reject custom merge-driver configuration and disable renormalization for this proof. Conflicts, unsupported Git operations, and uncertain evidence never authorize deletion. `--keep-branch` retains the local branch and permits clean, safely published worktree removal without requiring integration. Do not infer safety from a closed PR. Detached worktrees still require commit ancestry into the validated base.
12. No destructive `--force` in 0.1. No remote branch deletion, automatic stash, or implicit process killing.
13. `done` discards ignored files and directories, including `.env`, with the worktree by default. `--keep-ignored` refuses cleanup when ignored content exists, leaving those files, the worktree, and branch in their original locations; it does not copy them elsewhere. Retain `--discard-ignored` as a compatibility option. Reject combining it with `--keep-ignored`. Neither option bypasses modified/untracked files or commit/integration safety checks. Document the default in CLI help and the README.
14. Editors default to off until configured. Support `--no-editor`. Agent settings are parsed and retained in 0.1; agent launching remains 0.2. When implemented, agent launching is opt-in, follows the editor, and owns the invoking terminal.
15. CLI success means required Git/setup work completed. If editor/agent startup fails after creation, retain the workspace and explain how to retry. Editor launch success is process startup only: Timber returns promptly and does not report a later nonzero editor exit, even when editor args include `--wait`.
16. Human output goes to stdout; errors go to stderr; failed operations return a nonzero exit code. Keep noninteractive behavior deterministic; never hang waiting for input in CI.

## Repository configuration

Read only `.timber.toml` from the primary worktree root. Do not search nested or linked-worktree directories, the caller's current directory, or global config. A missing file uses the defaults below; unknown keys and invalid values are errors. Global config is deferred.

The supported 0.1 keys are `base_branch`, `remote`, `worktree_dir`, `[editor]`, and `[agent]`. `base_branch` and `remote` default to absent. `worktree_dir` defaults to absent and, when relative, resolves against the primary root. `[editor]` requires a non-empty executable `command`; `args` is a string array defaulting to `[]`. `[agent]` also requires `command` and accepts `args` defaulting to `[]` plus boolean `enabled` defaulting to `false`. Agent settings are parsed and retained in 0.1; agent launching remains 0.2.

Explicit CLI values take precedence over config, and config takes precedence over documented service defaults. Diagnostics identify the config file and invalid field without printing config values. Do not store credentials or other secrets in this file; use environment variables or a secret store. Hooks are a 0.2 extension described below; Jira settings remain unsupported.

```toml
base_branch = "main"
remote = "origin"
worktree_dir = "../timber-worktrees"

[editor]
command = "zed"
args = ["--new"]

[agent]
enabled = false
command = "claude"
args = []
```

An alternative for Visual Studio Code is:

```toml
[editor]
command = "code"
args = ["--new-window"]
```

The editor executable must be available on `PATH` or configured by absolute path. Editor and agent commands are executable names plus argument arrays, never shell command strings. Pass editor arguments literally and append the absolute selected worktree path as the final argument. On startup failure after worktree creation, retain the worktree and provide a retry command of the form `timber open -- '<absolute-worktree-path>'`; retry opens the existing worktree after the user fixes the editor configuration or `PATH`. The retry string is display text and must not be executed internally. Trusted shell hooks, when implemented, receive context through environment variables; do not substitute branch names or ticket text into shell source.

## Setup hooks (0.2, TIM-7)

The strict `[hooks]` table accepts only `post_create`, a string array defaulting
to `[]`. Each command must contain non-whitespace source and no NUL bytes;
preserve its source literally. Absent hooks mean setup is off. Read hooks only
from the primary root's config, never the linked worktree's config.

`new` and `open` run setup after creating a worktree and before launching its
editor. Normal `open` reuses an existing worktree without setup. `open --setup`
explicitly runs every step from the beginning for the selected worktree,
including primary and detached worktrees; creation plus `--setup` runs once.
`--no-editor` does not disable setup.

On Linux, invoke `/bin/sh` with argument array `["-c", configuredSource]` for
each step, sequentially, with worktree cwd, closed stdin, and stdout/stderr
streamed to their respective invoking streams. Each step has its own shell;
there is no implicit `set -e`. Hooks are trusted code with the user's permissions
and inherited environment. Document this trust boundary and safe reruns.

Override `TIMBER_REPO` with the absolute primary root, `TIMBER_WORKTREE` with
the selected absolute path, and `TIMBER_BRANCH` with the selected local branch
name (empty for detached HEAD). Set `TIMBER_TASK_ID` to the branch's leading
`[A-Z][A-Z0-9]*-<digits>` ticket ID only when followed by end or `-`, `_`, `.`, `/`;
otherwise remove any inherited value. Context values are environment data,
never substitutions into shell source.

Failure returns nonzero, identifies the one-based step and exit code/signal
or shell startup failure, stops subsequent hooks and launch, and retains all
workspace state. Do not echo shell source in the diagnostic or roll back hook
changes. Report a safely quoted retry of the form
`timber open --setup -- '<absolute-worktree-path>'`; use a printable Bash retry
for paths containing terminal controls. Timber never executes the retry text.
