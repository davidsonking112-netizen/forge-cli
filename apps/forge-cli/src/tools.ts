import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, lstatSync, promises as fs } from "node:fs";
import path from "node:path";
import type {
  RiskClass,
  ToolName,
} from "../../../packages/protocol/src/index.js";
import { applyUnifiedFilePatch, parseUnifiedDiff } from "./diff.js";
import { forgeStateDirectory } from "./paths.js";

export interface ToolResult {
  ok: boolean;
  output?: unknown;
  error?: { code: string; message: string; retryable: boolean };
  durationMs: number;
}

export interface ToolRequest {
  tool: ToolName;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ToolMetadata {
  risk: RiskClass;
  description: string;
}

export interface UnifiedDiffPreviewFile {
  path: string;
  selected: boolean;
  action: "create" | "modify" | "delete" | "rename";
  currentSha256: string | null;
  bytesBefore: number;
  bytesAfter: number | null;
  conflict: string | null;
}

export interface UnifiedDiffPreview {
  safeToApply: boolean;
  changeSetDigest: string;
  summary: { files: number; selectedFiles: number; hunks: number };
  files: UnifiedDiffPreviewFile[];
  conflicts: string[];
}

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
]);

function boundedInt(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : NaN;
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

async function writeNoFollow(
  target: string,
  content: string | Uint8Array,
): Promise<void> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(
      target,
      fsConstants.O_WRONLY | fsConstants.O_TRUNC | noFollow,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    handle = await fs.open(
      target,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        noFollow,
      0o600,
    );
  }
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

const sensitiveNames = [
  ".env",
  ".env.local",
  ".env.production",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
  "secrets.json",
];

export const TOOL_METADATA: Record<ToolName, ToolMetadata> = {
  "workspace.list": {
    risk: "read-only",
    description: "List bounded workspace files",
  },
  "workspace.search": {
    risk: "read-only",
    description: "Search bounded workspace text",
  },
  "workspace.read": {
    risk: "read-only",
    description: "Read a bounded workspace file",
  },
  "workspace.diff": {
    risk: "read-only",
    description: "Inspect the current Git diff",
  },
  "workspace.apply_patch": {
    risk: "reversible-write",
    description: "Apply a reviewable file change",
  },
  "workspace.apply_unified_diff": {
    risk: "reversible-write",
    description: "Apply validated unified-diff hunks",
  },
  "process.run": {
    risk: "local-execution",
    description: "Run an approved local process",
  },
  "browser.smoke": {
    risk: "local-execution",
    description: "Run a bounded local static-server browser smoke check",
  },
  "git.status": { risk: "read-only", description: "Inspect Git status" },
  "git.branch": {
    risk: "reversible-write",
    description: "Create a local Git branch",
  },
  "git.stage": {
    risk: "reversible-write",
    description: "Stage approved workspace paths",
  },
  "git.commit": {
    risk: "destructive",
    description: "Create a local Git commit",
  },
};

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "CI",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
  ];
  const environment: NodeJS.ProcessEnv = { CI: "1" };
  for (const key of allowed)
    if (process.env[key]) environment[key] = process.env[key];
  for (const key of Object.keys(process.env))
    if (key.startsWith("LC_")) environment[key] = process.env[key];
  return environment;
}

function errorResult(
  code: string,
  message: string,
  retryable = false,
  started = Date.now(),
): ToolResult {
  return {
    ok: false,
    error: { code, message, retryable },
    durationMs: Date.now() - started,
  };
}

export class WorkspaceTools {
  private readonly checkpointRoot: string;

  public constructor(
    public readonly root: string,
    checkpointRoot = path.join(forgeStateDirectory(), "checkpoints"),
  ) {
    this.checkpointRoot = checkpointRoot;
  }

