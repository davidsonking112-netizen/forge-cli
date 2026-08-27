import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { forgeStateDirectory } from "./paths.js";

const STALE_LOCK_MS = 24 * 60 * 60 * 1_000;

export class WorkspaceLockError extends Error {
  public readonly code = "WORKSPACE_LOCKED" as const;

  public constructor(
    message = "The approved workspace is already in use by another Forge process",
  ) {
    super(message);
    this.name = "WorkspaceLockError";
  }
}

export interface WorkspaceLock {
  readonly path: string;
  readonly token: string;
  release(): Promise<void>;
}

interface LockRecord {
  pid: number;
  startedAt: string;
  workspace: string;
  token: string;
}

function lockDirectory(): string {
  return path.join(forgeStateDirectory(), "locks");
}

export function workspaceLockPath(workspace: string): string {
  const digest = createHash("sha256")
    .update(path.resolve(workspace))
    .digest("hex");
  return path.join(lockDirectory(), `${digest}.lock`);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockRecord(lockPath: string): Promise<LockRecord | null> {
  try {
    const value = JSON.parse(
      await fs.readFile(lockPath, "utf8"),
    ) as Partial<LockRecord>;
    if (
      typeof value.pid !== "number" ||
      typeof value.startedAt !== "string" ||
      typeof value.workspace !== "string" ||
      typeof value.token !== "string"
    )
      return null;
    return {
      pid: value.pid,
      startedAt: value.startedAt,
      workspace: value.workspace,
      token: value.token,
    };
  } catch {
    return null;
  }
}

async function isStale(lockPath: string): Promise<boolean> {
  const record = await readLockRecord(lockPath);
  if (record) {
    if (processIsAlive(record.pid)) return false;
    return true;
  }
  const stat = await fs.stat(lockPath).catch(() => null);
  return Boolean(stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS);
}

export async function acquireWorkspaceLock(
  workspace: string,
): Promise<WorkspaceLock> {
  const lockPath = workspaceLockPath(workspace);
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const record: LockRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    workspace: path.resolve(workspace),
    token,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record), "utf8");
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        token,
        release: async (): Promise<void> => {
          const current = await readLockRecord(lockPath);
          if (current?.token !== token) return;
          await fs.unlink(lockPath).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await readLockRecord(lockPath);
      if (current && processIsAlive(current.pid))
        throw new WorkspaceLockError(
          `Workspace is already locked by active Forge process ${current.pid}`,
        );
      if (!(await isStale(lockPath)))
        throw new WorkspaceLockError(
          "Workspace is already locked by another Forge process",
        );
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }
  throw new WorkspaceLockError("Workspace lock could not be acquired safely");
}
