import type { RunLine } from './report'

// Opt-in sharing: anonymous numbers from the run log, sent to the rightsize author
// so the defaults can be tuned from real use. Off until the person says yes. Each
// event is rebuilt from an allowlist of numbers and known labels: no prompt text,
// file names, paths, MCP server names or session ids. Pure functions, no engine calls.

export const SHARE_URL = 'https://feedback.aivalue.blog/api/v1/events'
/** Events per request; the server takes at most 100. */
export const SHARE_BATCH = 100
/** At most one send an hour. */
export const SHARE_EVERY_MS = 60 * 60_000
/** Rated prompts before the one-time question, so the person has seen what rightsize does. */
export const SHARE_ASK_AFTER = 20

/** A random install id: 32 hex characters, not derived from anything on the machine. */
export function newInstall(random: () => number = Math.random) {
  return Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('')
}

/** FNV-1a, 64 bits, as 16 hex characters: links a 👍/👎 to its run without sending the run id. */
export function hashRef(install: string, id: string) {
  let h = 0xcbf29ce484222325n
  for (const c of `${install}:${id}`) {
    h ^= BigInt(c.codePointAt(0) ?? 0)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

const keep = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/** One log line as it may be shared; undefined for kinds that are not shared. */
export function shareEvent(l: RunLine, install: string): Record<string, unknown> | undefined {
  const kind = l.kind ?? 'run'
  if (kind === 'run') {
    const x = l as RunLine & { subLevel?: unknown; requests?: unknown; durationMs?: unknown }
    return keep({
      kind: 'run',
      at: l.at,
      ref: l.id ? hashRef(install, l.id) : undefined,
      type: l.type,
      tier: l.tier,
      level: l.level,
      normal: l.normal,
      route: l.route,
      subLevel: typeof x.subLevel === 'string' ? x.subLevel : undefined,
      change: l.change,
      offered: l.offered,
      fit: (l as { fit?: unknown }).fit,
      read: (l as { read?: unknown }).read,
      write: (l as { write?: unknown }).write,
      steps: (l as { steps?: unknown }).steps,
      context: l.context,
      estimate: l.estimate,
      actual: l.actual,
      stay: l.stay,
      taken: l.taken,
      overhead: l.overhead,
      agentCalls: l.agentCalls,
      requests: l.requests,
      escalations: l.escalations?.length,
      steppedUp: l.steppedUp,
      aborted: l.aborted,
      afterWorkflow: l.afterWorkflow,
      tie: l.tie?.by,
      durationMs: l.durationMs,
    })
  }
  if (kind === 'feedback' && l.ref && (l.value === 'up' || l.value === 'down')) return { kind: 'feedback', at: l.at, ref: hashRef(install, l.ref), value: l.value }
  if (kind === 'check' && l.check) return keep({ kind: 'check', at: l.at, type: l.type, fit: (l as { fit?: unknown }).fit, check: l.check.fit, by: l.check.by, overhead: l.overhead })
  return undefined
}

/** The next batch: lines after `after` (the last one sent), oldest first, and the `at` to remember once it is accepted. */
export function nextBatch(lines: readonly RunLine[], install: string, after: string | undefined) {
  const from = after ? Date.parse(after) : -Infinity
  const fresh = lines.filter(l => Date.parse(l.at) > from).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const picked: { line: RunLine; event: Record<string, unknown> }[] = []
  for (const line of fresh) {
    const event = shareEvent(line, install)
    if (event) picked.push({ line, event })
    if (picked.length === SHARE_BATCH) break
  }
  // Lines that are not shared still move the mark, so they are not looked at again.
  const last = picked.length === SHARE_BATCH ? picked[picked.length - 1]?.line.at : fresh[fresh.length - 1]?.at
  return { events: picked.map(p => p.event), upTo: last }
}
