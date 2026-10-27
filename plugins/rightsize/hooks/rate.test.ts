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

test('the prompt has one effort sentence: routine debugging does not need more than medium, subtle or high-stakes work does', async () => {
  expect(prompt).toContain("Effort: routine debugging with a clear symptom does not need a higher level than the model's medium; raise the level for subtle bugs, hard reasoning or high stakes.")
})

test('a broken ending after the last complete field is cut, and the object closed again', async () => {
  const body = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"type":"lookup","read":2000,"write":300,"steps":1,"approval":false,"continues":false,"reason":"simple lookup"'
  const whole = parseRating(`${body}}`, 'sonnet')
  expect(whole?.type).toBe('lookup')
  for (const ending of [',"}', ',"sonnet"}', ',}', ', }', ',\n}']) {
    expect(parseRating(`${body}${ending}`, 'sonnet'), JSON.stringify(ending)).toEqual(whole)
  }
  // Inside a code fence or with prose around it, as before.
  expect(parseRating('```json\n' + body + ',"}\n```', 'sonnet')).toEqual(whole)
  // A last field that is a number or a boolean.
  expect(parseRating('{"fit":{"opus":"low"},"type":"feature","steps":3,"continues":true,"}', 'opus')?.continues).toBe(true)
})

test('the parser stays strict: no value is guessed, and garbage is still refused', async () => {
  const ok = '{"fit":{"opus":"low"},"type":"feature","reason":"x"'
  expect(parseRating(`${ok},"fit"}`, 'opus')?.type, 'a dangling key is dropped, not given a value').toBe('feature')
  for (const bad of [
    `${ok},"sonnet":}`, // a key with no value
    `${ok},"a":"b}`, // a value cut in the middle
    `${ok},,}`,
    `${ok} nonsense}`,
    `${ok},"sonnet"`, // no closing brace at all
    '{"fit":{"opus":"low"},"type":"feature"',
    '{"fit":{"opus":"low"},"type":"feature","reason":"unfinished,"}}x',
    'not json {oops}',
    '{,"}',
    '[1,2,3]',
    '{"fit":{"opus":"maybe"},"type":"feature"}',
  ]) {
    expect(parseRating(bad, 'opus'), JSON.stringify(bad)).toBeUndefined()
  }
})
