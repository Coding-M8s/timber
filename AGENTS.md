# Timber development guidance

This is a small TypeScript CLI using Bun for development, tests, and optional standalone builds. Read docs/cli-contract.md and the assigned ticket before implementation. The initial setup is documentation only; TIM-11 establishes the scaffold, verifies dependency compatibility, and commits the lockfile.

- Prefer small modules and plain functions. Use Commander, Execa, Zod, and smol-toml after verifying supported versions.
- Installed Git and its worktree metadata are the source of truth. Invoke Git using executable plus argument arrays; never interpolate user input into shell commands.
- No GUI/IDE work, Rust rewrite, database, daemon, local API, global task registry, or provider plugin framework.
- Test Git mutations with meaningful temporary real repositories, including failure cases that assert files and refs remain intact. Use test doubles at command service seams.
- Preserve dirty, untracked, ignored, unpublished, and unproven work according to the contract. No destructive force bypass.
- Keep editor and agent launching separate. Agents run interactively in the invoking terminal. Trusted shell hooks receive context through environment variables, never shell source substitution.
- Keep secrets out of repository config, logs, tickets, and commits.
- Linux x86_64 is the initial release target. Claim other platforms only after actual testing.
- Work in independent ticket branches and PRs with one implementer and one reviewer. Review shared-contract changes before incompatible work. Logical lanes do not imply GitHub assignees.
- Record exact verification commands and observed results. Do not claim passing builds before a scaffold exists.
- Ship 0.1 before waiting on 0.2 integrations. Measure demonstrated performance problems before considering language changes.
