import { expect, it } from 'vitest'
import { sessionLink } from '../src/session-link.js'

it('links a session by id and workspace, the format the agent session tools read', () => {
  expect(sessionLink('/home/me/My App', 'abc-123')).toBe('tnega://session/abc-123?workspace=%2Fhome%2Fme%2FMy%20App')
})
