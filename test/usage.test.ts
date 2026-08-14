import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { UsageStore } from "../src/usage.js";

describe("UsageStore", () => {
  it("persists token records and summarizes the requested period", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "telecodex-usage-"));
    const now = 1_800_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const store = new UsageStore(workspace);
      store.record("chat:1", { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 });
      store.record("chat:2", { inputTokens: 7, cachedInputTokens: 2, outputTokens: 5 });

      const persistedStore = new UsageStore(workspace);
      expect(persistedStore.summarizeSince(now - 24 * 60 * 60 * 1000)).toEqual({
        taskCount: 2,
        inputTokens: 17,
        cachedInputTokens: 6,
        outputTokens: 8,
      });
    } finally {
      dateNow.mockRestore();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("removes an expired history before persisting new usage", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "telecodex-usage-"));
    const then = 1_700_000_000_000;
    const now = then + 91 * 24 * 60 * 60 * 1000;
    const dateNow = vi.spyOn(Date, "now");
    try {
      dateNow.mockReturnValue(then);
      const store = new UsageStore(workspace);
      store.record("old", { inputTokens: 1, cachedInputTokens: 1, outputTokens: 1 });

      dateNow.mockReturnValue(now);
      const reloadedStore = new UsageStore(workspace);
      reloadedStore.record("new", { inputTokens: 2, cachedInputTokens: 2, outputTokens: 2 });

      expect(new UsageStore(workspace).summarizeSince(0)).toEqual({
        taskCount: 1,
        inputTokens: 2,
        cachedInputTokens: 2,
        outputTokens: 2,
      });
    } finally {
      dateNow.mockRestore();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
