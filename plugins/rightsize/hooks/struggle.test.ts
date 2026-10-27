import { expect, test } from 'claude-code/testing'
import { ERRORS, LIMITS, LONG_MIN, LONG_X, LOOP, REPEAT, blockedError, callKey, isSensitivity, isTestCommand, noSignals, noteCall, oneUp, struggle } from './struggle'

// Claude labels each Bash call afresh, so the description differs between runs of one command.
const bash = (command: string) => callKey('Bash', { tool: 'Bash', tool_use_id: Math.random().toString(), command, description: `run ${command} (${Math.random()})` })

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

test('Stuck sensitivity: normal is today\'s thresholds, relaxed waits for more, sensitive for less', async () => {
  expect(LIMITS.normal).toEqual({ repeat: 2, errors: 3, loop: 3, longX: 3, longMin: 15 })
  expect(LIMITS.normal).toEqual({ repeat: REPEAT, errors: ERRORS, loop: LOOP, longX: LONG_X, longMin: LONG_MIN })
  for (const k of Object.keys(LIMITS.normal) as (keyof typeof LIMITS.normal)[]) {
    expect(LIMITS.relaxed[k], `relaxed ${k}`).toBeGreaterThanOrEqual(LIMITS.normal[k])
    expect(LIMITS.sensitive[k], `sensitive ${k}`).toBeLessThanOrEqual(LIMITS.normal[k])
  }
  expect(isSensitivity('relaxed') && isSensitivity('normal') && isSensitivity('sensitive')).toBe(true)
  expect(isSensitivity('on') || isSensitivity('toString')).toBe(false)

  // `n` different calls, each failing once.
  const failing = (n: number, key: string) => {
    let s = noSignals()
    for (let i = 0; i < n; i++) s = noteCall(s, bash(`${key}${i}`), true)
    return s
  }
  // The same call failing.
  const twice = noteCall(noteCall(noSignals(), bash('npm test'), true), bash('npm test'), true)
  expect(struggle(twice, 3, 5, LIMITS.normal)?.why).toBe('the same tool call failed twice')
  expect(struggle(twice, 3, 5, LIMITS.sensitive)?.why).toBe('the same tool call failed twice')
  expect(struggle(twice, 3, 5, LIMITS.relaxed), 'twice is not enough to a relaxed one').toBeUndefined()
  const thrice = noteCall(twice, bash('npm test'), true)
  expect(struggle(thrice, 3, 5, LIMITS.relaxed)).toEqual({ kind: 'repeat-fail', why: 'the same tool call failed 3 times' })

  // Failures of different calls.
  const two = failing(2, 'x')
  expect(struggle(two, 3, 5, LIMITS.normal), 'two is ordinary').toBeUndefined()
  expect(struggle(two, 3, 5, LIMITS.sensitive)).toEqual({ kind: 'errors', why: '2 tool calls failed' })
  const three = failing(3, 'x')
  expect(struggle(three, 3, 5, LIMITS.normal)?.kind).toBe('errors')
  expect(struggle(three, 3, 5, LIMITS.relaxed), 'three is not enough to a relaxed one').toBeUndefined()
  expect(struggle(failing(4, 'x'), 3, 5, LIMITS.relaxed)).toEqual({ kind: 'errors', why: '4 tool calls failed' })

  // The same call going round.
  const ran = (n: number) => {
    let s = noSignals()
    for (let i = 0; i < n; i++) s = noteCall(s, bash('ls'), false)
    return s
  }
  expect(struggle(ran(2), 3, 5, LIMITS.normal)).toBeUndefined()
  expect(struggle(ran(2), 3, 5, LIMITS.sensitive)).toEqual({ kind: 'loop', why: 'the same tool call ran 2 times' })
  expect(struggle(ran(3), 3, 5, LIMITS.relaxed)).toBeUndefined()
  expect(struggle(ran(4), 3, 5, LIMITS.relaxed)?.why).toBe('the same tool call ran 4 times')

  // A long turn.
  const none = noSignals()
  expect([struggle(none, 9, 2, LIMITS.sensitive), struggle(none, 10, 2, LIMITS.sensitive)?.why]).toEqual([undefined, 'the turn passed 10 steps, 2x the estimate'])
  expect(struggle(none, 19, 2, LIMITS.relaxed)).toBeUndefined()
  expect(struggle(none, 20, 2, LIMITS.relaxed)?.why).toBe('the turn passed 20 steps, 4x the estimate')
  // Past the minimum, the multiple of the rated steps decides: 10 rated steps.
  expect([struggle(none, 19, 10, LIMITS.sensitive), struggle(none, 20, 10, LIMITS.sensitive)?.kind]).toEqual([undefined, 'long'])
  expect([struggle(none, 39, 10, LIMITS.relaxed), struggle(none, 40, 10, LIMITS.relaxed)?.kind]).toEqual([undefined, 'long'])
  // Without limits given: normal.
  expect(struggle(none, 15, 2)?.why).toBe('the turn passed 15 steps, 3x the estimate')
})

