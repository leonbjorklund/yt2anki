[CmdletBinding(DefaultParameterSetName = 'Close')]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProfilePath,

    [Parameter(Mandatory = $true, ParameterSetName = 'MatchOnly')]
    [switch]$MatchOnly,

    [Parameter(Mandatory = $true, ParameterSetName = 'MatchOnly')]
    [string]$ProcessListPath
)

$ErrorActionPreference = 'Stop'
$targetProfile = [System.IO.Path]::GetFullPath($ProfilePath).TrimEnd('\').Replace('/', '\').ToLowerInvariant()

function Test-DedicatedChromeProcess {
    param([object]$ProcessInfo)

    if (([string]$ProcessInfo.Name).ToLowerInvariant() -ne 'chrome.exe') {
        return $false
    }
    $commandLine = (([string]$ProcessInfo.CommandLine) -replace '"', '').Replace('/', '\').ToLowerInvariant()
    $argument = "--user-data-dir=$targetProfile"
    $pattern = '(?:^|\s)' + [regex]::Escape($argument) + '(?:\s|$)'
    return [regex]::IsMatch($commandLine, $pattern)
}

if ($MatchOnly) {
    $processes = ConvertFrom-Json -InputObject (Get-Content -LiteralPath $ProcessListPath -Raw)
    $matchingIds = @()
    foreach ($processInfo in $processes) {
        if (Test-DedicatedChromeProcess $processInfo) {
            $matchingIds += $processInfo.ProcessId
        }
    }
    ConvertTo-Json -Compress -InputObject @($matchingIds)
    exit 0
}

function Get-DedicatedChrome {
    @(
        Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
            Where-Object { Test-DedicatedChromeProcess $_ }
    )
}

$initial = @(Get-DedicatedChrome)
foreach ($target in $initial) {
    $process = Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue
    if ($process) {
        try {
            if ($process.MainWindowHandle -ne 0) {
                [void]$process.CloseMainWindow()
            }
        } catch {
            if (-not $process.HasExited) {
                throw
            }
        }
    }
}

$deadline = (Get-Date).AddSeconds(8)
do {
    $remaining = @(Get-DedicatedChrome)
    if ($remaining.Count -eq 0 -or (Get-Date) -ge $deadline) {
        break
    }
    Start-Sleep -Milliseconds 100
} while ($true)

$forcedCount = 0
if ($remaining.Count -gt 0) {
    $forcedCount = $remaining.Count
    foreach ($target in $remaining) {
        try {
            Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
        } catch {
            if (Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue) {
                throw
            }
        }
    }
    $deadline = (Get-Date).AddSeconds(5)
    do {
        $remaining = @(Get-DedicatedChrome)
        if ($remaining.Count -eq 0 -or (Get-Date) -ge $deadline) {
            break
        }
        Start-Sleep -Milliseconds 100
    } while ($true)
}

if ($remaining.Count -gt 0) {
    throw 'Could not close the dedicated yt2anki Chrome process.'
}

[pscustomobject]@{
    ForcedCount = $forcedCount
    InitialCount = $initial.Count
} | ConvertTo-Json -Compress
