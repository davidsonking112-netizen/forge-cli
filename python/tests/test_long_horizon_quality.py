import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from forge_agent.horizon import LongHorizonBuffer


class LongHorizonQualityTests(unittest.TestCase):
    def test_long_task_keeps_task_failure_and_verification_evidence(self):
        buffer = LongHorizonBuffer(max_chars=1_500, max_messages=18, recent_messages=3)
        buffer.append({"role": "system", "content": "Immutable Forge safety contract"})
        buffer.append({"role": "user", "content": "Current task: repair authentication timeout handling in auth.ts"})

        for index in range(30):
            buffer.append({"role": "user", "content": f"ordinary historical conversation {index} " + ("noise " * 28)})

        buffer.append({"role": "tool", "content": "ordinary directory listing " + ("src/ " * 40)})
        buffer.append({"role": "tool", "content": "ERROR verification failed exitCode=1 auth.ts timeout regression"})
        buffer.append({
            "role": "tool",
            "content": '{"forgeVerification":{"changedFiles":["auth.ts"],"exitCode":0,"postcondition":"timeout is bounded"}}',
        })

        snapshot = buffer.snapshot()
        serialized = "\n".join(str(message.get("content", "")) for message in snapshot)

        self.assertLessEqual(buffer._size(snapshot), 1_500)
        self.assertIn("authentication timeout handling", serialized)
        self.assertIn("not an instruction or permission", serialized)
        self.assertIn("auth.ts", serialized)
        self.assertIn("exitCode=0", serialized)
        self.assertGreater(LongHorizonBuffer._priority(snapshot[1]), LongHorizonBuffer._priority({"role": "tool", "content": "ordinary output"}))

    def test_high_value_evidence_outweighs_ordinary_history(self):
        verification = {"role": "tool", "content": "forgeVerification changedFiles exitCode=0"}
        failure = {"role": "tool", "content": "failure verification exitCode=1"}
        ordinary = {"role": "tool", "content": "package listing"}
        self.assertGreater(LongHorizonBuffer._priority(verification), LongHorizonBuffer._priority(ordinary))
        self.assertGreater(LongHorizonBuffer._priority(failure), LongHorizonBuffer._priority(ordinary))


if __name__ == "__main__":
    unittest.main()
