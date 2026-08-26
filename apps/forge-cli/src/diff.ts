export interface UnifiedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export interface UnifiedFilePatch {
  oldPath: string | null;
  newPath: string | null;
  renameFrom?: string;
  renameTo?: string;
  hunks: UnifiedHunk[];
}

export interface UnifiedDiffSummary {
  files: number;
  hunks: number;
  additions: number;
  deletions: number;
  renames: number;
  created: number;
  deleted: number;
  paths: string[];
}

const MAX_DIFF_BYTES = 500_000;
const MAX_FILES = 100;
const MAX_HUNKS_PER_FILE = 200;

function cleanPath(value: string): string | null {
  const unquoted = value.trim().replace(/^"|"$/g, "");
  if (!unquoted || unquoted === "/dev/null") return null;
  const normalized = unquoted.replace(/^([ab])\//, "");
  if (
    normalized.startsWith("/") ||
    normalized.split(/[\\/]+/).some((part) => part === ".." || part === "") ||
    normalized.includes("\0")
  )
    throw new Error("Unified diff contains an unsafe path");
  return normalized;
}

function parseHeaderPath(
  line: string | undefined,
  prefix: string,
): string | null {
  if (!line || !line.startsWith(prefix))
    throw new Error(`Unified diff is missing ${prefix.trim()} header`);
  const value = line.slice(prefix.length).split("\t", 1)[0] ?? "";
  return cleanPath(value);
}

function parseHunkHeader(line: string): UnifiedHunk {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) throw new Error("Malformed unified diff hunk header");
  const values = [match[1], match[2] ?? "1", match[3], match[4] ?? "1"].map(
    Number,
  );
  if (
    values.some(
      (value) =>
        !Number.isSafeInteger(value) || value < 0 || value > MAX_DIFF_BYTES,
    )
  )
    throw new Error("Unified diff hunk header is out of bounds");
  return {
    oldStart: values[0]!,
    oldCount: values[1]!,
    newStart: values[2]!,
    newCount: values[3]!,
    lines: [],
  };
}

export function parseUnifiedDiff(diff: string): UnifiedFilePatch[] {
  if (
    typeof diff !== "string" ||
    Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES
  )
    throw new Error("Unified diff is empty or exceeds the 500000-byte limit");
  const lines = diff.replaceAll("\r\n", "\n").split("\n");
  const patches: UnifiedFilePatch[] = [];
  const seenTargets = new Set<string>();
  let index = 0;
  while (index < lines.length) {
    if (lines[index] === "") {
      index += 1;
      continue;
    }
    const fileHeader = lines[index];
    if (!fileHeader || !fileHeader.startsWith("diff --git "))
      throw new Error("Unified diff must contain diff --git file headers");
    index += 1;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    while (index < lines.length && !lines[index]?.startsWith("--- ")) {
      const line = lines[index];
      if (line === undefined) break;
      if (line.startsWith("rename from "))
        renameFrom = cleanPath(line.slice("rename from ".length)) ?? undefined;
      if (line.startsWith("rename to "))
        renameTo = cleanPath(line.slice("rename to ".length)) ?? undefined;
      if (line.startsWith("Binary files ") || line === "GIT binary patch")
        throw new Error("Binary unified diffs are not supported");
      index += 1;
    }
    if (
      lines[index] === "GIT binary patch" ||
      lines[index]?.startsWith("Binary files ")
    )
      throw new Error("Binary unified diffs are not supported");
    if (index >= lines.length) {
      if (!renameFrom || !renameTo)
        throw new Error("Unified diff is missing file headers");
      const target = `${renameFrom}\u0000${renameTo}`;
      if (seenTargets.has(target))
        throw new Error("Unified diff contains duplicate file changes");
      seenTargets.add(target);
      patches.push({
        oldPath: renameFrom,
        newPath: renameTo,
        renameFrom,
        renameTo,
        hunks: [],
      });
      continue;
    }
    const oldPath = parseHeaderPath(lines[index], "--- ");
    index += 1;
    if (index >= lines.length)
      throw new Error("Unified diff is missing the new-file header");
    const newPath = parseHeaderPath(lines[index], "+++ ");
    index += 1;
    const hunks: UnifiedHunk[] = [];
    while (index < lines.length && !lines[index]?.startsWith("diff --git ")) {
      const line = lines[index];
      if (line === undefined) break;
      if (line === "") {
        index += 1;
        continue;
      }
      if (!line.startsWith("@@ "))
        throw new Error(
          "Unexpected content in unified diff; expected a hunk header",
        );
      if (hunks.length >= MAX_HUNKS_PER_FILE)
        throw new Error("Unified diff has too many hunks");
      const hunk = parseHunkHeader(line);
      index += 1;
      while (
        index < lines.length &&
        !lines[index]?.startsWith("@@ ") &&
        !lines[index]?.startsWith("diff --git ")
      ) {
        const hunkLine = lines[index];
        if (hunkLine === undefined || hunkLine === "") break;
        if (
          hunkLine !== "\\ No newline at end of file" &&
          !/^[ +\-]/.test(hunkLine)
        )
          throw new Error("Malformed unified diff hunk line");
        if (hunkLine !== "\\ No newline at end of file")
          hunk.lines.push(hunkLine);
        index += 1;
      }
      const oldLines = hunk.lines.filter((entry) => entry[0] !== "+").length;
      const newLines = hunk.lines.filter((entry) => entry[0] !== "-").length;
      if (oldLines !== hunk.oldCount || newLines !== hunk.newCount)
        throw new Error(
          "Unified diff hunk line counts do not match its header",
        );
      hunks.push(hunk);
    }
    if (!oldPath && !newPath)
      throw new Error("Unified diff file has no target path");
    const target = `${oldPath ?? ""}\u0000${newPath ?? ""}`;
    if (seenTargets.has(target))
      throw new Error("Unified diff contains duplicate file changes");
    seenTargets.add(target);
    patches.push({
      oldPath,
      newPath,
      ...(renameFrom ? { renameFrom } : {}),
      ...(renameTo ? { renameTo } : {}),
      hunks,
    });
    if (patches.length > MAX_FILES)
      throw new Error("Unified diff has too many files");
  }
  if (!patches.length) throw new Error("Unified diff contains no file changes");
  return patches;
}

