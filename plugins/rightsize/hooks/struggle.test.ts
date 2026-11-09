import { expect, test } from 'claude-code/testing'
import { type Signals, FAILED_TRIES, ERRORS, helperCap, isCapSetting, LIMITS, LONG_MIN, LONG_X, LOOP, NOVEL, RECENT_MAX, REPEAT, WINDOW, blockedError, callKey, isEditTool, isTestCommand, noSignals, noteCall, oneUp, refusedByPerson, struggle, testsOutcome } from './struggle'

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

// `keys` different calls, then the same calls again `rounds` times over: no edit, no passing test, and each
// call run `rounds` times. Keep `rounds` under the loop limit, or the loop sign fires first.
const going = (keys: number, rounds: number, s = noSignals(), name = 'file') => {
  for (let r = 0; r < rounds; r++) for (let k = 0; k < keys; k++) s = noteCall(s, bash(`cat ${name}${k}`), false)
  return s
}
const edit = (s: Signals, file = 'a.ts', isError = false) => noteCall(s, callKey('Edit', { file_path: file, old_string: 'x', new_string: 'y' }), isError, false, true)

test('a long turn: three times the rated steps, never under 15, and the last calls show no progress', async () => {
  // 6 calls, twice each: the last 10 hold 4 new calls and no progress.
  const s = going(6, 2)
  expect(struggle(s, 14, 2)).toBeUndefined()
  expect(struggle(s, 15, 2)).toEqual({ kind: 'long', why: 'the turn passed 15 steps, 3x the estimate, and the last 10 calls made no progress' })
  expect(struggle(s, 29, 10)).toBeUndefined()
  expect(struggle(s, 30, 10)?.kind).toBe('long')
})

test('a long turn that is working is not stuck: edits, a passing test, or new reads count as progress', async () => {
  const base = going(6, 2)
  expect(struggle(base, 40, 2)?.kind, 'the base case fires').toBe('long')
  expect(struggle(edit(base), 40, 2), 'a recent edit that worked').toBeUndefined()
  expect(struggle(edit(base, 'a.ts', true), 40, 2)?.kind, 'an edit that failed is not progress').toBe('long')
  const written = noteCall(base, callKey('Write', { file_path: 'b.ts', content: 'x' }), false, false, true)
  expect(struggle(written, 40, 2), 'a write counts').toBeUndefined()
  expect(struggle(noteCall(base, bash('npm test'), false, true), 40, 2), 'a passing test').toBeUndefined()
  expect(struggle(noteCall(base, bash('npm test'), true, true), 40, 2)?.kind, 'a failing test is not progress').toBe('long')
  // Research: every call is a new one.
  let research = noSignals()
  for (let i = 0; i < 20; i++) research = noteCall(research, bash(`cat file${i}`), false)
  expect(struggle(research, 40, 2), 'new reads are progress').toBeUndefined()
  // Half new is still enough at normal (the limit is the share below which it is stuck).
  let half = going(5, 1)
  for (let k = 0; k < 5; k++) half = noteCall(half, bash(`cat file${k}`), false)
  expect(struggle(half, 40, 2), '5 of 10 new').toBeUndefined()
})

test('the check slides: progress that falls out of the window stops counting, and a stall after a busy stretch is caught', async () => {
  // 10 different reads, an edit, then the same 10 reads again: none of the last 10 is new or progress.
  const first = going(5, 1, going(5, 1, noSignals(), 'file'), 'other')
  let s = edit(first)
  expect(struggle(s, 40, 2), 'the edit is in the window').toBeUndefined()
  s = going(5, 1, going(5, 1, s, 'file'), 'other')
  expect(s.recent?.slice(-10).some(r => r.progress), 'the edit is 10 calls back').toBe(false)
  expect(struggle(s, 40, 2)?.kind).toBe('long')
  expect(struggle(edit(s, 'c.ts'), 40, 2), 'a new edit starts it over').toBeUndefined()
})

test('a long turn needs a full window of calls and the step threshold, both', async () => {
  const s = going(6, 2)
  expect(struggle(s, 14, 2), 'below the threshold, no progress').toBeUndefined()
  expect(struggle(going(4, 2), 40, 2), '8 calls: the window of 10 is not full').toBeUndefined()
  expect(struggle(noSignals(), 40, 2), 'no calls recorded').toBeUndefined()
  expect(struggle({ errors: 0, calls: {}, fired: [] }, 40, 2), 'an old shape without a record').toBeUndefined()
  expect(struggle(going(6, 2), 15, 2)?.kind, 'a full window at the threshold').toBe('long')
})

