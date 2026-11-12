import { describe, expect, it } from 'vitest'
import { EYE_REACH, eyeOffset, welcomeGreeting } from './welcome'

describe('welcomeGreeting', () => {
  it('says hello by the time of day', () => {
    expect(welcomeGreeting(3, 'coding').hello).toBe('Working late.')
    expect(welcomeGreeting(9, 'coding').hello).toBe('Good morning.')
    expect(welcomeGreeting(14, 'coding').hello).toBe('Good afternoon.')
    expect(welcomeGreeting(20, 'coding').hello).toBe('Good evening.')
    expect(welcomeGreeting(23, 'coding').hello).toBe('Working late.')
  })

  it('asks a question that fits the agent', () => {
    expect(welcomeGreeting(9, 'coding').ask).toBe('What are we building?')
    expect(welcomeGreeting(9, 'work').ask).toBe('What can I take off your plate?')
    expect(welcomeGreeting(9, 'general').ask).toBe('What’s on your mind?')
  })
})

describe('eyeOffset', () => {
  it('rests when the pointer is on the cloud', () => {
    expect(eyeOffset(0, 0)).toEqual({ x: 0, y: 0 })
  })

  it('looks toward the pointer and never past its reach', () => {
    const right = eyeOffset(5000, 0)
    expect(right.x).toBeCloseTo(EYE_REACH)
    expect(right.y).toBeCloseTo(0)
    const near = eyeOffset(-80, 0)
    expect(near.x).toBeLessThan(0)
    expect(Math.abs(near.x)).toBeLessThan(EYE_REACH)
    const corner = eyeOffset(-4000, -4000)
    expect(Math.hypot(corner.x, corner.y)).toBeLessThanOrEqual(EYE_REACH)
  })
})
