# Security policy

## Supported versions

Security fixes go into the latest published release. Older releases do not
receive fixes; update to the latest tag.

## Report a vulnerability

Report privately through GitHub:
[open a private security advisory](https://github.com/Coding-M8s/timber/security/advisories/new).
Do not open a public issue or pull request for a suspected vulnerability.

Include:

- The Timber version (`timber --version`) and how it was installed.
- Operating system, architecture, and `git --version`.
- The commands and configuration needed to reproduce the problem.
- What an attacker gains, and what access they need first.

Remove tokens, credentials, and private repository content from the report.
Maintainers work on Timber in their spare time and aim to acknowledge reports
within seven days.

## What counts

Timber runs with your account's permissions, calls Git, deletes worktrees, and
stores issue tracker credentials on your machine. Reports in these areas are
especially useful:

- Deleting or overwriting files, branches, or refs outside the documented
  [cleanup behavior](docs/guide.md#finish-a-worktree).
- Leaking stored Jira or Linear credentials through output, logs, files, or
  network requests.
- Running commands the user did not configure, including through branch names,
  ticket titles, or other untrusted input.
- A release asset that does not match its published checksums or build-info.

These are expected behavior, not vulnerabilities:

- Hooks, editors, and agents configured in `.timber.toml` or machine settings
  run as trusted shell code. Read a repository's configuration before running
  Timber in it.
- Release checksums detect corrupted or altered downloads. They are not
  signatures and do not authenticate the publisher.
- macOS and Windows release executables are unsigned.
