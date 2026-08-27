import type {
  ContextFile,
  ContextFailure,
  ProjectContract,
  RecoveryStrategy,
} from "./context.js";
import type { ToolName } from "../../../packages/protocol/src/index.js";

export type VerificationKind =
  "focused-unit" | "typecheck" | "browser-smoke" | "syntax";
export type FailureKind = NonNullable<ContextFailure["failureKind"]>;

export interface MilestoneVerificationPlan {
  milestoneId: string;
  kind: VerificationKind;
  tool: ToolName;
  command: string;
  args: string[];
  reason: string;
  expectedFiles: string[];
}

export interface VerificationFailureClassification {
  failureKind: FailureKind;
  recoveryStrategy: RecoveryStrategy;
}

const sourceExtensions = /\.(c|m)?(js|ts|tsx|jsx|py|go|rs|java|rb)$/i;
const browserExtensions = /\.(html?|css|scss|vue|svelte)$/i;

function commandForScript(
  contract: ProjectContract,
  names: RegExp,
): string[] | undefined {
  return [...contract.testCommands, ...contract.buildCommands].find((command) =>
    names.test(command.join(" ")),
  );
}

function siblingTest(
  filePath: string,
  files: ContextFile[],
): string | undefined {
  const base = filePath.replace(/\.[^.]+$/, "");
  return files
    .map((file) => file.path)
    .filter((candidate) => /(?:test|spec)/i.test(candidate))
    .sort((a, b) => a.localeCompare(b))
    .find(
      (candidate) =>
        candidate.startsWith(base) ||
        candidate.includes(base.split("/").pop() ?? ""),
    );
}

export function chooseMilestoneVerification(
  milestoneId: string,
  changedFiles: string[],
  files: ContextFile[],
  contract: ProjectContract,
): MilestoneVerificationPlan | null {
  const normalized = [
    ...new Set(
      changedFiles
        .map((file) => file.replaceAll("\\", "/").trim())
        .filter(Boolean),
    ),
  ].slice(0, 32);
  if (!normalized.length) return null;
  const htmlEntries = files
    .map((file) => file.path)
    .filter((file) => /(^|\/)index\.html$/i.test(file));
  const htmlDirectories = new Set(
    htmlEntries.map((file) => file.split("/").slice(0, -1).join("/")),
  );
  const browserFile =
    normalized.find((file) => browserExtensions.test(file)) ??
    normalized.find(
      (file) =>
        /\.(js|jsx|ts|tsx)$/i.test(file) &&
        (htmlDirectories.has(file.split("/").slice(0, -1).join("/")) ||
          /(^|\/)(public|web|ui|frontend|pages|components|app|main)(\/|$)/i.test(
            file,
          )),
    ) ??
    normalized.find((file) =>
      /(^|\/)(public|web|ui|frontend|pages|components)(\/|$)/i.test(file),
    );
  if (browserFile) {
    return {
      milestoneId,
      kind: "browser-smoke",
      tool: "browser.smoke",
      command: "chromium",
      args: [browserFile],
      reason: `Run the smallest browser smoke check for changed UI file ${browserFile}.`,
      expectedFiles: [browserFile],
    };
  }
  const typeScriptFile = normalized.find((file) => /\.(ts|tsx)$/i.test(file));
  if (typeScriptFile) {
    const command = commandForScript(contract, /typecheck|tsc|check/i) ?? [
      "tsc",
      "--noEmit",
    ];
    return {
      milestoneId,
      kind: "typecheck",
      tool: "process.run",
      command: command[0] ?? "tsc",
      args: command.slice(1),
      reason: `Run the smallest available TypeScript check after changing ${typeScriptFile}.`,
      expectedFiles: [typeScriptFile],
    };
  }
  const sourceFile = normalized.find((file) => sourceExtensions.test(file));
  if (!sourceFile) return null;
  const test = siblingTest(sourceFile, files);
  if (/\.py$/i.test(sourceFile)) {
    if (test)
      return {
        milestoneId,
        kind: "focused-unit",
        tool: "process.run",
        command: "python",
        args: ["-m", "pytest", test],
        reason: `Run the focused Python test associated with ${sourceFile}.`,
        expectedFiles: [sourceFile, test],
      };
    return {
      milestoneId,
      kind: "syntax",
      tool: "process.run",
      command: "python",
      args: ["-m", "py_compile", sourceFile],
      reason: `Run a focused Python syntax check for ${sourceFile}.`,
      expectedFiles: [sourceFile],
    };
  }
  if (test)
    return {
      milestoneId,
      kind: "focused-unit",
      tool: "process.run",
      command: "node",
      args: ["--test", test],
      reason: `Run the focused unit test associated with ${sourceFile}.`,
      expectedFiles: [sourceFile, test],
    };
  return {
    milestoneId,
    kind: "syntax",
    tool: "process.run",
    command: "node",
    args: ["--check", sourceFile],
    reason: `Run a focused syntax check for ${sourceFile} before broader verification.`,
    expectedFiles: [sourceFile],
  };
}

export function classifyVerificationFailure(input: {
  tool: string;
  kind?: VerificationKind;
  code?: string;
  message?: string;
  output?: string;
}): VerificationFailureClassification {
  const text =
    `${input.code ?? ""} ${input.message ?? ""} ${input.output ?? ""}`.toLowerCase();
  if (
    /provider|history|tool_state|invalid_argument|thought_signature/.test(text)
  )
    return {
      failureKind: "provider-history",
      recoveryStrategy: "rebuild-provider-history",
    };
  if (/stale|conflict|originalsha|patch.*context|changed since/.test(text))
    return {
      failureKind: "stale-patch",
      recoveryStrategy: "refresh-context-rebase",
    };
  if (/timeout|timed out|deadline|etimedout/.test(text))
    return { failureKind: "timeout", recoveryStrategy: "shorten-and-retry" };
  if (
    input.kind === "browser-smoke" &&
    /fail|error|uncaught|console/.test(text)
  )
    return {
      failureKind: "browser-regression",
      recoveryStrategy: "isolate-browser-regression",
    };
  if (
    /syntaxerror|syntax error|unexpected token|indentationerror|compile error/.test(
      text,
    )
  )
    return {
      failureKind: "syntax-error",
      recoveryStrategy: "repair-syntax-first",
    };
  return {
    failureKind: "command-failure",
    recoveryStrategy: "change-focused-command",
  };
}
