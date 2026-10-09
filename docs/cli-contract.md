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
10. `done` never removes the primary worktree. By default, it refuses modified or untracked files and unpublished commits. Unknown publication state blocks cleanup unless all branch commits are already contained in the validated base.
11. Delete a local branch only when its commits are contained in the validated base. `--keep-branch` permits clean, safely published worktree removal without requiring branch merge. If squash/rebase merging prevents proving ancestry, retain the branch or explain the refusal; do not infer safety from a closed PR.
12. No destructive `--force` in 0.1. No remote branch deletion, automatic stash, or implicit process killing.
13. Automatic cleanup must account for ignored files: preserve a worktree when ignored content exists unless the user explicitly chooses `--discard-ignored`. Explain this requirement for common ignored files such as `.env`. Do not silently erase them.
14. Editors default to off until configured. Support `--no-editor`. Agent launching is opt-in; editor opens first and the agent then owns the invoking terminal.
15. CLI success means required Git/setup work completed. If editor/agent launch fails after creation, retain the workspace and explain how to retry.
16. Human output goes to stdout; errors go to stderr; failed operations return a nonzero exit code. Keep noninteractive behavior deterministic; never hang waiting for input in CI.

Example configuration; hook and agent sections become active in 0.2:

```toml
base_branch = "main"
remote = "origin"
worktree_dir = "../my-repo-worktrees"

[editor]
command = "zed"
args = []

[agent]
enabled = false
command = "claude"
args = []

[hooks]
post_create = ["cp \"$TIMBER_REPO/.env\" .env"]

[jira]
url = "https://example.atlassian.net"
project = "ABU"
```

Editor/agent commands are executable names plus argument arrays, not shell strings. Hooks deliberately run trusted shell commands and receive context through environment variables. Do not substitute branch names or ticket text directly into shell source. Secrets stay outside repository config.
