import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

export async function pickSystemFolder(): Promise<string | undefined> {
  const platform = process.platform
  if (platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Windows.Forms',
      '$picker = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$picker.Description = 'Choose a folder for Tnega'",
      '$picker.ShowNewFolderButton = $true',
      'if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($picker.SelectedPath) }',
    ].join('; ')
    const foregroundScript = String.raw`
$targetProcessId = __TARGET_PROCESS_ID__
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TnegaFolderPickerWindow {
  private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  public static void BringToFront(uint targetProcessId) {
    EnumWindows((window, parameter) => {
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      if (processId == targetProcessId && IsWindowVisible(window)) {
        SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x0003);
        SetForegroundWindow(window);
      }
      return true;
    }, IntPtr.Zero);
  }
}
"@
while (Get-Process -Id $targetProcessId -ErrorAction SilentlyContinue) {
  [TnegaFolderPickerWindow]::BringToFront($targetProcessId)
  Start-Sleep -Milliseconds 100
}
`
    return showWindowsFolderDialog(script, foregroundScript)
  }

  if (platform === 'darwin') {
    try {
      const { stdout } = await runFile('osascript', [
        '-e', 'POSIX path of (choose folder with prompt "Choose a folder for Tnega")',
      ], { encoding: 'utf8', timeout: 120_000 })
      return stdout.trim() || undefined
    } catch (error) {
      if (isDialogCanceled(error)) return undefined
      throw error
    }
  }

  if (platform === 'linux') {
    try {
      const { stdout } = await runFile('zenity', [
        '--file-selection', '--directory', '--title=Choose a folder for Tnega',
      ], { encoding: 'utf8', timeout: 120_000 })
      return stdout.trim() || undefined
    } catch (error) {
      if (isDialogCanceled(error)) return undefined
      if (!isMissingCommand(error)) throw error
      const { stdout } = await runFile('kdialog', [
        '--getexistingdirectory', '', '--title', 'Choose a folder for Tnega',
      ], { encoding: 'utf8', timeout: 120_000 })
      return stdout.trim() || undefined
    }
  }

  throw new Error(`System folder picker is not supported on ${platform}`)
}

// The CLI Web server has no browser HWND to parent this dialog to. A small
// hidden helper raises only the picker process's windows above the browser.
function showWindowsFolderDialog(
  dialogScript: string,
  foregroundScript: string,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const picker = execFile('powershell.exe', [
      '-NoLogo', '-NoProfile', '-STA', '-Command', dialogScript,
    ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message))
        return
      }
      resolve(stdout.trim() || undefined)
    })
    const foreground = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      foregroundScript.replace('__TARGET_PROCESS_ID__', String(picker.pid)),
    ], { windowsHide: true, stdio: 'ignore' })
    foreground.unref()
    foreground.once('error', error => {
      picker.kill()
      reject(error)
    })
  })
}

function isDialogCanceled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 1 || error.code === 128)
}

function isMissingCommand(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'ENOENT'
}
