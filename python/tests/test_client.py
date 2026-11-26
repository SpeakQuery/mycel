"""Unit tests against a stdlib fake that mimics Mycel's A2A JSON-RPC server.

Run from the ``python/`` directory:  python3 -m unittest
"""

import io
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
import uuid
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from mycel_client import (  # noqa: E402
    ApprovalRequired,
    AuthError,
    Canceled,
    Denied,
    Mycel,
    MycelError,
    MycelTimeout,
    RpcError,
    StillWorking,
    TaskFailed,
)
from mycel_client.__main__ import main as cli_main  # noqa: E402

TOOLS = [
    {"tool": "demo.echo", "description": "Echo back", "params": "text?: string", "effect": "read", "score": 1.2},
    {"tool": "demo.delete_everything", "description": "Delete all data", "params": "", "effect": "destructive", "score": 0.4},
]


class FakeMycel:
    """In-memory imitation of src/a2a-server.ts."""

    def __init__(self, token: Optional[str] = None) -> None:
        self.token = token
        self.tasks: Dict[str, Dict[str, Any]] = {}
        self.jobs: Dict[str, int] = {}  # task id -> remaining polls before done
        self.pending: Dict[str, Dict[str, Any]] = {}
        self.requests: List[Dict[str, Any]] = []
        self.headers: List[Dict[str, str]] = []

    # -- helpers mirroring A2AServer
    @staticmethod
    def _part(v: Any) -> Dict[str, Any]:
        return {"kind": "text", "text": v} if isinstance(v, str) else {"kind": "data", "data": v}

    def _state(self, t: Dict[str, Any], state: str, text: Optional[str] = None) -> None:
        t["status"] = {"state": state, "timestamp": "2026-01-01T00:00:00Z"}
        if text:
            t["status"]["message"] = {"kind": "message", "role": "agent", "messageId": str(uuid.uuid4()), "parts": [{"kind": "text", "text": text}], "taskId": t["id"], "contextId": t["contextId"]}

    def _complete(self, t: Dict[str, Any], value: Any) -> None:
        t["artifacts"] = [{"artifactId": str(uuid.uuid4()), "name": "result", "parts": [self._part(value)]}]
        self._state(t, "completed")

    def _call(self, t: Dict[str, Any], tool: str, args: Dict[str, Any], approval: Optional[str] = None) -> None:
        if tool == "demo.echo":
            self._complete(t, {"echo": args})
        elif tool == "demo.text":
            self._complete(t, "plain text result")
        elif tool == "demo.slow":
            self.jobs[t["id"]] = int(args.get("polls", 2))
            t["metadata"] = {"job": "job_1"}
            self._state(t, "working", "Running as job job_1. Poll tasks/get.")
        elif tool == "demo.delete_everything":
            if approval == "apv_ok":
                self._complete(t, {"deleted": True})
            else:
                t["metadata"] = {"approval": "apv_ok"}
                self._state(t, "input-required", 'Human approval required: destructive. Once approved, send {"approval":"apv_ok"} with this taskId.')
        elif tool == "demo.forbidden":
            self._state(t, "rejected", "Blocked by policy rule no-forbidden")
        elif tool == "demo.broken":
            self._state(t, "failed", "upstream exploded")
        else:
            self._state(t, "failed", f'Unknown tool "{tool}".')

    def handle(self, body: Dict[str, Any]) -> Dict[str, Any]:
        self.requests.append(body)
        rid = body.get("id")
        method = body.get("method")
        params = body.get("params") or {}

        def ok(result: Any) -> Dict[str, Any]:
            return {"jsonrpc": "2.0", "id": rid, "result": result}

        def fail(code: int, msg: str) -> Dict[str, Any]:
            return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": msg}}

        if method == "message/send":
            msg = params.get("message") or {}
            parts = msg.get("parts") or []
            if not parts:
                return fail(-32603, "message.parts is required")
            p = parts[0]
            intent = p.get("data") if p.get("kind") == "data" else {"search": p.get("text")}
            if msg.get("taskId"):
                t = self.tasks.get(msg["taskId"])
                if not t:
                    return fail(-32603, "Task not found")
                pend = self.pending.get(t["id"])
                if pend and intent.get("approval"):
                    self._call(t, pend["tool"], pend["args"], intent["approval"])
                    return ok(t)
                return fail(-32603, "Nothing to resume on this task")
            t = {"kind": "task", "id": str(uuid.uuid4()), "contextId": str(uuid.uuid4()), "status": {"state": "working"}, "history": [msg]}
            self.tasks[t["id"]] = t
            if "tool" in intent:
                self.pending[t["id"]] = {"tool": intent["tool"], "args": intent.get("args") or {}}
                self._call(t, intent["tool"], intent.get("args") or {})
            elif "code" in intent:
                if "throw" in intent["code"]:
                    self._state(t, "failed", "Error: boom")
                else:
                    self._complete(t, {"ran": intent["code"]})
            else:
                limit = int(intent.get("limit") or 8)
                self._complete(t, {"tools": TOOLS[:limit], "hint": 'Call one with {"tool":"<id>","args":{...}}'})
            return ok(t)
        if method == "tasks/get":
            t = self.tasks.get(str(params.get("id")))
            if not t:
                return fail(-32001, "Task not found")
            if t["id"] in self.jobs and t["status"]["state"] == "working":
                self.jobs[t["id"]] -= 1
                if self.jobs[t["id"]] <= 0:
                    self._complete(t, {"job": "done"})
                else:
                    self._state(t, "working", "Job job_1: running")
            return ok(t)
        if method == "tasks/cancel":
            t = self.tasks.get(str(params.get("id")))
            if not t:
                return fail(-32001, "Task not found")
            self.jobs.pop(t["id"], None)
            self._state(t, "canceled")
            return ok(t)
        return fail(-32601, f"Method not found: {method}")

    def card(self, base: str) -> Dict[str, Any]:
        return {
            "protocolVersion": "0.3.0",
            "name": "mycel",
            "description": "fake",
            "url": base + "/a2a",
            "version": "0.1.0",
            "capabilities": {"streaming": False},
            "defaultInputModes": ["application/json"],
            "defaultOutputModes": ["application/json"],
            "skills": [{"id": "search", "name": "Search tools", "description": "", "tags": []}],
        }


