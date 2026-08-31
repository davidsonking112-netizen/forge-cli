"""Compatibility matrix tests for the OpenAI-compatible provider boundary."""
from __future__ import annotations

import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from forge_agent.providers import OpenAICompatibleProvider, ProviderReply


class _ScenarioHandler(BaseHTTPRequestHandler):
    scenario = "normal"
    calls = 0
    bodies: list[dict] = []

    def log_message(self, *_args: object) -> None:
        return

    def do_POST(self) -> None:  # noqa: N802
        type(self).calls += 1
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).bodies.append(body)
        if self.scenario == "retry" and type(self).calls == 1:
            self.send_response(429)
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"rate limited"}}')
            return
        if self.scenario == "malformed":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"not_choices":true}')
            return
        if self.scenario == "timeout":
            time.sleep(0.2)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if self.scenario == "stream" else "application/json")
        self.end_headers()
        if self.scenario == "stream":
            chunks = [
                {"choices":[{"delta":{"content":"hello "}}]},
                {"choices":[{"delta":{"content":"world"}}]},
                {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"workspace_read","arguments":"{\"path\":\"README.md\"}"}}]}}]},
            ]
            for chunk in chunks:
                self.wfile.write((f"data: {json.dumps(chunk)}\n\n").encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            return
        payload = {"choices": [{"message": {"content": "hello", "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "workspace_read", "arguments": '{"path":"README.md"}'}}]}}], "usage": {"prompt_tokens": 3, "completion_tokens": 2}}
        try:
            self.wfile.write(json.dumps(payload).encode())
        except BrokenPipeError:
            pass


class ProviderCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _ScenarioHandler.calls = 0
        _ScenarioHandler.bodies = []
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _ScenarioHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        _ScenarioHandler.calls = 0
        _ScenarioHandler.bodies = []

    def provider(self, *, scenario: str, **kwargs) -> OpenAICompatibleProvider:
        _ScenarioHandler.scenario = scenario
        return OpenAICompatibleProvider(api_key="test-key", base_url=self.base_url, model=kwargs.pop("model", "test-model"), timeout=kwargs.pop("timeout", 1.0), max_tokens=64, max_retries=kwargs.pop("max_retries", 0), token_parameter=kwargs.pop("token_parameter", "auto"), **kwargs)

    def tools(self):
        return [{"type": "function", "function": {"name": "workspace.read", "description": "Read", "parameters": {"type": "object"}}}]

    def test_normal_tool_response_is_normalized(self):
        reply = self.provider(scenario="normal").complete(messages=[{"role": "user", "content": "hi"}], tools=self.tools())
        self.assertIsInstance(reply, ProviderReply)
        self.assertEqual(reply.tool_calls[0].name, "workspace.read")
        self.assertEqual(reply.tool_calls[0].arguments["path"], "README.md")

    def test_streaming_accumulates_text_and_tool_calls(self):
        chunks: list[str] = []
        reply = self.provider(scenario="stream").complete(messages=[{"role": "user", "content": "hi"}], tools=self.tools(), on_text=chunks.append)
        self.assertEqual("".join(chunks), "hello world")
        self.assertEqual(reply.tool_calls[0].name, "workspace.read")

    def test_retryable_http_status_retries(self):
        reply = self.provider(scenario="retry", max_retries=1).complete(messages=[{"role": "user", "content": "hi"}], tools=[])
        self.assertEqual(reply.text, "hello")
        self.assertEqual(_ScenarioHandler.calls, 2)

    def test_token_parameter_matrix(self):
        matrix = [("gpt-5-mini", "auto", "max_completion_tokens"), ("llama-test", "auto", "max_tokens"), ("any", "max_completion_tokens", "max_completion_tokens"), ("any", "max_tokens", "max_tokens")]
        for model, configured, expected in matrix:
            self.setUp()
            self.provider(scenario="normal", model=model, token_parameter=configured).complete(messages=[{"role": "user", "content": "hi"}], tools=[])
            self.assertIn(expected, _ScenarioHandler.bodies[-1])

    def test_malformed_success_payload_fails_closed(self):
        with self.assertRaises((RuntimeError, IndexError, KeyError)):
            self.provider(scenario="malformed").complete(messages=[{"role": "user", "content": "hi"}], tools=[])

    def test_timeout_with_zero_retry_budget_fails(self):
        with self.assertRaises((RuntimeError, TimeoutError)):
            self.provider(scenario="timeout", timeout=0.01, max_retries=0).complete(messages=[{"role": "user", "content": "hi"}], tools=[])


if __name__ == "__main__":
    unittest.main()
