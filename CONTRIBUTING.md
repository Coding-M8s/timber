# Contributing to Timber

Bug reports, platform reports, and focused pull requests are welcome.

## Before you start

- Report bugs and propose features through
  [GitHub issues](https://github.com/Coding-M8s/timber/issues/new/choose).
- Report security problems privately; see [SECURITY.md](SECURITY.md).
- Open an issue before a pull request that changes behavior, so the scope can
  be agreed first. Small fixes and documentation corrections can go straight to
  a pull request.
- Some things are out of scope: GUI or IDE work, a Rust rewrite, a database, a
  daemon, a local API, a global task registry, and a provider plugin framework.

## Licensing of contributions

Timber is source-available under the
[MIT License plus Commons Clause v1.0](LICENSE), not an OSI-approved open-source
license. By submitting a contribution you confirm that you have the right to
submit it and agree that it is licensed under those same terms. Read the
[licensing details](docs/licensing.md) first if that affects whether you want to
contribute.

## Set up

You need Git and Bun 1.4.2 (pinned in `.bun-version`). Python 3 is needed for
PTY tests; Bash, Zsh, and Fish are needed for their completion suites.

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

Linux x86_64 is the tested development platform. See the
[development section of the guide](docs/guide.md#development) and
[building and releasing](docs/releases.md) for standalone builds.

## Making changes

Read [AGENTS.md](AGENTS.md) and the [CLI behavior contract](docs/cli-contract.md)
before you change behavior. The rules there apply to every contributor. The ones
that most often matter in review:

- Keep changes small: one topic per branch and pull request.
- Invoke Git with an executable plus an argument array. Never build shell
  commands from user input.
- Test Git changes against real temporary repositories, including failure cases
  that check files and refs are left intact.
- Do not use the em dash character (U+2014) anywhere. Use plain punctuation.
- Keep secrets, real environment files, and private details out of code,
  fixtures, logs, and commits.
- Keep `README.md` short. Put detail in a focused document under `docs/`.

## Commits and pull requests

- Do not add AI coauthor trailers or AI authorship signatures to commits or pull
  request descriptions. CI rejects them. Check a message locally with
  `bun run check:attribution --message-file <path>`.
- In the pull request, list the exact verification commands you ran and what
  they printed. Do not claim a platform works unless you tested it.
- Run `bun run typecheck` and `bun test` before you push.
