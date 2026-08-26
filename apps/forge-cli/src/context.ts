import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ContextFile {
  path: string;
  bytes: number;
  mtimeMs?: number;
  content?: string;
  symbols?: string[];
  reasons?: string[];
}

export interface ContextBudget {
  maxFiles: number;
  maxRelevantFiles: number;
  maxFileChars: number;
  maxTotalChars: number;
  maxInstructionsChars: number;
  maxChangedFiles: number;
}

export interface ContextStats {
  scannedFiles: number;
  candidateFiles: number;
  includedFiles: number;
  includedChars: number;
  prunedFiles: number;
  truncatedFiles: number;
}

export const DEFAULT_CONTEXT_BUDGET: Readonly<ContextBudget> = {
  maxFiles: 2_000,
  maxRelevantFiles: 16,
  maxFileChars: 24_000,
  maxTotalChars: 100_000,
  maxInstructionsChars: 12_000,
  maxChangedFiles: 200,
};

export interface RepositoryContext {
  root: string;
  projectType: string;
  packageManager: string | null;
  instructions: string | null;
  files: ContextFile[];
  relevantFiles: ContextFile[];
  verificationCommands: string[][];
  changedFiles: string[];
  stats: ContextStats;
}

export function fingerprintRepositoryContext(
  context: RepositoryContext,
): string {
  const hash = createHash("sha256");
  hash.update(context.root);
  hash.update(
    JSON.stringify(
      context.files.map(({ path: filePath, bytes, mtimeMs }) => ({
        path: filePath,
        bytes,
        mtimeMs,
      })),
    ),
  );
  hash.update(JSON.stringify(context.changedFiles));
  hash.update(
    JSON.stringify(
      context.relevantFiles.map(({ path: filePath, bytes, content }) => ({
        path: filePath,
        bytes,
        content: content ?? "",
      })),
    ),
  );
  return hash.digest("hex");
}

const ignored = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".pytest_cache",
]);

const priorityNames = [
  "readme.md",
  "package.json",
  "pyproject.toml",
  "tsconfig.json",
  "cargo.toml",
  "go.mod",
  "makefile",
];

function isText(buffer: Buffer): boolean {
  return !buffer.includes(0);
}

function extractSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /(?:export\s+)?(?:async\s+)?(?:function|class|interface|type)\s+([A-Za-z_$][\w$]*)/g,
    /(?:def|class)\s+([A-Za-z_][\w]*)/g,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern))
      if (match[1]) symbols.add(match[1]);
  }
  return [...symbols].slice(0, 80);
}

function score(
  filePath: string,
  terms: string[],
  changedFiles: Set<string>,
): number {
  return selectionReasons(filePath, terms, changedFiles).reduce(
    (total, reason) => total + reason.weight,
    0,
  );
}

function selectionReasons(
  filePath: string,
  terms: string[],
  changedFiles: Set<string>,
): Array<{ label: string; weight: number }> {
  const lower = filePath.toLowerCase();
  const reasons: Array<{ label: string; weight: number }> = [];
  if (priorityNames.includes(path.basename(lower)))
    reasons.push({ label: "project metadata", weight: 10 });
  if (changedFiles.has(filePath))
    reasons.push({ label: "changed file", weight: 20 });
  if (lower.includes("test") || lower.includes("spec"))
    reasons.push({ label: "test-like path", weight: 3 });
  for (const term of terms)
    if (term.length > 2 && lower.includes(term))
      reasons.push({ label: `prompt match: ${term}`, weight: 5 });
  return reasons;
}

function normalizeBudget(budget: ContextBudget): ContextBudget {
  return {
    maxFiles: Math.max(1, Math.min(2_000, Math.trunc(budget.maxFiles))),
    maxRelevantFiles: Math.max(
      1,
      Math.min(64, Math.trunc(budget.maxRelevantFiles)),
    ),
    maxFileChars: Math.max(
      1_000,
      Math.min(50_000, Math.trunc(budget.maxFileChars)),
    ),
    maxTotalChars: Math.max(
      8_000,
      Math.min(500_000, Math.trunc(budget.maxTotalChars)),
    ),
    maxInstructionsChars: Math.max(
      1_000,
      Math.min(20_000, Math.trunc(budget.maxInstructionsChars)),
    ),
    maxChangedFiles: Math.max(
      1,
      Math.min(200, Math.trunc(budget.maxChangedFiles)),
    ),
  };
}

async function collect(root: string, maxFiles: number): Promise<ContextFile[]> {
  const ignoreContent = await fs
    .readFile(path.join(root, ".gitignore"), "utf8")
    .catch(() => "");
  const ignorePatterns = ignoreContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const ignoredByProject = (relative: string): boolean =>
    ignorePatterns.some((pattern) => {
      if (pattern.startsWith("!")) return false;
      const normalized = pattern.replace(/\\/g, "/");
      const escaped = normalized
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\*\\\*/g, ".*")
        .replace(/\\\*/g, "[^/]*");
      const expression = pattern.endsWith("/")
        ? `(^|/)${escaped}`
        : `(^|/)${escaped}$`;
      return new RegExp(expression).test(relative);
    });
  const files: ContextFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (
        relative === "FORGE.md" ||
        relative.startsWith(".env") ||
        ignoredByProject(relative)
      )
        continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        files.push({
          path: relative,
          bytes: stat.size,
          mtimeMs: Math.trunc(stat.mtimeMs),
        });
      }
      if (files.length >= maxFiles) return;
    }
  };
  await visit(root);
  return files;
}

