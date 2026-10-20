# Timber Arena and Future Agent Workflows

Team discussion brief • 17 October 2026

## Recommendation

We should keep the agreed Arena lifecycle intact, make optional TOML worktree limits the first new follow-up ticket, and evaluate the broader management and execution system in the roadmap below. Timber should eventually let users choose how their agents work: competing attempts, independent reviews, isolated validation, cooperating teams, queued jobs, or staged pipelines. Those choices fit our existing worktree and harness foundations, but each needs a clear execution and preservation contract.

Recommended study order:

1. **Cursor:** create, compare, and explicitly apply a chosen solution.
2. **Qwen Code:** terminal interaction, attempt status, and result presentation.
3. **Arena.ai:** make winner selection understandable through inspectable outputs.
4. **Claude Code Agent Teams:** evaluate for a future collaboration mode.

For current tickets, evaluate documented approaches to clear attempt lists, real status, inspection paths, and change comparison. Parallel execution, conversation tabs, automatic application, and agent coordination need separate agreed scope.

The central distinction:

- **Arena:** several independent solutions to the same task; the user chooses.
- **Review panel:** independent reviewers inspect the same change and return findings.
- **Arena judging:** evaluators compare existing attempts and recommend an outcome; the user still chooses.
- **Validation:** an isolated workspace runs checks or reproduces a problem and records evidence.
- **Team:** agents own different parts of one goal, coordinate, and combine their work.
- **Batch or fleet:** independent jobs run through a queue with controlled concurrency and collected outcomes. Some vendors use “fleet” for collaborative delegation instead, so define our behavior explicitly.
- **Pipeline:** agents or models perform successive stages toward one solution.

Sources below document the inspiration. Proposed Timber behavior is identified as a recommendation, not an existing feature or a claim that another product works identically. This shortlist is selected for relevance rather than a measured popularity ranking. Product behavior was reviewed through official documentation; comparative hands-on trials remain planned.

External product documentation provides attributed references and inspiration for evaluating Timber-specific designs. References alone do not establish implementation compatibility or permission to reuse source code or documentation. These references preserve Timber's requirements: Timber keeps its own preservation, force, and secret rules. Dirty, untracked, ignored, unpublished, and unproven work stays. There is no destructive force bypass. Secrets stay out of config, logs, tickets, and commits. Git runs as an executable plus argument arrays. Failure tests use temporary repositories and assert that files and refs remain intact. Another product's cleanup, moving, or copying policy does not become Timber's policy.

## Proposed ticket roadmap

These are proposed follow-up tickets, not newly created GitHub issues. **The first new ticket is optional worktree limits in TOML.** TIM-20/21/22 retain their agreed creation, resume and pick behavior; this roadmap does not expand those tickets. Later rows describe the broader system in separate reviewable slices, with implementation order revisited after the comparison trials.

### 1. Optional worktree count and size limits in TOML

