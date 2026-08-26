export const FORGE_EXIT_CODES = {
  success: 0,
  operationFailed: 1,
  usageOrSafetyBlocked: 2,
  cancelled: 130,
} as const;

export const FORGE_ERROR_CODES = {
  approvalDenied: {
    category: "approval",
    meaning: "The user denied an approval-gated action.",
    retryable: false,
  },
  commandFailed: {
    category: "process",
    meaning:
      "An approved local process exited unsuccessfully or could not complete.",
    retryable: true,
  },
  gitBranchFailed: {
    category: "git",
    meaning: "A local branch operation failed.",
    retryable: true,
  },
  gitStageFailed: {
    category: "git",
    meaning: "A local staging operation failed.",
    retryable: true,
  },
  gitCommitFailed: {
    category: "git",
    meaning: "A local commit operation failed.",
    retryable: true,
  },
} as const;

export function errorReference(): {
  schemaVersion: 1;
  exitCodes: Array<{
    code: number;
    name: string;
    meaning: string;
  }>;
  structuredErrorCodes: Array<{
    code: string;
    category: string;
    meaning: string;
    retryable: boolean;
  }>;
  machineOutput: string;
} {
  return {
    schemaVersion: 1,
    exitCodes: [
      {
        code: FORGE_EXIT_CODES.success,
        name: "success",
        meaning: "The requested command completed successfully.",
      },
      {
        code: FORGE_EXIT_CODES.operationFailed,
        name: "operation-failed",
        meaning:
          "The command ran but an operational, provider, process, session, or remote action failed; inspect stderr and structured output.",
      },
      {
        code: FORGE_EXIT_CODES.usageOrSafetyBlocked,
        name: "usage-or-safety-blocked",
        meaning:
          "Arguments, configuration, workspace, interactivity, or safety preconditions prevented the command from running.",
      },
      {
        code: FORGE_EXIT_CODES.cancelled,
        name: "cancelled",
        meaning:
          "The operator interrupted the run, normally with Ctrl-C; no pending mutation is replayed.",
      },
    ],
    structuredErrorCodes: Object.entries(FORGE_ERROR_CODES).map(
      ([name, definition]) => ({
        code: name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase(),
        ...definition,
      }),
    ),
    machineOutput:
      "Use --output json where supported. JSON-lines ACP output remains one response per input line; never parse human-readable stderr as a success signal.",
  };
}
