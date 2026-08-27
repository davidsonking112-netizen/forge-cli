import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { redactValue } from "./redaction.js";
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
  maxArchitectureModules?: number;
  maxAcceptanceItems?: number;
  maxSymbolSlices?: number;
  maxFailureItems?: number;
  maxAttemptItems?: number;
}

export interface ContextStats {
  scannedFiles: number;
  candidateFiles: number;
  includedFiles: number;
  includedChars: number;
  prunedFiles: number;
  truncatedFiles: number;
}

export interface ProjectContract {
  language: string;
  packageManager: string | null;
  framework: string | null;
  instructionsFile: string | null;
  scripts: Record<string, string>;
  testCommands: string[][];
  buildCommands: string[][];
  entrypoints: string[];
}

export interface ArchitectureModule {
  path: string;
  directory: string;
  symbols: string[];
  imports: string[];
  exports: string[];
  routes: string[];
  stateStores: string[];
  dataFlow: string[];
}

export interface ArchitectureMap {
  directories: string[];
  modules: ArchitectureModule[];
  edges: Array<{
    from: string;
    to: string;
    kind: "import" | "route" | "data-flow";
  }>;
}

export interface AcceptanceMapping {
  id: string;
  requirement: string;
  files: string[];
  tests: string[];
  reasons: string[];
}

