# Timber on Windows

Timber's Windows x64 executable requires Git for Windows on PATH. Bun and Node are not
required to run it. Use PowerShell and local NTFS storage. Windows ARM, WSL,
network shares, and case-sensitive Windows directories are outside this scope.

Windows support is provisional: release builds pass automated Windows checks, but
clean-machine and interactive testing is still in progress.

## Install

Install [Git for Windows](https://git-scm.com/download/win) first. Then paste this
block into PowerShell. It downloads the latest Windows release, checks it against
the published SHA-256 checksum, runs it once, and only then copies it to
`%LOCALAPPDATA%\Programs\Timber\timber.exe`. If any step fails, nothing is
installed or replaced. It does not need administrator rights.

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $release = 'https://github.com/Coding-M8s/timber/releases/latest/download'
  $installDir = Join-Path $env:LOCALAPPDATA 'Programs\Timber'
  $temp = Join-Path ([IO.Path]::GetTempPath()) ('timber-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    Invoke-WebRequest -UseBasicParsing "$release/SHA256SUMS-windows-x64" -OutFile "$temp\SHA256SUMS"
    $entry = Get-Content "$temp\SHA256SUMS" | Where-Object { $_ -match '^[a-f0-9]{64}  timber-v\S+-windows-x64\.exe$' } | Select-Object -First 1
    if (-not $entry) { throw 'The release has no Windows executable. Nothing was installed.' }
    $hash, $name = $entry -split '  '
    Invoke-WebRequest -UseBasicParsing "$release/$name" -OutFile "$temp\timber.exe"
    if ((Get-FileHash "$temp\timber.exe" -Algorithm SHA256).Hash -ne $hash) { throw 'Checksum mismatch. Nothing was installed.' }
    & "$temp\timber.exe" --version
    if ($LASTEXITCODE -ne 0) { throw 'The download did not run. Nothing was installed.' }
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    try { Copy-Item "$temp\timber.exe" (Join-Path $installDir 'timber.exe') -Force }
    catch { throw 'Could not replace timber.exe. Close any running timber commands and try again.' }
    Write-Output "Installed $name to $installDir\timber.exe"
  } finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
```

The first time only, add the install folder to your user PATH. This is safe to
run again; it changes nothing if the folder is already there.

```powershell
& {
  $installDir = Join-Path $env:LOCALAPPDATA 'Programs\Timber'
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $installDir) {
    [Environment]::SetEnvironmentVariable('Path', (@($userPath, $installDir) | Where-Object { $_ }) -join ';', 'User')
  }
}
```

If you prefer to edit PATH by hand, search the Start menu for "Edit environment
variables for your account" and add `%LOCALAPPDATA%\Programs\Timber` to `Path`.

Open a new PowerShell window so it picks up the new PATH, then run:

```powershell
timber --version
timber setup --global
```

To install a specific release instead of the latest, change the `$release` line
to name its tag, for example
`'https://github.com/Coding-M8s/timber/releases/download/v0.2.0'`.

## Update

`timber update` is not available on Windows, and Windows does not show the
"Update available" notice. To see whether a newer release exists, run:

```powershell
timber update --check
```

To update, close any running `timber` commands (including agent sessions it
started) and paste the install block above again. It replaces `timber.exe` in
place; you do not need to repeat the PATH step. A failed update leaves your
current version in place.

## Uninstall

`timber uninstall` is not available on Windows, because a running `.exe` cannot
delete itself. Remove Timber by hand instead: delete
`%LOCALAPPDATA%\Programs\Timber` and remove that folder from your user `Path`.
To also remove settings and saved credentials, see the
[manual removal table](guide.md#manual-removal).

## Build from source

To try a local build, run these commands from the source checkout with Bun 1.4.5:

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
