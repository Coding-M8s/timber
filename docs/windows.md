# Windows x64 candidate and verification handoff

Issue [#89](https://github.com/Coding-M8s/timber/issues/89) adds a native Windows
x64 candidate. **Verification is pending.** No Windows build, test, checksum,
workflow, downloaded executable, or interactive acceptance result has been
established for this change. The owner requested that all verification be left
for their Windows machine. Linux x86_64 remains the previously verified platform;
Linux regression verification of this change is also pending.

The intended first Windows environment is native Windows x64, Git for Windows,
and PowerShell. WSL, Windows ARM, case-sensitive Windows directories, network
shares, other invoking shells and Windows editor-terminal integrations are outside
the initial verification scope. Use local NTFS storage. Record the actual Windows
edition/build, shell, Git version and commands below before claiming support.

## Build from this branch on Windows

Development needs Bun **1.4.2**. Installed standalone users need Git for Windows,
without Bun, Node, Python or Docker. Windows PowerShell is used for private ACL
operations; keep the OS-provided Windows PowerShell installed even when invoking
Timber from PowerShell 7. Use a trusted PowerShell session in the source checkout.

Run these only when ready to verify:

```powershell
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
$PSVersionTable.PSVersion
git --version
bun --version
bun install --frozen-lockfile
bun run typecheck
bun test --timeout 120000 tests/platform-windows.test.ts tests/windows.integration.test.ts tests/release.test.ts
bun run build
bun dist/index.js --help
bun run build:release --target windows-x64
if ($LASTEXITCODE -ne 0) { throw 'Windows build failed' }
./scripts/check-windows-checksums.ps1 -Directory dist/release
$Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
./scripts/smoke-release-windows.ps1 `
  -Binary "dist/release/timber-v$Version-windows-x64.exe" `
  -ExpectedVersion $Version -RequireNoRuntime -EvidencePath windows-candidate-smoke.json
```

Check each command's exit status and stop at the first failure. Keep the JSON
evidence outside source control. On failure, the harness retains its synthetic
temporary repository and prints its location for inspection. It deletes only
its own temporary fixture after success. Logs must not contain real credentials,
task bodies or private paths from unrelated repositories.

The Windows source selection deliberately excludes Linux shell/PTY fixtures.
It is not a claim that the entire source suite runs on Windows. The Linux suite
and container acceptance remain required regression gates in CI.

The standalone harness launches a relocated executable from a path with spaces
and Unicode, isolating HOME, XDG configuration, Git settings and child PATH.
It exercises noninteractive setup refusal, new/open/ls, native path aliases,
reserved and case-only collisions, remote materialization, publication checks,
unpublished/dirty/primary/ignored cleanup refusals, successful cleanup, rebase
and conflict recovery, hook failures and explicit retries, editor startup
failure retention, and Arena new/resume with manual participants.

`-RequireNoRuntime` requires Bun, Node and npm to be absent from the child's
restricted PATH. Hosted Windows runners contain developer tools. This isolation
demonstrates runtime-independent execution but **does not prove those tools are
uninstalled**. Repeat the downloaded-artifact checks on a clean Windows machine
or VM with Git for Windows and no Bun, Node or npm installed. Do not treat source
execution, WSL, cross-compilation or a locally copied candidate as that evidence.

## Installation from a future verified release

There is no verified Windows release recorded here yet. The following procedure
is for a real existing release after native acceptance, not permission to create
a tag or publish a release. Choose its exact tag deliberately. GitHub CLI is
only a download tool; browser downloads of the same three assets also work.

```powershell
$Tag = 'vX.Y.Z' # Replace with a real, reviewed release tag.
$Download = Join-Path $env:TEMP ('timber-download-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Download | Out-Null
gh release download $Tag --repo Coding-M8s/timber --dir $Download `
  --pattern "timber-$Tag-windows-x64.exe" `
  --pattern build-info-windows-x64.json --pattern SHA256SUMS-windows-x64
if ($LASTEXITCODE -ne 0) { throw 'Download failed' }
$ExpectedNames = @("timber-$Tag-windows-x64.exe", 'build-info-windows-x64.json')
$Seen = @()
foreach ($Line in Get-Content -LiteralPath (Join-Path $Download 'SHA256SUMS-windows-x64')) {
  if ($Line -cnotmatch '^([a-f0-9]{64})  ([^/\\]+)$') { throw 'Invalid checksum manifest' }
  $Digest = $Matches[1]; $Name = $Matches[2]
  if ($Name -cnotin $ExpectedNames -or $Name -cin $Seen) { throw 'Unexpected checksum entry' }
  if ((Get-FileHash -LiteralPath (Join-Path $Download $Name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Digest) { throw 'Checksum mismatch' }
  $Seen += $Name
}
if ($Seen.Count -ne 2) { throw 'Incomplete checksum manifest' }
$Install = Join-Path $env:LOCALAPPDATA 'Programs\Timber'
New-Item -ItemType Directory -Path $Install -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $Download "timber-$Tag-windows-x64.exe") -Destination (Join-Path $Install 'timber.exe')
$env:PATH = "$Install;$env:PATH"
timber --version
timber setup --global
```

The PATH change above applies to the current PowerShell session. Add the install
directory to your user PATH through Windows settings for subsequent terminals.
Checksums detect corruption; obtain the artifacts through the reviewed GitHub
release and verify its tag/source identity as well.

For clean-machine acceptance, copy the two PowerShell verification scripts to
the machine, verify checksums there, then run the smoke script against the actual
downloaded executable. Record the release URL and digest. No Bun, Node, Python
or source dependencies are needed by those scripts or the installed executable.

## Configuration, hooks and launchers

Configuration locations retain the existing XDG convention. Absolute
`XDG_CONFIG_HOME` and `XDG_STATE_HOME` override defaults. Otherwise use `HOME`,
then `USERPROFILE`, then the OS home directory. Typical defaults are:

- `%USERPROFILE%\.config\timber\config.toml`
- `%USERPROFILE%\.config\timber\credentials\jira.json`
- `%USERPROFILE%\.local\state\timber\setup-hint-shown`

Repository configuration remains the primary worktree's `.timber.toml`.
There is no automatic migration to AppData. Use TOML literal single-quoted
strings for Windows paths, or escape backslashes in basic double-quoted strings.

Private Arena/task/base/workflow metadata and saved credentials use Windows ACL
checks instead of emulated POSIX mode bits. New private objects grant access
only to the current account, SYSTEM and Administrators. Existing unsafe ACLs,
unexpected owners, symlinks/junctions and unsupported ACL operations are refused;
Timber does not silently loosen or repair existing private storage. ACL policy
or endpoint controls can therefore produce a retained-workspace failure that
requires inspection. Do not include credential/task files in diagnostic reports.

Hooks remain **trusted POSIX shell source**, including on PowerShell invocations.
Timber locates `sh.exe` from the Git for Windows installation and passes
`["-c", configuredSource]` literally, with closed stdin and worktree cwd.
It does not reinterpret source as PowerShell or fall back to another shell.
Each step has a separate shell. Context is inherited through `TIMBER_REPO`,
`TIMBER_WORKTREE`, `TIMBER_BRANCH`, `TIMBER_TASK_ID` and applicable workflow/Arena
environment variables, never inserted into source. Hook programs such as package
managers remain your responsibility. Explicit `open --setup` reruns all steps.
Hook failure retains side effects and blocks subsequent launches/removal.

Editors and agents use native executable launches with literal argument arrays.
PATHEXT lookup recognizes installed names. `.cmd`, `.bat` and direct `.ps1`
commands are refused because they require a command interpreter. For example,
configure the actual `Code.exe` path rather than VS Code's `code.cmd` shim.
Native coding-assistant `.exe` installations can launch directly. npm shims are
not supported directly. An explicit PowerShell wrapper can be configured as:

```toml
[agent]
command = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
args = ['-NoLogo', '-NoProfile', '-File', 'C:\Tools\my-agent-wrapper.ps1']
enabled = false
```

Wrapper scripts own their tool invocation and argument forwarding. Timber adds
the worktree path to editor arguments, never ordinary agent arguments. Agent
launches remain foreground and interactive, with CI disabled. No real tool or
model compatibility is established by the synthetic fixtures. Orca editor-owned
terminals remain Linux x86_64 only and have no Windows fallback.

Retry diagnostics on Windows use PowerShell literal quoting. File/ref preservation,
keep options, primary/identity/operation protections and explicit discard rules
remain the [CLI contract](cli-contract.md). Rebase shares the Windows console for
Ctrl-C. Process-directed cancellation terminates only the owned Git child tree
using the OS `taskkill /PID <owned-pid> /T /F`; inspect retained Git state and
locks before explicit recovery. Timber never automatically aborts or resets.

## Interactive acceptance still required

Use disposable repositories and synthetic tasks. Record exact commands, numeric
exit statuses, files/refs/worktree inventory before and after failures, and the
OS/shell/Git versions for every exercise.

1. Run `timber setup --global` outside Git and `timber setup` from a linked
   checkout. Exercise arrows, Enter, Escape, Ctrl-C, EOF, Unicode/backspace,
   multiline paste rejection and masked synthetic token input. Cancel must write
   nothing and restore terminal input mode. Save must preserve unrelated settings
   and publish only the intended config/credential changes.
2. Configure a native executable or a PowerShell `-File` wrapper that records
   cwd and argv to a synthetic capture file, then exits 7. Run
   `timber open <path> --agent --no-editor` with CI unset. Confirm literal spaces,
   Unicode, quotes and dollar signs, inherited terminal I/O, exit 7 and retained
   files/refs. Repeat with missing executable, a rejected `.cmd` shim, exit 0 and
   Ctrl-C. A console interrupt should return 130 without a duplicate interrupt.
3. Repeat foreground launches through Arena new and resume with a configured
   wrapper preset and identical synthetic task snapshots. Confirm recorded
   outcomes, explicit setup retry, changed-preset refusal and no implicit replay.
4. Run a rebase with a long-running native Git hook and interrupt it with Ctrl-C.
   Exercise process-directed cancellation where available. Confirm hook
   descendants terminate, unrelated processes survive, native recovery state is
   retained and `done` refuses any in-progress operation. Resolve/continue and
   abort explicitly in separate fixtures.
5. Exercise failing `pre_delete` hooks, locked/stale registrations, changed refs,
   changed ACLs, malformed Arena/base/workflow metadata, and publication network
   failures. Confirm local work remains intact. Test explicit interactive discard
   separately, including its default-No response and enforced keep options.

## Evidence ledger

| Evidence | Status |
| --- | --- |
| Native OS/build, architecture, PowerShell and Git versions | Pending owner run |
| Source typecheck and focused Windows tests | Not run |
| Windows build, metadata and checksums | Not run |
| Native automated standalone workflows | Not run |
| Interactive setup, launch and cancellation checks | Not run |
| Actual downloaded release assets on a machine without Bun/Node installed | Not run |
| Linux regression suite/build/container checks | Not run for this change |
| Independent code review | Pending |
| Tag creation and release publication | Not authorized |

CI is prepared to execute focused native Windows source tests and the automated
PowerShell acceptance group. Tagged release builds require Linux and Windows
candidate jobs, attach six platform assets to an owner-triggered draft, and test
the downloaded Windows executable on Windows. These workflows have not been run.
Hosted-runner evidence does not remove the clean-machine or interactive gates.
