import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, promises as fs } from "node:fs";
import path from "node:path";
import type {
  RiskClass,
  ToolName,
} from "../../../packages/protocol/src/index.js";

export interface ToolResult {
  ok: boolean;
  output?: unknown;
  error?: { code: string; message: string; retryable: boolean };
  durationMs: number;
}

export interface ToolRequest {
  tool: ToolName;
  arguments: Record<string, unknown>;
}

export interface ToolMetadata {
  risk: RiskClass;
  description: string;
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
  "process.run": {
    risk: "local-execution",
    description: "Run an approved local process",
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
    checkpointRoot = path.join(
      process.env.XDG_STATE_HOME ??
        path.join(process.env.HOME ?? process.cwd(), ".local", "state"),
      "forge",
      "checkpoints",
    ),
  ) {
    this.checkpointRoot = checkpointRoot;
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
        case "git.status":
          return {
            ok: true,
            output: await this.runGit(["status", "--short", "--branch"]),
            durationMs: Date.now() - started,
          };
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
        case "process.run": {
          const output = await this.runProcess(request.arguments);
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
    const limit = Math.min(Math.max(Number(args.limit ?? 120), 1), 500);
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
    const limit = Math.min(Math.max(Number(args.limit ?? 80), 1), 300);
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
    const maxBytes = Math.min(
      Math.max(Number(args.maxBytes ?? 20_000), 100),
      200_000,
    );
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
      };
    });
    const checkpoint = randomUUID();
    const manifest: Array<{
      path: string;
      existed: boolean;
      backup: string | null;
    }> = [];
    await fs.mkdir(this.checkpointRoot, { recursive: true, mode: 0o700 });
    for (const [index, change] of changes.entries()) {
      const previous = await fs.readFile(change.target).catch(() => null);
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
        await fs.mkdir(path.dirname(change.target), { recursive: true });
        await fs.writeFile(change.target, change.content, "utf8");
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
      if (file.existed && file.backup)
        await fs.copyFile(path.join(this.checkpointRoot, file.backup), target);
      else await fs.unlink(target).catch(() => undefined);
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

  private async runProcess(
    args: Record<string, unknown>,
  ): Promise<{ command: string; exitCode: number; output: string }> {
    const command = String(args.command ?? "");
    if (!command) throw new Error("Command is required");
    const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const timeoutMs = Math.min(
      Math.max(Number(args.timeoutMs ?? 30_000), 100),
      120_000,
    );
    const maxOutputBytes = Math.min(
      Math.max(Number(args.maxOutputBytes ?? 100_000), 1_000),
      1_000_000,
    );
    const shell = args.shell === true;
    return await new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, {
        cwd: this.root,
        shell,
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
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
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
  public constructor(
    public readonly mode: "safe" | "session-approve" | "unsafe" = "safe",
  ) {}

  public requiresApproval(risk: RiskClass): boolean {
    if (this.mode === "unsafe") return false;
    if (this.mode === "session-approve") return risk !== "read-only";
    return risk !== "read-only";
  }

  public isAllowed(risk: RiskClass): boolean {
    if (this.mode === "unsafe") return true;
    return (
      risk !== "destructive" &&
      risk !== "network" &&
      risk !== "credential-sensitive"
    );
  }
}
