/**
 * Whether the terminal speaks the kitty keyboard protocol, which is what lets
 * Shift+Enter differ from Enter. Asked once before Ink starts, so the key
 * hints can name the newline key that will actually work.
 */
export async function supportsKittyKeyboard(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
  timeoutMs = 200,
): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false
  const wasRaw = stdin.isRaw
  stdin.setRawMode(true)
  return new Promise(resolve => {
    let received = ''
    const finish = (supported: boolean) => {
      clearTimeout(timer)
      stdin.removeListener('data', onData)
      stdin.pause()
      stdin.setRawMode(wasRaw)
      // Keys typed while waiting go back to the input for Ink to read.
      const reply = kittyReply(received)
      const rest = reply ? received.replace(reply, '') : received
      if (rest) stdin.unshift(Buffer.from(rest))
      resolve(supported)
    }
    const onData = (data: Buffer | string) => {
      received += String(data)
      if (kittyReply(received)) finish(true)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    stdin.on('data', onData)
    // CSI ? u asks for the current flags; terminals without the protocol stay silent.
    stdout.write('\u001B[?u')
  })
}

/** The `ESC [ ? <flags> u` reply inside `text`, if it is there. */
export function kittyReply(text: string): string | undefined {
  let from = 0
  for (;;) {
    const start = text.indexOf('\u001B[?', from)
    if (start < 0) return undefined
    let end = start + 3
    while (end < text.length && text[end]! >= '0' && text[end]! <= '9') end += 1
    if (text[end] === 'u') return text.slice(start, end + 1)
    from = start + 1
  }
}
