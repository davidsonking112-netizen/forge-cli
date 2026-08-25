import io
import json
import os
import pathlib
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from forge_agent.orchestration import BoundedOrchestrator
from forge_agent.providers import MockProvider, OpenAICompatibleProvider, ProviderReply, redact
from forge_agent.worker import main


class WorkerTests(unittest.TestCase):
    def test_mock_worker_emits_plan_and_completion(self):
        messages = [
            {
                "protocol": 1,
                "id": "start",
                "sessionId": "session-1",
                "type": "session.start",
                "timestamp": "2026-01-01T00:00:00Z",
                "workspace": ".",
                "policy": "safe",
                "provider": "mock",
                "capabilities": [],
                "prompt": "Explain this repository",
            },
            {
                "protocol": 1,
                "id": "result-1",
                "sessionId": "session-1",
                "type": "tool.result",
                "timestamp": "2026-01-01T00:00:01Z",
                "tool": "workspace.list",
                "ok": True,
                "output": [],
                "approved": True,
                "durationMs": 1,
            },
            {
                "protocol": 1,
                "id": "result-2",
                "sessionId": "session-1",
                "type": "tool.result",
                "timestamp": "2026-01-01T00:00:02Z",
                "tool": "workspace.read",
                "ok": True,
                "output": {"path": "README.md", "content": "# Fixture"},
                "approved": True,
                "durationMs": 1,
            },
        ]
        stdin = "".join(json.dumps(message) + "\n" for message in messages)
        output = io.StringIO()
        with mock.patch("sys.stdin", io.StringIO(stdin)), redirect_stdout(output):
            self.assertEqual(main(), 0)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(any(event["type"] == "agent.plan" for event in events))
        self.assertTrue(any(event["type"] == "session.complete" and event["status"] == "completed" for event in events))

    def test_orchestrator_is_bounded_and_sequential(self):
        class FakeProvider:
            def __init__(self):
                self.calls = 0

            def complete(self, *, messages, tools, on_text=None):
                self.calls += 1
                return ProviderReply(text=f"role response {self.calls}")

        provider = FakeProvider()
        report = BoundedOrchestrator(max_agents=2, max_total_turns=2).run(provider=provider, goal="review code", context="bounded context")
        self.assertEqual(provider.calls, 2)
        self.assertEqual([result.role for result in report.results], ["explorer", "implementer"])
        self.assertIn("role response 1", report.merged_summary)

    def test_worker_opt_in_multi_agent_flow_emits_delegations(self):
        output = io.StringIO()
        environment = {"FORGE_PROVIDER": "openai-compatible", "FORGE_MULTI_AGENT": "1", "FORGE_MAX_AGENTS": "2", "FORGE_MAX_TOTAL_TURNS": "2"}
        with mock.patch.dict(os.environ, environment, clear=False), mock.patch("forge_agent.worker.build_provider", return_value=MockProvider()), mock.patch("sys.stdin", io.StringIO(json.dumps({"type": "session.start", "sessionId": "multi", "workspace": ".", "prompt": "review code", "context": {}}) + "\n")), redirect_stdout(output):
            self.assertEqual(main(), 0)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        delegations = [event for event in events if event["type"] == "agent.delegation"]
        self.assertEqual(len(delegations), 2)
        self.assertTrue(all(event["status"] == "completed" for event in delegations))
        self.assertTrue(any(event["type"] == "session.complete" for event in events))

    def test_provider_errors_are_redacted(self):
        message = redact('api_key=sk-1234567890 secret=visible token=abc123')
        self.assertIn('api_key=[REDACTED]', message)
        self.assertIn('secret=[REDACTED]', message)
        self.assertIn('token=[REDACTED]', message)
        self.assertNotIn('abc123', message)

    def test_provider_normalizes_tool_calls(self):
        provider = OpenAICompatibleProvider.__new__(OpenAICompatibleProvider)
        reply = provider._parse_payload({"choices": [{"message": {"content": "", "tool_calls": [{"id": "call-1", "function": {"name": "workspace.read", "arguments": '{"path":"README.md"}'}}]}}], "usage": {"total_tokens": 3}})
        self.assertEqual(reply.tool_calls[0].name, "workspace.read")
        self.assertEqual(reply.tool_calls[0].arguments["path"], "README.md")
        self.assertEqual(reply.usage["total_tokens"], 3)

    def test_streaming_provider_normalizes_fragments(self):
        provider = OpenAICompatibleProvider.__new__(OpenAICompatibleProvider)
        chunks = [
            b'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
            b'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
            b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"workspace.read","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\n\n',
            b'data: [DONE]\n\n',
        ]
        fragments = []
        reply = provider._read_stream(chunks, fragments.append)
        self.assertEqual("".join(fragments), "hello world")
        self.assertEqual(reply.tool_calls[0].arguments["path"], "README.md")

    def test_mock_provider_streams_text_callback(self):
        fragments = []
        reply = MockProvider().complete(messages=[{"role": "user", "content": "hello"}], tools=[], on_text=fragments.append)
        self.assertEqual(reply.text, "Mock provider response for: hello")
        self.assertEqual(fragments, [reply.text])

    def test_invalid_input_is_reported(self):
        output = io.StringIO()
        with mock.patch("sys.stdin", io.StringIO('{"type":"session.start"}\\n')), redirect_stdout(output):
            self.assertEqual(main(), 0)
        event = json.loads(output.getvalue().splitlines()[0])
        self.assertEqual(event["type"], "error")
        self.assertEqual(event["error"]["code"], "WORKER_PROTOCOL_ERROR")


if __name__ == "__main__":
    unittest.main()
