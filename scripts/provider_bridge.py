"""Use the same installed OpenAI Python SDK as frozen AFlow for HTTP/retries."""
import asyncio
import contextvars
import httpx
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from openai import AsyncOpenAI, APIStatusError, APIConnectionError, APITimeoutError


class ProviderStreamError(ValueError):
    """A malformed/incomplete stream, with optional untrusted error fields."""
    def __init__(self, message, body=None):
        super().__init__(message)
        self.safe_message = message
        self.body = body


def _input_strings(body):
    """Only used for redaction; request content never becomes telemetry."""
    if not isinstance(body, dict):
        return []
    found = []

    def visit(value, depth=0):
        if depth > 8:
            return
        if isinstance(value, str):
            if value:
                found.append(value)
            # Function arguments are encoded JSON; redact their scalar values
            # as well as the complete string if an error echoes one field.
            if len(value) <= 65536 and value.lstrip().startswith(("{", "[")):
                try:
                    visit(json.loads(value), depth + 1)
                except (ValueError, TypeError):
                    pass
        elif isinstance(value, list):
            for item in value:
                visit(item, depth + 1)
        elif isinstance(value, dict):
            for item in value.values():
                visit(item, depth + 1)

    for message in body.get("messages") or []:
        if isinstance(message, dict):
            for key in ("content", "reasoning_content", "tool_calls", "function_call"):
                visit(message.get(key))
    return found


def safe_diagnostic_text(value, body=None, limit=1024):
    """Allow scalar diagnostics only; redact before applying a strict bound."""
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return None
    text = str(value)
    # Never stringify an exception, HTTP body, headers or request. These are
    # defensive redactions for secrets that a provider may echo in its message.
    secrets = [value for name, value in os.environ.items()
               if value and re.search(r"(?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD)$", name, re.I)]
    for secret in sorted(set(secrets + _input_strings(body)), key=len, reverse=True):
        text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"sk-[A-Za-z0-9_-]+", "[REDACTED]", text, flags=re.I)
    text = re.sub(r"\bBearer\s+[^\s,;\"'<>]+", "Bearer [REDACTED]", text, flags=re.I)
    text = re.sub(r"(?i)(?:authorization|api[_-]?key|access[_-]?token|password|secret)\s*[\"']?\s*[:=]\s*[\"']?[^\s,;\"'<>]+",
                  "[REDACTED CREDENTIAL]", text)
    # If a provider echoes a serialized request, retaining it after selective
    # redaction is unsafe: it may contain unknown input/argument encodings.
    if re.search(r"\\*[\"'](?:messages|tool_calls|function_call|arguments|authorization|extra_body)\\*[\"']\s*:", text, re.I):
        return "[REDACTED REQUEST ECHO]"
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", text).strip()
    if len(text) > limit:
        text = text[:limit - len(" [truncated]")] + " [truncated]"
    return text or None


def safe_provider_error(error, request_body=None, request_id=None):
    """Extract an allowlist, never log repr(error) or the complete payload."""
    status = error.status_code if isinstance(error, APIStatusError) else 599
    details = {"type": "ValueError" if isinstance(error, ProviderStreamError) else type(error).__name__,
               "status": status}
    payload = getattr(error, "body", None)
    if isinstance(payload, str):
        # Parse JSON only. Raw HTML/plain-text responses may be request dumps.
        try:
            payload = json.loads(payload) if len(payload) <= 65536 else None
        except (ValueError, TypeError):
            payload = None
    cursor = payload if isinstance(payload, dict) else {}
    allowed = ("type", "code", "message", "request_id", "requestId")
    fields = {key: cursor[key] for key in allowed if key in cursor}
    for _ in range(4):
        if not isinstance(cursor.get("error"), dict):
            break
        cursor = cursor["error"]
        fields.update({key: cursor[key] for key in allowed if key in cursor})
    fallback = (error.safe_message if isinstance(error, ProviderStreamError) else
                "Provider request timed out" if isinstance(error, APITimeoutError) else
                "Provider connection could not be established" if isinstance(error, APIConnectionError) else
                "Provider returned an HTTP error" if isinstance(error, APIStatusError) else
                "Provider request or response could not be completed")
    for source, destination, bound in (("type", "provider_type", 128), ("code", "code", 256),
                                       ("message", "message", 1024)):
        value = safe_diagnostic_text(fields.get(source), request_body, bound)
        if value:
            details[destination] = value
    details.setdefault("message", fallback)
    identifier = (getattr(error, "request_id", None) or request_id or response_request_id(error) or
                  fields.get("request_id") or fields.get("requestId"))
    identifier = safe_diagnostic_text(identifier, request_body, 256)
    if identifier:
        details["request_id"] = identifier
    return details


