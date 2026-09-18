param(
    [string]$ScriptPath,
    [ValidateSet('CloseExited', 'CloseAlive', 'StopExited', 'StopAlive')]
    [string]$Scenario
)

$ErrorActionPreference = 'Stop'
$global:chromeShutdownTestQueryCount = 0
$global:chromeShutdownTestStopped = $false
$global:chromeShutdownTestProcess = [pscustomobject]@{
    MainWindowHandle = $(if ($Scenario.StartsWith('Close')) { 1 } else { 0 })
    HasExited = $Scenario.EndsWith('Exited')
}
$global:chromeShutdownTestProcess | Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value {
    throw [System.InvalidOperationException]::new('Process has exited, so the requested information is not available.')
}

function Get-CimInstance {
    param($ClassName, $Filter)
    $global:chromeShutdownTestQueryCount++
    if (($Scenario.StartsWith('Close') -and $global:chromeShutdownTestQueryCount -gt 1) -or
        ($global:chromeShutdownTestStopped -and $Scenario.EndsWith('Exited'))) {
        return
    }
    [pscustomobject]@{
        Name = 'chrome.exe'
        CommandLine = 'chrome.exe --user-data-dir=C:\repo\.tmp\manual-chrome-profile'
        ProcessId = 101
    }
}

function Get-Process {
    param($Id, $ErrorAction)
    if (-not ($global:chromeShutdownTestStopped -and $Scenario.EndsWith('Exited'))) {
        $global:chromeShutdownTestProcess
    }
}

function Stop-Process {
    param($Id, [switch]$Force, $ErrorAction)
    $global:chromeShutdownTestStopped = $true
    throw 'Synthetic stop failure.'
}

function Get-Date {
    [datetime]::new(2026, 1, 1).AddSeconds($global:chromeShutdownTestQueryCount * 30)
}

function Start-Sleep {
    param($Milliseconds)
}

& $ScriptPath -ProfilePath 'C:\repo\.tmp\manual-chrome-profile'
