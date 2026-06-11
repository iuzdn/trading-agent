#!/usr/bin/env python3
"""Render a Claude Code JSONL transcript to redacted Markdown.

Usage: python3 scripts/export_conversation.py <input.jsonl> <output.md>
"""
import json
import os
import re
import sys
from pathlib import Path


def load_env_secrets(env_path: Path) -> list[str]:
    """Return concrete secret VALUES worth scrubbing (long enough not to false-positive)."""
    if not env_path.exists():
        return []
    SKIP_KEYS = {"PAPER_MODE", "MAX_POSITION_PCT", "DAILY_LOSS_LIMIT_PCT", "ANTHROPIC_MODEL"}
    out = []
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        if k in SKIP_KEYS or len(v) < 12:
            continue
        out.append(v)
    return sorted(out, key=len, reverse=True)  # longest first so substrings don't shadow


# Generic secret patterns (applied after exact-match scrub).
PATTERNS = [
    (re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"), "sk-ant-REDACTED"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "sk-REDACTED"),
    (re.compile(r"\bPK[A-Z0-9]{16,}\b"), "PK_REDACTED"),       # Alpaca live key prefix
    (re.compile(r"\bAK[A-Z0-9]{16,}\b"), "AK_REDACTED"),       # Alpaca paper key prefix
    (re.compile(r"\b\d{8,12}:[A-Za-z0-9_-]{30,}\b"), "TELEGRAM_BOT_TOKEN_REDACTED"),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b"), "JWT_REDACTED"),
    (re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"), "EMAIL_REDACTED"),
    (re.compile(r"/home/[a-z_][a-z0-9_-]*"), "/home/USER"),
]


def redact(text: str, secrets: list[str]) -> str:
    for s in secrets:
        text = text.replace(s, "REDACTED")
    for pat, repl in PATTERNS:
        text = pat.sub(repl, text)
    return text


def render_tool_use(block: dict) -> str:
    name = block.get("name", "?")
    inp = block.get("input", {}) or {}
    if name == "Bash":
        cmd = (inp.get("command", "") or "").splitlines()[0][:200]
        return f"🔧 **Bash** — `{cmd}`"
    if name == "Read":
        return f"📖 **Read** — `{inp.get('file_path', '?')}`"
    if name in {"Edit", "Write"}:
        return f"✏️ **{name}** — `{inp.get('file_path', '?')}`"
    if name == "Grep":
        return f"🔍 **Grep** — `{inp.get('pattern', '?')}` in `{inp.get('path', '.')}`"
    if name == "Glob":
        return f"🔍 **Glob** — `{inp.get('pattern', '?')}`"
    if name == "TaskCreate":
        return f"📋 **TaskCreate** — {inp.get('title', '?')}"
    if name == "Agent":
        return f"🤖 **Agent** ({inp.get('subagent_type', 'general')}) — {inp.get('description', '?')}"
    if name == "AskUserQuestion":
        qs = inp.get("questions", []) or []
        q0 = qs[0].get("question", "?") if qs else "?"
        return f"❓ **AskUserQuestion** — {q0}"
    # Fallback: name + first arg summary.
    first_arg = next(iter(inp.items()), None)
    arg_preview = ""
    if first_arg:
        k, v = first_arg
        arg_preview = f" — {k}=`{str(v)[:120]}`"
    return f"🔧 **{name}**{arg_preview}"


def strip_system_reminders(text: str) -> str:
    # Drop <system-reminder>...</system-reminder> blocks and local-command-* tags.
    text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.DOTALL)
    text = re.sub(r"<local-command-[^>]*>.*?</local-command-[^>]*>", "", text, flags=re.DOTALL)
    text = re.sub(r"<command-(name|message|args)>.*?</command-\1>", "", text, flags=re.DOTALL)
    text = re.sub(r"<user-prompt-submit-hook>.*?</user-prompt-submit-hook>", "", text, flags=re.DOTALL)
    return text.strip()


def render(jsonl_path: Path, secrets: list[str]) -> str:
    out: list[str] = []
    out.append(f"# Conversation transcript — {jsonl_path.name}\n")
    out.append("_Exported by `scripts/export_conversation.py`. Secrets and personal paths redacted._\n")

    with jsonl_path.open() as f:
        for line in f:
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Skip sub-agent / meta / housekeeping entries.
            if o.get("isSidechain"):
                continue
            if o.get("isMeta"):
                continue
            if o.get("type") not in {"user", "assistant"}:
                continue

            msg = o.get("message")
            if not isinstance(msg, dict):
                continue
            role = msg.get("role")
            content = msg.get("content")

            # User prose is often stored as a bare string; tool-result wrappers
            # and most assistant turns use a list of blocks. Normalize to list.
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]
            elif not isinstance(content, list):
                continue

            parts: list[str] = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    txt = strip_system_reminders(block.get("text", ""))
                    if txt:
                        parts.append(txt)
                elif btype == "thinking":
                    # Skip — internal reasoning isn't part of the dialog.
                    continue
                elif btype == "tool_use":
                    parts.append(render_tool_use(block))
                elif btype == "tool_result":
                    # Suppressed by default — too noisy. Uncomment to include short results.
                    continue

            if not parts:
                continue

            body = "\n\n".join(parts)
            header = "## 🧑 User" if role == "user" else "## 🤖 Assistant"
            out.append(f"\n{header}\n\n{body}\n")

    rendered = "\n".join(out)
    return redact(rendered, secrets)


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    repo = Path(__file__).resolve().parent.parent
    secrets = load_env_secrets(repo / ".env")
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(render(src, secrets))
    size = dst.stat().st_size
    print(f"Wrote {dst} ({size:,} bytes, scrubbed {len(secrets)} exact secrets)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
