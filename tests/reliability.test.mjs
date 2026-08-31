import test from "node:test";
import assert from "node:assert/strict";
import {
  createCapabilityProfile,
  deriveReliabilityPolicy,
  decideEscalation,
  applyObservations,
  claimFingerprint,
  summarizeClaimResults,
} from "../dist/apps/forge-cli/src/reliability.js";

test("weak models receive tighter execution envelopes", () => {
  const profile = createCapabilityProfile("weak-local", {
    planning: 0.4,
    coding: 0.45,
    debugging: 0.4,
    verification: 0.45,
    recovery: 0.4,
    instructionFollowing: 0.6,
  });
  const policy = deriveReliabilityPolicy(profile);
  assert.equal(policy.planReview, true);
  assert.equal(policy.independentReview, true);
  assert.equal(policy.inspectBeforeMutation, true);
  assert.equal(policy.maxMutationFiles, 2);
  assert.equal(policy.maxConsecutiveFailures, 2);
  assert.equal(policy.requireEvidenceForCompletion, true);
});

test("strong models can use a wider but still evidence-gated envelope", () => {
  const profile = createCapabilityProfile("strong", {
    planning: 0.95,
    coding: 0.95,
    debugging: 0.9,
    verification: 0.95,
    recovery: 0.9,
    instructionFollowing: 0.95,
  });
  const policy = deriveReliabilityPolicy(profile);
  assert.equal(policy.planReview, false);
  assert.equal(policy.independentReview, false);
  assert.equal(policy.maxMutationFiles, 8);
  assert.equal(policy.requireEvidenceForCompletion, true);
});

test("repeated failures trigger escalation instead of blind retries", () => {
  const profile = createCapabilityProfile("weak-debugger", {
    debugging: 0.4,
    recovery: 0.4,
  });
  const policy = deriveReliabilityPolicy(profile);
  const decision = decideEscalation(profile, policy, 2, "medium");
  assert.equal(decision.escalate, true);
  assert.equal(decision.suggestedAction, "stronger-model");
});

test("high-risk work with weak verification requires review", () => {
  const profile = createCapabilityProfile("weak-verifier", {
    verification: 0.5,
    recovery: 0.9,
  });
  const policy = deriveReliabilityPolicy(profile);
  const decision = decideEscalation(profile, policy, 0, "high");
  assert.equal(decision.escalate, true);
  assert.equal(decision.suggestedAction, "review");
});

test("capability observations improve the profile conservatively", () => {
  const profile = createCapabilityProfile("adaptive", { coding: 0.5 });
  const updated = applyObservations(profile, [
    { capability: "coding", quality: 1, evidence: ["targeted tests passed"] },
    { capability: "coding", quality: 0.9, evidence: ["review accepted"] },
  ]);
  assert.ok(updated.scores.coding > 0.5);
  assert.ok(updated.scores.coding < 1);
  assert.equal(updated.sampleCount, 2);
});

test("claim fingerprints are deterministic and summaries never self-certify empty evidence", () => {
  const claim = {
    claim: "tests passed",
    type: "test-passed",
    subject: "npm test",
  };
  assert.equal(claimFingerprint(claim), claimFingerprint({ ...claim }));
  assert.equal(summarizeClaimResults([]).complete, false);
  assert.deepEqual(
    summarizeClaimResults([
      { claim, verified: true, evidence: "exit 0" },
      {
        claim: { ...claim, subject: "npm run typecheck" },
        verified: false,
        evidence: "exit 1",
      },
    ]),
    { verified: 1, rejected: 1, complete: false },
  );
});