async function detectChangedFiles(
  root: string,
  maxChangedFiles: number,
): Promise<string[]> {
  try {
    const result = await execFileAsync(
      "git",
      ["diff", "--name-only", "--", "."],
      {
        cwd: root,
        timeout: 5_000,
        maxBuffer: 100_000,
      },
    );
    return result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim().replaceAll("\\", "/"))
      .filter(
        (value) => value && !value.startsWith("../") && !path.isAbsolute(value),
      )
      .slice(0, maxChangedFiles);
  } catch {
    return [];
  }
}

async function readInstructions(
  root: string,
  maxChars: number,
): Promise<string | null> {
  const file = path.join(root, "FORGE.md");
  const content = await fs.readFile(file, "utf8").catch(() => null);
  return content ? content.slice(0, maxChars) : null;
}

async function detectVerificationCommands(
  root: string,
  files: ContextFile[],
): Promise<string[][]> {
  const commands: string[][] = [];
  const packageJson = await fs
    .readFile(path.join(root, "package.json"), "utf8")
    .catch(() => null);
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as {
        scripts?: Record<string, unknown>;
      };
      for (const name of ["test", "lint", "format", "build", "typecheck"]) {
        if (typeof parsed.scripts?.[name] === "string")
          commands.push(["npm", "run", name]);
      }
    } catch {
      // Invalid project metadata is context data, not a reason to fail a Forge session.
    }
  }
  if (
    files.some(
      (file) => file.path.startsWith("tests/") || file.path.startsWith("test/"),
    )
  )
    commands.push(["python", "-m", "pytest"]);
  return commands.slice(0, 8);
}

export async function buildRepositoryContext(
  root: string,
  prompt: string,
  requestedBudget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): Promise<RepositoryContext> {
  const budget = normalizeBudget(requestedBudget);
  const files = await collect(root, budget.maxFiles);
  const terms = prompt
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .filter(Boolean);
  const changedFiles = await detectChangedFiles(root, budget.maxChangedFiles);
  const changedFileSet = new Set(changedFiles);
  const relevantFiles: ContextFile[] = [];
  let includedChars = 0;
  let truncatedFiles = 0;
  const candidates = [...files]
    .sort(
      (a, b) =>
        score(b.path, terms, changedFileSet) -
          score(a.path, terms, changedFileSet) || a.path.localeCompare(b.path),
    )
    .slice(0, budget.maxRelevantFiles);
  for (const file of candidates) {
    if (file.bytes > 200_000) continue;
    const content = await fs
      .readFile(path.join(root, file.path), "utf8")
      .catch(() => null);
    if (content === null || !isText(Buffer.from(content))) continue;
    const marker = "\n...[truncated]";
    const remaining = budget.maxTotalChars - includedChars;
    if (remaining <= 0) break;
    const limit = Math.min(budget.maxFileChars, remaining);
    const wasTruncated = content.length > limit;
    const visible = wasTruncated
      ? content.slice(0, Math.max(0, limit - marker.length)) + marker
      : content;
    includedChars += visible.length;
    if (wasTruncated) truncatedFiles += 1;
    relevantFiles.push({
      ...file,
      content: visible,
      symbols: extractSymbols(content),
      reasons: selectionReasons(file.path, terms, changedFileSet).map(
        (reason) => reason.label,
      ),
    });
  }
  const has = (name: string) =>
    files.some((file) => path.basename(file.path).toLowerCase() === name);
  const projectType = has("package.json")
    ? "node"
    : has("pyproject.toml")
      ? "python"
      : has("cargo.toml")
        ? "rust"
        : has("go.mod")
          ? "go"
          : "mixed-or-unknown";
  const packageManager = has("pnpm-lock.yaml")
    ? "pnpm"
    : has("yarn.lock")
      ? "yarn"
      : has("package-lock.json")
        ? "npm"
        : has("uv.lock")
          ? "uv"
          : has("poetry.lock")
            ? "poetry"
            : null;
  return {
    root,
    projectType,
    packageManager,
    instructions: await readInstructions(root, budget.maxInstructionsChars),
    files,
    relevantFiles,
    verificationCommands: await detectVerificationCommands(root, files),
    changedFiles,
    stats: {
      scannedFiles: files.length,
      candidateFiles: candidates.length,
      includedFiles: relevantFiles.length,
      includedChars,
      prunedFiles: Math.max(0, files.length - relevantFiles.length),
      truncatedFiles,
    },
  };
}
