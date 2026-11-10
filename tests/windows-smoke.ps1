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
function Read-ServiceStatus {
  $output = (& $executable --service-status | Out-String).Trim()
  if (-not $output) { throw 'Native service status returned no JSON.' }
  return $output | ConvertFrom-Json
}
try {
  $deadline = (Get-Date).AddSeconds(45)
  do {
    Start-Sleep -Seconds 1
    $app.Refresh()
    if ($app.HasExited) {
      Get-Content $errorLog, $outputLog -ErrorAction SilentlyContinue | Write-Output
      throw "Installed app exited: $($app.ExitCode)"
    }
    if ($app.MainWindowHandle -ne 0 -and $app.MainWindowTitle -eq 'TasknBoard') {
      $status = Read-ServiceStatus
      if (-not $status.running -or -not $status.runtime.pid) { throw 'Installed app has no resident service.' }
      $serviceProcessId = $status.runtime.pid
      $service = Get-CimInstance Win32_Process -Filter "ProcessId = $serviceProcessId"
      if (-not $service -or $service.Name -ne 'node.exe') { throw 'Resident service process is missing.' }
      if ($service.ParentProcessId -eq $app.Id) { throw 'Desktop still owns the resident service.' }
      $secret = (& $executable --service-credential | Out-String).Trim()
      if (-not $secret) { throw 'Native credential store returned no local credential.' }
      $headers = @{ Authorization = "Bearer $secret" }
      $origin = $status.runtime.url.TrimEnd('/')
      $info = Invoke-RestMethod -Method Post -Uri "$origin/api/workspace_info" -Headers $headers -ContentType 'application/json' -Body '{}'
      if (-not $info.actor.id) { throw 'Resident service did not return the workspace identity.' }
      $page = Invoke-WebRequest -Uri $origin
      $assets = [regex]::Matches($page.Content, '(?:src|href)="(/assets/[^"]+)"')
      if ($assets.Count -lt 2) { throw 'Installed interface has no JavaScript/CSS assets.' }
      foreach ($asset in $assets) {
        $response = Invoke-WebRequest -Uri "$origin$($asset.Groups[1].Value)"
        if ($response.RawContentLength -eq 0) { throw 'Installed interface asset is empty.' }
      }
      $null = $app.CloseMainWindow()
      if (-not $app.WaitForExit(10000)) { throw 'Installed app did not close gracefully.' }
      $afterClose = Invoke-RestMethod -Method Post -Uri "$origin/api/workspace_info" -Headers $headers -ContentType 'application/json' -Body '{}'
      if (-not $afterClose.actor.id) { throw 'Resident service stopped when the desktop closed.' }
      $originalInstance = $status.runtime.instanceId
      $null = '{"action":"restart"}' | & $executable --service-control | Out-String
      $restartDeadline = (Get-Date).AddSeconds(30)
      do {
        Start-Sleep -Milliseconds 250
        $restarted = Read-ServiceStatus
        if ($restarted.runtime -and $restarted.runtime.instanceId -ne $originalInstance) { break }
      } while ((Get-Date) -lt $restartDeadline)
      if (-not $restarted.runtime -or $restarted.runtime.instanceId -eq $originalInstance) { throw 'Resident restart did not replace the Node instance.' }
      $serviceProcessId = $restarted.runtime.pid
      $origin = $restarted.runtime.url.TrimEnd('/')
      $afterRestart = Invoke-RestMethod -Method Post -Uri "$origin/api/workspace_info" -Headers $headers -ContentType 'application/json' -Body '{}'
      if (-not $afterRestart.actor.id) { throw 'Resident service did not reconnect after restart.' }
      Write-Output 'Installed app served its interface and API. The service survived desktop closure and restarted independently.'
      break
    }
  } while ((Get-Date) -lt $deadline)
  if (-not $serviceProcessId) { throw 'Installed app did not open a window within 45 seconds.' }
} finally {
  if (-not $app.HasExited) {
    $null = $app.CloseMainWindow()
    if (-not $app.WaitForExit(10000)) { $app.Kill() }
  }
  $null = & $executable --service-uninstall | Out-String
  $secret = $null
  $headers = $null
  if ($serviceProcessId) {
    $deadline = (Get-Date).AddSeconds(20)
    while (Get-Process -Id $serviceProcessId -ErrorAction SilentlyContinue) {
      if ((Get-Date) -gt $deadline) { throw 'Node service remained running after service uninstall.' }
      Start-Sleep -Milliseconds 200
    }
    Write-Output 'The per-user service unregistered and stopped.'
  }
}
