# Timber CLI

A small CLI for creating, opening, listing, and safely cleaning up Git worktrees.

**Bootstrap stage:** the CLI runs and displays help. `new`, `open`, `ls`, and `done` are explicit placeholders that exit nonzero without changing Git or files. Worktree operations land in their assigned tickets.

## Development

Use Bun **1.4.2** (pinned in `.bun-version`) on Linux x86_64. Git is required for
future worktree operations. Node is not required to run the CLI through Bun.

```bash
bun install --frozen-lockfile
bun run dev --help
bun run typecheck
bun test
bun run build
bun dist/index.js --help
```

`build` creates a Bun JavaScript bundle in `dist/index.js`; it is not a standalone
release binary. Standalone packaging belongs to TIM-17. `src/index.ts` also has a
Bun shebang and is the package's `timber` bin entry. No global installation is
needed for development. GitHub CI runs locked installation, typecheck, tests, build
and bundled help on Ubuntu x86_64. Other platforms are not verified.

## Planned commands

```bash
timber new my-feature
timber open my-feature
timber ls
timber done my-feature
```

## Release scope

- **0.1 — Worktree CLI:** repository discovery, local/remote branch resolution, four commands, repository configuration, optional editor opening, conservative cleanup.
- **0.2 — Integrations:** trusted setup hooks, optional interactive Claude/Codex launching, Jira lookup. The CLI remains usable without Jira credentials or an AI subscription.
- **1.0 — Stable CLI:** real-repository dogfooding, errors, safety validation, documentation, verified Linux x86_64 packages.

TypeScript and Bun are the development direction, with Commander, Execa, Zod, and smol-toml. Exact dependency versions are pinned in `package.json` and `bun.lock`; compatibility tests exercise them under Bun. No GUI/IDE, Rust rewrite, database, daemon, or plugin framework is included.

## Planning and contribution

- [Implementation tickets](https://github.com/Coding-M8s/timber/issues)
- [Delivery board](https://github.com/orgs/Coding-M8s/projects/2/views/2) · [Timber CLI Project](https://github.com/orgs/Coding-M8s/projects/2)
- [Behavioral contract](docs/cli-contract.md)
- [Shared TypeScript contracts and service seams](docs/shared-contracts.md)
- [Full handoff and scheduling](docs/timber-github-handoff.md)
- [Setup mapping and remaining actions](docs/github-project-setup.json)
- [Development guidance](AGENTS.md)

TIM-11 provides the scaffold and shared contracts. After it merges, Dev 1 starts TIM-1 (Git context), Dev 2 starts TIM-6 (configuration), and Dev 3 prepares TIM-14 (list command) against test doubles, completing it after TIM-1. Use independent ticket branches and PRs with one implementer and one reviewer.
