# Rebase ignored-path index

[Issue #110](https://github.com/Coding-M8s/timber/issues/110) replaced the
tracked-path by ignored-path nested scan in rebase ignored-file protection with
an index built once per preservation check and reused for the incoming base and
every replayed commit tree.

## How it works

Two maps keep the first ignored-list entry for each exact key and each directory
prefix. A tracked lookup checks its full key for equality or ignored descendants,
then checks its slash-delimited ancestors, and returns the entry with the lowest
ignored-list position. Lookups cost tracked-path depth instead of ignored-list
length.

Behavior matches the previous matcher: one trailing slash is stripped, case is
folded only on Windows, and Unicode is not normalized. Commit and tracked-path
traversal order, Git reads, identity checks, revalidation and refusal
diagnostics are unchanged.

## Benchmark

```sh
bun --no-env-file scripts/benchmark-rebase-ignored.ts <baseline-ref> [repetitions=9]
```

The script copies the current source into two temporary snapshots and replaces
only `preserveIgnored` in the "before" snapshot with the baseline's version.
Each run is a full CLI rebase in a disposable repository: one unrecorded warm-up
per variant, then alternating before/after pairs. Timing covers process start to
exit, including index construction; fixture setup and result verification are
outside the timed window.

Results on Linux x86_64, Bun 1.4.2, Git 2.56.0, nine pairs, local base (no
network), shared machine:

| Replayed commits | Tracked files | Ignored files | Before median (ms) | After median (ms) | Reduction |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 100 | 10 | 237.770 | 234.986 | 1.2% |
| 5 | 1,000 | 100 | 374.154 | 326.805 | 12.7% |
| 10 | 10,000 | 100 | 1295.038 | 694.009 | 46.4% |

For the largest fixture every after sample beat every before sample. The
smallest fixture's difference is within noise. Remote fetch latency, other
repository layouts and native Windows were not benchmarked.
