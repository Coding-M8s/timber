# Timber CLI licensing

Timber CLI uses the [MIT License plus Commons Clause License Condition v1.0](../LICENSE).
The copyright holder and licensor is Coding-M8s. These terms apply to this
CLI repository, not Timber IDE. The combined terms are source-available and are
not an OSI-approved open-source license. Package metadata uses the custom
`SEE LICENSE IN LICENSE` designation rather than claiming plain `MIT`.

## Allowed use and commercial restrictions

Personal, educational, and internal workplace use, including use within a
commercial business, is free. Modification, forking, and no-charge sharing are
permitted subject to retaining the MIT and Commons Clause notices.

The Commons Clause withholds the right to Sell Timber. Its definition reaches
products or services provided for a fee or other consideration whose value comes
entirely or substantially from Timber's functionality. It can cover paid hosting,
consulting, or support as well as selling binaries or rebranded forks. It is not
only a restriction on literal resale and does not prohibit every business use.
Products with substantial independent value can fall outside that restriction.
The [actual license text](../LICENSE) controls, not this summary.

Permission outside these terms must come from the rights holder. Ownership of
Timber does not confer ownership of its dependencies or restrict their separate
licenses. Preserve [third-party notices](../THIRD_PARTY_NOTICES.txt) with any
source, bundle, or executable distribution.

## Adoption audit for issue #115

