# Timber development guidance

This is a small TypeScript CLI using Bun for development, tests, and optional standalone builds. Read docs/cli-contract.md and the assigned ticket before implementation. The initial setup is documentation only; TIM-11 establishes the scaffold, verifies dependency compatibility, and commits the lockfile.

- Prefer small modules and plain functions. Use Commander, Execa, Zod, and smol-toml after verifying supported versions.
- Installed Git and its worktree metadata are the source of truth. Invoke Git using executable plus argument arrays; never interpolate user input into shell commands.
- No GUI/IDE work, Rust rewrite, database, daemon, local API, global task registry, or provider plugin framework.
- Test Git mutations with meaningful temporary real repositories, including failure cases that assert files and refs remain intact. Use test doubles at command service seams.
- Preserve dirty, untracked, ignored, unpublished, and unproven work according to the contract. No destructive force bypass.
- Keep editor and agent launching separate. Agents run interactively in the invoking terminal unless an enabled, explicitly selected editor integration owns their terminal. Orca uses the existing local window and exact worktree, with separate setup and agent terminals; never silently fall back after handoff failure. Trusted shell hooks receive context through environment variables, never shell source substitution.
- Keep secrets out of repository config, logs, tickets, and commits.
- Linux x86_64 is the initial release target. Claim other platforms only after actual testing.
- Work in independent ticket branches and PRs with one implementer and one reviewer. Review shared-contract changes before incompatible work. Logical lanes do not imply GitHub assignees.
- Record exact verification commands and observed results. Do not claim passing builds before a scaffold exists.
- Ship 0.1 before waiting on 0.2 integrations. Measure demonstrated performance problems before considering language changes.

## Commit hygiene

- Never add AI coauthor trailers or AI-generated authorship signatures to commits, PR descriptions, or other authorship metadata. This includes Claude, Codex, ChatGPT, Copilot, Cursor, Gemini, Grok, and similar assistants. Preserve legitimate human coauthors.
- Validate proposed commit messages with `bun run check:attribution --message-file <path>`. With no arguments this checks the current tip; `--all-history` audits reachable history. CI rejects AI author/committer identities and prohibited AI attribution in introduced commits and PR descriptions, including edited PRs.
- `.githooks/commit-msg` provides the same check before local commits when explicitly activated; do not change Git hook configuration without the user's specific authorization.

- Keep Superpowers plans, specs, ledgers, and execution artifacts local. Never commit `.superpowers/` or `docs/superpowers/`, including with `git add -f`. This project preference overrides skill instructions to commit those artifacts.
- Treat commits as potentially public from day one. Do not commit credentials, private keys, real environment files, customer data, or private operational details in code, fixtures, plans, logs, or documentation.
- Commit shared product contracts and contributor documentation intentionally; review staged changes before committing. Ignore rules do not remove files from existing history.