function contentLines(content: string): {
  lines: string[];
  trailingNewline: boolean;
} {
  const normalized = content.replaceAll("\r\n", "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

export function applyUnifiedFilePatch(
  content: string,
  patch: UnifiedFilePatch,
): string {
  const source = contentLines(content);
  if (!patch.hunks.length) return content;
  const result: string[] = [];
  let cursor = 0;
  for (const hunk of patch.hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    if (start < cursor || start > source.lines.length)
      throw new Error("Unified diff hunk position is invalid");
    result.push(...source.lines.slice(cursor, start));
    cursor = start;
    for (const entry of hunk.lines) {
      const marker = entry[0];
      const value = entry.slice(1);
      if (marker === " ") {
        if (source.lines[cursor] !== value)
          throw new Error(
            "Unified diff context does not match the current file",
          );
        result.push(value);
        cursor += 1;
      } else if (marker === "-") {
        if (source.lines[cursor] !== value)
          throw new Error(
            "Unified diff deletion does not match the current file",
          );
        cursor += 1;
      } else {
        result.push(value);
      }
    }
  }
  result.push(...source.lines.slice(cursor));
  return result.join("\n") + (source.trailingNewline ? "\n" : "");
}

export function summarizeUnifiedDiff(diff: string): UnifiedDiffSummary {
  const patches = parseUnifiedDiff(diff);
  let additions = 0;
  let deletions = 0;
  for (const patch of patches) {
    for (const hunk of patch.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) additions += 1;
        if (line.startsWith("-")) deletions += 1;
      }
    }
  }
  return {
    files: patches.length,
    hunks: patches.reduce((count, patch) => count + patch.hunks.length, 0),
    additions,
    deletions,
    renames: patches.filter((patch) => patch.renameFrom && patch.renameTo)
      .length,
    created: patches.filter((patch) => !patch.oldPath && patch.newPath).length,
    deleted: patches.filter((patch) => patch.oldPath && !patch.newPath).length,
    paths: patches
      .flatMap((patch) => [patch.oldPath, patch.newPath])
      .filter((value): value is string => Boolean(value)),
  };
}
