import { expect, test } from 'claude-code/testing'
import type { RunLine } from './report'
import { SHARE_BATCH, hashRef, newInstall, nextBatch, shareEvent } from './share'

const I = 'c'.repeat(32)
const at = (m: number) => new Date(Date.parse('2026-10-24T18:00:00.000Z') + m * 60_000).toISOString()

test('an install id is 32 random hex characters', async () => {
  expect(newInstall()).toMatch(/^[a-f0-9]{32}$/)
  expect(newInstall()).not.toBe(newInstall())
  expect(newInstall(b => b.fill(0xab)), 'bytes become hex').toBe('ab'.repeat(16))
})

test('a run id is hashed per install, so a 👍/👎 still finds its run', async () => {
  expect(hashRef(I, 'sess:1')).toMatch(/^[a-f0-9]{16}$/)
  expect(hashRef(I, 'sess:1')).toBe(hashRef(I, 'sess:1'))
  expect(hashRef('d'.repeat(32), 'sess:1')).not.toBe(hashRef(I, 'sess:1'))
  const run = shareEvent({ at: at(0), kind: 'run', id: 'sess:1', type: 'debug' }, I)
  const vote = shareEvent({ at: at(1), kind: 'feedback', ref: 'sess:1', value: 'down' }, I)
  expect(vote?.ref).toBe(run?.ref)
})

test('a run keeps numbers and labels only: no session, fixed context, reasons or paths', async () => {
  const line = {
    at: at(0),
    kind: 'run',
    id: 'sess:1',
    session: 'sess',
    type: 'debug',
    tier: 'opus',
    level: 'medium',
    route: 'delegate:sonnet',
    subLevel: 'high',
    fit: { sonnet: 'high' },
    actual: 0.5,
    fixed: { tokens: 1, servers: { private_mcp: 1 } },
    escalations: [{ step: 1, from: 'low', to: 'medium', why: 'cat /Users/me/secret.txt failed' }],
    tie: { by: 'guide', over: 'opus' },
  } as unknown as RunLine
  const e = shareEvent(line, I) ?? {}
  expect(Object.keys(e).sort()).toEqual(['actual', 'at', 'escalations', 'fit', 'kind', 'level', 'ref', 'route', 'subLevel', 'tie', 'tier', 'type'])
  expect(e.escalations).toBe(1)
  expect(e.tie).toBe('guide')
  expect(JSON.stringify(e)).not.toMatch(/sess|private_mcp|secret/)
  expect(shareEvent({ at: at(0), kind: 'overhead', overhead: 0.001 }, I), 'overhead lines are not shared').toBeUndefined()
})

test('the next batch starts after the last send, holds at most 100, and moves past unshared lines', async () => {
  const lines: RunLine[] = [{ at: at(0), kind: 'run' }, { at: at(1), kind: 'overhead' }, { at: at(2), kind: 'run' }, { at: at(3), kind: 'subagent' }]
  expect(nextBatch(lines, I, at(0))).toEqual({ events: [{ kind: 'run', at: at(2) }], upTo: at(3) })
  expect(nextBatch(lines, I, at(3))).toEqual({ events: [], upTo: undefined })
  const many: RunLine[] = Array.from({ length: 150 }, (_, i) => ({ at: at(i), kind: 'run' }))
  const first = nextBatch(many, I, undefined)
  expect(first.events.length).toBe(SHARE_BATCH)
  expect(first.upTo, 'the 100th line').toBe(at(99))
  expect(nextBatch(many, I, first.upTo).events.length).toBe(50)
})
