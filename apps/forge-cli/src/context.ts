import { promises as fs } from "node:fs";
import path from "node:path";

export interface ContextFile {
  path: string;
  bytes: number;
  content?: string;
}

export interface RepositoryContext {
  root: string;
  projectType: string;
  packageManager: string | null;
  instructions: string | null;
  files: ContextFile[];
  relevantFiles: ContextFile[];
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

function score(filePath: string, terms: string[]): number {
  const lower = filePath.toLowerCase();
  let value = priorityNames.includes(path.basename(lower)) ? 10 : 0;
  if (lower.includes("test") || lower.includes("spec")) value += 3;
  for (const term of terms)
    if (term.length > 2 && lower.includes(term)) value += 5;
  return value;
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
        files.push({ path: relative, bytes: stat.size });
      }
      if (files.length >= 2000) return;
    }
  };
  await visit(root);
  return files;
}

async function readInstructions(root: string): Promise<string | null> {
  const file = path.join(root, "FORGE.md");
  const content = await fs.readFile(file, "utf8").catch(() => null);
  return content ? content.slice(0, 12_000) : null;
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
  const relevantFiles: ContextFile[] = [];
  for (const file of [...files]
    .sort(
      (a, b) =>
        score(b.path, terms) - score(a.path, terms) ||
        a.path.localeCompare(b.path),
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
  };
}
