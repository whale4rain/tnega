import { randomUUID } from 'node:crypto'
import { loadJson, saveJson } from '@tnega/eval'
import { diagnose } from './diagnose.js'
import type {
  ExperimentLogData,
  ExperimentNode,
  ExperimentReplay,
} from './types.js'

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class ExperimentLog {
  private _data: ExperimentLogData

  constructor(
    readonly file: string,
    data?: ExperimentLogData,
  ) {
    this._data = data ?? this._empty()
  }

  static async open(file: string): Promise<ExperimentLog> {
    try {
      const data = await loadJson<ExperimentLogData>(file)
      return new ExperimentLog(file, data)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new ExperimentLog(file)
      }
      throw error
    }
  }

  get id(): string {
    return this._data.id
  }

  get baselineId(): string | undefined {
    return this._data.baselineId
  }

  get baseline(): ExperimentNode | undefined {
    return this._data.baselineId ? this.get(this._data.baselineId) : undefined
  }

  get size(): number {
    return Object.keys(this._data.nodes).length
  }

  nodes(): ExperimentNode[] {
    return Object.values(this._data.nodes).map(node => clone(node))
  }

  get(id: string): ExperimentNode | undefined {
    const node = this._data.nodes[id]
    return node ? clone(node) : undefined
  }

  roots(): ExperimentNode[] {
    return this.nodes().filter(node => node.parentId === undefined)
  }

  children(parentId: string): ExperimentNode[] {
    return this.nodes().filter(node => node.parentId === parentId)
  }

  lineage(id: string): ExperimentNode[] {
    const path: ExperimentNode[] = []
    let cursor: ExperimentNode | undefined = this._data.nodes[id]
    while (cursor) {
      path.unshift(clone(cursor))
      cursor = cursor.parentId ? this._data.nodes[cursor.parentId] : undefined
    }
    return path
  }

  async add(node: ExperimentNode): Promise<void> {
    if (this._data.nodes[node.id]) {
      throw new Error(`experiment node already exists: ${node.id}`)
    }
    this._data.nodes[node.id] = clone(node)
    await this.save()
  }

  async update(node: ExperimentNode): Promise<void> {
    if (!this._data.nodes[node.id]) {
      throw new Error(`experiment node not found: ${node.id}`)
    }
    this._data.nodes[node.id] = clone(node)
    await this.save()
  }

  async setBaseline(nodeId: string): Promise<void> {
    if (!this._data.nodes[nodeId]) {
      throw new Error(`cannot set baseline for unknown node: ${nodeId}`)
    }
    this._data.baselineId = nodeId
    await this.save()
  }

  async fork(options: { parentId?: string; file?: string } = {}): Promise<ExperimentLog> {
    const data = clone(this._data)
    const parentId = options.parentId ?? data.baselineId
    if (parentId && !data.nodes[parentId]) {
      throw new Error(`cannot fork from unknown node: ${parentId}`)
    }
    const child: ExperimentLogData = {
      ...data,
      id: randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(parentId ? { baselineId: parentId } : {}),
    }
    return new ExperimentLog(options.file ?? this.file, child)
  }

  async replay(nodeId: string): Promise<ExperimentReplay> {
    const node = this.get(nodeId)
    if (!node) throw new Error(`experiment node not found: ${nodeId}`)
    const baseline = node.parentId ? this.get(node.parentId) : undefined
    return {
      node,
      diagnosis: diagnose(node.run),
      history: this.lineage(nodeId).map(item => item.id),
      ...(baseline ? { baseline } : {}),
    }
  }

  async save(): Promise<void> {
    this._data.updatedAt = Date.now()
    await saveJson(this.file, this._data)
  }

  private _empty(): ExperimentLogData {
    return {
      version: 1,
      id: randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nodes: {},
    }
  }
}
