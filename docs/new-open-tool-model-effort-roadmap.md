# Tool, model and effort selection for new and open

Proposed follow-up • 19 October 2026

Companion to the [Arena and future workflow roadmap](arena-workflow-research.md#tool-model-and-effort-for-new-and-open). Documentation only: the flags below are proposed for ordinary `new` and `open`; they currently exist only in Arena's selection interface. Existing roadmap order and TIM-20/21/22 acceptance criteria remain unchanged.

## Goal and current behavior

Choose one agent tool and optional model/effort when creating or opening a worktree, without editing saved configuration for a one-off launch. Use standard `--model` spelling.

Today, ordinary `new` and `open` offer `--agent` and `--no-agent` for configured launchers. Global/repository configuration and named workflows determine the executable and literal arguments. An existing workflow-associated worktree normally reopens without replaying setup or implicitly launching its agent. Arena already resolves tools/models/effort through shared matching and tool-specific capability checks.

## Proposed interface

Illustrative future commands, not currently supported:

```sh
timber new my-feature --tool codex --model your-model-id --effort low
timber open my-feature --tool cursor --model your-cursor-model --no-editor
timber open my-feature --tool claude
```

Offer one `--tool <query>`, optional `--model <id>`, and optional `--effort <level>` per invocation. No repeated groups, runs or lineups: these commands launch one agent in one selected worktree.

Proposed first-slice rules, subject to shared-contract review:

- Explicit `--tool` requests a foreground agent launch; `--agent` alongside it is redundant but valid. Reject `--no-agent` with selection flags before mutation.
- Initially require explicit `--tool` when supplying `--model` or `--effort`. Arbitrary configured commands and wrappers do not reliably identify a native tool. Model/effort-only overrides of configured agents need a separate typed-launcher design.
- Omitting all three flags retains current configured-agent and workflow behavior, including `--agent`/`--no-agent` semantics.
- Omitting model or effort keeps that native tool's default; never infer another session's choices.
- Resolve tools through the existing matcher. Reuse model matching, literal custom IDs, supported effort discovery and native argument translation. Ambiguity must be resolved interactively or fail with actionable exact choices; never guess effort support.
- Start with existing native tool adapters for `codex`, `claude` and `cursor`. Keep custom executable paths and literal wrapper arguments in existing configuration; do not infer a tool from an executable filename or shell string.

## Precedence, workflow and launch behavior

Explicit tool selection supplies an invocation-local native executable/model/effort selection ahead of workflow and ordinary agent configuration. Do not append arguments from a different configured tool or wrapper. In particular, do not silently inherit workflow agent prompt arguments when replacing that launcher; disclose that boundary in help and review whether task handoff needs a later explicit interface.

Keep workflow association, hooks and editor policy intact. Selecting a tool does not save a new default, alter workflow configuration, or imply setup retry. An explicit tool on an existing worktree deliberately launches that tool; a later plain reopen follows existing behavior. It does not restore any native conversation or reinterpret an Arena attempt's recorded configuration.

Require interactive stdin/stdout and CI off for explicit selection, as for explicit `--agent`. Resolve and validate flags, capability combinations and launch prerequisites before Git creation/materialization, remote refresh, workflow-association writes, hooks or editor startup. Invalid, conflicting or unavailable selections must leave files and refs intact.

After successful Git/setup and successful or skipped editor startup, reuse the existing foreground launcher with literal argument arrays and worktree cwd. Await the child and preserve exit/signal behavior and retained-workspace diagnostics. Editor failure continues to suppress launch. A normal `open` must not gain implicit fetch, rebase, cleanup or setup behavior from this proposal.

## Dependencies and scope

Reuse Arena's selection/capability helpers through small shared functions rather than introducing a provider framework or coupling ordinary commands to Arena records. Review ordinary new/open options, workflow precedence, native invocation construction, help/completion, terminal capability checks and failure/retry messages before implementation.

This follow-up can be designed after TIM-20 establishes the reusable selectors. It does not depend on Saved Arena lineups, parallel execution or new storage. Preset selection for ordinary commands can be considered separately; this slice covers tool/model/effort flags only.

Retain current privacy and preservation contracts. Do not log raw command arguments, prompts or private native configuration. Safely displayed retry guidance must identify the selected tool and any necessary non-sensitive overrides, or clearly explain how to supply them again; do not silently retry a different configured agent.

## Focused verification for implementation

- Check parsing, duplicate/conflicting flags, model/effort without tool, exact/prefix/fuzzy selection, ambiguous noninteractive refusal and cancellation without side effects.
- Verify native argument translation, supported/unknown effort handling, omitted native defaults and literal custom model IDs with existing discovery seams.
- Cover explicit override versus global/repository/workflow defaults, disabled agent settings, unchanged behavior with no selection flags, and no configuration writes.
- Cover both creation paths and existing worktree reopening, including saved workflows. Explicit tool selection launches once; plain reopen does not replay setup or initial workflow agent launch.
- Assert invalid selections and noninteractive explicit launches fail before fetch, association writes, Git mutations, hooks or editors.
- Verify setup/editor failure suppresses agent launch, agent cwd/stdin/stdout/stderr, exit statuses and interruption through launcher seams.
- Use temporary real repositories for creation/materialization failures and dirty/untracked/ignored preservation. Verify existing files and refs remain intact.
- Check help, Bash completion and documented examples against implemented flags when this ticket ships. Runtime tests are future acceptance work, not evidence supplied by this roadmap edit.
