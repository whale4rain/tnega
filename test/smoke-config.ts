import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLlmEnv } from '../packages/config/src/index.js'

/**
 * A settings file for the real-provider smoke tests.
 *
 * They used to run with whatever `~/.tnega/config.json` held, which made their
 * result depend on the developer's personal setup: with no file at all the
 * adapter falls back to the OpenCode Go gateway and answers 400 MissingSessionID,
 * so a green run meant "my config happened to name DeepSeek".
 *
 * This names the endpoint explicitly instead. The key still comes from the
 * environment (see `hasApiKey` in each test), and `OPENCODE_GO_BASE_URL` /
 * `OPENCODE_GO_MODEL` still steer it when someone runs the suite against another
 * compatible provider.
 */
export const smokeModel = process.env.OPENCODE_GO_MODEL ?? 'deepseek-v4-flash'
export const smokeBaseUrl = resolveLlmEnv(process.env).baseUrl ?? 'https://api.deepseek.com'

/** Written per test run; the caller keeps using it for the whole file. */
export async function smokeConfigFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-smoke-'))
  const file = join(dir, 'config.json')
  await writeFile(file, JSON.stringify({ baseUrl: smokeBaseUrl, model: smokeModel }), 'utf8')
  return file
}
