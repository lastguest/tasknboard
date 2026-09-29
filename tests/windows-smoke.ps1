$ErrorActionPreference = 'Stop'
$installer = Get-ChildItem src-tauri/target -Filter '*-setup.exe' -Recurse | Select-Object -First 1
if (-not $installer) { throw 'Windows installer is missing.' }
$destination = Join-Path $env:RUNNER_TEMP 'TasknBoard-smoke'
$install = Start-Process $installer.FullName -ArgumentList @('/S', "/D=$destination") -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Installer failed: $($install.ExitCode)" }
$executable = Join-Path $destination 'tasknboard.exe'
if (-not (Test-Path $executable)) { throw "Installed executable is missing: $executable" }
$app = Start-Process $executable -PassThru
try {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Seconds 1
    $app.Refresh()
    if ($app.HasExited) { throw "Installed app exited: $($app.ExitCode)" }
    if ($app.MainWindowHandle -ne 0 -and $app.MainWindowTitle -eq 'TasknBoard') {
      $service = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($app.Id) AND Name = 'node.exe'"
      if (-not $service) { throw 'Installed app has no Node service.' }
      $listener = Get-NetTCPConnection -State Listen -OwningProcess $service.ProcessId | Select-Object -First 1
      if (-not $listener) { throw 'Installed service has no listening port.' }
      $info = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($listener.LocalPort)/api/workspace_info" -ContentType 'application/json' -Body '{}'
      if (-not $info.actor.id) { throw 'Installed service did not return the workspace identity.' }
      Write-Output "Installed app opened a window and served workspace_info: $($app.MainWindowTitle)"
      return
    }
  } while ((Get-Date) -lt $deadline)
  throw 'Installed app did not open a window within 30 seconds.'
} finally {
  if (-not $app.HasExited) {
    $null = $app.CloseMainWindow()
    if (-not $app.WaitForExit(10000)) { $app.Kill() }
  }
}