test('a raise stops at Highest effort, and never goes past xhigh', async () => {
  expect(oneUp('low', 'high')).toBe('medium')
  expect(oneUp('medium', 'high')).toBe('high')
  expect(oneUp('high', 'high'), 'at the ceiling').toBeUndefined()
  expect(oneUp('xhigh', 'high'), 'over the ceiling already').toBeUndefined()
  expect(oneUp('high', 'xhigh')).toBe('xhigh')
  expect(oneUp('high', 'max'), 'a mid-turn raise never reaches max').toBe('xhigh')
  expect(oneUp('xhigh', 'max')).toBeUndefined()
  expect(oneUp('medium'), 'no ceiling given: as before').toBe('high')
})

test('blockedError: the environment (permission, sandbox, network, login, a missing program) is not struggling', async () => {
  const blocked = [
    'bash: /etc/hosts: Operation not permitted',
    "Error: EACCES: permission denied, open '/usr/local/lib/x'",
    'rm: cannot remove build: Permission denied',
    'The command was blocked by the sandbox: write outside the allowed directories',
    'Sandbox denied access to ~/.ssh',
    'curl: (6) Could not resolve host: registry.example.com',
    'getaddrinfo ENOTFOUND registry.npmjs.org',
    'connect ECONNREFUSED 127.0.0.1:5432',
    'npm ERR! code ETIMEDOUT',
    'ssh: connect to host example.com port 22: Network is unreachable',
    'HTTP 401 from https://api.example.com/v1/items',
    'curl: The requested URL returned error: 403 Forbidden',
    'Error: not logged in. Run `gh auth login`.',
    'Authentication failed for https://github.com/x/y.git',
    'zsh: command not found: jq',
    'bash: pnpm: command not found',
  ]
  for (const text of blocked) expect(blockedError(text), text).toBe(true)
})

test('blockedError: the work failing, or a file the model got wrong, is not blocked', async () => {
  const ordinary = [
    'boom',
    'cat: src/confg.ts: No such file or directory',
    'bash: ./scripts/buid.sh: No such file or directory',
    'FAIL src/auth.test.ts\n  expected 401 to equal 200',
    'src/parse.ts:403:12 - error TS2322: Type string is not assignable to type number.',
    'AssertionError: expected "a" to equal "b"',
    'SyntaxError: Unexpected token } in JSON at position 401',
    'error: pathspec \'feature\' did not match any file(s) known to git',
    '',
  ]
  for (const text of ordinary) expect(blockedError(text), JSON.stringify(text)).toBe(false)
})

