"""Offline connection-refresh test; no network or real model key."""
import asyncio
import importlib.util
import io
import json
import os
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import unittest
import httpx
from openai import APIConnectionError, APIStatusError, AsyncOpenAI

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).with_name("provider_bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTest(unittest.TestCase):
    def test_opt_in_attempt_progress_exposes_counts_and_http_failures_without_request_data(self):
        replies = []

        async def exercise():
            diagnostics = {"requestId": 7, "attempts": 0, "failedAttempts": 0, "unknownUsageAttempts": 0,
                           "usageKnown": False, "inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
            token = bridge._attempt_context.set(diagnostics)
            reporting = bridge._attempt_reporting.set(True)
            try:
                request = httpx.Request("POST", "https://example.invalid", content="private request")
                await bridge.record_http_request(request)
                await bridge.record_http_response(httpx.Response(503, request=request))
            finally:
                bridge._attempt_reporting.reset(reporting)
                bridge._attempt_context.reset(token)

        with patch.object(bridge, "emit", replies.append), patch.object(bridge, "log", lambda _event: None):
            asyncio.run(exercise())
        self.assertEqual([item["event"] for item in replies], ["attempt", "attempt"])
        self.assertEqual(replies[-1]["status"], 503)
        self.assertEqual(replies[-1]["diagnostics"]["attempts"], 1)
        self.assertEqual(replies[-1]["diagnostics"]["failedAttempts"], 1)
        self.assertNotIn("private request", json.dumps(replies))

    def test_long_and_unlimited_budgets_replace_hidden_read_deadline_keep_connect_separate(self):
        observed = []
        overall = []
        real_timeout = asyncio.timeout

        def capture_timeout(value):
            overall.append(value)
            return real_timeout(value)

        class FakeStream:
            async def __aiter__(self):
                yield SimpleNamespace(model_dump=lambda **kwargs: {
                    "choices": [{"index": 0, "delta": {"content": "2"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})

            async def close(self):
                pass

        class FakeClient:
            def __init__(self, **kwargs):
                self.chat = SimpleNamespace(completions=self)
                self.http = kwargs["http_client"]

            async def create(self, **kwargs):
                timeout = kwargs["timeout"]
                observed.append((timeout.read, timeout.write, timeout.pool, timeout.connect))
                return FakeStream()

            async def close(self):
                await self.http.aclose()

        requests = [{"id": index + 1, "timeoutMs": limit, "connectTimeoutMs": 10000,
                     "body": {"model": "fixture", "messages": []}}
                    for index, limit in enumerate([1200000, None])]
        output = io.StringIO()
        with patch.object(bridge, "AsyncOpenAI", FakeClient), patch.object(bridge.asyncio, "timeout", capture_timeout), \
             patch.object(bridge.sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in requests))), \
             patch.object(bridge.sys, "stdout", output), patch.dict(os.environ, {
                 "CODE_SOUL_API_KEY": "fixture", "CODE_SOUL_BASE_URL": "https://example.invalid", "DITTO_PROVIDER_LOG": ""}):
            asyncio.run(bridge.main())
        self.assertEqual(overall, [1200, None])
        self.assertEqual(observed, [(1200, 1200, 1200, 10), (None, None, None, 10)])
        self.assertEqual([json.loads(line)["status"] for line in output.getvalue().splitlines()], [200, 200])

    def test_error_diagnostics_allowlist_nested_fields_and_header_request_id(self):
        request = httpx.Request("POST", "https://example.invalid", headers={"Authorization": "Bearer hidden-header"})
        response = httpx.Response(402, request=request, headers={
            "x-request-id": "request-402", "authorization": "Bearer hidden-response-header"})
        payload = {"request_id": "body-id", "debug": {"messages": ["never-serialize-debug"]},
                   "error": {"type": "outer", "error": {
                       "type": "account_error", "code": "insufficient_balance", "message": "Balance unavailable",
                       "password": "never-serialize-password"}}}
        error = APIStatusError("unsafe SDK repr with never-serialize-sdk", response=response, body=payload)
        diagnostic = bridge.safe_provider_error(error)
        self.assertEqual(diagnostic, {"type": "APIStatusError", "status": 402, "provider_type": "account_error",
                                      "code": "insufficient_balance", "message": "Balance unavailable", "request_id": "request-402"})
        self.assertNotIn("never-serialize", json.dumps(diagnostic))
        self.assertNotIn("hidden-header", json.dumps(diagnostic))

    def test_error_diagnostics_redact_keys_bearer_and_request_inputs_before_truncation(self):
        configured_key = "configured-complete-key-without-sk-prefix"
        prompt = "private user prompt must never appear"
        arguments = '{"account":"private-account-12345"}'
        body = {"messages": [{"role": "user", "content": prompt}, {
            "role": "assistant", "tool_calls": [{"function": {"name": "read", "arguments": arguments}}]}]}
        with patch.dict(os.environ, {"CODE_SOUL_API_KEY": configured_key}):
            text = bridge.safe_diagnostic_text(
                "problem sk-example-key-123 Bearer provider-token-not-sk " + configured_key + " " + prompt + " " + arguments)
            self.assertIn("[REDACTED]", text)
            # The request itself is not passed into logs; it is used only to
            # eliminate an echoed prompt or exact tool argument in diagnostics.
            protected = bridge.safe_diagnostic_text(prompt + " " + arguments, body)
            self.assertNotIn(prompt, protected)
            self.assertNotIn(arguments, protected)
            self.assertNotIn("private-account-12345", bridge.safe_diagnostic_text("Invalid account private-account-12345", body))
            bounded = bridge.safe_diagnostic_text("x" * 1500 + " sk-secret-beyond-limit", body)
        for secret in ("sk-example-key-123", "provider-token-not-sk", configured_key):
            self.assertNotIn(secret, text)
        self.assertEqual(len(bounded), 1024)
        self.assertTrue(bounded.endswith(" [truncated]"))
        self.assertNotIn("sk-secret-beyond-limit", bounded)

    def test_structured_and_non_scalar_error_messages_are_not_dumped(self):
        request = httpx.Request("POST", "https://example.invalid")
        response = httpx.Response(400, request=request)
        cases = [
            {"error": {"message": {"messages": ["private-content"]}, "code": ["private-code"]}},
            {"error": {"message": 'Request: {"messages": [{"content": "private-content"}]}' }},
            {"error": {"message": 'Request: {\\"messages\\": [{\\"content\\": \\"private-content\\"}]}' }},
            "<html>Authorization: Bearer private-content</html>",
        ]
        for payload in cases:
            with self.subTest(payload_type=type(payload).__name__):
                result = bridge.safe_provider_error(APIStatusError("unsafe private-content", response=response, body=payload))
                self.assertNotIn("private-content", json.dumps(result))
                self.assertNotIn("private-code", json.dumps(result))
                self.assertIn("message", result)

    def test_json_string_error_body_and_request_id_header_allowlist(self):
        response = httpx.Response(400, request=httpx.Request("POST", "https://example.invalid"),
                                  headers={"request-id": "alternative-request-id", "set-cookie": "do-not-log-cookie"})
        error = APIStatusError("not-for-logging", response=response,
                               body=json.dumps({"error": {"code": 40001, "message": "Parameter unsupported"}}))
        diagnostic = bridge.safe_provider_error(error)
        self.assertEqual(diagnostic["request_id"], "alternative-request-id")
        self.assertEqual(diagnostic["code"], "40001")
        self.assertEqual(diagnostic["message"], "Parameter unsupported")
        self.assertNotIn("do-not-log-cookie", json.dumps(diagnostic))

    def test_http_account_and_request_errors_are_not_sdk_retried_and_keep_safe_evidence(self):
        calls = []
        records = []

        def handler(request):
            status = int(json.loads(request.content)["model"].split("-")[-1])
            calls.append(status)
            return httpx.Response(status, headers={"x-request-id": f"request-{status}",
                "authorization": "Bearer do-not-log-header"}, json={"error": {
                    "type": "account_error", "code": f"error_{status}",
                    "message": "Rejected sk-do-not-log-fixture Bearer do-not-log-bearer",
                    "debug": {"messages": ["do-not-log-body"]}}})

        def make_client(**kwargs):
            injected = kwargs.pop("http_client", None)
            # Retain production attempt hooks while replacing only the network.
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                       event_hooks=injected.event_hooks if injected else None)
            if injected is not None:
                asyncio.get_running_loop().create_task(injected.aclose())
            return AsyncOpenAI(**kwargs, http_client=client)

        requests = [{"id": index, "profile": "automationbench", "body": {"model": f"fixture-{status}",
                    "messages": [{"role": "user", "content": "private-prompt-do-not-log"}]}}
                    for index, status in enumerate((400, 401, 402, 403), 1)]
        output = io.StringIO()
        with patch.object(bridge, "AsyncOpenAI", make_client), patch.object(bridge, "log", records.append), \
             patch.object(bridge.sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in requests))), \
             patch.object(bridge.sys, "stdout", output), patch.dict(os.environ, {
                 "CODE_SOUL_API_KEY": "fixture", "CODE_SOUL_BASE_URL": "https://example.invalid", "DITTO_PROVIDER_LOG": ""}):
            asyncio.run(bridge.main())
        self.assertEqual(sorted(calls), [400, 401, 402, 403])
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(sorted(item["status"] for item in replies), [400, 401, 402, 403])
        for reply in replies:
            detail = reply["body"]["error"]
            self.assertEqual(detail["request_id"], f'request-{reply["status"]}')
            self.assertEqual(detail["code"], f'error_{reply["status"]}')
            self.assertEqual(detail["provider_type"], "account_error")
        all_records = json.dumps(records) + output.getvalue()
        for secret in ("sk-do-not-log-fixture", "do-not-log-bearer", "do-not-log-header", "do-not-log-body", "private-prompt-do-not-log"):
            self.assertNotIn(secret, all_records)
        errors = [record for record in records if record["phase"] == "error"]
        self.assertEqual(len(errors), 4)
        self.assertTrue(all(record["error"]["request_id"] for record in errors))

    def test_incomplete_stream_has_safe_message_request_id_and_no_partial_success(self):
        calls = []
        records = []
        chunks = [{"choices": [{"index": 0, "delta": {"content": "incomplete"}}]}]
        sse = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n"

        def handler(request):
            calls.append(request)
            return httpx.Response(200, headers={"content-type": "text/event-stream", "x-request-id": "stream-incomplete-id"}, content=sse)

        def make_client(**kwargs):
            injected = kwargs.pop("http_client", None)
            # Retain production attempt hooks while replacing only the network.
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                       event_hooks=injected.event_hooks if injected else None)
            if injected is not None:
                asyncio.get_running_loop().create_task(injected.aclose())
            return AsyncOpenAI(**kwargs, http_client=client)

        request = {"id": 1, "profile": "automationbench", "body": {"model": "fixture", "messages": [], "stream": True}}
        output = io.StringIO()
        with patch.object(bridge, "AsyncOpenAI", make_client), patch.object(bridge, "log", records.append), \
             patch.object(bridge.sys, "stdin", io.StringIO(json.dumps(request) + "\n")), \
             patch.object(bridge.sys, "stdout", output), patch.dict(os.environ, {
                 "CODE_SOUL_API_KEY": "fixture", "CODE_SOUL_BASE_URL": "https://example.invalid", "DITTO_PROVIDER_LOG": ""}):
            asyncio.run(bridge.main())
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([item["event"] for item in replies], ["start", "chunk", "error"])
        self.assertEqual(replies[-1]["status"], 599)
        self.assertEqual(replies[-1]["body"]["error"]["type"], "ValueError")
        self.assertEqual(replies[-1]["body"]["error"]["request_id"], "stream-incomplete-id")
        self.assertIn("finish_reason", replies[-1]["body"]["error"]["message"])
        self.assertEqual(len(calls), 1)
        self.assertFalse(any(item["phase"] == "response" for item in records))

    def test_stream_provider_error_preserves_safe_fields_not_untrusted_error_body(self):
        records = []
        chunks = [{"error": {"type": "account_error", "code": "stream_rejected", "message": "Provider rejected stream",
                              "debug": {"messages": ["private-stream-debug"]}}}]
        sse = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)

        def handler(request):
            return httpx.Response(200, headers={"content-type": "text/event-stream", "x-request-id": "stream-error-id"}, content=sse)

        def make_client(**kwargs):
            injected = kwargs.pop("http_client", None)
            # Retain production attempt hooks while replacing only the network.
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                       event_hooks=injected.event_hooks if injected else None)
            if injected is not None:
                asyncio.get_running_loop().create_task(injected.aclose())
            return AsyncOpenAI(**kwargs, http_client=client)

        request = {"id": 1, "profile": "automationbench", "body": {"model": "fixture", "messages": [], "stream": True}}
        output = io.StringIO()
        with patch.object(bridge, "AsyncOpenAI", make_client), patch.object(bridge, "log", records.append), \
             patch.object(bridge.sys, "stdin", io.StringIO(json.dumps(request) + "\n")), \
             patch.object(bridge.sys, "stdout", output), patch.dict(os.environ, {
                 "CODE_SOUL_API_KEY": "fixture", "CODE_SOUL_BASE_URL": "https://example.invalid", "DITTO_PROVIDER_LOG": ""}):
            asyncio.run(bridge.main())
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([item["event"] for item in replies], ["start", "error"])
        error = replies[-1]["body"]["error"]
        self.assertEqual(error["code"], "stream_rejected")
        self.assertEqual(error["provider_type"], "account_error")
        self.assertEqual(error["request_id"], "stream-error-id")
        self.assertNotIn("private-stream-debug", json.dumps(records) + output.getvalue())

    def test_cancellation_stops_sdk_stream_and_closes_it(self):
        started = threading.Event()
        lifecycle = []

        class FakeStream:
            async def __aiter__(self):
                yield SimpleNamespace(model_dump=lambda **kwargs: {
                    "choices": [{"index": 0, "delta": {"content": "partial"}}]})
                started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    lifecycle.append("cancelled")
                    raise

            async def close(self):
                lifecycle.append("stream-closed")

        class FakeClient:
            def __init__(self, **kwargs):
                self.chat = SimpleNamespace(completions=self)

            async def create(self, **kwargs):
                return FakeStream()

            async def close(self):
                lifecycle.append("client-closed")

        class Input:
            calls = 0

            def readline(self):
                self.calls += 1
                if self.calls == 1:
                    return json.dumps({"id": 1, "profile": "automationbench", "body": {
                        "model": "fixture", "messages": [], "stream": True}}) + "\n"
                if self.calls == 2:
                    if not started.wait(2):
                        raise RuntimeError("Fixture stream did not start")
                    return '{"cancel":1}\n'
                return ""

        output = io.StringIO()
        with patch.object(bridge, "AsyncOpenAI", FakeClient), patch.object(bridge.sys, "stdin", Input()), \
             patch.object(bridge.sys, "stdout", output), patch.dict(os.environ, {
                 "CODE_SOUL_API_KEY": "fixture", "CODE_SOUL_BASE_URL": "https://example.invalid", "DITTO_PROVIDER_LOG": ""}):
            asyncio.run(bridge.main())
        self.assertEqual(lifecycle, ["cancelled", "stream-closed", "client-closed"])
        self.assertEqual([json.loads(line)["event"] for line in output.getvalue().splitlines()], ["start", "chunk"])

    def test_automation_profile_uses_sdk_extra_body_and_real_streaming_for_both_modes(self):
        captured = []
        records = []
        chunks = [
            {"id": "fixture", "model": "fixture", "system_fingerprint": "offline", "choices": [
                {"index": 0, "delta": {"content": "read ", "reasoning_content": "fixture reasoning", "tool_calls": [
                    {"index": 0, "id": "call-1", "type": "function", "function": {"name": "read_", "arguments": '{"path":'}}]}}]},
            {"choices": [{"index": 0, "delta": {"content": "file", "tool_calls": [
                {"index": 0, "function": {"name": "file", "arguments": '"x"}'}}]}, "finish_reason": "tool_calls"}]},
            {"choices": [], "usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6}},
        ]
        sse = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n"

        def handler(request):
            captured.append(json.loads(request.content))
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse)

        def make_client(**kwargs):
            injected = kwargs.pop("http_client", None)
            # Retain production attempt hooks while replacing only the network.
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                       event_hooks=injected.event_hooks if injected else None)
            if injected is not None:
                asyncio.get_running_loop().create_task(injected.aclose())
            return AsyncOpenAI(**kwargs, http_client=client)

        body = {"model": "fixture", "messages": [{"role": "user", "content": "private-prompt-do-not-log"}],
                "temperature": 0.9, "top_p": 0.8, "reasoning_effort": "high", "max_tokens": 100,
                "thinking": {"type": "enabled"}, "extra_body": {"temperature": 1, "top_p": 1, "reasoning_effort": "high"}}
        requests = [{"id": 1, "profile": "automationbench", "body": {**body, "stream": False}},
                    {"id": 2, "profile": "automationbench", "body": {**body, "stream": True}}]
        output = io.StringIO()
        with patch.object(bridge, "AsyncOpenAI", make_client), patch.object(bridge, "log", records.append), \
             patch.object(bridge.sys, "stdin", io.StringIO("".join(json.dumps(request) + "\n" for request in requests))), \
             patch.object(bridge.sys, "stdout", output), patch.dict(os.environ, {
                 "CODE_SOUL_API_KEY": "private-key-do-not-log", "CODE_SOUL_BASE_URL": "https://example.invalid", "DITTO_PROVIDER_LOG": ""}):
            asyncio.run(bridge.main())
        self.assertEqual(len(captured), 2)
        for wire in captured:
            self.assertEqual(wire["thinking"], {"type": "disabled"})
            self.assertNotIn("top_p", wire)
            self.assertNotIn("reasoning_effort", wire)
            self.assertEqual(wire["temperature"], 0)
            self.assertEqual(wire["max_tokens"], 393216)
            self.assertEqual(wire["n"], 1)
            self.assertEqual(wire["response_format"], {"type": "text"})
            self.assertTrue(wire["stream"])
            self.assertEqual(wire["stream_options"], {"include_usage": True})
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        ordinary = next(reply for reply in replies if reply["id"] == 1)
        self.assertEqual(ordinary["status"], 200)
        choice = ordinary["body"]["choices"][0]
        self.assertEqual(choice["message"]["content"], "read file")
        self.assertEqual(choice["finish_reason"], "tool_calls")
        self.assertEqual(choice["message"]["tool_calls"], [
            {"id": "call-1", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"x"}'}}])
        self.assertEqual(ordinary["body"]["usage"]["total_tokens"], 6)
        streamed = [reply for reply in replies if reply["id"] == 2]
        self.assertEqual([reply["event"] for reply in streamed], ["start", "chunk", "chunk", "chunk", "end"])
        self.assertNotIn("private-prompt-do-not-log", json.dumps(records))
        self.assertNotIn("private-key-do-not-log", json.dumps(records))
        responses = [record for record in records if record["phase"] == "response"]
        self.assertEqual(len(responses), 2)
        self.assertTrue(all(record["toolCalls"] == 1 and record["finishReason"] == "tool_calls" for record in responses))

    def test_every_profile_enforces_the_same_request_policy_without_mutation(self):
        body = {"model": "fixture", "messages": [], "temperature": 0.2, "top_p": 1,
                "max_tokens": 16384, "max_completion_tokens": 12, "stream": False,
                "reasoning_effort": "high", "seed": 42,
                "extra_body": {"top_p": 0.8, "reasoning_effort": "high", "seed": 42,
                               "max_tokens": 64, "thinking": {"type": "enabled"}}}
        original = json.loads(json.dumps(body))
        for profile in ("math", "drop", "gsm8k", "automationbench"):
            with self.subTest(profile=profile):
                prepared = bridge.prepare_request(body, profile)
                self.assertEqual(prepared["temperature"], 0)
                self.assertEqual(prepared["max_tokens"], 393216)
                self.assertEqual(prepared["n"], 1)
                self.assertEqual(prepared["response_format"], {"type": "text"})
                self.assertTrue(prepared["stream"])
                self.assertEqual(prepared["extra_body"], {"thinking": {"type": "disabled"}})
                for key in ("top_p", "reasoning_effort", "seed", "max_completion_tokens"):
                    self.assertNotIn(key, prepared)
        self.assertEqual(body, original)

    def test_tool_only_stream_and_missing_finish_reason(self):
        aggregate = bridge.StreamAccumulator()
        aggregate.add({"choices": [{"index": 0, "delta": {"tool_calls": [
            {"index": 0, "id": "call", "function": {"name": "tool", "arguments": "{}"}}]}}]})
        with self.assertRaisesRegex(ValueError, "finish_reason"):
            aggregate.finish()
        aggregate.add({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})
        raw = aggregate.finish()
        self.assertEqual(raw["choices"][0]["message"]["content"], "")
        self.assertEqual(len(raw["choices"][0]["message"]["tool_calls"]), 1)

    def test_refreshes_client_without_retrying_the_same_request(self):
        clients = []

        class FakeStream:
            async def __aiter__(self):
                yield SimpleNamespace(model_dump=lambda **kwargs: {"choices": [
                    {"index": 0, "delta": {"content": "4"}, "finish_reason": "stop"}]})

            async def close(self):
                pass

        class FakeClient:
            def __init__(self, **kwargs):
                self.generation = len(clients) + 1
                self.calls = 0
                self.closed = False
                clients.append(self)
                self.chat = SimpleNamespace(completions=self)

            async def create(self, **body):
                self.calls += 1
                if self.generation == 1:
                    raise APIConnectionError(request=httpx.Request("POST", "https://example.invalid"))
                return FakeStream()

            async def close(self):
                self.closed = True

        requests = "".join(json.dumps({"id": index, "body": {"model": "fixture", "messages": []}})+"\n" for index in range(1, 5))
        output = io.StringIO()
        with patch.object(bridge, "AsyncOpenAI", FakeClient), patch.object(bridge.sys, "stdin", io.StringIO(requests)), \
             patch.object(bridge.sys, "stdout", output), patch.dict(os.environ, {"CODE_SOUL_API_KEY": "fixture", "CODE_SOUL_BASE_URL": "https://example.invalid", "DITTO_PROVIDER_LOG": ""}):
            asyncio.run(bridge.main())
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([reply["status"] for reply in replies], [599, 599, 599, 200])
        self.assertEqual(replies[-1]["body"]["choices"][0]["message"]["content"], "4")
        self.assertEqual([client.calls for client in clients], [3, 1])
        self.assertTrue(all(client.closed for client in clients))


if __name__ == "__main__":
    unittest.main()
