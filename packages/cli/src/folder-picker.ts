import { execFile } from 'node:child_process'
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
    const { stdout } = await runFile('powershell.exe', [
      '-NoLogo', '-NoProfile', '-STA', '-Command', script,
    ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
    return stdout.trim() || undefined
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

function isDialogCanceled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 1 || error.code === 128)
}

function isMissingCommand(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'ENOENT'
}
