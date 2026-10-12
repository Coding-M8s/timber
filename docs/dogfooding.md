# Timber workflow dogfooding

This checklist exercises the real CLI through create, setup, reopen, list, and safe cleanup. It uses a disposable Git repository and a local bare remote; it needs no network access or credentials. The configured `post_create` hook is trusted shell code and runs with your account's permissions. Read the hook before running it.

Use Linux x86_64, Git, Bun 1.4.2 or newer, and a Timber source checkout. These commands use synthetic names and data. `done` discards ignored files in the selected worktree by default, including `.setup-log`; the commands below create that file only in disposable worktrees.

## Prepare a disposable repository

Set `CHECKOUT` to the Timber source checkout, then run:

```bash
LAB="$(mktemp -d "${TMPDIR:-/tmp}/timber-dogfooding.XXXXXX")"
PRIMARY="$LAB/primary"
BARE="$LAB/origin.git"
WORKTREE_ROOT="$LAB/primary repo-worktrees"
WORKFLOW_TREE="$WORKTREE_ROOT/TIM-16-workflow"
KEEP_TREE="$WORKTREE_ROOT/TIM-16-keep-branch"
INTEGRATED_TREE="$WORKTREE_ROOT/TIM-16-integrated"

git init --initial-branch=main "$PRIMARY"
git -C "$PRIMARY" config user.name "Timber Dogfood"
git -C "$PRIMARY" config user.email timber-dogfood@example.invalid
mkdir -p "$PRIMARY/nested"
printf 'original project content\n' > "$PRIMARY/tracked.txt"
printf 'Nested discovery fixture.\n' > "$PRIMARY/nested/README.md"
cat > "$PRIMARY/.gitignore" <<'EOF'
.env
.setup-log
.timber.toml
EOF
git -C "$PRIMARY" add .gitignore tracked.txt nested/README.md
git -C "$PRIMARY" commit -m "create dogfooding fixture"
cat > "$PRIMARY/.timber.toml" <<'EOF'
base_branch = "main"
worktree_dir = "../primary repo-worktrees"

[hooks]
post_create = ['printf "%s\n%s\n%s\n%s\n%s\n" "$PWD" "$TIMBER_REPO" "$TIMBER_WORKTREE" "$TIMBER_BRANCH" "$TIMBER_TASK_ID" >> .setup-log']
EOF
```

The tracked `.gitignore` keeps `.timber.toml` and hook output out of Git status. The hook writes its working directory and the four Timber context values to an ignored file.

## Create, reopen, and list

Run `new`, then inspect the ignored setup log. It should contain five lines: the worktree path, primary repository path, worktree path, `TIM-16-workflow`, and `TIM-16`.

```bash
(cd "$PRIMARY" && bun --no-env-file "$CHECKOUT/src/index.ts" new TIM-16-workflow --base main --no-editor --no-agent)
cat "$WORKFLOW_TREE/.setup-log"
```

Run ordinary `open` and confirm the log remains five lines. Then run explicit setup and confirm it grows to ten lines.

```bash
(cd "$PRIMARY/nested" && bun --no-env-file "$CHECKOUT/src/index.ts" open TIM-16-workflow --no-editor --no-agent)
wc -l < "$WORKFLOW_TREE/.setup-log"
(cd "$PRIMARY/nested" && bun --no-env-file "$CHECKOUT/src/index.ts" open TIM-16-workflow --setup --no-editor --no-agent)
wc -l < "$WORKFLOW_TREE/.setup-log"
```

List from the primary root, its nested directory, and the linked worktree. The output should be identical from all three locations, identify the primary row, and show one ignored file in the linked row.

```bash
(cd "$PRIMARY" && bun --no-env-file "$CHECKOUT/src/index.ts" ls)
(cd "$PRIMARY/nested" && bun --no-env-file "$CHECKOUT/src/index.ts" ls)
(cd "$WORKFLOW_TREE" && bun --no-env-file "$CHECKOUT/src/index.ts" ls)
```

## Prove published and integrated cleanup

Create a local bare remote and publish a synthetic feature commit. Also create one branch to retain and another branch whose commit will be integrated into `main`.

```bash
git init --bare --initial-branch=main "$BARE"
git -C "$PRIMARY" remote add origin "$BARE"
git -C "$PRIMARY" push -u origin main

(cd "$PRIMARY" && bun --no-env-file "$CHECKOUT/src/index.ts" new TIM-16-keep-branch --base main --no-editor --no-agent)
(cd "$PRIMARY" && bun --no-env-file "$CHECKOUT/src/index.ts" new TIM-16-integrated --base main --no-editor --no-agent)

printf 'workflow feature commit\n' >> "$WORKFLOW_TREE/tracked.txt"
git -C "$WORKFLOW_TREE" add -- tracked.txt
git -C "$WORKFLOW_TREE" -c user.name="Timber Dogfood" -c user.email=timber-dogfood@example.invalid commit -m "add published workflow change"
git -C "$WORKFLOW_TREE" push -u origin TIM-16-workflow

printf 'integrated into main\n' > "$INTEGRATED_TREE/integration.txt"
git -C "$INTEGRATED_TREE" add -- integration.txt
git -C "$INTEGRATED_TREE" -c user.name="Timber Dogfood" -c user.email=timber-dogfood@example.invalid commit -m "add integrated cleanup change"
git -C "$PRIMARY" merge --ff-only TIM-16-integrated
git -C "$PRIMARY" merge-base --is-ancestor TIM-16-integrated main
```

