import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ForgeEvent } from "../../../packages/protocol/src/index.js";

export interface SessionRecord {
  id: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  events: ForgeEvent[];
}

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
      events: [],
    };
    await this.save(record);
    return record;
  }

  public async save(record: SessionRecord): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const sanitized = JSON.stringify(
      { ...record, events: record.events.slice(-500) },
      null,
      2,
    );
    await fs.writeFile(
      path.join(this.directory, `${record.id}.json`),
      sanitized,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  public async append(record: SessionRecord, event: ForgeEvent): Promise<void> {
    record.events.push(this.sanitizeEvent(event));
    record.updatedAt = new Date().toISOString();
    await this.save(record);
  }

  public async list(): Promise<
    Array<Pick<SessionRecord, "id" | "workspace" | "createdAt" | "updatedAt">>
  > {
    const entries = await fs
      .readdir(this.directory, { withFileTypes: true })
      .catch(() => []);
    const records: Array<
      Pick<SessionRecord, "id" | "workspace" | "createdAt" | "updatedAt">
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
    return record;
  }

  public async remove(id: string): Promise<void> {
    await fs.unlink(path.join(this.directory, `${id}.json`));
  }

  public getPath(): string {
    return this.directory;
  }

  private sanitizeEvent(event: ForgeEvent): ForgeEvent {
    const copy = structuredClone(event) as ForgeEvent;
    if (copy.type === "tool.proposal" && copy.tool === "process.run") {
      const args = copy.arguments;
      if (typeof args.command === "string")
        args.command = args.command.replace(
          /(api[_-]?key|token|password|secret)=\S+/gi,
          "$1=[REDACTED]",
        );
    }
    return copy;
  }
}
