param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $Root,
  [Parameter(Position = 1)]
  [string] $OutputPath
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Refusing to run as a Windows administrator.'
}
$rootMatch = [regex]::Match($Root, '^\\\\wsl\.localhost\\([^\\]+)\\var\\lib\\(beady-eye-seal-test\.[A-Za-z0-9]{8})$')
if (-not $rootMatch.Success) {
  throw 'Root must be the canonical WSL UNC path to the documented staged fixture.'
}
$distro = $rootMatch.Groups[1].Value
$leaf = $rootMatch.Groups[2].Value
$sharePrefix = "\\wsl.localhost\$distro\"
if (-not $OutputPath) {
  $OutputPath = "${sharePrefix}tmp\beady-eye-seal-windows-$([guid]::NewGuid().ToString('N'))"
}
$outputPattern = '^' + [regex]::Escape("${sharePrefix}tmp\beady-eye-seal-windows-") + '[A-Za-z0-9]+$'
if ($OutputPath -notmatch $outputPattern) {
  throw 'Output must be a unique direct child of /tmp on the same WSL share.'
}
if (Test-Path -LiteralPath $OutputPath) { throw 'Output path already exists.' }
$wsl = Join-Path $env:WINDIR 'System32\wsl.exe'
$outputLinuxPath = "/tmp/$([IO.Path]::GetFileName($OutputPath))"
$deviceInfo = & $wsl --distribution $distro --exec /usr/bin/stat -c '%d' -- "/var/lib/$leaf" /tmp 2>&1
if ($LASTEXITCODE -ne 0 -or @($deviceInfo).Count -ne 2 -or $deviceInfo[0] -ne $deviceInfo[1]) {
  throw "Could not establish a shared WSL filesystem for the fixture and private output: $($deviceInfo -join ' ')"
}
$ordinaryWslUid = (& $wsl --distribution $distro --exec /usr/bin/id -u 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $ordinaryWslUid -notmatch '^\d+$') {
  throw "Could not establish the ordinary WSL output owner: '$ordinaryWslUid'."
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class EvidenceSealToken {
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, UInt32 access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int length, out int returned);
  public static int ElevationType() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      int value, returned;
      if (!GetTokenInformation(token, 18, out value, sizeof(int), out returned)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return value;
    } finally { CloseHandle(token); }
  }
}
'@
$elevationType = [EvidenceSealToken]::ElevationType()
if ($elevationType -eq 2 -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Windows token is elevated or administrative (elevation type $elevationType)."
}
if ($elevationType -notin @(1, 3)) {
  throw "Windows token elevation type is ambiguous: $elevationType."
}

$project = Join-Path $Root 'project'
$evidence = Join-Path $project 'evidence'
$receipt = Join-Path $evidence 'receipt.txt'
$manifest = Join-Path $Root 'manifest.json'
$expectedText = "Invented sealed evidence only.`n"
$sha = [Security.Cryptography.SHA256]::Create()
$expectedHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($expectedText))).Replace('-', '').ToLowerInvariant()
$sha.Dispose()
$expectedManifest = "{`"version`":1,`"project`":`"/var/lib/$leaf/project`",`"files`":{`"evidence/receipt.txt`":`"$expectedHash`"}}`n"

foreach ($directory in @($Root, $project, $evidence)) {
  $item = Get-Item -LiteralPath $directory -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Expected a real directory: $directory"
  }
}
foreach ($file in @($receipt, $manifest)) {
  $item = Get-Item -LiteralPath $file -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Expected a regular file: $file"
  }
}
$utf8 = [Text.UTF8Encoding]::new($false)
function Test-ExactBytes([string] $Path, [byte[]] $Expected) {
  $actual = [IO.File]::ReadAllBytes($Path)
  return $actual.Length -eq $Expected.Length -and
    [Convert]::ToBase64String($actual) -ceq [Convert]::ToBase64String($Expected)
}
if (-not (Test-ExactBytes $receipt ($utf8.GetBytes($expectedText)))) {
  throw 'Receipt bytes do not match the invented fixture.'
}
if (-not (Test-ExactBytes $manifest ($utf8.GetBytes($expectedManifest)))) {
  throw 'Manifest bytes do not match the exact staged contract.'
}

