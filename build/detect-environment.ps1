param([Parameter(Mandatory=$true)][string]$OutputFile, [string]$AppDirectory)
$ErrorActionPreference = 'SilentlyContinue'

function Test-Executable([string]$Executable, [string]$Argument) {
  if (!$Executable) { return $false }
  $probe = New-Object System.Diagnostics.Process
  $probe.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $probe.StartInfo.FileName = $Executable
  $probe.StartInfo.Arguments = $Argument
  $probe.StartInfo.UseShellExecute = $false
  $probe.StartInfo.CreateNoWindow = $true
  $probe.StartInfo.RedirectStandardOutput = $true
  $probe.StartInfo.RedirectStandardError = $true
  try {
    if (!$probe.Start()) { return $false }
    $stdoutTask = $probe.StandardOutput.ReadToEndAsync()
    $stderrTask = $probe.StandardError.ReadToEndAsync()
    if (!$probe.WaitForExit(2000)) { $probe.Kill(); return $false }
    return $probe.ExitCode -eq 0
  } catch { return $false } finally { $probe.Dispose() }
}

$ffmpeg = ''
$ffmpegCandidates = @($env:FFMPEG_PATH, "$AppDirectory\ffmpeg.exe", "$AppDirectory\resources\ffmpeg.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\ffmpeg.exe", 'ffmpeg.exe')
foreach ($candidate in $ffmpegCandidates) {
  if (Test-Executable $candidate '-version') { $ffmpeg = $candidate; break }
}
$winget = ''
foreach ($candidate in @("$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe", 'winget.exe')) {
  if (Test-Executable $candidate '--version') { $winget = $candidate; break }
}

$roots = @()
foreach ($key in @('Registry::HKEY_CURRENT_USER\Software\Classes\osu\shell\open\command', 'Registry::HKEY_CLASSES_ROOT\osu\shell\open\command', 'Registry::HKEY_CLASSES_ROOT\osufile\shell\open\command')) {
  $command = (Get-Item -LiteralPath $key).GetValue('')
  if ($command -match '^\s*"([^"]+\.exe)"|^\s*(.+?\.exe)(?:\s|$)') {
    $executable = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    $roots += Split-Path -LiteralPath $executable
  }
}
$roots += "$env:LOCALAPPDATA\osu!"
$songs = ''
foreach ($root in ($roots | Select-Object -Unique)) {
  foreach ($config in (Get-ChildItem -LiteralPath $root -Filter 'osu!.*.cfg' -File)) {
    $line = Get-Content -LiteralPath $config.FullName | Where-Object { $_ -match '^\s*BeatmapDirectory\s*=' } | Select-Object -First 1
    if ($line) {
      $directory = ($line -split '=',2)[1].Trim()
      if (![System.IO.Path]::IsPathRooted($directory)) { $directory = Join-Path $root $directory }
      if (Test-Path -LiteralPath $directory -PathType Container) { $songs = $directory; break }
    }
  }
  if (!$songs -and (Test-Path -LiteralPath "$root\Songs" -PathType Container)) { $songs = "$root\Songs" }
  if ($songs) { break }
}
# INI entries contain paths, never executable commands. Prevent multiline data.
$ffmpeg = $ffmpeg -replace '[\r\n]', ''
$winget = $winget -replace '[\r\n]', ''
$songs = $songs -replace '[\r\n]', ''
[System.IO.File]::WriteAllText($OutputFile, "[environment]`r`nffmpeg=$ffmpeg`r`nwinget=$winget`r`nsongs=$songs`r`n", [System.Text.Encoding]::Unicode)
