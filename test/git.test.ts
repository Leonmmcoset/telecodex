import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getGitDiffReport, getGitFileDiff, getGitStatus } from "../src/git.js";

function git(workspace: string, args: string[]): void {
  execFileSync("git", args, { cwd: workspace, windowsHide: true });
}

async function createRepository(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "telecodex-git-"));
  git(workspace, ["init"]);
  git(workspace, ["config", "user.email", "telecodex@example.test"]);
  git(workspace, ["config", "user.name", "TeleCodex Test"]);
  return workspace;
}

describe("Git workspace reports", () => {
  it("reports modified and untracked files with line counts", async () => {
    const workspace = await createRepository();
    try {
      await writeFile(path.join(workspace, "tracked.txt"), "one\n");
      git(workspace, ["add", "tracked.txt"]);
      git(workspace, ["commit", "-m", "initial"]);
      await writeFile(path.join(workspace, "tracked.txt"), "one\ntwo\n");
      await writeFile(path.join(workspace, "new.txt"), "new file\n");

      const status = await getGitStatus(workspace);
      const report = await getGitDiffReport(workspace);

      expect(status.repository).toBe(true);
      expect(status.status).toContain(" M tracked.txt");
      expect(status.status).toContain("?? new.txt");
      expect(report.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt", kind: "modified", additions: 1, deletions: 0 }),
        expect.objectContaining({ path: "new.txt", kind: "untracked", additions: 1, deletions: 0 }),
      ]));
      await expect(getGitFileDiff(workspace, "tracked.txt")).resolves.toContain("+two");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports staged files before the first commit", async () => {
    const workspace = await createRepository();
    try {
      await writeFile(path.join(workspace, "first.txt"), "first line\n");
      git(workspace, ["add", "first.txt"]);

      const report = await getGitDiffReport(workspace);

      expect(report.repository).toBe(true);
      expect(report.files).toEqual([
        expect.objectContaining({ path: "first.txt", kind: "added", additions: 1, deletions: 0 }),
      ]);
      await expect(getGitFileDiff(workspace, "first.txt")).resolves.toContain("+first line");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects diff paths that escape the workspace", async () => {
    const workspace = await createRepository();
    try {
      await expect(getGitFileDiff(workspace, "../outside.txt")).resolves.toBe("无法查看工作区之外的文件。");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
