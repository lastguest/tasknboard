$ErrorActionPreference = 'Stop'
$installer = Get-ChildItem src-tauri/target -Filter '*-setup.exe' -Recurse | Select-Object -First 1
if (-not $installer) { throw 'Windows installer is missing.' }
$destination = Join-Path $env:RUNNER_TEMP 'TasknBoard-smoke'
$install = Start-Process $installer.FullName -ArgumentList @('/S', "/D=$destination") -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Installer failed: $($install.ExitCode)" }
$executable = Join-Path $destination 'tasknboard.exe'
if (-not (Test-Path $executable)) { throw "Installed executable is missing: $executable" }
$env:RUST_BACKTRACE = '1'
$errorLog = Join-Path $env:RUNNER_TEMP 'tasknboard-stderr.log'
$outputLog = Join-Path $env:RUNNER_TEMP 'tasknboard-stdout.log'
$app = Start-Process $executable -PassThru -RedirectStandardError $errorLog -RedirectStandardOutput $outputLog
$serviceProcessId = $null
try {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Seconds 1
    $app.Refresh()
    if ($app.HasExited) {
      Get-Content $errorLog, $outputLog -ErrorAction SilentlyContinue | Write-Output
      throw "Installed app exited: $($app.ExitCode)"
    }
    if ($app.MainWindowHandle -ne 0 -and $app.MainWindowTitle -eq 'TasknBoard') {
      $service = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($app.Id) AND Name = 'node.exe'"
      if (-not $service) { throw 'Installed app has no Node service.' }
      $serviceProcessId = $service.ProcessId
      $listener = Get-NetTCPConnection -State Listen -OwningProcess $service.ProcessId | Select-Object -First 1
      if (-not $listener) { throw 'Installed service has no listening port.' }
      $info = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($listener.LocalPort)/api/workspace_info" -ContentType 'application/json' -Body '{}'
      if (-not $info.actor.id) { throw 'Installed service did not return the workspace identity.' }
      $origin = "http://127.0.0.1:$($listener.LocalPort)"
      $page = Invoke-WebRequest -Uri $origin
      $assets = [regex]::Matches($page.Content, '(?:src|href)="(/assets/[^"]+)"')
      if ($assets.Count -lt 2) { throw 'Installed interface has no JavaScript/CSS assets.' }
      foreach ($asset in $assets) {
        $response = Invoke-WebRequest -Uri "$origin$($asset.Groups[1].Value)"
        if ($response.RawContentLength -eq 0) { throw 'Installed interface asset is empty.' }
      }
      Write-Output "Installed app opened a window and served its interface, assets, and workspace API."
      return
    }
  } while ((Get-Date) -lt $deadline)
  throw 'Installed app did not open a window within 30 seconds.'
} finally {
  if (-not $app.HasExited) {
    $null = $app.CloseMainWindow()
    if (-not $app.WaitForExit(10000)) {
      $app.Kill()
      throw 'Installed app did not close gracefully.'
    }
  }
  if ($serviceProcessId) {
    $deadline = (Get-Date).AddSeconds(10)
    while (Get-Process -Id $serviceProcessId -ErrorAction SilentlyContinue) {
      if ((Get-Date) -gt $deadline) { throw 'Node service remained running after app shutdown.' }
      Start-Sleep -Milliseconds 200
    }
    Write-Output 'Installed app and Node service closed gracefully.'
  }
}
