import { expect, test } from 'claude-code/testing'
import { COMPACT_SUMMARY_TOKENS, DEFAULT_PRICES as P, atPrompt, dollars } from './cost'
import { TIP_STEPS, isTipId, TIP_FILL, TIP_NEXT, TIP_HIDE, TIP_START, TIP_WHY_ID, TIP_WHY, tipCommandAt, tipDue, tipSaving, tipText } from './coldtip'

// ---- The cold-compact tip (P-47): the pure part --------------------------------------------------------------

test('the saving: the cold write on the own model, less a compaction on Sonnet and the summary written back', async () => {
  const ctx = 150_000
  const want = dollars(atPrompt(P.opus, ctx), { cacheWrite: ctx }) - dollars(atPrompt(P.sonnet, ctx), { input: ctx, output: COMPACT_SUMMARY_TOKENS }) - dollars(P.opus, { cacheWrite: COMPACT_SUMMARY_TOKENS })
  expect(Math.abs(tipSaving(P, 'opus', ctx) - Math.max(0, want))).toBeLessThan(1e-9)
  expect(tipSaving(P, 'opus', 1000), 'a tiny conversation saves nothing').toBe(0)
})

test('due on Opus and Fable only, when the conversation fits Sonnet and the saving reaches the amount', async () => {
  const ctx = 150_000
  const s = tipSaving(P, 'opus', ctx)
  expect(s, 'a big Opus conversation saves something').toBeGreaterThan(0)
  expect(tipDue(P, 'opus', ctx, s)).toBe(s)
  expect(tipDue(P, 'opus', ctx, s + 0.01), 'under the amount').toBeUndefined()
  expect(tipDue(P, 'sonnet', ctx, 0), 'already on Sonnet').toBeUndefined()
  expect(tipDue(P, 'haiku', ctx, 0)).toBeUndefined()
  expect(tipDue(P, 'opus', 0, 0), 'no context').toBeUndefined()
  const small = { ...P, sonnet: { ...P.sonnet, window: 100_000 } }
  expect(tipDue(small, 'opus', ctx, 0), 'bigger than Sonnet\'s window').toBeUndefined()
})

test('the row says each step, and the command it waits for', async () => {
  expect(tipText(0, '~$0.45')).toBe('Cache is cold. Compact on Sonnet first to save ~$0.45 on your next prompt.')
  expect(tipText(1, '~$0.45')).toBe('Step 1 of 3: press Enter to send /model sonnet (it is in your prompt box).')
  expect(tipText(2, '~$0.45')).toBe('Step 2 of 3: press Enter to send /compact (it is in your prompt box), then press Next.')
  expect(tipText(3, '~$0.45')).toBe('Step 3 of 3: press Enter to send /model default (it is in your prompt box).')
  expect(tipText(4, '~$0.45')).toBe('Done: compacted on Sonnet, back on your usual model. Saved ~$0.45.')
  expect(TIP_STEPS).toEqual(['/model sonnet', '/compact', '/model default'])
  expect(tipCommandAt('/model sonnet')).toBe(1)
  expect(tipCommandAt('  /MODEL   Sonnet ')).toBe(1)
  expect(tipCommandAt('/compact')).toBe(2)
  expect(tipCommandAt('/model default')).toBe(3)
  expect(tipCommandAt('/compact keep the tests'), 'a compact with text is the person\'s own').toBeUndefined()
  expect(tipCommandAt('fix the bug')).toBeUndefined()
  expect(TIP_WHY(147_000, 'opus')).toContain('~147K tokens')
  for (const id of [TIP_START, TIP_FILL, TIP_NEXT, TIP_WHY_ID, TIP_HIDE]) expect(isTipId(id)).toBe(true)
  expect(isTipId('stop')).toBe(false)
})
