# Timber on Windows

Timber's Windows x64 executable requires Git for Windows on PATH. Bun and Node are not
required to run it. Use PowerShell and local NTFS storage. Windows ARM, WSL,
network shares, and case-sensitive Windows directories are outside this scope.

## Install

Download `timber-v<VERSION>-windows-x64.exe` from the
[releases page](https://github.com/Coding-M8s/timber/releases) when a Windows
asset is available. Rename it to `timber.exe` and place it in
`%LOCALAPPDATA%\Programs\Timber`. Add that directory to your user PATH, then open
PowerShell and run:

```powershell
timber --version
timber setup --global
```

To try a local build, run these commands from the source checkout with Bun 1.4.2:

```powershell
bun install --frozen-lockfile
bun run build:release --target windows-x64
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Timber'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Copy-Item "dist/release/timber-v$version-windows-x64.exe" (Join-Path $installDir 'timber.exe') -Force
$env:PATH = "$installDir;$env:PATH"
timber --version
```

Check that the build succeeds before copying. This PATH change lasts only for
the current session; add the directory to your user PATH for future terminals.
See [building and releasing](releases.md) for checksums and release tooling.

## Everyday use

Inside a Git repository:

```powershell
timber setup
timber new windows-test --no-editor --no-agent
timber ls
timber open windows-test --no-editor --no-agent
```

`new` uses your configured base branch. You can select one explicitly with
`--base <branch>`. `done windows-test` removes an eligible linked worktree and
its branch; commit or preserve any work you want to keep first. See the
[CLI contract](cli-contract.md) for cleanup rules.

## Configuration and tools

Configuration defaults to `%USERPROFILE%\.config\timber\config.toml`.
Absolute `XDG_CONFIG_HOME` overrides it; an explicit `HOME` takes precedence
over `USERPROFILE`. Repository settings live in `.timber.toml` in the primary
worktree. Use TOML single-quoted strings for Windows paths.

Hooks use the POSIX `sh.exe` supplied by Git for Windows, even when Timber runs
from PowerShell. Hook commands are shell source and are not PowerShell scripts.
Install any tools your hooks invoke separately.

Editors and agents must use native executables, such as `Code.exe` rather than
`code.cmd`. Direct `.cmd`, `.bat`, and `.ps1` launchers are not supported. To run
a PowerShell wrapper, configure the interpreter explicitly:

```toml
[agent]
command = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
args = ['-NoLogo', '-NoProfile', '-File', 'C:\Tools\my-agent-wrapper.ps1']
enabled = false
```

Agents run in the invoking terminal. Orca editor-owned terminals are Linux-only.
Keep Windows PowerShell installed: Timber uses it to protect private metadata
and saved credentials with Windows ACLs. Existing unsafe permissions are refused
rather than silently changed.

## Uninstall

The `timber uninstall` command is not available on Windows. Delete `timber.exe`, remove its PATH entry, and follow the [manual removal table](guide.md#manual-removal).
