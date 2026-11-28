import type { Stats } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { assertWindowsPrivateAcl } from "./windows-acl";

/** PowerShell applied via -EncodedCommand so paths and newlines stay literal. */
const aclScript = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:TIMBER_PRIVATE_PATH
$item = Get-Item -LiteralPath $path -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Redirected private storage' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
function Assert-PrivateAcl([System.Security.AccessControl.FileSystemSecurity]$acl) {
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unexpected owner' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value) { throw 'Nonprivate ACL' }
  }
}
if ($env:TIMBER_PRIVATE_ACTION -eq 'create') {
  $acl = Get-Acl -LiteralPath $path
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
    $root = $(if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' })
    $takeown = Join-Path $root 'System32\takeown.exe'
    & $takeown /F $path | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "takeown exit $LASTEXITCODE" }
    $acl = Get-Acl -LiteralPath $path
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  # Publish the complete ACL once; an intermediate empty DACL locks out the owner.
  foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
    [void]$acl.RemoveAccessRule($rule)
  }
  foreach ($identity in $trusted) {
    $principal = New-Object Security.Principal.SecurityIdentifier($identity)
    if ($item.PSIsContainer) {
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'Allow')
    }
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
}
Assert-PrivateAcl (Get-Acl -LiteralPath $path)
`;

const windowsStorageMessage = "Cannot establish private Windows storage. Use an NTFS directory owned by your account with access limited to you, SYSTEM and Administrators; inspect its ACL privately before retrying.";

/** Read checks run in process; only creating private storage starts PowerShell. */
async function windowsReadACL(path: string): Promise<void> {
  try { await assertWindowsPrivateAcl(path); }
  catch (error) { throw new Error(`${windowsStorageMessage} ${(error as Error).message}`); }
}

/** Set the private owner and ACL on new storage, then check it in the same script. */
async function windowsCreateACL(path: string): Promise<void> {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(aclScript, "utf16le").toString("base64");
  try {
    await execa(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdin: "ignore",
      // Hosted Windows runners can take longer than ten seconds to cold-start
      // Windows PowerShell while several test processes are active.
      timeout: 30_000,
      extendEnv: true,
      // PowerShell 7's inherited modules cannot load in Windows PowerShell 5.1.
      env: { TIMBER_PRIVATE_PATH: path, TIMBER_PRIVATE_ACTION: "create", PSModulePath: join(dirname(powershell), "Modules") },
    });
  } catch (error) {
    const detail = typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr: unknown }).stderr).trim()
      : "";
    throw new Error(windowsStorageMessage + (detail ? ` ${detail}` : ""));
  }
}

/** Never weaken POSIX permissions to accommodate Windows mode emulation. */
export async function assertPrivateStorage(path: string, info: Stats, directory: boolean): Promise<void> {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new Error("Private storage must be a regular file or directory, never a link.");
  }
  if (process.platform === "win32") await windowsReadACL(path);
  else if ((info.mode & 0o077) !== 0) throw new Error("Private storage permissions must exclude other users.");
}

/** Only call for a new, empty, exclusively created object before writing bytes. */
export async function protectNewStorage(path: string): Promise<void> {
  if (process.platform === "win32") await windowsCreateACL(path);
}

export async function privateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    await protectNewStorage(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertPrivateStorage(path, await lstat(path), true);
}
