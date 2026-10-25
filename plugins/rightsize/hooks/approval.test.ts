import { expect, test } from 'claude-code/testing'
import { isApprovalStep } from './approval'

const bash = (command: string) => isApprovalStep('Bash', { command })

test('finds the steps only the person can approve', async () => {
  for (const c of ['git push origin main', 'git push --tags', 'gh release create v1 --notes x', 'gh pr merge 2 --squash', 'npm publish', 'vercel deploy --prod --yes', 'claude plugin tag plugins/rightsize -m "x %s" --push']) {
    expect(bash(c), c).toBe(true)
  }
  for (const c of ['git status', 'git commit -m push', 'gh release view', 'npm test', 'claude plugin tag plugins/rightsize', 'echo vercel']) {
    expect(bash(c), c).toBe(false)
  }
  expect(isApprovalStep('PublishPlugin', {})).toBe(true)
  expect(isApprovalStep('mcp__mail__send_email', {})).toBe(true)
  expect(isApprovalStep('mcp__mail__read_inbox', {})).toBe(false)
  expect(isApprovalStep('Edit', { command: 'git push' }), 'only Bash runs commands').toBe(false)
})
