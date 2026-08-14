import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface UsageRecord {
  timestamp: number;
  contextKey: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface UsageSummary {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  taskCount: number;
}

export class UsageStore {
  private readonly records: UsageRecord[];
  private readonly persistPath: string;

  constructor(workspace: string) {
    this.persistPath = path.join(workspace, ".telecodex", "usage.json");
    this.records = this.load();
  }

  record(contextKey: string, usage: Omit<UsageRecord, "timestamp" | "contextKey">): void {
    this.records.push({ timestamp: Date.now(), contextKey, ...usage });
    this.prune();
    this.persist();
  }

  summarizeSince(startTimestamp: number): UsageSummary {
    const summary: UsageSummary = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, taskCount: 0 };
    for (const record of this.records) {
      if (record.timestamp < startTimestamp) continue;
      summary.inputTokens += record.inputTokens;
      summary.cachedInputTokens += record.cachedInputTokens;
      summary.outputTokens += record.outputTokens;
      summary.taskCount += 1;
    }
    return summary;
  }

  private load(): UsageRecord[] {
    try {
      if (!existsSync(this.persistPath)) return [];
      const parsed = JSON.parse(readFileSync(this.persistPath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isUsageRecord);
    } catch {
      return [];
    }
  }

  private prune(): void {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const firstKept = this.records.findIndex((record) => record.timestamp >= cutoff);
    if (firstKept === -1) {
      this.records.splice(0);
      return;
    }
    if (firstKept > 0) this.records.splice(0, firstKept);
  }

  private persist(): void {
    try {
      const directory = path.dirname(this.persistPath);
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.records, null, 2), "utf8");
    } catch (error) {
      console.warn("保存 token 用量失败：", error instanceof Error ? error.message : String(error));
    }
  }
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<UsageRecord>;
  return typeof record.timestamp === "number"
    && typeof record.contextKey === "string"
    && typeof record.inputTokens === "number"
    && typeof record.cachedInputTokens === "number"
    && typeof record.outputTokens === "number";
}
