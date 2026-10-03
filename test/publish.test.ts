import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { join } from 'node:path'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

// The full build (esbuild + vite + tsc) runs near 30s on a warm machine, so the
// hook needs headroom well past the default budget; the inner timeout is what
// turns a genuinely wedged build into a readable failure rather than a hang.
const BUILD_TIMEOUT_MS = 120_000

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build.mjs'], {
    cwd: root,
    stdio: 'pipe',
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  })
}, BUILD_TIMEOUT_MS + 10_000)

describe('publish metadata', () => {
  it('exposes tnega as a public CLI package', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('tnega')
    expect(pkg.private).toBe(false)
    expect(pkg.license).toBe('MIT')
    expect(pkg.bin?.tnega).toBe('./dist/bin.js')
    expect(pkg.files).toContain('dist')
    expect(pkg.engines.node).toBe('>=22.19.0')
  })

  it('keeps the bin entry in source so a fresh build can emit it', () => {
    const bin = readFileSync(resolve(root, 'packages/cli/src/bin.ts'), 'utf8')
    expect(bin.startsWith('#!/usr/bin/env node')).toBe(true)
    expect(bin).toContain("main(process.argv.slice(2))")
  })
})

describe('packed artifact', () => {
  it('installs bundled skills from a copied artifact without source files or network', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tnega-packed-skills-'))
    try {
      await cp(resolve(root, 'dist/coding-agent.js'), join(directory, 'coding-agent.mjs'))
      await writeFile(join(directory, 'verify.mjs'), `
        import { installBuiltinSkills, listSkills, readSkill } from './coding-agent.mjs';
        import { writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        process.env.TNEGA_HOME = ${JSON.stringify(join(directory, 'home'))};
        await installBuiltinSkills();
        const skills = await listSkills(${JSON.stringify(directory)});
        if (skills.length !== 8) throw new Error('missing bundled skills');
        if (!(await readSkill(${JSON.stringify(directory)}, 'using-tnega')).includes('description:')) throw new Error('content missing');
        await writeFile(join(process.env.TNEGA_HOME, 'skills', 'using-tnega', 'SKILL.md'), '# User override');
        await installBuiltinSkills();
        if (await readSkill(${JSON.stringify(directory)}, 'using-tnega') !== '# User override') throw new Error('user file overwritten');
        console.log('packed skills ok');
      `)
      expect(execFileSync(process.execPath, [join(directory, 'verify.mjs')], {
        cwd: directory, encoding: 'utf8', timeout: 15_000,
      })).toContain('packed skills ok')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('runs background tools through the built runtime and exposes job plugins', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tnega-packed-jobs-'))
    try {
      await writeFile(join(directory, 'verify.mjs'), `
        import { createAgentRuntime } from ${JSON.stringify(pathToFileURL(join(root, 'dist/cli-runtime.js')).href)};
        import { JobRegistry } from ${JSON.stringify(pathToFileURL(join(root, 'dist/jobs.js')).href)};
        import { jobsLocal } from ${JSON.stringify(pathToFileURL(join(root, 'dist/jobs-local.js')).href)};
        import { toolJobs } from ${JSON.stringify(pathToFileURL(join(root, 'dist/tool-jobs.js')).href)};
        if (!JobRegistry || !jobsLocal || !toolJobs) throw new Error('missing job exports');
        const runtime = await createAgentRuntime({ cwd: ${JSON.stringify(directory)},
          sessionFile: ${JSON.stringify(join(directory, 'session.jsonl'))}, builtinTools: false, jobs: true });
        const tools = runtime.root.get('tools');
        tools.register({ schema: { name: 'long_work', description: 'long work' }, execute: async () => {
          await new Promise(resolve => setTimeout(resolve, 10)); return 'work finished';
        } });
        const started = await tools.execute('job_start', { tool: 'long_work' });
        if (!started.ok || !started.output.job_id) throw new Error('job failed to launch');
        const output = await tools.execute('job_output', { job_id: started.output.job_id, wait: true });
        if (!output.ok || output.output.job.status !== 'completed' || output.output.output !== 'work finished') throw new Error('job result lost');
        await runtime.dispose();
        console.log('packed jobs ok');
      `)
      expect(execFileSync(process.execPath, [join(directory, 'verify.mjs')], {
        cwd: root, encoding: 'utf8', timeout: 15_000,
      })).toContain('packed jobs ok')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('loads configured ESM package plugins through the built runtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tnega-packed-profile-'))
    try {
      const { mkdir } = await import('node:fs/promises')
      const pkg = join(directory, 'node_modules', 'external-plugin')
      await mkdir(pkg, { recursive: true })
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: { import: './index.js' } }))
      await writeFile(join(pkg, 'index.js'), `
        import { Service } from ${JSON.stringify(pathToFileURL(join(root, 'dist/core.js')).href)};
        export default class Greeting extends Service {
          constructor(ctx, config) { super(ctx, 'externalGreeting'); this.message = config.message; }
        }
      `)
      await writeFile(join(directory, 'profile.json'), JSON.stringify({ bundles: [
        { module: 'external-plugin', config: { message: 'hello from outside' } },
      ], options: { builtinTools: false } }))
      await writeFile(join(directory, 'verify.mjs'), `
        import { bootAgentRuntimeFromFile, createAgentRuntime } from ${JSON.stringify(pathToFileURL(join(root, 'dist/cli-runtime.js')).href)};
        const runtime = await createAgentRuntime(await bootAgentRuntimeFromFile(
          { cwd: ${JSON.stringify(directory)}, sessionFile: ${JSON.stringify(join(directory, 'session.jsonl'))} },
          ${JSON.stringify(join(directory, 'profile.json'))}
        ));
        if (runtime.root.get('externalGreeting').message !== 'hello from outside') throw new Error('config lost');
        await runtime.dispose();
        if (runtime.root.get('externalGreeting') !== undefined) throw new Error('service leaked');
        console.log('external profile ok');
      `)
      expect(execFileSync(process.execPath, [join(directory, 'verify.mjs')], {
        cwd: root, encoding: 'utf8', timeout: 15_000,
      })).toContain('external profile ok')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('runs QuickJS from copied runtime resources without installed dependencies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tnega-packed-ptc-'))
    try {
      await cp(resolve(root, 'dist'), join(directory, 'dist'), { recursive: true })
      const code = `
        import { Context, toolsApi, ptcRuntimeQuickjsApi, toolPtcApi } from './dist/index.js';
        const ctx = new Context();
        await ctx.plugin(toolsApi.tools);
        const registry = ctx.get('tools');
        registry.register({schema:{name:'echo_test',description:'echo'},execute:input=>input});
        await ctx.plugin(ptcRuntimeQuickjsApi.ptcRuntimeQuickjs);
        await ctx.plugin(toolPtcApi.toolPtc);
        const result = await registry.execute('run_code',{code:'return await tools.echo_test({value:42})'});
        if (!result.ok || !result.output.ok || result.output.value.value !== 42) throw new Error(JSON.stringify(result));
        await ctx.fiber.dispose();
        console.log('packed QuickJS ok');
      `
      await writeFile(join(directory, 'verify.mjs'), code)
      await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
      expect(execFileSync(process.execPath, ['verify.mjs'], {
        cwd: directory, encoding: 'utf8', timeout: 15_000,
      })).toContain('packed QuickJS ok')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('builds a runnable self-contained bin', () => {
    const bin = resolve(root, 'dist/bin.js')
    expect(existsSync(bin)).toBe(true)
    let output = ''
    try {
      execFileSync(process.execPath, [bin, 'no-such-command'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const err = error as { stdout?: unknown }
      output = String(err.stdout ?? '')
    }
    expect(output).toContain('unknown command: no-such-command')
  })

  it('bundles the library entry without leaking internal workspace paths', () => {
    const index = readFileSync(resolve(root, 'dist/index.js'), 'utf8')
    expect(index).not.toMatch(/from ["']@tnega\//)
    expect(index).toContain('runAgentCommand')
  })

  it('resolves the library entry as a consumer via package exports', async () => {
    const mod = await import('tnega')
    expect(typeof mod.Context).toBe('function')
    expect(typeof mod.SessionLog).toBe('function')
    expect(typeof mod.ToolsService).toBe('function')
    expect(typeof mod.AgentService).toBe('function')
    expect(typeof mod.openaiCompatAdapter).toBe('function')
    expect(typeof mod.anthropicMessagesAdapter).toBe('function')
    expect(typeof mod.createLlmAdapter).toBe('function')
    expect(typeof mod.lookupModel).toBe('function')
    expect(mod.DEFAULT_MODEL).toBe('deepseek-v4-flash')
    expect(typeof mod.main).toBe('function')
    expect(mod.coreApi).toBeTruthy()
  })

  it('resolves every documented subpath as a consumer via package exports', async () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const subpaths = [
      'approval-review',
      'approval-llm',
      'approval-jev',
      'approval-openai',
      'auto-approval',
      'run-summary',
      'ptc-runtime',
      'ptc-runtime-quickjs',
      'tool-ptc',
      'user-questions',
      'tool-question',
      'agent',
      'artifact-local',
      'artifact-store',
      'blackboard',
      'blackboard-local',
      'box',
      'box-blackboard',
      'cli/runtime',
      'coding-agent',
      'core',
      'events',
      'execution',
      'llm',
      'memory',
      'memory-local',
      'project',
      'project-local',
      'project-loop',
      'sandbox',
      'sandbox-local',
      'sandbox-windows-acl',
      'fs-sandbox',
      'execution-sandbox',
      'search',
      'search-ripgrep',
      'services',
      'session',
      'spill',
      'spill-local',
      'thread',
      'thread-local',
      'tool-blackboard',
      'tool-box',
      'tool-search',
      'tool-thread',
      'tool-memory',
      'tool-spill',
      'tools',
    ]
    for (const subpath of subpaths) {
      expect(pkg.exports[`./${subpath}`]).toBeTruthy()
      const mod = await import(`tnega/${subpath}`)
      expect(Object.keys(mod).length).toBeGreaterThan(0)
    }
  }, 30_000)

  it('emits a runtime js file for every subpath entry', () => {
    const names = [
      'approval-review',
      'approval-llm',
      'approval-jev',
      'approval-openai',
      'auto-approval',
      'run-summary',
      'agent',
      'artifact-local',
      'artifact-store',
      'blackboard',
      'blackboard-local',
      'cli-runtime',
      'coding-agent',
      'core',
      'events',
      'execution',
      'llm',
      'memory',
      'memory-local',
      'project',
      'project-local',
      'project-loop',
      'sandbox',
      'sandbox-local',
      'sandbox-windows-acl',
      'sandbox-windows-acl-runner',
      'fs-sandbox',
      'execution-sandbox',
      'search',
      'search-ripgrep',
      'services',
      'session',
      'spill',
      'spill-local',
      'thread',
      'thread-local',
      'tool-blackboard',
      'tool-box',
      'tool-search',
      'tool-thread',
      'tool-memory',
      'tool-spill',
      'tools',
    ]
    for (const name of names) {
      expect(existsSync(resolve(root, `dist/${name}.js`))).toBe(true)
    }
  })

  it('publishes self-contained declarations without @tnega/* imports', () => {
    const rootDir = resolve(root, 'dist/types')
    const files = collectDeclarations(rootDir)
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(/['"]@tnega\//)
    }
    expect(existsSync(resolve(rootDir, 'src/index.d.ts'))).toBe(true)
  })
})

function collectDeclarations(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectDeclarations(path))
    } else if (entry.name.endsWith('.d.ts')) {
      files.push(path)
    }
  }
  return files
}