def response_request_id(response):
    """Inspect only request-id headers, not Authorization or all headers."""
    headers = getattr(getattr(response, "response", None), "headers", None)
    if headers is not None:
        for name in ("x-request-id", "request-id", "x-ds-request-id"):
            if headers.get(name):
                return headers.get(name)
    return getattr(response, "_request_id", None)


def prepare_request(body, profile="math"):
    """Enforce one wire policy for every benchmark and optimizer request."""
    prepared = dict(body)
    extra = dict(prepared.get("extra_body") or {})
    for field in ("top_p", "reasoning_effort", "seed", "temperature", "max_tokens",
                  "max_completion_tokens", "n", "response_format", "stream", "stream_options"):
        extra.pop(field, None)
    extra["thinking"] = {"type": "disabled"}
    prepared["extra_body"] = extra
    for field in ("thinking", "reasoning_effort", "top_p", "max_completion_tokens", "seed"):
        prepared.pop(field, None)
    prepared.update(temperature=0, max_tokens=393216, n=1,
                    response_format={"type": "text"}, stream=True,
                    stream_options={"include_usage": True})
    return prepared


class StreamAccumulator:
    """Reconstruct a ChatCompletion from content and function-call deltas."""
    def __init__(self):
        self.raw = {"object": "chat.completion", "choices": []}
        self.choices = {}

    def add(self, chunk):
        if chunk.get("error"):
            raise ProviderStreamError("Provider stream reported an error", chunk)
        for key in ("id", "model", "created", "system_fingerprint", "usage"):
            if chunk.get(key) is not None:
                self.raw[key] = chunk[key]
        for choice in chunk.get("choices", []):
            index = choice.get("index", 0)
            current = self.choices.setdefault(index, {
                "index": index, "message": {"role": "assistant", "content": ""}, "calls": {}})
            delta = choice.get("delta") or {}
            message = current["message"]
            for field in ("content", "reasoning_content"):
                piece = delta.get(field)
                if piece is not None:
                    if not isinstance(piece, str):
                        raise ProviderStreamError("Unsupported stream content")
                    message[field] = message.get(field, "") + piece
            for call in delta.get("tool_calls") or []:
                call_index = call.get("index")
                if not isinstance(call_index, int) or call_index < 0:
                    raise ProviderStreamError("Invalid streamed tool-call index")
                current_call = current["calls"].setdefault(call_index, {
                    "id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                if call.get("type") is not None and call["type"] != "function":
                    raise ProviderStreamError("Unsupported streamed tool-call type")
                if call.get("id") is not None:
                    current_call["id"] += call["id"]
                for field in ("name", "arguments"):
                    piece = (call.get("function") or {}).get(field)
                    if piece is not None:
                        current_call["function"][field] += piece
            if choice.get("finish_reason") is not None:
                current["finish_reason"] = choice["finish_reason"]

    def finish(self):
        if not self.choices:
            raise ProviderStreamError("Provider stream omitted choices")
        choices = []
        for index in sorted(self.choices):
            current = self.choices[index]
            if not current.get("finish_reason"):
                raise ProviderStreamError("Provider stream omitted finish_reason")
            message = dict(current["message"])
            if current["calls"]:
                message["tool_calls"] = [current["calls"][key] for key in sorted(current["calls"])]
            choices.append({"index": index, "message": message, "finish_reason": current["finish_reason"]})
        return {**self.raw, "choices": choices}


def emit(record):
    print(json.dumps(record, ensure_ascii=False), flush=True)


def log(record):
    target = os.environ.get("DITTO_PROVIDER_LOG")
    if target:
        path = Path(target)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "pid": os.getpid(), **record}) + "\n")


_attempt_context = contextvars.ContextVar("attempt_diagnostics", default=None)
_attempt_reporting = contextvars.ContextVar("attempt_reporting", default=False)


async def record_http_request(request):
    current = _attempt_context.get()
    if current is not None:
        current["attempts"] += 1
        log({"phase": "http-attempt", "id": current["requestId"], "attempt": current["attempts"]})
        # Payload evidence only: never archive Authorization or signed headers.
        if os.environ.get("DITTO_PROVIDER_LOG"):
            log({"phase": "http-request", "id": current["requestId"], "attempt": current["attempts"], "body": json.loads(request.content)})
        if _attempt_reporting.get():
            emit({"id": current["requestId"], "event": "attempt", "diagnostics": dict(current)})


