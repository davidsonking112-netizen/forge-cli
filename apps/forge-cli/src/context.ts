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

export interface RepositoryContext {
  root: string;
  projectType: string;
  packageManager: string | null;
  instructions: string | null;
  files: ContextFile[];
  relevantFiles: ContextFile[];
  verificationCommands: string[][];
  changedFiles: string[];
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

async function collect(root: string): Promise<ContextFile[]> {
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
      if (files.length >= 2000) return;
    }
  };
  await visit(root);
  return files;
}

async function detectChangedFiles(root: string): Promise<string[]> {
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
      .slice(0, 200);
  } catch {
    return [];
  }
}

async function readInstructions(root: string): Promise<string | null> {
  const file = path.join(root, "FORGE.md");
  const content = await fs.readFile(file, "utf8").catch(() => null);
  return content ? content.slice(0, 12_000) : null;
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
): Promise<RepositoryContext> {
  const files = await collect(root);
  const terms = prompt
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .filter(Boolean);
  const changedFiles = await detectChangedFiles(root);
  const changedFileSet = new Set(changedFiles);
  const relevantFiles: ContextFile[] = [];
  for (const file of [...files]
    .sort(
      (a, b) =>
        score(b.path, terms, changedFileSet) -
          score(a.path, terms, changedFileSet) || a.path.localeCompare(b.path),
    )
    .slice(0, 16)) {
    if (file.bytes > 200_000) continue;
    const content = await fs
      .readFile(path.join(root, file.path), "utf8")
      .catch(() => null);
    if (content === null || !isText(Buffer.from(content))) continue;
    relevantFiles.push({
      ...file,
      content:
        content.slice(0, 24_000) +
        (content.length > 24_000 ? "\n...[truncated]" : ""),
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
    instructions: await readInstructions(root),
    files,
    relevantFiles,
    verificationCommands: await detectVerificationCommands(root, files),
    changedFiles,
  };
}