  public async previewUnifiedDiff(
    diff: string,
    selectedPaths?: string[],
  ): Promise<UnifiedDiffPreview> {
    if (typeof diff !== "string")
      throw new Error("Unified diff requires string diff content");
    const patches = parseUnifiedDiff(diff);
    const selection = selectedPaths?.length ? new Set(selectedPaths) : null;
    const files: UnifiedDiffPreviewFile[] = [];
    const conflicts: string[] = [];
    for (const patch of patches) {
      const oldTarget = patch.oldPath ? this.resolveSafe(patch.oldPath) : null;
      const newTarget = patch.newPath ? this.resolveSafe(patch.newPath) : null;
      const displayPath = patch.newPath ?? patch.oldPath;
      const selected =
        selection === null ||
        [patch.oldPath, patch.newPath].some(
          (candidate) => candidate !== null && selection.has(candidate),
        );
      if (!displayPath || (!oldTarget && !newTarget))
        throw new Error("Unified diff has no target path");
      const previous = oldTarget
        ? await fs.readFile(oldTarget, "utf8").catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          })
        : null;
      const destination = newTarget
        ? await fs.readFile(newTarget, "utf8").catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          })
        : null;
      const action: UnifiedDiffPreviewFile["action"] = !patch.newPath
        ? "delete"
        : !patch.oldPath
          ? "create"
          : oldTarget !== newTarget
            ? "rename"
            : "modify";
      let conflict: string | null = null;
      let bytesAfter: number | null = null;
      if (action === "create" && destination !== null)
        conflict = `File already exists: ${displayPath}`;
      else if (
        (action === "modify" || action === "delete") &&
        previous === null
      )
        conflict = `File does not exist: ${displayPath}`;
      else if (action === "rename" && previous === null)
        conflict = `Rename source does not exist: ${patch.oldPath}`;
      else if (action === "rename" && destination !== null)
        conflict = `Rename destination already exists: ${patch.newPath}`;
      else {
        try {
          const next =
            action === "delete"
              ? ""
              : applyUnifiedFilePatch(previous ?? "", patch);
          bytesAfter = Buffer.byteLength(next, "utf8");
        } catch (error) {
          conflict = error instanceof Error ? error.message : String(error);
        }
      }
      if (conflict && selected) conflicts.push(conflict);
      files.push({
        path: displayPath,
        selected,
        action,
        currentSha256: previous
          ? createHash("sha256").update(previous).digest("hex")
          : null,
        bytesBefore: previous ? Buffer.byteLength(previous, "utf8") : 0,
        bytesAfter,
        conflict,
      });
      if (action === "rename")
        files.push({
          path: patch.newPath as string,
          selected,
          action: "rename",
          currentSha256: destination
            ? createHash("sha256").update(destination).digest("hex")
            : null,
          bytesBefore: destination ? Buffer.byteLength(destination, "utf8") : 0,
          bytesAfter: conflict ? null : bytesAfter,
          conflict,
        });
    }
    const changeSetDigest = createHash("sha256")
      .update(diff)
      .update(JSON.stringify(selectedPaths ?? []))
      .update(JSON.stringify(files))
      .digest("hex");
    return {
      safeToApply: conflicts.length === 0,
      changeSetDigest,
      summary: {
        files: patches.length,
        selectedFiles: files.filter((file) => file.selected).length,
        hunks: patches.reduce((count, patch) => count + patch.hunks.length, 0),
      },
      files,
      conflicts,
    };
  }

  public async execute(request: ToolRequest): Promise<ToolResult> {
    const started = Date.now();
    try {
      switch (request.tool) {
        case "workspace.list":
          return {
            ok: true,
            output: await this.list(request.arguments),
            durationMs: Date.now() - started,
          };
        case "workspace.search":
          return {
            ok: true,
            output: await this.search(request.arguments),
            durationMs: Date.now() - started,
          };
        case "workspace.read":
          return {
            ok: true,
            output: await this.read(request.arguments),
            durationMs: Date.now() - started,
          };
        case "workspace.diff":
          return {
            ok: true,
            output: await this.runGit(["diff", "--no-ext-diff", "--", "."]),
            durationMs: Date.now() - started,
          };
        case "git.status": {
          try {
            return {
              ok: true,
              output: await this.runGit(["status", "--short", "--branch"]),
              durationMs: Date.now() - started,
            };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return {
              ok: true,
              output: {
                command: "git status --short --branch",
                unavailable: true,
                reason:
                  "Git is not installed or is not available on PATH; Git-dependent workflows remain unavailable.",
              },
              durationMs: Date.now() - started,
            };
          }
        }
        case "git.branch": {
          const name = String(request.arguments.name ?? "");
          if (
            !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(name) ||
            name.includes("..")
          )
            throw new Error("Invalid branch name");
          const output = await this.runGit(["switch", "-c", name]);
          return {
            ok: output.exitCode === 0,
            output,
            ...(output.exitCode === 0
              ? {}
              : {
                  error: {
                    code: "GIT_BRANCH_FAILED",
                    message: output.output,
                    retryable: false,
                  },
                }),
            durationMs: Date.now() - started,
          };
        }
        case "git.stage": {
          const paths = Array.isArray(request.arguments.paths)
            ? request.arguments.paths.map(String)
            : [];
          if (!paths.length || paths.length > 100)
            throw new Error("git.stage requires 1 to 100 relative paths");
          for (const relativePath of paths) this.resolveSafe(relativePath);
          const output = await this.runGit(["add", "--", ...paths]);
          return {
            ok: output.exitCode === 0,
            output,
            ...(output.exitCode === 0
              ? {}
              : {
                  error: {
                    code: "GIT_STAGE_FAILED",
                    message: output.output,
                    retryable: false,
                  },
                }),
            durationMs: Date.now() - started,
          };
        }
        case "git.commit": {
          const message = String(request.arguments.message ?? "").trim();
          if (!message || message.length > 200)
            throw new Error(
              "git.commit requires a commit message of 1-200 characters",
            );
          const output = await this.runGit(["commit", "-m", message]);
          return {
            ok: output.exitCode === 0,
            output,
            ...(output.exitCode === 0
              ? {}
              : {
                  error: {
                    code: "GIT_COMMIT_FAILED",
                    message: output.output,
                    retryable: false,
                  },
                }),
            durationMs: Date.now() - started,
          };
        }
        case "workspace.apply_patch":
          return {
            ok: true,
            output: await this.applyPatch(request.arguments),
            durationMs: Date.now() - started,
          };
        case "workspace.apply_unified_diff":
          return {
            ok: true,
            output: await this.applyUnifiedDiff(request.arguments),
            durationMs: Date.now() - started,
          };
        case "browser.smoke": {
          const output = await this.runBrowserSmoke(
            request.arguments,
            request.signal,
          );
          return {
            ok: output.exitCode === 0,
            output,
            ...(output.exitCode === 0
              ? {}
              : {
                  error: {
                    code: "BROWSER_SMOKE_FAILED",
                    message: "The browser smoke check failed",
                    retryable: true,
                  },
                }),
            durationMs: Date.now() - started,
          };
        }
        case "process.run": {
          const output = await this.runProcess(
            request.arguments,
            request.signal,
          );
          return {
            ok: output.exitCode === 0,
            output,
            ...(output.exitCode === 0
              ? {}
              : {
                  error: {
                    code: "COMMAND_FAILED",
                    message: `Command exited with code ${output.exitCode}`,
                    retryable: true,
                  },
                }),
            durationMs: Date.now() - started,
          };
        }
      }
    } catch (error) {
      return errorResult(
        "TOOL_EXECUTION_ERROR",
        error instanceof Error ? error.message : String(error),
        false,
        started,
      );
    }
  }

  private resolveSafe(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath))
      throw new Error("Only relative workspace paths are allowed");
    const target = path.resolve(this.root, relativePath);
    let current = this.root;
    for (const part of relativePath.split(/[\\/]+/).filter(Boolean)) {
      current = path.join(current, part);
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink())
        throw new Error(
          "Symbolic-link paths are denied by the workspace policy",
        );
    }
    const relative = path.relative(this.root, target);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Path escapes the approved workspace");
    }
    if (this.isSensitive(relativePath))
      throw new Error("Access to sensitive credential-like files is denied");
    return target;
  }

  private isSensitive(relativePath: string): boolean {
    const normalized = relativePath.replaceAll("\\", "/");
    const basename = path.basename(normalized).toLowerCase();
    return sensitiveNames.some(
      (name) => basename === name || normalized.startsWith(`${name}/`),
    );
  }

  private async list(
    args: Record<string, unknown>,
  ): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
    const limit = boundedInt(args.limit ?? 120, 120, 1, 500);
    const files: Array<{ path: string; bytes: number; sha256: string }> = [];
    const visit = async (directory: string): Promise<void> => {
      if (files.length >= limit) return;
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= limit || ignoredDirectories.has(entry.name))
          continue;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(this.root, absolute);
        if (this.isSensitive(relative)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await visit(absolute);
        } else if (entry.isFile()) {
          const buffer = await fs.readFile(absolute);
          files.push({
            path: relative.replaceAll("\\", "/"),
            bytes: buffer.byteLength,
            sha256: createHash("sha256").update(buffer).digest("hex"),
          });
        }
      }
    };
    await visit(this.root);
    return files;
  }

  private async search(
    args: Record<string, unknown>,
  ): Promise<Array<{ path: string; line: number; text: string }>> {
    const query = String(args.query ?? "");
    if (!query) throw new Error("Search query is required");
    const limit = boundedInt(args.limit ?? 80, 80, 1, 300);
    const results: Array<{ path: string; line: number; text: string }> = [];
    const files = await this.list({ limit: 500 });
    for (const file of files) {
      if (results.length >= limit || file.bytes > 1_000_000) continue;
      const content = await fs
        .readFile(path.join(this.root, file.path), "utf8")
        .catch(() => "");
      if (!content) continue;
      content.split(/\r?\n/).forEach((text, index) => {
        if (
          results.length < limit &&
          text.toLowerCase().includes(query.toLowerCase())
        )
          results.push({
            path: file.path,
            line: index + 1,
            text: text.slice(0, 500),
          });
      });
    }
    return results;
  }

  private async read(
    args: Record<string, unknown>,
  ): Promise<{ path: string; content: string; bytes: number; sha256: string }> {
    const relativePath = String(args.path ?? "");
    const target = this.resolveSafe(relativePath);
    const maxBytes = boundedInt(args.maxBytes ?? 20_000, 20_000, 100, 200_000);
    const buffer = await fs.readFile(target);
    if (buffer.includes(0))
      throw new Error("Binary files are not readable through the text tool");
    const clipped = buffer.subarray(0, maxBytes);
    return {
      path: relativePath,
      content:
        clipped.toString("utf8") +
        (buffer.length > maxBytes ? "\n...[truncated]" : ""),
      bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    };
  }

  private async applyPatch(args: Record<string, unknown>): Promise<{
    files: string[];
    checkpoint: string;
  }> {
    const rawFiles = Array.isArray(args.files)
      ? args.files
      : [
          {
            path: args.path,
            content: args.content,
            originalSha256: args.originalSha256,
          },
        ];
    if (!rawFiles.length) throw new Error("At least one file is required");
    const changes = rawFiles.map((raw) => {
      if (!raw || typeof raw !== "object")
        throw new Error("Each patch file must be an object");
      const item = raw as Record<string, unknown>;
      const relativePath = String(item.path ?? "");
      const content = item.content;
      if (typeof content !== "string")
        throw new Error("Each patch file requires string content");
      return {
        relativePath,
        target: this.resolveSafe(relativePath),
        content,
        originalSha256:
          typeof item.originalSha256 === "string" ? item.originalSha256 : null,
        delete: false,
      };
    });
    return this.applyChanges(changes);
  }

  private async applyUnifiedDiff(args: Record<string, unknown>): Promise<{
    files: string[];
    checkpoint: string;
    changeSetDigest: string;
    summary: unknown;
  }> {
    const diff = args.diff;
    if (typeof diff !== "string")
      throw new Error("Unified diff requires string diff content");
    const selectedPaths = Array.isArray(args.paths)
      ? args.paths.map(String)
      : undefined;
    const preview = await this.previewUnifiedDiff(diff, selectedPaths);
    if (!preview.safeToApply)
      throw new Error(
        `Change set is stale or invalid: ${preview.conflicts.join("; ")}`,
      );
    const changeSetDigest = preview.changeSetDigest;
    const patches = parseUnifiedDiff(diff);
    const selection = selectedPaths?.length ? new Set(selectedPaths) : null;
    const selectedPatches = selection
      ? patches.filter((patch) =>
          [patch.oldPath, patch.newPath].some(
            (candidate) => candidate !== null && selection.has(candidate),
          ),
        )
      : patches;
    if (!selectedPatches.length)
      throw new Error("No unified-diff files matched the selected paths");
    const changes: Array<{
      relativePath: string;
      target: string;
      content: string;
      originalSha256: string | null;
      delete: boolean;
    }> = [];
    for (const patch of selectedPatches) {
      const oldTarget = patch.oldPath ? this.resolveSafe(patch.oldPath) : null;
      const newTarget = patch.newPath ? this.resolveSafe(patch.newPath) : null;
      if (!newTarget && !oldTarget)
        throw new Error("Unified diff has no target path");
      if (oldTarget && newTarget && oldTarget !== newTarget) {
        const previous = await fs.readFile(oldTarget, "utf8").catch(() => {
          throw new Error(`Rename source does not exist: ${patch.oldPath}`);
        });
        const content = patch.hunks.length
          ? applyUnifiedFilePatch(previous, patch)
          : previous;
        changes.push({
          relativePath: patch.oldPath as string,
          target: oldTarget,
          content: "",
          originalSha256: createHash("sha256").update(previous).digest("hex"),
          delete: true,
        });
        changes.push({
          relativePath: patch.newPath as string,
          target: newTarget,
          content,
          originalSha256: null,
          delete: false,
        });
        continue;
      }
      const relativePath = patch.newPath ?? patch.oldPath;
      if (!relativePath) throw new Error("Unified diff has no target path");
      const target = newTarget ?? oldTarget;
      if (!target) throw new Error("Unified diff target is invalid");
      const previous = await fs
        .readFile(target, "utf8")
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
      if (!patch.oldPath && previous !== null)
        throw new Error(`File already exists: ${relativePath}`);
      if (!patch.newPath) {
        if (previous === null)
          throw new Error(`File does not exist: ${relativePath}`);
        changes.push({
          relativePath,
          target,
          content: "",
          originalSha256: createHash("sha256").update(previous).digest("hex"),
          delete: true,
        });
        continue;
      }
      const content =
        previous === null
          ? applyUnifiedFilePatch("", patch)
          : applyUnifiedFilePatch(previous, patch);
      changes.push({
        relativePath,
        target,
        content,
        originalSha256: previous
          ? createHash("sha256").update(previous).digest("hex")
          : null,
        delete: false,
      });
    }
    const applied = await this.applyChanges(changes);
    return {
      ...applied,
      changeSetDigest,
      summary: {
        files: selectedPatches.length,
        hunks: selectedPatches.reduce(
          (count, patch) => count + patch.hunks.length,
          0,
        ),
      },
    };
  }

  private async applyChanges(
    changes: Array<{
      relativePath: string;
      target: string;
      content: string;
      originalSha256: string | null;
      delete: boolean;
    }>,
  ): Promise<{ files: string[]; checkpoint: string }> {
    if (!changes.length) throw new Error("At least one file is required");
    if (changes.length > 8)
      throw new Error(
        "CHANGE_UNIT_TOO_LARGE: at most 8 file entries may be changed transactionally",
      );
    const totalBytes = changes.reduce(
      (total, change) => total + Buffer.byteLength(change.content, "utf8"),
      0,
    );
    if (totalBytes > 1_000_000)
      throw new Error(
        "CHANGE_UNIT_TOO_LARGE: transactional change content is limited to 1000000 bytes",
      );
    if (new Set(changes.map((change) => change.target)).size !== changes.length)
      throw new Error(
        "CHANGE_UNIT_INVALID: duplicate file entries are not allowed",
      );
    const checkpoint = randomUUID();
    const manifest: Array<{
      path: string;
      existed: boolean;
      backup: string | null;
    }> = [];
    await fs.mkdir(this.checkpointRoot, { recursive: true, mode: 0o700 });
    for (const [index, change] of changes.entries()) {
      let previous: Buffer | null;
      try {
        previous = await fs.readFile(change.target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        previous = null;
      }
      const beforeSha256 = previous
        ? createHash("sha256").update(previous).digest("hex")
        : null;
      if (change.originalSha256 && change.originalSha256 !== beforeSha256)
        throw new Error(`Stale file detected: ${change.relativePath}`);
      const backup = previous ? `${checkpoint}-${index}.bak` : null;
      if (previous && backup)
        await fs.writeFile(path.join(this.checkpointRoot, backup), previous, {
          mode: 0o600,
        });
      manifest.push({
        path: change.relativePath,
        existed: Boolean(previous),
        backup,
      });
    }
    await fs.writeFile(
      path.join(this.checkpointRoot, `${checkpoint}.json`),
      JSON.stringify({ workspace: this.root, files: manifest }, null, 2),
      { mode: 0o600 },
    );
    try {
      for (const change of changes) {
        if (change.delete) await fs.unlink(change.target);
        else {
          await fs.mkdir(path.dirname(change.target), { recursive: true });
          await writeNoFollow(change.target, change.content);
        }
      }
    } catch (error) {
      await this.restoreCheckpoint(checkpoint).catch(() => undefined);
      throw error;
    }
    return { files: changes.map((change) => change.relativePath), checkpoint };
  }

  public async restoreCheckpoint(checkpoint: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(checkpoint))
      throw new Error("Invalid checkpoint ID");
    const manifestPath = path.join(this.checkpointRoot, `${checkpoint}.json`);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      workspace: string;
      files: Array<{ path: string; existed: boolean; backup: string | null }>;
    };
    if (manifest.workspace !== this.root)
      throw new Error("Checkpoint belongs to a different workspace");
    for (const file of manifest.files) {
      const target = this.resolveSafe(file.path);
      if (file.existed && file.backup) {
        const backup = await fs.readFile(
          path.join(this.checkpointRoot, file.backup),
        );
        await writeNoFollow(target, backup);
      } else await fs.unlink(target).catch(() => undefined);
    }
  }

  private async runGit(
    args: string[],
  ): Promise<{ command: string; exitCode: number; output: string }> {
    return this.runProcess({
      command: "git",
      args,
      timeoutMs: 10_000,
      maxOutputBytes: 100_000,
    });
  }

  private async runBrowserSmoke(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ command: string; exitCode: number; output: string }> {
    const requestedPath = String(args.path ?? "").replaceAll("\\", "/");
    this.resolveSafe(requestedPath);
    let indexPath = requestedPath;
    let directory = path.posix.dirname(requestedPath);
    while (true) {
      const candidate =
        directory === "." ? "index.html" : `${directory}/index.html`;
      const exists = await fs
        .stat(path.join(this.root, candidate))
        .then((stat) => stat.isFile())
        .catch(() => false);
      if (exists) {
        indexPath = candidate;
        break;
      }
      if (directory === ".") break;
      directory = path.posix.dirname(directory);
    }
    const python =
      process.env.FORGE_PYTHON ||
      (process.platform === "win32" ? "python" : "python3");
    const server = spawn(
      python,
      ["-u", "-m", "http.server", "0", "--bind", "127.0.0.1"],
      { cwd: this.root, env: safeChildEnvironment(), windowsHide: true },
    );
    let serverOutput = "";
    let port: number | undefined;
    const serverReady = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.stdout.removeListener("data", capture);
        server.stderr.removeListener("data", capture);
        server.removeListener("error", onError);
        server.removeListener("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const capture = (chunk: Buffer): void => {
        if (Buffer.byteLength(serverOutput) < 8_000)
          serverOutput += chunk
            .toString("utf8")
            .slice(0, 8_000 - Buffer.byteLength(serverOutput));
        const match = serverOutput.match(/port (\d+)/i);
        const candidatePort = match ? Number(match[1]) : undefined;
        if (candidatePort && candidatePort > 0 && candidatePort < 65_536) {
          port = candidatePort;
          finish();
        }
      };
      const onError = (error: Error): void => finish(error);
      const onClose = (code: number | null): void =>
        finish(
          new Error(`Static server exited before startup (code ${code ?? 1})`),
        );
      const timer = setTimeout(
        () => finish(new Error("Static server startup timed out")),
        5_000,
      );
      server.stdout.on("data", capture);
      server.stderr.on("data", capture);
      server.on("error", onError);
      server.on("close", onClose);
    });
    try {
      await serverReady;
      if (signal?.aborted) throw new Error("Browser smoke cancelled");
      const browser =
        process.env.FORGE_BROWSER ??
        (process.platform === "win32" ? "msedge" : "chromium");
      const url = `http://127.0.0.1:${port}/${indexPath.split("/").map(encodeURIComponent).join("/")}`;
      const browserArgs = [
        "--headless",
        ...(process.platform === "linux"
          ? ["--no-sandbox", "--disable-dev-shm-usage"]
          : []),
        "--disable-gpu",
        "--enable-logging=stderr",
        "--log-level=0",
        "--virtual-time-budget=1500",
        "--dump-dom",
        url,
      ];
      let result: { exitCode: number; output: string };
      try {
        result = await this.runChild(
          browser,
          browserArgs,
          signal,
          15_000,
          50_000,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT")
          return {
            command: `${browser} --headless --dump-dom ${url}`,
            exitCode: 127,
            output: `BROWSER_UNAVAILABLE: ${browser} was not found on PATH`,
          };
        throw error;
      }
      const output = `${result.output}${serverOutput}`.slice(0, 50_000);
      const browserFailure =
        /(?:Uncaught|SyntaxError|ReferenceError|Failed to load resource|404 Not Found)/i.test(
          output,
        );
      return {
        command: `${browser} --headless --dump-dom ${url}`,
        exitCode:
          result.exitCode === 0 && !browserFailure ? 0 : result.exitCode || 1,
        output,
      };
    } finally {
      if (!server.killed && server.exitCode === null) server.kill("SIGTERM");
      if (server.exitCode === null)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          server.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
    }
  }

  private async runChild(
    command: string,
    commandArgs: string[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<{ exitCode: number; output: string }> {
    if (signal?.aborted) throw new Error("Command cancelled");
    return await new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, {
        cwd: this.root,
        env: safeChildEnvironment(),
        windowsHide: true,
      });
      let output = "";
      const append = (chunk: Buffer): void => {
        if (Buffer.byteLength(output) < maxOutputBytes)
          output += chunk
            .toString("utf8")
            .slice(0, maxOutputBytes - Buffer.byteLength(output));
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        reject(new Error("Command cancelled"));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ exitCode: code ?? 1, output });
      });
    });
  }

  private async runProcess(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ command: string; exitCode: number; output: string }> {
    let command = String(args.command ?? "").trim();
    if (!command) throw new Error("Command is required");
    let commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    if (!commandArgs.length && /\s/.test(command)) {
      const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
      command = tokens.shift() ?? command;
      commandArgs = tokens.map((token) => token.replace(/^("|')|("|')$/g, ""));
    }
    if (process.platform === "win32" && /^(npm|npx|yarn|pnpm)$/i.test(command))
      command = `${command}.cmd`;
    const timeoutMs = boundedInt(
      args.timeoutMs ?? 30_000,
      30_000,
      100,
      120_000,
    );
    const maxOutputBytes = boundedInt(
      args.maxOutputBytes ?? 100_000,
      100_000,
      1_000,
      1_000_000,
    );
    const shell = args.shell === true;
    if (shell && args.allowShell !== true)
      throw new Error("Shell execution requires explicit allowShell=true");
    if (signal?.aborted) throw new Error("Command cancelled");
    return await new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, {
        cwd: this.root,
        shell:
          shell ||
          (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)),
        env: safeChildEnvironment(),
        windowsHide: true,
      });
      let output = "";
      let clipped = false;
      const append = (chunk: Buffer): void => {
        if (Buffer.byteLength(output) >= maxOutputBytes) {
          clipped = true;
          return;
        }
        output += chunk
          .toString("utf8")
          .slice(0, maxOutputBytes - Buffer.byteLength(output));
        if (Buffer.byteLength(output) >= maxOutputBytes) clipped = true;
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        reject(new Error("Command cancelled"));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          command: [command, ...commandArgs].join(" "),
          exitCode: code ?? 1,
          output: output + (clipped ? "\n...[output truncated]" : ""),
        });
      });
    });
  }
}

