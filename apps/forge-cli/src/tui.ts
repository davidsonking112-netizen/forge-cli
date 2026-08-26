import type {
  AgentChecklistEvent,
  ForgeEvent,
  ToolProposalEvent,
} from "../../../packages/protocol/src/index.js";

export class FullScreenTui {
  private readonly lines: string[] = [];
  private checklist: AgentChecklistEvent["items"] = [];
  private active = false;
  private readonly resizeHandler = (): void => this.draw();

  public start(): void {
    if (this.active) return;
    this.active = true;
    process.stdout.on("resize", this.resizeHandler);
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
    this.draw();
  }

  public stop(): void {
    if (!this.active) return;
    this.active = false;
    process.stdout.off("resize", this.resizeHandler);
    process.stdout.write("\x1b[?1049l");
  }

  public handle(event: ForgeEvent): void {
    if (!this.active) return;
    if (event.type === "agent.checklist") this.checklist = event.items;
    if (event.type === "agent.text") this.lines.push(`Forge  ${event.text}`);
    if (event.type === "agent.repair")
      this.lines.push(
        `[repair ${event.status}] attempt ${event.attempt}/${event.maxAttempts} ${event.strategy}: ${event.reason}`,
      );
    if (event.type === "agent.delegation")
      this.lines.push(
        `[${event.status}] ${event.role} specialist (${event.turns} turn${event.turns === 1 ? "" : "s"})`,
      );
    if (event.type === "agent.plan") {
      this.lines.push(`PLAN   ${event.goal}`);
      for (const step of event.steps)
        this.lines.push(`       ${step.status.padEnd(8)} ${step.description}`);
    }
    if (event.type === "tool.proposal")
      this.lines.push(`TOOL   ${event.tool} [${event.risk}]`);
    if (event.type === "tool.result")
      this.lines.push(`RESULT ${event.tool} ${event.ok ? "ok" : "failed"}`);
    if (event.type === "approval.result")
      this.lines.push(
        `APPROVAL ${event.category ?? "user"} ${event.decision} (${event.proposalId.slice(0, 8)})`,
      );
    if (event.type === "session.complete")
      this.lines.push(`DONE   ${event.status}: ${event.summary}`);
    if (event.type === "error")
      this.lines.push(`ERROR  ${event.error.code}: ${event.error.message}`);
    while (this.lines.length > 24) this.lines.shift();
    this.draw();
  }

  public showApproval(proposal: ToolProposalEvent): void {
    if (!this.active) return;
    this.lines.push(`APPROVAL REQUIRED  ${proposal.tool} (${proposal.risk})`);
    this.lines.push(`Arguments: ${JSON.stringify(proposal.arguments)}`);
    this.draw();
  }

  private draw(): void {
    if (!this.active) return;
    const width = Math.max(40, Math.min(process.stdout.columns ?? 100, 120));
    const title = ` Forge CLI v0.9.9 | ${"local-first coding agent".padEnd(width - 21, " ")} `;
    process.stdout.write(
      `\x1b[2J\x1b[H\x1b[1;36m${title.slice(0, width)}\x1b[0m\n`,
    );
    process.stdout.write(`${"─".repeat(width)}\n`);
    if (this.checklist.length) {
      process.stdout.write("Checklist:\n");
      for (const item of this.checklist.slice(0, 24)) {
        const marker =
          item.status === "complete"
            ? "✓"
            : item.status === "active"
              ? "→"
              : item.status === "blocked"
                ? "!"
                : "-";
        process.stdout.write(
          `  ${marker} ${item.label}: ${item.expectation}${item.note ? ` (${item.note})` : ""}\n`.slice(
            0,
            width + 1,
          ),
        );
      }
      process.stdout.write(`${"─".repeat(width)}\n`);
    }
    for (const line of this.lines)
      process.stdout.write(`${line.slice(0, width)}\n`);
    process.stdout.write(`\n${"─".repeat(width)}\n`);
    process.stdout.write(
      "Keys: approval prompts use y=once, s=session, n=deny, c=cancel | --simple disables TUI\n",
    );
  }
}
