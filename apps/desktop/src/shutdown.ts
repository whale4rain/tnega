export interface ClosableRuntime {
  close(): Promise<void>
}

export async function closeDesktopRuntime(
  runtime: ClosableRuntime | undefined,
): Promise<void> {
  await runtime?.close()
}
