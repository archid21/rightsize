// Steps only the person can approve: pushing, publishing, releasing, deploying,
// sending. A subagent refuses them, because a message from another agent is not the
// person's consent, so the main chat does them itself. Pure functions, no engine calls.

const COMMANDS = [
  /\bgit\s+push\b/,
  /\bgh\s+(release\s+(create|edit|upload)|pr\s+(create|merge)|repo\s+create)\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\bvercel\s+(deploy|--prod|promote)\b/,
  /\bclaude\s+plugin\s+(publish|tag\b.*--push)\b/,
  /\b(cargo|twine|gem|docker)\s+(publish|upload|push)\b/,
]

const TOOLS = new Set(['PublishPlugin'])
// The last part of an MCP tool's name, such as mcp__mail__send_email.
const MCP_ACTION = /^(send|publish|deploy|merge|post|create_deployment|create_release)(_|$)/

/** Whether a main-chat tool call is a step only the person can approve. */
export function isApprovalStep(tool: string, input: Record<string, unknown>) {
  if (TOOLS.has(tool)) return true
  if (tool === 'Bash') return typeof input.command === 'string' && COMMANDS.some(re => re.test(input.command as string))
  if (tool.startsWith('mcp__')) return MCP_ACTION.test(tool.split('__').pop() ?? '')
  return false
}
