import { describe, expect, it } from "vitest";

import type { CodexSessionInfo } from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";
import { renderSecurityReport } from "../src/security.js";

const config: TeleCodexConfig = {
  telegramBotToken: "token",
  telegramAllowedUserIds: [1, 2],
  telegramAllowedUserIdSet: new Set([1, 2]),
  workspace: "/workspace",
  maxFileSize: 1,
  codexSandboxMode: "workspace-write",
  codexApprovalPolicy: "never",
  launchProfiles: [],
  defaultLaunchProfileId: "default",
  enableUnsafeLaunchProfiles: false,
  toolVerbosity: "summary",
  showTurnTokenUsage: false,
  enableTelegramLogin: true,
  enableTelegramReactions: false,
};

const sessionInfo: CodexSessionInfo = {
  threadId: "thread-1",
  workspace: "/workspace/<unsafe>",
  launchProfileId: "default",
  launchProfileLabel: "Default",
  launchProfileBehavior: "workspace-write · never",
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  unsafeLaunch: false,
};

describe("security report", () => {
  it("renders low-risk session details and escapes workspace HTML", () => {
    const report = renderSecurityReport(config, sessionInfo);

    expect(report.plain).toContain("风险等级：中");
    expect(report.plain).toContain("允许 Telegram 用户：2 个");
    expect(report.html).toContain("/workspace/&lt;unsafe&gt;");
  });

  it("marks danger-full-access launch profiles as high risk", () => {
    const report = renderSecurityReport(config, {
      ...sessionInfo,
      sandboxMode: "danger-full-access",
      unsafeLaunch: true,
    });

    expect(report.plain).toContain("风险等级：高");
    expect(report.html).toContain("<b>danger-full-access</b>");
  });
});