This audit covers the checkout used for
[issue #115](https://github.com/Coding-M8s/timber/issues/115), before adoption.

- No root `LICENSE`, tracked license/notice files, or package `license` field
  existed. Searches of the tracked source, scripts, tests, README, docs and CI
  found no existing license grant or identified copied/vendor-code notices.
  Text searches do not prove the provenance of every line.
- Reachable history starts on 2026-10-08 and contains contributions under William
  Friend, Ben Sebring/Bsebring, and Rafal/Rafal Puk identities. Git authorship
  does not establish copyright ownership or assignment.
- The repository owner confirmed ownership and licensing authority for this
  repository through Coding-M8s and selected MIT plus Commons Clause after
  discussion of its broader commercial restrictions. The copyright year is 2026,
  matching the initial history. This records the owner's confirmation; no separate
  assignment agreements were available in the repository for independent review.
- No third-party material is relicensed under Commons Clause. Runtime packages
  retain their upstream licenses below. Full installed package license/notice
  texts are preserved in `THIRD_PARTY_NOTICES.txt`, including Apache-2.0 for
  human-signals, ISC for signal-exit, and BSD-3-Clause for smol-toml.
- Development-only TypeScript and its native compiler use Apache-2.0 and ship
  their own `LICENSE` and `NOTICE.txt`; Bun/Node/Undici type packages declare MIT.
  They are not included in the CLI bundle. Keep their installed notices when
  redistributing those tools separately.
- Release builds previously emitted only a binary, metadata, and checksums.
  They now copy the root license and notices, checksum both, and identify the
  combined terms in build metadata. Draft-release tooling carries and verifies
  those files for both platform candidates. No existing release is relicensed or
  modified by this change.

### Locked runtime package inventory

This includes all transitive runtime dependencies, even if bundling removes some
unused code. License texts were copied from the installed versions in `bun.lock`.

| Package | Version | Upstream license |
| --- | --- | --- |
| `@sec-ant/readable-stream` | `0.4.1` | MIT |
| `@sindresorhus/merge-streams` | `4.0.0` | MIT |
| `commander` | `15.0.0` | MIT |
| `execa` | `10.1.0` | MIT |
| `figures` | `6.1.0` | MIT |
| `fuzzysort` | `4.0.2` | MIT |
| `get-stream` | `9.0.1` | MIT |
| `human-signals` | `8.0.1` | Apache-2.0 |
| `is-plain-obj` | `4.1.0` | MIT |
| `is-stream` | `4.0.1` | MIT |
| `is-unicode-supported` | `2.1.0` | MIT |
| `npm-run-path` | `6.0.0` | MIT |
| `parse-ms` | `4.0.0` | MIT |
| `path-key` | `4.0.0` | MIT |
| `pretty-ms` | `9.3.1` | MIT |
| `signal-exit` | `4.1.0` | ISC |
| `smol-toml` | `1.9.0` | BSD-3-Clause |
| `strip-final-newline` | `4.0.0` | MIT |
| `unicorn-magic` | `0.3.0` | MIT |
| `which-command` | `0.1.0` | MIT |
| `yoctocolors` | `2.2.0` | MIT |
| `zod` | `4.6.5` | MIT |

### Bun runtime distribution caveat

Standalone executables embed Bun 1.4.4, not just Timber and its npm dependencies.
Bun's [versioned licensing inventory](https://github.com/oven-sh/bun/blob/bun-v1.4.4/LICENSE.md)
is reproduced in `THIRD_PARTY_NOTICES.txt`. It identifies JavaScriptCore/WebKit
under LGPL-2 and other independently licensed native libraries, including tinycc
under LGPL-2.1. The [Bun license documentation](https://bun.sh/docs/project/license)
describes runtime source and relinking requirements.

Timber's Commons Clause does not replace or narrow those library rights.

#### Runtime update to Bun 1.4.4 (2026-11-18)

The pinned runtime moved from Bun 1.4.2 to 1.4.4 for upstream TLS, `fetch`,
HTTP, and Brotli security fixes (issue #165). Bun's `LICENSE.md` was compared
between the `bun-v1.4.2` and `bun-v1.4.4` tags. The JavaScriptCore/WebKit,
tinycc, linked library, and polyfill sections are unchanged. The only addition
is a block of rows crediting code ported into `bun check`, `bun lint`, and
`bun fmt` (from typescript-go, ESLint, Prettier, oxc, Biome, and others) under
MIT, Apache 2.0, BSD 2-Clause, BSD 3-Clause, and ISC. None of these add a
copyleft obligation. `THIRD_PARTY_NOTICES.txt` now reproduces the 1.4.4
inventory, and the notices file and release notes link the `bun-v1.4.4` tag.
The LGPL obligations and approach recorded below are otherwise unchanged. The
release owner reviewed this update on 2026-11-18.

#### Release-owner review for 0.1.0 (2026-11-14)

The release owner reviewed the runtime distribution requirements for Bun 1.4.2
before the first public release. This is a good-faith engineering review, not
legal advice.

- License texts: `THIRD_PARTY_NOTICES.txt` now reproduces the full GNU Library
  General Public License version 2 and GNU Lesser General Public License
  version 2.1, copied unmodified from gnu.org, alongside Bun's inventory.
- Notice of use: the notices file and release notes state that executables
  embed Bun 1.4.2 with LGPL-licensed JavaScriptCore/WebKit and tinycc.
- Corresponding source: the notices file and release notes link the
  [Bun 1.4.2 tag](https://github.com/oven-sh/bun/tree/bun-v1.4.2), Bun's
  [patched WebKit](https://github.com/oven-sh/WebKit), and
  [tinycc](https://github.com/tinycc/tinycc). Timber relies on those upstream
  publications and does not mirror them.
- Relinking: Timber's source for each release tag is public, and
  `bun run build:release` rebuilds the executable with any Bun binary of the
  pinned version, including one built from modified library source using the
  steps in Bun's inventory.

Limits of this review: nobody built a custom Bun runtime or relinked a Timber
executable to prove the procedure, and license texts for Bun's other statically
linked libraries are covered by Bun's inventory and links, not reproduced in
full. Repeat this review whenever the pinned Bun version changes.

### Audit sources and reproduction

Official texts: [MIT](https://opensource.org/license/mit) and
[Commons Clause v1.0](https://commonsclause.com/). Commons Clause wording is
unmodified apart from line wrapping and filling Software, License, and Licensor.

Read-only audit commands included:

```sh
gh issue view 115 --repo Coding-M8s/timber --json number,title,body,url,labels
git ls-files '*LICENSE*' '*LICENCE*' '*NOTICE*' '*COPYING*' '*CLA*' '*DCO*'
git log HEAD --format='%aN' | sort -u
git log HEAD --reverse --format='%ad %s' --date=short
rg -n -i 'copyright|licen[cs]e|vendored|copied from|adapted from|source.available|open.source' src scripts tests README.md docs .github
```

Installed `node_modules/<package>/package.json` license fields and license/notice
files were read recursively from the five runtime dependencies. No dependency or
lockfile changes were needed. When dependencies or Bun change, refresh the
inventory and copied texts and repeat the runtime distribution review.
