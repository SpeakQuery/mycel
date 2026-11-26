"""Exceptions raised by the Mycel client."""

from typing import Any, Dict, Optional

__all__ = [
    "MycelError",
    "RpcError",
    "AuthError",
    "ApprovalRequired",
    "Denied",
    "TaskFailed",
    "Canceled",
    "StillWorking",
    "MycelTimeout",
]


class MycelError(Exception):
    """Base class for every error raised by the client.

    ``task_id`` and ``task`` are set when the error comes from an A2A task
    (as opposed to a transport or JSON-RPC level problem).
    """

    def __init__(self, message: str, *, task_id: Optional[str] = None, task: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.message = message
        self.task_id = task_id
        self.task = task


class RpcError(MycelError):
    """The server answered with a JSON-RPC error object."""

    def __init__(self, code: int, message: str, *, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status

    def __str__(self) -> str:
        return f"[{self.code}] {self.message}"


class AuthError(RpcError):
    """The server rejected the request: missing, invalid or expired capability token."""


class ApprovalRequired(MycelError):
    """The call needs a human's approval before it runs.

    Ask a human to approve ``approval_id`` (``mycel approve <id>`` or the
    dashboard), then call ``Mycel.resume(task_id, approval=approval_id)``.
    """

    def __init__(self, approval_id: str, task_id: str, message: str, *, task: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message, task_id=task_id, task=task)
        self.approval_id = approval_id

    def __str__(self) -> str:
        return f"{self.message} (approval={self.approval_id}, task={self.task_id})"


class Denied(MycelError):
    """Policy (or a human) rejected the call. Retrying will not help."""


class TaskFailed(MycelError):
    """The tool, script or job ran and failed."""


class Canceled(MycelError):
    """The task was canceled before it finished."""


class StillWorking(MycelError):
    """The call was accepted as a background job and has not finished yet.

    Raised when ``wait=False``. Use ``Mycel.wait(task_id)`` to block until it
    is done, or ``Mycel.task(task_id)`` to poll yourself.
    """

    def __init__(self, task_id: str, message: str, *, job_id: Optional[str] = None, task: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message, task_id=task_id, task=task)
        self.job_id = job_id


class MycelTimeout(MycelError, TimeoutError):
    """Waiting for a task exceeded the given timeout. The task keeps running server-side."""
