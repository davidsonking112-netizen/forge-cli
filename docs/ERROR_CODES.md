# Forge CLI exit codes and error codes

This document defines the stable automation contract for Forge CLI scripts and continuous-integration jobs. The contract applies to the current v1.0 release-candidate line and is implemented by the `forge errors` command. A future major version may add fields or codes, but existing exit-code meanings and structured error-code names should remain compatible.

## Exit codes

Forge uses a deliberately small process exit-code vocabulary. The cancellation code follows the conventional shell interpretation of an interrupt (`128 + SIGINT`).
Scripts should branch on the numeric exit code and use `--output json` or the command’s documented machine-readable output for details. Human-readable text on stdout or stderr is not a stable parsing interface.

| Exit code | Stable name               | Meaning                                                                                                                                                                                                                                                      | Typical automation response                                                                              |
| --------: | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
|       `0` | `success`                 | The requested command completed successfully. A read-only command may have completed with warnings that do not prevent the requested inspection.                                                                                                             | Continue. If the command produces JSON, parse stdout as the documented result.                           |
|       `1` | `operation-failed`        | The command was recognized and attempted, but an operational condition failed. Examples include an unavailable provider, failed process, failed verification, missing session data, or unsuccessful optional integration operation.                          | Stop or retry according to the command and structured error details. Do not assume a mutation succeeded. |
|       `2` | `usage-or-safety-blocked` | Arguments, configuration, workspace, interactivity, or a safety precondition prevented execution. This includes malformed usage, missing required approval context, non-interactive mutation attempts, denied safety decisions, and bounded input rejection. | Correct the invocation or obtain explicit user approval. Do not automatically retry unchanged input.     |
|     `130` | `cancelled`               | The operator interrupted an active run, normally with Ctrl-C. Forge aborts the active worker/tool boundary where supported, records cancellation when sessions are persisted, and does not replay pending mutations.                                         | Stop the workflow and inspect the session/audit record. Retry only as a new, deliberate run.             |

The exit code does not grant permission. Forge also takes an atomic per-workspace lock for every active supervisor run. A second process targeting the same approved workspace fails closed with `WORKSPACE_LOCKED` and exit code `2`; a different workspace can run independently. Lock records are stored under the Forge state directory with restrictive permissions, include the owning PID and a random token, and are released only by the owner. A lock whose recorded process is no longer alive can be reclaimed safely.
A successful read-only command does not imply that a later write, process, GitHub, Daytona, or MCP operation is approved. Every mutation and external action remains subject to Forge’s existing approval and global-deny rules.

## Structured tool-result error codes

Commands that return a `ToolResult` or include tool results in JSON use stable uppercase error-code strings. A result with `ok: false` must be treated as unsuccessful even when the process itself exits with `0` for a reporting command. The code is intended for branching; the message is explanatory and may change.

| Code                | Category      |             Retryable | Meaning                                                                                                                                                                            |
| ------------------- | ------------- | --------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APPROVAL_DENIED`   | `approval`    |                    No | The user denied an approval-gated action. The caller must not retry the same mutation automatically.                                                                               |
| `COMMAND_FAILED`    | `process`     |    Yes, conditionally | An approved local process failed, timed out, or could not complete. A retry is safe only after inspecting the bounded result and considering whether the command is deterministic. |
| `GIT_BRANCH_FAILED` | `git`         |    Yes, conditionally | A local branch operation failed. Inspect repository state before retrying.                                                                                                         |
| `GIT_STAGE_FAILED`  | `git`         |    Yes, conditionally | A local staging operation failed. Inspect the selected paths and repository state before retrying.                                                                                 |
| `GIT_COMMIT_FAILED` | `git`         |    Yes, conditionally | A local commit operation failed. Do not assume a commit was created; inspect Git status and log first.                                                                             |
| `WORKSPACE_LOCKED`  | `concurrency` | Yes, after inspection | Another active Forge process owns the approved workspace lock. Wait for the owner to finish, or inspect and recover a lock whose recorded process is no longer alive.              |

The stable list can be queried without starting an agent or contacting a provider:

```bash
forge errors
```

The output is JSON with `schemaVersion: 1`, an `exitCodes` array, a `structuredErrorCodes` array, and a `machineOutput` guidance field. A script may use this command during capability discovery, but it should normally rely on the documented contract rather than requiring a network connection.

## Machine-readable command usage

Use `--output json` where the command supports it. JSON output is intended for a single command result on stdout. Diagnostics and failure explanations may still be written to stderr. A CI wrapper should capture stdout and stderr separately and always check the process exit code first.

```bash
set +e
result=$(forge init --workspace "$PWD" --output json 2>forge-init.stderr)
status=$?
set -e

if [ "$status" -eq 0 ]; then
  printf '%s\n' "$result" | jq .
elif [ "$status" -eq 2 ]; then
  cat forge-init.stderr >&2
  exit 2
else
  cat forge-init.stderr >&2
  exit 1
fi
```

For ACP, the transport contract is JSON-RPC/JSONL rather than the top-level CLI result contract. Each valid input line receives one correlated response line. ACP protocol error numbers remain JSON-RPC values and should not be confused with Forge process exit codes. Oversized, malformed, or unsafe ACP input is rejected within the bounded ACP policy; a caller must treat a non-zero Forge process exit as unsuccessful.

## Safety and retry rules

Forge intentionally does not provide a generic “force” exit code. Ctrl-C is handled as cancellation rather than approval denial. During an interactive approval prompt, the prompt is closed and the run exits with `130`; it does not approve or replay the proposed action. During a provider call, the Node supervisor terminates the worker so the provider request is not allowed to continue as an uncontrolled background operation. The Python provider path does not swallow `KeyboardInterrupt`.

For local subprocesses, the supervisor passes an abort signal to the active process boundary; cancellation requests termination and rejects the pending tool operation. Process-group behavior can differ across operating systems, so the platform matrix remains part of release verification. MCP requests already support abort signals and pending-request rejection. Daytona HTTP operations accept an abort signal and classify caller-driven cancellation without contacting a real service in tests.
A `2` result should never be changed to `0` by suppressing an approval or by automatically switching to a less restrictive profile. A retry loop should be bounded and should preserve the same global safety ceiling. If a command reports `APPROVAL_DENIED`, the correct next action is to ask the operator, not to replay the action.

A process exit of `0` is also not proof that a remote action occurred. For example, a read-only status command can succeed while reporting that an optional integration is unavailable, and a plan command can succeed while explicitly making no changes. Automation should inspect the command’s structured fields such as `ok`, `status`, `changedFiles`, `verification`, and `readOnly` where provided.

## Compatibility policy

The `schemaVersion` field on `forge errors` is currently `1`. New error codes may be added in a backward-compatible release. Existing codes will not be silently reassigned to a different meaning. Unknown future codes should be handled as an unsuccessful result and surfaced for operator review. Consumers should not parse human-readable error messages, terminal checkmarks, timing text, or internal stack traces.

Forge redacts secrets from persistent sessions and user-facing reports. CI jobs should still avoid printing provider credentials, `DAYTONA_API_KEY`, GitHub credentials, or full environment dumps. Provider and integration credentials belong in the CI secret store and are read only from the execution environment when the operator intentionally configures an external action.
