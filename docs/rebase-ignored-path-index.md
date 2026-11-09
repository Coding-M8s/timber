# Rebase ignored-path index (#110)

[Issue #110](https://github.com/Coding-M8s/timber/issues/110) replaces the
tracked-path by ignored-path nested scan with an index built once per preservation
check and reused for the incoming base and every candidate replay tree.

Two maps retain the first original ignored-list entry for each exact key and
directory prefix. A tracked lookup checks its full key for equality/descendants,
then its slash-delimited ancestors, choosing the lowest ignored-list position.
Commit and tracked-path traversal order are unchanged. Matching still strips one
trailing slash, folds case only on Windows, and does not normalize Unicode.
Git reads, identity checks, revalidation and refusal diagnostics are unchanged.
Index storage follows the number of ignored paths and their directory prefixes;
lookups visit tracked-path ancestors instead of every ignored path.

## Whole-command benchmark

Measured 2026-11-08 on Linux x86_64, AMD Ryzen 7 7840U (16 logical CPUs),
Linux 7.2.11-200.fc44.x86_64, Bun 1.4.2 and Git 2.56.0.

Exact command (Bun was not on this session's PATH):

```sh
/home/williamfriend/.bun/bin/bun --no-env-file scripts/benchmark-rebase-ignored.ts 14aef65aa974559e242543b1904947776462baf7 9
```

Exit 0. The script copies current source into two temporary snapshots and replaces
only `preserveIgnored` in the before snapshot with the function from the specified
baseline. Both snapshots use the same installed dependencies and CLI implementation.
All Git mutations occur in disposable repositories, which are removed afterward.

Each fixture starts with the listed tracked-file count under `shared/tree/`.
Feature commits edit one additional file; the diverged local base adds another.
Thus each checked tree has the listed count plus one tracked path. Ignored files
share that directory prefix without colliding. Each measurement starts with a fresh
linked worktree at the original feature tip. One unrecorded warm-up per variant
precedes nine paired repetitions, alternating before/after execution order.

Timing covers subprocess startup through full CLI exit: configuration, Git status,
identity/revalidation reads, index construction, all tree scans, actual Git rebase
and base metadata publication. Repository/worktree setup and verification are
outside the timed interval. Every run verifies rewritten HEAD, exact base ancestry,
clean tracked status and unchanged bytes in every ignored file. These are actual
successful rebases, not already-integrated no-ops or isolated matcher timings.

| Replayed commits | Initial tracked files | Ignored files | Before median (ms) | After median (ms) | Reduction |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 100 | 10 | 273.876 | 266.846 | 2.6% |
| 5 | 1,000 | 100 | 423.772 | 375.429 | 11.4% |
| 10 | 10,000 | 100 | 1429.053 | 793.689 | 44.5% |

Samples below are milliseconds, rounded to three decimals, in repetition order.

- 1 commit / 100 files / 10 ignored:
  - Before: 267.277, 288.550, 273.876, 244.919, 286.096, 279.442, 270.706, 264.029, 278.145.
  - After: 275.572, 290.217, 266.846, 257.478, 253.369, 272.635, 251.218, 256.710, 297.377.
- 5 commits / 1,000 files / 100 ignored:
  - Before: 413.428, 428.570, 423.772, 404.906, 441.266, 402.871, 429.383, 392.119, 425.311.
  - After: 352.645, 420.806, 375.429, 395.173, 333.078, 377.739, 331.437, 400.564, 374.795.
- 10 commits / 10,000 files / 100 ignored:
  - Before: 1380.311, 1440.050, 1374.307, 1398.610, 1605.735, 1429.053, 1413.184, 2345.536, 1474.350.
  - After: 762.002, 903.433, 776.715, 751.416, 923.633, 793.689, 762.375, 1071.588, 885.391.

The smallest fixture's distributions overlap; its median difference does not
establish a small-repository speedup. The larger fixture demonstrates lower
whole-command time for this workload. This shared machine was not isolated from
other sessions, and the large-fixture samples include outliers. Local bases avoid
network variability; remote fetch latency, other histories/path layouts, memory
usage and native Windows execution were not benchmarked. These results do not
establish a universal rebase speedup or Windows support.

## Verification and self-review

Exact final commands and observed results:

```sh
/home/williamfriend/.bun/bin/bun test tests/ignored-path-index.test.ts tests/rebase-ignored.integration.test.ts tests/rebase.test.ts tests/rebase.integration.test.ts
# Exit 0: 85 pass, 0 fail, 60,329 assertions across 4 files (20.34 seconds).

/home/williamfriend/.bun/bin/bun run typecheck
# Exit 0: tsc --noEmit.

git diff --check
# Exit 0: no whitespace errors.

rg -n '\x{2014}|[ \t]+$' src/git/rebase.ts src/git/ignored-path-index.ts tests/ignored-path-index.test.ts tests/rebase-ignored.integration.test.ts scripts/benchmark-rebase-ignored.ts docs/rebase-ignored-path-index.md
# Exit 1: no em dash characters or trailing whitespace found.

git diff --cached --stat
# Exit 0: empty; all changes remain unstaged.
```

Differential tests compare against the original nested matcher over 7,500
seeded cases per case mode, with four lookups against each reused index:
60,000 comparisons total. Explicit cases cover exact/ancestor/descendant matches,
slash boundaries, duplicates, original first-match spelling/order, Unicode,
combining marks, case folding, control characters and prototype-like names.
The initial empty matcher produced 25 failed tests and 8 passes before
implementation. Self-review improved the seeded generator to use high bits rather
than repeating low-bit path shapes.

Four additional real-repository cases prove Unicode/file/directory refusal,
first tracked-path diagnostic precedence, unchanged refs/status/ignored bytes and
absence of a started rebase. Existing rebase safety tests cover replay-only
collisions, already-integrated no-ops, dirty files, changing branch tips,
target-selection revalidation, failed fetch/startup/hooks, conflicts, cancellation
and submodule preservation.
Self-review checked matching/order equivalence and confirmed that only the matcher
inside `preserveIgnored` changed; surrounding Git protections remain intact.
No unresolved findings. No separate reviewer, full-suite run or native Windows
verification was performed, following the requested focused verification scope.

## Speedup confirmation before commit-message draft

Repeated the exact nine-pair benchmark command above with exit 0. Production code
and benchmark implementation were unchanged. Results again include index
construction and full CLI rebases. Same shared-machine and local-base limitations
apply.

| Replayed commits | Initial tracked files | Ignored files | Before median (ms) | After median (ms) | Reduction |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 100 | 10 | 237.770 | 234.986 | 1.2% |
| 5 | 1,000 | 100 | 374.154 | 326.805 | 12.7% |
| 10 | 10,000 | 100 | 1295.038 | 694.009 | 46.4% |

Confirmation samples in milliseconds, rounded to three decimals:

- 1 replayed / 100 files / 10 ignored:
  - Before: 245.653, 239.724, 237.770, 243.088, 240.197, 230.160, 234.998, 230.321, 232.070.
  - After: 237.858, 234.986, 230.251, 237.528, 232.746, 234.486, 234.218, 242.365, 236.320.
- 5 replayed / 1,000 files / 100 ignored:
  - Before: 404.628, 358.169, 408.693, 391.205, 343.890, 395.281, 374.154, 355.747, 333.203.
  - After: 311.288, 374.444, 359.651, 296.511, 335.179, 313.777, 279.648, 326.805, 339.444.
- 10 replayed / 10,000 files / 100 ignored:
  - Before: 1228.419, 1248.145, 1404.074, 1421.243, 1295.038, 1129.994, 1300.515, 1290.484, 1332.593.
  - After: 870.435, 686.966, 714.599, 869.704, 728.372, 694.009, 682.344, 691.229, 683.390.

For the 10-commit / 10,000-file / 100-ignored fixture, every after sample was
faster than every before sample (after maximum 870.435 ms; before minimum
1129.994 ms). This confirms a speedup for that measured workload; the smallest
fixture still does not establish a speedup beyond noise.
