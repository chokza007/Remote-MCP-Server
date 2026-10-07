from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any, Callable


PROTOCOL_VERSION = "1"


@dataclass
class ProtocolError(Exception):
    code: str
    message: str
    retryable: bool = False
    suggested_action: str = "Inspect the request and helper capabilities before retrying."
    target: str = "document-helper"


def emit(frame: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def emit_progress(request_id: str, progress: float, message: str) -> None:
    emit({"v": PROTOCOL_VERSION, "id": request_id, "type": "progress", "progress": progress, "message": message})


def parse_request(line: str) -> tuple[str, str, dict[str, Any]]:
    try:
        frame = json.loads(line)
    except json.JSONDecodeError as exc:
        raise ProtocolError("PROTOCOL_INVALID", "Request is not valid JSON.") from exc
    if not isinstance(frame, dict) or frame.get("v") != PROTOCOL_VERSION:
        raise ProtocolError("PROTOCOL_INVALID", "Unsupported or missing protocol version.")
    request_id = frame.get("id")
    method = frame.get("method")
    params = frame.get("params", {})
    if not isinstance(request_id, str) or not request_id or not isinstance(method, str) or not isinstance(params, dict):
        raise ProtocolError("PROTOCOL_INVALID", "Request requires string id/method and object params.")
    return request_id, method, params


def serve(dispatch: Callable[[str, dict[str, Any], Callable[[float, str], None]], Any]) -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = "unknown"
        try:
            request_id, method, params = parse_request(line)
            result = dispatch(method, params, lambda value, message: emit_progress(request_id, value, message))
            emit({"v": PROTOCOL_VERSION, "id": request_id, "type": "result", "result": result})
        except ProtocolError as exc:
            emit({
                "v": PROTOCOL_VERSION,
                "id": request_id,
                "type": "error",
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "retryable": exc.retryable,
                    "suggestedAction": exc.suggested_action,
                    "target": exc.target,
                },
            })
        except Exception as exc:  # Never leak a Python traceback over the wire.
            emit({
                "v": PROTOCOL_VERSION,
                "id": request_id,
                "type": "error",
                "error": {
                    "code": "DOCUMENT_INVALID",
                    "message": f"Document processing failed: {type(exc).__name__}: {str(exc)[:500]}",
                    "retryable": False,
                    "suggestedAction": "Verify that the document is non-corrupt and supported.",
                    "target": "document-helper",
                },
            })