$shapeOutput = & $wsl --distribution $distro --exec /usr/bin/stat -c '%F:%u:%a' -- /var/lib "/var/lib/$leaf" "/var/lib/$leaf/project" "/var/lib/$leaf/project/evidence" "/var/lib/$leaf/project/evidence/receipt.txt" "/var/lib/$leaf/manifest.json" 2>&1
$expectedShape = @('directory:0:755', 'directory:0:755', 'directory:0:755', 'directory:0:755', 'regular file:0:644', 'regular file:0:644')
if ($LASTEXITCODE -ne 0 -or @($shapeOutput).Count -ne $expectedShape.Count) {
  throw "Could not verify exact staged ownership and shape: $($shapeOutput -join ' ')"
}
for ($i = 0; $i -lt $expectedShape.Count; $i++) {
  if ($shapeOutput[$i] -cne $expectedShape[$i]) {
    throw "Unexpected staged type, owner, or mode at shape item ${i}: $($shapeOutput[$i])"
  }
}
$flags = & $wsl --distribution $distro --exec /usr/bin/lsattr -d -- "/var/lib/$leaf/project/evidence/receipt.txt" "/var/lib/$leaf/manifest.json" 2>&1
if ($LASTEXITCODE -ne 0 -or @($flags).Count -ne 2 -or @($flags | Where-Object { $_ -notmatch '^----i[-A-Za-z]*\s' }).Count -ne 0) {
  throw "Both exact files must show immutable flags before probing: $($flags -join ' ')"
}

$mkdirResult = & $wsl --distribution $distro --exec /usr/bin/mkdir -m 700 -- $outputLinuxPath 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Could not create private WSL output directory: $($mkdirResult -join ' ')"
}
$outputInfo = & $wsl --distribution $distro --exec /usr/bin/stat -c '%d:%a:%u' -- $outputLinuxPath 2>&1
if ($LASTEXITCODE -ne 0 -or $outputInfo -cne "$($deviceInfo[0]):700:$ordinaryWslUid") {
  throw "Private output directory verification failed: $($outputInfo -join ' ')"
}

$checks = [Collections.Generic.List[object]]::new()
$ambiguousChecks = [Collections.Generic.List[string]]::new()
$writeFile = Join-Path $OutputPath 'replacement.txt'
$scratch = Join-Path $OutputPath 'scratch'
New-Item -ItemType Directory -Path $scratch | Out-Null
[IO.File]::WriteAllText($writeFile, "replacement`n", $utf8)

function Save-Receipt([bool] $Passed, [string] $Failure = '') {
  $result = [ordered]@{
    version = 1
    platform = 'Windows'
    identity = $identity.Name
    administrator = $false
    elevationType = $elevationType
    root = $Root
    output = $OutputPath
    checks = @($checks)
    controls = @{ ordinaryRead = $false; writableScratch = $false }
    originalBytesUnchanged = $false
    passed = $Passed
  }
  if ($Failure) { $result.failure = $Failure }
  $json = $result | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText((Join-Path $OutputPath 'receipt.json'), $json + "`n", $utf8)
  $json
}

function Expect-Denied([string] $Name, [scriptblock] $Operation, [scriptblock] $NoOpCheck = $null) {
  try {
    & $Operation
  } catch {
    $exception = $_.Exception
    $caughtException = $exception
    $denied = $false
    $deniedException = $null
    while ($exception) {
      if ($exception.HResult -eq -2147024891) {
        $denied = $true
        $deniedException = $exception
        break
      }
      $exception = $exception.InnerException
    }
    if ($denied) {
      $checks.Add(@{ name = $Name; result = 'denied'; hresult = $deniedException.HResult })
      return
    }
    $checks.Add(@{
      name = $Name
      result = 'ambiguous'
      exception = $caughtException.GetType().FullName
      hresult = $caughtException.HResult
      message = $caughtException.Message
    })
    $ambiguousChecks.Add($Name)
    return
  }
  if ($NoOpCheck -and (& $NoOpCheck)) {
    $checks.Add(@{ name = $Name; result = 'ambiguous-no-op' })
    $ambiguousChecks.Add($Name)
    return
  }
  $checks.Add(@{ name = $Name; result = 'unexpected-success' })
  Save-Receipt $false "$Name unexpectedly succeeded; stop and preserve evidence."
  exit 1
}

