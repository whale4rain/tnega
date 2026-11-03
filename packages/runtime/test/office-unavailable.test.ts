import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

// The office package cannot be loaded: importing it fails outright.
vi.mock("@tnega/tool-office", () => {
  throw new Error("office package failed to load")
})

import { Context } from "@tnega/core"
import { runtimeCapabilities } from "../src/index.js"

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * A workspace with a spreadsheet mounts the office capability, which imports a
 * package that carries exceljs and friends. When that import fails, the run must
 * lose only the office tools and must say so — not abandon every other tool.
 */
it("keeps every other tool when the office package cannot load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tnega-office-broken-"))
  dirs.push(dir)
  await writeFile(join(dir, "report.xlsx"), "", "utf8")
  const toStderr = vi.spyOn(console, "error").mockImplementation(() => {})

  const ctx = new Context()
  // The composition itself must resolve rather than reject.
  await ctx.plugin(runtimeCapabilities, { workspace: dir, permission: "read-only" })

  const names = (ctx.get("tools") as unknown as { list(): Array<{ schema: { name: string } }> })
    .list().map(tool => tool.schema.name)
  expect(names.filter(name => name.startsWith("office_"))).toEqual([])
  expect(names).toContain("read_file")
  expect(names).toContain("list_dir")

  const stderr = toStderr.mock.calls.map(call => call.join(" ")).join("\n")
  expect(stderr).toContain("capability office is unavailable")

  await ctx.fiber.dispose()
}, 120_000)
