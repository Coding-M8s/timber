# Timber CLI — Codex GitHub Setup Handoff

## Your assignment

Execute this handoff. Create a GitHub repository, a GitHub Project with a board, repository milestones, and the 17 implementation issues below. Populate the Project and connect dependencies. Do not merely return another plan.

This assignment is **project setup**, not implementation of all tickets. Initialize the repository with useful documentation and development guidance; leave application implementation to the issues.

The user approved a small, fast-to-ship CLI written in TypeScript for three developers. Timber manages Git worktrees, opens editors, and later adds setup hooks, Jira, and agent launching. An IDE or GUI belongs to **2.0** and is excluded from this backlog. A Rust rewrite is not a milestone.

## 1. Resolve the GitHub destination

The user confirmed the destination organization: **[Coding-M8s](https://github.com/Coding-M8s)**. Create the private repository as **`Coding-M8s/timber`** and the **Timber CLI** Project under that same organization. Do not create these under the personal account.

Use these settings:

| Setting | Default |
| --- | --- |
| Repository name | `timber` |
| Description | A small CLI for creating, opening, listing, and safely cleaning up Git worktrees. |
| Visibility | Private |
| Project name | Timber CLI |
| Default branch | main |
| Repository owner | `Coding-M8s` organization |
| Project owner | `Coding-M8s` organization |
| Developers | Dev 1, Dev 2, Dev 3 logical lanes; actual GitHub assignees optional |

This handoff will run in **Codex on the user's own machine**. Prefer the authenticated GitHub CLI (`gh`) for repository, issue, and Project operations; use its supported API commands where needed. Check `gh auth status`, organization access, and permissions required for repository, issue, and Project writes before mutation. Never print tokens.

If repository writes work but Project writes do not, report the missing authorization precisely and retain completed work. Verify current GitHub CLI/API requirements rather than assuming repository access grants organization Project access.

- Use a user-supplied organization or repository instead of the defaults.
- If an explicit organization is ambiguous, ask for the exact owner before writing there.
- Reuse an existing matching repository and Project after inspecting their contents.
- Preserve existing code, issues, settings, and unrelated board fields.
- Do not create `timber-2` or another substitute name silently.
- Do not invent usernames, assign strangers, or invite collaborators. Use the Lane field until real usernames are provided.
- Do not make the repository or Project public, purchase services, or choose a license without instructions.
- If authentication or required permissions are missing, complete the local documentation and a resumable setup manifest first, then report the exact remaining blocker.

Creating the repository, Project, issues, and project metadata is the intended action when the user asks you to execute this handoff. Follow the receiving environment's authorization requirements. Do not ask for repeated confirmation of the same authorized setup.

## 2. Product scope and implementation direction

### Timber 0.1 — useful worktree CLI

Four commands:

```bash
timber new my-feature
timber open my-feature
timber ls
timber done my-feature
```

Include repository discovery, local and remote branch handling, configuration, editor launching, and conservative cleanup.

### Timber 0.2 — integrations

Add setup hooks, optional Claude/Codex launching, and Jira issue resolution. Both releases must work without Jira credentials or an AI subscription.

### Timber 1.0 — confidence

Stabilize what exists after the team uses it on real repositories. Improve errors, prove cleanup safety, document it, and publish verified packages. Do not use 1.0 to add a framework or IDE.

### Technical direction

- TypeScript with Bun for development, tests, and optional standalone executable builds.
- Commander for command parsing; Execa for subprocesses; Zod for config validation; smol-toml for TOML.
- Verify supported versions and compatibility when bootstrapping. Commit a lockfile.
- Invoke installed Git with argument arrays. Do not interpolate user input into shell commands.
- Git worktree metadata is the source of truth. No database, daemon, local API, global task registry, or provider plugin framework is required.
- A small shared types file and a few plain functions are sufficient.
- Linux x86_64 is the first release target. Other platforms are follow-up work only after actual testing.
- Keep editor launching and agent launching separate. Agents run interactively in the invoking terminal; no terminal emulator or session manager.
- Measure a demonstrated performance problem before considering Rust.

Suggested layout:

```text
src/
  index.ts
  commands/
    new.ts
    open.ts
    list.ts
    done.ts
  git/
    repository.ts
    branches.ts
    worktrees.ts
  config/
    config.ts
  integrations/
    editor.ts
    agent.ts
    jira.ts
  hooks.ts
  types.ts
tests/
docs/
```

### Shared behavioral contract

Write this contract to `docs/cli-contract.md` during setup so the developers can implement independently. TIM-11 establishes the matching TypeScript contracts and test doubles.

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

The 0.1 `.timber.toml` schema is strict and accepts `base_branch`, `remote`, `worktree_dir`, `[editor]`, and `[agent]`. The file is read only from the primary worktree root; relative worktree paths resolve against it. Editor and agent commands are executable names plus argument arrays, never shell strings. The `[agent]` table requires `command`, defaults `args` to `[]` and `enabled` to `false`, and is retained in 0.1; launch behavior remains in 0.2. Hooks and Jira are not supported config keys in 0.1. Keep secrets outside repository config.

```toml
base_branch = "main"
remote = "origin"
worktree_dir = "../my-repo-worktrees"

[editor]
command = "zed"
args = ["--wait"]

[agent]
enabled = false
command = "claude"
args = []
```

Trusted shell hooks, when implemented, receive context through environment variables. Do not substitute branch names or ticket text directly into shell source.

## 3. Initialize the repository

Create or update only the files needed for the setup:

- `README.md`: product purpose, release scope, planned commands, and link to the board. Clearly label commands as planned until implemented.
- `.gitignore`: sensible TypeScript/Bun entries, build output, credentials, and local config.
- `AGENTS.md`: TypeScript/Bun direction; small modules; no IDE work; no Rust rewrite; Git argument arrays; meaningful temporary-repository tests for Git mutations; independent ticket branches and PRs.
- `docs/timber-github-handoff.md`: this handoff.
- `docs/cli-contract.md`: the behavioral contract above.
- `docs/github-project-setup.json`: actual repository/Project URLs, milestone IDs, issue number mapping, Project item/field IDs, and any incomplete setup actions. No secrets.

Create an initial documentation commit and push it. Do not fabricate a passing build before TIM-11 implements the scaffold. Do not add a license or configure rules that require paid features.

The same code repository should contain the plan and setup mapping. No separate repository is needed for project administration.

## 4. Create milestones, labels, and the Project

Create repository milestones with no invented due dates:

| Milestone | Outcome |
| --- | --- |
| v0.1 — Worktree CLI | Four commands, Git resolution, config, editor opening, safe cleanup |
| v0.2 — Integrations | Hooks, Jira, optional agent launching |
| v1.0 — Stable CLI | Dogfooding fixes, UX, documentation, verified release |

Create labels as needed without overwriting unrelated labels:

- `area:git`, `area:config`, `area:cli`, `area:integrations`, `area:release`
- `priority:P0`, `priority:P1`
- `bug`, `documentation`

Use a GitHub Project, not a legacy project board. Add these fields:

| Field | Kind | Values |
| --- | --- | --- |
| Status | Single select | Backlog, Ready, In Progress, In Review, Blocked, Done |
| Lane | Single select | Dev 1 — Git, Dev 2 — Config and integrations, Dev 3 — CLI and release |
| Priority | Single select | P0, P1 |
| Size | Single select | S, M, L |

Use each issue's native repository milestone and labels. Do not create duplicate custom fields for the same metadata.

Configure a **Delivery board** grouped by Status and a **Developer lanes** table grouped by Lane. A release-filtered view is useful if easy to create.

Use current supported GitHub APIs/tools and verify their capabilities. If view creation, dependencies, or a particular field cannot be configured through the available interface, use supported alternatives, preserve all issue bodies, and list the exact manual step needed. Never claim a board view exists merely because a Project exists.

Simple automation, if supported: closed issues become Done; reopened issues return to Backlog. Ready still depends on prerequisites being complete.

No epics or placeholder IDE tickets are required. This is a flat, manageable 17-ticket backlog.

## 5. Issue inventory and scheduling

The TIM identifiers are stable planning IDs included in issue titles. They are **not** GitHub issue numbers.

Create each issue as `[TIM-N] Title`. After all issues exist, replace dependency identifiers in their bodies with links to the actual issues. Add native blocking relationships if supported; otherwise retain the linked dependency sections.

| ID | Title | Lane | Milestone | Priority | Size | Depends on |
| --- | --- | --- | --- | --- | --- | --- |
| TIM-11 | Bootstrap CLI, CI, and shared contracts | Dev 3 | v0.1 | P0 | S | None |
| TIM-1 | Detect repository and worktree context | Dev 1 | v0.1 | P0 | S | TIM-11 |
| TIM-2 | Resolve local and remote branches | Dev 1 | v0.1 | P0 | M | TIM-1 |
| TIM-3 | Create worktrees safely | Dev 1 | v0.1 | P0 | M | TIM-2 |
| TIM-4 | Find and open existing worktree targets | Dev 1 | v0.1 | P0 | S | TIM-2 |
| TIM-5 | Implement conservative cleanup checks | Dev 1 | v0.1 | P0 | L | TIM-3 |
| TIM-6 | Load and validate repository configuration | Dev 2 | v0.1 | P0 | S | TIM-11 |
| TIM-8 | Launch the configured editor | Dev 2 | v0.1 | P1 | S | TIM-6 |
| TIM-12 | Implement timber new | Dev 3 | v0.1 | P0 | M | TIM-3, TIM-6, TIM-8 |
| TIM-13 | Implement timber open | Dev 3 | v0.1 | P0 | M | TIM-3, TIM-4, TIM-6, TIM-8 |
| TIM-14 | Implement timber ls | Dev 3 | v0.1 | P0 | S | TIM-1 |
| TIM-15 | Implement timber done | Dev 3 | v0.1 | P0 | M | TIM-5, TIM-6 |
| TIM-7 | Run setup hooks and preserve failed setups | Dev 2 | v0.2 | P1 | M | TIM-6, TIM-12, TIM-13 |
| TIM-9 | Launch optional Claude or Codex agents | Dev 2 | v0.2 | P1 | S | TIM-8, TIM-12, TIM-13 |
| TIM-10 | Resolve Jira tickets and generate branch names | Dev 2 | v0.2 | P1 | M | TIM-2, TIM-6, TIM-12 |
| TIM-16 | Polish errors and validate real workflows | Dev 3 | v1.0 | P1 | M | TIM-7, TIM-9, TIM-10, TIM-14, TIM-15 |
| TIM-17 | Package, document, and verify releases | Dev 3 | v1.0 | P1 | M | TIM-16 |

Initial statuses: TIM-11 = Ready; all other issues = Backlog. Dependencies alone do not mean an issue should be marked Blocked before anyone starts it. Set Blocked only for an active impediment.

Suggested order once the scaffold merges:

- Dev 1: TIM-1 → TIM-2 → TIM-3 → TIM-4 → TIM-5.
- Dev 2: TIM-6 → TIM-8, then prepare hooks/Jira/agent implementations against shared contracts while commands are wired.
- Dev 3: TIM-14 and command wiring using test doubles, then TIM-12/TIM-13/TIM-15 as services land.
- Publish 0.1 before waiting on 0.2 integrations. Dev 3 can prepare release documentation and packaging early, with final acceptance tracked by TIM-17.
- Dev 1 takes Git regressions found during dogfooding; Dev 2 takes integration regressions. Avoid placing every later bug on Dev 3.
- One implementer and one reviewer per PR. Keep three independent lanes; change shared contracts in a small reviewed PR before incompatible work.
- Do not promise a fixed delivery date. Small releases and fewer features are the speed strategy.

## 6. Full issue bodies

Use each section below as the corresponding issue body, adding its metadata from the inventory. Every body must contain Goal, Scope, Acceptance criteria, Verification, and Dependencies.

### TIM-11 — Bootstrap CLI, CI, and shared contracts

**Goal:** Give all three developers a runnable scaffold and stable contracts.

**Scope:** TypeScript/Bun scaffold, command parser, shared repository/branch/worktree/config types, command service seams, test doubles, and CI. No implementation of the Git engine.

**Acceptance criteria:**
- [ ] A local command displays `timber --help` and registers new/open/ls/done as explicit placeholders until implemented.
- [ ] Development, test, typecheck, and build scripts exist.
- [ ] GitHub CI installs locked dependencies and runs typecheck and tests.
- [ ] Shared function contracts match `docs/cli-contract.md` and let command development use test doubles.
- [ ] Repository structure stays small; no monorepo or framework.

**Verification:** Clean checkout install, help invocation, typecheck, tests, and build. Record exact commands and outputs in the PR.

**Dependencies:** None.

### TIM-1 — Detect repository and worktree context

**Goal:** Resolve Git context reliably wherever Timber is run.

**Scope:** Repository root, primary worktree root, common Git directory, current branch, remotes, and default-branch information.

**Acceptance criteria:**
- [ ] Running from a nested directory or a linked worktree returns the same repository identity.
- [ ] Current and primary worktree paths remain distinct.
- [ ] Non-repository paths, detached HEAD, and unsupported bare repositories have clear results.
- [ ] Paths with spaces work; no hardcoded origin/main/master assumptions.

**Verification:** Temporary real repositories with nested paths, linked worktrees, spaces, and detached HEAD.

**Dependencies:** TIM-11.

### TIM-2 — Resolve local and remote branches

**Goal:** Resolve branch inputs without guessing.

**Scope:** Exact local/remote refs, configured remote selection, safe fetching, unique ticket-prefix matches, and base selection.

**Acceptance criteria:**
- [ ] Exact local, remote-only, and explicit remote inputs resolve correctly.
- [ ] Prefix matches respect delimiters; ambiguity returns candidates.
- [ ] Remote refresh failures are visible and prevent stale remote creation.
- [ ] Base resolution follows the shared contract.
- [ ] Validate new branch names with Git; pass refs as separate arguments.

**Verification:** Local bare remote fixtures, multiple remotes, duplicate ticket prefixes, missing branches, and failed fetches.

**Dependencies:** TIM-1.

### TIM-3 — Create worktrees safely

**Goal:** Support creation from a new, local, or remote branch.

**Scope:** Git worktree creation and safe destination handling.

**Acceptance criteria:**
- [ ] New branch, existing local branch, and remote tracking branch creation all work.
- [ ] Existing paths and branches checked out elsewhere produce actionable errors.
- [ ] Generated path slugs cannot escape the configured directory; collisions are rejected.
- [ ] Failed creation does not leave misleading Timber state.
- [ ] Never delete a pre-existing directory or branch during recovery.

**Verification:** Real temporary repositories covering all three modes, path collisions, concurrent duplicate creation, and failed Git operations.

**Dependencies:** TIM-2.

### TIM-4 — Find and open existing worktree targets

**Goal:** Reuse worktrees before attempting new creation.

**Scope:** Parse Git's machine-readable worktree output into shared models and locate matching worktrees.

**Acceptance criteria:**
- [ ] Discover both Timber-created and manually created worktrees.
- [ ] Match exact branches and unique ticket prefixes consistently.
- [ ] Handle paths with spaces, detached worktrees, and missing/prunable entries explicitly.
- [ ] Already-checked-out branches identify their existing path.
- [ ] No database or substring-based porcelain parsing.

**Verification:** Real Git fixtures with multiple worktrees and stale entries.

**Dependencies:** TIM-2.

### TIM-5 — Implement conservative cleanup checks

**Goal:** Preserve work when removing a worktree or branch.

**Scope:** Cleanup inspection, clear reasons for refusal, worktree removal, and optional safe local branch deletion.

**Acceptance criteria:**
- [ ] Refuse dirty and untracked content; detect ignored content and require explicit `--discard-ignored` before discarding it.
- [ ] Refuse unpublished commits or unknown publication state unless commits are already contained in the validated base.
- [ ] Delete local branches only after proving ancestry into the validated base.
- [ ] `--keep-branch` supports clean, safely published worktree removal without deleting an unmerged branch.
- [ ] Never remove the primary, locked, or unrelated worktree.
- [ ] Recheck state immediately before mutation and handle partial failures clearly.
- [ ] No force bypass, remote deletion, automatic stash, or process killing.

**Verification:** Matrix of modified/untracked/ignored files, ahead branches, no upstream, merged branches, squash-merged branches, locked worktrees, and partial failure. Assert preserved files/refs after refusals.

**Dependencies:** TIM-3.

### TIM-6 — Load and validate repository configuration

**Goal:** Make project defaults predictable with one small config file.

**Scope:** `.timber.toml` at the primary repository root, schema validation, defaults, and CLI overrides. Global config is deferred.

**Acceptance criteria:**
- [ ] Read only `.timber.toml` at the primary root; load it identically from the primary repo, nested directories, and linked worktrees. A missing file returns documented defaults.
- [ ] Strictly validate `base_branch`, `remote`, `worktree_dir`, `[editor]`, and `[agent]`; reject unsupported keys and invalid values with file/field diagnostics that do not print config values.
- [ ] Explicit CLI values override config; config overrides documented defaults. Relative worktree paths resolve against the primary root.
- [ ] Editor and agent `command` values are non-empty executable names; `args` is a string array defaulting to `[]`.
- [ ] Parse and retain `[agent]` in 0.1 with boolean `enabled` defaulting to `false`; do not launch agents in TIM-6 (launching belongs to TIM-9 in 0.2).
- [ ] Secrets are not stored in config; absent config requires no external services.

**Verification:** Focused parser tests for precedence, relative paths, invalid values, and missing config.

**Dependencies:** TIM-11.

### TIM-8 — Launch the configured editor

**Goal:** Open the selected worktree in the user's editor.

**Scope:** Executable-plus-args launcher, with documented Zed and VS Code examples.

**Acceptance criteria:**
- [ ] Correct worktree path is appended as a separate argument.
- [ ] No editor is launched when unconfigured or when `--no-editor` is given.
- [ ] Executable failures are caught; the worktree remains available.
- [ ] Launch returns without waiting for the editor window to close.
- [ ] No shell interpolation; no editor plugin framework.

**Verification:** Stub executables capture arguments and simulate launch failure; smoke-test an installed editor when available.

**Dependencies:** TIM-6.

### TIM-12 — Implement timber new

**Goal:** Create a useful workspace in one command.

**Scope:** Wire config, base selection, branch/worktree creation, and optional editor opening.

**Acceptance criteria:**
- [ ] `timber new <branch>` creates the expected branch and worktree.
- [ ] `--base`, `--no-editor`, and documented path options work.
- [ ] Existing branch/path errors suggest the appropriate next command.
- [ ] Optional launch failure reports the retained workspace and retry instructions.
- [ ] No Jira or agent setup is required for 0.1.

**Verification:** CLI integration tests with real Git and a stub editor, including duplicate invocation and creation failure.

**Dependencies:** TIM-3, TIM-6, TIM-8.

### TIM-13 — Implement timber open

**Goal:** Open or materialize the correct existing branch.

**Scope:** Existing worktree → local branch → refreshed remote branch resolution.

**Acceptance criteria:**
- [ ] Reopening an existing worktree does not create another one.
- [ ] A local branch without a worktree gets one.
- [ ] A remote-only branch gets a tracking branch and worktree.
- [ ] Exact remote and unique ticket-prefix inputs work; ambiguous inputs do not guess.
- [ ] Existing local worktrees open offline; remote refresh errors remain visible.
- [ ] Missing input produces a clear error, not silent task creation.

**Verification:** End-to-end fixtures for each resolution path, ambiguity, offline reuse, and unavailable remotes.

**Dependencies:** TIM-3, TIM-4, TIM-6, TIM-8.

### TIM-14 — Implement timber ls

**Goal:** Show the repository's worktrees at a glance.

**Scope:** Paths, branches, primary-worktree marker, and clean/dirty status.

**Acceptance criteria:**
- [ ] Lists manually created and Timber-created worktrees.
- [ ] Marks the primary worktree and handles detached HEAD.
- [ ] Dirty and untracked counts reflect Git status.
- [ ] Stale/missing paths produce a useful row or warning without crashing the entire list.
- [ ] No fetch, mutation, or persistent registry is needed.

**Verification:** Temporary repository with primary, linked, dirty, detached, and stale worktrees.

**Dependencies:** TIM-1.

### TIM-15 — Implement timber done

**Goal:** Expose safe cleanup through an understandable command.

**Scope:** Target resolution, cleanup checks, `--keep-branch`, and `--discard-ignored`.

**Acceptance criteria:**
- [ ] `timber done <branch-or-worktree>` selects exactly one linked worktree.
- [ ] Refusals explain files/commits or ancestry/publication uncertainty.
- [ ] Safe completion removes the worktree and, when permitted, its local branch.
- [ ] Ignored-file discard is an explicit option, not an implicit consequence of cleanup.
- [ ] Success output describes only completed actions.
- [ ] Remote branches and unrelated files stay intact.

**Verification:** CLI tests reuse the cleanup safety matrix and assert filesystem/ref state after every result.

**Dependencies:** TIM-5, TIM-6.

### TIM-7 — Run setup hooks and preserve failed setups

**Goal:** Automate project setup without hiding failures.

**Scope:** `post_create` hooks only, explicit retry through `timber open <target> --setup`, and command integration.

**Acceptance criteria:**
- [ ] Hooks run sequentially in the created worktree with TIMBER_REPO, TIMBER_WORKTREE, TIMBER_BRANCH, and optional TIMBER_TASK_ID environment variables.
- [ ] Shell choice and trusted config behavior are documented for the initial Linux target.
- [ ] Hook failure stops later hooks and editor/agent launch; the branch/worktree remains.
- [ ] Failure output states which step failed and how to retry.
- [ ] Normal `open` does not rerun setup; `--setup` does so explicitly.
- [ ] No auto rollback that risks deleting user work.

**Verification:** Temporary hooks test cwd/context, ordering, failure, retry, and hostile characters in context values.

**Dependencies:** TIM-6, TIM-12, TIM-13.

### TIM-9 — Launch optional Claude or Codex agents

**Goal:** Start the user's installed agent in the correct worktree.

**Scope:** Small interactive command launcher for Claude and Codex; no API subscription management.

**Acceptance criteria:**
- [ ] Consume the validated `RepositoryConfig.agent` from TIM-6; launch is opt-in via its `enabled` setting or an explicit CLI choice, and documented disabling works.
- [ ] Pass the configured executable and each argument separately, without shell interpolation.
- [ ] Agent inherits the invoking terminal and selected worktree cwd.
- [ ] Editor launches first; agent invocation follows successful setup.
- [ ] Missing executables fail clearly without removing the workspace.
- [ ] Interrupts and exit codes are handled; no orphan background agent is started.
- [ ] No session manager, agent framework, or dependency on Jira.

**Verification:** Stub agents record cwd/args and simulate errors/exits; optional manual smoke tests for installed tools.

**Dependencies:** TIM-8, TIM-12, TIM-13.

### TIM-10 — Resolve Jira tickets and generate branch names

**Goal:** Turn a Jira ticket ID into a descriptive branch/worktree.

**Scope:** One Jira Cloud integration, title/URL lookup, basic title slugging, and `new` integration. Other ticket systems are deferred.

**Acceptance criteria:**
- [ ] Configured `timber new ABU-834` resolves the title and produces `ABU-834-<title-slug>`.
- [ ] Credential environment variables are documented; tokens never enter repository config, logs, or issue bodies.
- [ ] Missing credentials, timeouts, unavailable issues, and authorization errors have distinct useful errors.
- [ ] A recognized configured Jira input fails visibly when resolution fails; no silent fallback that creates the wrong branch.
- [ ] Plain branch input still works without Jira.
- [ ] Generated names pass Git validation and path-collision checks.
- [ ] Existing `open ABU-834` uses branch resolution without needing Jira API access.

**Verification:** Mock HTTP responses for success and failures; CLI creation fixture with deterministic ticket data. Verify current Jira API behavior using official documentation during implementation.

**Dependencies:** TIM-2, TIM-6, TIM-12.

### TIM-16 — Polish errors and validate real workflows

**Goal:** Make the implemented tool predictable in daily use.

**Scope:** Consistent output, actionable errors, documentation corrections, and fixes from team dogfooding.

**Acceptance criteria:**
- [ ] All commands have useful help and correct stdout/stderr/exit behavior.
- [ ] Unattended commands do not wait for interactive input.
- [ ] The team exercises a real create → setup → open → list → safe finish workflow.
- [ ] Editor/agent/hook/network failures describe retained state and recovery.
- [ ] Cleanup refusals demonstrably preserve work.
- [ ] Changes stay within the approved CLI scope; additional features become separate future proposals.

**Verification:** Existing integration suite plus a recorded manual dogfooding checklist. File concrete bugs and resolve release blockers.

**Dependencies:** TIM-7, TIM-9, TIM-10, TIM-14, TIM-15.

### TIM-17 — Package, document, and verify releases

**Goal:** Ship a reproducible installation that matches the completed release scope.

**Scope:** Standalone Bun builds, tagged GitHub releases, install/config/troubleshooting docs, and final acceptance.

**Acceptance criteria:**
- [ ] Release pipeline builds a Linux x86_64 executable from a tagged commit.
- [ ] Clean environment smoke test runs help and real worktree commands without requiring Bun/Node installed by the user.
- [ ] Document Git and configured editor/agent prerequisites.
- [ ] Publish checksums and the actual supported platform list; do not claim untested compatibility.
- [ ] README documents installation, four commands, config, hooks, Jira credentials, launch options, and cleanup limitations.
- [ ] Demonstrate 0.1 without integrations, 0.2 integration flows, and 1.0 acceptance after TIM-16.
- [ ] No GUI, IDE, Rust rewrite, or universal packaging requirement blocks the initial release.

**Verification:** Downloaded-artifact smoke test in an isolated environment; release pipeline test; end-to-end lifecycle and failure-recovery suite.

**Dependencies:** TIM-16 for final 1.0 acceptance. Preparation of the 0.1 packaging path may start earlier.

## 7. Apply and verify the setup

1. Inspect authentication, destination, and existing assets.
2. Create/reuse the repository and Project; commit the documentation.
3. Create/reuse milestones, labels, and Project fields.
4. Create the 17 issues with their complete bodies and metadata.
5. Add all 17 issues to the Project and set Lane/Priority/Size/Status.
6. Resolve TIM IDs to real issue URLs and add dependency links/native blocking edges.
7. Configure the board and lane view when supported.
8. Save the actual ID/URL mapping in `docs/github-project-setup.json` and push it.
9. Read back repository metadata, milestones, issue bodies, and Project items/field values. Confirm 17 unique TIM issues, correct milestones, an acyclic dependency graph, and no invented assignees.
10. Report repository URL, Project/board URL, issue count, what's Ready, and any manual setup steps.

Make execution resumable: search for matching repository, Project, milestone names, labels, and exact TIM title prefixes before creating them. On partial failure, update the manifest with completed IDs and remaining actions. A retry must not create duplicate issues or Projects.

If a feature is unsupported or a permission blocks a write, clearly distinguish completed work from remaining work. Never invent links or claim that the board, tickets, or dependencies were created without verifying them.

## Completion response expected from the receiving Codex

Return a short result with:
- Repository link.
- Project/board link.
- Confirmation that all 17 implementation issues were created and added.
- Confirmation that TIM-11 is Ready and other work is Backlog.
- Logical developer lanes and the first work each developer can take after bootstrap.
- Any specific permission or manual UI steps still required.

Do not implement the product as part of this setup run. The next task is TIM-11.
