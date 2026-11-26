"""Python client for Mycel — the MCP gateway + A2A agent mesh.

>>> from mycel_client import Mycel, ApprovalRequired
>>> m = Mycel("http://127.0.0.1:4747")
>>> m.search("list github issues", limit=3)
"""

from .client import Mycel, result_of
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

__version__ = "0.1.0"

__all__ = [
    "Mycel",
    "result_of",
    "MycelError",
    "RpcError",
    "AuthError",
    "ApprovalRequired",
    "Denied",
    "TaskFailed",
    "Canceled",
    "StillWorking",
    "MycelTimeout",
    "__version__",
]
