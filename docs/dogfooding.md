# Timber workflow dogfooding

This checklist exercises the real CLI through create, setup, reopen, list, and safe cleanup. It uses a disposable Git repository and a local bare remote; it needs no network access or credentials. The configured `post_create` hook is trusted shell code and runs with your account's permissions. Read the hook before running it.

Use Linux x86_64 and Git. For a release exercise, set `TIMBER_BIN` to the absolute
path of the downloaded, checksum-verified executable; Bun is not needed. For a
source exercise, leave `TIMBER_BIN` unset and use Bun 1.4.5 and a source checkout.
These commands use synthetic names and data. `done` discards ignored files in the selected worktree by default, including `.setup-log`; the commands below create that file only in disposable worktrees.

## Prepare a disposable repository

For a source exercise set `CHECKOUT` to the absolute source checkout. Define this
helper in the same shell as the remaining commands; it selects the downloaded
binary when `TIMBER_BIN` is set:

```bash
timber_cli() {
  if [ -n "${TIMBER_BIN:-}" ]; then
    "$TIMBER_BIN" "$@"
  else
    bun --no-env-file "$CHECKOUT/src/index.ts" "$@"
  fi
}
```

Then prepare the disposable repository:

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
(cd "$PRIMARY" && timber_cli new TIM-16-workflow --base main --no-editor --no-agent)
cat "$WORKFLOW_TREE/.setup-log"
```

Run ordinary `open` and confirm the log remains five lines. Then run explicit setup and confirm it grows to ten lines.

```bash
(cd "$PRIMARY/nested" && timber_cli open TIM-16-workflow --no-editor --no-agent)
wc -l < "$WORKFLOW_TREE/.setup-log"
(cd "$PRIMARY/nested" && timber_cli open TIM-16-workflow --setup --no-editor --no-agent)
wc -l < "$WORKFLOW_TREE/.setup-log"
```

List from the primary root, its nested directory, and the linked worktree. The output should be identical from all three locations, identify the primary row, and not mention ignored files.

```bash
(cd "$PRIMARY" && timber_cli ls)
(cd "$PRIMARY/nested" && timber_cli ls)
(cd "$WORKFLOW_TREE" && timber_cli ls)
```

## Prove published and integrated cleanup

Create a local bare remote and publish a synthetic feature commit. Also create one branch to retain and another branch whose commit will be integrated into `main`.

```bash
git init --bare --initial-branch=main "$BARE"
git -C "$PRIMARY" remote add origin "$BARE"
git -C "$PRIMARY" push -u origin main

(cd "$PRIMARY" && timber_cli new TIM-16-keep-branch --base main --no-editor --no-agent)
(cd "$PRIMARY" && timber_cli new TIM-16-integrated --base main --no-editor --no-agent)

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
(cd "$PRIMARY" && timber_cli done TIM-16-workflow)
git -C "$PRIMARY" worktree list --porcelain
git -C "$PRIMARY" show-ref
git --git-dir="$BARE" show-ref
```

Run `done --keep-branch` for the clean branch at the base. Confirm its worktree is gone and its local branch remains. Then clean up the integrated branch and confirm only the primary worktree remains.

```bash
(cd "$PRIMARY" && timber_cli done TIM-16-keep-branch --keep-branch)
(cd "$PRIMARY" && timber_cli done TIM-16-integrated)
git -C "$PRIMARY" worktree list --porcelain
git -C "$PRIMARY" show-ref
git --git-dir="$BARE" show-ref
```

All Timber commands above should exit 0 with empty stderr. After each `done`, check the worktree inventory and refs before continuing. Remove the disposable lab after saving the result:

```bash
rm -rf "$LAB"
```
