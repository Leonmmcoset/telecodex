import {
  formatTaskCancelledNotification,
  formatTaskCompletionNotification,
  formatTaskDuration,
  formatTaskFailureNotification,
  formatReplyContext,
  formatUsageSummary,
  formatToolSummaryLine,
  formatTurnUsageLine,
  selectTaskGitChanges,
  summarizeToolName,
} from "../src/bot.js";

describe("tool summary formatting", () => {
  it("normalizes raw tool names into compact summary categories", () => {
    expect(summarizeToolName("ls -la")).toBe("bash");
    expect(summarizeToolName("🔍 latest codex release")).toBe("web_fetch");
    expect(summarizeToolName("mcp:codex_apps/spawn_agent")).toBe("subagent");
    expect(summarizeToolName("mcp:codex_apps/github_fetch")).toBe("github_fetch");
    expect(summarizeToolName("file_change")).toBe("file_change");
  });

  it("formats a short summary line with grouped counts", () => {
    const toolCounts = new Map<string, number>([
      ["ls -la", 2],
      ["git status", 1],
      ["mcp:codex_apps/spawn_agent", 2],
      ["🔍 latest codex release", 1],
    ]);

    expect(formatToolSummaryLine(toolCounts)).toBe(
      "已使用工具：3x bash, 2x subagents, web_fetch",
    );
  });

  it("keeps the turn usage line format stable when enabled", () => {
    expect(
      formatTurnUsageLine({
        inputTokens: 12,
        cachedInputTokens: 3,
        outputTokens: 9,
      }),
    ).toBe("🪙 输入：12 · 缓存：3 · 输出：9");
  });

  it("formats task durations and terminal notifications", () => {
    expect(formatTaskDuration(138_000)).toBe("2 分 18 秒");
    expect(formatTaskDuration(3_600_000)).toBe("1 小时");
    expect(formatTaskCompletionNotification(138_000, {
      inputTokens: 12400,
      cachedInputTokens: 8100,
      outputTokens: 2300,
    })).toBe([
      "✅ 任务已完成",
      "⏱️ 耗时：2 分 18 秒",
      "🪙 输入：12400 · 缓存：8100 · 输出：2300",
    ].join("\n"));
    expect(formatTaskCompletionNotification(0)).toBe("✅ 任务已完成\n⏱️ 耗时：0 秒");
    expect(formatTaskFailureNotification(1_000, "执行失败")).toContain("❌ 任务执行失败");
    expect(formatTaskCancelledNotification(1_000)).toBe("⏹️ 任务已取消\n⏱️ 已运行：1 秒");
  });

  it("formats reply context for text and attachment messages", () => {
    expect(formatReplyContext({
      message_id: 42,
      from: { username: "alice" },
      text: "请检查这个问题",
    })).toContain("发送者：@alice");
    expect(formatReplyContext({
      message_id: 7,
      document: { file_name: "report.pdf" },
    })).toContain("内容：文件：report.pdf");
  });

  it("selects only files changed since a task baseline", () => {
    const baseline = {
      repository: true,
      branch: "main",
      additions: 2,
      deletions: 0,
      files: [
        { path: "stable.ts", kind: "modified" as const, additions: 2, deletions: 0, signature: "before" },
      ],
    };
    const report = {
      ...baseline,
      files: [
        { path: "stable.ts", kind: "modified" as const, additions: 2, deletions: 0, signature: "before" },
        { path: "new.ts", kind: "added" as const, additions: 4, deletions: 0, signature: "new" },
      ],
    };

    expect(selectTaskGitChanges(baseline, report).map((file) => file.path)).toEqual(["new.ts"]);
    expect(formatUsageSummary("最近 24 小时", {
      taskCount: 2,
      inputTokens: 10,
      cachedInputTokens: 3,
      outputTokens: 5,
    })).toContain("任务轮次：2");
  });
});
