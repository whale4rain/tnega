export class OpenAICompatibleError extends Error {
  override name = 'OpenAICompatibleError'

  constructor(
    readonly status: number,
    message: string,
    readonly detail?: string,
  ) {
    super(message)
  }
}
