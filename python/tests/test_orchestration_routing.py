import unittest

from forge_agent.orchestration import BoundedOrchestrator, create_task_specific_roles


class OrchestrationRoutingTests(unittest.TestCase):
    def test_trivial_tasks_do_not_add_dynamic_specialists(self):
        self.assertEqual(create_task_specific_roles("Explain what this function does."), [])
        self.assertEqual(create_task_specific_roles("Fix a typo in README."), [])

    def test_specialists_are_signal_driven_and_bounded(self):
        roles = create_task_specific_roles("Audit security and dependency vulnerabilities in the backend API", 3)
        ids = [role.role for role in roles]
        self.assertEqual(ids, ["custom-security-auditor", "custom-dependency-auditor", "custom-backend-integrator"])
        self.assertEqual(ids, list(dict.fromkeys(ids)))
        self.assertLessEqual(len(ids), 3)

    def test_orchestrator_respects_small_budget(self):
        orchestrator = BoundedOrchestrator(max_agents=2, max_total_turns=2)
        tasks = orchestrator.plan("Explain the authentication flow.")
        self.assertLessEqual(len(tasks), 2)


if __name__ == "__main__":
    unittest.main()
