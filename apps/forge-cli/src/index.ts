import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildRepositoryContext, type RepositoryContext } from "./context.js";

const MAX_INDEX_BYTES = 1_000_000;
const MAX_INDEX_FILES = 2_000;

export interface RepositoryIndexEntry {
  path: string;
  bytes: number;
  symbols: string[];
  indexedAt: string;
}

export interface RepositoryIndex {
  version: 1;
  root: string;
  createdAt: string;
  updatedAt: string;
  files: RepositoryIndexEntry[];
}

function stateDirectory(): string {
  return path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    "forge",
    "indexes",
  );
}

function indexPath(root: string): string {
  const key = createHash("sha256").update(path.resolve(root)).digest("hex");
  return path.join(stateDirectory(), `${key}.json`);
}

export async function buildRepositoryIndex(
  root: string,
): Promise<RepositoryIndex> {
  const resolvedRoot = path.resolve(root);
  const context: RepositoryContext = await buildRepositoryContext(
    resolvedRoot,
    "",
  );
  const now = new Date().toISOString();
  const entries: RepositoryIndexEntry[] = context.files
    .slice(0, MAX_INDEX_FILES)
    .map((file) => {
      const relevant = context.relevantFiles.find(
        (candidate) => candidate.path === file.path,
      );
      return {
        path: file.path,
        bytes: file.bytes,
        symbols: relevant?.symbols?.slice(0, 80) ?? [],
        indexedAt: now,
      };
    });
  const existing = await readRepositoryIndex(resolvedRoot).catch(() => null);
  const index: RepositoryIndex = {
    version: 1,
    root: resolvedRoot,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    files: entries,
  };
  const serialized = JSON.stringify(index, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_INDEX_BYTES)
    throw new Error("Repository index exceeds the local size limit");
  await fs.mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  await fs.writeFile(indexPath(resolvedRoot), serialized, { mode: 0o600 });
  return index;
}

export async function readRepositoryIndex(
  root: string,
): Promise<RepositoryIndex> {
  const content = await fs.readFile(indexPath(path.resolve(root)), "utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_INDEX_BYTES)
    throw new Error("Repository index exceeds the local size limit");
  const parsed = JSON.parse(content) as RepositoryIndex;
  if (
    parsed.version !== 1 ||
    parsed.root !== path.resolve(root) ||
    !Array.isArray(parsed.files) ||
    parsed.files.length > MAX_INDEX_FILES
  )
    throw new Error("Invalid repository index");
  return parsed;
}

export async function clearRepositoryIndex(root: string): Promise<void> {
  await fs.rm(indexPath(path.resolve(root)), { force: true });
}
