import { expect, test } from 'claude-code/testing'
import { ratingSystem, parseRating } from './rate'

const prompt = ratingSystem('opus', 'medium')

test('the rating reply carries `continues`, and the prompt says what it means', async () => {
  expect(prompt).toContain('"continues":<true|false>')
  expect(prompt).toMatch(/continues: true when the request carries on the task in <last_reply>/)
  // The rest of the shape is as before.
  for (const key of ['"fit"', '"type"', '"read"', '"write"', '"steps"', '"approval"', '"reason"']) expect(prompt, key).toContain(key)
})

test('`continues` reads true only when the answer is true; missing is false', async () => {
  const read = (extra: string) => parseRating(`{"fit":{"opus":"low"},"type":"feature"${extra}}`, 'opus')?.continues
  expect(read(',"continues":true')).toBe(true)
  expect(read(',"continues":false')).toBe(false)
  expect(read('')).toBe(false)
  expect(read(',"continues":"yes"'), 'only a real true counts').toBe(false)
})

test('Haiku guidance: clearly specified work fits, open-ended work does not, and "unsure" no longer forces "no"', async () => {
  expect(prompt).toContain('haiku for finding, listing and lookups, mechanical edits across files')
  expect(prompt).toContain('coding against a clear spec or a failing test')
  expect(prompt).toMatch(/Say "no" for haiku on open-ended review and hunting for subtle bugs, design with trade-offs, writing that is judged on style, and long requests where a key constraint comes last/)
  expect(prompt).toContain('When unsure whether a cheaper model fits work that is clearly specified, give it the level it needs; when the work is unclear or open-ended, say "no" for it.')
  expect(prompt, 'the old blanket rule is gone').not.toContain('When unsure whether a cheaper model fits, say "no" for it.')
  expect(prompt, 'the other rules stay').toContain('When unsure between two levels, pick the lower one.')
  expect(prompt).toContain('sonnet for routine coding and writing that needs some judgement')
})

test('the public prompt quotes no benchmark numbers or task names', async () => {
  const guidance = prompt.slice(prompt.indexOf('A stronger model fits'), prompt.indexOf('type: one of'))
  expect(guidance, 'no digits, no percentages').not.toMatch(/\d/)
  expect(prompt).not.toMatch(/benchmark|pass rate|\bruns?\b of/i)
})
