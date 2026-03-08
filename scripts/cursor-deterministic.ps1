param(
    [string]$TargetFile,
    [string]$GapId,
    [string]$Prompt = "Please review this document and act upon the prompt at the very bottom."
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

if (-not $TargetFile -or -not $GapId) {
    Log "Error: TargetFile and GapId are required parameters."
    exit 1
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
# PREPARE CLIPBOARD
# ==============================
Log "Reading content from $TargetFile and copying to Clipboard..."
$Content = Get-Content $TargetFile -Raw
Set-Clipboard -Value $Content
Start-Sleep -Milliseconds 500

# ==============================
# LAUNCH AND FOCUS CURSOR
# ==============================

Log "Launching Cursor..."
Start-Process $CursorExe
Start-Sleep -Seconds 6

$process = Get-Process -Name Cursor -ErrorAction SilentlyContinue |
           Where-Object { $_.MainWindowHandle -ne 0 }

if (-not $process) {
    Log "Failed to find Cursor window."
    exit 1
}

$hwnd = $process.MainWindowHandle
[Win32]::ShowWindow($hwnd, 9) | Out-Null
Start-Sleep -Milliseconds 500
[Win32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 1200

Log "Cursor focused."

# ==============================
# MAXIMIZE WINDOW
# ==============================

Log "Maximizing window (Win+Up)..."
# In PowerShell, Win+Up is tricky via SendKeys, but we can do it via SW_MAXIMIZE
# SW_MAXIMIZE = 3
[Win32]::ShowWindow($hwnd, 3) | Out-Null
Start-Sleep -Milliseconds 500

# ==============================
# GET WINDOW RECT
# ==============================

$rect = New-Object Win32+RECT
[Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null

$windowWidth = $rect.Right - $rect.Left
$windowHeight = $rect.Bottom - $rect.Top

Log "Window detected: $windowWidth x $windowHeight"

# ==============================
# OPEN CHAT VIA COMMAND PALETTE
# ==============================

Log "Opening Command Palette (Ctrl+Shift+P)..."
[System.Windows.Forms.SendKeys]::SendWait("^+p")
Start-Sleep -Milliseconds 800

Log "Typing 'New Chat'..."
[System.Windows.Forms.SendKeys]::SendWait("new chat")
Start-Sleep -Milliseconds 500

Log "Pressing Enter to open New Chat..."
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 2000

# ==============================
# SEND PROMPT
# ==============================

Log "Pasting prompt from clipboard (Ctrl+V)..."
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 1500

Log "Submitting prompt..."
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

Log "Waiting for response..."
Start-Sleep -Seconds 60

# ==============================
# CLICK 3 DOTS (relative position)
# ==============================

# 3 dots are near top-right of chat panel
$xThreeDots = $rect.Right - 26
$yThreeDots = $rect.Top + 45

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
$yExport = $rect.Top + 205

Log "Clicking Export Transcript at ($xExport, $yExport)..."
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($xExport, $yExport)
Start-Sleep -Milliseconds 500
[Win32]::mouse_event(0x02,0,0,0,[UIntPtr]::Zero)
[Win32]::mouse_event(0x04,0,0,0,[UIntPtr]::Zero)

Log "Clicked Export Transcript."
Start-Sleep -Seconds 2

# ==============================
# CONFIRM SAVE
# ==============================

Log "Waiting for save dialog to settle..."
Start-Sleep -Milliseconds 1000

$startTime = Get-Date

Log "Pressing Enter to save..."
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 1500

# ==============================
# WAIT FOR FILE
# ==============================

Log "Waiting for transcript file..."

$exportedFile = $null

while ((Get-Date) -lt $startTime.AddSeconds($TimeoutSeconds)) {

    Start-Sleep -Seconds 2

    $files = Get-ChildItem $DownloadsPath -Filter *.md |
             Sort-Object LastWriteTime -Descending

    if ($files.Count -gt 0) {
        $latest = $files[0]

        # Only accept files created *after* we hit enter, and wait until they stopped growing (2s delta)
        if ($latest.LastWriteTime -ge $startTime.AddSeconds(-2) -and
            $latest.Length -gt 0 -and
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

# ==============================
# MOVE FILE TO RESEARCH DIR
# ==============================

$TargetDir = "D:\Freelancing\02-02-2026_MoltBot_Browser\Cursor_Research_work\$GapId"
if (-not (Test-Path -Path $TargetDir)) {
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
}

$FinalPath = Join-Path -Path $TargetDir -ChildPath "final_cursor_response.md"
Move-Item -Path $exportedFile -Destination $FinalPath -Force

Log "Moved final response to: $FinalPath"
Log "Done."