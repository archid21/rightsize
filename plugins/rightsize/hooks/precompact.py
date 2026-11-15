#!/usr/bin/env python3
"""rightsize's handoff text for a compaction told nothing (ADR 0077, fixes P-42's ADR 0073).

A classic PreCompact command hook. When it exits 0 without blocking, Claude Code uses its stdout as the
instructions for the compaction summary (code.claude.com/docs/en/hooks). It runs where the mod hook
`session.compact` cannot: on Team and Enterprise logins the built-in guard (sec-default@builtin) runs ahead of
every installed mod and a user mod's `session.compact` hook never runs there.

Prints COMPACT_TEXT (read from whatsnext.ts, so there is one copy) when:
- the compaction is the main conversation's (no agent_id), and
- no instructions were given (custom_instructions absent or only whitespace): a bare /compact or an
  automatic compact. Text typed after /compact, whatsnext's and another plugin's are never replaced, and
- rightsize is not switched off (~/.claude/mods/switches.json has no "rightsize": false).

Logs one line to the session's rightsize log. Fails open: on any error it prints nothing and exits 0, so the
compaction goes ahead with Claude Code's own prompt.
"""
import datetime
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser("~")


def compact_text():
    with open(os.path.join(HERE, "whatsnext.ts"), encoding="utf-8") as f:
        src = f.read()
    m = re.search(r'export const COMPACT_TEXT =\s*("(?:[^"\\\n]|\\.)*")', src)
    if not m:
        return None
    text = json.loads(m.group(1))
    return text if isinstance(text, str) and text.strip() else None


def switched_off():
    try:
        with open(os.path.join(HOME, ".claude", "mods", "switches.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and data.get("rightsize") is False


def log(session, line):
    if not isinstance(session, str) or not re.match(r"^[A-Za-z0-9_-]+$", session):
        return
    folder = os.path.join(HOME, ".claude", "mods-logs", "rightsize", session)
    try:
        os.makedirs(folder, exist_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with open(os.path.join(folder, "rightsize.log"), "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (stamp, line))
    except OSError:
        pass


def decide(event):
    """What to print for one PreCompact input, and the log line; (None, None) when the hook stays out."""
    if not isinstance(event, dict) or event.get("agent_id") or event.get("hook_event_name", "PreCompact") != "PreCompact":
        return None, None
    trigger = event.get("trigger") or "unknown"
    if switched_off():
        return None, None
    given = event.get("custom_instructions")
    if isinstance(given, str) and given.strip():
        return None, "compact (%s): instructions given; left as they are" % trigger
    text = compact_text()
    if text is None:
        return None, "compact (%s): no instructions given; rightsize's handoff text could not be read, Claude Code's own used" % trigger
    return text, "compact (%s): no instructions given; rightsize's handoff-style text used" % trigger


def main():
    try:
        event = json.loads(sys.stdin.read() or "{}")
        out, line = decide(event)
        if line:
            log(event.get("session_id"), line)
        if out:
            sys.stdout.write(out)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
