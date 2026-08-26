import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildRepositoryContext, type RepositoryContext } from "./context.js";

const MAX_INDEX_BYTES = 1_000_000;
const MAX_INDEX_FILES = 2_000;

export interface RepositoryIndexEntry {
  path: string;
  bytes: number;
  signature: string;
  symbols: string[];
  indexedAt: string;
}

export type RepositoryRelationshipKind =
  "dependency" | "test" | "configuration";

export interface RepositoryRelationship {
  from: string;
  to: string;
  kind: RepositoryRelationshipKind;
}

export interface RepositoryIndex {
  version: 1 | 2 | 3;
  root: string;
  createdAt: string;
  updatedAt: string;
  files: RepositoryIndexEntry[];
  relationships: RepositoryRelationship[];
  scan: {
    reused: number;
    refreshed: number;
    removed: number;
  };
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

function normalizeRelative(value: string): string | null {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.startsWith("/")
  )
    return null;
  return normalized;
}

function buildRelationships(
  context: RepositoryContext,
  entries: RepositoryIndexEntry[],
): RepositoryRelationship[] {
  const paths = new Set(entries.map((entry) => entry.path));
  const relationships = new Map<string, RepositoryRelationship>();
  const add = (from: string, to: string, kind: RepositoryRelationshipKind) => {
    if (from === to || !paths.has(from) || !paths.has(to)) return;
    const relationship = { from, to, kind };
    relationships.set(`${from}\u0000${to}\u0000${kind}`, relationship);
  };
  const candidates = (from: string, raw: string): string[] => {
    const base = normalizeRelative(
      path.posix.join(path.posix.dirname(from), raw),
    );
    if (!base) return [];
    return [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.py`,
      `${base}/index.ts`,
      `${base}/index.js`,
      `${base}/__init__.py`,
    ];
  };
  for (const file of context.relevantFiles.slice(0, 16)) {
    const content = file.content ?? "";
    for (const match of content.matchAll(
      /(?:from|import|require)\s*[('\"]([^'\")]+)[ '\"]/g,
    )) {
      const raw = match[1];
      if (!raw?.startsWith(".")) continue;
      const target = candidates(file.path, raw).find((candidate) =>
        paths.has(candidate),
      );
      if (target) add(file.path, target, "dependency");
    }
  }
  for (const file of entries) {
    const lower = file.path.toLowerCase();
    if (!/(test|spec)/.test(path.posix.basename(lower))) continue;
    const testStem = path.posix
      .basename(lower)
      .replace(/\.(test|spec)(?=\.)/, "");
    for (const candidate of entries) {
      const candidateStem = path.posix.basename(candidate.path.toLowerCase());
      if (
        candidate.path !== file.path &&
        candidateStem === testStem &&
        !/(test|spec)/.test(candidateStem)
      )
        add(file.path, candidate.path, "test");
    }
  }
  const configPairs: Record<string, string[]> = {
    "package.json": ["package-lock.json", "npm-shrinkwrap.json"],
    "pyproject.toml": ["requirements.txt", "pytest.ini", "setup.cfg"],
    "tsconfig.json": ["package.json"],
    "cargo.toml": ["cargo.lock"],
    "go.mod": ["go.sum"],
  };
  for (const [config, neighbors] of Object.entries(configPairs)) {
    if (!paths.has(config)) continue;
    for (const neighbor of neighbors)
      if (paths.has(neighbor)) add(config, neighbor, "configuration");
  }
  return [...relationships.values()].slice(0, 600);
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
  const existing = await readRepositoryIndex(resolvedRoot).catch(() => null);
  const previous = new Map(
    existing?.files.map((entry) => [entry.path, entry]) ?? [],
  );
  const entries: RepositoryIndexEntry[] = [];
  let reused = 0;
  let refreshed = 0;
  for (const file of context.files.slice(0, MAX_INDEX_FILES)) {
    const stat = await fs
      .stat(path.join(resolvedRoot, file.path))
      .catch(() => null);
    if (!stat?.isFile()) continue;
    const signature = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    const old = previous.get(file.path);
    const relevant = context.relevantFiles.find(
      (candidate) => candidate.path === file.path,
    );
    const unchanged = old?.signature === signature && old.bytes === stat.size;
    if (unchanged) reused += 1;
    else refreshed += 1;
    entries.push({
      path: file.path,
      bytes: stat.size,
      signature,
      symbols: unchanged
        ? old.symbols.slice(0, 80)
        : (relevant?.symbols?.slice(0, 80) ?? []),
      indexedAt: unchanged ? old.indexedAt : now,
    });
  }
  const currentPaths = new Set(entries.map((entry) => entry.path));
  const removed = [...previous.keys()].filter(
    (filePath) => !currentPaths.has(filePath),
  ).length;
  const index: RepositoryIndex = {
    version: 3,
    root: resolvedRoot,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    files: entries,
    relationships: buildRelationships(context, entries),
    scan: { reused, refreshed, removed },
  };
  const serialized = JSON.stringify(index, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_INDEX_BYTES)
    throw new Error("Repository index exceeds the local size limit");
  await fs.mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  const target = indexPath(resolvedRoot);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, serialized, { mode: 0o600 });
  await fs.rename(temporary, target).catch(async (error) => {
    await fs.rm(temporary, { force: true });
    throw error;
  });
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
    (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) ||
    parsed.root !== path.resolve(root) ||
    !Array.isArray(parsed.files) ||
    parsed.files.length > MAX_INDEX_FILES
  )
    throw new Error("Invalid repository index");
  return {
    ...parsed,
    version: parsed.version,
    relationships: Array.isArray(parsed.relationships)
      ? parsed.relationships
          .slice(0, 600)
          .filter(
            (relationship) =>
              typeof relationship?.from === "string" &&
              typeof relationship?.to === "string" &&
              ["dependency", "test", "configuration"].includes(
                relationship.kind,
              ),
          )
      : [],
    scan: parsed.scan ?? {
      reused: 0,
      refreshed: parsed.files.length,
      removed: 0,
    },
    files: parsed.files
      .map((entry) => ({
        path: entry.path,
        bytes: entry.bytes,
        signature: entry.signature ?? `${entry.bytes}:legacy`,
        symbols: Array.isArray(entry.symbols) ? entry.symbols.slice(0, 80) : [],
        indexedAt: entry.indexedAt,
      }))
      .filter(
        (entry) =>
          typeof entry.path === "string" &&
          entry.path.length <= 500 &&
          !entry.path.startsWith("/") &&
          !entry.path
            .split(/[\\/]+/)
            .some((part) => part === ".." || part === "") &&
          Number.isSafeInteger(entry.bytes) &&
          entry.bytes >= 0 &&
          entry.bytes <= 100_000_000 &&
          Array.isArray(entry.symbols),
      ),
  };
}

export function queryRepositoryIndex(
  index: RepositoryIndex,
  query: string,
  limit = 80,
): {
  entries: RepositoryIndexEntry[];
  relationships: RepositoryRelationship[];
} {
  const term = query.trim().toLowerCase();
  if (!term) throw new Error("Index query is required");
  const boundedLimit = Math.max(1, Math.min(80, Math.trunc(limit)));
  const entries = index.files
    .filter(
      (entry) =>
        entry.path.toLowerCase().includes(term) ||
        entry.symbols.some((symbol) => symbol.toLowerCase().includes(term)),
    )
    .slice(0, boundedLimit);
  const paths = new Set(entries.map((entry) => entry.path));
  const relationships = index.relationships
    .filter(
      (relationship) =>
        paths.has(relationship.from) || paths.has(relationship.to),
    )
    .slice(0, boundedLimit * 4);
  return { entries, relationships };
}

export async function clearRepositoryIndex(root: string): Promise<void> {
  await fs.rm(indexPath(path.resolve(root)), { force: true });
}
