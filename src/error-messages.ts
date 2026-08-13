/**
 * Translate raw errors into user-friendly Telegram messages.
 * Raw details are preserved for console logging only.
 */

export interface FriendlyError {
  userMessage: string;
  logMessage: string;
}

const ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /ECONNREFUSED|ENOTFOUND|ENETUNREACH|fetch failed/i,
    message: "无法连接到 Codex API，请检查网络连接。",
  },
  {
    pattern: /429|rate.?limit|too many requests/i,
    message: "请求过于频繁，请稍后再试。",
  },
  {
    pattern: /401|unauthorized|authentication|invalid.*api.?key/i,
    message: "认证失败。请使用 /login 重新认证，或检查 API 密钥。",
  },
  {
    pattern: /403|forbidden|permission/i,
    message: "访问被拒绝，请检查 API 密钥权限。",
  },
  {
    pattern: /404.*model|model.*not.*found|invalid.*model|model.*does not exist/i,
    message: "模型不可用，请使用 /model 选择其他模型。",
  },
  {
    pattern: /timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i,
    message: "请求超时。请尝试更短的提问，或使用 /retry 重试。",
  },
  {
    pattern: /500|internal.?server.?error/i,
    message: "API 返回服务器错误，请稍后重试。",
  },
  {
    pattern: /502|503|504|bad.?gateway|service.?unavailable/i,
    message: "API 暂时不可用，请稍后重试。",
  },
  {
    pattern: /context.?length|token.?limit|too.?long/i,
    message: "对话内容超出当前模型的上下文限制，请使用 /new 新建会话。",
  },
  {
    pattern: /^(?:AbortError|The operation was aborted)/i,
    message: "⏹ 已取消",
  },
];

export function translateError(error: unknown): FriendlyError {
  const raw = extractRawMessage(error);
  const logMessage = raw;

  for (const { pattern, message } of ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return { userMessage: message, logMessage };
    }
  }

  const cleaned = stripStackTrace(raw);
  return { userMessage: cleaned, logMessage };
}

export function friendlyErrorText(error: unknown): string {
  return translateError(error).userMessage;
}

function extractRawMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: Error }).cause;
    const base = error.message || String(error);
    return cause?.message ? `${base}: ${cause.message}` : base;
  }

  return String(error);
}

function stripStackTrace(message: string): string {
  // Remove stack frame lines (lines starting with "at ")
  const lines = message.split("\n").filter((line) => !line.trim().startsWith("at "));
  return lines.join("\n").trim() || message.trim();
}
