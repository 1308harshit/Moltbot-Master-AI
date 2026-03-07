param(
    [string]$Prompt = "Explain microservices architecture clearly."
)

# ==============================
# CONFIG
# ==============================

$CursorExe = "D:\Program File\cursor\Cursor.exe"
$DownloadsPath = "$env:USERPROFILE\Downloads"
$TimeoutSeconds = 180

function Log($msg) {
    $timestamp = Get-Date -Format "HH:mm:ss"
    Write-Host "$timestamp - $msg"
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class Win32 {

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    public const int SW_RESTORE = 9;
    public const uint LEFTDOWN = 0x02;
    public const uint LEFTUP = 0x04;

    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
"@

# ==============================
# FIND OR START CURSOR
# ==============================

$process = Get-Process -Name Cursor -ErrorAction SilentlyContinue |
           Where-Object { $_.MainWindowHandle -ne 0 }

if (-not $process) {
    Log "Launching Cursor..."
    Start-Process $CursorExe
    Start-Sleep -Seconds 6

    $process = Get-Process -Name Cursor |
               Where-Object { $_.MainWindowHandle -ne 0 }

    if (-not $process) {
        Log "Failed to find Cursor window."
        exit 1
    }
}

$hwnd = $process.MainWindowHandle
[Win32]::ShowWindow($hwnd, 9) | Out-Null
Start-Sleep -Milliseconds 500
[Win32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 1200

Log "Cursor focused."

# ==============================
# GET WINDOW RECT
# ==============================

$rect = New-Object Win32+RECT
[Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null

$windowWidth = $rect.Right - $rect.Left
$windowHeight = $rect.Bottom - $rect.Top

Log "Window detected: $windowWidth x $windowHeight"

# ==============================
# OPEN CHAT
# ==============================

[System.Windows.Forms.SendKeys]::SendWait("^l")
Start-Sleep -Milliseconds 800

# ==============================
# SEND PROMPT
# ==============================

Log "Sending prompt..."
[System.Windows.Forms.SendKeys]::SendWait($Prompt)
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

Log "Waiting for response..."
Start-Sleep -Seconds 20

# ==============================
# CLICK 3 DOTS (relative position)
# ==============================

# 3 dots are near top-right of chat panel
# Move in from the edge (Right-10 was too close)
$xThreeDots = $rect.Right - 12
$yThreeDots = $rect.Top + 25

Log "Clicking three dots at ($xThreeDots, $yThreeDots)..."
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($xThreeDots, $yThreeDots)
Start-Sleep -Milliseconds 500
[Win32]::mouse_event(0x02,0,0,0,[UIntPtr]::Zero)
[Win32]::mouse_event(0x04,0,0,0,[UIntPtr]::Zero)

Log "Clicked three dots."
Start-Sleep -Milliseconds 1200

# ==============================
# CLICK EXPORT TRANSCRIPT
# ==============================

# Export option is below menu
$xExport = $rect.Right - 105
$yExport = $rect.Top + 185

Log "Clicking Export Transcript at ($xExport, $yExport)..."
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($xExport, $yExport)
Start-Sleep -Milliseconds 500
[Win32]::mouse_event(0x02,0,0,0,[UIntPtr]::Zero)
[Win32]::mouse_event(0x04,0,0,0,[UIntPtr]::Zero)

Log "Clicked Export Transcript."
Start-Sleep -Milliseconds 1500

# ==============================
# CONFIRM SAVE
# ==============================

[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 1500

# ==============================
# WAIT FOR FILE
# ==============================

Log "Waiting for transcript file..."

$startTime = Get-Date
$exportedFile = $null

while ((Get-Date) -lt $startTime.AddSeconds($TimeoutSeconds)) {

    Start-Sleep -Seconds 2

    $files = Get-ChildItem $DownloadsPath -Filter *.md |
             Sort-Object LastWriteTime -Descending

    if ($files.Count -gt 0) {
        $latest = $files[0]

        if ($latest.Length -gt 0 -and
            ((Get-Date) - $latest.LastWriteTime).TotalSeconds -gt 2) {

            $exportedFile = $latest.FullName
            break
        }
    }
}

if (-not $exportedFile) {
    Log "Transcript file not detected."
    exit 1
}

Log "Export successful."
Log "File saved at: $exportedFile"