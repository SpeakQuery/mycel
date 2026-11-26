"""Synchronous Mycel client speaking A2A (protocol v0.3, JSON-RPC binding).

Only the standard library is used: ``urllib.request`` for HTTP and ``json``.
"""

import json
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Dict, List, Mapping, Optional

from .errors import (
    ApprovalRequired,
    AuthError,
    Canceled,
    Denied,
    MycelError,
    MycelTimeout,
    RpcError,
    StillWorking,
    TaskFailed,
)

__all__ = ["Mycel", "result_of"]

JSONDict = Dict[str, Any]

_PENDING_STATES = ("submitted", "working")
_CARD_PATHS = ("/.well-known/agent-card.json", "/.well-known/agent.json")


def _part_value(part: Mapping[str, Any]) -> Any:
    kind = part.get("kind")
    if kind == "text":
        return part.get("text", "")
    if kind == "data":
        return part.get("data")
    if kind == "file":
        return dict(part.get("file") or {})
    return dict(part)


def _status_text(task: Mapping[str, Any]) -> str:
    msg = (task.get("status") or {}).get("message") or {}
    texts = [p.get("text", "") for p in msg.get("parts") or [] if p.get("kind") == "text"]
    return "\n".join(t for t in texts if t)


def result_of(task: Mapping[str, Any]) -> Any:
    """Map a terminal A2A task (or a direct A2A message) to a Python value.

    * ``completed``                       -> the artifact value (data part -> object, text part -> ``str``)
    * ``input-required`` + approval       -> raises :class:`ApprovalRequired`
    * ``rejected``                        -> raises :class:`Denied`
    * ``failed``                          -> raises :class:`TaskFailed`
    * ``canceled``                        -> raises :class:`Canceled`
    * ``auth-required``                   -> raises :class:`AuthError`
    * ``submitted`` / ``working``         -> raises :class:`StillWorking`
    """
    if task.get("kind") == "message":
        values = [_part_value(p) for p in task.get("parts") or []]
        return values[0] if len(values) == 1 else values

    task_id = str(task.get("id", ""))
    state = (task.get("status") or {}).get("state")
    text = _status_text(task)
    raw = dict(task)

    if state == "completed":
        artifacts = task.get("artifacts") or []
        values = [_part_value(p) for a in artifacts for p in a.get("parts") or []]
        if not values:
            return None
        return values[0] if len(values) == 1 else values
    if state == "input-required":
        meta = task.get("metadata") or {}
        approval = meta.get("approval")
        if approval:
            raise ApprovalRequired(str(approval), task_id, text or "Human approval required", task=raw)
        raise MycelError(text or "The task needs more input", task_id=task_id, task=raw)
    if state == "rejected":
        raise Denied(text or "Denied by policy", task_id=task_id, task=raw)
    if state == "failed":
        raise TaskFailed(text or "Task failed", task_id=task_id, task=raw)
    if state == "canceled":
        raise Canceled(text or "Task was canceled", task_id=task_id, task=raw)
    if state == "auth-required":
        err = AuthError(-32000, text or "Authentication required")
        err.task_id, err.task = task_id, raw
        raise err
    if state in _PENDING_STATES:
        job = (task.get("metadata") or {}).get("job")
        raise StillWorking(task_id, text or f"Task is {state}", job_id=str(job) if job else None, task=raw)
    raise MycelError(f"Unknown task state: {state!r}", task_id=task_id, task=raw)


