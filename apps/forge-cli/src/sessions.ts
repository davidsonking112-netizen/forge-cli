import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactValue } from "./redaction.js";
import type {
  AgentStateEvent,
  CheckResult,
  ChecklistItem,
  ForgeEvent,
  PlanStep,
  RecoveryAssessment,
  ScratchpadItem,
} from "../../../packages/protocol/src/index.js";

export type SessionStatus =
  "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface PlanSnapshot {
  goal: string;
  steps: Array<{ id: string; description: string; status: string }>;
  assumptions: string[];
  verification: string[];
}

export type JournalStepStatus =
  PlanStep["status"] | "awaiting-approval" | "stale";

export interface StepJournalEntry {
  stepId: string;
  description: string;
  status: JournalStepStatus;
  startedAt?: string;
  updatedAt: string;
  proposalIds: string[];
  toolResults: number;
  lastTool?: string;
  lastResultOk?: boolean;
  lastApproval?: "approve-once" | "approve-session" | "deny" | "cancel";
}

export interface SessionRecord {
  id: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  resumeCount: number;
  workspaceFingerprint?: string;
  recovery?: RecoveryAssessment;
  scratchpad: ScratchpadItem[];
  checklist: ChecklistItem[];
  plan?: PlanSnapshot;
  journal: StepJournalEntry[];
  executionState?: AgentStateEvent;
  verification: CheckResult[];
  events: ForgeEvent[];
}

const MAX_IN_MEMORY_EVENTS = 500;

export class SessionStore {
  private readonly directory: string;

  public constructor(
    baseDirectory = path.join(
      process.env.XDG_STATE_HOME ??
        path.join(process.env.HOME ?? process.cwd(), ".local", "state"),
      "forge",
      "sessions",
    ),
  ) {
    this.directory = baseDirectory;
  }

  public async create(workspace: string): Promise<SessionRecord> {
    const timestamp = new Date().toISOString();
    const record: SessionRecord = {
      id: randomUUID(),
      workspace,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "running",
      resumeCount: 0,
      journal: [],
      scratchpad: [],
      checklist: [],
      verification: [],
      events: [],
    };
    await this.save(record);
    return record;
  }

