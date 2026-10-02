$ErrorActionPreference = 'Stop'
# Run only in the disposable Windows CI runner: installer writes normal HKCU
# uninstall entries and shortcuts. Never use this against a user's installation.
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Installer smoke test requires the disposable GitHub Actions runner.' }
$installer = (Get-ChildItem -LiteralPath release -Filter '*Setup-*-x64.exe' | Select-Object -First 1).FullName
$testDirectory = Join-Path $env:RUNNER_TEMP 'bms-installer-smoke'
if (!(Test-Path -LiteralPath $installer)) { throw 'Installer missing' }
function Invoke-Setup([string]$Executable, [string[]]$Arguments) {
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru
  if (!$process.WaitForExit(120000)) {
    Stop-Process -Id $process.Id -Force
    throw "Installer froze: $Executable"
  }
  if ($process.ExitCode -ne 0) { throw "Installer failed with code $($process.ExitCode)" }
}
for ($cycle = 1; $cycle -le 3; $cycle++) {
  # No /currentuser switch: validate the normal default and repeated fresh installs.
  Invoke-Setup $installer @('/S', "/D=$testDirectory")
  $appExe = Join-Path $testDirectory 'BMS to osu!mania Hitsound.exe'
  if (!(Test-Path -LiteralPath $appExe)) { throw 'App not installed into isolated target' }
  $uninstallKey = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\b794b988-a3e6-5747-8f98-84c112f0db27'
  if (!(Test-Path -LiteralPath $uninstallKey)) { throw 'Expected current-user uninstall registration missing' }
  Invoke-Setup (Join-Path $testDirectory 'Uninstall BMS to osu!mania Hitsound.exe') @('/S', "_?=$testDirectory")
  Write-Output "PASS: fresh current-user install/uninstall cycle $cycle"
}
