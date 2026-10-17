# Explicit base revisions for new, open and related commands

Proposed follow-up • 19 October 2026

Companion to the [Arena and future workflow roadmap](arena-workflow-research.md#explicit-base-revisions-for-new-open-and-related-commands). Documentation only: this page proposes broader revision support and an ordinary `open --base` interface. It does not claim these extensions are implemented or change TIM-20/21/22 acceptance criteria.

## Goal and current behavior

Let a user choose a starting snapshot on the fly: a branch, a particular commit on that branch, a tag, or another supported exact Git revision. An explicit `--base <revision>` overrides configured base selection for that invocation without editing global or repository TOML.

Ordinary `new` and `arena new` already expose `--base`; ordinary `open` currently resolves an existing worktree or branch and has no such option. Existing base selection prioritizes explicit CLI input over configuration and default-branch discovery. Arena currently documents branch/ref selection rather than general raw-commit selection. Broader revision support requires shared-contract review.

## Proposed revision selectors

Support these commit-resolving selectors through installed Git, subject to a reviewed, documented grammar:

- Full commit object IDs and unique abbreviated IDs supported by the repository's object format; reject ambiguous abbreviations.
- Exact local branch names and full branch refs.
- Explicit remote-tracking selectors such as `origin/feature-x` and full remote-tracking refs.
- Tags, including annotated tags that peel to a commit; require explicit `refs/tags/...` when short names collide.
- Bounded Git revision expressions such as `HEAD~2` and `feature-x~3`, and explicit commit peeling where useful. Review supported operators before implementation; do not promise all Git revision syntax.

A branch identifies a moving ref; the resolved commit identifies the immutable starting snapshot. A branch's historical commit can be selected directly by hash or a supported ancestor expression. Reject ambiguous branch/tag names, ranges, multiple revisions, tree/blob objects, option-like inputs and unsupported selectors. Never fuzzy-match source revisions or evaluate shell substitutions. Missing explicit input is an error, never a fallback to TOML.

Illustrative future invocations, using a commit ID that exists in the selected repository:

```sh
timber new fix-regression --base <commit-id>
timber new experiment --base feature-x
timber new previous-release --base refs/tags/v1.0.0
timber new earlier-snapshot --base 'feature-x~3'
timber arena new compare --base <commit-id> --prompt-file task.md --tool codex --runs 2
```

Angle-bracket values are placeholders, not literal shell input. The destination branch name remains separate from the source revision.

## Command behavior and the open distinction

| Command or case | Proposed meaning of explicit base |
| --- | --- |
| `new <destination> --base <revision>` | Create a fresh destination branch/worktree from one resolved commit, using existing destination collision and preservation checks. |
| `arena new <name> --base <revision>` | Create fresh attempts from the same resolved commit and retain source provenance; task, setup and sequential launch behavior remain intact. |
| `open <existing-worktree>` | Reopen its current files and branch. A base flag must not reposition it. |
| `open <existing-branch>` materialization | Materialize that branch at its own current tip. A base flag must not reset the existing branch to a different commit. |
| Future fresh-destination creation through `open` | If approved, allow `open <new-local-branch> --base <revision>` to explicitly create a missing destination from the selected commit. Define exact destination matching and conflict errors before shipping; no accidental creation after a failed or ambiguous lookup. |
| Arena resume/pick and ordinary cleanup | Retain their recorded identity, source and preservation semantics. This proposal does not introduce a replacement-base flag for them. |
| Future group creation or sync | Reuse the resolver where appropriate. Creation selects a start; sync/rebase changes existing history and needs its own reviewed interface and authorization contract. |

Proposed `open` examples, conditional on approval of the fresh-destination extension:

```sh
timber open new-investigation --base <commit-id>
timber open new-investigation-from-feature --base 'feature-x~2'
```

For an existing worktree or branch, initially reject `--base` with an explanation and a `new <fresh-destination> --base <revision>` alternative. Reject even a matching base rather than imply the flag updates existing work. Do not silently ignore an explicit override, detach the existing branch, reset, rebase, stash or replace files.

If opening a commit directly as a detached inspection worktree is desired, design that as a distinct explicit interface. A commit selector is not an instruction to move the current checkout.

## Precedence and source resolution

1. Explicit `--base` wins over repository TOML, global TOML, ticket-based source inference where applicable, and default-branch discovery. It is invocation-local; do not save a new config default.
2. With no explicit base, retain each command's existing source-selection contract. Broad revision support does not change ordinary `open` target meaning.
3. Resolve one commit and retain it through review, creation, hooks and launch. Moving refs or changing `HEAD` must not silently change the snapshot after review.
4. Preserve existing remote-selection and confirmed-refresh rules. Distinguish an explicitly selected live remote branch from a locally available immutable commit or tag; no implicit network lookup for arbitrary hashes and no fetching every remote to search for a missing object. Report unavailable objects and explicit recovery guidance.
5. For a live remote source, review the selected ref/advertised commit before the authorized refresh and verify it afterward; stop if it moved. Define any newly supported remote-tag refresh separately rather than treating tags as branches.
6. Invoke Git with executable plus argument arrays and an option-safe, single-commit resolver. Define option termination, object peeling, repository boundaries and supported Git versions in implementation review. Treat revision text as data.

## Planning, provenance and preservation

Complete selector validation and destination preflight before mutations. Pin the exact resolved object ID, and retain the original selector/source kind alongside it where existing records support provenance. Review any manifest extension for compatibility; never reinterpret an existing arena against an edited config, moved tag or current branch tip.

Preserve source worktrees, local/remote refs and all dirty, untracked, ignored, unpublished and unproven work. Starting from a branch's commit does not adopt or modify that source branch. Fresh attempts/destinations use existing safe creation rules; failures retain completed work with clear retry guidance. No force bypass, implicit publish, integration or cleanup follows from a chosen base.

Keep shared architecture small: one resolver with command-specific source and destination policies. Review CLI help/completion, config precedence, ordinary new/open discovery, Arena preflight and storage, remote refresh, and failure messages before implementation.

## Focused verification for implementation

- Use temporary real repositories to cover full/abbreviated commit IDs, ambiguous IDs, local/remote refs, lightweight/annotated tags and approved ancestor expressions.
- Refuse branch/tag collisions without an explicit namespace, non-commit objects, missing objects, revision ranges, option-like inputs and unsupported syntax before mutation. Assert original files and refs remain intact.
- Verify CLI precedence over repository/global defaults without changing TOML; omitted flags retain existing behavior.
- Move a branch/tag after source resolution and prove the planned commit remains pinned or the required refresh comparison refuses; no silent source substitution.
- Verify local commits work offline, unavailable objects produce explicit errors, and remote source failures never fall back to stale/configured bases.
- Cover ordinary creation and Arena batches from identical source commits, destination collisions and partial failures with retained work.
- Cover existing `open` targets refusing base overrides without resetting files or refs. If the fresh-destination extension is approved, test exact missing-target creation, ambiguous lookup refusal, conflicting existing refs and subsequent ordinary reopen.
- Confirm recorded arenas remain tied to their original commit after config/ref changes. Keep resume/pick and cleanup proof unchanged.
- Update help and completion for supported selector classes without network calls or mutations during completion. Record exact test commands and observed outcomes when implemented.

This roadmap edit supplies no runtime implementation or new platform claims. Existing proposal order, including optional TOML worktree limits first, remains intact.
