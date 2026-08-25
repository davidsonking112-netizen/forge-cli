import io
import json
import pathlib
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
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

    def test_invalid_input_is_reported(self):
        output = io.StringIO()
        with mock.patch("sys.stdin", io.StringIO('{"type":"session.start"}\\n')), redirect_stdout(output):
            self.assertEqual(main(), 0)
        event = json.loads(output.getvalue().splitlines()[0])
        self.assertEqual(event["type"], "error")
        self.assertEqual(event["error"]["code"], "WORKER_PROTOCOL_ERROR")


if __name__ == "__main__":
    unittest.main()