  public async save(record: SessionRecord): Promise<void> {
    if (!Array.isArray(record.journal)) record.journal = [];
    if (!Array.isArray(record.scratchpad)) record.scratchpad = [];
    if (!Array.isArray(record.checklist)) record.checklist = [];
    if (!Array.isArray(record.verification)) record.verification = [];
    if (!/^[0-9a-f-]{36}$/i.test(record.id))
      throw new Error("Invalid session ID");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const sanitized = JSON.stringify(
      {
        ...record,
        journal: record.journal.slice(0, 64).map((entry) => ({
          ...entry,
          description: entry.description.slice(0, 500),
          proposalIds: entry.proposalIds.slice(-32),
        })),
        scratchpad: record.scratchpad.slice(0, 64).map((item) => ({
          key: String(item.key ?? "").slice(0, 100),
          value: String(item.value ?? "").slice(0, 1_000),
          status: ["todo", "active", "done", "blocked"].includes(item.status)
            ? item.status
            : "todo",
        })),
        checklist: record.checklist.slice(0, 64).map((item) => ({
          id: String(item.id ?? "").slice(0, 100),
          label: String(item.label ?? "").slice(0, 300),
          expectation: String(item.expectation ?? "").slice(0, 500),
          status: ["pending", "active", "complete", "blocked"].includes(
            item.status,
          )
            ? item.status
            : "pending",
          ...(item.note ? { note: String(item.note).slice(0, 500) } : {}),
        })),
        ...(record.executionState
          ? { executionState: record.executionState }
          : {}),
        verification: record.verification.slice(0, 32).map((check) => ({
          ...check,
          command: check.command.slice(0, 500),
          output: check.output.slice(0, 100_000),
        })),
        events: record.events.slice(-500),
      },
      null,
      2,
    );
    const target = path.join(this.directory, `${record.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, sanitized, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporary, target).catch(async (error) => {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    });
  }

  public async append(record: SessionRecord, event: ForgeEvent): Promise<void> {
    if (!Array.isArray(record.journal)) record.journal = [];
    if (!Array.isArray(record.verification)) record.verification = [];
    const sanitized = this.sanitizeEvent(event);
    record.events.push(sanitized);
    if (record.events.length > MAX_IN_MEMORY_EVENTS)
      record.events.splice(0, record.events.length - MAX_IN_MEMORY_EVENTS);
    record.updatedAt = new Date().toISOString();
    if (sanitized.type === "agent.plan") {
      record.plan = {
        goal: sanitized.goal,
        steps: sanitized.steps.map(({ id, description, status }) => ({
          id,
          description,
          status,
        })),
        assumptions: [...sanitized.assumptions],
        verification: [...sanitized.verification],
      };
      const now = new Date().toISOString();
      record.journal = sanitized.steps.map((step) => ({
        stepId: step.id,
        description: step.description,
        status: step.status,
        ...(step.status === "active" ? { startedAt: now } : {}),
        updatedAt: now,
        proposalIds: [],
        toolResults: 0,
      }));
    }
    if (sanitized.type === "agent.state") {
      record.executionState = { ...sanitized };
    }
    if (sanitized.type === "agent.scratchpad") {
      record.scratchpad = sanitized.items.slice(0, 64).map((item) => ({
        key: item.key.slice(0, 100),
        value: item.value.slice(0, 1_000),
        status: item.status,
      }));
    }
    if (sanitized.type === "agent.checklist") {
      record.checklist = sanitized.items.slice(0, 64).map((item) => ({
        id: item.id.slice(0, 100),
        label: item.label.slice(0, 300),
        expectation: item.expectation.slice(0, 500),
        status: item.status,
        ...(item.note ? { note: item.note.slice(0, 500) } : {}),
      }));
    }
    if (sanitized.type === "tool.proposal") {
      const current = currentJournalEntry(record);
      if (current) {
        current.status = "awaiting-approval";
        current.updatedAt = new Date().toISOString();
        current.proposalIds.push(sanitized.id);
        current.lastTool = sanitized.tool;
      }
    }
    if (sanitized.type === "approval.result") {
      const current = currentJournalEntry(record);
      if (current) {
        current.lastApproval = sanitized.decision;
        current.updatedAt = new Date().toISOString();
      }
    }
    if (sanitized.type === "tool.result") {
      const current = currentJournalEntry(record);
      if (current) {
        current.status = sanitized.ok ? "active" : "blocked";
        current.updatedAt = new Date().toISOString();
        current.toolResults += 1;
        current.lastTool = sanitized.tool;
        current.lastResultOk = sanitized.ok;
      }
    }
    if (sanitized.type === "session.complete") {
      record.status = sanitized.status;
      record.verification = sanitized.checks.map((check) => ({ ...check }));
      const now = new Date().toISOString();
      if (sanitized.status === "completed") {
        for (const entry of record.journal) {
          if (
            entry.status === "active" ||
            entry.status === "awaiting-approval"
          ) {
            entry.status = "complete";
            entry.updatedAt = now;
          }
        }
      } else {
        const current = currentJournalEntry(record);
        if (current) {
          current.status = "blocked";
          current.updatedAt = now;
        }
      }
    }
    if (sanitized.type === "session.cancel") record.status = "cancelled";
    await this.save(record);
  }

  public async setRecoveryAssessment(
    record: SessionRecord,
    assessment: RecoveryAssessment,
  ): Promise<void> {
    record.recovery = { ...assessment };
    record.updatedAt = new Date().toISOString();
    await this.save(record);
  }

  public async incrementResume(record: SessionRecord): Promise<void> {
    record.resumeCount += 1;
    record.updatedAt = new Date().toISOString();
    await this.save(record);
  }

  public async markInterrupted(record: SessionRecord): Promise<void> {
    if (record.status === "running") {
      record.status = "interrupted";
      record.updatedAt = new Date().toISOString();
      await this.save(record);
    }
  }

  public async list(): Promise<
    Array<
      Pick<
        SessionRecord,
        | "id"
        | "workspace"
        | "createdAt"
        | "updatedAt"
        | "status"
        | "resumeCount"
      >
    >
  > {
    const entries = await fs
      .readdir(this.directory, { withFileTypes: true })
      .catch(() => []);
    const records: Array<
      Pick<
        SessionRecord,
        | "id"
        | "workspace"
        | "createdAt"
        | "updatedAt"
        | "status"
        | "resumeCount"
      >
    > = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = await this.read(entry.name.slice(0, -5)).catch(() => null);
      if (record)
        records.push({
          id: record.id,
          workspace: record.workspace,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          status: record.status,
          resumeCount: record.resumeCount,
        });
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async read(id: string): Promise<SessionRecord> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid session ID");
    const content = await fs.readFile(
      path.join(this.directory, `${id}.json`),
      "utf8",
    );
    const record = JSON.parse(content) as SessionRecord;
    if (!record || record.id !== id || !Array.isArray(record.events))
      throw new Error("Invalid session record");
    return {
      ...record,
      status: record.status ?? "interrupted",
      resumeCount: Number.isSafeInteger(record.resumeCount)
        ? record.resumeCount
        : 0,
      scratchpad: Array.isArray(record.scratchpad)
        ? record.scratchpad.slice(0, 64).map((item) => ({
            key: String(item.key ?? "").slice(0, 100),
            value: String(item.value ?? "").slice(0, 1_000),
            status: ["todo", "active", "done", "blocked"].includes(item.status)
              ? item.status
              : "todo",
          }))
        : [],
      checklist: Array.isArray(record.checklist)
        ? record.checklist.slice(0, 64).map((item) => ({
            id: String(item.id ?? "").slice(0, 100),
            label: String(item.label ?? "").slice(0, 300),
            expectation: String(item.expectation ?? "").slice(0, 500),
            status: ["pending", "active", "complete", "blocked"].includes(
              item.status,
            )
              ? item.status
              : "pending",
            ...(item.note ? { note: String(item.note).slice(0, 500) } : {}),
          }))
        : [],
      journal: Array.isArray(record.journal)
        ? record.journal.slice(0, 64).map((entry) => ({
            ...entry,
            description: String(entry.description ?? "").slice(0, 500),
            proposalIds: Array.isArray(entry.proposalIds)
              ? entry.proposalIds.slice(-32).map(String)
              : [],
          }))
        : [],
      verification: Array.isArray(record.verification)
        ? record.verification.slice(0, 32).map((check) => ({
            ...check,
            command: String(check.command ?? "").slice(0, 500),
            output: String(check.output ?? "").slice(0, 100_000),
          }))
        : [],
    };
  }

  public async remove(id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid session ID");
    await fs.unlink(path.join(this.directory, `${id}.json`));
  }

  public getPath(): string {
    return this.directory;
  }

  private sanitizeEvent(event: ForgeEvent): ForgeEvent {
    return redactValue(structuredClone(event)) as ForgeEvent;
  }
}

function currentJournalEntry(
  record: SessionRecord,
): StepJournalEntry | undefined {
  return (
    record.journal.find(
      (entry) =>
        entry.status === "active" || entry.status === "awaiting-approval",
    ) ?? record.journal.find((entry) => entry.status === "pending")
  );
}
