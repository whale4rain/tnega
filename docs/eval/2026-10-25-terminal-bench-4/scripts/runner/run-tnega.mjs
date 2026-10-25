// Runs `tnega run` for one task with a cost cap and a wall-clock cap, both
// rebuilt live from the durable session log.
// argv: instructionFile sessionFile logDir
import { spawn } from 'node:child_process'
import { copyFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'

const [instructionFile, sessionFile, logDir] = process.argv.slice(2)
const CAP_USD = Number(process.env.TNEGA_BENCH_CAP_USD ?? '0.09')
const WALL_MS = Number(process.env.TNEGA_BENCH_WALL_MIN ?? '60') * 60_000

// DeepSeek V4.1 Flash list prices, USD per 1M tokens; peak (2x) is weekdays 01-04 and 06-10 UTC.
export function rates(ts) {
  const d = new Date(ts)
  const h = d.getUTCHours()
  const wd = d.getUTCDay()
  const peak = wd >= 1 && wd <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10))
  const m = peak ? 2 : 1
  return { miss: 0.15 * m, hit: 0.003 * m, out: 0.6 * m }
}

let offset = 0
let carry = ''
let cost = 0
let calls = 0
function scan() {
  if (!existsSync(sessionFile)) return
  const size = statSync(sessionFile).size
  if (size <= offset) return
  const fd = openSync(sessionFile, 'r')
  const buf = Buffer.alloc(size - offset)
  readSync(fd, buf, 0, buf.length, offset)
  closeSync(fd)
  offset = size
  const lines = (carry + buf.toString('utf8')).split('\n')
  carry = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.includes('"assistant/message"')) continue
    try {
      const e = JSON.parse(line)
      const u = e.payload?.usage
      if (!u) continue
      const r = rates(e.ts)
      const cached = u.cachedTokens ?? 0
      cost += ((u.promptTokens - cached) * r.miss + cached * r.hit + u.completionTokens * r.out) / 1e6
      calls++
    } catch {}
  }
}

const RESUME_FROM = process.env.TNEGA_BENCH_RESUME_FROM
if (RESUME_FROM) {
  copyFileSync(RESUME_FROM, sessionFile)
  scan()
  cost = 0
  calls = 0
}
const instruction = RESUME_FROM
  ? 'You were stopped in the previous attempt because you ran out of budget. You now have more budget. Your earlier work is still in place in the environment. Continue the original task from where you left off, finish it, and check the result against the task requirements.'
  : readFileSync(instructionFile, 'utf8')
const args = [
  RESUME_FROM ? '/home/user/bench/tnega-resume/bin.js' : '/home/user/tnega/dist/bin.js', 'run', instruction,
  '--cwd', process.cwd(), '--session', sessionFile, '--profile', '/home/user/bench/profile.json',
  '--model', process.env.TNEGA_BENCH_MODEL ?? 'deepseek-v4-flash', '--base-url', 'https://api.deepseek.com',
  '--max-steps', '1000', '--max-turns', '1000', '--max-retries', '6', '--timeout-ms', '900000',
]
const started = Date.now()
const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...(RESUME_FROM ? { TNEGA_RESUME: '1' } : {}) } })
let stopReason = null
const timer = setInterval(() => {
  scan()
  if (!stopReason && cost >= CAP_USD) stopReason = 'cost_cap'
  if (!stopReason && Date.now() - started >= WALL_MS) stopReason = 'wall_cap'
  if (stopReason && child.exitCode === null) {
    child.kill('SIGTERM')
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 10_000)
  }
}, 3000)
const code = await new Promise(res => child.on('exit', (c, s) => res(c ?? (s ? 128 : 1))))
clearInterval(timer)
scan()
writeFileSync(`${logDir}/bench-run.json`, JSON.stringify({
  exitCode: code, stopReason, costUsd: cost, llmCalls: calls,
  wallMs: Date.now() - started, capUsd: CAP_USD, resumedFrom: RESUME_FROM ?? null, wallCapMs: WALL_MS,
}, null, 2))
