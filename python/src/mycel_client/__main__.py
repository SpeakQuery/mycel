"""Command line: ``python -m mycel_client [--url URL] [--token TOKEN] <command> …``.

Exit codes: 0 ok, 1 error, 2 approval required, 3 denied, 4 still working.
"""

import argparse
import json
import os
import sys
from typing import Any, List, Optional

from . import __version__
from .client import Mycel
from .errors import ApprovalRequired, Denied, MycelError, StillWorking


def _print(value: Any) -> None:
    if isinstance(value, str):
        print(value)
    else:
        print(json.dumps(value, indent=2, ensure_ascii=False))


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m mycel_client", description="Talk to a Mycel gateway over A2A.")
    p.add_argument("--url", default=os.environ.get("MYCEL_URL", "http://127.0.0.1:4747"), help="Mycel URL (env MYCEL_URL, default %(default)s)")
    p.add_argument("--token", default=os.environ.get("MYCEL_TOKEN"), help="capability token myc1.… (env MYCEL_TOKEN; optional on loopback)")
    p.add_argument("--version", action="version", version=f"mycel-client {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("card", help="print the Agent Card")

    s = sub.add_parser("search", help="search the tool catalog")
    s.add_argument("query")
    s.add_argument("--limit", type=int, default=8)

    c = sub.add_parser("call", help="call a tool: call github.list_issues '{\"limit\":5}'")
    c.add_argument("tool")
    c.add_argument("args", nargs="?", default="{}", help="JSON object of arguments (default {})")
    c.add_argument("--no-wait", dest="wait", action="store_false", help="do not wait for background jobs")
    c.add_argument("--timeout", type=float, default=600.0)

    r = sub.add_parser("run", help="run a code-mode script from a file ('-' for stdin)")
    r.add_argument("file")
    r.add_argument("--no-wait", dest="wait", action="store_false")
    r.add_argument("--timeout", type=float, default=600.0)

    t = sub.add_parser("task", help="show a task (tasks/get)")
    t.add_argument("task_id")

    k = sub.add_parser("cancel", help="cancel a task (tasks/cancel)")
    k.add_argument("task_id")

    w = sub.add_parser("resume", help="resume a task after a human approved it")
    w.add_argument("task_id")
    w.add_argument("approval")
    w.add_argument("--no-wait", dest="wait", action="store_false")
    w.add_argument("--timeout", type=float, default=600.0)
    return p


def main(argv: Optional[List[str]] = None) -> int:
    a = _parser().parse_args(argv)
    m = Mycel(a.url, token=a.token)
    try:
        if a.cmd == "card":
            _print(m.card())
        elif a.cmd == "search":
            _print(m.search(a.query, limit=a.limit))
        elif a.cmd == "call":
            try:
                args = json.loads(a.args)
            except ValueError as e:
                print(f"error: args must be a JSON object: {e}", file=sys.stderr)
                return 1
            if not isinstance(args, dict):
                print("error: args must be a JSON object", file=sys.stderr)
                return 1
            _print(m.call(a.tool, args, wait=a.wait, timeout=a.timeout))
        elif a.cmd == "run":
            if a.file == "-":
                code = sys.stdin.read()
            else:
                with open(a.file, encoding="utf-8") as f:
                    code = f.read()
            _print(m.run(code, wait=a.wait, timeout=a.timeout))
        elif a.cmd == "task":
            _print(m.task(a.task_id))
        elif a.cmd == "cancel":
            _print(m.cancel(a.task_id))
        elif a.cmd == "resume":
            _print(m.resume(a.task_id, a.approval, wait=a.wait, timeout=a.timeout))
    except ApprovalRequired as e:
        print(f"approval required: {e.message}", file=sys.stderr)
        print(f"  approval: {e.approval_id}\n  task:     {e.task_id}", file=sys.stderr)
        print(f"  after approving: python -m mycel_client --url {a.url} resume {e.task_id} {e.approval_id}", file=sys.stderr)
        return 2
    except Denied as e:
        print(f"denied: {e.message}", file=sys.stderr)
        return 3
    except StillWorking as e:
        print(f"still working: {e.message}\n  task: {e.task_id}", file=sys.stderr)
        return 4
    except MycelError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
