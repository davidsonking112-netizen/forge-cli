import io
import json
import os
import pathlib
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from forge_agent.horizon import LongHorizonBuffer
from forge_agent.orchestration import BoundedOrchestrator
from forge_agent.providers import MockProvider, OpenAICompatibleProvider, ProviderReply, ToolCall, build_provider, redact
from forge_agent.worker import MockAgent, main, protocol_json, redact_error, selected_roles, verification_check


class WorkerTests(unittest.TestCase):
    def test_long_horizon_buffer_compacts_without_dropping_anchors(self):
        buffer = LongHorizonBuffer(max_chars=1_000, max_messages=8, recent_messages=2)
        buffer.append({"role": "system", "content": "system anchor"})
        buffer.append({"role": "user", "content": "task anchor"})
        for index in range(12):
            buffer.append({"role": "tool", "content": f"evidence-{index} " * 20})
        snapshot = buffer.snapshot()
        self.assertLessEqual(buffer._size(snapshot), 1_000)
        self.assertEqual(snapshot[0]["content"], "system anchor")
        self.assertEqual(snapshot[1]["content"], "task anchor")
        self.assertGreater(buffer.compactions, 0)
        self.assertIn("Earlier bounded conversation", buffer.summary)

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
                "workspaceFingerprint": "a" * 64,
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
        checklists = [event for event in events if event["type"] == "agent.checklist"]
        self.assertGreaterEqual(len(checklists), 3)
        self.assertEqual(checklists[0]["items"][0]["status"], "active")
        final_checklist = checklists[-1]["items"]
        self.assertEqual(final_checklist[0]["status"], "complete")
        self.assertEqual(final_checklist[4]["status"], "blocked")
        self.assertTrue(any(event["type"] == "session.complete" and event["status"] == "completed" for event in events))

    def test_orchestrator_is_bounded_and_sequential(self):
        class FakeProvider:
            def __init__(self):
                self.calls = 0
                self.requests = []

            def complete(self, *, messages, tools, on_text=None):
                self.calls += 1
                self.requests.append({"messages": messages, "tools": tools})
                return ProviderReply(text=f"role response {self.calls}")

        provider = FakeProvider()
        report = BoundedOrchestrator(max_agents=2, max_total_turns=2).run(provider=provider, goal="review code", context="bounded context")
        self.assertEqual(provider.calls, 2)
        self.assertEqual([result.role for result in report.results], ["explorer", "implementer"])
        self.assertIn("role response 1", report.merged_summary)
        self.assertEqual(provider.calls, 2)
        self.assertTrue(all("Never spawn agents" in call["messages"][0]["content"] for call in provider.requests))
        self.assertEqual([call["tools"] for call in provider.requests], [[], []])

    def test_worker_opt_in_multi_agent_flow_emits_delegations(self):
        output = io.StringIO()
        environment = {"FORGE_PROVIDER": "openai-compatible", "FORGE_MULTI_AGENT": "1", "FORGE_MAX_AGENTS": "2", "FORGE_MAX_TOTAL_TURNS": "2"}
        with mock.patch.dict(os.environ, environment, clear=False), mock.patch("forge_agent.worker.build_provider", return_value=MockProvider()), mock.patch("sys.stdin", io.StringIO(json.dumps({"type": "session.start", "sessionId": "multi", "workspace": ".", "prompt": "review code", "context": {}}) + "\n")), redirect_stdout(output):
            self.assertEqual(main(), 0)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        delegations = [event for event in events if event["type"] == "agent.delegation"]
        self.assertEqual(len(delegations), 2)
        self.assertTrue(all(event["status"] == "completed" for event in delegations))
        self.assertTrue(all(event["budget"]["profile"] == "balanced" for event in delegations))
        self.assertEqual(delegations[-1]["budget"]["usedRoles"], 2)
        self.assertTrue(any(event["type"] == "agent.checklist" for event in events))
        self.assertTrue(any(event["type"] == "session.complete" for event in events))

    def test_cost_scope_is_conservative_for_high_risk_goals(self):
        self.assertEqual(selected_roles("summarize the repository", 2), ("explorer", "implementer"))
        self.assertEqual(selected_roles("create a new file safely", 2), ("explorer", "implementer", "tester", "reviewer"))

    def test_role_contracts_are_detailed_and_empty_output_fails_closed(self):
        class EmptyProvider:
            def complete(self, *, messages, tools, on_text=None):
                self.messages = messages
                self.tools = tools
                return ProviderReply(text="")

        provider = EmptyProvider()
        report = BoundedOrchestrator(max_agents=1, max_total_turns=1).run(provider=provider, goal="inspect safely")
        self.assertEqual(report.results[0].status, "failed")
        self.assertIn("empty", report.results[0].error.lower())
        self.assertEqual(provider.tools, [])
        self.assertIn("evidence", provider.messages[1]["content"].lower())
        self.assertIn("approval", provider.messages[0]["content"].lower())

    def test_repair_attempts_escalate_and_exhaust_at_four(self):
        class RepairProvider:
            def complete(self, *, messages, tools, on_text=None):
                del messages, tools, on_text
                return ProviderReply(tool_calls=(ToolCall("repair", "process.run", {"command": "false"}),))

        agent = MockAgent("repair")
        agent.provider = RepairProvider()
        agent.pending_call = ToolCall("initial", "process.run", {"command": "false"})
        agent.repair_attempts = 1
        agent.pending_assistant_message = {"role": "assistant", "tool_calls": []}
        all_events = []
        for _ in range(4):
            all_events.extend(agent.on_provider_tool_result({
                "tool": "process.run",
                "ok": False,
                "approved": True,
                "error": {"code": "COMMAND_FAILED", "message": "failed", "retryable": True},
                "output": {"command": "false", "exitCode": 1, "output": ""},
            }))
            if any(item.get("type") == "session.complete" for item in all_events):
                break
        repairs = [item for item in all_events if item.get("type") == "agent.repair"]
        self.assertEqual([item["attempt"] for item in repairs if item["status"] == "started"], [2, 3, 4])
        self.assertIn("deep-thinking", [item["strategy"] for item in repairs])
        self.assertEqual(repairs[-1]["status"], "exhausted")
        self.assertEqual(all_events[-1]["type"], "session.complete")
        self.assertEqual(all_events[-1]["status"], "failed")

    def test_failed_verification_reports_actual_evidence(self):
        agent = MockAgent("verification")
        agent.stage = "verify"
        events = agent.on_mock_tool_result(
            {
                "tool": "process.run",
                "ok": False,
                "error": {"code": "PROCESS_EXIT", "message": "exit 2"},
                "output": {"command": "pytest", "exitCode": 2, "output": "failed test"},
            }
        )
        completion = next(event for event in events if event["type"] == "session.complete")
        self.assertEqual(completion["status"], "failed")
        self.assertEqual(completion["checks"][0]["exitCode"], 2)
        self.assertEqual(completion["checks"][0]["output"], "failed test")
        self.assertEqual(completion["checks"][0]["status"], "failed")
        self.assertTrue(completion["checks"][0]["finishedAt"])
        self.assertFalse(completion["checks"][0]["outputTruncated"])

    def test_verification_timeout_is_typed(self):
        check = verification_check(
            {},
            ok=False,
            fallback="Command timed out after 100ms",
            error={"code": "TOOL_EXECUTION_ERROR", "message": "Command timed out after 100ms"},
            workspace_fingerprint="b" * 64,
        )
        self.assertEqual(check["status"], "timed-out")
        self.assertEqual(check["workspaceFingerprint"], "b" * 64)

    def test_provider_budget_environment_is_bounded(self):
        with mock.patch.dict(os.environ, {"FORGE_PROVIDER": "openai-compatible", "FORGE_API_KEY": "test", "FORGE_MAX_TOKENS": "999999", "FORGE_PROVIDER_RETRIES": "999"}, clear=False):
            provider = build_provider()
        self.assertEqual(provider.max_tokens, 100_000)
        self.assertEqual(provider.max_retries, 5)
        with mock.patch.dict(os.environ, {"FORGE_PROVIDER": "openai-compatible", "FORGE_API_KEY": "test", "FORGE_MAX_TOKENS": "invalid"}, clear=False):
            provider = build_provider()
        self.assertIsNone(provider.max_tokens)

    def test_provider_presets_select_supported_endpoints_without_leaking_keys(self):
        cases = [
            ("openrouter", "OPENROUTER_API_KEY", "https://openrouter.ai/api/v1"),
            ("groq", "GROQ_API_KEY", "https://api.groq.com/openai/v1"),
            ("gemini", "GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta/openai"),
            ("google-ai-studio", "GOOGLE_AI_STUDIO_API_KEY", "https://generativelanguage.googleapis.com/v1beta/openai"),
            ("xai", "XAI_API_KEY", "https://api.x.ai/v1"),
        ]
        for name, key_name, base_url in cases:
            with self.subTest(name=name), mock.patch.dict(os.environ, {"FORGE_PROVIDER": name, key_name: "provider-secret"}, clear=False):
                provider = build_provider()
            self.assertEqual(provider.base_url, base_url)
            self.assertEqual(provider.api_key, "provider-secret")
            self.assertNotIn("provider-secret", repr(provider.headers))
        with mock.patch.dict(os.environ, {"FORGE_PROVIDER": "openrouter", "OPENROUTER_API_KEY": "provider-secret", "FORGE_BASE_URL": "https://proxy.invalid", "FORGE_MODEL": "custom/model"}, clear=False):
            provider = build_provider()
        self.assertEqual(provider.base_url, "https://proxy.invalid")
        self.assertEqual(provider.model, "custom/model")

    def test_provider_token_parameter_and_headers_are_bounded(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

            def read(self):
                return b'{"choices":[{"message":{"content":"ok"}}]}'

        def capture(model, token_parameter="auto", headers=None):
            requests = []

            def fake_urlopen(request, timeout):
                del timeout
                requests.append(request)
                return Response()

            provider = OpenAICompatibleProvider(
                api_key="secret-key",
                base_url="https://provider.invalid/v1",
                model=model,
                max_tokens=321,
                max_retries=0,
                token_parameter=token_parameter,
                headers=headers,
            )
            with mock.patch("forge_agent.providers.urllib.request.urlopen", side_effect=fake_urlopen):
                provider.complete(messages=[{"role": "user", "content": "ping"}], tools=[])
            return requests[0]

        gpt_body = json.loads(capture("gpt-5-mini").data)
        self.assertEqual(gpt_body["max_completion_tokens"], 321)
        self.assertNotIn("max_tokens", gpt_body)
        gemini_body = json.loads(capture("gemini-2.0-flash").data)
        self.assertEqual(gemini_body["max_tokens"], 321)
        self.assertNotIn("max_completion_tokens", gemini_body)
        explicit_body = json.loads(capture("gpt-5-mini", "max_tokens").data)
        self.assertEqual(explicit_body["max_tokens"], 321)
        with mock.patch.dict(
            os.environ,
            {
                "FORGE_PROVIDER": "openai-compatible",
                "FORGE_API_KEY": "secret-key",
                "FORGE_MODEL": "gpt-5-mini",
                "FORGE_MAX_TOKENS": "321",
                "FORGE_TOKEN_PARAMETER": "invalid",
            },
            clear=True,
        ):
            invalid_provider = build_provider()
        self.assertEqual(invalid_provider.token_parameter, "auto")

        request = capture("gpt-5-mini", headers={"X-OpenRouter-Title": "Forge CLI", "HTTP-Referer": "https://forge.example"})
        header_names = {name.lower() for name in request.headers}
        self.assertIn("x-openrouter-title", header_names)
        self.assertIn("http-referer", header_names)
        non_auth_headers = [
            value
            for name, value in request.header_items()
            if name.lower() != "authorization"
        ]
        self.assertNotIn("secret-key", " ".join(non_auth_headers))
        self.assertNotIn("secret-key", request.data.decode("utf-8"))

    def test_provider_can_disable_streaming_for_non_streaming_proxies(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

            def read(self):
                return b'{"choices":[{"message":{"content":"ok"}}]}'

        requests = []

        def fake_urlopen(request, timeout):
            del timeout
            requests.append(request)
            return Response()

        provider = OpenAICompatibleProvider(
            api_key="secret-key",
            base_url="https://provider.invalid/v1",
            model="gpt-5-mini",
            max_retries=0,
        )
        with mock.patch.dict(os.environ, {"FORGE_STREAM": "0"}, clear=False):
            with mock.patch("forge_agent.providers.urllib.request.urlopen", side_effect=fake_urlopen):
                reply = provider.complete(
                    messages=[{"role": "user", "content": "ping"}],
                    tools=[],
                    on_text=lambda _: None,
                )
        body = json.loads(requests[0].data)
        self.assertFalse(body["stream"])
        self.assertEqual(reply.text, "ok")

    def test_provider_encodes_and_restores_dotted_tool_names(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

            def read(self):
                return b'{"choices":[{"message":{"content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"forge_workspace_u2e_list","arguments":"{}"}}]}}]}'

        requests = []

        def fake_urlopen(request, timeout):
            del timeout
            requests.append(request)
            return Response()

        provider = OpenAICompatibleProvider(
            api_key="secret-key",
            base_url="https://provider.invalid/v1",
            model="gpt-5-mini",
            max_retries=0,
        )
        tools = [{
            "type": "function",
            "function": {
                "name": "workspace.list",
                "description": "List workspace files.",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        }]
        with mock.patch.dict(os.environ, {"FORGE_STREAM": "0"}, clear=False):
            with mock.patch("forge_agent.providers.urllib.request.urlopen", side_effect=fake_urlopen):
                reply = provider.complete(
                    messages=[{"role": "user", "content": "inspect"}],
                    tools=tools,
                )
        body = json.loads(requests[0].data)
        self.assertEqual(body["tools"][0]["function"]["name"], "forge_workspace_u2e_list")
        self.assertEqual(reply.tool_calls[0].name, "workspace.list")

    def test_provider_keyboard_interrupt_propagates_without_retry(self):
        provider = OpenAICompatibleProvider(
            api_key="secret-key",
            base_url="https://provider.invalid/v1",
            model="test-model",
            max_retries=5,
        )
        calls = []

        def interrupted_urlopen(request, timeout):
            del request, timeout
            calls.append(True)
            raise KeyboardInterrupt()

        with mock.patch(
            "forge_agent.providers.urllib.request.urlopen",
            side_effect=interrupted_urlopen,
        ):
            with self.assertRaises(KeyboardInterrupt):
                provider.complete(
                    messages=[{"role": "user", "content": "cancel"}],
                    tools=[],
                )
        self.assertEqual(len(calls), 1)

    def test_provider_errors_are_redacted(self):
        message = redact('api_key=sk-1234567890 secret=visible token=abc123')
        self.assertIn('api_key=[REDACTED]', message)
        self.assertIn('secret=[REDACTED]', message)
        self.assertIn('token=[REDACTED]', message)
        self.assertNotIn('abc123', message)

    def test_provider_normalizes_tool_calls(self):
        provider = OpenAICompatibleProvider.__new__(OpenAICompatibleProvider)
        reply = provider._parse_payload({"choices": [{"message": {"content": "", "tool_calls": [{"id": "call-1", "function": {"name": "workspace.read", "arguments": '{"path":"README.md"}'}, "extra_content": {"google": {"thought_signature": "sig-1"}}}]}}], "usage": {"total_tokens": 3}})
        self.assertEqual(reply.tool_calls[0].name, "workspace.read")
        self.assertEqual(reply.tool_calls[0].arguments["path"], "README.md")
        self.assertEqual(reply.usage["total_tokens"], 3)
        self.assertEqual(reply.raw_message["tool_calls"][0]["extra_content"]["google"]["thought_signature"], "sig-1")

    def test_streaming_provider_normalizes_fragments(self):
        provider = OpenAICompatibleProvider.__new__(OpenAICompatibleProvider)
        chunks = [
            b'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
            b'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
            b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"workspace.read","arguments":"{\\"path\\":\\"README.md\\"}"},"extra_content":{"google":{"thought_signature":"sig-stream"}}}]}}]}\n\n',
            b'data: [DONE]\n\n',
        ]
        fragments = []
        reply = provider._read_stream(chunks, fragments.append)
        self.assertEqual("".join(fragments), "hello world")
        self.assertEqual(reply.tool_calls[0].arguments["path"], "README.md")
        self.assertEqual(reply.raw_message["role"], "assistant")
        self.assertEqual(reply.raw_message["tool_calls"][0]["extra_content"]["google"]["thought_signature"], "sig-stream")

    def test_mock_provider_streams_text_callback(self):
        fragments = []
        reply = MockProvider().complete(messages=[{"role": "user", "content": "hello"}], tools=[], on_text=fragments.append)
        self.assertEqual(reply.text, "Mock provider response for: hello")
        self.assertEqual(fragments, [reply.text])

    def test_protocol_json_escapes_lone_surrogates(self):
        payload = {"type": "agent.text", "text": "safe-" + chr(0xDC9D) + "-text"}
        encoded = protocol_json(payload)
        self.assertNotIn(chr(0xDC9D), encoded)
        self.assertEqual(json.loads(encoded), payload)
        encoded.encode("utf-8")

    def test_worker_rejects_oversized_and_non_object_input(self):
        output = io.StringIO()
        oversized = "x" * 1_000_001
        lines = json.dumps(oversized) + "\n" + json.dumps({"sessionId": "s", "type": "unknown"}) + "\n"
        with mock.patch("sys.stdin", io.StringIO(lines)), redirect_stdout(output):
            self.assertEqual(main(), 0)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[0]["error"]["code"], "WORKER_PROTOCOL_ERROR")
        self.assertEqual(events[1]["error"]["code"], "UNKNOWN_EVENT")

    def test_worker_error_redaction_is_bounded(self):
        message = redact_error("Bearer secret-token api_key=sk-secret token=abc-secret")
        self.assertNotIn("secret-token", message)
        self.assertNotIn("sk-secret", message)
        self.assertNotIn("abc-secret", message)
        self.assertLessEqual(len(message), 2_000)

    def test_invalid_input_is_reported(self):
        output = io.StringIO()
        with mock.patch("sys.stdin", io.StringIO('{"type":"session.start"}\\n')), redirect_stdout(output):
            self.assertEqual(main(), 0)
        event = json.loads(output.getvalue().splitlines()[0])
        self.assertEqual(event["type"], "error")
        self.assertEqual(event["error"]["code"], "WORKER_PROTOCOL_ERROR")


if __name__ == "__main__":
    unittest.main()
