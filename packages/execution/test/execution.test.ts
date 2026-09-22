import { describe, expect, it } from 'vitest'
import { localExecutionProvider } from '../src/index.js'

const cwd = process.cwd()

function node(script: string): readonly string[] {
  return [process.execPath, '-e', script]
}

describe('runProcess', () => {
  it('runs an argv vector and captures both streams', async () => {
    const result = await localExecutionProvider.runProcess({
      argv: node('process.stdout.write("out"); process.stderr.write("err")'),
      cwd,
    })
    expect(result).toMatchObject({ exitCode: 0, stdout: 'out', stderr: 'err', stdoutTruncated: false })
  })

  it('treats the exit code as a result rather than a rejection', async () => {
    const result = await localExecutionProvider.runProcess({
      argv: node('process.exit(3)'),
      cwd,
    })
    expect(result.exitCode).toBe(3)
  })

  it('gives the child EOF on stdin instead of a pipe that never closes', async () => {
    // A reader that would block forever on an open stdin pipe (this is what made
    // ripgrep hang when it was handed no explicit path).
    const result = await localExecutionProvider.runProcess({
      argv: node('process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'),
      cwd,
      timeoutMs: 10_000,
    })
    expect(result.exitCode).toBe(0)
  })

  it('reports a capture that hit the byte cap', async () => {
    const result = await localExecutionProvider.runProcess({
      argv: node('process.stdout.write("x".repeat(5000))'),
      cwd,
      maxBuffer: 100,
    })
    expect(result.stdout).toHaveLength(100)
    expect(result.stdoutTruncated).toBe(true)
  })

  it('keeps a capture that exactly fills the cap unflagged', async () => {
    const result = await localExecutionProvider.runProcess({
      argv: node('process.stdout.write("x".repeat(100))'),
      cwd,
      maxBuffer: 100,
    })
    expect(result.stdout).toHaveLength(100)
    expect(result.stdoutTruncated).toBe(false)
  })

  it('rejects and kills the process tree when the budget expires', async () => {
    await expect(localExecutionProvider.runProcess({
      argv: node('setInterval(() => {}, 1000)'),
      cwd,
      timeoutMs: 300,
    })).rejects.toThrow(/timed out after 300ms/)
  })

  it('rejects when the caller aborts', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    await expect(localExecutionProvider.runProcess({
      argv: node('setInterval(() => {}, 1000)'),
      cwd,
      signal: controller.signal,
    })).rejects.toThrow(/cancelled/)
  })
})
