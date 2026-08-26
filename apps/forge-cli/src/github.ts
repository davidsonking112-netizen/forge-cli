import { spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

const MAX_OUTPUT_BYTES = 100_000;
const COMMAND_TIMEOUT_MS = 120_000;

export type GitHubAction = "status" | "connect" | "create" | "clone" | "push";

export interface GitHubCommandResult {
  action: GitHubAction;
  command: string[];
  ok: boolean;
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
}

function redact(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s/@]+):[^\s/@]+@/gi, "$1:[redacted]@")
    .replace(
      /(token|password|secret|api[_-]?key)[=:]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    );
}

function validRepository(value: string): boolean {
  return (
    /^(?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(value) && value.length <= 200
  );
}

function validBranch(value: string): boolean {
  const unsafeCharacters = new Set([
    "~",
    "^",
    ":",
    "?",
    "*",
    "[",
    "]",
    String.fromCharCode(92),
  ]);
  return (
    value.length > 0 &&
    value.length <= 200 &&
    !value.startsWith("-") &&
    !value.includes("..") &&
    ![...value].some(
      (character) =>
        character.charCodeAt(0) <= 32 || unsafeCharacters.has(character),
    )
  );
}

async function rejectSymlinkComponents(
  target: string,
  root: string,
): Promise<void> {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(
      "GitHub destination must remain inside the approved workspace",
    );
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(`GitHub destination contains a symbolic link: ${part}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
}

export async function runGitHubCommand(
  command: string[],
  cwd: string,
  action: GitHubAction,
  interactive = false,
): Promise<GitHubCommandResult> {
  if (!command.length) throw new Error("GitHub command cannot be empty");
  const executable = command[0];
  if (executable !== "gh" && executable !== "git")
    throw new Error("GitHub operations only permit the gh and git executables");
  if (interactive) {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(executable, command.slice(1), {
        cwd,
        stdio: "inherit",
        shell: false,
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          USERPROFILE: process.env.USERPROFILE ?? "",
          GH_HOST: "github.com",
        },
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("GitHub interactive command timed out"));
      }, COMMAND_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    return {
      action,
      command: command.map((item) =>
        item.startsWith("http") ? "[url]" : item,
      ),
      ok: exitCode === 0,
      exitCode,
      output:
        exitCode === 0
          ? "Interactive GitHub command completed."
          : "Interactive GitHub command failed.",
      outputTruncated: false,
    };
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, command.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        USERPROFILE: process.env.USERPROFILE ?? "",
        GH_HOST: "github.com",
      },
    });
    let output = "";
    let outputTruncated = false;
    const append = (chunk: Buffer): void => {
      if (Buffer.byteLength(output, "utf8") >= MAX_OUTPUT_BYTES) {
        outputTruncated = true;
        return;
      }
      output += chunk
        .toString("utf8")
        .slice(0, MAX_OUTPUT_BYTES - Buffer.byteLength(output, "utf8"));
      if (Buffer.byteLength(output, "utf8") >= MAX_OUTPUT_BYTES)
        outputTruncated = true;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("GitHub command timed out"));
    }, COMMAND_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        action,
        command: command.map((item) =>
          item.startsWith("http") ? "[url]" : item,
        ),
        ok: exitCode === 0,
        exitCode,
        output:
          redact(output) + (outputTruncated ? "\n...[output truncated]" : ""),
        outputTruncated,
      });
    });
  });
}

export async function prepareGitHubAction(
  action: GitHubAction,
  workspace: string,
  options: {
    repository?: string | undefined;
    destination?: string | undefined;
    branch?: string | undefined;
    push?: boolean | undefined;
  } = {},
): Promise<{ command: string[]; cwd: string }> {
  if (action === "status")
    return {
      command: ["gh", "auth", "status", "--hostname", "github.com"],
      cwd: workspace,
    };
  if (action === "connect")
    return {
      command: [
        "gh",
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--web",
        "--git-protocol",
        "https",
      ],
      cwd: workspace,
    };
  const repository = options.repository;
  if (action !== "push" && (!repository || !validRepository(repository)))
    throw new Error(
      "GitHub repository must be owner/name or a bounded repository name",
    );
  if (action === "create") {
    if (!repository) throw new Error("GitHub create requires a repository");
    if (options.push !== undefined && typeof options.push !== "boolean")
      throw new Error("GitHub create push option is invalid");
    return {
      command: [
        "gh",
        "repo",
        "create",
        repository,
        "--private",
        "--source",
        workspace,
        "--remote",
        "origin",
        ...(options.push ? ["--push"] : []),
      ],
      cwd: workspace,
    };
  }
  if (action === "clone") {
    if (!options.destination)
      throw new Error("GitHub clone requires a destination");
    const destination = path.resolve(workspace, options.destination);
    await mkdir(workspace, { recursive: true });
    await rejectSymlinkComponents(destination, workspace);
    return {
      command: ["gh", "repo", "clone", repository as string, destination],
      cwd: workspace,
    };
  }
  const branch = options.branch ?? "HEAD";
  if (branch !== "HEAD" && !validBranch(branch))
    throw new Error("GitHub push branch is invalid");
  return {
    command: ["git", "push", "origin", branch],
    cwd: workspace,
  };
}
