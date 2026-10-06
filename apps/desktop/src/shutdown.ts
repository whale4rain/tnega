export interface ClosableRuntime {
  close(): Promise<void>
}

export async function closeDesktopRuntime(
  runtime: ClosableRuntime | undefined,
): Promise<void> {
  await runtime?.close()
}

interface ShutdownSteps {
  prepare?(): void
  closeRuntime(): Promise<void>
  closeBrowser(): Promise<void>
  /** True means the update installer will terminate Electron asynchronously. */
  finish(): boolean
  forceExit(): void
  reportError(error: unknown): void
}

/** A broken cleanup or installer must never leave a desktop host without its tray. */
export async function finishDesktopShutdown(steps: ShutdownSteps, timeoutMs = 10_000): Promise<void> {
  const deadline = setTimeout(() => {
    steps.reportError(new Error('Desktop shutdown exceeded its deadline'))
    steps.forceExit()
  }, timeoutMs)
  try {
    steps.prepare?.()
  } catch (error) {
    steps.reportError(error)
  }
  for (const close of [steps.closeRuntime, steps.closeBrowser]) {
    try {
      await close()
    } catch (error) {
      steps.reportError(error)
    }
  }
  try {
    if (!steps.finish()) clearTimeout(deadline)
  } catch (error) {
    clearTimeout(deadline)
    steps.reportError(error)
    steps.forceExit()
  }
}