async def record_http_response(response):
    current = _attempt_context.get()
    if current is not None:
        if response.status_code >= 400:
            current["failedAttempts"] += 1
        if response.status_code == 429:
            await response.aread()
            try:
                error_code = response.json().get("error", {}).get("code")
            except (ValueError, TypeError, AttributeError):
                error_code = None
            if isinstance(error_code, str) and error_code in ("AccountQuotaExceeded", "AccountRateLimitExceeded"):
                current["providerErrorCode"] = error_code
            if error_code == "AccountQuotaExceeded":
                # The SDK honors this local retry-control header. An exhausted
                # subscription cannot be repaired by retrying the same request.
                response.headers["x-should-retry"] = "false"
        log({"phase": "http-status", "id": current["requestId"], "attempt": current["attempts"], "status": response.status_code})
        if _attempt_reporting.get():
            emit({"id": current["requestId"], "event": "attempt", "status": response.status_code, "diagnostics": dict(current)})


def account_usage(diagnostics, raw, failed=False):
    if isinstance(raw.get("model"), str):
        diagnostics["responseModel"] = raw["model"]
    if isinstance(raw.get("system_fingerprint"), str):
        diagnostics["systemFingerprint"] = raw["system_fingerprint"]
    usage = raw.get("usage") or {}
    known = all(isinstance(usage.get(k), int) and usage[k] >= 0 for k in ("prompt_tokens", "completion_tokens", "total_tokens"))
    diagnostics.update(inputTokens=usage.get("prompt_tokens", 0), outputTokens=usage.get("completion_tokens", 0), totalTokens=usage.get("total_tokens", 0))
    diagnostics["unknownUsageAttempts"] = max(0, diagnostics["attempts"] - (1 if known else 0))
    diagnostics["usageKnown"] = known and diagnostics["unknownUsageAttempts"] == 0
    if failed:
        diagnostics["failedAttempts"] = diagnostics["attempts"]
    return diagnostics


