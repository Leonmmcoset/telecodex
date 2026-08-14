import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type GitChangeKind = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface GitFileChange {
  path: string;
  kind: GitChangeKind;
  additions: number;
  deletions: number;
  signature: string;
}

export interface GitDiffReport {
  repository: boolean;
  branch: string;
  files: GitFileChange[];
  additions: number;
  deletions: number;
}

export interface GitStatusReport {
  repository: boolean;
  branch: string;
  status: string[];
}

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export async function getGitStatus(workspace: string): Promise<GitStatusReport> {
  const branchResult = await runGit(workspace, ["branch", "--show-current"]);
  const statusResult = await runGit(workspace, ["status", "--short", "--untracked-files=all"]);

  if (!branchResult.ok && !statusResult.ok) {
    return { repository: false, branch: "", status: [] };
  }

  return {
    repository: true,
    branch: branchResult.stdout.trim() || "（无分支）",
    status: statusResult.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean),
  };
}

export async function getGitDiffReport(workspace: string): Promise<GitDiffReport> {
  const status = await getGitStatus(workspace);
  if (!status.repository) {
    return { repository: false, branch: "", files: [], additions: 0, deletions: 0 };
  }

  const stats = await getWorkingTreeNumstat(workspace);
  const changes = new Map<string, GitFileChange>();

  for (const line of status.status) {
    const parsed = parseStatusLine(line);
    if (!parsed) continue;
    const stat = stats.get(parsed.path);
    changes.set(parsed.path, {
      path: parsed.path,
      kind: parsed.kind,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      signature: "",
    });
  }

  for (const [filePath, stat] of stats.entries()) {
    if (!changes.has(filePath)) {
      changes.set(filePath, {
        path: filePath,
        kind: "modified",
        additions: stat.additions,
        deletions: stat.deletions,
        signature: "",
      });
    }
  }

  for (const change of changes.values()) {
    if (change.kind === "untracked" && change.additions === 0 && change.deletions === 0) {
      change.additions = await countFileLines(workspace, change.path);
    }
  }

  const files = [...changes.values()].sort((left, right) => left.path.localeCompare(right.path));
  await Promise.all(files.map(async (file) => {
    file.signature = await getFileSignature(workspace, file.path);
  }));
  return {
    repository: true,
    branch: status.branch,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

export async function getGitFileDiff(workspace: string, filePath: string): Promise<string> {
  const absolutePath = path.resolve(workspace, filePath);
  const workspaceRoot = path.resolve(workspace);
  if (!isPathWithinWorkspace(workspaceRoot, absolutePath)) {
    return "无法查看工作区之外的文件。";
  }

  const hasHead = await hasHeadCommit(workspace);
  const diffArgs = hasHead
    ? ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", filePath]
    : ["diff", "--no-ext-diff", "--cached", "--unified=3", "--", filePath];
  const result = await runGit(workspace, diffArgs);
  if (result.stdout.trim()) return result.stdout;

  const content = await readFile(absolutePath, "utf8").catch(() => "");
  if (!content) return "（没有可显示的 diff，文件可能为空或已被删除。）";
  const lines = content.split(/\r?\n/).map((line) => `+${line}`);
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines,
  ].join("\n");
}

export async function getGitLog(workspace: string, limit = 8): Promise<string[]> {
  const result = await runGit(workspace, [
    "log",
    `-${Math.max(1, Math.min(limit, 20))}`,
    "--date=short",
    "--pretty=format:%h|%ad|%an|%s",
  ]);
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function getGitRemotes(workspace: string): Promise<string[]> {
  const result = await runGit(workspace, ["remote", "-v"]);
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseStatusLine(line: string): { path: string; kind: GitChangeKind } | null {
  if (line.length < 3) return null;
  const code = line.slice(0, 2);
  const filePath = line.slice(3).trim();
  if (!filePath) return null;

  if (code === "??") return { path: filePath, kind: "untracked" };
  if (code.includes("R")) return { path: filePath.split(" -> ").at(-1) ?? filePath, kind: "renamed" };
  if (code.includes("A")) return { path: filePath, kind: "added" };
  if (code.includes("D")) return { path: filePath, kind: "deleted" };
  return { path: filePath, kind: "modified" };
}

function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!match) continue;
    const additions = match[1] === "-" ? 0 : Number(match[1]);
    const deletions = match[2] === "-" ? 0 : Number(match[2]);
    const filePath = match[3].includes(" => ") ? match[3].split(" => ").at(-1)! : match[3];
    result.set(filePath, { additions, deletions });
  }
  return result;
}

async function getWorkingTreeNumstat(workspace: string): Promise<Map<string, { additions: number; deletions: number }>> {
  if (await hasHeadCommit(workspace)) {
    const result = await runGit(workspace, ["diff", "--no-ext-diff", "--numstat", "HEAD", "--"]);
    return parseNumstat(result.stdout);
  }

  const [staged, unstaged] = await Promise.all([
    runGit(workspace, ["diff", "--no-ext-diff", "--cached", "--numstat", "--"]),
    runGit(workspace, ["diff", "--no-ext-diff", "--numstat", "--"]),
  ]);
  return mergeNumstats(parseNumstat(staged.stdout), parseNumstat(unstaged.stdout));
}

async function hasHeadCommit(workspace: string): Promise<boolean> {
  const result = await runGit(workspace, ["rev-parse", "--verify", "HEAD"]);
  return result.ok;
}

function mergeNumstats(
  first: Map<string, { additions: number; deletions: number }>,
  second: Map<string, { additions: number; deletions: number }>,
): Map<string, { additions: number; deletions: number }> {
  const merged = new Map(first);
  for (const [filePath, stat] of second) {
    const existing = merged.get(filePath);
    merged.set(filePath, existing
      ? { additions: existing.additions + stat.additions, deletions: existing.deletions + stat.deletions }
      : stat);
  }
  return merged;
}

async function countFileLines(workspace: string, filePath: string): Promise<number> {
  const content = await readFile(path.join(workspace, filePath), "utf8").catch(() => "");
  if (!content) return 0;
  return content.split(/\r?\n/).filter((line, index, lines) => line.length > 0 || index < lines.length - 1).length;
}

async function getFileSignature(workspace: string, filePath: string): Promise<string> {
  const diff = await runGit(
    workspace,
    await hasHeadCommit(workspace)
      ? ["diff", "--no-ext-diff", "--binary", "HEAD", "--", filePath]
      : ["diff", "--no-ext-diff", "--cached", "--binary", "--", filePath],
  );
  let source = diff.stdout;
  if (!source.trim()) {
    source = await readFile(path.join(workspace, filePath), "utf8").catch(() => "");
  }
  return createHash("sha256").update(source).digest("hex");
}

function isPathWithinWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  const relativePath = path.relative(workspaceRoot, candidatePath);
  return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
}

function runGit(workspace: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd: workspace,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
