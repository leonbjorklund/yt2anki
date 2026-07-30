param(
    [Parameter(Mandatory = $true)]
    [string]$BasePath
)

$ErrorActionPreference = 'Stop'
$resolvedBase = (Resolve-Path -LiteralPath $BasePath).Path
$resolvedTemp = [System.IO.Path]::GetFullPath(
    [System.IO.Path]::GetTempPath()
).TrimEnd('\')
$allowedPrefix = @(
    "$resolvedTemp\yt2anki-anki-playback-",
    "$resolvedTemp\yt2anki-anki-connect-"
) | Where-Object { $resolvedBase.StartsWith($_) }
if ($allowedPrefix.Count -eq 0) {
    throw 'Refusing to close Anki outside the disposable playback base.'
}

$processIds = @(
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.ProcessId -ne $PID -and
            $_.CommandLine -and
            $_.CommandLine.Contains($resolvedBase)
        } |
        Select-Object -ExpandProperty ProcessId
)

foreach ($processId in $processIds) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne 0) {
        [void]$process.CloseMainWindow()
    }
}

$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
    Start-Sleep -Milliseconds 250
    $remaining = @(
        $processIds |
            Where-Object {
                Get-Process -Id $_ -ErrorAction SilentlyContinue
            }
    )
} while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)

foreach ($processId in $remaining) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
