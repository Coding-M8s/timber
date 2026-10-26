# Native Windows acceptance. This file is prepared for later operator execution.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Binary,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [switch]$RequireNoRuntime,
    [string]$EvidencePath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'Run this verifier in native 64-bit Windows PowerShell or PowerShell 7, not WSL.'
}
$binaryPath = (Resolve-Path -LiteralPath $Binary).Path
if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) { throw 'Release binary is missing.' }
$gitPath = (Get-Command git.exe -CommandType Application -ErrorAction Stop).Source
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$lab = Join-Path ([IO.Path]::GetTempPath()) ('timber Windows ' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $lab
$checks = New-Object 'Collections.Generic.List[string]'

function Assert-That([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

# ProcessStartInfo.Arguments uses Windows argv quoting, never shell evaluation.
# This also works in Windows PowerShell 5.1, without ArgumentList support.
function Quote-Argument([string]$Value) {
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

$childEnv = @{}
foreach ($item in Get-ChildItem Env:) {
    if ($item.Name -notmatch '^(GIT_|JIRA_|TIMBER_|BUN_)' -and $item.Name -notin @('NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'GH_TOKEN', 'GITHUB_TOKEN')) {
        $childEnv[$item.Name] = $item.Value
    }
}
$homePath = Join-Path $lab 'home'
$null = New-Item -ItemType Directory -Path $homePath
$templates = Join-Path $lab 'empty-template'
$null = New-Item -ItemType Directory -Path $templates
$childEnv.HOME = $homePath
$childEnv.USERPROFILE = $homePath
$childEnv.XDG_CONFIG_HOME = Join-Path $homePath '.config'
$childEnv.XDG_STATE_HOME = Join-Path $homePath '.local\state'
$childEnv.CI = 'true'
$childEnv.GIT_CONFIG_NOSYSTEM = '1'
$childEnv.GIT_CONFIG_GLOBAL = Join-Path $lab 'empty.gitconfig'
[IO.File]::WriteAllText($childEnv.GIT_CONFIG_GLOBAL, '')
$childEnv.GIT_TEMPLATE_DIR = $templates
$childEnv.GIT_OPTIONAL_LOCKS = '0'
$childEnv.GIT_TERMINAL_PROMPT = '0'
$childEnv.GIT_AUTHOR_NAME = 'Timber Windows Fixture'
$childEnv.GIT_COMMITTER_NAME = 'Timber Windows Fixture'
$childEnv.GIT_AUTHOR_EMAIL = 'windows@example.invalid'
$childEnv.GIT_COMMITTER_EMAIL = 'windows@example.invalid'
# Restrict discovery to Git and OS tools. This proves no runtime is reachable by
# this process; it does not claim hosted runners have no runtimes installed.
$childEnv.PATH = ((Split-Path -Parent $gitPath), (Split-Path -Parent $powershellPath), (Join-Path $env:SystemRoot 'System32'), $env:SystemRoot) -join ';'

function Invoke-Fixture([string]$Executable, [string[]]$Arguments, [string]$Directory = $lab, [int]$ExpectedExit = 0) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = (($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' ')
    $start.WorkingDirectory = $Directory
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $start.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $start.EnvironmentVariables.Clear()
    foreach ($key in $childEnv.Keys) { $start.EnvironmentVariables[$key] = $childEnv[$key] }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        $null = $process.Start()
        $process.StandardInput.Close()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(90000)) {
            $process.Kill()
            throw 'Fixture timed out; inspect the retained temporary repository.'
        }
        $result = [pscustomobject]@{ Code = $process.ExitCode; Out = $stdout.Result; Err = $stderr.Result }
        Assert-That ($result.Code -eq $ExpectedExit) ('Unexpected exit ' + $result.Code + ', expected ' + $ExpectedExit + ': ' + $result.Err)
        return $result
    } finally { $process.Dispose() }
}

$primary = Join-Path $lab 'primary repo'
$trees = Join-Path $lab 'primary repo-worktrees'
function Git-Fixture([string[]]$Arguments, [string]$Directory = $primary) {
    return (Invoke-Fixture $gitPath $Arguments $Directory).Out.TrimEnd("`r", "`n")
}
function Timber-Fixture([string[]]$Arguments, [string]$Directory = $primary, [int]$ExpectedExit = 0) {
    return Invoke-Fixture $script:installed $Arguments $Directory $ExpectedExit
}
function Write-Utf8([string]$Path, [string]$Contents) {
    [IO.File]::WriteAllText($Path, $Contents, (New-Object Text.UTF8Encoding($false)))
}
function Snapshot([string]$Tree) {
    $files = @{}
    foreach ($file in Get-ChildItem -LiteralPath $Tree -File -Force -Recurse) {
        if ($file.FullName -notmatch '[\\/]\.git([\\/]|$)') {
            $files[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        }
    }
    return (@{
        Refs = (Git-Fixture @('show-ref'))
        Trees = (Git-Fixture @('worktree', 'list', '--porcelain'))
        Files = ($files.GetEnumerator() | Sort-Object Name | ForEach-Object { $_.Key + ':' + $_.Value }) -join "`n"
    } | ConvertTo-Json -Compress)
}
function Refuses-Unchanged([string[]]$Arguments, [string]$Tree) {
    $before = Snapshot $Tree
    $null = Timber-Fixture $Arguments -ExpectedExit 1
    Assert-That ((Snapshot $Tree) -ceq $before) 'Refusal changed files, refs or worktree registration.'
}

try {
    if ($RequireNoRuntime) {
        foreach ($name in @('bun.exe', 'node.exe', 'npm.cmd')) {
            $probe = Invoke-Fixture (Join-Path $env:SystemRoot 'System32\where.exe') @($name) -ExpectedExit 1
            Assert-That ([string]::IsNullOrWhiteSpace($probe.Out)) 'External JavaScript runtime is discoverable.'
        }
    }
    $relocated = Join-Path $lab ('installed ' + [char]0x00c9 + 'quipe with spaces')
    $null = New-Item -ItemType Directory -Path $relocated
    $script:installed = Join-Path $relocated 'timber.exe'
    Copy-Item -LiteralPath $binaryPath -Destination $installed
    $version = Timber-Fixture @('--version') $lab
    Assert-That ($version.Out.Trim() -ceq $ExpectedVersion) 'Version mismatch.'
    Assert-That (Test-Path -LiteralPath (Join-Path $childEnv.XDG_STATE_HOME 'timber\setup-hint-shown')) 'First-use marker missing.'
    foreach ($command in @('setup', 'new', 'open', 'ls', 'rebase', 'done', 'arena')) {
        $help = Timber-Fixture @($command, '--help') $lab
        Assert-That ($help.Out -match 'Usage: timber') 'Help output missing.'
    }
    $null = Timber-Fixture @('setup', '--global') $lab -ExpectedExit 1
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $childEnv.XDG_CONFIG_HOME 'timber\config.toml'))) 'Unattended setup wrote config.'
    $checks.Add('version, relocation, help, first-use marker and noninteractive setup')

    $null = New-Item -ItemType Directory -Path $primary
    $null = Git-Fixture @('init', '-b', 'main')
    $null = Git-Fixture @('config', 'core.autocrlf', 'false')
    Write-Utf8 (Join-Path $primary 'tracked.txt') "original`n"
    Write-Utf8 (Join-Path $primary '.gitignore') ".timber.toml`n.env`n"
    $null = Git-Fixture @('add', '.')
    $null = Git-Fixture @('commit', '-m', 'synthetic native Windows fixture')
    $null = Timber-Fixture @('new', 'core', '--base', 'main', '--no-editor', '--no-agent')
    $core = Join-Path $trees 'core'
    $null = Timber-Fixture @('open', $core.Replace('\', '/'), '--no-editor', '--no-agent')
    $null = New-Item -ItemType Directory -Path (Join-Path $core 'nested')
    $null = Timber-Fixture @('ls') (Join-Path $core 'nested')
    Refuses-Unchanged @('done', $primary) $primary
    Write-Utf8 (Join-Path $core 'tracked.txt') "local work`n"
    Write-Utf8 (Join-Path $core 'untracked.txt') "untracked work`n"
    Refuses-Unchanged @('done', 'core') $core
    $checks.Add('new, open with slash aliases, nested linked discovery, primary and dirty cleanup refusals')

    $null = Timber-Fixture @('new', 'Topic', '--base', 'main', '--no-editor', '--no-agent')
    Refuses-Unchanged @('new', 'topic', '--base', 'main', '--no-editor', '--no-agent') (Join-Path $trees 'Topic')
    Refuses-Unchanged @('new', 'CON', '--base', 'main', '--no-editor', '--no-agent') $primary
    $unicodeRoot = Join-Path $lab ([string][char]0x00c9 + 'quipe workspace')
    Write-Utf8 (Join-Path $primary '.timber.toml') ('base_branch = "main"' + "`nworktree_dir = " + (ConvertTo-Json -InputObject $unicodeRoot -Compress) + "`n")
    $null = Timber-Fixture @('new', 'unicode-path', '--no-editor', '--no-agent')
    $null = Timber-Fixture @('open', (Join-Path $unicodeRoot 'unicode-path'), '--no-editor', '--no-agent')
    Remove-Item -LiteralPath (Join-Path $primary '.timber.toml')
    $checks.Add('Unicode, spaces, reserved filenames and case-insensitive collision preservation')

    # Rebase actual commits, then verify a conflict leaves native Git state intact.
    $null = Timber-Fixture @('new', 'rebased', '--base', 'main', '--no-editor', '--no-agent')
    $rebased = Join-Path $trees 'rebased'
    Write-Utf8 (Join-Path $rebased 'feature.txt') "feature`n"
    $null = Git-Fixture @('add', '.') $rebased
    $null = Git-Fixture @('commit', '-m', 'feature') $rebased
    Write-Utf8 (Join-Path $primary 'base.txt') "base`n"
    $null = Git-Fixture @('add', '.')
    $null = Git-Fixture @('commit', '-m', 'base progress')
    $null = Timber-Fixture @('rebase', 'rebased', '--base', 'refs/heads/main')
    $null = Git-Fixture @('merge-base', '--is-ancestor', 'main', 'rebased')
    $null = Timber-Fixture @('new', 'conflict', '--base', 'main', '--no-editor', '--no-agent')
    $conflict = Join-Path $trees 'conflict'
    Write-Utf8 (Join-Path $conflict 'tracked.txt') "feature conflict`n"
    $null = Git-Fixture @('add', '.') $conflict
    $null = Git-Fixture @('commit', '-m', 'feature conflict') $conflict
    $originalTip = Git-Fixture @('rev-parse', 'refs/heads/conflict')
    Write-Utf8 (Join-Path $primary 'tracked.txt') "base conflict`n"
    $null = Git-Fixture @('add', '.')
    $null = Git-Fixture @('commit', '-m', 'base conflict')
    $null = Timber-Fixture @('rebase', 'conflict', '--base', 'refs/heads/main') -ExpectedExit 1
    Assert-That (-not [string]::IsNullOrWhiteSpace((Git-Fixture @('ls-files', '-u') $conflict))) 'Rebase did not retain conflict state.'
    Assert-That ((Git-Fixture @('rev-parse', 'refs/heads/conflict')) -ceq $originalTip) 'Conflict moved the original branch ref.'
    Refuses-Unchanged @('done', 'conflict') $conflict
    $null = Git-Fixture @('-c', 'core.editor=true', 'rebase', '--abort') $conflict
    Assert-That ((Git-Fixture @('rev-parse', 'HEAD') $conflict) -ceq $originalTip) 'Explicit native abort failed to restore the original tip.'
    $checks.Add('local-base rebase, conflicts, operation refusal and explicit native abort')

    $null = Timber-Fixture @('new', 'clean', '--base', 'main', '--no-editor', '--no-agent')
    $clean = Join-Path $trees 'clean'
    Write-Utf8 (Join-Path $clean '.env') "synthetic disposable ignored file`n"
    Refuses-Unchanged @('done', 'clean', '--keep-ignored') $clean
    $null = Timber-Fixture @('done', 'clean')
    Assert-That (-not (Test-Path -LiteralPath $clean)) 'Integrated cleanup did not remove its worktree.'
    $null = Invoke-Fixture $gitPath @('show-ref', '--verify', '--quiet', 'refs/heads/clean') $primary -ExpectedExit 1
    $checks.Add('integrated cleanup, ignored-file retention and default discard')

    $remote = Join-Path $lab 'origin.git'
    $null = Git-Fixture @('init', '--bare', '--initial-branch=main', $remote) $lab
    $null = Git-Fixture @('remote', 'add', 'origin', $remote)
    $null = Git-Fixture @('push', '-u', 'origin', 'main')
    $null = Git-Fixture @('branch', 'remote-only', 'main') $remote
    $null = Timber-Fixture @('open', 'origin/remote-only', '--no-editor', '--no-agent')
    Assert-That ((Git-Fixture @('rev-parse', '--abbrev-ref', 'remote-only@{upstream}')) -ceq 'origin/remote-only') 'Remote materialization lost its upstream.'
    $null = Timber-Fixture @('done', 'remote-only')
    $null = Git-Fixture @('rev-parse', 'remote-only') $remote
    $null = Timber-Fixture @('new', 'published', '--base', 'main', '--no-editor', '--no-agent')
    $published = Join-Path $trees 'published'
    Write-Utf8 (Join-Path $published 'published.txt') "published feature`n"
    $null = Git-Fixture @('add', '.') $published
    $null = Git-Fixture @('commit', '-m', 'published feature') $published
    $null = Git-Fixture @('push', '-u', 'origin', 'published') $published
    $publishedTip = Git-Fixture @('rev-parse', 'HEAD') $published
    $null = Timber-Fixture @('done', 'published')
    Assert-That ((Git-Fixture @('rev-parse', 'published') $remote) -ceq $publishedTip) 'Cleanup changed a remote ref.'
    $null = Timber-Fixture @('new', 'unpublished', '--base', 'main', '--no-editor', '--no-agent')
    $unpublished = Join-Path $trees 'unpublished'
    Write-Utf8 (Join-Path $unpublished 'private.txt') "unpublished commit`n"
    $null = Git-Fixture @('add', '.') $unpublished
    $null = Git-Fixture @('commit', '-m', 'unpublished feature') $unpublished
    Refuses-Unchanged @('done', 'unpublished') $unpublished
    $null = Git-Fixture @('remote', 'set-url', 'origin', (Join-Path $lab 'unavailable.git'))
    $null = Timber-Fixture @('open', 'core', '--no-editor', '--no-agent')
    Refuses-Unchanged @('open', 'origin/missing', '--no-editor', '--no-agent') $primary
    $null = Git-Fixture @('remote', 'set-url', 'origin', $remote)
    $checks.Add('remote materialization, publication, unpublished-commit refusal and offline reopen')

    # POSIX hook source is unchanged; a failed step must retain all side effects.
    Write-Utf8 (Join-Path $primary '.timber.toml') "base_branch = `"main`"`n[hooks]`npost_create = ['printf preserved > hook-file.txt; exit 23']`n"
    $hook = Timber-Fixture @('new', 'hook-failure', '--no-editor', '--no-agent') -ExpectedExit 1
    Assert-That ($hook.Err -match 'exit code 23') 'Hook failure did not identify the exit code.'
    $hookTree = Join-Path $trees 'hook-failure'
    Refuses-Unchanged @('done', 'hook-failure') $hookTree
    Assert-That ([IO.File]::ReadAllText((Join-Path $hookTree 'hook-file.txt')) -ceq 'preserved') 'Hook side effects were lost.'
    Write-Utf8 (Join-Path $primary '.timber.toml') "base_branch = `"main`"`n[hooks]`npost_create = ['printf recovered > recovered.txt']`n"
    $null = Timber-Fixture @('open', 'hook-failure', '--setup', '--no-editor', '--no-agent')
    Assert-That (Test-Path -LiteralPath (Join-Path $hookTree 'recovered.txt')) 'Explicit setup retry did not run.'
    Write-Utf8 (Join-Path $primary '.timber.toml') "base_branch = `"main`"`n[hooks]`npre_delete = ['exit 24']`n"
    $null = Timber-Fixture @('new', 'delete-hook', '--no-editor', '--no-agent')
    Refuses-Unchanged @('done', 'delete-hook') (Join-Path $trees 'delete-hook')
    Write-Utf8 (Join-Path $primary '.timber.toml') "base_branch = `"main`"`n[editor]`ncommand = `"missing-native-editor.exe`"`nenabled = true`n"
    $null = Timber-Fixture @('new', 'editor-failure', '--no-agent') -ExpectedExit 1
    Assert-That (Test-Path -LiteralPath (Join-Path $trees 'editor-failure')) 'Editor failure removed the worktree.'
    $null = Git-Fixture @('show-ref', '--verify', 'refs/heads/editor-failure')
    $checks.Add('Git for Windows POSIX hooks and editor startup failure retention')

    # Prepare two manual Arena attempts, then revisit without invoking an agent.
    Write-Utf8 (Join-Path $primary '.timber.toml') "base_branch = `"main`"`n"
    $null = Timber-Fixture @('arena', 'new', 'native', '--base', 'refs/heads/main', '--prompt', 'Synthetic Windows acceptance task', '--tool', 'manual', '--runs', '2', '--no-agent', '--no-editor')
    $null = Timber-Fixture @('arena', 'resume', 'native', '--attempt', 'manual-1', '--no-agent', '--no-editor')
    $null = Timber-Fixture @('ls')
    $checks.Add('Arena new and resume with private metadata and retained identities')

    $os = Get-CimInstance Win32_OperatingSystem
    $evidence = [ordered]@{
        result = 'passed'; os = $os.Caption; osVersion = $os.Version; osBuild = $os.BuildNumber
        architecture = $env:PROCESSOR_ARCHITECTURE; powershell = $PSVersionTable.PSVersion.ToString()
        git = (Invoke-Fixture $gitPath @('--version')).Out.Trim(); version = $ExpectedVersion
        sha256 = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
        runtimeDiscovery = 'Bun, Node and npm excluded from child PATH'
        runtimeNotInstalled = 'Requires separate clean-machine evidence; this harness does not uninstall tools'
        checks = @($checks.ToArray())
        pendingInteractive = @('setup save/cancel/secret input', 'foreground agent exit and Ctrl-C', 'rebase Ctrl-C including hook descendants')
    }
    $json = $evidence | ConvertTo-Json -Depth 5
    if ($EvidencePath) { Write-Utf8 ([IO.Path]::GetFullPath($EvidencePath)) ($json + "`n") }
    Write-Output $json
    Remove-Item -LiteralPath $lab -Recurse -Force
} catch {
    Write-Error ('Native Windows acceptance failed. Synthetic fixture retained at ' + $lab + '. ' + $_.Exception.Message) -ErrorAction Continue
    exit 1
}
