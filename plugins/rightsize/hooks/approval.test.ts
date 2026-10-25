import { expect, test } from 'claude-code/testing'
import { isApprovalStep } from './approval'

const bash = (command: string) => isApprovalStep('Bash', { command })

test('finds the steps only the person can approve', async () => {
  for (const c of ['git push origin main', 'git push --tags', 'gh release create v1 --notes x', 'gh pr merge 2 --squash', 'npm publish', 'vercel deploy --prod --yes', 'claude plugin tag plugins/rightsize -m "x %s" --push']) {
    expect(bash(c), c).toBe(true)
  }
  for (const c of ['git -C ../repo push', 'git -c core.sshCommand=ssh push origin', 'git --no-pager push', 'sh -c "git push"', 'git commit -m x && git push', 'npx vercel --prod', 'wrangler deploy', 'gh repo delete x --yes']) {
    expect(bash(c), c).toBe(true)
  }
  for (const c of ['git status', 'git commit -m push', 'git -C ../repo pull', 'gh release view', 'npm test', 'claude plugin tag plugins/rightsize', 'echo vercel', 'vercel env ls']) {
    expect(bash(c), c).toBe(false)
  }
  expect(isApprovalStep('PublishPlugin', {})).toBe(true)
  expect(isApprovalStep('mcp__mail__send_email', {})).toBe(true)
  expect(isApprovalStep('mcp__mail__read_inbox', {})).toBe(false)
  expect(isApprovalStep('Edit', { command: 'git push' }), 'only Bash runs commands').toBe(false)
})
