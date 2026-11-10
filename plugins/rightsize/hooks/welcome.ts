// The welcome (ADR 0039): a table of what rightsize does, shown once after install and again with /rightsize welcome.
// Modeled on whatsnext's first-run welcome. Pure: no engine calls. Every claim here is a row of docs/FEATURES.md.

import { FEATURES } from './tips'

/** `$.store` key: true once the welcome was shown, so it shows once per install. */
export const WELCOMED_KEY = 'welcomed'

const HEAD = ['What you get', 'How it works'] as const
/** The plain-text columns: 71 wide, so the terminal's 5-column indent of a command row still fits 80. */
const WIDTHS = [22, 46] as const

/** The rows; the first FIRST are the ones to learn first, and a rule follows them. */
export const ROWS: readonly (readonly [string, string])[] = [
  ['Right model and effort', 'Sonnet rates each prompt in about one second. The cheapest model and effort that fits wins.'],
  ['Every choice visible', 'The band says what changed and what it cost. Retry undoes it.'],
  ['Savings report', '/rightsize report shows hours of work and 5-hour windows saved on a subscription, and dollars on the API.'],
  ['Try it first', "Set Mode to watch only in /rightsize. rightsize then changes nothing and shows what it would have done."],
  ['More effort when stuck', 'When a turn shows Claude is stuck, effort goes up one level for that turn.'],
  ['Helper hand-offs', 'Routine work goes from Opus to a cheaper helper, and the main chat checks the result.'],
  ['Keep warm', 'Keeps the prompt cache warm while you are away, when that costs less than coming back to a cold cache.'],
  ['Learns your work', 'Real usage and your 👍 or 👎 make the estimates more accurate.'],
  ['Local only', 'Logs stay on your machine. Nothing goes to the author. Web requests: the monthly price check, and a GitHub star check through your own gh once rightsize has saved you something.'],
]
const FIRST = 5

/** Words wrapped to `width` columns; a word longer than that stands on its own line. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function row(cells: readonly string[]): string[] {
  const wrapped = cells.map((c, i) => wrap(c, WIDTHS[i] ?? 20))
  const height = Math.max(...wrapped.map(w => w.length))
  return Array.from({ length: height }, (_, i) =>
    wrapped
      .map((w, j) => (w[i] ?? '').padEnd(WIDTHS[j] ?? 20))
      .join(' | ')
      .trimEnd(),
  )
}

const INTRO = 'Each prompt runs on the cheapest model and effort that does it well. The band shows every choice, and you can undo it.'
const STEPS = [
  'Work as usual. The band says what rightsize changed.',
  'Not happy with a choice? Press **Retry at original effort** on the band.',
  'Run `/rightsize report` to see the hours of work saved.',
]
const plain = (md: string) => md.replace(/\*\*|`/g, '')

/** The whole welcome as Markdown: what the Welcome pane and the /rightsize welcome row draw on every surface. */
export function welcomeMarkdown(): string {
  const table = (rows: readonly (readonly [string, string])[]) => ['| What you get | How it works |', '|---|---|', ...rows.map(([a, b]) => `| ${a} | ${b} |`)]
  return [
    '**rightsize: the right model and effort for each prompt**',
    '',
    INTRO,
    '',
    '**The short version**',
    '',
    ...STEPS.map((x, i) => `${i + 1}. ${x}`),
    '',
    '**Learn these first**',
    '',
    ...table(ROWS.slice(0, FIRST)),
    '',
    '**Also**',
    '',
    ...table(ROWS.slice(FIRST)),
    '',
    `See this again any time: \`/rightsize welcome\`. All features: [FEATURES.md](${FEATURES})`,
  ].join('\n')
}

/** The whole welcome as plain text, within 71 columns: for a surface that draws no Markdown (a -p run, the SDK). */
export function welcomeText(): string {
  const rule = WIDTHS.map(w => '-'.repeat(w)).join('-+-')
  const out = [
    'rightsize: the right model and effort for each prompt',
    '',
    ...wrap(INTRO, 71),
    '',
    'The short version:',
    ...STEPS.flatMap((x, i) => wrap(plain(x), 66).map((l, j) => `${j === 0 ? `  ${i + 1}. ` : '     '}${l}`)),
    '',
    ...row(HEAD),
    rule,
  ]
  ROWS.forEach((r, i) => {
    out.push(...row(r))
    if (i === FIRST - 1) out.push(rule)
  })
  out.push('', 'See this again any time: /rightsize welcome.', 'All features:', FEATURES)
  return out.join('\n')
}
