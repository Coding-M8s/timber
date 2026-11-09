[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Directory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$directoryPath = (Resolve-Path -LiteralPath $Directory).Path
$info = Get-Content -LiteralPath (Join-Path $directoryPath 'build-info-windows-x64.json') -Raw | ConvertFrom-Json
if ($info.target -cne 'bun-windows-x64' -or $info.version -notmatch '^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$') { throw 'Invalid Windows build metadata.' }
$expected = @('build-info-windows-x64.json', ('timber-v' + $info.version + '-windows-x64.exe'), 'LICENSE', 'THIRD_PARTY_NOTICES.txt')
$seen = @()
foreach ($line in Get-Content -LiteralPath (Join-Path $directoryPath 'SHA256SUMS-windows-x64')) {
    if ($line -cnotmatch '^([a-f0-9]{64})  ([^/\\]+)$') { throw 'Malformed Windows checksum manifest.' }
    $digest = $Matches[1]
    $name = $Matches[2]
    if ($name -cnotin $expected -or $name -cin $seen) { throw 'Unexpected or duplicate checksum entry.' }
    $actual = (Get-FileHash -LiteralPath (Join-Path $directoryPath $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $digest) { throw ('Checksum mismatch: ' + $name) }
    $seen += $name
    Write-Output ($name + ': OK')
}
if ($seen.Count -ne $expected.Count) { throw 'Windows checksum manifest is incomplete.' }