def make_server(fake: FakeMycel) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a: Any) -> None:  # silence
            pass

        def _send(self, status: int, body: Any) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path == "/.well-known/agent-card.json":
                return self._send(200, fake.card(f"http://{self.headers['Host']}"))
            self._send(404, {"error": "Not found"})

        def do_POST(self) -> None:
            fake.headers.append(dict(self.headers))
            if self.path != "/a2a":
                return self._send(404, {"error": "Not found"})
            if fake.token is not None and self.headers.get("Authorization") != f"Bearer {fake.token}":
                return self._send(401, {"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": "A capability token is required (Authorization: Bearer myc1.…)."}})
            n = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            self._send(200, fake.handle(body))

    return ThreadingHTTPServer(("127.0.0.1", 0), Handler)


class Base(unittest.TestCase):
    token: Optional[str] = None

    def setUp(self) -> None:
        self.fake = FakeMycel(token=self.token)
        self.httpd = make_server(self.fake)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.m = Mycel(self.url, token=self.token, poll_interval=0.01, timeout=5)

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class ClientTests(Base):
    def test_card(self) -> None:
        c = self.m.card()
        self.assertEqual(c["protocolVersion"], "0.3.0")
        self.assertTrue(c["url"].endswith("/a2a"))
        self.assertIs(self.m.card(), c)  # cached

    def test_url_may_point_at_a2a_endpoint(self) -> None:
        m = Mycel(self.url + "/a2a/")
        self.assertEqual(m.endpoint, self.url + "/a2a")
        self.assertEqual(m.card()["name"], "mycel")

    def test_search(self) -> None:
        hits = self.m.search("echo", limit=1)
        self.assertEqual([h["tool"] for h in hits], ["demo.echo"])
        sent = self.fake.requests[-1]["params"]["message"]
        self.assertEqual(sent["parts"], [{"kind": "data", "data": {"search": "echo", "limit": 1}}])
        self.assertEqual(sent["role"], "user")
        self.assertEqual(sent["kind"], "message")
        self.assertEqual(self.fake.requests[-1]["jsonrpc"], "2.0")

    def test_call_returns_data(self) -> None:
        self.assertEqual(self.m.call("demo.echo", {"text": "hi"}), {"echo": {"text": "hi"}})

    def test_call_returns_text(self) -> None:
        self.assertEqual(self.m.call("demo.text"), "plain text result")

    def test_no_token_sends_no_auth_header(self) -> None:
        self.m.call("demo.echo")
        self.assertNotIn("Authorization", self.fake.headers[-1])

    def test_job_without_wait_raises_still_working(self) -> None:
        with self.assertRaises(StillWorking) as cm:
            self.m.call("demo.slow", {"polls": 2})
        self.assertEqual(cm.exception.job_id, "job_1")
        self.assertEqual(self.m.wait(cm.exception.task_id), {"job": "done"})

    def test_job_with_wait_polls(self) -> None:
        self.assertEqual(self.m.call("demo.slow", {"polls": 3}, wait=True, timeout=5), {"job": "done"})
        self.assertEqual([r["method"] for r in self.fake.requests], ["message/send"] + ["tasks/get"] * 3)

    def test_wait_timeout(self) -> None:
        with self.assertRaises(MycelTimeout) as cm:
            self.m.call("demo.slow", {"polls": 10_000}, wait=True, timeout=0.05)
        self.assertIsInstance(cm.exception, TimeoutError)
        self.assertTrue(cm.exception.task_id)

    def test_approval_flow(self) -> None:
        with self.assertRaises(ApprovalRequired) as cm:
            self.m.call("demo.delete_everything")
        e = cm.exception
        self.assertEqual(e.approval_id, "apv_ok")
        self.assertIn("approval required", e.message.lower())
        self.assertEqual(e.task["status"]["state"], "input-required")
        self.assertEqual(self.m.resume(e.task_id, approval=e.approval_id), {"deleted": True})
        sent = self.fake.requests[-1]["params"]["message"]
        self.assertEqual(sent["taskId"], e.task_id)
        self.assertEqual(sent["parts"][0]["data"], {"approval": "apv_ok"})

    def test_resume_wrong_task_is_rpc_error(self) -> None:
        with self.assertRaises(RpcError) as cm:
            self.m.resume("nope", approval="apv_x")
        self.assertEqual(cm.exception.code, -32603)

    def test_denied(self) -> None:
        with self.assertRaises(Denied) as cm:
            self.m.call("demo.forbidden")
        self.assertIn("policy", str(cm.exception))

    def test_failed(self) -> None:
        with self.assertRaises(TaskFailed) as cm:
            self.m.call("demo.broken")
        self.assertEqual(str(cm.exception), "upstream exploded")
        self.assertIsInstance(cm.exception, MycelError)

    def test_run(self) -> None:
        code = "return await tools.call('demo.echo', {})"
        self.assertEqual(self.m.run(code), {"ran": code})
        with self.assertRaises(TaskFailed):
            self.m.run("throw new Error('boom')")

    def test_task_and_cancel(self) -> None:
        with self.assertRaises(StillWorking) as cm:
            self.m.call("demo.slow", {"polls": 100})
        tid = cm.exception.task_id
        self.assertEqual(self.m.task(tid)["status"]["state"], "working")
        self.assertEqual(self.m.cancel(tid)["status"]["state"], "canceled")
        with self.assertRaises(Canceled):
            self.m.wait(tid)

    def test_unknown_task(self) -> None:
        with self.assertRaises(RpcError) as cm:
            self.m.task("missing")
        self.assertEqual(cm.exception.code, -32001)

    def test_unknown_method(self) -> None:
        with self.assertRaises(RpcError) as cm:
            self.m.rpc("tasks/resubscribe", {})
        self.assertEqual(cm.exception.code, -32601)

    def test_unreachable(self) -> None:
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()  # nothing listens on this port now
        with self.assertRaises(MycelError) as cm:
            Mycel(f"http://127.0.0.1:{port}", timeout=1).search("x")
        self.assertIn("Cannot reach", str(cm.exception))