class Mycel:
    """Client for a Mycel gateway's A2A endpoint.

    >>> m = Mycel("http://127.0.0.1:4747")              # loopback: no token needed
    >>> m = Mycel("https://mycel.example", token="myc1.…")

    ``url`` may be the server root or the ``/a2a`` endpoint itself.
    """

    def __init__(
        self,
        url: str = "http://127.0.0.1:4747",
        token: Optional[str] = None,
        *,
        timeout: float = 120.0,
        poll_interval: float = 1.0,
        user_agent: str = "mycel-client-python/0.1.0",
    ) -> None:
        base = url.rstrip("/")
        if base.endswith("/a2a"):
            base = base[: -len("/a2a")]
        self.base_url = base
        self.endpoint = base + "/a2a"
        self.token = token
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.user_agent = user_agent
        self._card: Optional[JSONDict] = None

    def __repr__(self) -> str:
        return f"Mycel({self.base_url!r}, token={'***' if self.token else None})"

    # ------------------------------------------------------------ transport
    def _headers(self) -> Dict[str, str]:
        h = {"Accept": "application/json", "User-Agent": self.user_agent}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def _http(self, url: str, body: Optional[bytes] = None) -> Any:
        headers = self._headers()
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=body, headers=headers, method="POST" if body is not None else "GET")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
        except urllib.error.HTTPError as e:
            payload = e.read()
            e.close()
            try:
                data = json.loads(payload.decode("utf-8") or "null")
            except ValueError:
                data = None
            err = data.get("error") if isinstance(data, dict) else None
            if isinstance(err, dict):
                cls = AuthError if e.code in (401, 403) else RpcError
                raise cls(int(err.get("code", -32000)), str(err.get("message", e.reason)), status=e.code) from None
            msg = err if isinstance(err, str) else (payload.decode("utf-8", "replace")[:500] or str(e.reason))
            cls = AuthError if e.code in (401, 403) else RpcError
            raise cls(-32000, f"HTTP {e.code}: {msg}", status=e.code) from None
        except urllib.error.URLError as e:
            raise MycelError(f"Cannot reach Mycel at {url}: {e.reason}") from None
        except OSError as e:  # timeouts, resets
            raise MycelError(f"Request to {url} failed: {e}") from None
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise MycelError(f"Invalid JSON from {url}: {raw[:200]!r}") from None

    def rpc(self, method: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        """Send one JSON-RPC request to ``/a2a`` and return its ``result``."""
        body = json.dumps({"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method, "params": dict(params or {})}).encode("utf-8")
        reply = self._http(self.endpoint, body)
        if not isinstance(reply, dict):
            raise MycelError(f"Unexpected JSON-RPC reply: {reply!r}")
        err = reply.get("error")
        if err:
            raise RpcError(int(err.get("code", -32603)), str(err.get("message", "error")))
        return reply.get("result")

    # ------------------------------------------------------------ A2A primitives
    def card(self, refresh: bool = False) -> JSONDict:
        """Fetch (and cache) the Agent Card."""
        if self._card is not None and not refresh:
            return self._card
        last: Optional[Exception] = None
        for path in _CARD_PATHS:
            try:
                c = self._http(self.base_url + path)
                if isinstance(c, dict):
                    self._card = c
                    return c
            except MycelError as e:
                last = e
        raise MycelError(f"Could not fetch the agent card from {self.base_url}: {last}")

    def send(
        self,
        data: Any = None,
        *,
        text: Optional[str] = None,
        task_id: Optional[str] = None,
        context_id: Optional[str] = None,
    ) -> JSONDict:
        """Low level: ``message/send`` with a data and/or text part. Returns the raw task."""
        parts: List[JSONDict] = []
        if text is not None:
            parts.append({"kind": "text", "text": text})
        if data is not None:
            parts.append({"kind": "data", "data": data})
        if not parts:
            raise ValueError("send() needs data or text")
        message: JSONDict = {"kind": "message", "role": "user", "parts": parts, "messageId": str(uuid.uuid4())}
        if task_id:
            message["taskId"] = task_id
        if context_id:
            message["contextId"] = context_id
        result = self.rpc("message/send", {"message": message})
        if not isinstance(result, dict):
            raise MycelError(f"Unexpected message/send result: {result!r}")
        return result

    def task(self, task_id: str) -> JSONDict:
        """``tasks/get``: the raw task, including status, artifacts and metadata."""
        return self.rpc("tasks/get", {"id": task_id})

    def cancel(self, task_id: str) -> JSONDict:
        """``tasks/cancel``: cancel a task (and its background job, if any). Returns the raw task."""
        return self.rpc("tasks/cancel", {"id": task_id})

    def wait(self, task_id: str, timeout: Optional[float] = 600.0) -> Any:
        """Poll ``tasks/get`` until the task leaves ``working``, then map it like :meth:`call`."""
        return self._finish(self.task(task_id), wait=True, timeout=timeout)

    # ------------------------------------------------------------ high level
    def search(self, query: str, limit: int = 8) -> List[JSONDict]:
        """Search the tool catalog. Returns a list of ``{tool, description, params, effect, score, …}``."""
        out = result_of(self.send({"search": query, "limit": int(limit)}))
        if isinstance(out, dict) and isinstance(out.get("tools"), list):
            return list(out["tools"])
        if isinstance(out, list):
            return out
        raise MycelError(f"Unexpected search result: {out!r}")

    def call(
        self,
        tool: str,
        args: Optional[Mapping[str, Any]] = None,
        *,
        wait: bool = False,
        timeout: Optional[float] = 600.0,
    ) -> Any:
        """Call ``server.tool`` and return its result value.

        If the tool runs as a background job the task stays ``working``: with
        ``wait=True`` this polls until it is done (up to ``timeout`` seconds,
        ``None`` = forever); otherwise :class:`StillWorking` is raised.
        """
        task = self.send({"tool": tool, "args": dict(args or {})})
        return self._finish(task, wait=wait, timeout=timeout)

    def run(self, code: str, *, wait: bool = False, timeout: Optional[float] = 600.0) -> Any:
        """Run a code-mode script (``return await tools.call('server.tool', {...})``) and return its value."""
        return self._finish(self.send({"code": code}), wait=wait, timeout=timeout)

    def resume(self, task_id: str, approval: str, *, wait: bool = False, timeout: Optional[float] = 600.0) -> Any:
        """Re-run a call that raised :class:`ApprovalRequired`, after a human approved ``approval``."""
        return self._finish(self.send({"approval": approval}, task_id=task_id), wait=wait, timeout=timeout)

    # ------------------------------------------------------------ internals
    def _finish(self, task: JSONDict, *, wait: bool, timeout: Optional[float]) -> Any:
        if wait and task.get("kind") == "task":
            deadline = None if timeout is None else time.monotonic() + timeout
            while (task.get("status") or {}).get("state") in _PENDING_STATES:
                if deadline is not None and time.monotonic() >= deadline:
                    raise MycelTimeout(
                        f"Task {task.get('id')} still running after {timeout}s: {_status_text(task)}",
                        task_id=str(task.get("id")),
                        task=task,
                    )
                pause = self.poll_interval if deadline is None else max(0.0, min(self.poll_interval, deadline - time.monotonic()))
                time.sleep(pause)
                task = self.task(str(task["id"]))
        return result_of(task)

