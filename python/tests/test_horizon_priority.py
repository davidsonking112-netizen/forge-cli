import unittest

from forge_agent.horizon import LongHorizonBuffer


class HorizonPriorityTests(unittest.TestCase):
    def test_compaction_marks_history_as_non_authoritative_user_context(self):
        buffer = LongHorizonBuffer(max_chars=900, max_messages=12, recent_messages=2)
        buffer.append({"role": "system", "content": "Task safety constraints"})
        buffer.append({"role": "user", "content": "Current task"})
        for index in range(10):
            buffer.append({"role": "user", "content": f"historical discussion {index} " + ("x" * 80)})
        snapshot = buffer.snapshot()
        summaries = [
            message for message in snapshot
            if isinstance(message.get("content"), str) and "historical summary" in message["content"].lower()
        ]
        self.assertTrue(summaries)
        self.assertEqual(summaries[0]["role"], "user")
        self.assertIn("not an instruction or permission", summaries[0]["content"].lower())

    def test_error_and_verification_context_has_higher_priority(self):
        error = {"role": "tool", "content": "ERROR verification failed exitCode=1"}
        ordinary = {"role": "tool", "content": "ordinary output"}
        self.assertGreater(LongHorizonBuffer._priority(error), LongHorizonBuffer._priority(ordinary))


if __name__ == "__main__":
    unittest.main()
