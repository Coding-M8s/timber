# Timber CLI

A small CLI for creating, opening, listing, and safely cleaning up Git worktrees.

**Planning stage: the CLI is not implemented.** This repository contains the approved contract and implementation backlog. TIM-11 is the next task; build and test commands will be introduced there.

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

TypeScript and Bun are the development direction, with Commander, Execa, Zod, and smol-toml. Supported dependency versions and a lockfile belong to TIM-11. No GUI/IDE, Rust rewrite, database, daemon, or plugin framework is included.

## Planning and contribution

- [Implementation tickets](https://github.com/Coding-M8s/timber/issues)
- [Delivery board](https://github.com/orgs/Coding-M8s/projects/2/views/2) · [Timber CLI Project](https://github.com/orgs/Coding-M8s/projects/2)
- [Behavioral contract](docs/cli-contract.md)
- [Full handoff and scheduling](docs/timber-github-handoff.md)
- [Setup mapping and remaining actions](docs/github-project-setup.json)
- [Development guidance](AGENTS.md)

TIM-11 bootstraps shared contracts. After it merges, Dev 1 starts TIM-1 (Git context), Dev 2 starts TIM-6 (configuration), and Dev 3 prepares TIM-14 (list command) against test doubles, completing it after TIM-1. Use independent ticket branches and PRs with one implementer and one reviewer.