test('isTestCommand: a Bash call that starts a test runner', async () => {
  for (const command of [
    'npm test',
    'npm run test -- --watch=false',
    'pnpm test',
    'yarn test',
    'bun test',
    'npx vitest run',
    'vitest',
    'jest --ci',
    'pytest -x',
    'python -m pytest tests/',
    'python3 -m unittest',
    'go test ./...',
    'cargo test',
    'claude plugin test plugins/rightsize',
    'mvn test',
    'gradle test',
    'rspec spec/',
    'make test',
    'cd app && npm test',
    'CI=1 npm test',
    'npm run build; pytest',
    'uv run pytest',
  ]) expect(isTestCommand('Bash', { command }), command).toBe(true)
  for (const command of ['npm install', 'npm run build', 'ls tests', 'echo npm test', 'fail npm test', 'git commit -m "npm test"', 'cat jest.config.js', 'make testdata', 'pytest-cov --help'])
    expect(isTestCommand('Bash', { command }), command).toBe(false)
  expect(isTestCommand('Read', { command: 'npm test' }), 'only a Bash call').toBe(false)
  expect(isTestCommand('Bash', {}), 'no command').toBe(false)
})

test('a failing test run adds nothing to errors, however many different ones fail', async () => {
  let s = noSignals()
  for (const c of ['npm test -- a', 'npm test -- b', 'pytest c', 'go test d']) s = noteCall(s, bash(c), true, true)
  expect(s.errors).toBe(0)
  expect(struggle(s, 5, 5), 'four red test runs, none the same: not several tool calls failing').toBeUndefined()
  // Any other call still counts, test runs around it or not.
  s = noteCall(s, bash('ls x'), true)
  expect(s.errors).toBe(1)
})

test('a failing test run needs one more repeat before the same call counts as failing again', async () => {
  const test = bash('npm test')
  let s = noteCall(noSignals(), test, true, true)
  s = noteCall(s, test, true, true)
  expect(struggle(s, 3, 5), 'twice is an expected red').toBeUndefined()
  expect(struggle(s, 3, 5, LIMITS.sensitive)?.kind, 'sensitive: still one more than a plain call').not.toBe('repeat-fail')
  s = noteCall(s, test, true, true)
  expect(struggle(s, 4, 5)?.kind, 'the third time').toBe('repeat-fail')
  expect(struggle(s, 4, 5)?.why).toBe('the same test run failed 3 times')
  expect(struggle(s, 4, 5, LIMITS.relaxed), 'relaxed waits for 4').toBeUndefined()
  // The call is the same call, run or not: a plain call keeps the old limit.
  const plain = noteCall(noteCall(noSignals(), bash('make'), true), bash('make'), true)
  expect(struggle(plain, 3, 5)?.why).toBe('the same tool call failed twice')
})

test('running the same test command again is not going round: red, red, green is the normal cycle', async () => {
  const test = bash('npm test')
  let s = noteCall(noteCall(noSignals(), test, true, true), test, true, true)
  s = noteCall(s, test, false, true)
  expect(struggle(s, 4, 5), 'two reds, then green').toBeUndefined()
  for (let i = 0; i < 5; i++) s = noteCall(s, test, false, true)
  expect(struggle(s, 9, 5), 'any number of green runs').toBeUndefined()
  const plain = noteCall(noteCall(noteCall(noSignals(), bash('ls'), false), bash('ls'), false), bash('ls'), false)
  expect(struggle(plain, 4, 5)?.kind, 'a plain call three times still goes round').toBe('loop')
})

test('struggle takes the turn\'s cap on raises: a helper\'s cap is the task\'s budget, so it passes none', async () => {
  const s = { ...noteCall(noteCall(noSignals(), bash('a'), true), bash('a'), true), fired: ['errors', 'loop'] as const }
  expect(struggle({ ...s, fired: [...s.fired] }, 3, 5), 'two raised: the turn is done').toBeUndefined()
  expect(struggle({ ...s, fired: [...s.fired] }, 3, 5, LIMITS.normal, Infinity)?.kind).toBe('repeat-fail')
})
