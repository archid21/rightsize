// GitHub star ask (P-65, ADR-0021): one ask, shared with rightsize through a file both plugins read and write.
// Each plugin's `$.store` is its own, so the agreement between the two lives in `~/.config/archid21/stars.json`.
// A copy of whatsnext's hooks/star.ts with ME = 'rightsize' (whatsnext ADR-0021, rightsize ADR 0039). Keep the file format
// and the rules below the same in both: a change to either copy must change the other.

export const ME = 'rightsize'
export const REPOS: Record<string, string> = { whatsnext: 'archid21/whatsnext', rightsize: 'archid21/rightsize' }
export const SHARED_PATH = '.config/archid21/stars.json' // under the home folder
export const CLAIM_DAYS = 7 // a claim by the other plugin blocks this one's ask for this long
const DAY_MS = 24 * 60 * 60 * 1000

// `installed`: plugin name -> first seen (UTC). `starred`: repo -> true once GitHub says so.
// `answered`: UTC time the person pressed Star or No thanks; after it, neither plugin asks on its own.
// `claim`: the plugin showing the ask now, and when it started.
export type Shared = {
  installed: Record<string, string>
  starred: Record<string, boolean>
  answered?: string
  claim?: { by: string; at: string }
}

// An older, missing or damaged file reads as empty: nobody asked, nothing starred.
export function parseShared(text: string | undefined): Shared {
  let raw: Record<string, unknown> = {}
  try {
    const value = text ? JSON.parse(text) : {}
    if (value && typeof value === 'object' && !Array.isArray(value)) raw = value
  } catch {
    raw = {}
  }
  const strings = (v: unknown) =>
    Object.fromEntries(Object.entries(isObject(v) ? v : {}).filter(([, x]) => typeof x === 'string')) as Record<string, string>
  const starred = Object.fromEntries(Object.entries(isObject(raw.starred) ? raw.starred : {}).filter(([, x]) => x === true))
  const claim = isObject(raw.claim) && typeof raw.claim.by === 'string' && typeof raw.claim.at === 'string'
    ? { by: raw.claim.by, at: raw.claim.at }
    : undefined

  return {
    installed: strings(raw.installed),
    starred: starred as Record<string, boolean>,
    ...(typeof raw.answered === 'string' ? { answered: raw.answered } : {}),
    ...(claim ? { claim } : {}),
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// The other plugin claimed the ask less than CLAIM_DAYS ago. Our own claim never blocks us.
export function blockedByClaim(shared: Shared, nowMs: number, me = ME): boolean {
  if (!shared.claim || shared.claim.by === me) return false
  const at = Date.parse(shared.claim.at)

  return Number.isFinite(at) && nowMs - at < CLAIM_DAYS * DAY_MS
}

// The repos the ask names: this plugin's own, plus each other installed plugin's, minus the starred ones.
export function reposToAsk(shared: Shared, me = ME): string[] {
  const names = [me, ...Object.keys(shared.installed).filter(n => n !== me && REPOS[n])]

  return names.map(n => REPOS[n]).filter((repo): repo is string => !!repo && !shared.starred[repo])
}

// The band's line for these repos.
export function askText(repos: readonly string[]): string {
  const names = repos.map(r => r.split('/')[1])
  const what = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
  const them = names.length > 1 ? 'them' : 'it'

  return `Finding ${what} useful? Star ${them} on GitHub so other people can find ${them}.`
}

// `gh api user/starred/<repo>`: exit 0 is starred, an HTTP 404 is not starred, anything else (no gh, not signed in,
// no network) is unknown.
export function readStarCheck(ran: { exitCode: number; stderr: string } | undefined): 'starred' | 'not' | 'unknown' {
  if (!ran) return 'unknown'
  if (ran.exitCode === 0) return 'starred'
  if (/HTTP 404/.test(ran.stderr)) return 'not'

  return 'unknown'
}
