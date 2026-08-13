import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensureWorkspaceDirectory, normalizeWorkspacePath } from "../src/workspace.js";

describe("workspace helpers", () => {
  it("accepts Windows drive-letter paths", () => {
    expect(normalizeWorkspacePath("C:\\Projects\\demo")).toBe(path.normalize("C:\\Projects\\demo"));
    expect(normalizeWorkspacePath("D:/")).toBe(path.normalize("D:/"));
  });

  it("accepts root paths", () => {
    expect(normalizeWorkspacePath("/")).toBe(path.normalize("/"));
    expect(normalizeWorkspacePath("\\")).toBe(path.normalize("\\"));
  });

  it("rejects relative paths", () => {
    expect(() => normalizeWorkspacePath("projects/demo")).toThrow("绝对路径");
  });

  it("creates a missing directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telecodex-workspace-"));
    const target = path.join(root, "nested", "workspace");
    try {
      await expect(ensureWorkspaceDirectory(target)).resolves.toBe(path.normalize(target));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an existing file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telecodex-workspace-"));
    const target = path.join(root, "file.txt");
    await writeFile(target, "not a directory");
    try {
      await expect(ensureWorkspaceDirectory(target)).rejects.toThrow("不是文件夹");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