export interface SymbolSlice {
  path: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ContextFailure {
  tool: string;
  command?: string;
  exitCode?: number | null;
  output: string;
  changedFiles: string[];
}

export interface ContextAttempt {
  strategy: string;
  reason: string;
  outcome: "failed" | "blocked" | "succeeded" | "exhausted";
}

export interface HierarchicalContextPack {
  projectContract: ProjectContract;
  architectureMap: ArchitectureMap;
  acceptanceMap: AcceptanceMapping[];
  symbolSlices: SymbolSlice[];
  failureContext: ContextFailure[];
  attemptHistory: ContextAttempt[];
}

export const DEFAULT_CONTEXT_BUDGET: Readonly<ContextBudget> = {
  maxFiles: 2_000,
  maxRelevantFiles: 16,
  maxFileChars: 24_000,
  maxTotalChars: 100_000,
  maxInstructionsChars: 12_000,
  maxChangedFiles: 200,
  maxArchitectureModules: 64,
  maxAcceptanceItems: 16,
  maxSymbolSlices: 64,
  maxFailureItems: 8,
  maxAttemptItems: 8,
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
  contextPack: HierarchicalContextPack;
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
    maxArchitectureModules: Math.max(
      1,
      Math.min(64, Math.trunc(budget.maxArchitectureModules ?? 64)),
    ),
    maxAcceptanceItems: Math.max(
      1,
      Math.min(32, Math.trunc(budget.maxAcceptanceItems ?? 16)),
    ),
    maxSymbolSlices: Math.max(
      1,
      Math.min(128, Math.trunc(budget.maxSymbolSlices ?? 64)),
    ),
    maxFailureItems: Math.max(
      1,
      Math.min(16, Math.trunc(budget.maxFailureItems ?? 8)),
    ),
    maxAttemptItems: Math.max(
      1,
      Math.min(16, Math.trunc(budget.maxAttemptItems ?? 8)),
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

export interface ContextBuildOptions {
  failureContext?: ContextFailure[];
  attemptHistory?: ContextAttempt[];
  acceptanceRequirements?: string[];
}

async function readBoundedText(
  root: string,
  filePath: string,
  maxChars: number,
): Promise<string> {
  return (
    await fs.readFile(path.join(root, filePath), "utf8").catch(() => "")
  ).slice(0, maxChars);
}

function detectLanguage(projectType: string, files: ContextFile[]): string {
  if (projectType !== "mixed-or-unknown") return projectType;
  if (files.some((file) => /\.(ts|tsx)$/.test(file.path))) return "typescript";
  if (files.some((file) => /\.(js|jsx)$/.test(file.path))) return "javascript";
  if (files.some((file) => /\.py$/.test(file.path))) return "python";
  return "unknown";
}

function detectFramework(
  packageJson: Record<string, unknown> | null,
): string | null {
  const dependencies = {
    ...(typeof packageJson?.dependencies === "object" &&
    packageJson.dependencies
      ? (packageJson.dependencies as Record<string, unknown>)
      : {}),
    ...(typeof packageJson?.devDependencies === "object" &&
    packageJson.devDependencies
      ? (packageJson.devDependencies as Record<string, unknown>)
      : {}),
  };
  const candidates = [
    "next",
    "react",
    "vue",
    "svelte",
    "angular",
    "express",
    "fastify",
    "nestjs",
    "vite",
  ];
  return candidates.find((name) => Object.hasOwn(dependencies, name)) ?? null;
}

async function buildProjectContract(
  root: string,
  files: ContextFile[],
  projectType: string,
  packageManager: string | null,
  verificationCommands: string[][],
  instructions: string | null,
): Promise<ProjectContract> {
  const rawPackage = await readBoundedText(root, "package.json", 50_000);
  let packageJson: Record<string, unknown> | null = null;
  try {
    packageJson = rawPackage
      ? (JSON.parse(rawPackage) as Record<string, unknown>)
      : null;
  } catch {
    packageJson = null;
  }
  const scripts =
    packageJson?.scripts && typeof packageJson.scripts === "object"
      ? Object.fromEntries(
          Object.entries(packageJson.scripts as Record<string, unknown>)
            .filter(([, value]) => typeof value === "string")
            .slice(0, 32) as Array<[string, string]>,
        )
      : {};
  const testCommands = verificationCommands
    .filter((command) =>
      /test|check|verify|pytest|vitest|jest/i.test(command.join(" ")),
    )
    .slice(0, 8);
  const buildCommands = verificationCommands
    .filter((command) =>
      /build|typecheck|compile|lint|format/i.test(command.join(" ")),
    )
    .slice(0, 8);
  const entrypoints = files
    .filter((file) =>
      /(^|\/)(main|index|app|server|cli)\.(ts|tsx|js|jsx|py|go|rs)$|(^|\/)src\/main\./i.test(
        file.path,
      ),
    )
    .map((file) => file.path)
    .slice(0, 16);
  return {
    language: detectLanguage(projectType, files),
    packageManager,
    framework: detectFramework(packageJson),
    instructionsFile: instructions ? "FORGE.md" : null,
    scripts,
    testCommands,
    buildCommands,
    entrypoints,
  };
}

function importExportSummary(content: string): {
  imports: string[];
  exports: string[];
} {
  const imports = [
    ...content.matchAll(
      /(?:import\s+(?:[^"']+\s+from\s+)?|require\()?['"]([^'"]+)['"]/g,
    ),
  ]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value))
    .slice(0, 24);
  const exports = [
    ...content.matchAll(
      /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+([A-Za-z_$][\w$]*)/g,
    ),
  ]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value))
    .slice(0, 24);
  return { imports, exports };
}

function buildArchitectureMap(
  files: ContextFile[],
  maxModules: number,
): ArchitectureMap {
  const sourceFiles = files
    .filter(
      (file) =>
        file.content !== undefined &&
        /\.(ts|tsx|js|jsx|py|go|rs|java|rb)$/.test(file.path),
    )
    .slice(0, maxModules);
  const modules: ArchitectureModule[] = sourceFiles.map((file) => {
    const content = file.content ?? "";
    const { imports, exports } = importExportSummary(content);
    const routes = [
      ...content.matchAll(
        /(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)/gi,
      ),
    ]
      .map((match) => `${(match[1] ?? "").toUpperCase()} ${match[2] ?? ""}`)
      .slice(0, 24);
    const stateStores = [
      ...content.matchAll(
        /(?:useState|createSlice|configureStore|zustand|redux|mobx|store)\b/gi,
      ),
    ]
      .map((match) => match[0])
      .slice(0, 16);
    const dataFlow = [
      ...content.matchAll(
        /(?:fetch|axios|request|localStorage|sessionStorage|database|prisma|drizzle)\b/gi,
      ),
    ]
      .map((match) => match[0])
      .slice(0, 16);
    return {
      path: file.path,
      directory: path.dirname(file.path),
      symbols: file.symbols ?? extractSymbols(content),
      imports,
      exports,
      routes,
      stateStores: [...new Set(stateStores)],
      dataFlow: [...new Set(dataFlow)],
    };
  });
  const edges: ArchitectureMap["edges"] = [];
  for (const module of modules) {
    for (const imported of module.imports)
      edges.push({ from: module.path, to: imported, kind: "import" });
    for (const route of module.routes)
      edges.push({ from: module.path, to: route, kind: "route" });
    for (const flow of module.dataFlow)
      edges.push({ from: module.path, to: flow, kind: "data-flow" });
  }
  return {
    directories: [
      ...new Set(files.map((file) => path.dirname(file.path))),
    ].slice(0, 128),
    modules,
    edges: edges.slice(0, 256),
  };
}

function buildSymbolSlices(
  files: ContextFile[],
  prompt: string,
  maxSlices: number,
  maxChars: number,
): SymbolSlice[] {
  const terms = prompt
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((term) => term.length > 2);
  const slices: SymbolSlice[] = [];
  for (const file of files) {
    const content = file.content ?? "";
    const lines = content.split(/\r?\n/);
    const matches = [
      ...content.matchAll(
        /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|def|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
      ),
    ];
    for (const match of matches) {
      const symbol = match[1];
      if (!symbol) continue;
      const lowerSymbol = symbol.toLowerCase();
      const relevant =
        terms.some((term) => lowerSymbol.includes(term)) ||
        file.reasons?.some((reason) => reason.includes("prompt match")) ||
        file.reasons?.includes("changed file");
      if (!relevant) continue;
      const startLine = content
        .slice(0, match.index ?? 0)
        .split(/\r?\n/).length;
      const endLine = Math.min(lines.length, startLine + 80);
      slices.push({
        path: file.path,
        symbol,
        kind: match[0].includes("class")
          ? "class"
          : match[0].includes("interface")
            ? "interface"
            : match[0].includes("type")
              ? "type"
              : "symbol",
        startLine,
        endLine,
        content: lines
          .slice(startLine - 1, endLine)
          .join("\n")
          .slice(0, maxChars),
      });
      if (slices.length >= maxSlices) return slices;
    }
  }
  return slices;
}

function buildAcceptanceMap(
  prompt: string,
  files: ContextFile[],
  maxItems: number,
): AcceptanceMapping[] {
  const requirements = prompt
    .split(/(?:\r?\n|[.!?])+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 8)
    .slice(0, maxItems);
  return requirements.map((requirement, index) => {
    const terms = requirement
      .toLowerCase()
      .split(/[^a-z0-9_$]+/)
      .filter((term) => term.length > 2);
    const matches = files
      .map((file) => {
        const haystack =
          `${file.path} ${file.content ?? ""} ${(file.symbols ?? []).join(" ")}`.toLowerCase();
        return {
          file,
          score: terms.reduce(
            (score, term) => score + (haystack.includes(term) ? 1 : 0),
            0,
          ),
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path),
      )
      .slice(0, 8);
    return {
      id: `acceptance-${index + 1}`,
      requirement,
      files: matches.map((match) => match.file.path),
      tests: matches
        .filter((match) => /test|spec/i.test(match.file.path))
        .map((match) => match.file.path),
      reasons: matches
        .map(
          (match) =>
            `${match.file.path} matches ${match.score} requirement term(s)`,
        )
        .slice(0, 8),
    };
  });
}

export async function buildRepositoryContext(
  root: string,
  prompt: string,
  requestedBudget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
  options: ContextBuildOptions = {},
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
  const instructions = await readInstructions(
    root,
    budget.maxInstructionsChars,
  );
  const verificationCommands = await detectVerificationCommands(root, files);
  const contextPack: HierarchicalContextPack = {
    projectContract: await buildProjectContract(
      root,
      files,
      projectType,
      packageManager,
      verificationCommands,
      instructions,
    ),
    architectureMap: buildArchitectureMap(
      [
        ...files.map(
          (file) =>
            relevantFiles.find((candidate) => candidate.path === file.path) ??
            file,
        ),
      ],
      budget.maxArchitectureModules ?? 64,
    ),
    acceptanceMap: buildAcceptanceMap(
      (options.acceptanceRequirements ?? [prompt]).join("\n"),
      relevantFiles,
      budget.maxAcceptanceItems ?? 16,
    ),
    symbolSlices: buildSymbolSlices(
      relevantFiles,
      prompt,
      budget.maxSymbolSlices ?? 64,
      Math.min(12_000, budget.maxFileChars),
    ),
    failureContext: (options.failureContext ?? [])
      .slice(0, budget.maxFailureItems ?? 8)
      .map((failure) => ({
        ...failure,
        tool: failure.tool.slice(0, 100),
        ...(failure.command
          ? { command: String(redactValue(failure.command)).slice(0, 500) }
          : {}),
        output: String(redactValue(failure.output)).slice(0, 20_000),
        changedFiles: failure.changedFiles.slice(0, budget.maxChangedFiles),
      })),
    attemptHistory: (options.attemptHistory ?? [])
      .slice(0, budget.maxAttemptItems ?? 8)
      .map((attempt) => ({
        strategy: attempt.strategy.slice(0, 100),
        reason: String(redactValue(attempt.reason)).slice(0, 1_000),
        outcome: attempt.outcome,
      })),
  };
  return {
    root,
    projectType,
    packageManager,
    instructions,
    files,
    relevantFiles,
    verificationCommands,
    changedFiles,
    contextPack,
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
