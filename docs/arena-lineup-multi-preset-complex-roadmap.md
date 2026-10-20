# Saved Arena lineups and multi-agent presets roadmap

Proposed follow-up • 19 October 2026

Companion to the [Arena and future workflow roadmap](arena-workflow-research.md#saved-arena-lineups). Documentation only: `--lineup` and the TOML below are proposals, not supported configuration or commands. This proposal does not change TIM-20/21/22 acceptance criteria.

This proposal expands Timber's existing preset and Arena configuration contracts. The same safety rules apply: resolve the lineup before any mutation; preserve dirty, untracked, ignored, unpublished, and unproven work; refuse rather than force; keep task text and raw command arguments out of diagnostics, manifests, and commits. Failure tests use temporary repositories and assert that original files and refs survive.

## User benefit and current behavior

Users who repeat a comparison should be able to select one reusable name instead of repeating several tool or preset groups. For example, a quick comparison might run one low-effort Codex preset and one Cursor preset; a larger comparison could repeat either configuration.

Today, an agent preset names one tool/command/model/effort/argument configuration in `[arena.agents.<name>]`. The preset name already acts as its shortcut; exact names, unique prefixes and fuzzy selection resolve through the existing matcher. Ambiguity requires interactive selection or an actionable error in scripts. There is no separate alias list, and one preset cannot contain multiple tools. Guided selections are not automatically saved.

Existing preset configuration lives in:

- Global: `~/.config/timber/config.toml`, or `$XDG_CONFIG_HOME/timber/config.toml` when XDG_CONFIG_HOME is absolute.
- Repository: `.timber.toml` in the primary checkout root, shared across its worktrees.

Repository presets replace same-name global presets as whole entries. Existing per-name `false` and `arena = false` disable inheritance. A lineup should build on these rules rather than change what an agent preset means.

## Proposed interface

Keep `--preset` as one agent configuration. Add `--lineup <name>` for one saved ordered collection of exact preset references, each with an optional run count defaulting to one.

Illustrative future configuration, assuming `luna-low` and `composer` are separately defined agent presets:

```toml
[arena.lineups.quick]
groups = [
  { preset = "luna-low" },
  { preset = "composer", runs = 2 },
]
```

Illustrative future invocation:

```sh
timber arena new compare --lineup quick --prompt "Your task"
```

This expands to three attempts in order: one `luna-low`, then two `composer` attempts. Task instructions remain invocation-specific through `--prompt`, `--prompt-file`, or interactive entry; lineups do not store task text.

Reuse the existing matcher for lineup selection. Resolve once and retain the exact selected lineup name and preset choices. Stored preset references must be exact names, never fuzzy queries. Initially accept one lineup per invocation and reject mixing it with explicit `--tool`/`--preset` groups or their `--model`, `--effort` and `--runs` modifiers.

## Proposed configuration precedence

Review and finalize these rules against the shared configuration contract before implementation:

- Merge global and repository lineups by name. A repository entry replaces the entire same-name global lineup, including its ordered groups; do not concatenate or partially merge groups.
- Allow a repository same-name lineup set to `false` to disable the inherited entry. Preserve existing `arena = false` behavior for the entire Arena configuration.
- Resolve each exact preset reference against the effective merged agent preset collection. A repository preset override therefore affects newly invoked global or repository lineups that reference it.
- Report missing or disabled references before mutation. A disabled lineup is unavailable for selection.
- Validate both configuration scopes, including malformed unused or overridden entries, consistently with current configuration parsing. Validate effective references after merging, so a repository can intentionally supply a preset referenced by a global lineup.
- Reuse preset naming constraints and reserved-name rules unless shared-contract review identifies a reason to differ. Define validation messages and setup round-trip preservation for the new table.

## Scope and acceptance criteria

1. Parse the saved ordered groups, preserving order and repeated references. Counts and their total must be positive safe integers; omitted counts mean one. Require at least two total runs. Add no arbitrary upper cap.
2. Resolve the lineup, all referenced presets, native arguments and supported model/effort combinations before any fetch, branch/worktree creation, record reservation, setup or launch. Missing/disabled presets, invalid counts, overflow and mixed selection flags fail with actionable errors and no mutation.
3. Expand into existing Arena groups and reuse current source selection, pinned base, whole-batch destination preflight, configured budget checks when available, preservation, setup and sequential foreground launch behavior.
4. Record resolved run configurations and the exact selected lineup identity as provenance. Current manifests deliberately omit raw argument dumps; review how existing configuration references/fingerprints preserve exact launch behavior without introducing sensitive diagnostic output.
5. Resume must use recorded configurations and task snapshots after identity revalidation. Editing, disabling or deleting a lineup or changing a referenced preset must never silently reinterpret an old arena. If exact configuration cannot be recovered through the reviewed storage design, fail explicitly rather than launch changed settings.
6. Keep task bytes invocation-specific and privately snapshotted through the existing task contract. Review UI shows the expanded groups/counts and destinations using existing privacy rules.
7. Preserve strict config validation and setup round-trips. Existing agent-only configurations, CLI grouping and historical arena records remain compatible.

No nested lineups, separate alias registry, automatic wizard saving, new execution engine, parallel launch mode or new integration/cleanup behavior belongs in this slice.

## Dependencies and contract review

Build on TIM-20's agent presets, matcher, group planner, immutable task snapshot and sequential launcher. Coordinate recorded-configuration behavior with TIM-21; retain TIM-22's human selection and preservation boundaries. Configurable worktree limits remain the first proposed enhancement; this page does not move existing roadmap items.

Before implementation, review CLI grouping and help/completion, global/repository parsing and inheritance, setup serialization, planning, manifest schema/backward compatibility, and resume configuration recovery. Decide whether immutable configuration data or verified existing references satisfy exact replay without logging private command arguments. A saved lineup is configuration expansion, not a new orchestration subsystem.

## Focused verification for implementation

- Parse/merge fixtures for global-only, repository-only, whole-entry replacement, per-name disable and `arena = false`; round-trip through setup without losing lineup tables.
- Exercise exact/prefix/fuzzy selection, ambiguous interactive selection/cancellation and noninteractive refusal; resolve stored preset names exactly.
- Check expansion order, repeated presets, omitted counts, valid large counts without arbitrary caps, invalid/overflow counts and fewer than two total runs. Test large counts in pure planning without launching huge batches.
- Reject missing/disabled references and mixed flags before mutation. Use service seams to assert no fetch, creation, record writes, setup or agent launches occur.
- Compare equivalent explicit groups and a lineup through the existing planner and launcher seams; verify identical task/base/configuration and sequential launch ordering.
- Use temporary real repositories for meaningful creation/failure and preservation checks. Assert original files and refs survive refusal or partial failure.
- Record an arena, then edit/remove its lineup and change/disable referenced presets. Verify revisit retains recorded settings or explicitly refuses unavailable exact recovery; never substitute current configuration. Check old manifests remain readable.

For this documentation change, verify local links, proposal labels, unchanged roadmap order and absence of product-code edits. Runtime tests belong to the future implementation.
