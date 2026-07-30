param(
    [Parameter(Mandatory = $true)]
    [string]$ProfilePath
)

$ErrorActionPreference = 'Stop'
$resolvedProfile = (Resolve-Path -LiteralPath $ProfilePath).Path

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class BrowserUiMouse
{
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(
        uint flags,
        uint dx,
        uint dy,
        uint data,
        UIntPtr extraInfo
    );
}
'@

function Invoke-MouseClick {
    param(
        [Parameter(Mandatory = $true)]
        [System.Windows.Automation.AutomationElement]$Element
    )

    $bounds = $Element.Current.BoundingRectangle
    [void][BrowserUiMouse]::SetCursorPos(
        [int]($bounds.Left + ($bounds.Width / 2)),
        [int]($bounds.Top + ($bounds.Height / 2))
    )
    [BrowserUiMouse]::mouse_event(
        0x0002,
        0,
        0,
        0,
        [UIntPtr]::Zero
    )
    [BrowserUiMouse]::mouse_event(
        0x0004,
        0,
        0,
        0,
        [UIntPtr]::Zero
    )
}

$processIds = @(
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.Contains($resolvedProfile)
        } |
        Select-Object -ExpandProperty ProcessId
)
if ($processIds.Count -eq 0) {
    throw 'The disposable browser process is unavailable.'
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$buttonCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
)

$browserWindow = $null
$extensionsButton = $null
$windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
)
foreach ($window in $windows) {
    if ($processIds -notcontains $window.Current.ProcessId) {
        continue
    }
    $buttons = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $buttonCondition
    )
    $candidate = $buttons |
        Where-Object { $_.Current.Name -eq 'Extensions' } |
        Select-Object -First 1
    if ($candidate) {
        $browserWindow = $window
        $extensionsButton = $candidate
        break
    }
}
if (-not $browserWindow -or -not $extensionsButton) {
    throw 'The disposable browser Extensions button is unavailable.'
}

[void][BrowserUiMouse]::SetForegroundWindow(
    [IntPtr]$browserWindow.Current.NativeWindowHandle
)
Invoke-MouseClick $extensionsButton
Start-Sleep -Milliseconds 500

$actionButton = $null
$windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
)
foreach ($window in $windows) {
    if ($processIds -notcontains $window.Current.ProcessId) {
        continue
    }
    $buttons = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $buttonCondition
    )
    $actionButton = $buttons |
        Where-Object { $_.Current.Name -like 'yt2anki*' } |
        Select-Object -First 1
    if ($actionButton) {
        break
    }
}
if (-not $actionButton) {
    throw 'yt2anki is unavailable in the browser Extensions menu.'
}

Invoke-MouseClick $actionButton
Start-Sleep -Milliseconds 500
