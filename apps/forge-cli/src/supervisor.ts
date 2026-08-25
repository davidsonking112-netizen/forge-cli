import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createEnvelope,
  encodeForgeEvent,
  parseForgeEvent,
  type ForgeEvent,
  type PolicyMode,
  type ToolProposalEvent,
  type ToolResultEvent,
} from "../../../packages/protocol/src/index.js";
import { PolicyEngine, TOOL_METADATA, WorkspaceTools } from "./tools.js";
import { SessionStore, type SessionRecord } from "./sessions.js";
import { buildRepositoryContext } from "./context.js";

export interface RunOptions {
  prompt: string;
  workspace: string;
  policy?: PolicyMode;
  json?: boolean;
  approveAll?: boolean;
  multiAgent?: boolean;
  maxAgents?: number;
  maxTotalTurns?: number;
  record?: boolean;
  onEvent?: (event: ForgeEvent) => void;
  approve?: (
    proposal: ToolProposalEvent,
  ) => Promise<"approve-once" | "approve-session" | "deny" | "cancel">;
}

export interface RunResult {
  sessionId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  changedFiles: string[];
}

export class ForgeSupervisor {
  private readonly sessions: SessionStore;

  public constructor(sessions = new SessionStore()) {
    this.sessions = sessions;
  }

  public async run(options: RunOptions): Promise<RunResult> {
    const workspace = path.resolve(options.workspace);
    const timestamp = new Date().toISOString();
    const session: SessionRecord =
      options.record === false
        ? {
            id: randomUUID(),
            workspace,
            createdAt: timestamp,
            updatedAt: timestamp,
            events: [],
          }
        : await this.sessions.create(workspace);
    const policy = new PolicyEngine(options.policy ?? "safe");
    const tools = new WorkspaceTools(workspace);
    const worker = this.startWorker(options);
    const repositoryContext = await buildRepositoryContext(
      workspace,
      options.prompt,
    );
    let sessionResult: RunResult | undefined;
    let approvalMode: "safe" | "session-approve" | "unsafe" = policy.mode;

    const send = (event: ForgeEvent): void => {
      worker.stdin.write(`${encodeForgeEvent(event)}\n`);
    };

    const emit = async (event: ForgeEvent): Promise<void> => {
      if (options.record !== false) await this.sessions.append(session, event);
      options.onEvent?.(event);
    };

    const readline = createInterface({ input: worker.stdout });
    const processing = (async (): Promise<void> => {
      for await (const line of readline) {
        if (typeof line !== "string" || !line.trim()) continue;
        let event: ForgeEvent;
        try {
          event = parseForgeEvent(line);
        } catch (error) {
          await emit(
            this.errorEvent(
              session.id,
              "WORKER_PROTOCOL_ERROR",
              error instanceof Error ? error.message : String(error),
            ),
          );
          continue;
        }
        await emit(event);
        if (event.type === "tool.proposal") {
          const metadata = TOOL_METADATA[event.tool];
          const needsApproval = metadata
            ? policy.requiresApproval(event.risk)
            : true;
          let approved = !needsApproval;
          let decision: "approve-once" | "approve-session" | "deny" | "cancel" =
            "approve-once";
          if (needsApproval) {
            if (options.approveAll) {
              approved = true;
              decision = "approve-session";
            } else if (
              approvalMode === "session-approve" &&
              event.risk !== "destructive" &&
              event.risk !== "network"
            ) {
              approved = true;
              decision = "approve-session";
            } else if (options.approve) {
              decision = await options.approve(event);
              approved =
                decision === "approve-once" || decision === "approve-session";
              if (decision === "approve-session")
                approvalMode = "session-approve";
            }
          }
          if (decision === "cancel") {
            send(
              this.cancelEvent(
                session.id,
                "User cancelled the requested operation",
              ),
            );
            continue;
          }
          const result =
            approved && policy.isAllowed(event.risk)
              ? await tools.execute({
                  tool: event.tool,
                  arguments: event.arguments,
                })
              : {
                  ok: false,
                  error: {
                    code: "APPROVAL_DENIED",
                    message:
                      "The operation was denied by Forge policy or the user.",
                    retryable: false,
                  },
                  durationMs: 0,
                };
          const resultEvent: ToolResultEvent = {
            ...createEnvelope("tool.result", session.id),
            type: "tool.result",
            tool: event.tool,
            ok: result.ok,
            ...(result.output === undefined ? {} : { output: result.output }),
            ...(result.error === undefined ? {} : { error: result.error }),
            approved,
            durationMs: result.durationMs,
          };
          await emit(resultEvent);
          send(resultEvent);
        }
        if (event.type === "session.complete") {
          sessionResult = {
            sessionId: session.id,
            status: event.status,
            summary: event.summary,
            changedFiles: event.changedFiles,
          };
          worker.stdin.end();
        }
      }
    })();

    const startEvent = {
      ...createEnvelope("session.start", session.id),
      type: "session.start" as const,
      workspace,
      policy: options.policy ?? "safe",
      provider: process.env.FORGE_PROVIDER ?? "mock",
      capabilities: Object.keys(TOOL_METADATA),
      prompt: options.prompt,
      context: repositoryContext,
    };
    await emit(startEvent);
    send(startEvent);
    await processing;
    if (!sessionResult) {
      sessionResult = {
        sessionId: session.id,
        status: "failed",
        summary: "The worker exited before completing the session.",
        changedFiles: [],
      };
    }
    if (!worker.killed) worker.kill();
    return sessionResult;
  }

  public async listSessions(): Promise<ReturnType<SessionStore["list"]>> {
    return this.sessions.list();
  }

  public async readSession(id: string): Promise<SessionRecord> {
    return this.sessions.read(id);
  }

  public async removeSession(id: string): Promise<void> {
    await this.sessions.remove(id);
  }

  public getSessionPath(): string {
    return this.sessions.getPath();
  }

  private startWorker(options: RunOptions): ChildProcessWithoutNullStreams {
    const python =
      process.env.FORGE_PYTHON ??
      (process.platform === "win32" ? "python" : "python3");
    const pythonRoot = path.resolve(process.cwd(), "python");
    const env = {
      ...process.env,
      PYTHONPATH: [pythonRoot, process.env.PYTHONPATH]
        .filter(Boolean)
        .join(path.delimiter),
      ...(options.multiAgent === undefined
        ? {}
        : { FORGE_MULTI_AGENT: options.multiAgent ? "1" : "0" }),
      ...(options.maxAgents === undefined
        ? {}
        : { FORGE_MAX_AGENTS: String(options.maxAgents) }),
      ...(options.maxTotalTurns === undefined
        ? {}
        : { FORGE_MAX_TOTAL_TURNS: String(options.maxTotalTurns) }),
    };
    return spawn(python, ["-m", "forge_agent.worker"], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  private errorEvent(
    sessionId: string,
    code: string,
    message: string,
  ): ForgeEvent {
    return {
      ...createEnvelope("error", sessionId),
      type: "error",
      error: { code, message, retryable: false },
    };
  }

  private cancelEvent(sessionId: string, reason: string): ForgeEvent {
    return {
      ...createEnvelope("session.cancel", sessionId),
      type: "session.cancel",
      reason,
    };
  }
}
