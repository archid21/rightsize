import { expect, test } from 'claude-code/testing'
import { callKey, noSignals, noteCall, oneUp, struggle } from './struggle'

const bash = (command: string) => callKey('Bash', { tool: 'Bash', tool_use_id: Math.random().toString(), command })

test('the same call failing twice is the first sign', async () => {
  let s = noSignals()
  s = noteCall(s, bash('npm test'), true)
  expect(struggle(s, 2, 5), 'one failure is ordinary').toBeUndefined()
  s = noteCall(s, bash('npm test'), true)
  expect(struggle(s, 3, 5)?.kind, 'the call id does not make it a different call').toBe('repeat-fail')
})

test('three failures of different calls count; each kind raises once, two raises a turn at most', async () => {
  let s = noSignals()
  for (const c of ['a', 'b', 'c']) s = noteCall(s, bash(c), true)
  expect(struggle(s, 4, 5)).toEqual({ kind: 'errors', why: '3 tool calls failed' })
  s = { ...s, fired: ['errors'] }
  expect(struggle(s, 4, 5), 'fired already').toBeUndefined()
  for (let i = 0; i < 3; i++) s = noteCall(s, bash('ls'), false)
  expect(struggle(s, 6, 5)?.kind, 'the same call going round, failing or not').toBe('loop')
  s = { ...s, fired: ['errors', 'loop'] }
  expect(struggle(s, 40, 5), 'two raises already').toBeUndefined()
})

test('a long turn: three times the rated steps, never under 15', async () => {
  const s = noSignals()
  expect(struggle(s, 14, 2)).toBeUndefined()
  expect(struggle(s, 15, 2)?.why).toBe('the turn passed 15 steps, 3x the estimate')
  expect(struggle(s, 29, 10)).toBeUndefined()
  expect(struggle(s, 30, 10)?.kind).toBe('long')
})

test('one level up, never to max', async () => {
  expect(oneUp('low')).toBe('medium')
  expect(oneUp('high')).toBe('xhigh')
  expect(oneUp('xhigh')).toBeUndefined()
  expect(oneUp('max')).toBeUndefined()
})
