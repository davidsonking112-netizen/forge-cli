import type {
  AgentChecklistEvent,
  AgentDelegationEvent,
  AgentGraphEvent,
  AgentPlanEvent,
  AgentRepairEvent,
  AgentScratchpadEvent,
  AgentStateEvent,
  ForgeEvent,
  SessionCompleteEvent,
  ToolProposalEvent,
} from "../../../packages/protocol/src/index.js";

export type TuiCommand = "cancel";
export type TuiTab = "overview" | "plan" | "activity" | "evidence";

export interface TuiInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  resume?: () => void;
  on: (event: "data", listener: (chunk: Buffer | string) => void) => void;
  off: (event: "data", listener: (chunk: Buffer | string) => void) => void;
}

export interface TuiOutput {
  columns?: number;
  rows?: number;
  write: (chunk: string) => void;
  on: (event: "resize", listener: () => void) => void;
  off: (event: "resize", listener: () => void) => void;
}

export interface FullScreenTuiOptions {
  input?: TuiInput;
  output?: TuiOutput;
  onCommand?: (command: TuiCommand) => void;
}

type Activity = {
  time: string;
  kind: string;
  text: string;
  tone: "normal" | "good" | "warn" | "bad";
};

type ToolEntry = {
  tool: string;
  risk: string;
  status: "proposed" | "ok" | "failed" | "denied";
  detail: string;
};

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
};

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const cleanText = (value: unknown, max = 320): string => {
  const text = String(value ?? "")
    .replace(ANSI_ESCAPE, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r/g, "")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const shortId = (value: string): string =>
  value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;

const statusTone = (status: string): "normal" | "good" | "warn" | "bad" => {
  if (["completed", "complete", "ok", "passed", "succeeded"].includes(status))
    return "good";
  if (["blocked", "failed", "exhausted", "cancelled"].includes(status))
    return "bad";
  if (["active", "proposed", "started", "awaiting-approval"].includes(status))
    return "warn";
  return "normal";
};

export class FullScreenTui {
  private readonly input: TuiInput;
  private readonly output: TuiOutput;
  private readonly onCommand: ((command: TuiCommand) => void) | undefined;
  private readonly activity: Activity[] = [];
  private readonly tools: ToolEntry[] = [];
  private checklist: AgentChecklistEvent["items"] = [];
  private scratchpad: AgentScratchpadEvent["items"] = [];
  private plan: AgentPlanEvent | undefined;
  private delegations: AgentDelegationEvent[] = [];
  private checks: SessionCompleteEvent["checks"] = [];
  private executionState: AgentStateEvent | undefined;
  private executionGraph: AgentGraphEvent | undefined;
  private contextLayers = {
    architectureModules: 0,
    acceptanceItems: 0,
    symbolSlices: 0,
    failureItems: 0,
    attemptItems: 0,
  };
  private sessionId = "";
  private workspace = "";
  private provider = "";
  private policy = "";
  private runStatus = "starting";
  private summary = "Waiting for the supervised session to start.";
  private activeApproval: ToolProposalEvent | undefined;
  private activeTab: TuiTab = "overview";
  private activityOffset = 0;
  private active = false;
  private cancelRequested = false;
  private inputSuspended = false;
  private startedAt = 0;
  private eventCount = 0;
  private readonly resizeHandler = (): void => this.draw();
  private readonly inputHandler = (chunk: Buffer | string): void =>
    this.handleInput(chunk);
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  public constructor(options: FullScreenTuiOptions = {}) {
    this.input = options.input ?? (process.stdin as unknown as TuiInput);
    this.output = options.output ?? (process.stdout as unknown as TuiOutput);
    this.onCommand = options.onCommand;
  }

  public start(): void {
    if (this.active) return;
    this.active = true;
    this.startedAt = Date.now();
    this.output.on("resize", this.resizeHandler);
    this.input.on("data", this.inputHandler);
    this.input.setRawMode?.(true);
    this.input.resume?.();
    this.refreshTimer = setInterval(() => this.draw(), 1_000);
    this.output.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
    this.draw();
  }

  public stop(): void {
    if (!this.active) return;
    this.active = false;
    this.output.off("resize", this.resizeHandler);
    this.input.off("data", this.inputHandler);
    this.input.setRawMode?.(false);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.output.write("\x1b[?25h\x1b[?1049l");
  }

  public setInputSuspended(suspended: boolean): void {
    this.inputSuspended = suspended;
  }

  public setApprovalActive(active: boolean): void {
    if (!active) this.activeApproval = undefined;
    this.draw();
  }

  public handle(event: ForgeEvent): void {
    if (!this.active) return;
    this.eventCount += 1;
    const time = new Date(event.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    if (event.type === "session.start") {
      this.sessionId = event.sessionId;
      this.workspace = event.workspace;
      this.provider = event.provider;
      this.policy = `${event.policy}${event.profile ? ` / ${event.profile}` : ""}`;
      const contextPack =
        event.context &&
        typeof event.context === "object" &&
        "contextPack" in event.context
          ? (
              event.context as {
                contextPack?: {
                  architectureMap: { modules: unknown[] };
                  acceptanceMap: unknown[];
                  symbolSlices: unknown[];
                  failureContext: unknown[];
                  attemptHistory: unknown[];
                };
              }
            ).contextPack
          : undefined;
      if (contextPack) {
        this.contextLayers = {
          architectureModules: contextPack.architectureMap.modules.length,
          acceptanceItems: contextPack.acceptanceMap.length,
          symbolSlices: contextPack.symbolSlices.length,
          failureItems: contextPack.failureContext.length,
          attemptItems: contextPack.attemptHistory.length,
        };
      }
      this.runStatus = "running";
      this.addActivity(
        time,
        "SESSION",
        `Started in ${event.workspace}`,
        "good",
      );
    } else if (event.type === "user.prompt") {
      this.addActivity(time, "PROMPT", event.prompt, "normal");
    } else if (event.type === "agent.text") {
      this.summary = cleanText(event.text, 600) || this.summary;
      this.addActivity(time, "AGENT", event.text, "normal");
    } else if (event.type === "agent.checklist") {
      this.checklist = event.items;
      this.addActivity(
        time,
        "CHECK",
        `${this.completedChecklist()}/${event.items.length} expectations complete`,
        "normal",
      );
    } else if (event.type === "agent.scratchpad") {
      this.scratchpad = event.items;
      this.addActivity(
        time,
        "STATE",
        `${event.items.length} scratchpad entries updated`,
        "normal",
      );
    } else if (event.type === "agent.plan") {
      this.plan = event;
      this.addActivity(time, "PLAN", event.goal, "good");
    } else if (event.type === "agent.state") {
      this.executionState = event;
      this.addActivity(
        time,
        "STATE",
        `${event.phase} / ${event.artifact}: ${event.note}`,
        statusTone(event.status),
      );
    } else if (event.type === "agent.graph") {
      this.executionGraph = event;
      const completed = event.steps.filter(
        (step) => step.status === "completed",
      ).length;
      this.addActivity(
        time,
        "GRAPH",
        `${completed}/${event.steps.length} steps complete; active ${event.activeStepId ?? "none"}`,
        statusTone(event.status),
      );
    } else if (event.type === "agent.delegation") {
      this.delegations = [
        ...this.delegations.filter((entry) => entry.role !== event.role),
        event,
      ];
      this.addActivity(
        time,
        "AGENT",
        `${event.role}: ${event.status} (${event.turns} turn${event.turns === 1 ? "" : "s"})`,
        statusTone(event.status),
      );
    } else if (event.type === "agent.repair") {
      this.addActivity(
        time,
        "REPAIR",
        `attempt ${event.attempt}/${event.maxAttempts}: ${event.strategy} — ${event.reason}`,
        statusTone(event.status),
      );
    } else if (event.type === "tool.proposal") {
      this.tools.push({
        tool: event.tool,
        risk: event.risk,
        status: "proposed",
        detail: cleanText(event.reason),
      });
      this.activeApproval = event;
      this.addActivity(time, "TOOL", `${event.tool} [${event.risk}]`, "warn");
    } else if (event.type === "approval.result") {
      const last = this.tools.at(-1);
      if (last && ["deny", "cancel"].includes(event.decision))
        last.status = "denied";
      this.addActivity(
        time,
        "APPROVE",
        `${event.decision} (${shortId(event.proposalId)})`,
        statusTone(event.decision),
      );
    } else if (event.type === "tool.result") {
      const last = [...this.tools]
        .reverse()
        .find(
          (entry) => entry.tool === event.tool && entry.status === "proposed",
        );
      if (last) last.status = event.ok ? "ok" : "failed";
      this.addActivity(
        time,
        "RESULT",
        `${event.tool}: ${event.ok ? "ok" : "failed"} in ${event.durationMs}ms`,
        event.ok ? "good" : "bad",
      );
    } else if (event.type === "session.complete") {
      this.runStatus = event.status;
      this.summary = event.summary;
      this.checks = event.checks;
      this.activeApproval = undefined;
      this.addActivity(time, "DONE", event.status, statusTone(event.status));
    } else if (event.type === "session.cancel") {
      this.runStatus = "cancelled";
      this.addActivity(time, "CANCEL", event.reason, "warn");
    } else if (event.type === "error") {
      this.runStatus = "failed";
      this.summary = event.error.message;
      this.addActivity(
        time,
        "ERROR",
        `${event.error.code}: ${event.error.message}`,
        "bad",
      );
    }
    this.draw();
  }

  public showApproval(proposal: ToolProposalEvent): void {
    if (!this.active) return;
    this.activeApproval = proposal;
    this.addActivity(
      new Date().toLocaleTimeString([], { hour12: false }),
      "APPROVE",
      `${proposal.tool} requires your decision`,
      "warn",
    );
    this.draw();
  }

  private handleInput(chunk: Buffer | string): void {
    if (!this.active || this.inputSuspended || this.activeApproval) return;
    const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    if (value.includes("\u0003") || value.toLowerCase().includes("q")) {
      if (!this.cancelRequested) {
        this.cancelRequested = true;
        this.addActivity(
          new Date().toLocaleTimeString([], { hour12: false }),
          "CANCEL",
          "Cancellation requested by operator",
          "warn",
        );
        this.onCommand?.("cancel");
      }
      return;
    }
    if (value.includes("\t") || value.includes("\x1b[C")) this.nextTab();
    else if (value.includes("\x1b[D")) this.previousTab();
    else if (value.includes("1")) this.activeTab = "overview";
    else if (value.includes("2")) this.activeTab = "plan";
    else if (value.includes("3")) this.activeTab = "activity";
    else if (value.includes("4")) this.activeTab = "evidence";
    else if (value.includes("\x1b[A") || value.toLowerCase().includes("k"))
      this.activityOffset = Math.min(
        this.activityOffset + 1,
        Math.max(0, this.activity.length - 1),
      );
    else if (value.includes("\x1b[B") || value.toLowerCase().includes("j"))
      this.activityOffset = Math.max(0, this.activityOffset - 1);
    this.draw();
  }

  private nextTab(): void {
    const tabs: TuiTab[] = ["overview", "plan", "activity", "evidence"];
    this.activeTab =
      tabs[(tabs.indexOf(this.activeTab) + 1) % tabs.length] ?? "overview";
  }

  private previousTab(): void {
    const tabs: TuiTab[] = ["overview", "plan", "activity", "evidence"];
    this.activeTab =
      tabs[(tabs.indexOf(this.activeTab) + tabs.length - 1) % tabs.length] ??
      "overview";
  }

  private completedChecklist(): number {
    return this.checklist.filter((item) => item.status === "complete").length;
  }

  private addActivity(
    time: string,
    kind: string,
    text: string,
    tone: Activity["tone"],
  ): void {
    this.activity.push({ time, kind, text: cleanText(text), tone });
    if (this.activity.length > 250) this.activity.shift();
    this.activityOffset = 0;
  }

  private tone(value: Activity["tone"]): string {
    if (value === "good") return ANSI.green;
    if (value === "warn") return ANSI.yellow;
    if (value === "bad") return ANSI.red;
    return ANSI.white;
  }

  private writeLine(value = ""): void {
    this.output.write(`${value}\n`);
  }

  private fit(value: string, width: number): string {
    const text = cleanText(value, Math.max(0, width));
    return text.length > width
      ? `${text.slice(0, Math.max(0, width - 1))}…`
      : text.padEnd(Math.max(0, width), " ");
  }

  private wrap(value: string, width: number): string[] {
    const text = cleanText(value, 2_000);
    if (width < 8) return [this.fit(text, width)];
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      if ((current ? current.length + 1 : 0) + word.length <= width)
        current = current ? `${current} ${word}` : word;
      else {
        if (current) lines.push(current);
        current = word.slice(0, width);
      }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [""];
  }

  private section(title: string, width: number): void {
    this.writeLine(
      `${ANSI.cyan}${ANSI.bold}┌─ ${this.fit(title, Math.max(0, width - 4))} ${"─".repeat(Math.max(0, width - title.length - 5))}┐${ANSI.reset}`,
    );
  }

  private draw(): void {
    if (!this.active) return;
    const width = Math.max(60, Math.min(this.output.columns ?? 110, 140));
    const rows = Math.max(18, this.output.rows ?? 36);
    const inner = width - 2;
    const elapsed = this.startedAt
      ? `${Math.floor((Date.now() - this.startedAt) / 1000)}s`
      : "0s";
    const statusColor = statusTone(this.runStatus);
    this.output.write("\x1b[2J\x1b[H");
    this.writeLine(
      `${ANSI.bgBlue}${ANSI.white}${ANSI.bold} ${this.fit("FORGE CLI  •  SUPERVISED WORKSPACE", inner)} ${ANSI.reset}`,
    );
    this.writeLine(
      `${ANSI.dim}${this.fit(`Status ${this.runStatus.toUpperCase()}   Session ${shortId(this.sessionId || "pending")}   Events ${this.eventCount}   Elapsed ${elapsed}`, inner)}${ANSI.reset}`,
    );
    this.writeLine(
      `${ANSI.dim}${this.fit(`Provider ${this.provider || "detecting"}   Policy ${this.policy || "safe"}   Workspace ${this.workspace || "pending"}`, inner)}${ANSI.reset}`,
    );
    this.writeLine(
      `${ANSI.dim}${this.fit(`Execution phase ${this.executionState?.phase || "intake"}   Artifact ${this.executionState?.artifact || "task-contract"}   Budget ${this.executionState ? `${this.executionState.budget.providerTurns}/${this.executionState.budget.maxProviderTurns} turns, ${this.executionState.budget.toolCalls}/${this.executionState.budget.maxToolCalls} tools` : "initializing"}`, inner)}${ANSI.reset}`,
    );
    if (this.executionGraph) {
      const completed = this.executionGraph.steps.filter(
        (step) => step.status === "completed",
      ).length;
      this.writeLine(
        `${ANSI.dim}${this.fit(`Dependency graph ${completed}/${this.executionGraph.steps.length}   Active ${this.executionGraph.activeStepId ?? "none"}   Status ${this.executionGraph.status}`, inner)}${ANSI.reset}`,
      );
    }
    const tabs = ["1 Overview", "2 Plan", "3 Activity", "4 Evidence"]
      .map((tab) =>
        tab.startsWith(
          this.activeTab === "overview"
            ? "1"
            : this.activeTab === "plan"
              ? "2"
              : this.activeTab === "activity"
                ? "3"
                : "4",
        )
          ? `${ANSI.bold}${tab}${ANSI.reset}`
          : `${ANSI.dim}${tab}${ANSI.reset}`,
      )
      .join("   ");
    this.writeLine(`${ANSI.cyan}${tabs}${ANSI.reset}`);
    this.writeLine(`${ANSI.dim}${"─".repeat(width)}${ANSI.reset}`);
    if (this.activeApproval)
      this.writeLine(
        `${ANSI.yellow}${ANSI.bold} APPROVAL REQUIRED  ${this.fit(`${this.activeApproval.tool} [${this.activeApproval.risk}]`, inner - 20)}${ANSI.reset}`,
      );
    if (this.activeTab === "overview") this.drawOverview(inner, rows);
    else if (this.activeTab === "plan") this.drawPlan(inner, rows);
    else if (this.activeTab === "activity") this.drawActivity(inner, rows);
    else this.drawEvidence(inner, rows);
    this.writeLine(`${ANSI.dim}${"─".repeat(width)}${ANSI.reset}`);
    this.writeLine(
      `${this.tone(statusColor)}${this.fit(` ${this.summary}`, inner)}${ANSI.reset}`,
    );
    this.writeLine(
      `${ANSI.dim}${this.fit("Keys: 1-4 tabs  Tab/Arrows navigate  j/k scroll activity  q/Ctrl-C cancel  --simple disables full-screen UI", inner)}${ANSI.reset}`,
    );
  }

  private drawOverview(inner: number, rows: number): void {
    const gap = 3;
    const left = Math.max(24, Math.floor(inner * 0.38));
    const right = inner - left - gap;
    const height = Math.max(7, rows - 11);
    this.section(
      `CHECKLIST ${this.completedChecklist()}/${this.checklist.length || 0}`,
      left,
    );
    this.section("LIVE ACTIVITY", right);
    const checklistLines: string[] = [];
    for (const item of this.checklist.slice(0, Math.max(1, height - 2))) {
      const marker =
        item.status === "complete"
          ? "OK"
          : item.status === "active"
            ? ">>"
            : item.status === "blocked"
              ? "!!"
              : "--";
      checklistLines.push(`${marker} ${item.label}`);
      if (item.status === "active" || item.note)
        checklistLines.push(`   ${item.note || item.expectation}`);
    }
    if (!checklistLines.length) checklistLines.push("Waiting for checklist...");
    const activityLines = this.activity.slice(
      -(height - 1) - this.activityOffset,
      this.activity.length - this.activityOffset || undefined,
    );
    const visibleActivity = activityLines.length
      ? activityLines
      : [
          {
            time: "--:--:--",
            kind: "WAIT",
            text: "Waiting for Forge events...",
            tone: "normal" as const,
          },
        ];
    for (let row = 0; row < height; row += 1) {
      const leftText = checklistLines[row] || "";
      const event = visibleActivity[row];
      const rightText = event
        ? `${event.time} ${event.kind.padEnd(7)} ${event.text}`
        : "";
      this.writeLine(
        `${this.fit(leftText, left)}   ${this.tone(event?.tone ?? "normal")}${this.fit(rightText, right)}${ANSI.reset}`,
      );
    }
    this.writeLine(
      `${ANSI.dim}${this.fit("Scratchpad", left)}   ${ANSI.dim}${this.fit("Recent state and tool activity", right)}${ANSI.reset}`,
    );
    const scratch = this.scratchpad
      .slice(0, 2)
      .map((item) => `${item.status.toUpperCase()} ${item.key}: ${item.value}`)
      .join(" | ");
    this.writeLine(
      `${this.fit(scratch || "No scratchpad entries yet.", inner)}`,
    );
    this.writeLine(
      `${ANSI.bold}Context retrieval${ANSI.reset}: contract + architecture ${this.contextLayers.architectureModules} modules | acceptance ${this.contextLayers.acceptanceItems} | symbols ${this.contextLayers.symbolSlices} | failures ${this.contextLayers.failureItems} | prior attempts ${this.contextLayers.attemptItems}`,
    );
  }

  private drawPlan(inner: number, rows: number): void {
    if (!this.plan) {
      this.writeLine(
        "No plan event received yet. Forge will show the plan when the provider creates it.",
      );
      return;
    }
    this.writeLine(
      `${ANSI.bold}Goal${ANSI.reset}: ${this.fit(this.plan.goal, inner - 7)}`,
    );
    this.writeLine("");
    const maxSteps = Math.max(1, rows - 16);
    for (const step of this.plan.steps.slice(0, maxSteps)) {
      const marker =
        step.status === "complete"
          ? "OK"
          : step.status === "active"
            ? ">>"
            : step.status === "blocked"
              ? "!!"
              : "--";
      this.writeLine(
        `${this.tone(statusTone(step.status))}${marker} ${step.id}  ${step.description}${ANSI.reset}`,
      );
    }
    this.writeLine("");
    this.writeLine(
      `${ANSI.bold}Assumptions${ANSI.reset}: ${this.fit(this.plan.assumptions.join(" | ") || "none", inner - 14)}`,
    );
    this.writeLine(
      `${ANSI.bold}Verification${ANSI.reset}: ${this.fit(this.plan.verification.join(" | ") || "none", inner - 14)}`,
    );
  }

  private drawActivity(inner: number, rows: number): void {
    const height = Math.max(3, rows - 12);
    const visible = this.activity.slice(
      -height - this.activityOffset,
      this.activity.length - this.activityOffset || undefined,
    );
    if (!visible.length) this.writeLine("No activity yet.");
    for (const event of visible)
      this.writeLine(
        `${this.tone(event.tone)}${this.fit(`${event.time}  ${event.kind.padEnd(8)} ${event.text}`, inner)}${ANSI.reset}`,
      );
  }

  private drawEvidence(inner: number, rows: number): void {
    if (this.executionGraph) {
      this.writeLine(`${ANSI.bold}Dependency graph${ANSI.reset}`);
      for (const step of this.executionGraph.steps.slice(
        0,
        Math.max(1, Math.floor((rows - 18) / 4)),
      )) {
        const marker =
          step.status === "completed"
            ? "✓"
            : step.status === "active"
              ? "→"
              : step.status === "blocked" || step.status === "failed"
                ? "!"
                : "-";
        this.writeLine(
          this.fit(
            `${marker} ${step.id} [${step.status}] deps=${step.dependencies.join(",") || "none"}`,
            inner,
          ),
        );
        this.writeLine(
          this.fit(
            `  files=${step.expectedFiles.join(", ") || "unspecified"} risks=${step.risks.join("; ") || "unspecified"}`,
            inner,
          ),
        );
        this.writeLine(
          this.fit(
            `  tests=${step.tests.join("; ") || "missing"} post=${step.postconditions.join("; ") || "missing"}`,
            inner,
          ),
        );
        if (step.contractErrors.length)
          this.writeLine(
            this.fit(`  contract: ${step.contractErrors.join("; ")}`, inner),
          );
      }
      this.writeLine("");
    }
    if (this.executionState) {
      this.writeLine(
        `${ANSI.bold}Enforced execution state${ANSI.reset}: ${this.executionState.phase} / ${this.executionState.status}`,
      );
      this.writeLine(
        this.fit(
          `Artifact ${this.executionState.artifactId}: ${this.executionState.artifact}`,
          inner,
        ),
      );
      this.writeLine(
        this.fit(`Required: ${this.executionState.requiredArtifact}`, inner),
      );
      this.writeLine(
        this.fit(`Exit: ${this.executionState.exitCondition}`, inner),
      );
      this.writeLine(
        this.fit(`Failure: ${this.executionState.failureTransition}`, inner),
      );
      this.writeLine("");
    }
    this.writeLine(`${ANSI.bold}Tools${ANSI.reset}`);
    for (const entry of this.tools.slice(
      -Math.max(2, Math.floor((rows - 15) / 2)),
    ))
      this.writeLine(
        `${this.tone(statusTone(entry.status))}${this.fit(`${entry.status.toUpperCase().padEnd(9)} ${entry.tool} [${entry.risk}] — ${entry.detail}`, inner)}${ANSI.reset}`,
      );
    this.writeLine("");
    this.writeLine(`${ANSI.bold}Specialists${ANSI.reset}`);
    this.writeLine(
      this.fit(
        this.delegations.length
          ? this.delegations
              .map((entry) => `${entry.role}:${entry.status}/${entry.turns}t`)
              .join("   ")
          : "No specialist delegation events.",
        inner,
      ),
    );
    this.writeLine("");
    this.writeLine(`${ANSI.bold}Verification${ANSI.reset}`);
    for (const check of this.checks.slice(-Math.max(2, rows - 20)))
      this.writeLine(
        `${this.tone(check.ok ? "good" : "bad")}${this.fit(`${check.ok ? "PASS" : "FAIL"}  ${check.command} (exit ${check.exitCode ?? "?"})`, inner)}${ANSI.reset}`,
      );
    if (this.activeApproval) {
      this.writeLine("");
      this.writeLine(
        `${ANSI.yellow}${ANSI.bold}APPROVAL REQUIRED${ANSI.reset} ${this.activeApproval.tool} [${this.activeApproval.risk}]`,
      );
      this.writeLine(this.fit(`Reason: ${this.activeApproval.reason}`, inner));
    }
  }
}
