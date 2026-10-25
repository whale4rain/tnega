export type OfficeErrorCode =
  /** 请求本身不合法：坏的地址、未知 sheet、不是该类型的文件。 */
  | 'OFFICE_INVALID'
  /** 文件能打开，但用到了本库尚不支持的能力。 */
  | 'OFFICE_UNSUPPORTED'

export class OfficeError extends Error {
  override name = 'OfficeError'

  constructor(
    message: string,
    readonly code: OfficeErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
