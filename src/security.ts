import type { TeleCodexConfig } from "./config.js";
import type { CodexSessionInfo } from "./codex-session.js";

export interface SecurityReport {
  html: string;
  plain: string;
}

export function renderSecurityReport(config: TeleCodexConfig, info: CodexSessionInfo): SecurityReport {
  const risk = info.unsafeLaunch || info.sandboxMode === "danger-full-access" ? "高" : info.sandboxMode === "workspace-write" ? "中" : "低";
  const detailLines = [
    "🔐 当前安全配置",
    `风险等级：${risk}`,
    `工作区：${info.workspace}`,
    `启动配置：${info.launchProfileLabel}`,
    `沙箱：${info.sandboxMode}`,
    `审批策略：${info.approvalPolicy}`,
    `当前配置：${info.unsafeLaunch ? "danger-full-access" : "受限"}`,
    `允许 Telegram 用户：${config.telegramAllowedUserIds.length} 个`,
    `Telegram 登录：${config.enableTelegramLogin ? "已开启" : "已关闭"}`,
    `不安全启动配置：${config.enableUnsafeLaunchProfiles ? "允许" : "未允许"}`,
  ];
  const plain = detailLines.join("\n");
  const html = [
    "<b>🔐 当前安全配置</b>",
    `<b>风险等级：</b>${risk}`,
    `<b>工作区：</b><code>${escapeHtml(info.workspace)}</code>`,
    `<b>启动配置：</b><code>${escapeHtml(info.launchProfileLabel)}</code>`,
    `<b>沙箱：</b><code>${escapeHtml(info.sandboxMode)}</code>`,
    `<b>审批策略：</b><code>${escapeHtml(info.approvalPolicy)}</code>`,
    `<b>当前配置：</b>${info.unsafeLaunch ? "<b>danger-full-access</b>" : "受限"}`,
    `<b>允许 Telegram 用户：</b>${config.telegramAllowedUserIds.length} 个`,
    `<b>Telegram 登录：</b>${config.enableTelegramLogin ? "已开启" : "已关闭"}`,
    `<b>不安全启动配置：</b>${config.enableUnsafeLaunchProfiles ? "允许" : "未允许"}`,
  ].join("\n");
  return { html, plain };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