class TokenTests(Base):
    token = "myc1.test-token"

    def test_bearer_header(self) -> None:
        self.assertEqual(self.m.call("demo.echo", {"a": 1}), {"echo": {"a": 1}})
        self.assertEqual(self.fake.headers[-1]["Authorization"], "Bearer myc1.test-token")
        self.assertNotIn("test-token", repr(self.m))

    def test_missing_token_is_auth_error(self) -> None:
        with self.assertRaises(AuthError) as cm:
            Mycel(self.url).call("demo.echo")
        self.assertEqual(cm.exception.status, 401)
        self.assertEqual(cm.exception.code, -32000)
        self.assertIn("capability token", str(cm.exception))


class CliTests(Base):
    def cli(self, *argv: str) -> "tuple[int, str, str]":
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli_main(["--url", self.url, *argv])
        return code, out.getvalue(), err.getvalue()

    def test_search(self) -> None:
        code, out, _ = self.cli("search", "echo", "--limit", "2")
        self.assertEqual(code, 0)
        self.assertEqual([t["tool"] for t in json.loads(out)], ["demo.echo", "demo.delete_everything"])

    def test_call(self) -> None:
        code, out, _ = self.cli("call", "demo.echo", '{"text":"yo"}')
        self.assertEqual((code, json.loads(out)), (0, {"echo": {"text": "yo"}}))

    def test_call_waits_for_jobs(self) -> None:
        code, out, _ = self.cli("call", "demo.slow", '{"polls":1}')
        self.assertEqual((code, json.loads(out)), (0, {"job": "done"}))

    def test_call_bad_json(self) -> None:
        code, _, err = self.cli("call", "demo.echo", "{not json")
        self.assertEqual(code, 1)
        self.assertIn("JSON", err)

    def test_approval_exit_code(self) -> None:
        code, _, err = self.cli("call", "demo.delete_everything")
        self.assertEqual(code, 2)
        self.assertIn("apv_ok", err)

    def test_denied_exit_code(self) -> None:
        self.assertEqual(self.cli("call", "demo.forbidden")[0], 3)

    def test_run_file(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write("return 1")
        try:
            code, out, _ = self.cli("run", f.name)
        finally:
            os.unlink(f.name)
        self.assertEqual((code, json.loads(out)), (0, {"ran": "return 1"}))

    def test_card(self) -> None:
        code, out, _ = self.cli("card")
        self.assertEqual((code, json.loads(out)["name"]), (0, "mycel"))


if __name__ == "__main__":
    unittest.main()
