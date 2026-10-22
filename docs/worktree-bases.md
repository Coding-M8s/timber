# Remembered worktree bases

Timber remembers the branch selected when `timber new` creates a worktree. `timber ls`
shows that choice in its BASE column, alongside the workflow. The saved base is the
intended target for future rebases; it follows the branch's current tip.

```sh
timber new my-feature --base origin/main
timber ls
timber rebase my-feature
```

Rebase chooses its base in this order:

1. Explicit `--base`.
2. The worktree's saved base.
3. Repository/global configuration.
4. Existing remote-default and unambiguous main/master discovery.

An explicit replacement becomes the saved choice when the rebase succeeds, is
already up to date, or pauses with conflicts:

```sh
timber rebase my-feature --base origin/release
```

Failures before rebase or non-conflict Git failures retain the previous choice.
Conflicts leave Git paused. Resolve and stage files, then use `git rebase --continue`
or `git rebase --abort` in that worktree. A later native abort restores Git's branch
state but does not restore the old saved base.

## Local and remote branches

`--base main` means the selected remote's `main`, matching existing rebase behavior.
Use `origin/main` to select the remote explicitly. Remote bases are fetched and
validated before rebasing; a stale cache never substitutes for a failed fetch.

Select a local branch with its full ref:

```sh
timber rebase my-feature --base refs/heads/main
```

Local bases work offline, including repositories without remotes. Timber uses the
local branch's current commit and checks that it has not changed before starting.
It warns on every invocation that the branch must be up to date. Timber does not
fetch, pull, or advance the local base branch. `ls` shows local bases as
`refs/heads/main` to distinguish them from `origin/main`.

## Existing worktrees and recovery

Worktrees created outside Timber or before this feature show `-` until a successful
or conflict-paused rebase saves a base. Ordinary `open` does not guess a parent or
overwrite the saved choice. Missing saved branches require an explicit replacement;
Timber does not silently switch to a configured default.

Saved bases live in private Git worktree metadata, alongside workflow associations,
without changing TOML or tracked files. `ls` remains offline and shows `?` with a
warning for malformed, stale, or unreadable metadata. Repair malformed/unreadable
records before retrying; an explicit rebase base can replace a stale identity record.
If saving fails after Git finishes or pauses, the diagnostic reports that actual
outcome and gives recovery guidance. Timber never resets or aborts to undo it.

Saved bases affect rebase only. Cleanup keeps its existing rules; use
`timber done my-feature --base <ref>` to choose a cleanup integration target.
