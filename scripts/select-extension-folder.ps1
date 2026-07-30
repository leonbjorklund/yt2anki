param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$ProfilePath
)

$ErrorActionPreference = 'Stop'
$resolvedPath = (Resolve-Path -LiteralPath $Path).Path
$resolvedProfile = (Resolve-Path -LiteralPath $ProfilePath).Path

Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class FolderDialogNative
{
    public delegate bool EnumWindowsCallback(IntPtr handle, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(
        EnumWindowsCallback callback,
        IntPtr parameter
    );

    [DllImport("user32.dll")]
    public static extern int GetWindowText(
        IntPtr handle,
        StringBuilder text,
        int maximum
    );

    [DllImport("user32.dll")]
    public static extern IntPtr GetDlgItem(IntPtr dialog, int id);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(
        IntPtr handle,
        out uint processId
    );

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(
        uint sourceThread,
        uint targetThread,
        bool attach
    );

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern IntPtr SetActiveWindow(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(
        IntPtr handle,
        uint message,
        IntPtr word,
        IntPtr data
    );
}
'@

$profileProcessIds = @(
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.Contains($resolvedProfile)
        } |
        Select-Object -ExpandProperty ProcessId
)
if ($profileProcessIds.Count -eq 0) {
    throw 'The disposable browser process is unavailable.'
}

$dialog = [IntPtr]::Zero
[FolderDialogNative]::EnumWindows(
    {
        param($handle, $parameter)
        $title = New-Object System.Text.StringBuilder 300
        [void][FolderDialogNative]::GetWindowText(
            $handle,
            $title,
            $title.Capacity
        )
        $ownerProcessId = 0
        [void][FolderDialogNative]::GetWindowThreadProcessId(
            $handle,
            [ref]$ownerProcessId
        )
        if (
            $title.ToString() -eq 'Select the extension directory.' -and
            $profileProcessIds -contains $ownerProcessId
        ) {
            $script:dialog = $handle
        }
        return $true
    },
    [IntPtr]::Zero
) | Out-Null

if ($dialog -eq [IntPtr]::Zero) {
    throw 'The browser extension folder picker is unavailable.'
}

$folderEdit = [FolderDialogNative]::GetDlgItem($dialog, 1152)
$selectButton = [FolderDialogNative]::GetDlgItem($dialog, 1)
if (
    $folderEdit -eq [IntPtr]::Zero -or
    $selectButton -eq [IntPtr]::Zero
) {
    throw 'The browser extension folder picker controls changed.'
}

$targetProcessId = 0
$targetThread = [FolderDialogNative]::GetWindowThreadProcessId(
    $dialog,
    [ref]$targetProcessId
)
$currentThread = [FolderDialogNative]::GetCurrentThreadId()
if (
    -not [FolderDialogNative]::AttachThreadInput(
        $currentThread,
        $targetThread,
        $true
    )
) {
    throw 'The browser extension folder picker could not receive input.'
}

try {
    [void][FolderDialogNative]::SetForegroundWindow($dialog)
    [void][FolderDialogNative]::SetActiveWindow($dialog)
    [void][FolderDialogNative]::SetFocus($folderEdit)
    $escapedPath = $resolvedPath -replace '([+^%~(){}\[\]])', '{$1}'
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    [System.Windows.Forms.SendKeys]::SendWait($escapedPath)
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 800
    [void][FolderDialogNative]::SendMessage(
        $selectButton,
        0x00F5,
        [IntPtr]::Zero,
        [IntPtr]::Zero
    )
    Start-Sleep -Milliseconds 300
}
finally {
    [void][FolderDialogNative]::AttachThreadInput(
        $currentThread,
        $targetThread,
        $false
    )
}