Record `git -C "$PRIMARY" worktree list --porcelain` and `git -C "$PRIMARY" show-ref` before cleanup. Run default cleanup on the published feature, then confirm that only its local worktree and local branch were removed. The remote branch must remain.

```bash
(cd "$PRIMARY" && bun --no-env-file "$CHECKOUT/src/index.ts" done TIM-16-workflow)
git -C "$PRIMARY" worktree list --porcelain
git -C "$PRIMARY" show-ref
git --git-dir="$BARE" show-ref
```

Run `done --keep-branch` for the clean branch at the base. Confirm its worktree is gone and its local branch remains. Then clean up the integrated branch and confirm only the primary worktree remains.

```bash
(cd "$PRIMARY" && bun --no-env-file "$CHECKOUT/src/index.ts" done TIM-16-keep-branch --keep-branch)
(cd "$PRIMARY" && bun --no-env-file "$CHECKOUT/src/index.ts" done TIM-16-integrated)
git -C "$PRIMARY" worktree list --porcelain
git -C "$PRIMARY" show-ref
git --git-dir="$BARE" show-ref
```

All Timber commands above should exit 0 with empty stderr. After each `done`, check the worktree inventory and refs before continuing. Remove the disposable lab after saving the result:

```bash
rm -rf "$LAB"
```

## Recorded implementation run

Observed on Linux x86_64 with Bun 1.4.2 and Git 2.55.0, using Timber source commit `8bd043c`. The temporary root is shown as `$LAB`; paths below are the observed output with only that ephemeral prefix normalized.

| Command | Exit | Observed stdout | Observed stderr and state |
| --- | ---: | --- | --- |
| `new TIM-16-workflow --base main --no-editor --no-agent` | 0 | `Created TIM-16-workflow at $LAB/timber dogfood worktrees/TIM-16-workflow` | Empty. Branch points to base commit `e5982d9afa452f1d33381c7850dc5e9de3b287b9`; worktree contains the five expected hook context lines. |
| `open TIM-16-workflow --no-editor --no-agent` | 0 | `Opened existing worktree at $LAB/timber dogfood worktrees/TIM-16-workflow` | Empty. Setup log stayed at five lines. |
| `open TIM-16-workflow --setup --no-editor --no-agent` | 0 | `Opened existing worktree at $LAB/timber dogfood worktrees/TIM-16-workflow` | Empty. Setup log grew to ten lines. |
| `ls` from primary, nested, and linked paths | 0 each | Identical output: `WORKTREE<TAB>BRANCH<TAB>STATUS<TAB>PATH`, then `primary<TAB>main<TAB>clean; 1 ignored<TAB>$LAB/primary` and `linked<TAB>TIM-16-workflow<TAB>clean; 1 ignored<TAB>$LAB/timber dogfood worktrees/TIM-16-workflow` | Empty for all three invocations. |
| `done TIM-16-workflow` | 0 | `Removed worktree at $LAB/timber dogfood worktrees/TIM-16-workflow` and `Deleted local branch TIM-16-workflow` | Empty. Local feature ref was removed; bare remote retained `TIM-16-workflow` at `0d49f5a22ecce134883ea1cf04c8b9d1c4b74cb3`. Primary, keep, and integrated worktrees remained registered. |
| `done TIM-16-keep-branch --keep-branch` | 0 | `Removed worktree at $LAB/timber dogfood worktrees/TIM-16-keep-branch` and `Retained local branch TIM-16-keep-branch` | Empty. Keep worktree was absent from inventory; local branch remained at `e5982d9afa452f1d33381c7850dc5e9de3b287b9`; integrated worktree remained. |
| `done TIM-16-integrated` | 0 | `Removed worktree at $LAB/timber dogfood worktrees/TIM-16-integrated` and `Deleted local branch TIM-16-integrated` | Empty. The integrated file remained in `main`; only the primary worktree remained registered. |

Before cleanup, the primary and integrated worktrees pointed to `607fdbcfd9a45ef250a5263549b84bd552266dc9`, the keep worktree pointed to `e5982d9afa452f1d33381c7850dc5e9de3b287b9`, and the published worktree pointed to `0d49f5a22ecce134883ea1cf04c8b9d1c4b74cb3`. After all cleanup, local `main` remained at the integrated commit, `TIM-16-keep-branch` remained at the base commit, and the bare remote still contained both `main` and `TIM-16-workflow`.

This is the implementation run, not the separate team exercise required by TIM-16. A team member still needs to follow this checklist and record their own date, commit, and result before the issue's team-exercise acceptance criterion is complete.
