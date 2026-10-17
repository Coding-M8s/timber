# Timber: parallel worktrees, freshness, and agent visibility

> Historical research note, originally dated 12 October 2026; copied from Obsidian into Timber on 19 October 2026. Original discussion is retained below. Statements about current features, open tickets and external tools describe the earlier research context, not verified current availability or compatibility. All proposed commands and policies require design review; this note grants no permission for Git writes, automatic rebasing or publication. See the [current roadmap](arena-workflow-research.md#worktree-groups-freshness-and-agent-context) and [CLI contract](cli-contract.md) for current scope and preservation requirements. External tools are attributed research references; comparative trials remain proposed.

## Original prompt

> is there anything in timeber plans about opening multile worktrees from different subreasons like implement, review, test etc, where you could name multiple branches and have them built at once for different reasons? is there anything about using it to always make sure every worktree is based on most rescent verion of main since they easily get out of sync and need to be rebased all the time due to changes, and is there anything that lets it swarm basically and do more then one at a time etc? cold work with "entire cli" or "git ai", or do a similar simple version of them for knowing what is happening in your worktrees a speed and scale? just curious and can we mak a note of it under obsidian these are just questions,

## TL;DR

- Proposed roadmap epic: stand in primary `master` worktree, give one agent prompt, and receive a reviewable plan for several ticket worktrees.
- Initial focus: two or more implementation worktrees for work you will do, plus one review worktree. Add a separate manual QA worktree only when useful.
- Pin every implementation worktree to one freshly resolved `origin/master` commit. Review worktrees open the exact candidate branch or PR revision.
- Give each Timber worktree one freshness policy: guarded automatic upkeep, prompt/on-demand sync, or observe-only/manual.
- Add one command or agent prompt to inspect and safely update eligible worktrees together.
- Track decision context across worktrees: what changed, who or which agent decided it, why, evidence used, tests run, commit/PR, and open questions.
- Evaluate Entire CLI and Git AI first. If integration is too heavy, build a small Timber-native local decision journal with Markdown/JSON export.
- Keep unsafe rebases gated. Dirty, active, conflicted, or published branches stop for review.

Date: 2026-10-12
Status: exploratory questions, not approved Timber scope

## Current answer

Timber currently manages one target per command:

- `timber new <branch>` creates one branch/worktree.
- `timber open <target>` opens or materializes one worktree.
- `timber ls` reports every registered worktree.
- `timber done <target>` safely cleans one worktree.
- `--agent` launches one configured foreground agent in one selected worktree.

Current roadmap has no ticket for batch creation, role-based worktrees, keeping all
branches rebased on latest `main`, agent swarming, runtime monitoring, or multi-agent
orchestration. TIM-16 explicitly says extra features should become separate future
proposals. TIM-9 also excludes an agent framework and session manager.

Current open roadmap:

- [TIM-9: optional foreground agent launching](https://github.com/Coding-M8s/timber/issues/14)
- [TIM-16: dogfooding and workflow polish](https://github.com/Coding-M8s/timber/issues/16)
- [TIM-17: packaging and release](https://github.com/Coding-M8s/timber/issues/17)
- [TIM-18: guided defaults setup](https://github.com/Coding-M8s/timber/issues/25)

## Proposed roadmap epic: ticket worktree groups, freshness, and context

### Product story

Start in the primary `master` worktree and tell one agent:

> Prepare TIM-101 and TIM-102 as implementation worktrees for me, open TIM-103
> as a review worktree, and create TIM-104 as a manual QA worktree only if its
> change needs isolated testing. Keep implementation branches current with master
> using my selected policy, then show me what every worktree is doing and why.

Agent should turn request into a visible plan before changing Git:

```text
Role         Ticket    Source                         Purpose
implement    TIM-101   pinned origin/master OID       work I will implement
implement    TIM-102   pinned origin/master OID       work I will implement
review       TIM-103   exact candidate branch/PR OID  inspect someone else's change
qa           TIM-104   exact candidate commit         optional manual verification
```

MVP should focus on `implement` and `review`. `qa` stays optional because many
reviews can test candidate directly. A worktree role describes intent and defaults;
it does not grant an agent permission to commit, rebase, push, approve, or merge.

Possible agent-facing flow:

1. Confirm primary repository and selected base.
2. Fetch only when requested, then resolve one exact `origin/master` OID.
3. Resolve ticket branches or review candidate revisions.
4. Show paths, branches, roles, freshness policies, editor/agent choices, and Git
   mutations.
5. Create approved worktrees sequentially and report partial success honestly.
6. Open implementation worktrees for user. Open review worktree read-only by
   convention until user asks for changes.
7. Add QA worktree only when test isolation, a clean candidate build, or manual
   regression work makes it useful.

Timber should expose stable commands or JSON plans so Codex, Orca, or another agent can
perform this from one natural-language prompt. Timber remains authority for safe Git
and worktree operations; prompting and parallel process control can stay outside it.

### Three freshness choices per worktree

Each Timber-created worktree can record one policy:

1. **Guarded automatic** - periodically detect newer `origin/master` and update only
   when worktree is clean, agent is idle, branch is unpublished or explicitly approved,
   and operation can proceed under chosen merge/rebase policy. Stop and report any
   conflict, dirty state, publication, active process, or force-push requirement.
2. **Prompt/on-demand** - show drift and offer one click, one command, or one agent
   prompt to update target or whole group. Example: `timber sync group --plan`, then
   approve exact operations.
3. **Observe-only/manual** - never update automatically. Record ahead/behind state and
   let user decide later. Same one-command or prompt-driven plan remains available.

"Always current" cannot mean hidden unconditional rebases. It means active monitoring
plus guarded updates under explicit policy. Without a Timber daemon, Orca, a scheduled
task, or user command can trigger checks. Timber can keep policy and safety logic
deterministic.

Useful interaction:

```text
timber group status launch-batch --fetch
timber group sync launch-batch --plan
timber group sync launch-batch --apply
```

Agent equivalent:

> Check all Timber worktrees against latest origin/master. Update eligible
> implementation worktrees, leave review candidates pinned, and explain every skip.

Review worktrees usually stay pinned to reviewed commit so code does not change during
review. User can explicitly refresh candidate and see old/new OIDs. QA worktrees also
stay pinned unless user asks to test newer candidate.

### Preserve why, not only Git state

Hard problem is instant context loss across several worktrees. Branch and dirty status
show what exists, but not why a choice was made. Group status should connect Git facts
to lightweight decision records:

- ticket, role, worktree, branch, base OID, and candidate OID;
- human or agent responsible for action;
- originating prompt and task goal;
- decision plus short reason;
- files, commits, issue comments, or docs used as evidence;
- commands and tests run with observed result;
- resulting commit, diff, PR, or review comment;
- open questions, blockers, handoff, and next action;
- timestamp and links to related sessions.

Desired questions:

```text
timber group status launch-batch
timber context TIM-101
timber why TIM-103
```

Status should answer quickly:

- Which worktree implements each ticket?
- Which candidate revision is being reviewed?
- What changed since last check?
- Why did agent choose this approach?
- Which evidence and tests support it?
- What needs human review?
- Which worktrees are behind master, and why were any skipped?

### Build small or integrate existing tools

First option: integrate or document Entire CLI for session checkpoints and Git AI for
authorship/usage evidence. Prove multi-worktree isolation, privacy, ref behavior, and
cleanup before recommending either.

Fallback: small Timber-native local journal stored with repository Git metadata rather
than inside disposable worktrees. Append structured events, keep secrets out, and
export Markdown/JSON when user wants to share. This should capture summaries and links,
not full private transcripts by default.

Best boundary:

```text
Timber         worktree identity, roles, pinned revisions, freshness, safe Git plans
Codex/Orca     natural-language request, agent launch, parallel execution, approvals
Entire/Git AI  detailed session checkpoints, authorship, and usage evidence
```

### Suggested ticket split

1. **Role-based worktree group MVP** - one plan creates multiple implementation and
   review worktrees from pinned revisions; optional QA target; no automatic agents.
2. **Freshness policies and group sync** - guarded automatic, prompt/on-demand, and
   observe-only modes with dry-run evidence and refusal reasons.
3. **Decision-context timeline** - status/context commands plus Entire/Git AI
   compatibility; add minimal local journal only if integrations do not cover need.
4. **Agent/orchestrator recipe** - one natural-language prompt composes above commands
   and optionally opens editors or foreground agents without turning Timber into a
   session manager.

## Question 1: role-based groups of worktrees

Example idea: start implementation, review, and test workspaces together.

```text
timber batch start TIM-123 --roles implement,review,test
```

Important distinction:

- Independent implementations can start from one pinned base commit in parallel.
- Review normally depends on an implementation commit, so it belongs after or against
  a pinned implementation revision rather than blindly starting beside it.
- Testing can use a detached worktree at the candidate commit when no test changes are
  expected. A separate branch is useful only when the tester will make changes.

A manifest could describe branches, roles, base commit, agent command, prompt, and
dependencies. Batch creation should be sequential and report partial success without
deleting worktrees already created. Timber should not infer that a role name grants an
agent permission to commit, merge, or rewrite Git history.

## Question 2: always start from fresh `main`

Timber does not currently guarantee latest remote `main` and does not rebase existing
worktrees. Existing `open` intentionally works offline and does not mutate Git state.

"Latest main" must mean an exact source and commit, usually freshly fetched
`origin/main`, not whichever local `main` happens to exist. Safe split:

1. New worktree: optional explicit fetch, then create every requested branch from one
   pinned `origin/main` OID.
2. Existing worktree: show fork point plus ahead/behind counts.
3. Sync: explicit preview followed by rebase or merge only for eligible clean worktrees.
4. Dirty, conflicted, unpublished, or active worktrees: report and skip.

Automatic rebasing every worktree is unsafe. It rewrites published commits, can need
force-pushes, conflicts with uncommitted work, and changes the revision an agent is
reasoning about. Better commands would be explicit:

```text
timber status --fetch
timber sync <target> --rebase --dry-run
timber sync --all --rebase --dry-run
```

No mutation should happen merely from `ls` or `open`.

## Question 3: swarm or parallel agent execution

Current `--agent` is foreground and blocking by design. True swarm behavior needs:

- multiple worktrees and branches;
- dependency/DAG scheduling;
- terminal or process ownership;
- prompts and role context;
- status, cancellation, restart, and crash recovery;
- integration testing after results combine;
- merge/conflict policy and human approval gates.

That becomes an orchestrator, not a small worktree CLI. Strong boundary:

```text
Timber: Git/worktree creation, inspection, freshness evidence, safe cleanup
Orca/tmux/runner: terminals, parallel agents, prompts, runtime status, coordination
Entire/Git AI: session history, checkpoints, authorship, and usage evidence
```

Timber could support orchestration without becoming one by adding stable `--json`
output, dry-run plans, exact base OIDs, and commands that operate safely on explicit
targets. Orca or a small script could call Timber once per lane and launch agents in
separate terminals.

## Question 4: faster situational awareness

Small Timber-native idea: expand `timber ls` or add `timber status`/`timber doctor`.

Useful Git-derived fields:

- worktree, branch, and path;
- clean/dirty/ignored/locked/missing state;
- base branch and pinned base OID;
- fork point;
- ahead/behind counts against cached or explicitly fetched base;
- unpublished commits;
- branch age and last commit;
- PR link when available;
- safe cleanup eligibility and reason for refusal.

Without a process registry, Timber cannot reliably know whether an agent is running,
waiting, or finished. That live state belongs to Orca, tmux, or another terminal
manager. Avoid `timber watch` or a background daemon until real usage proves need.

## Entire CLI and Git AI compatibility

### Entire CLI

[Entire CLI](https://github.com/entireio/cli) captures agent sessions and checkpoints
alongside Git commits. It supports Codex and Claude Code hooks. Likely good companion:
Timber selects isolated worktree and launches agent; Entire records what happened.

Start with documentation and a compatibility test, not a Timber provider integration:

- enable Entire once in a disposable repository;
- create two Timber worktrees;
- run separate Codex sessions;
- verify checkpoint/session identity stays separated;
- verify shared Git refs and cleanup behavior remain safe;
- confirm transcripts contain no secrets before pushing checkpoint refs.

### Git AI

[Git AI](https://usegitai.com/docs/get-started/reference) proxies Git and records AI
authorship, sessions, commits, line attribution, token estimates, and cost. It can answer
who or what authored changes, but does not replace worktree management or orchestration.

Because Git AI can install itself as the `git` executable proxy, Timber's exact porcelain
parsing and exit behavior must be tested under that PATH before claiming compatibility.
Useful experiment: run Timber's full integration suite through Git AI, then inspect
`git ai usage`, `git ai diff`, and `git ai stats` across multiple worktrees.

## Comparable tools worth studying

- [git-paw](https://github.com/bearicorn/git-paw): selects multiple branches, launches
  agents in tmux panes, supports presets, and rebases existing branches on start.
- [taskpods](https://github.com/yanairon/taskpods): small agent-agnostic worktree CLI with
  parallel pods, lifecycle commands, and no daemon.
- [Station](https://github.com/jeremy0dell/station): terminal control plane with persistent
  sessions and live agent state.
- [Entire CLI](https://github.com/entireio/cli): session/checkpoint history.
- [Git AI](https://usegitai.com/docs/get-started/reference): authorship and usage evidence.

## Suggested future proposals

Keep proposals separate so Timber can ship before growing into a platform:

1. **Worktree status JSON** — `ls --json`, base OID, ahead/behind, unpublished state.
2. **Explicit freshness** — fetch/pin base for new worktrees; dry-run sync for existing ones.
3. **Batch creation manifest** — create named role worktrees from one pinned base, no agents.
4. **External orchestration recipe** — Orca/script launches agents using Timber JSON output.
5. **Entire/Git AI compatibility spike** — prove hooks, refs, porcelain, privacy, and cleanup.
6. **Swarm evaluation later** — only after measuring need; preserve human approval for Git
   writes and run full tests on the combined result, not only inside each lane.

## Main design opinion

Do not make Timber another full agent platform yet. Its useful core is trustworthy
worktree control. Add better evidence and composable output first. Let specialized tools
own sessions and agent swarms. If repeated real workflows still require one command,
Timber can later add a thin batch layer without a daemon or provider framework.