async def main():
    tasks = {}
    clients = []
    health = {"pid": os.getpid(), "startedAt": datetime.now(timezone.utc).isoformat(),
              "lastSuccessAt": None, "lastRequestAt": None, "lastFailureAt": None,
              "requests": 0, "successes": 0, "failures": 0, "clientRefreshes": 0}
    last_health_write = 0.0

    def make_client():
        # Retain the SDK's existing retry policy. In particular, do not add
        # retries for 400/401/402/403; accounting/authentication failures need
        # operator action, not additional paid evaluation attempts.
        entry = {"sdk": AsyncOpenAI(api_key=os.environ["CODE_SOUL_API_KEY"],
                                    base_url=os.environ["CODE_SOUL_BASE_URL"], max_retries=2,
                                    http_client=httpx.AsyncClient(event_hooks={"request": [record_http_request], "response": [record_http_response]})),
                 "active": 0, "failures": 0, "generation": len(clients) + 1, "retired": False}
        clients.append(entry)
        return entry

    client = make_client()

    def publish_health(force=False):
        nonlocal last_health_write
        target = os.environ.get("DITTO_PROVIDER_LOG")
        if not target or (not force and time.monotonic() - last_health_write < 2):
            return
        path = Path(target + ".health.json")
        temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps({"at": datetime.now(timezone.utc).isoformat(),
                **health, "active": sum(entry["active"] for entry in clients),
                "currentClientGeneration": client["generation"]}) + "\n", encoding="utf-8")
            os.replace(temporary, path)
            last_health_write = time.monotonic()
        except OSError:
            # Telemetry must not break successful requests when Windows
            # readers briefly deny replacement of an open status file.
            pass

    async def invoke(request):
        nonlocal client
        diagnostics = {"requestId": request["id"], "attempts": 0, "failedAttempts": 0, "unknownUsageAttempts": 0,
                       "usageKnown": False, "inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
        token = _attempt_context.set(diagnostics)
        reporting_token = _attempt_reporting.set(bool(request.get("reportAttempts")))
        started = time.monotonic()
        raw = {}
        incoming = request["body"]
        body = prepare_request(incoming, request.get("profile", "math"))
        passthrough = bool(incoming.get("stream"))
        stream_started = False
        provider_request_id = None
        entry = client
        entry["active"] += 1
        health["requests"] += 1
        health["lastRequestAt"] = datetime.now(timezone.utc).isoformat()
        publish_health()
        digest = hashlib.sha256(json.dumps(body.get("messages"), ensure_ascii=False).encode()).hexdigest()
        log({"phase": "request", "id": request["id"], "promptHash": digest, "model": body["model"],
             "profile": request.get("profile", "math"),
             "max_tokens": body.get("max_tokens"), "temperature": body.get("temperature"), "top_p": body.get("top_p"),
             "n": body.get("n"), "response_format": body.get("response_format"), "stream": body.get("stream", False),
             "thinking": (body.get("extra_body") or {}).get("thinking"),
             "reasoning_effort": body.get("reasoning_effort"),
             "toolNames": [tool.get("function", {}).get("name") for tool in body.get("tools") or []],
             "clientGeneration": entry["generation"]})
        try:
            timeout_ms = request.get("timeoutMs", 600000)
            timeout_seconds = None if timeout_ms is None else timeout_ms / 1000
            connect_seconds = request.get("connectTimeoutMs", 10000) / 1000
            async with asyncio.timeout(timeout_seconds):
                response = await entry["sdk"].chat.completions.create(**body, timeout=httpx.Timeout(timeout_seconds, connect=connect_seconds))
                provider_request_id = response_request_id(response)
                if body.get("stream"):
                    aggregate = StreamAccumulator()
                    if passthrough:
                        emit({"id": request["id"], "event": "start", "status": 200})
                        stream_started = True
                    try:
                        async for chunk in response:
                            raw_chunk = chunk.model_dump(exclude_none=True)
                            aggregate.add(raw_chunk)
                            if passthrough:
                                emit({"id": request["id"], "event": "chunk", "body": raw_chunk})
                        raw = aggregate.finish()
                    finally:
                        await response.close()
                else:
                    # Omit SDK-materialized null optional fields for Ditto's parser.
                    raw = response.model_dump(exclude_none=True)
            account_usage(diagnostics, raw)
            entry["failures"] = 0
            health["successes"] += 1
            health["lastSuccessAt"] = datetime.now(timezone.utc).isoformat()
            result = {"id": request["id"], "event": "end"} if passthrough else {"id": request["id"], "status": 200, "body": raw}
            result["diagnostics"] = diagnostics
            log({"phase": "response", "response": raw, "diagnostics": diagnostics, "id": request["id"], "elapsedMs": round((time.monotonic()-started)*1000),
                 "model": raw.get("model"), "fingerprint": raw.get("system_fingerprint"), "usage": raw.get("usage"),
                 "finishReason": raw["choices"][0].get("finish_reason"),
                 "contentChars": len(raw["choices"][0]["message"].get("content") or ""),
                 "toolCalls": len(raw["choices"][0]["message"].get("tool_calls") or [])})
        except asyncio.CancelledError:
            log({"phase": "cancelled", "id": request["id"], "elapsedMs": round((time.monotonic()-started)*1000)})
            return
        except Exception as error:
            health["failures"] += 1
            health["lastFailureAt"] = datetime.now(timezone.utc).isoformat()
            if "aggregate" in locals():
                raw = aggregate.raw
            account_usage(diagnostics, raw, failed=True)
            diagnostic = safe_provider_error(error, body, provider_request_id)
            if diagnostic.get("code") in ("AccountQuotaExceeded", "AccountRateLimitExceeded"):
                diagnostics["providerErrorCode"] = diagnostic["code"]
            status = 504 if isinstance(error, TimeoutError) else diagnostic["status"]
            result = {"id": request["id"], "status": status, "body": {"error": diagnostic}, "diagnostics": diagnostics}
            if stream_started:
                result["event"] = "error"
            log({"phase": "error", "diagnostics": diagnostics, "id": request["id"], "status": status,
                 "errorType": type(error).__name__, "causeType": type(error.__cause__).__name__,
                 "error": diagnostic,
                 "clientGeneration": entry["generation"]})
            if isinstance(error, (APIConnectionError, APITimeoutError)):
                entry["failures"] += 1
                if entry is client and entry["failures"] >= 3:
                    entry["retired"] = True
                    client = make_client()
                    health["clientRefreshes"] += 1
                    log({"phase": "client-refreshed", "oldGeneration": entry["generation"],
                         "newGeneration": client["generation"], "reason": type(error).__name__})
                    # In-flight calls retain the old client. This does not
                    # change generation parameters or add retry attempts.
        finally:
            _attempt_context.reset(token)
            _attempt_reporting.reset(reporting_token)
            entry["active"] -= 1
            if entry["retired"] and entry["active"] == 0:
                await entry["sdk"].close()
            publish_health()
        emit(result)

    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            request = json.loads(line)
            if "cancel" in request:
                task = tasks.get(request["cancel"])
                if task is not None:
                    task.cancel()
                continue
            request_id = request["id"]
            task = asyncio.create_task(invoke(request))
            tasks[request_id] = task
            task.add_done_callback(lambda completed, key=request_id: tasks.pop(key, None))
        if tasks:
            await asyncio.gather(*tasks.values(), return_exceptions=True)
    finally:
        for entry in clients:
            await entry["sdk"].close()
        publish_health(force=True)


if __name__ == "__main__":
    asyncio.run(main())
