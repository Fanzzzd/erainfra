import { UPDATE_READINESS_JS } from "./updateHealthCheck.ts";

/**
 * The Windows installer's update health check (`-Update`): PowerShell functions that
 * `installScriptPowerShell.ts` embeds inside `Install-Worker`, mirroring the bash installer's
 * `--update` check. They read Install-Worker's variables ($siteUrl, $nodeExe, $tmpDir,
 * $readyTimeoutSeconds and the rest) through PowerShell's dynamic scoping.
 *
 * `updateHealthCheck.ts` owns the rules both installers share. This file owns only the Windows
 * mechanics, and must stay pure ASCII like the script it is embedded in.
 */
export const WINDOWS_UPDATE_HEALTH_CHECK = String.raw`  # --- the update health check -----------------------------------------------------------------
  # The same check the bash installer runs on --update. It reads the control plane's readiness for
  # each Profile this Worker serves: GET /agents/readiness, answered by workerApi.readiness the way
  # the scheduler judges it. The Profiles ready before the update must report ready again from the
  # new agent, or the update rolls back. UPDATE_READINESS_JS in updateHealthCheck.ts owns the program
  # that reads the answer, and lists its modes: "now FILE", "ready FILE" and
  # "verdict FILE SINCE PROFILE...".
  $readinessReader = @'
${UPDATE_READINESS_JS}
'@
  # The machine token travels only in this header, built in-process for Invoke-WebRequest. It is
  # never written to a file, a log or a child process's arguments.
  $readinessHeaders = @{}
  # The control plane's clock from its last answer, and the local time it was read, so a report the
  # restarted agent made can be told from one made before.
  $readinessClock = @{ Ms = [long]0; At = [DateTime]::UtcNow }
  # The Profiles ready before the update. Empty on a fresh install, and on an update of a Worker
  # with no ready Profile, which has nothing to compare against and is updated without the check.
  $readyBefore = @()
  $readinessSince = [long]0
  $readinessFile = ''

  # The program goes in on stdin: Windows PowerShell 5.1 strips the double quotes from a native
  # argument, and the program is made of them. Returns its output lines as one array, possibly
  # empty, or $null if it failed.
  function Invoke-ReadinessReader([string[]]$readerArgs) {
    $output = $readinessReader | & $nodeExe - @readerArgs
    if ($LASTEXITCODE -ne 0) { return $null }
    return ,@($output | Where-Object { $_ })
  }

  # Save the control plane's readiness answer to $path and note its clock. False when the control
  # plane did not answer 200 with a readable clock.
  function Read-Readiness($path) {
    try {
      $response = Invoke-WebRequest -Uri "$siteUrl/agents/readiness" -Headers $readinessHeaders -OutFile $path -PassThru -TimeoutSec 15 -UseBasicParsing
    } catch {
      return $false
    }
    if ([int]$response.StatusCode -ne 200) { return $false }
    $now = Invoke-ReadinessReader @('now', $path)
    if ($null -eq $now -or $now.Count -ne 1 -or $now[0] -notmatch '^[0-9]+$') { return $false }
    $readinessClock.Ms = [long]$now[0]
    $readinessClock.At = [DateTime]::UtcNow
    return $true
  }

  # The control plane's clock now, in milliseconds: its last answer plus local time elapsed since.
  function Get-ControlPlaneNow {
    return $readinessClock.Ms + [long]([DateTime]::UtcNow - $readinessClock.At).TotalMilliseconds
  }

  # Wait until each Profile in $names reports ready in a report newer than $since (control-plane
  # milliseconds), for at most $readyTimeoutSeconds. A degraded or failed report ends the wait at
  # once. Returns '' when they are ready, otherwise what failed: the Profile and what it reported.
  function Wait-ForReady([long]$since, [string[]]$names) {
    $deadline = [DateTime]::UtcNow.AddSeconds($readyTimeoutSeconds)
    $waitingFor = $names[0]
    $status = 'it has not reported since the Agent restarted'
    $shown = ''
    while ($true) {
      if (Read-Readiness $readinessFile) {
        $lines = Invoke-ReadinessReader (@('verdict', $readinessFile, [string]$since) + $names)
        $verdict = ''
        if ($lines) { $verdict = [string]$lines[0] }
        if ($verdict -eq 'ready') { return '' }
        if ($verdict.StartsWith('fail ')) { return $verdict.Substring(5) }
        if ($verdict -match '^wait (\S+) (.+)$') {
          $waitingFor = $Matches[1]
          $status = $Matches[2]
        }
      } else {
        $status = 'the control plane did not answer GET /agents/readiness'
      }
      if ("$waitingFor $status" -ne $shown) {
        Say "Waiting for Profile $waitingFor; $status."
        $shown = "$waitingFor $status"
      }
      $left = ($deadline - [DateTime]::UtcNow).TotalSeconds
      if ($left -le 0) {
        return "Profile $waitingFor did not report ready within $readyTimeoutSeconds seconds; $status"
      }
      Start-Sleep -Seconds ([int][math]::Ceiling([math]::Min(5, $left)))
    }
  }

  # The new agent failed the update health check ($reason says how). Put the previous agent back,
  # start it, and wait for it to report the same Profiles ready. Always exits non-zero: the update
  # did not happen, and a script or operator running it must see that.
  function Undo-Update($reason) {
    $rollbackReason = "Agent $installVersion failed the update health check: $reason"
    Write-Host "[erainfra] $rollbackReason" -ForegroundColor Red
    Say "Restoring agent $previousVersion."
    Stop-Agent
    if (-not (Restore-Previous)) { Fail "$rollbackReason. No previous installation was available to restore." }
    Write-Meta $nodeExe $serviceKind $previousVersion
    Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
    $rollbackSince = Get-ControlPlaneNow
    try {
      Start-Agent $serviceKind
    } catch {
      Fail "$rollbackReason. Restored $previousVersion, but its scheduled task did not start."
    }
    if (-not (Wait-ForConnection $previousVersion)) {
      Fail "$rollbackReason. Restored $previousVersion, but it did not connect within 20 seconds; check $logFile"
    }
    $restoredFailure = Wait-ForReady $rollbackSince $readyBefore
    if (-not $restoredFailure) {
      Fail "$rollbackReason. Rolled back to $previousVersion, which reports every Profile ready again."
    }
    Fail "$rollbackReason. Rolled back to $previousVersion, but it has not reported ready either: $restoredFailure. Check rc.ps1 logs."
  }`;