foreach ($file in @($receipt, $manifest)) {
  $name = [IO.Path]::GetFileName($file)
  Expect-Denied "write-open:$name" {
    $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $stream.Dispose()
  }
  $originalBytes = if ($name -eq 'receipt.txt') { $utf8.GetBytes($expectedText) } else { $utf8.GetBytes($expectedManifest) }
  Expect-Denied "rename-replacement:$name" {
    [IO.File]::Replace($writeFile, $file, $null)
  } {
    (Test-ExactBytes $file $originalBytes) -and (Test-ExactBytes $writeFile ($utf8.GetBytes("replacement`n")))
  }
  Expect-Denied "delete:$name" { Remove-Item -LiteralPath $file -Force } {
    (Test-Path -LiteralPath $file) -and (Test-ExactBytes $file $originalBytes)
  }
}
Expect-Denied 'replace-project-parent' { Move-Item -LiteralPath $project -Destination (Join-Path $Root 'project.replacement') -Force } {
  (Test-Path -LiteralPath $project) -and -not (Test-Path -LiteralPath (Join-Path $Root 'project.replacement'))
}
Expect-Denied 'replace-evidence-parent' { Move-Item -LiteralPath $evidence -Destination (Join-Path $project 'evidence.replacement') -Force } {
  (Test-Path -LiteralPath $evidence) -and -not (Test-Path -LiteralPath (Join-Path $project 'evidence.replacement'))
}

if (-not (Test-ExactBytes $receipt ($utf8.GetBytes($expectedText))) -or
    -not (Test-ExactBytes $manifest ($utf8.GetBytes($expectedManifest)))) {
  Save-Receipt $false 'Original fixture bytes changed.'
  exit 1
}
$finalFlags = & $wsl --distribution $distro --exec /usr/bin/lsattr -d -- "/var/lib/$leaf/project/evidence/receipt.txt" "/var/lib/$leaf/manifest.json" 2>&1
if ($LASTEXITCODE -ne 0 -or @($finalFlags).Count -ne 2 -or @($finalFlags | Where-Object { $_ -notmatch '^----i[-A-Za-z]*\s' }).Count -ne 0) {
  Save-Receipt $false "Immutable flag verification failed at end: $($finalFlags -join ' ')"
  exit 1
}
$scratchFile = Join-Path $scratch 'positive-control.txt'
[IO.File]::WriteAllText($scratchFile, "ordinary scratch write succeeded`n", $utf8)
if ([IO.File]::ReadAllText($scratchFile, $utf8) -ne "ordinary scratch write succeeded`n" -or
    [IO.File]::ReadAllText($receipt, $utf8) -ne $expectedText) {
  Save-Receipt $false 'Ordinary read or writable scratch control failed.'
  exit 1
}
$result = [ordered]@{
  version = 1
  platform = 'Windows'
  identity = $identity.Name
  administrator = $false
  elevationType = $elevationType
  root = $Root
  output = $OutputPath
  checks = @($checks)
  controls = @{ ordinaryRead = $true; writableScratch = $true }
  originalBytesUnchanged = $true
  passed = ($ambiguousChecks.Count -eq 0)
}
if ($ambiguousChecks.Count -gt 0) {
  $result.failure = "Ambiguous results: $($ambiguousChecks -join ', ')"
}
$json = $result | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $OutputPath 'receipt.json'), $json + "`n", $utf8)
$json
if ($ambiguousChecks.Count -gt 0) { exit 1 }
