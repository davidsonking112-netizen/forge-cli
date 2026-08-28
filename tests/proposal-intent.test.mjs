import test from "node:test";
import assert from "node:assert/strict";
import {
  isApprovalGatedPrompt,
  normalizeExecutionPrompt,
} from "../bin/prompt-intent.mjs";

test("recognizes explicit approval-gated change requests", () => {
  assert.equal(
    isApprovalGatedPrompt(
      "Inspect the repo, find one small code improvement, propose the exact change, and wait for approval before applying it.",
    ),
    true,
  );
  assert.equal(
    isApprovalGatedPrompt(
      "Suggest a fix for the login bug and await my approval.",
    ),
    true,
  );
});

test("does not mark ordinary implementation requests as proposal-only", () => {
  assert.equal(isApprovalGatedPrompt("Fix the login bug."), false);
  assert.equal(isApprovalGatedPrompt("Run the tests and fix any failures."), false);
  assert.equal(isApprovalGatedPrompt("Create a new settings page."), false);
});

test("adds a post-approval execution contract", () => {
  const prompt =
    "Find one small safe improvement, propose the exact patch, and wait for my approval before applying it.";
  const normalized = normalizeExecutionPrompt(prompt);
  assert.match(normalized, /wait for my approval/i);
  assert.match(
    normalized,
    /do not modify, write, edit, apply, run, or execute anything before the required approval/i,
  );
  assert.match(
    normalized,
    /after approval, the proposed change may be applied and verified/i,
  );
});

test("leaves unrelated prompts unchanged", () => {
  const prompt = "Explain the architecture of this repository.";
  assert.equal(normalizeExecutionPrompt(prompt), prompt);
});
