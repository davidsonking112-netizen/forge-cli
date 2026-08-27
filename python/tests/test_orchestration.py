import json
import pathlib
import re
import sys
import threading
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from forge_agent.orchestration import (
    BoundedOrchestrator,
    ROLES,
    create_task_specific_roles,
    validate_artifact,
)


def artifact(role):
    if role == "explorer":
        return {
            "version": 1,
            "kind": role,
            "files": [{"path": "src/app.ts", "relevance": "entrypoint", "evidence": "context"}],
            "symbols": [{"path": "src/app.ts", "name": "main", "kind": "function", "reason": "entrypoint"}],
            "conventions": ["strict TypeScript"],
            "risks": ["unknown runtime integration"],
            "unknowns": ["deployment target"],
            "evidence": [{"source": "context", "detail": "project contract"}],
        }
    if role == "architect":
        return {
            "version": 1,
            "kind": role,
            "milestoneGraph": [{"localId": "m1", "title": "Implement", "description": "Implement the change", "expectedFiles": ["src/app.ts"], "dependsOn": [], "risks": ["regression"], "tests": ["npm test"], "postconditions": ["check passes"]}],
            "acceptanceMapping": [{"requirement": "feature works", "files": ["src/app.ts"], "tests": ["npm test"]}],
            "assumptions": ["context is current"],
            "unknowns": ["external service state"],
        }
    if role == "implementer":
        return {"version": 1, "kind": role, "proposedDiff": "diff --git a/src/app.ts b/src/app.ts", "affectedFiles": ["src/app.ts"], "preconditions": ["source is current"], "rollbackNotes": ["restore checkpoint"], "postconditions": ["typecheck passes"]}
    if role == "tester":
        return {"version": 1, "kind": role, "testMatrix": [{"area": "unit", "command": "npm test", "expectedEvidence": "passing focused test"}], "unverifiedChecks": ["browser behavior"], "coverageGaps": ["production deployment"]}
    return {"version": 1, "kind": role, "blockers": [], "contradictions": [], "nonBlockingImprovements": ["add more coverage"], "goNoGo": "go", "rationale": "Artifacts are consistent and bounded."}


class Reply:
    def __init__(self, text):
        self.text = text


class ArtifactProvider:
    def __init__(self, delay=0.0):
        self.delay = delay
        self.tools = []
        self.active = 0
        self.max_active = 0
        self.lock = threading.Lock()

    def complete(self, *, messages, tools, on_text=None):
        del on_text
        self.tools.append(tools)
        role = next(role for role in ROLES if role in messages[0]["content"])
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            if self.delay:
                time.sleep(self.delay)
            return Reply(json.dumps(artifact(role)))
        finally:
            with self.lock:
                self.active -= 1


class OrchestrationTests(unittest.TestCase):
    def test_all_roles_return_typed_artifacts_without_tools(self):
        provider = ArtifactProvider()
        report = BoundedOrchestrator(max_agents=5, max_total_turns=5).run(provider=provider, goal="improve the app")
        self.assertEqual([result.role for result in report.results], list(ROLES))
        self.assertTrue(all(result.status == "completed" for result in report.results))
        self.assertEqual([result.artifact["kind"] for result in report.results], list(ROLES))
        self.assertTrue(all(tools == [] for tools in provider.tools))
        self.assertFalse(report.parallelReadOnly)

    def test_invalid_prose_fails_closed_instead_of_becoming_artifact(self):
        class ProseProvider(ArtifactProvider):
            def complete(self, *, messages, tools, on_text=None):
                self.tools.append(tools)
                return Reply("I inspected the repository and recommend a change.")

        report = BoundedOrchestrator(max_agents=1, max_total_turns=1).run(provider=ProseProvider(), goal="review")
        self.assertEqual(report.results[0].status, "failed")
        self.assertIn("Invalid typed artifact", report.results[0].error)
        self.assertIsNone(report.results[0].artifact)

    def test_parallel_read_only_is_opt_in_and_limited_to_read_only_roles(self):
        provider = ArtifactProvider(delay=0.01)
        report = BoundedOrchestrator(max_agents=5, max_total_turns=5, parallel_read_only=True).run(provider=provider, goal="review")
        self.assertTrue(report.parallelReadOnly)
        self.assertGreaterEqual(provider.max_active, 2)
        self.assertEqual([result.role for result in report.results], list(ROLES))
        self.assertTrue(all(tools == [] for tools in provider.tools))

    def test_supervisor_creates_task_specific_roles_within_eight_agent_ceiling(self):
        specs = create_task_specific_roles("Build a frontend with a secure backend and dependency updates", maximum=3)
        self.assertEqual([spec.role for spec in specs], [
            "custom-dependency-auditor",
            "custom-ux-qa",
            "custom-backend-integrator",
        ])
        self.assertLessEqual(len(specs), 3)

        class DynamicProvider(ArtifactProvider):
            def complete(self, *, messages, tools, on_text=None):
                del on_text
                self.tools.append(tools)
                content = messages[0]["content"]
                if "roleId=custom-" in content:
                    role = re.search(r"roleId=(custom-[a-z0-9-]+)", content).group(1)
                    return Reply(json.dumps({
                        "version": 1,
                        "kind": "custom",
                        "roleId": role,
                        "mission": "Review the bounded task",
                        "findings": ["Review completed from supplied context"],
                        "evidence": [{"source": "context", "detail": "bounded"}],
                        "risks": [],
                        "recommendedChecks": ["run the project test"],
                        "unknowns": [],
                    }))
                role = next(role for role in ROLES if role in content)
                return Reply(json.dumps(artifact(role)))

        provider = DynamicProvider()
        report = BoundedOrchestrator(max_agents=8, max_total_turns=8, dynamic_roles=specs).run(
            provider=provider,
            goal="Build a frontend with a secure backend and dependency updates",
        )
        self.assertEqual(len(report.results), 8)
        self.assertEqual([result.role for result in report.results][-3:], [spec.role for spec in specs])
        self.assertTrue(all(result.status == "completed" for result in report.results))
        self.assertTrue(all(tools == [] for tools in provider.tools))

    def test_custom_artifact_requires_matching_role_id(self):
        valid = {
            "version": 1,
            "kind": "custom",
            "roleId": "custom-security-auditor",
            "mission": "Review security",
            "findings": [],
            "evidence": [{"source": "context", "detail": "bounded"}],
            "risks": [],
            "recommendedChecks": [],
            "unknowns": [],
        }
        self.assertEqual(validate_artifact("custom-security-auditor", valid), (True, "valid"))
        invalid = dict(valid, roleId="custom-other")
        self.assertFalse(validate_artifact("custom-security-auditor", invalid)[0])


if __name__ == "__main__":
    unittest.main()
