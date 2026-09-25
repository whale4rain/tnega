import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import {
  BoxError,
  USER_ADDRESS,
  agentAddress,
  type BoxEnvelope,
} from '@tnega/box'
import { blackboardLocal } from '../../blackboard-local/src/index.js'
import { boxBlackboard } from '../src/index.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const coordinator = agentAddress('11111111-1111-4111-8111-111111111111')

async function mount(): Promise<Context> {
  const root_dir = await mkdtemp(join(tmpdir(), 'tnega-box-'))
  directories.push(root_dir)
  const root = new Context()
  await root.plugin(blackboardLocal, { root: root_dir })
  await root.plugin(boxBlackboard, { projectId: '22222222-2222-4222-8222-222222222222' })
  return root
}

it('writes the envelope and one delivery per recipient in one commit', async () => {
  const root = await mount()
  try {
    const envelope = await root.box.send({
      sender: USER_ADDRESS,
      recipients: [coordinator, USER_ADDRESS, coordinator],
      placement: { kind: 'main' },
      kind: 'user-message',
      text: 'Draft the release notes',
    })
    expect(envelope.recipients).toHaveLength(2)
    expect((await root.box.timeline()).map(entry => entry.messageId)).toEqual([envelope.messageId])
    expect((await root.box.inbox(coordinator)).map(entry => entry.messageId))
      .toEqual([envelope.messageId])
    expect(await root.box.delivery(envelope.messageId, USER_ADDRESS))
      .toMatchObject({ status: 'pending', attempts: 0 })
    // 用户也是一个地址：发给用户的信封同样有待投递记录，只是没有 Agent Session 去消费它。
    expect(await root.box.inbox(USER_ADDRESS)).toHaveLength(1)
  } finally {
    await root.fiber.dispose()
  }
})

it('stops returning an envelope from inbox once it is acked', async () => {
  const root = await mount()
  try {
    const envelope = await root.box.send({
      sender: coordinator,
      recipients: [agentAddress('33333333-3333-4333-8333-333333333333')],
      placement: { kind: 'main' },
      kind: 'agent-reply',
      text: 'Done',
    })
    const child = agentAddress('33333333-3333-4333-8333-333333333333')
    await root.box.markDelivered(envelope.messageId, child)
    await root.box.markDelivered(envelope.messageId, child)
    expect(await root.box.delivery(envelope.messageId, child))
      .toMatchObject({ status: 'delivered', attempts: 2 })
    expect(await root.box.inbox(child)).toHaveLength(1)
    await root.box.ack(envelope.messageId, child)
    await root.box.ack(envelope.messageId, child)
    expect(await root.box.inbox(child)).toHaveLength(0)
    expect(await root.box.delivery(envelope.messageId, child)).toMatchObject({ status: 'acked' })
  } finally {
    await root.fiber.dispose()
  }
})

it('is idempotent for a caller-supplied messageId', async () => {
  const root = await mount()
  try {
    const input = {
      sender: coordinator,
      recipients: [coordinator],
      placement: { kind: 'main' as const },
      kind: 'agent-reply' as const,
      text: 'Published once per Session event',
      messageId: 'deadbeefdeadbeefdeadbeefdeadbeef',
    }
    const first = await root.box.send(input)
    await root.box.ack(first.messageId, coordinator)
    const replay = await root.box.send(input)
    expect(replay).toEqual(first)
    expect(await root.box.timeline()).toHaveLength(1)
    const fact = await root.blackboard.read<BoxEnvelope>('message', first.messageId)
    expect(fact?.version).toBe(1)
    // 重复发布不得把已确认的投递重置成待投递。
    expect(await root.box.delivery(first.messageId, coordinator))
      .toMatchObject({ status: 'acked' })
    expect(await root.box.inbox(coordinator)).toHaveLength(0)
  } finally {
    await root.fiber.dispose()
  }
})

it('rejects malformed sends before touching the store', async () => {
  const root = await mount()
  try {
    await expect(root.box.send({
      sender: USER_ADDRESS,
      recipients: [],
      placement: { kind: 'main' },
      kind: 'user-message',
      text: 'hello',
    })).rejects.toBeInstanceOf(BoxError)
    await expect(root.box.send({
      sender: USER_ADDRESS,
      recipients: [coordinator],
      placement: { kind: 'main' },
      kind: 'user-message',
      text: '   ',
    })).rejects.toMatchObject({ code: 'BOX_INVALID' })
    expect(await root.box.timeline()).toEqual([])
    await expect(root.box.ack('nothing', coordinator)).rejects.toMatchObject({
      code: 'BOX_NOT_FOUND',
    })
  } finally {
    await root.fiber.dispose()
  }
})
