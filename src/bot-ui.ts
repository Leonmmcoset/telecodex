import { escapeHTML } from "./format.js";

export interface DualText {
  html: string;
  plain: string;
}

/**
 * Grouped command reference for /help.
 */
export function renderHelpMessage(): DualText {
  const sections = [
    {
      title: "💬 会话",
      commands: [
        ["/new", "新建会话"],
        ["/plan", "切换 Plan Mode"],
        ["/session", "查看当前会话详情"],
        ["/sessions", "浏览并切换会话"],
        ["/attach", "将 Codex 会话绑定到当前话题"],
        ["/handback", "将会话交还给 Codex CLI"],
        ["/abort", "取消当前操作"],
        ["/retry", "重新发送上一条提问"],
      ],
    },
    {
      title: "🤖 模型",
      commands: [
        ["/launch_profiles", "选择启动配置"],
        ["/model", "查看并切换模型"],
        ["/effort", "设置推理强度"],
      ],
    },
    {
      title: "🔐 认证",
      commands: [
        ["/auth", "检查认证状态"],
        ["/login", "开始认证"],
        ["/logout", "退出登录"],
      ],
    },
    {
      title: "ℹ️ 工具",
      commands: [
        ["/start", "欢迎与状态"],
        ["/help", "查看命令说明"],
        ["/voice", "查看语音转写状态"],
      ],
    },
  ];

  const htmlLines: string[] = [];
  const plainLines: string[] = [];

  for (const section of sections) {
    htmlLines.push(`<b>${escapeHTML(section.title)}</b>`);
    plainLines.push(section.title);
    for (const [cmd, desc] of section.commands) {
      htmlLines.push(`  ${cmd}：${escapeHTML(desc)}`);
      plainLines.push(`  ${cmd}：${desc}`);
    }
    htmlLines.push("");
    plainLines.push("");
  }

  while (htmlLines.at(-1) === "") {
    htmlLines.pop();
  }
  while (plainLines.at(-1) === "") {
    plainLines.pop();
  }

  return {
    html: htmlLines.join("\n"),
    plain: plainLines.join("\n"),
  };
}

/**
 * Short /start message for first-time users (no prior interaction in this context).
 */
export function renderWelcomeFirstTime(authWarning?: string): DualText {
  const htmlLines = [
    "<b>👋 TeleCodex 已就绪。</b>",
    "",
    "发送消息即可开始与 Codex 对话。",
    "也可以发送语音、图片或文件。",
    "",
    "输入 /help 查看全部命令。",
  ];
  const plainLines = [
    "👋 TeleCodex 已就绪。",
    "",
    "发送消息即可开始与 Codex 对话。",
    "也可以发送语音、图片或文件。",
    "",
    "输入 /help 查看全部命令。",
  ];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Concise /start message for returning users with session info.
 */
export function renderWelcomeReturning(
  sessionHtml: string,
  sessionPlain: string,
  isTopicSession: boolean,
  authWarning?: string,
): DualText {
  const label = isTopicSession ? "TeleCodex（话题会话）" : "TeleCodex";

  const htmlLines = [`<b>👋 ${escapeHTML(label)}</b>`, "", sessionHtml];
  const plainLines = [`👋 ${label}`, "", sessionPlain];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Format a session button label for /sessions list.
 * Wider workspace name (12 chars), model tag, short thread snippet.
 */
export function formatSessionLabel(
  options: {
    workspace: string;
    title: string;
    relativeTime: string;
    model?: string;
    isActive: boolean;
  },
): string {
  const prefix = options.isActive ? "✅" : "📁";
  const workspaceName = trimLabel(getWorkspaceShortName(options.workspace), 12) || "（未知）";
  const title = trimLabel(options.title || "（未命名）", 20) || "（未命名）";
  const time = options.relativeTime;

  let label = `${prefix} ${workspaceName} · ${title} · ${time}`;

  if (options.model) {
    const shortModel = trimLabel(options.model, 10);
    label += ` · ${shortModel}`;
  }

  return label;
}

function trimLabel(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}