**Inspiration:** [Cursor worktree settings](https://cursor.com/docs/configuration/worktrees), including the count and total-size controls shown in the team discussion.

Proposed configuration, not currently supported:

```toml
[worktree_limits]
max_count = 25
max_size_gb = 50
```

The values above are examples, not built-in defaults. Each setting is optional; leaving it unset imposes no configured limit. Users choose their own budget. This does not restore the removed hardcoded Arena attempt cap or change the minimum of two attempts.

Scope and acceptance criteria:

- Parse and validate both fields through the existing global/repository TOML configuration. Proposed initial scope: the current repository's linked worktrees; exclude its primary worktree and shared Git object store. Define whether externally created linked worktrees count before implementation. A global configuration supplies defaults per repository; it does not imply machine-wide accounting or a global registry.
- Define count as a positive safe integer, size as a positive finite number of decimal GB, and reject invalid values before mutation. Document omission as unlimited and finalize table inheritance rules against the existing configuration contract.
- Use one shared creation check for ordinary creation, `open` when it materializes a worktree, and Arena creation. Opening an already existing worktree remains available even when over budget.
- Preflight the whole Arena batch against the count budget before creating any attempt. If refused, show the configured limit, observed usage, requested additions and recovery options. Preserve all existing branches, files and worktrees.
- Define the size policy precisely: what is measured, how symlinks and shared data are treated, whether checkout size can be estimated before creation, and how an unknown measurement is handled. Existing usage and checkout estimates cannot predict later dependency installs, setup hooks or agent writes. Document a creation-time budget check rather than promising a continuous hard disk quota; exceeding it later must retain completed work and explain recovery.
- Refuse creation when the agreed checks would exceed the configured budget. No automatic deletion, eviction, background monitor or settings UI in this ticket. Reuse existing inspection and manual cleanup guidance.
- Verify unchanged behavior with settings omitted, both configuration scopes, whole-batch refusal, existing-worktree reopen, measurement failure, and preservation after setup growth or partial failure. Review shared config/creation contracts before implementation.

This first ticket delivers the small configurable control requested. The following proposals build the larger management and execution system incrementally.

### Follow-up system

| Proposed ticket | Deliverable and boundary | Inspiration / dependency |
| --- | --- | --- |
| **2. Worktree usage and retention visibility** | List measured count/size, relevant age and Git state; explain budget failures and show cleanup candidates. Define age semantics and expose unknown data. Read-only inspection first. | [Cursor worktrees](https://cursor.com/docs/configuration/worktrees); builds on ticket 1 accounting |
| **3. Explicit safe cleanup and optional retention policy** | Preview candidates, retain pinned/active/unsafe work, revalidate Git evidence, then remove only eligible work through reviewed cleanup rules. Opt-in automatic cleanup needs a separate trigger design and preservation contract. Count/size settings alone never authorize deletion. | [Cursor worktrees](https://cursor.com/docs/configuration/worktrees); existing Timber cleanup checks and ticket 2 |
| **4. Arena inspection and result artifacts** | After TIM-21/22, improve grouped attempt lists, actual state, test commands, inspection paths and optional tool-reported summaries. Record evidence and provenance; exit zero is not proof of correctness. | [Qwen Arena](https://qwenlm.github.io/qwen-code-docs/en/users/features/arena/), [Arena.ai](https://help.arena.ai/articles/5701270322-arena-how-to-code-arena), [Devin Command Center](https://docs.devin.ai/desktop/agent-command-center) |
| **4a. Independent review and multi-model panels** | Pin one review target; select reviewer tools/models and optional specialties; collect independent findings with attribution and evidence. Start sequentially with supported native tool handoffs. Review mode does not edit the source. | [Codex review](https://learn.chatgpt.com/docs/code-review), [Qwen review](https://qwenlm.github.io/qwen-code-docs/en/users/features/code-review/), [Cursor Agent Review](https://cursor.com/docs/agent/agent-review), [Copilot review](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/agentic-code-review); reviewed task/report contract |
| **4b. Optional Arena judging** | Compare selected attempts using a declared rubric and recorded revisions. Report rationale, evidence and uncertainty. A recommendation never selects, applies or removes work automatically. | [Cursor multi-agent judging](https://cursor.com/changelog/2-2); TIM-22 and ticket 4 artifacts |
| **4c. Isolated validation and reproduction** | Prepare a checkout for tests, build checks or bug reproduction; retain commands, environment identity and outputs. Define setup permissions and cleanup independently. A worktree isolates files, not arbitrary code execution. | [Qwen review isolation](https://qwenlm.github.io/qwen-code-docs/en/users/features/code-review/), [Gemini CLI contributor review](https://geminicli.com/docs/contributing/); shared worktree lifecycle |
| **5. Parallel Arena execution and queue control** | Separate total attempts from active concurrency. Define supported foreground/headless tools, interaction, cancellation, interrupts, queued work, restart and failure handling before implementation. Preserve the current sequential default. | [Qwen Arena](https://qwenlm.github.io/qwen-code-docs/en/users/features/arena/), [Cursor worktrees](https://cursor.com/docs/configuration/worktrees); reviewed execution contract |
| **6. Arena continuation and explicit integration** | Scope individual/shared follow-ups separately from apply/export. Define supported native conversation handoff, explicit destinations and conflict checks. Selection remains distinct from merging or publishing. Split implementation into smaller tickets. | [Cascade Arena](https://docs.devin.ai/desktop/cascade/arena), [Cursor worktrees](https://cursor.com/docs/configuration/worktrees); TIM-21/22 and ticket 4 |
| **7. Team collaboration mode** | Assign ownership, exchange findings, expose blockers and combine results through explicit integration. Define supervision, communication and workspace isolation. | [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams); independent mode proposal |
| **8. Batch/fleet mode** | Queue many independent jobs, select concurrency, track dependencies where needed, collect outcomes and retry selected failures. Remote/distributed execution requires a separate proposal and measured scale evidence. | [Copilot fleet](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/speed-up-task-completion); reuse reviewed scheduling primitives where suitable |
| **9. Pipeline mode** | Define stage inputs, outputs, selected tools/models, review gates, retries and recovery for plan → implement → review → verify. | [Aider architect/editor](https://aider.chat/docs/usage/modes.html) inspires staged handoff; the four-stage workflow is our proposed extension |
| **10. Shared status and measured resource reporting** | Reuse task/workspace identity and status across modes. Report actual elapsed time, memory/disk and tool-provided token/cost data, with unknowns explicit. Add scale or cloud capabilities only after measurements justify them. | [Devin Command Center](https://docs.devin.ai/desktop/agent-command-center), [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), [Qwen Arena](https://qwenlm.github.io/qwen-code-docs/en/users/features/arena/) |

These proposals describe a cohesive direction, not one large implementation ticket. Resource accounting, identity, preservation and honest status can be shared; each mode still owns its execution and result contract. A daemon, global registry, graphical session board or provider integration framework would require an explicit change to Timber's current architecture constraints.

## Timber today and the upcoming tickets

### TIM 20 creates and launches

Current implementation accepts `--prompt-file`, quoted `--prompt`, or interactive task instructions. Users select an agent tool, optional model and supported effort, or a saved agent preset, plus run count. Every attempt receives the same private task snapshot and starts from one pinned commit.

An existing local or remote branch can supply committed progress even without a local source worktree. Timber then creates fresh attempt branches/worktrees; the original source remains intact. A branch names a moving reference, a commit identifies the starting snapshot, and a worktree provides the files each attempt edits.

All attempt worktrees and setup finish before agents launch sequentially in the invoking terminal. Users interact with each native agent and exit it before the next starts. Manual preparation is supported. Minimum two attempts remains; the arbitrary 100-attempt cap has been removed. Resources and runtime limits still determine practical scale.

Creation reports paths, stages and exit/failure outcomes. Completed work is retained after failures. Agent exit zero does not establish solution quality. There is no current simultaneous agent dashboard, distributed scheduler, or combined final-answer report.

Source: [TIM-20 creation and launch requirements](https://github.com/Coding-M8s/timber/issues/40).

### TIM 21 revisits existing attempts

The planned `arena resume` selects an existing attempt and revalidates its actual Git/worktree identity. It preserves current commits and files, reuses the recorded task and configuration, and requires explicit setup retry. Restoring a workspace is separate from restoring the native agent's conversation; conversation support depends on the tool.

Source: [TIM-21 recovery and revisit requirements](https://github.com/Coding-M8s/timber/issues/41).

### TIM 22 compares and selects

The planned `arena pick` groups attempts by arena and shows their agents, branches, paths, state and changes against the common base. It must distinguish committed/uncommitted tracked changes from untracked files and give users inspection/reopen paths.

The user selects the winner. Its workspace stays intact. Only eligible losing work can be removed through existing preservation checks; dirty, unpublished or unproven losers can remain. Choosing a winner does not merge or publish it.

Source: [TIM-22 comparison and preservation requirements](https://github.com/Coding-M8s/timber/issues/42).

## Comparison with other tools

| Tool or method | Work pattern | Execution and review | What we should learn |
| --- | --- | --- | --- |
| **Timber Arena** | Same task, independent attempts | Sequential native terminal agents; retained Git work; resume/pick planned | Baseline for harness choice, isolation, recovery and preservation |
| **Cursor best-of-N** | Competing solutions | Parallel model runs in worktrees; comparison separated from explicit application | Clear create/compare/apply decisions |
| **Qwen Code Agent Arena** | Competing solutions | Experimental parallel agents, terminal tabs and result summaries | Attempt navigation, individual interaction and honest telemetry |
| **Arena.ai Code Arena** | Competing generated apps | Browser previews, iteration and voting | Inspect the output before choosing |
| **Claude Code Agent Teams** | Cooperating teammates | Messaging, task coordination and terminal panel/split panes | Ownership, supervision and combined results |
| **Windsurf/Cascade Arena** | Competing models | Parallel isolated conversations and user-chosen convergence | Independent and shared follow-up interaction |
| **Devin Command Center** | Session management | Groups local/cloud sessions by status and project | Running, blocked and review states |
| **Codex worktree chats** | Independent workstreams | Concurrent chats in isolated worktrees, setup and handoff | Clear chat/workspace ownership and continuation |
| **Copilot CLI fleet** | Coordinated subtasks | Parent delegates independent work, runs workers and combines results | Dependencies, specialization and result collection |
| **Aider architect/editor** | Staged cooperation | Architect proposes; editor translates proposal into edits | Explicit model roles and stage handoff |

## Review, judging and other worktree workflows

The earlier comparison emphasized generating competing implementations. The study should also cover reviewing existing work, verifying behavior, and improving a selected implementation. These are candidate capabilities; they do not change TIM-20/21/22. Labels below describe behavior, not approved new commands.

### Review features across the requested tools

Official documentation checked on 17 October 2026. A native command, a repository-specific script, a configurable workflow and a multi-model panel are different levels of support. This table records what the linked pages establish; missing evidence is not a claim that a product lacks the feature everywhere.

| Tool | Documented review or related behavior | Timber opportunity / attribution boundary |
| --- | --- | --- |
| **Cursor** | [Agent Review](https://cursor.com/docs/agent/agent-review) inspects local changes with Quick/Deep depth. Separately, [multi-agent judging](https://cursor.com/changelog/2-2) was announced to compare finished parallel runs and recommend one with an explanation. | Study both dedicated review and optional Arena recommendations. These pages do not establish a user-selected simultaneous multi-model review panel; verify that exact UI/version before describing it as native. The judging announcement is historical, not a hands-on check of current availability. |
| **Codex** | [Local review](https://learn.chatgpt.com/docs/code-review) supports a base branch, uncommitted changes, a commit or custom instructions, and reports findings without editing the working tree. CLI `review_model` can select a model different from the coding session. | Separate implementer from reviewer, make review scope explicit and offer second opinions. Selecting a different review model is not evidence of a built-in cross-provider panel. |
| **Qwen Code** | [Code Review](https://qwenlm.github.io/qwen-code-docs/en/users/features/code-review/) documents specialist review agents, verification, isolated same-repository PR review, Markdown/JSON reports, and full second-opinion review after switching models. | Strong reference for findings as data, independent model opinions and reproducible evidence. Sequential cross-model re-review and specialist subagents should not be described as an arbitrary simultaneous multi-model panel. |
| **Windsurf / Cascade** | [Reusable workflows](https://docs.devin.ai/desktop/cascade/workflows) cover PR feedback, testing/fixing and security checks; [modes](https://docs.devin.ai/desktop/cascade/modes) distinguish Code, Plan and Ask. [Arena](https://docs.devin.ai/desktop/cascade/arena) offers independent model sessions/worktrees. | Study reusable procedures and follow-ups. These pages do not establish a dedicated multi-model review command. Workflows and Arena are legacy Cascade features; current Devin Local support must be checked separately. |
| **GitHub Copilot CLI** | [Agentic review](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/agentic-code-review) offers `/review` with optional focus/path scope and permission checks for proposed commands. | Useful terminal review flow. Do not infer that model selection or `/fleet` automatically produces independent multi-model reviews. |
| **Gemini CLI** | [Contributor review tooling](https://geminicli.com/docs/contributing/) prepares a PR worktree and accepts a model argument. [Custom commands](https://geminicli.com/docs/cli/custom-commands/) show a reusable review prompt; [experimental worktrees](https://geminicli.com/docs/cli/git-worktrees/) isolate sessions and retain work on exit. | Study isolated review setup and configurable prompts. The contributor script belongs to Gemini CLI's own repository; it is not evidence that every installation includes a universal `/review` or multi-model panel. |

### Proposed review panel flow

1. **Choose the target and scope.** An existing local/remote branch, specific revision, existing worktree or Arena attempt can be a target. Pin the reviewed commit and comparison base. Dirty files require a separately designed, explicitly requested snapshot including a precise tracked/untracked policy; never silently stash, commit or copy them. If the target changes, mark prior findings stale rather than claiming they cover the new content.
2. **Choose reviewers.** Select executable/harness, model or named configuration, and optional focus such as correctness, security or performance. Different roles using one model and genuinely different models are both valid, visibly distinct choices. One reviewer is useful; review panels need no inherited Arena minimum of two or fixed product upper cap.
3. **Run independent first passes.** Give reviewers the same target evidence and criteria. Keep earlier reviews out of their initial context; optional discussion or synthesis happens afterward. Begin with supported sequential terminal launches; parallel execution depends on the separate scheduling contract. Additional native integrations need explicit per-tool handoff validation, not guessed prompt flags.
4. **Present individual reports and a grouped view.** Preserve reviewer identity, scope, locations, severity, rationale, reproduction evidence and failed/incomplete runs. Group duplicates without hiding disagreement or deleting original findings. Report unknown coverage and unmeasured usage explicitly. Model agreement is not proof; an optional synthesizer can also make mistakes and incurs its own cost.
5. **Let the user decide what happens next.** Review findings can lead to a separate fix request, validation run or pipeline stage. Keep editing, PR posting, applying changes and cleanup explicit. A prompt asking for read-only behavior is not enforcement; supported tool permissions and workspace policy must establish what can actually be changed.

This is our proposed cross-harness workflow. The sources above inspire parts of it; none is claimed to ship this exact combined design. Static review does not inherently need one new worktree per reviewer. A stable read-only snapshot can avoid duplicate setup; executable tests, independent fixes or tools that write files may need separate worktrees. Git worktrees share repository metadata and are not a security sandbox or a guarantee of isolated ports, services or databases.

### Additional features worth studying

| Candidate | Why a worktree helps | Inspiration and proposed Timber boundary |
| --- | --- | --- |
| **Review an existing branch or PR locally** | Inspect and test someone else's change while keeping the user's checkout intact. | [Qwen review](https://qwenlm.github.io/qwen-code-docs/en/users/features/code-review/), [Gemini contributor review](https://geminicli.com/docs/contributing/). Reuse `open` where possible; remote PR discovery and exact snapshot policy require their own contract. |
| **Specialist or adversarial review** | Reviewers inspect one stable target from different angles; reproductions can run separately. | [Qwen review](https://qwenlm.github.io/qwen-code-docs/en/users/features/code-review/). Candidate focus presets, with evidence checks and bounded optional synthesis; no assumption that more reviewers always improve quality. |
| **Test, build and compatibility matrix** | Each runtime/dependency configuration can have its own files and generated outputs. | [Gemini's isolated review setup](https://geminicli.com/docs/contributing/) and [Qwen verification](https://qwenlm.github.io/qwen-code-docs/en/users/features/code-review/) inspire validation; a general compatibility matrix is our extension. Share results, record exact commands, and distinguish environment failure from code failure. |
| **Bug reproduction and alternative fixes** | Preserve a reproducible failing case while separate attempts explore repairs. | [Cursor Debug Mode](https://cursor.com/changelog/2-2) inspires evidence-led debugging. Combining reproduction with Timber Arena is our proposal; retain logs and test the same acceptance case across attempts. |
| **Review → fix → re-review** | A repair workspace can evolve while the reviewed target remains identifiable. | [Cascade testing/fixing workflows](https://docs.devin.ai/desktop/cascade/workflows), [Qwen explicit fixes](https://qwenlm.github.io/qwen-code-docs/en/users/features/code-review/), [Aider staged handoff](https://aider.chat/docs/usage/modes.html). Make this a pipeline recipe with user-defined budgets, stopping conditions and approvals. |
| **Plan before creating implementation attempts** | Several plans can be compared cheaply before allocating code-writing worktrees. | [Cascade Plan/Ask modes](https://docs.devin.ai/desktop/cascade/modes), [Gemini Plan Mode](https://geminicli.com/docs/cli/tutorials/plan-mode-steering/). Plan comparison is our extension; planning alone need not create a worktree. |
| **Per-worktree preview and verification commands** | An attempt can expose a reproducible run/test path alongside its diff. | [Codex local environment actions](https://learn.chatgpt.com/docs/environments/local-environment) and [Arena.ai previews](https://help.arena.ai/articles/5701270322-arena-how-to-code-arena). Start with configured commands and links; any port allocation or service ownership needs separate design. |

### How these fit the roadmap

Keep optional TOML limits first. Complete the agreed Arena lifecycle, then prioritize review target/report contracts and an initial review panel alongside the planned inspection work. Add optional judging and isolated validation as separate slices. Parallel reviews can later reuse reviewed scheduling capabilities; review/fix loops can become Pipeline recipes. Team collaboration remains a separate relationship between agents.

Prefer a few clear workflows over a new top-level mode for every checklist. Review specialties and validation commands may fit existing named workflows, task handoff and setup hooks. A dedicated mode earns its place when its lifecycle or output differs enough to need a distinct contract. Supporting Cursor, Qwen, Copilot or Gemini in a comparison document does not make them supported Timber harnesses today.

Study success through seeded real bugs, clean counterexamples, reproducible tests, missed issues, false positives, human triage time and actual resource usage. Compare one strong reviewer with additional models on the same pinned target. Include repeated-reading, verification and synthesis tokens. Review quality gains remain unproven until those trials are run.

## Features inspired by other tools

### Separate comparison from applying changes

**Inspiration:** [Cursor worktrees and best-of-N](https://cursor.com/docs/configuration/worktrees).

Candidate: show the source, attempt changes, inspection path and explicit choice before any integration. Cursor documents comparison separately from applying a worktree. Timber's current pick ticket already separates winner selection from merging; a later apply/export feature would need its own scope and destination-conflict checks.

**Why it fits:** choosing a preferred implementation should not silently change another branch. This follows Timber's explicit Git and preservation model.

### Make each attempt easy to inspect and interact with

**Inspiration:** [Qwen Code Agent Arena](https://qwenlm.github.io/qwen-code-docs/en/users/features/arena/).

Candidate: clear attempt selection, actual running/failed/completed state, per-attempt interaction and optional measured usage. Qwen documents terminal tabs and comparison summaries. It marks Arena experimental; its preview descriptions are inconsistent, so verify the installed version before treating those controls as Timber's design. Its worktree duplication and cleanup policies also differ from Timber's contract.

**Why it fits:** one task can have many independent attempts, but users still need to understand and inspect each one. A conversation tab implementation belongs to future execution/UI work, not the current sequential launcher.

### Let people inspect working results before voting

**Inspiration:** [Arena.ai Code Arena guide](https://help.arena.ai/articles/5701270322-arena-how-to-code-arena).

Candidate: show reproducible test commands, workspace paths, changed files and available preview links alongside the diff. Arena.ai emphasizes inspecting generated application previews before voting.

**Why it fits:** a persuasive final message is not proof that code works. Timber can adopt the inspection principle through terminal output and explicit links without building a browser IDE.

### Support individual or shared follow-ups

**Inspiration:** [Windsurf/Cascade Arena](https://docs.devin.ai/desktop/cascade/arena).

Candidate: send a follow-up to one attempt or deliberately to a selected group, while retaining clear independent histories. Cascade Arena documents isolated model conversations and user-chosen convergence. It is a legacy Cascade feature, separate from the newer Devin Local agent.

**Why it fits:** users may want to explore one promising result or ask every candidate to address the same issue. Native tools have different session interfaces, so this requires an explicit supported handoff design.

### Add collaboration as a distinct mode

**Inspiration:** [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams).

Candidate: a lead or user assigns bounded responsibilities; teammates communicate findings, expose blockers and return results. Claude documents independent contexts, coordination, direct messages and selectable terminal views. Its team feature is experimental.

**Why it fits:** Timber already separates workspaces and launching from agent choice. A collaboration mode could add explicit ownership and integration steps. **Claude Teams is the reference for teamwork, not the source of our staged pipeline idea.**

### Add queueing and collected job outcomes

**Inspiration:** [Copilot delegation and parallelization](https://docs.github.com/en/copilot/concepts/agent-capabilities/choosing-and-delegating-agent-work/delegating-and-parallelizing-work-with-agents) and [Copilot fleet task monitoring](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/speed-up-task-completion).

Candidate: queue independent jobs, expose dependencies and worker state, collect outcomes, and retry selected failures. Copilot's fleet delegates parts of one goal to workers; our proposed batch mode would need to define whether jobs are independent requests or coordinated subtasks.

**Why it fits:** total jobs and simultaneous workers are different controls. Users could request a large batch while choosing an appropriate concurrency level. Cloud/distributed execution needs separate architecture and observed scale evidence.

### Preserve clear workspace and session ownership

**Inspiration:** [Codex worktrees in the official OpenAI documentation](https://learn.chatgpt.com/docs/environments/git-worktrees).

Candidate: make starting context, setup, workspace location and continuation explicit. Codex documents concurrent worktree chats and handoff between local and worktree contexts. Its default detached-HEAD approach differs from Timber's named attempt branches.

**Why it fits:** users need to know which files and conversation belong to each run. Timber should reuse its reviewed identity records and preservation rules. Another tool's moving or duplication behavior stays that tool's behavior.

### Organize sessions by useful states

**Inspiration:** [Devin Agent Command Center](https://docs.devin.ai/desktop/agent-command-center).

Candidate: read-only grouped lists showing active work, blockers, failures and readiness for inspection. Devin uses a local/cloud session board and grouped project context.

**Why it fits:** the status vocabulary is useful even in a CLI. A graphical board or global session manager would be a separate product decision under Timber's current architecture constraints.

### Introduce an explicit staged pipeline

**Inspiration:** [Aider architect and editor modes](https://aider.chat/docs/usage/modes.html).

Candidate: let users choose a planner, implementer and reviewer, with recorded outputs and explicit transitions. Aider's documented pattern is architect proposal followed by editor-produced file changes. Extending that into plan, implement, review and verify is **our proposed Timber design**, not a claim that Aider provides that entire pipeline.

**Why it fits:** some tasks benefit from specialization toward one result rather than multiple competing implementations. Stages can use selected tools/models and retain their evidence. More stages can add latency and tokens, so measure their value.

## Proposed future mode structure

These names describe workflows, not approved CLI syntax. Review and validation may become dedicated workflows or reusable capabilities after design review; their relationship to Arena, Team, Batch and Pipeline is explicit below.

- **Arena:** the same task across independent attempts, followed by human comparison and choice.
- **Review:** one target, independent findings and optional synthesis; it can run alone or inspect Arena attempts.
- **Validation:** evidence from isolated test/reproduction runs; it can serve any workflow.
- **Team:** distinct responsibilities toward a shared outcome, with ownership, communication and explicit integration.
- **Batch or fleet:** many jobs, a queue, user-selected concurrency, actual outcomes and selected retries.
- **Pipeline:** a defined sequence of planning, implementation, review and verification stages toward one solution.

A shared read-only status/inspection surface could serve all modes. Live sessions, automated execution and reporting should remain explicit capabilities with supported tool interfaces. Current requirements exclude a daemon, global task registry, provider plugin framework and terminal/session manager; proposals that need those change the architecture and require separate decisions.

## Review plan

1. **Confirm the baseline.** Keep TIM-20/21/22 scope and current preservation behavior visible. Mark each researched capability as documented, experimental, planned or directly observed.
2. **Review Cursor and Qwen first.** Trace creation, source state, user interaction, inspection, selection, revisit and cleanup. Read public implementation when documentation conflicts.
3. **Run controlled trials.** Use the same disposable repository, task bytes, starting commit and acceptance tests for independent-attempt comparisons. Record model/harness differences. Use separate baselines for collaborative and pipeline work.
4. **Exercise recovery.** Cover failed setup, missing executables, nonzero exit, interruption, stale workspace identity, dirty/untracked/ignored files and unsafe losing work.
5. **Measure useful outcomes.** Record correctness, user effort, elapsed time, process memory, disk, actual reported tokens/cost and recovery behavior. Missing measurements stay unknown.
6. **Choose a next slice.** Classify each idea as keep, adapt, defer or reject. Assign it to a mode and write its contract impact, acceptance checks, implementation cost and exclusions before implementation.

### Questions every trial should answer

- Can the user identify the task, source snapshot, active attempt and actual workspace?
- Can the user inspect changes and tests before choosing?
- What happens when an agent needs input, fails, or is interrupted?
- Can work be revisited without replacement, reset or loss?
- Are result selection, application and deletion separate decisions?
- Are token/cost figures measured or inferred? Are retries and summary/judge calls included?
- How much local memory comes from agents, editors, tests and servers, and how much disk comes from dependencies and retained worktrees?

There is no measured efficiency winner yet. Sequential launches can reduce overlapping local processes, but do not inherently reduce total tokens. More powerful hardware does not remove provider quotas, setup costs or correctness/recovery requirements. Removing the count cap does not establish thousand- or million-agent scalability.

## Offline help and documentation packaging

These are separate proposed tickets in the same roadmap. They cover the CLI as a whole, including shipped Arena commands. Optional TOML limits remain the first proposed enhancement. Documentation and release work can proceed independently of the later agent modes; future commands must not appear as available in a released manual before they ship.

### 11. Ship a man page and offline manual

**Goal:** Users can read complete, version-matched CLI documentation offline, including when they download only the standalone executable.

Proposed acceptance criteria:

- Maintain a reviewed manual source covering synopsis, commands/options, configuration precedence, environment variables, exit statuses, examples, Linux support, task privacy, retained failures and cleanup behavior. Keep it consistent with CLI help and the behavioral contract.
- Generate a section 1 `timber.1` manual, with subcommand pages or cross-references where useful. Embed the corresponding manual content in the standalone executable and define an offline display/export interface; its exact CLI syntax needs review before implementation. Viewing help must not discover or mutate a repository, prompt for setup, or require network access, Bun or Node.
- Include the installable man page and a readable text or HTML manual in release archives. Document installation beneath the chosen prefix, such as `share/man/man1`, and removal through the same package/install mechanism. Downloading an executable alone does not register a system man page.
- Verify `man timber` on supported Linux and macOS installations after installing the page. On native Windows, provide equivalent full offline text/HTML help and ordinary executable `--help`; do not assume `man` is installed. PowerShell `Get-Help` integration would need an actual documented script/module integration, not a renamed Unix file.
- Verify rendering, version identity, offline embedded access, installation and uninstall behavior against the downloaded release package. Keep build-only documentation generators out of runtime requirements.

References: [manual-page structure and sections](https://man7.org/linux/man-pages/man7/man-pages.7.html), [Apple Terminal manual-page help](https://support.apple.com/guide/terminal/get-started-pht23b129fed/mac), [PowerShell Get-Help](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/get-help).

### 12. Ship tldr pages and offline examples

**Goal:** Users can find short, task-oriented examples alongside the full manual on every supported platform.

Proposed acceptance criteria:

- Author tldr-format Markdown for `timber` and appropriate shipped subcommands, using a common page where syntax is shared and platform-specific examples only where needed. Cover ordinary worktrees, configuration, safe cleanup and the released Arena lifecycle; validate examples against the actual release.
- Embed the examples in the standalone executable for offline display/export, with syntax chosen alongside ticket 11. Include the Markdown pages in Linux and macOS archives and Windows ZIP packages. Users should not need a separate tldr client to read Timber's embedded examples.
- Document and verify local rendering or import with explicitly selected tldr clients. Some clients support Linux, macOS and Windows, but cache layouts and local-page integration vary. Shipping a Markdown file does not automatically make `tldr timber` work in every client; do not overwrite a user's cache or require network access during help lookup.
- Lint the page format and check examples for supported options and shell-specific quoting. Verify offline access and that a help request has no workspace side effects.
- Treat a later contribution to the public tldr-pages collection as a separate publication decision. Upstream acceptance and client cache refresh are separate from shipping Timber's own version-matched pages; public submission is not part of this documentation edit.

References: [tldr contribution guidance](https://github.com/tldr-pages/tldr/blob/main/CONTRIBUTING.md), [client specification](https://github.com/tldr-pages/tldr/blob/main/CLIENT-SPECIFICATION.md), [official Node client and platform options](https://github.com/tldr-pages/tldr-node-client).

## Releases for Linux, macOS and Windows

The long-term distribution goal is verified standalone releases for all three major desktop operating systems. This expands the release roadmap separately from Arena. The existing baseline remains Linux x86_64: the repository records Ubuntu 24.04/glibc verification, while macOS, Windows, ARM and musl/Alpine remain unverified. See [current release process and evidence](releases.md).

Bun documents cross-compilation, but a successful cross-build does not prove that Timber's Git operations, filesystem protections, hooks, terminals or interrupts work on the target. Validate targets against the project's pinned toolchain and run downloaded-artifact checks on each supported OS/architecture. Reference: [Bun standalone executables and supported targets](https://bun.sh/docs/bundler/executables).

### Proposed release tickets

| Proposed ticket | Scope and acceptance |
| --- | --- |
| **13. Shared release artifact and support contract** | Extend the current pipeline with explicit OS/architecture/minimum-version naming, per-target metadata, checksums, licenses, embedded help and packaged documentation. Preserve existing Linux download compatibility or document a transition. Define archive layout, install/uninstall, upgrade behavior and native verification gates. Owner-controlled tagging and publication remain separate actions. |
| **14. Linux release packages and additional targets** | Preserve the verified Linux x86_64/glibc artifact; add a documentation-bearing archive and installation instructions. Propose ARM64 separately within the ticket breakdown when the pinned toolchain and native tests support it. Record minimum libc/Git/kernel requirements demonstrated by tests; treat musl/Alpine as a separate compatibility target rather than claiming all Linux works. |
| **15. macOS release binaries** | Add Apple Silicon ARM64 and Intel x86_64 candidates where the pinned toolchain supports them. Establish minimum tested macOS versions, native CI and downloaded-artifact tests. Cover permissions, filesystem case handling, terminal signals, shells, configuration paths and man/tldr installation. Define signing/notarization, quarantine behavior and release credentials before claiming a smooth installation path. |
| **16. Native Windows release binaries** | Start with x86_64 `.exe` plus a ZIP containing manual/examples; consider ARM64 after toolchain and test validation. Define supported Windows versions and Git for Windows prerequisite. Review configuration directories, drive/UNC paths, separators, reserved names, case handling, symlinks, shell hooks, executable lookup, literal arguments and Ctrl+C/exit behavior. Document supported shells and any feature gaps. WSL testing does not establish native Windows support. |
| **17. Optional package-manager distribution** | After verified archives exist, evaluate Homebrew, Windows package managers and Linux package formats as separate scoped adapters. Install/remove man pages and examples in the proper locations. Do not make every package ecosystem a prerequisite for direct binary downloads. |

Common release gate: download the actual candidate artifact onto the claimed target, verify checksums and source/version identity, then exercise help/version, offline manual/examples, real worktree creation/open/list/cleanup, preservation refusals, setup hooks, configured launchers and terminal interruption without requiring Bun or Node. Record exact commands, observed outcomes and limitations. Add Arena lifecycle checks as those commands ship. Tests use disposable repositories; support claims follow evidence.

Suggested delivery: tickets 11/12 prepare versioned help; ticket 13 establishes the shared package contract; ticket 14 improves Linux packaging while tickets 15/16 address platform-specific runtime work independently. Ticket 17 follows verified platform releases. None requires waiting for Team, Batch or Pipeline modes, and none changes the initial Linux-only release commitment.

## Continuous integration

Repository quality gates for the Bun CLI are a separate plan: [CI roadmap](ci-roadmap.md).

That plan keeps the current GitHub Actions path (frozen install, typecheck, `bun test`, bundle, `--help`, release binary, checksums, and runtime-free Docker smoke). It then adds a formatter/linter, one local check command that CI runs, unused-code review, workflow lint on pull requests, and a dependency-advisory policy. Browser end-to-end, a second test runner, front-end asset lint, and server deploy jobs stay out.

CI tickets use their own numbering (CI-1 onward). They do not change the Arena follow-up order above, documentation tickets 11–12, or release tickets 13–17. Multi-OS runners stay with the release tickets; this CI plan does not claim new platforms. Gates informed by reviewed pipeline practices still follow the preservation, force, and secret rules in that CI roadmap.

## Saved Arena lineups

Proposed follow-up: **Saved Arena lineups** lets one reusable name expand into several ordered agent presets, each with an optional run count. Keep `--preset` as one tool/model/effort/argument configuration; propose `--lineup quick` for a saved comparison. Task instructions remain per invocation.

See the [individual Saved Arena lineups and multi-agent presets roadmap](arena-lineup-multi-preset-complex-roadmap.md) for the proposed CLI/TOML format, global/repository precedence, dependencies, scope and focused verification. Resolve exact configurations before mutation, reuse existing Arena planning and sequential launches, and retain recorded settings so later lineup edits cannot reinterpret an existing arena.

This is a separate small follow-up after TIM-20, not an addition to TIM-20/21/22 acceptance criteria. Optional TOML worktree limits remain first; existing roadmap order and numbering stay intact. The proposed lineup flag and configuration are not implemented.

## Tool, model and effort for new and open

Proposed follow-up: allow optional `--tool`, `--model` and `--effort` on ordinary `timber new` and `timber open`, reusing Arena's native tool selection for one invocation. Users can choose an agent without editing saved configuration; omitted flags retain existing behavior.

See the [individual new/open tool selection roadmap](new-open-tool-model-effort-roadmap.md) for proposed CLI examples, precedence, explicit launch intent, workflow compatibility, dependencies and focused verification. These flags are not implemented for ordinary commands. Existing roadmap order and TIM-20/21/22 scope remain unchanged.

## Worktree groups, freshness and agent context

The [earlier worktree groups, swarms, freshness and decision-context note](worktrees-swarms-and-launching-multiple-worktrees-for-reasons-like-review-implement-etc-and-automatic-rebase-updates-and-insight-into-agent-decisions.md) is now retained here as a historical research companion. It proposes implementation/review/optional-QA worktree groups, pinned source revisions, ahead/behind inspection, explicit sync previews, and three freshness policies: guarded automatic, prompt/on-demand, and observe-only/manual.

Additional proposals cover decision history (what changed, why, evidence and tests), Entire CLI/Git AI compatibility research, and external orchestration recipes. Suggested slices are role-based groups, freshness/group sync, decision-context reporting, and an orchestration recipe. They complement the existing Team/Batch/Validation proposals without changing their order.

These remain proposals. Review/QA targets stay pinned unless explicitly refreshed. Any future sync/rebase needs a reviewed preservation and authorization contract; policy labels alone never authorize Git writes or bypass dirty, untracked, ignored, unpublished or unproven work. Automatic triggers require separate review within Timber's architecture constraints; a daemon or new session manager is not approved by this note. External integrations require actual compatibility testing before recommendations.

The copied note retains its original October 12 context and older status statements; it does not expand TIM-20/21/22 or move optional TOML worktree limits from first place.

## Explicit base revisions for new, open and related commands

Proposed follow-up: let `--base <revision>` select a branch, full/unique abbreviated commit ID, commit-resolving tag, or reviewed Git revision expression for one invocation, overriding TOML without changing saved defaults. Pin the resolved commit so a moving source ref cannot silently change the starting snapshot.

See the [individual explicit base revisions roadmap](base-revision-selection-roadmap.md) for command boundaries, precedence, remote refresh, provenance and verification. Extend existing `new`/Arena source selection and review `open --base` for explicit fresh-destination creation. Reopening existing work must never reset or rebase it; conflicting base input fails with guidance to create a fresh destination.

These are future extensions, not shipped support for arbitrary Git syntax. Resume/pick and cleanup retain their own contracts; sync/rebase needs separate design. Existing roadmap order and TIM-20/21/22 acceptance criteria remain unchanged.

## Team decisions to make

- Which problem should we solve next: inspection, independent review, validation, parallel comparison, coordinated implementation, bulk jobs, or staged quality control?
- Which ideas fit existing resume/pick requirements, and which deserve separate tickets?
- Which tools and operating systems will the first version actually support?
- What evidence would show that an added mode improves outcomes enough to justify its coordination and maintenance costs?

## Why Timber should eventually support all these workflow styles

We should aim to support Arena, Review, Validation, Team, Batch and Pipeline workflows as explicit, opt-in choices. They solve different recurring problems: finding a good approach, examining a change independently, reproducing and verifying behavior, dividing implementation work, processing many jobs, and improving one solution through specialist stages. A user should be able to choose the right relationship between agents without abandoning Timber's workspace lifecycle or preferred tools.

The fit is practical. Repository discovery, Git worktrees, task references, agent configuration, setup hooks, identity checks, retained state and inspection paths already form useful foundations. Shared foundations can make additional workflows understandable and consistent, while each mode defines its own execution, communication, results and integration rules.

Supporting all styles should mean supporting their useful behavior, not reproducing every vendor feature or hiding a universal orchestration engine inside Arena. A team mode needs ownership; batch mode needs queue/retry semantics; pipeline mode needs stage contracts; parallel Arena needs clear terminal/headless execution and cancellation rules. Each should arrive through a scoped design, measured trials and preservation tests.

Our recommendation is therefore to finish the three Arena tickets as designed, begin the new follow-up roadmap with optional TOML worktree limits, and develop the broader management, Arena, Review, Validation, Team, Batch and Pipeline system through separate reviewed tickets. This gives Timber room to grow while keeping its central promise: users control their tools and workspaces, and their work survives uncertainty and failure.