export class PolicyEngine {
  private readonly deniedRisks: ReadonlySet<RiskClass>;
  private readonly deniedTools: ReadonlySet<ToolName>;

  public constructor(
    public readonly mode: "safe" | "session-approve" | "unsafe" = "safe",
    restrictions: {
      denyRisks?: Iterable<RiskClass>;
      denyTools?: Iterable<ToolName>;
    } = {},
  ) {
    this.deniedRisks = new Set(restrictions.denyRisks ?? []);
    this.deniedTools = new Set(restrictions.denyTools ?? []);
  }

  public requiresApproval(risk: RiskClass): boolean {
    if (this.mode === "unsafe") return false;
    if (this.mode === "session-approve") return risk !== "read-only";
    return risk !== "read-only";
  }

  public isAllowed(risk: RiskClass, tool?: ToolName): boolean {
    return this.explain(risk, tool).allowed;
  }

  public explain(
    risk: RiskClass,
    tool?: ToolName,
  ): {
    mode: "safe" | "session-approve" | "unsafe";
    risk: RiskClass;
    tool?: ToolName;
    allowed: boolean;
    approvalRequired: boolean;
    category: "allowed" | "approval-required" | "denied";
    nextAction: "execute-read-only" | "request-approval" | "review-policy";
    reasons: string[];
  } {
    const reasons: string[] = [];
    if (
      risk === "destructive" ||
      risk === "network" ||
      risk === "credential-sensitive"
    )
      reasons.push("global safety ceiling denies this risk class");
    if (this.deniedRisks.has(risk))
      reasons.push("policy restriction denies this risk class");
    if (tool && this.deniedTools.has(tool))
      reasons.push("policy restriction denies this tool");
    const allowed = reasons.length === 0;
    const approvalRequired = allowed && this.requiresApproval(risk);
    if (approvalRequired) reasons.push("explicit approval is required");
    if (allowed && !approvalRequired)
      reasons.push("read-only action is automatic");
    return {
      mode: this.mode,
      risk,
      ...(tool ? { tool } : {}),
      allowed,
      approvalRequired,
      category: !allowed
        ? "denied"
        : approvalRequired
          ? "approval-required"
          : "allowed",
      nextAction: !allowed
        ? "review-policy"
        : approvalRequired
          ? "request-approval"
          : "execute-read-only",
      reasons,
    };
  }
}