test('the record of recent calls keeps the newest, bounded', async () => {
  let s = noSignals()
  for (let i = 0; i < 40; i++) s = noteCall(s, bash(`cat file${i}`), false)
  expect(s.recent).toHaveLength(RECENT_MAX)
  expect(RECENT_MAX, 'the window').toBe(LIMITS.window)
  // The newest call is last: an edit, then a repeat of it.
  s = edit(s)
  s = edit(s)
  expect(s.recent?.slice(-2)).toEqual([{ novel: true, progress: true }, { novel: false, progress: true }])
  expect(s.recent).toHaveLength(RECENT_MAX)
  expect(s.recent?.[0], 'the oldest went first').toEqual({ novel: true, progress: false })
  expect(isEditTool('Edit') && isEditTool('Write') && isEditTool('MultiEdit') && isEditTool('NotebookEdit')).toBe(true)
  expect(isEditTool('Read') || isEditTool('Bash')).toBe(false)
})

test('one level up, never to max', async () => {
  expect(oneUp('low')).toBe('medium')
  expect(oneUp('high')).toBe('xhigh')
  expect(oneUp('xhigh')).toBeUndefined()
  expect(oneUp('max')).toBeUndefined()
})

test('the stuck limits: one set of values, and the signs fire at them', async () => {
  expect(LIMITS).toEqual({ repeat: 2, errors: 3, loop: 3, longX: 3, longMin: 15, window: 10, novel: 0.5, failedTries: 2 })
  expect(LIMITS).toEqual({ repeat: REPEAT, errors: ERRORS, loop: LOOP, longX: LONG_X, longMin: LONG_MIN, window: WINDOW, novel: NOVEL, failedTries: FAILED_TRIES })

  // `n` different calls, each failing once.
  const failing = (n: number, key: string) => {
    let s = noSignals()
    for (let i = 0; i < n; i++) s = noteCall(s, bash(`${key}${i}`), true)
    return s
  }
  // The same call failing.
  const twice = noteCall(noteCall(noSignals(), bash('npm test'), true), bash('npm test'), true)
  expect(struggle(twice, 3, 5)?.why).toBe('the same tool call failed twice')
  expect(struggle(noteCall(noSignals(), bash('npm test'), true), 3, 5), 'once is ordinary').toBeUndefined()

  // Failures of different calls.
  expect(struggle(failing(2, 'x'), 3, 5), 'two is ordinary').toBeUndefined()
  expect(struggle(failing(3, 'x'), 3, 5)).toEqual({ kind: 'errors', why: '3 tool calls failed' })

  // The same call going round.
  const ran = (n: number) => {
    let s = noSignals()
    for (let i = 0; i < n; i++) s = noteCall(s, bash('ls'), false)
    return s
  }
  expect(struggle(ran(2), 3, 5)).toBeUndefined()
  expect(struggle(ran(3), 3, 5)).toEqual({ kind: 'loop', why: 'the same tool call ran 3 times' })

  // A long turn with no progress: the steps decide past the minimum (10 rated steps), and progress stops it.
  const rel = going(6, 2)
  expect([struggle(rel, 29, 10), struggle(rel, 30, 10)?.kind]).toEqual([undefined, 'long'])
  expect(struggle(edit(rel), 30, 10)).toBeUndefined()
  expect(struggle(rel, 15, 2)?.why).toBe('the turn passed 15 steps, 3x the estimate, and the last 10 calls made no progress')
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

test('blockedError: the environment (permission, sandbox, network, access, a missing program) is not struggling', async () => {
  const blocked = [
    'bash: /etc/hosts: Operation not permitted',
    "Error: EACCES: permission denied, open '/usr/local/lib/x'",
    'rm: cannot remove build: Permission denied',
    'The command was blocked by the sandbox: write outside the allowed directories',
    'Sandbox denied access to /var/db/data',
    'fatal: unable to access the package host: Could not resolve host: package.example.com',
    'getaddrinfo ENOTFOUND registry.npmjs.org',
    'connect ECONNREFUSED 127.0.0.1:5432',
    'npm ERR! code ETIMEDOUT',
    'ssh: connect to host example.com port 22: Network is unreachable',
    'HTTP 401 from the service',
    'fatal: unable to access the package host: The requested URL returned error: 403',
    'Error: not signed in',
    'Authentication required for the repository',
    'Authentication failed for the repository',
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
    'FAIL src/session.test.ts\n  expected 401 to equal 200',
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
    'python tests/runtests.py template_tests --parallel 1',
    'cd /repo && python tests/runtests.py auth_tests.test_management --parallel 1',
    'python3 ./tests/runtests.py basic.tests',
    'python manage.py test app',
    './manage.py test',
    'django-admin test',
    'python -m django test',
    'tox -e py312',
    'nox -s tests',
    'bundle exec rspec',
    'rake test',
    'bin/rails test',
    'vendor/bin/phpunit',
    'dotnet test',
    'swift test',
    'mix test',
    'deno test',
    './gradlew test',
    'ctest --output-on-failure',
    'make check',
    'npx playwright test',
    'mocha',
  ]) expect(isTestCommand('Bash', { command }), command).toBe(true)
  for (const command of ['npm install', 'python manage.py migrate', 'python tests/helper.py', 'cat tests/runtests.py', 'echo tox', 'toxic --help', 'make checkout','npm run build', 'ls tests', 'echo npm test', 'fail npm test', 'git commit -m "npm test"', 'cat jest.config.js', 'make testdata', 'pytest-cov --help'])
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
  s = noteCall(s, test, true, true)
  expect(struggle(s, 4, 5)?.kind, 'the third time').toBe('repeat-fail')
  expect(struggle(s, 4, 5)?.why).toBe('the same test run failed 3 times')
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
  expect(struggle({ ...s, fired: [...s.fired] }, 3, 5, LIMITS, Infinity)?.kind).toBe('repeat-fail')
})

test('refusedByPerson: a call the person said no to at the permission prompt, in either of core\'s wordings', async () => {
  expect(refusedByPerson("The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.")).toBe(true)
  expect(refusedByPerson("The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nuse the other branch")).toBe(true)
  expect(refusedByPerson('User rejected tool use')).toBe(true)
  for (const text of ['boom', 'rm: cannot remove build: Permission denied', 'error: the user rejected the merge request in review', '']) expect(refusedByPerson(text), text).toBe(false)
})

test('the last test run in a turn is its objective outcome', async () => {
  let s = noteCall(noSignals(), bash('npm test'), true, true)
  expect(testsOutcome(s)).toBe('failed')
  s = noteCall(s, bash('ls'), false)
  expect(testsOutcome(s), 'a later non-test call changes nothing').toBe('failed')
  s = noteCall(s, bash('npm test'), false, true)
  expect(testsOutcome(s)).toBe('passed')
  expect(testsOutcome(noteCall(noSignals(), bash('ls'), true)), 'no test run: no outcome').toBeUndefined()
})

test('helper call cap: Haiku 25 and Sonnet 40 by default, tight and loose move both, off and a tier with no entry have none', () => {
  expect([helperCap('normal', 'haiku'), helperCap('normal', 'sonnet')]).toEqual([25, 40])
  expect([helperCap('tight', 'haiku'), helperCap('tight', 'sonnet')]).toEqual([15, 25])
  expect([helperCap('loose', 'haiku'), helperCap('loose', 'sonnet')]).toEqual([40, 60])
  expect([helperCap('off', 'haiku'), helperCap('off', 'sonnet')]).toEqual([undefined, undefined])
  expect([helperCap('normal', 'opus'), helperCap('normal', 'fable')], 'a stronger tier has no cap').toEqual([undefined, undefined])
  expect([isCapSetting('tight'), isCapSetting('nope'), isCapSetting(undefined)]).toEqual([true, false, false])
})

test('failed-check: fixes that keep leaving the tests red are a sign; how many calls a fix takes does not matter; a green run resets it', async () => {
  const edit = (s: Signals, f: string) => noteCall(s, callKey('Edit', { file_path: f }), false, false, true)
  const red = (s: Signals, cmd = 'npm test') => noteCall(s, bash(cmd), true, true)
  const green = (s: Signals) => noteCall(s, bash('npm test'), false, true)
  // The first red is not an attempt; reading and editing for any number of calls after it is not one either.
  let s = red(noSignals())
  expect([s.failedTries, s.editedSinceRed]).toEqual([0, false])
  for (let i = 0; i < 12; i++) s = noteCall(s, bash(`cat f${i}`), false)
  s = edit(s, 'a.ts')
  expect(s.editedSinceRed).toBe(true)
  expect(struggle(s, 15, 5), 'many calls after a red run, still fixing: not a sign').toBeUndefined()
  // Red again after an edit: one failed attempt. The sign waits for FAILED_TRIES of them; a different test command still counts.
  s = red(s, 'pytest tests/x.py')
  expect([s.failedTries, s.editedSinceRed]).toEqual([1, false])
  expect(struggle(s, 16, 5), 'one failed fix is not yet a sign').toBeUndefined()
  // The same red again with no edit between is not another attempt.
  s = red(s, 'pytest tests/x.py')
  expect(s.failedTries).toBe(1)
  s = edit(s, 'b.ts')
  s = red(s, 'pytest tests/y.py')
  expect(s.failedTries).toBe(2)
  expect(struggle(s, 19, 5)).toEqual({ kind: 'failed-check', why: `${FAILED_TRIES} fixes in a row left the tests red` })
  expect(struggle({ ...s, fired: ['failed-check'] }, 19, 5), 'fires once a turn').toBeUndefined()
  // A green run ends it; a later red starts over from nothing.
  const g = green(s)
  expect([g.failedTries, g.editedSinceRed]).toEqual([undefined, undefined])
  expect(struggle(g, 20, 5)).toBeUndefined()
  const again = red(edit(g, 'c.ts'))
  expect(again.failedTries, 'an edit after a green run does not arm the next red').toBe(0)
  // A turn with no test run never fires it; an edit before any red does nothing.
  let none = edit(noSignals(), 'z.ts')
  for (let i = 0; i < 10; i++) none = noteCall(none, bash(`cat h${i}`), false)
  expect([none.failedTries, none.editedSinceRed]).toEqual([undefined, undefined])
  expect(struggle(none, 11, 5)).toBeUndefined()
})
