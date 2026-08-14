import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";

import {
  buildFileInstructions,
  cleanupInbox,
  outboxPath,
  stageFile,
  type StagedFile,
} from "./attachments.js";
import { collectArtifactReport, ensureOutDir, formatArtifactSummary } from "./artifacts.js";
import {
  formatSessionLabel,
  renderHelpMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "./bot-ui.js";
import {
  type CodexPromptInput,
  type CodexSessionCallbacks,
  type CodexSessionInfo,
  type CodexSessionService,
} from "./codex-session.js";
import type {
  AppServerApprovalRequest,
  AppServerPlanUpdate,
  AppServerUserInputRequest,
  AppServerUserInputQuestion,
} from "./codex-app-server.js";
import { checkAuthStatus, clearAuthCache, startLogin, startLogout } from "./codex-auth.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  formatLaunchProfileLabel,
} from "./codex-launch.js";
import { getThread } from "./codex-state.js";
import type { TeleCodexConfig, ToolVerbosity } from "./config.js";
import { contextKeyFromCtx, isTopicContextKey, parseContextKey, type TelegramContextKey } from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML, formatTelegramHTML } from "./format.js";
import {
  getGitDiffReport,
  getGitFileDiff,
  getGitLog,
  getGitRemotes,
  getGitStatus,
  type GitDiffReport,
  type GitFileChange,
} from "./git.js";
import { SessionRegistry } from "./session-registry.js";
import { renderSecurityReport } from "./security.js";
import { UsageStore, type UsageSummary } from "./usage.js";
import { getAvailableBackends, transcribeAudio } from "./voice.js";
import { ensureWorkspaceDirectory } from "./workspace.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const TYPING_INTERVAL_MS = 4500;
const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const FORMATTED_CHUNK_TARGET = 3000;
const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;
const KEYBOARD_PAGE_SIZE = 6;
const NOOP_PAGE_CALLBACK_DATA = "noop_page";
const LAUNCH_PROFILES_COMMAND = "/launch_profiles";
const TELEGRAM_API_TIMEOUT_SECONDS = 40;

type TelegramChatId = number | string;
type TelegramParseMode = "HTML";
type KeyboardItem = { label: string; callbackData: string };

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
};

type RenderedText = {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
};

type RenderedChunk = RenderedText & {
  sourceText: string;
};

type PendingPlanAction = {
  contextKey: TelegramContextKey;
  messageId: number;
  confirm?: () => Promise<void>;
  steer: (text: string) => Promise<void>;
  cancel: () => Promise<void>;
  regenerate?: () => Promise<void>;
};

type PlanActionHandlers = Omit<PendingPlanAction, "contextKey" | "messageId">;

type PendingPlanInput = {
  contextKey: TelegramContextKey;
  chatId: TelegramChatId;
  messageThreadId?: number;
  question: AppServerUserInputQuestion;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

type PendingPlanDecision = {
  contextKey: TelegramContextKey;
  request: AppServerApprovalRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type PlanMessage = {
  actionId: string;
  messageId: number;
};

type TaskStatus = "planning" | "awaitingConfirmation" | "running" | "reconnecting" | "completed" | "failed" | "cancelled";

type TaskMode = "default" | "plan" | "planExecution";

type TaskUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

type TaskState = {
  status: TaskStatus;
  mode: TaskMode;
  chatId: TelegramChatId;
  messageThreadId?: number;
  startedAt: number;
  finishedAt?: number;
  currentStep?: string;
  progress: number;
  usage?: TaskUsage;
  cancellationRequested?: boolean;
  terminalNotified: boolean;
  workspace: string;
  gitBaseline?: GitDiffReport;
  usageRecorded?: boolean;
};

export function formatTaskDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [hours > 0 ? `${hours} 小时` : undefined, minutes > 0 ? `${minutes} 分` : undefined, seconds > 0 || hours === 0 && minutes === 0 ? `${seconds} 秒` : undefined];
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

export function formatTaskCompletionNotification(durationMs: number, usage?: TaskUsage): string {
  return [
    "✅ 任务已完成",
    `⏱️ 耗时：${formatTaskDuration(durationMs)}`,
    usage ? formatTurnUsageLine(usage) : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function formatTaskFailureNotification(durationMs: number, reason: string): string {
  return [
    "❌ 任务执行失败",
    `⏱️ 耗时：${formatTaskDuration(durationMs)}`,
    `📝 原因：${reason}`,
  ].join("\n");
}

export function formatTaskCancelledNotification(durationMs: number): string {
  return ["⏹️ 任务已取消", `⏱️ 已运行：${formatTaskDuration(durationMs)}`].join("\n");
}

export function selectTaskGitChanges(
  baseline: GitDiffReport | undefined,
  report: GitDiffReport,
): GitFileChange[] {
  const before = new Map((baseline?.files ?? []).map((file) => [file.path, file.signature]));
  return report.files.filter((file) => before.get(file.path) !== file.signature);
}

export function formatGitChangeIcon(kind: GitFileChange["kind"]): string {
  switch (kind) {
    case "added":
    case "untracked":
      return "➕";
    case "deleted":
      return "➖";
    case "renamed":
      return "🔁";
    default:
      return "✏️";
  }
}

export function formatUsageSummary(label: string, summary: UsageSummary): string {
  return [
    `🪙 ${label} token 用量`,
    `任务轮次：${summary.taskCount}`,
    `输入：${summary.inputTokens} · 缓存：${summary.cachedInputTokens} · 输出：${summary.outputTokens}`,
  ].join("\n");
}

type ReferencedTelegramMessage = {
  message_id: number;
  from?: { first_name?: string; username?: string };
  text?: string;
  caption?: string;
  photo?: unknown[];
  document?: { file_name?: string };
  voice?: unknown;
  audio?: unknown;
  video?: unknown;
  sticker?: unknown;
};

export function formatReplyContext(message: ReferencedTelegramMessage | undefined): string | undefined {
  if (!message) return undefined;
  const sender = message.from?.username
    ? `@${message.from.username}`
    : message.from?.first_name ?? "未知发送者";
  const content = message.text?.trim() || message.caption?.trim() || describeReferencedMessage(message);
  return [
    "用户回复了以下 Telegram 消息，请将其作为上下文引用：",
    `- 消息 ID：${message.message_id}`,
    `- 发送者：${sender}`,
    `- 内容：${trimLine(content, 2_000)}`,
    "",
    "用户当前请求如下：",
  ].join("\n");
}

function describeReferencedMessage(message: ReferencedTelegramMessage): string {
  if (message.document) return `文件：${message.document.file_name ?? "未命名文件"}`;
  if (message.photo?.length) return "图片消息";
  if (message.voice) return "语音消息";
  if (message.audio) return "音频消息";
  if (message.video) return "视频消息";
  if (message.sticker) return "贴纸消息";
  return "非文本 Telegram 消息";
}

function withReplyContext(input: CodexPromptInput, context: string | undefined): CodexPromptInput {
  if (!context) return input;
  if (typeof input === "string") {
    return `${context}\n${input}`;
  }
  return {
    ...input,
    text: [context, input.text].filter((part): part is string => Boolean(part?.trim())).join("\n"),
  };
}

function paginateKeyboard(items: KeyboardItem[], page: number, prefix: string): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(items.length / KEYBOARD_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = currentPage * KEYBOARD_PAGE_SIZE;
  const pageItems = items.slice(start, start + KEYBOARD_PAGE_SIZE);
  const keyboard = new InlineKeyboard();

  pageItems.forEach((item, index) => {
    keyboard.text(item.label, item.callbackData);
    if (index < pageItems.length - 1 || totalPages > 1) {
      keyboard.row();
    }
  });

  if (totalPages > 1) {
    if (currentPage > 0) {
      keyboard.text("◀️ 上一页", `${prefix}_page_${currentPage - 1}`);
    }
    keyboard.text(`${currentPage + 1}/${totalPages}`, NOOP_PAGE_CALLBACK_DATA);
    if (currentPage < totalPages - 1) {
      keyboard.text("下一页 ▶️", `${prefix}_page_${currentPage + 1}`);
    }
  }

  return keyboard;
}

export function createBot(config: TeleCodexConfig, registry: SessionRegistry): Bot<Context> {
  const bot = new Bot<Context>(config.telegramBotToken, {
    client: { timeoutSeconds: TELEGRAM_API_TIMEOUT_SECONDS },
  });
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));
  const contextBusy = new Map<
    TelegramContextKey,
    { processing: boolean; switching: boolean; transcribing: boolean }
  >();
  const pendingSessionPicks = new Map<TelegramContextKey, string[]>();
  const pendingWorkspacePicks = new Map<TelegramContextKey, string[]>();
  const pendingSessionButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingWorkspaceButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingLaunchPicks = new Map<TelegramContextKey, string[]>();
  const pendingLaunchButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingUnsafeLaunchConfirmations = new Map<TelegramContextKey, string>();
  const pendingModelButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingEffortButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingPlanActions = new Map<string, PendingPlanAction>();
  const pendingPlanInputs = new Map<string, PendingPlanInput>();
  const pendingPlanDecisions = new Map<string, PendingPlanDecision>();
  const pendingPlanSteers = new Map<TelegramContextKey, PendingPlanAction>();
  const pendingPlanTextRequests = new Map<TelegramContextKey, string>();
  const planModeContexts = new Set<TelegramContextKey>();
  const planMessages = new Map<TelegramContextKey, PlanMessage>();
  const planRenderQueues = new Map<TelegramContextKey, Promise<void>>();
  const pendingWorkspacePathRequests = new Set<TelegramContextKey>();
  const lastPromptInput = new Map<TelegramContextKey, CodexPromptInput>();
  const taskStates = new Map<TelegramContextKey, TaskState>();
  const usageStore = new UsageStore(config.workspace);
  const pendingGitDiffs = new Map<string, { workspace: string; filePath: string; chatId: TelegramChatId; messageThreadId?: number }>();

  registry.onRemove((key) => {
    contextBusy.delete(key);
    pendingLaunchPicks.delete(key);
    pendingLaunchButtons.delete(key);
    pendingUnsafeLaunchConfirmations.delete(key);
    pendingWorkspacePathRequests.delete(key);
    pendingPlanSteers.delete(key);
    pendingPlanTextRequests.delete(key);
    planModeContexts.delete(key);
    planMessages.delete(key);
    planRenderQueues.delete(key);
    for (const [requestId, request] of pendingPlanInputs.entries()) {
      if (request.contextKey === key) {
        request.reject(new Error("会话已关闭。"));
        pendingPlanInputs.delete(requestId);
      }
    }
    for (const [actionId, decision] of pendingPlanDecisions.entries()) {
      if (decision.contextKey === key) {
        decision.reject(new Error("会话已关闭。"));
        pendingPlanDecisions.delete(actionId);
      }
    }
    for (const [actionId, action] of pendingPlanActions.entries()) {
      if (action.contextKey === key) pendingPlanActions.delete(actionId);
    }
    lastPromptInput.delete(key);
    taskStates.delete(key);
    for (const [id, pending] of pendingGitDiffs.entries()) {
      if (pending.chatId === parseContextKey(key).chatId) pendingGitDiffs.delete(id);
    }
  });

  const getBusyState = (
    contextKey: TelegramContextKey,
  ): { processing: boolean; switching: boolean; transcribing: boolean } => {
    let state = contextBusy.get(contextKey);
    if (!state) {
      state = { processing: false, switching: false, transcribing: false };
      contextBusy.set(contextKey, state);
    }
    return state;
  };

  const isBusy = (contextKey: TelegramContextKey): boolean => {
    const state = contextBusy.get(contextKey);
    const session = registry.get(contextKey);
    return Boolean(state?.processing || state?.switching || state?.transcribing || session?.isProcessing());
  };

  const beginTask = (
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    messageThreadId: number | undefined,
    mode: TaskMode,
    status: TaskStatus = "running",
  ): TaskState => {
    const task: TaskState = {
      status,
      mode,
      chatId,
      messageThreadId,
      startedAt: Date.now(),
      progress: 0,
      terminalNotified: false,
      workspace: registry.get(contextKey)?.getCurrentWorkspace() ?? config.workspace,
    };
    taskStates.set(contextKey, task);
    return task;
  };

  const updateTask = (contextKey: TelegramContextKey, patch: Partial<TaskState>): TaskState | undefined => {
    const task = taskStates.get(contextKey);
    if (!task) return undefined;
    Object.assign(task, patch);
    return task;
  };

  const recordTaskUsage = (contextKey: TelegramContextKey): void => {
    const task = taskStates.get(contextKey);
    if (!task?.usage || task.usageRecorded) return;
    usageStore.record(contextKey, task.usage);
    task.usageRecorded = true;
  };

  const sendTaskNotification = async (
    contextKey: TelegramContextKey,
    status: "completed" | "failed" | "cancelled",
    reason?: string,
  ): Promise<void> => {
    const task = taskStates.get(contextKey);
    if (!task || task.terminalNotified) return;

    task.status = status;
    task.finishedAt = Date.now();
    task.terminalNotified = true;
    recordTaskUsage(contextKey);
    const durationMs = task.finishedAt - task.startedAt;
    const text = status === "completed"
      ? formatTaskCompletionNotification(durationMs, task.usage)
      : status === "cancelled"
        ? formatTaskCancelledNotification(durationMs)
        : formatTaskFailureNotification(durationMs, reason ?? "未知错误");

    await sendTextMessage(bot.api, task.chatId, text, {
      fallbackText: text,
      ...(task.messageThreadId ? { messageThreadId: task.messageThreadId } : {}),
    }).catch((error) => console.error("发送任务状态通知失败", error));
    await sendGitDiffSummary(contextKey);
  };

  const markTaskCancelled = async (contextKey: TelegramContextKey): Promise<void> => {
    const task = taskStates.get(contextKey);
    if (!task || task.terminalNotified) return;
    task.cancellationRequested = true;
    await sendTaskNotification(contextKey, "cancelled");
  };

  const captureTaskGitBaseline = async (contextKey: TelegramContextKey): Promise<void> => {
    const task = taskStates.get(contextKey);
    if (!task) return;
    task.gitBaseline = await getGitDiffReport(task.workspace).catch(() => undefined);
  };

  const sendGitDiffSummary = async (contextKey: TelegramContextKey): Promise<void> => {
    const task = taskStates.get(contextKey);
    if (!task) return;
    const report = await getGitDiffReport(task.workspace).catch(() => undefined);
    if (!report?.repository) return;

    const changes = selectTaskGitChanges(task.gitBaseline, report);
    if (changes.length === 0) return;

    const keyboard = new InlineKeyboard();
    const additions = changes.reduce((sum, file) => sum + file.additions, 0);
    const deletions = changes.reduce((sum, file) => sum + file.deletions, 0);
    const htmlLines = [
      "🧾 <b>本次任务文件变更</b>",
      `<b>分支：</b><code>${escapeHTML(report.branch)}</code>`,
      `<b>文件：</b>${changes.length} 个 · <b>新增：</b>${additions} 行 · <b>删除：</b>${deletions} 行`,
      "",
    ];
    const plainLines = [
      "🧾 本次任务文件变更",
      `分支：${report.branch}`,
      `文件：${changes.length} 个 · 新增：${additions} 行 · 删除：${deletions} 行`,
      "",
    ];

    for (const file of changes.slice(0, 20)) {
      const callbackId = randomUUID().slice(0, 12);
      pendingGitDiffs.set(callbackId, {
        workspace: task.workspace,
        filePath: file.path,
        chatId: task.chatId,
        messageThreadId: task.messageThreadId,
      });
      const line = `${formatGitChangeIcon(file.kind)} ${file.path} · +${file.additions} -${file.deletions}`;
      htmlLines.push(`${formatGitChangeIcon(file.kind)} <code>${escapeHTML(file.path)}</code> · +${file.additions} -${file.deletions}`);
      plainLines.push(line);
      keyboard.text(`查看 ${trimLine(file.path, 32)}`, `git_diff_file:${callbackId}`).row();
    }
    if (changes.length > 20) {
      htmlLines.push(`……还有 ${changes.length - 20} 个文件未显示。`);
      plainLines.push(`……还有 ${changes.length - 20} 个文件未显示。`);
    }

    await sendTextMessage(bot.api, task.chatId, htmlLines.join("\n"), {
      parseMode: "HTML",
      fallbackText: plainLines.join("\n"),
      replyMarkup: keyboard,
      ...(task.messageThreadId ? { messageThreadId: task.messageThreadId } : {}),
    }).catch((error) => console.error("发送 Git diff 摘要失败", error));
  };

  const updateTaskFromPlan = (contextKey: TelegramContextKey, update: AppServerPlanUpdate): void => {
    const total = update.plan.length;
    const completed = update.plan.filter((step) => step.status === "completed").length;
    const current = update.plan.find((step) => step.status === "inProgress") ?? update.plan.find((step) => step.status !== "completed");
    updateTask(contextKey, {
      currentStep: current?.step,
      progress: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0,
    });
  };

  const formatTaskStatusMessage = (task: TaskState | undefined): { html: string; plain: string } => {
    if (!task) {
      return { html: "ℹ️ 当前没有正在执行的任务。", plain: "ℹ️ 当前没有正在执行的任务。" };
    }
    const labels: Record<TaskStatus, string> = {
      planning: "制定计划",
      awaitingConfirmation: "等待确认",
      running: "执行中",
      reconnecting: "重新连接中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
    };
    const durationMs = (task.finishedAt ?? Date.now()) - task.startedAt;
    const lines = [
      "📊 当前任务状态",
      `状态：${labels[task.status]}`,
      task.currentStep ? `📌 当前步骤：${task.currentStep}` : undefined,
      `📈 进度：${task.progress}%`,
      `⏱️ ${task.status === "running" || task.status === "reconnecting" || task.status === "planning" ? "已耗时" : "耗时"}：${formatTaskDuration(durationMs)}`,
      task.usage ? formatTurnUsageLine(task.usage) : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n");
    return { html: formatTelegramHTML(lines), plain: lines };
  };

  const getContextSession = async (
    ctx: Context,
    options?: { deferThreadStart?: boolean },
  ): Promise<{ contextKey: TelegramContextKey; session: CodexSessionService } | null> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return null;
    }

    const session = await registry.getOrCreate(contextKey, options);
    return { contextKey, session };
  };

  const updateSessionMetadata = (contextKey: TelegramContextKey, session: CodexSessionService): void => {
    registry.updateMetadata(contextKey, session);
  };

  const isTopicContext = (contextKey: TelegramContextKey): boolean => isTopicContextKey(contextKey);

  const clearLaunchSelectionState = (contextKey: TelegramContextKey): void => {
    pendingLaunchPicks.delete(contextKey);
    pendingLaunchButtons.delete(contextKey);
    pendingUnsafeLaunchConfirmations.delete(contextKey);
  };

  const clearPlanInteractionState = (contextKey: TelegramContextKey, error?: Error): void => {
    pendingPlanSteers.delete(contextKey);
    pendingPlanTextRequests.delete(contextKey);
    const planMessage = planMessages.get(contextKey);
    if (planMessage) pendingPlanActions.delete(planMessage.actionId);
    planMessages.delete(contextKey);

    for (const [requestId, request] of pendingPlanInputs.entries()) {
      if (request.contextKey === contextKey) {
        pendingPlanInputs.delete(requestId);
        if (error) request.reject(error);
      }
    }
    for (const [actionId, decision] of pendingPlanDecisions.entries()) {
      if (decision.contextKey === contextKey) {
        pendingPlanDecisions.delete(actionId);
        if (error) decision.reject(error);
      }
    }
    for (const [actionId, action] of pendingPlanActions.entries()) {
      if (action.contextKey === contextKey) pendingPlanActions.delete(actionId);
    }
  };

  const handlePageCallback = (
    pattern: RegExp,
    prefix: string,
    buttonsMap: Map<TelegramContextKey, KeyboardItem[]>,
    expiredMessage: string,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      const ctxKey = contextKeyFromCtx(ctx);
      const messageId = ctx.callbackQuery.message?.message_id;
      const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
      if (!ctxKey || !messageId || Number.isNaN(page)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const buttons = buttonsMap.get(ctxKey);
      if (!buttons) {
        await ctx.answerCallbackQuery({ text: expiredMessage });
        return;
      }
      await ctx.answerCallbackQuery();
      try {
        const keyboard = paginateKeyboard(buttons, page, prefix);
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: keyboard });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error(`Failed to update ${prefix} keyboard page`, error);
        }
      }
    });
  };

  const sendBusyReply = async (ctx: Context): Promise<void> => {
    await safeReply(ctx, escapeHTML("上一条消息仍在处理中，请稍候……"), {
      fallbackText: "上一条消息仍在处理中，请稍候……",
    });
  };

  const setReaction = async (ctx: Context, emoji: "👀" | "👍" | "❤" | "🔥" | "👏"): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
    } catch {
      // Reactions may not be available in all chats — fail silently.
    }
  };

  const clearReaction = async (ctx: Context): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, []);
    } catch {
      // Fail silently.
    }
  };

  const ensureActiveThread = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionService,
  ): Promise<boolean> => {
    if (session.hasActiveThread()) {
      return true;
    }

    try {
      await session.newThread();
      updateSessionMetadata(contextKey, session);
      return true;
    } catch (error) {
      await safeReply(ctx, escapeHTML(`创建会话失败：${friendlyErrorText(error)}`), {
        fallbackText: `创建会话失败：${friendlyErrorText(error)}`,
      });
      return false;
    }
  };

  const renderPlanCard = async (
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    messageThreadId: number | undefined,
    text: string,
    actions: PlanActionHandlers,
  ): Promise<void> => {
    const previous = planRenderQueues.get(contextKey) ?? Promise.resolve();
    const render = previous.then(async () => {
      const previousMessage = planMessages.get(contextKey);
      if (previousMessage) pendingPlanActions.delete(previousMessage.actionId);

      const actionId = randomUUID().slice(0, 12);
      const keyboard = new InlineKeyboard();
      if (actions.confirm) {
        keyboard.text("▶️ 执行此计划", `plan_confirm:${actionId}`).row();
      }
      if (actions.regenerate) {
        keyboard.text("🔄 重新生成计划", `plan_regenerate:${actionId}`).row();
      }
      keyboard
        .text("✏️ 继续修改", `plan_steer:${actionId}`)
        .text("⏹ 取消", `plan_cancel:${actionId}`);

      let messageId: number;
      if (previousMessage) {
        messageId = previousMessage.messageId;
        await safeEditMessage(bot, chatId, messageId, text, {
          fallbackText: text.replace(/<[^>]+>/g, ""),
          replyMarkup: keyboard,
        });
      } else {
        const message = await sendTextMessage(bot.api, chatId, text, {
          parseMode: "HTML",
          fallbackText: text.replace(/<[^>]+>/g, ""),
          replyMarkup: keyboard,
          messageThreadId,
        });
        messageId = message.message_id;
      }

      pendingPlanActions.set(actionId, { contextKey, messageId, ...actions });
      planMessages.set(contextKey, { actionId, messageId });
    });
    planRenderQueues.set(contextKey, render.catch(() => {}));
    await render;
  };

  const renderPlanUpdate = async (
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    messageThreadId: number | undefined,
    update: AppServerPlanUpdate,
    actions: PlanActionHandlers,
  ): Promise<void> => {
    const lines = update.plan.map((step) => {
      const icon = step.status === "completed" ? "✅" : step.status === "inProgress" ? "🔄" : "⬜";
      return `${icon} ${escapeHTML(step.step)}`;
    });
    const text = [
      "🧭 <b>Plan Mode</b>",
      update.explanation ? escapeHTML(update.explanation) : undefined,
      lines.join("\n"),
    ].filter((line): line is string => Boolean(line)).join("\n\n");
    await renderPlanCard(contextKey, chatId, messageThreadId, text, actions);
  };

  const renderPlanDraft = async (
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    messageThreadId: number | undefined,
    draft: string | undefined,
    actions: PlanActionHandlers,
  ): Promise<void> => {
    const text = draft?.trim()
      ? ["🧭 <b>Plan Mode</b>", "<b>计划草案：</b>", formatTelegramHTML(draft.trim())].join("\n\n")
      : "🧭 <b>Plan Mode</b>\n\n⚠️ 未收到可确认的计划内容";
    await renderPlanCard(contextKey, chatId, messageThreadId, text, actions);
  };

  const requestPlanUserInput = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    messageThreadId: number | undefined,
    request: AppServerUserInputRequest,
  ): Promise<{ answers: Record<string, { answers: string[] }> }> => {
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of request.questions) {
      const answer = await requestSinglePlanQuestion(ctx, contextKey, chatId, messageThreadId, request, question);
      answers[question.id] = { answers: [answer] };
    }
    return { answers };
  };

  const requestSinglePlanQuestion = (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    messageThreadId: number | undefined,
    request: AppServerUserInputRequest,
    question: AppServerUserInputQuestion,
  ): Promise<string> => {
    const requestId = randomUUID().slice(0, 12);
    return new Promise<string>((resolve, reject) => {
      const pending: PendingPlanInput = {
        contextKey,
        chatId,
        messageThreadId,
        question,
        resolve,
        reject,
      };
      pendingPlanInputs.set(requestId, pending);

      const keyboard = new InlineKeyboard();
      for (const [index, option] of (question.options ?? []).entries()) {
        keyboard.text(option.label, `plan_answer:${requestId}:${index}`).row();
      }
      if (question.isOther || !question.options?.length) {
        keyboard.text("✍️ 自定义回答", `plan_other:${requestId}`);
      }

      void safeReply(ctx, [
        `<b>${escapeHTML(question.header || "需要你的选择")}</b>`,
        escapeHTML(question.question),
        question.options?.length ? question.options.map((option) => `• ${option.label}：${option.description}`).join("\n") : undefined,
      ].filter((line): line is string => Boolean(line)).join("\n\n"), {
        fallbackText: [question.header || "需要你的选择", question.question].join("\n\n"),
        replyMarkup: keyboard,
        messageThreadId,
      }).catch((error) => {
        if (pendingPlanInputs.get(requestId) === pending) {
          pendingPlanInputs.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  };

  const requestPlanApproval = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    messageThreadId: number | undefined,
    request: AppServerApprovalRequest,
  ): Promise<unknown> => {
    const actionId = randomUUID().slice(0, 12);
    const description = request.kind === "command"
      ? [`<b>需要确认命令：</b>`, `<pre>${escapeHTML(request.command ?? "（未知命令）")}</pre>`, request.reason ? escapeHTML(request.reason) : undefined].filter(Boolean).join("\n")
      : [`<b>需要确认操作：</b>`, escapeHTML(request.reason ?? "Codex 请求额外权限。")].join("\n");
    const keyboard = new InlineKeyboard()
      .text("✅ 允许一次", `plan_approve:${actionId}:accept`)
      .text("✅ 允许本次会话", `plan_approve:${actionId}:acceptForSession`)
      .row()
      .text("❌ 拒绝", `plan_approve:${actionId}:decline`);
    const decision = waitForPlanDecision(actionId, contextKey, request);
    void safeReply(ctx, description, {
      fallbackText: description.replace(/<[^>]+>/g, ""),
      replyMarkup: keyboard,
      messageThreadId,
    }).catch((error) => {
      const pending = pendingPlanDecisions.get(actionId);
      if (pending) {
        pendingPlanDecisions.delete(actionId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return decision;
  };

  const waitForPlanDecision = (
    actionId: string,
    contextKey: TelegramContextKey,
    request: AppServerApprovalRequest,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      pendingPlanDecisions.set(actionId, {
        contextKey,
        request,
        resolve,
        reject,
      });
    });

  const handleUserPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
  ): Promise<void> => {
    const parsed = parseContextKey(contextKey);
    const messageThreadId = parsed.messageThreadId;

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.processing = true;

    const abortKeyboard = new InlineKeyboard().text("⏹ 取消", `codex_abort:${contextKey}`);
    const toolVerbosity: ToolVerbosity = config.toolVerbosity;
    const toolStates = new Map<string, ToolState>();
    const toolCounts = new Map<string, number>();
    let finalized = false;
    let sentAgentMessage = false;
    let messageQueue: Promise<void> = Promise.resolve();
    const agentMessageIds: number[] = [];
    let planMessageId: number | undefined;
    let lastRenderedPlan = "";
    let planMessageSending = false;
    let lastTurnUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;

    const typingInterval = setInterval(() => {
      void bot.api
        .sendChatAction(chatId, "typing", {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        })
        .catch(() => {});
    }, TYPING_INTERVAL_MS);
    void bot.api
      .sendChatAction(chatId, "typing", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {});

    const stopTyping = (): void => {
      clearInterval(typingInterval);
    };

    const buildCompletionText = (): string => {
      const usageLine =
        config.showTurnTokenUsage && lastTurnUsage ? formatTurnUsageLine(lastTurnUsage) : "";

      if (toolVerbosity === "summary") {
        const footerLines = [formatToolSummaryLine(toolCounts), usageLine].filter((line): line is string => Boolean(line));
        return footerLines.join("\n");
      }

      if (toolVerbosity === "all" && usageLine) {
        return usageLine;
      }

      return "";
    };

    const sendRenderedChunks = async (chunks: RenderedChunk[], replyMarkup?: InlineKeyboard): Promise<void> => {
      if (chunks.length === 0) {
        return;
      }

      for (const chunk of chunks) {
        const message = await sendTextMessage(bot.api, chatId, chunk.text, {
          parseMode: chunk.parseMode,
          fallbackText: chunk.fallbackText,
          replyMarkup,
          messageThreadId,
        });
        if (replyMarkup === abortKeyboard) {
          agentMessageIds.push(message.message_id);
        }
      }
    };

    const enqueueRenderedChunks = (chunks: RenderedChunk[], replyMarkup?: InlineKeyboard): Promise<void> => {
      const delivery = messageQueue.then(() => sendRenderedChunks(chunks, replyMarkup));
      messageQueue = delivery.catch((error) => {
        console.error("发送 Telegram 消息失败", error);
      });
      return delivery;
    };

    const clearAbortButtons = async (): Promise<void> => {
      await messageQueue;
      for (const messageId of agentMessageIds) {
        try {
          await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: new InlineKeyboard() });
        } catch (error) {
          if (!isMessageNotModifiedError(error)) {
            console.error("清理取消按钮失败", error);
          }
        }
      }
    };

    const finalizeResponse = async (): Promise<void> => {
      if (finalized) {
        return;
      }
      finalized = true;

      stopTyping();
      const completionText = buildCompletionText();
      if (completionText) {
        await enqueueRenderedChunks(splitMarkdownForTelegram(completionText));
      }

      await messageQueue;
      await clearAbortButtons();
      await sendTaskNotification(contextKey, "completed");
    };

    const callbacks: CodexSessionCallbacks = {
      onAgentMessage: (text: string) => {
        sentAgentMessage = true;
        stopTyping();
        void enqueueRenderedChunks(splitMarkdownForTelegram(text), abortKeyboard).catch((error) => {
          console.error("发送 Codex 消息失败", error);
        });
      },
      onToolStart: (toolName: string, toolCallId: string) => {
        updateTask(contextKey, {
          status: "running",
          currentStep: `正在执行：${toolName}`,
          progress: Math.max(taskStates.get(contextKey)?.progress ?? 0, 1),
        });
        if (toolVerbosity === "summary") {
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
          return;
        }

        if (toolVerbosity === "none") {
          return;
        }

        toolStates.set(toolCallId, { toolName, partialResult: "" });
        if (toolVerbosity !== "all") {
          return;
        }

        const messageText = renderToolStartMessage(toolName);

        void (async () => {
          const message = await sendTextMessage(bot.api, chatId, messageText.text, {
            parseMode: messageText.parseMode,
            fallbackText: messageText.fallbackText,
            messageThreadId,
          });
          const state = toolStates.get(toolCallId);
          if (!state) {
            return;
          }

          state.messageId = message.message_id;
          if (state.finalStatus) {
            await safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
              parseMode: state.finalStatus.parseMode,
              fallbackText: state.finalStatus.fallbackText,
            });
          }
        })().catch((error) => {
          console.error(`Failed to send tool start message for ${toolName}`, error);
        });
      },
      onToolUpdate: (toolCallId: string, partialResult: string) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state || !partialResult) {
          return;
        }

        state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
      },
      onToolEnd: (toolCallId: string, isError: boolean) => {
        const currentProgress = taskStates.get(contextKey)?.progress ?? 0;
        updateTask(contextKey, {
          currentStep: isError ? "工具执行失败" : "正在整理执行结果",
          progress: Math.min(99, Math.max(currentProgress, currentProgress + 5)),
        });
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state) {
          return;
        }

        state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);
        if (toolVerbosity === "errors-only") {
          if (!isError) {
            return;
          }

          void sendTextMessage(bot.api, chatId, state.finalStatus.text, {
            parseMode: state.finalStatus.parseMode,
            fallbackText: state.finalStatus.fallbackText,
            messageThreadId,
          }).catch((error) => {
            console.error(`Failed to send tool error message for ${state.toolName}`, error);
          });
          return;
        }

        if (!state.messageId) {
          return;
        }

        void safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
          parseMode: state.finalStatus.parseMode,
          fallbackText: state.finalStatus.fallbackText,
        }).catch((error) => {
          console.error(`Failed to update tool message for ${state.toolName}`, error);
        });
      },
      onTodoUpdate: (items) => {
        const completed = items.filter((item) => item.completed).length;
        const current = items.find((item) => !item.completed);
        updateTask(contextKey, {
          currentStep: current?.text ?? "正在整理执行结果",
          progress: items.length > 0 ? Math.min(99, Math.round((completed / items.length) * 100)) : 0,
        });
        if (toolVerbosity === "none") {
          return;
        }

        const rendered = renderTodoList(items);
        if (rendered === lastRenderedPlan) {
          return;
        }

        lastRenderedPlan = rendered;
        if (!planMessageId) {
          if (planMessageSending) return;
          planMessageSending = true;
          void sendTextMessage(bot.api, chatId, rendered, { parseMode: "HTML", messageThreadId })
            .then((msg) => {
              planMessageId = msg.message_id;
            })
            .catch((err) => {
              console.error("Failed to send plan message", err);
            })
            .finally(() => {
              planMessageSending = false;
            });
        } else {
          void safeEditMessage(bot, chatId, planMessageId, rendered, { parseMode: "HTML" }).catch((err) => {
            console.error("Failed to update plan message", err);
          });
        }
      },
      onTurnComplete: (usage) => {
        lastTurnUsage = usage;
        updateTask(contextKey, { usage, progress: 100 });
      },
      onTurnStatus: (status) => {
        if (status === "reconnecting") {
          updateTask(contextKey, { status: "reconnecting", currentStep: "正在重新连接 Codex" });
        }
      },
      onAgentEnd: () => {},
    };

    try {
      const authStatus = await checkAuthStatus(config.codexApiKey);
      if (!authStatus.authenticated) {
        await safeReply(
          ctx,
          [
            "<b>⚠️ Codex 尚未认证。</b>",
            "",
            `<code>${escapeHTML(authStatus.detail)}</code>`,
            "",
            "请使用 /login 开始认证，或在主机上设置 CODEX_API_KEY。",
          ].join("\n"),
          {
            fallbackText: [
              "⚠️ Codex 尚未认证。",
              "",
              authStatus.detail,
              "",
              "请使用 /login 开始认证，或在主机上设置 CODEX_API_KEY。",
            ].join("\n"),
          },
        );
        return;
      }

      if (!(await ensureActiveThread(ctx, contextKey, session))) {
        return;
      }

      beginTask(contextKey, chatId, messageThreadId, "default");
      await captureTaskGitBaseline(contextKey);
      await session.prompt(userInput, callbacks);
      updateSessionMetadata(contextKey, session);
      await finalizeResponse();
    } catch (error) {
      stopTyping();
      if (finalized) {
        console.error("Codex 完成后发生提问错误：", formatError(error));
      } else {
        finalized = true;

        const chunks = splitMarkdownForTelegram(renderPromptFailure(error));
        try {
          await enqueueRenderedChunks(chunks);
          await clearAbortButtons();
        } catch (telegramError) {
          console.error("向 Telegram 发送错误消息失败:", telegramError);
        }
        const task = taskStates.get(contextKey);
        if (task?.cancellationRequested) {
          await sendTaskNotification(contextKey, "cancelled");
        } else {
          await sendTaskNotification(contextKey, "failed", friendlyErrorText(error));
        }
      }
    } finally {
      stopTyping();
      await clearAbortButtons();
      busyState.processing = false;
    }
  };

  const handlePlanPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
    mode: "start" | "continue",
  ): Promise<void> => {
    const parsed = parseContextKey(contextKey);
    const messageThreadId = parsed.messageThreadId;

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.processing = true;
    const toolStates = new Map<string, ToolState>();
    const toolCounts = new Map<string, number>();
    const toolVerbosity = config.toolVerbosity;
    let lastPlanAgentMessage: string | undefined;
    let receivedPlanContent = false;
    let executingConfirmedPlan = false;
    let latestPlanInput = userInput;
    let lastTurnUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;
    let finalized = false;

    const typingInterval = setInterval(() => {
      void bot.api.sendChatAction(chatId, "typing", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      }).catch(() => {});
    }, TYPING_INTERVAL_MS);
    void bot.api.sendChatAction(chatId, "typing", {
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    }).catch(() => {});

    const stopTyping = (): void => clearInterval(typingInterval);
    const buildPlanActions = (canConfirm = true): PlanActionHandlers => ({
      ...(canConfirm ? {
        confirm: async () => {
          executingConfirmedPlan = true;
          beginTask(contextKey, chatId, messageThreadId, "planExecution");
          await captureTaskGitBaseline(contextKey);
          updateTask(contextKey, { currentStep: "正在执行已确认计划" });
          void bot.api.sendChatAction(chatId, "typing", {
            ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
          }).catch(() => {});
          try {
            await session.executePlan("确认上述计划并开始执行。", callbacks);
            updateSessionMetadata(contextKey, session);
            await sendTaskNotification(contextKey, "completed");
          } catch (error) {
            const task = taskStates.get(contextKey);
            if (task?.cancellationRequested) {
              await sendTaskNotification(contextKey, "cancelled");
            } else {
              await sendTaskNotification(contextKey, "failed", friendlyErrorText(error));
            }
            throw error;
          }
        },
      } : {}),
      steer: async (text) => {
        const steerBusyState = getBusyState(contextKey);
        steerBusyState.processing = true;
        updateTask(contextKey, {
          status: "planning",
          currentStep: "正在更新计划",
          progress: 0,
          cancellationRequested: false,
          finishedAt: undefined,
          terminalNotified: false,
        });
        latestPlanInput = text;
        lastPlanAgentMessage = undefined;
        receivedPlanContent = false;
        try {
          await session.continuePlan(text, callbacks);
          await finalizePlanView();
        } catch (error) {
          const task = taskStates.get(contextKey);
          if (task?.cancellationRequested) {
            await sendTaskNotification(contextKey, "cancelled");
          } else {
            await sendTaskNotification(contextKey, "failed", friendlyErrorText(error));
          }
          throw error;
        } finally {
          steerBusyState.processing = false;
        }
      },
      cancel: async () => {
        await session.abort();
      },
      regenerate: async () => {
        const regenerateBusyState = getBusyState(contextKey);
        regenerateBusyState.processing = true;
        updateTask(contextKey, {
          status: "planning",
          currentStep: "正在重新生成计划",
          progress: 0,
          cancellationRequested: false,
          finishedAt: undefined,
          terminalNotified: false,
        });
        lastPlanAgentMessage = undefined;
        receivedPlanContent = false;
        try {
          await session.continuePlan(latestPlanInput, callbacks);
          await finalizePlanView();
        } catch (error) {
          const task = taskStates.get(contextKey);
          if (task?.cancellationRequested) {
            await sendTaskNotification(contextKey, "cancelled");
          } else {
            await sendTaskNotification(contextKey, "failed", friendlyErrorText(error));
          }
          throw error;
        } finally {
          regenerateBusyState.processing = false;
        }
      },
    });

    const updatePlan = (update: AppServerPlanUpdate): void => {
      const hasPlanContent = Boolean(update.explanation?.trim()) || update.plan.some((step) => step.step.trim());
      if (!hasPlanContent) return;
      if (executingConfirmedPlan) {
        updateTaskFromPlan(contextKey, update);
        updateTask(contextKey, { status: "running" });
        return;
      }
      receivedPlanContent = true;
      updateTaskFromPlan(contextKey, update);
      updateTask(contextKey, { status: "planning" });
      void renderPlanUpdate(contextKey, chatId, messageThreadId, update, buildPlanActions())
        .catch((error) => console.error("发送 Plan Mode 计划失败", error));
    };

    const callbacks: CodexSessionCallbacks = {
      onAgentMessage: (text) => {
        stopTyping();
        if (executingConfirmedPlan) {
          updateTask(contextKey, {
            status: "running",
            currentStep: "正在生成执行结果",
            progress: Math.max(taskStates.get(contextKey)?.progress ?? 0, 1),
          });
          void sendTextMessage(bot.api, chatId, formatTelegramHTML(text), {
            parseMode: "HTML",
            fallbackText: text,
            messageThreadId,
          }).catch((error) => console.error("发送执行计划消息失败", error));
          return;
        }
        lastPlanAgentMessage = text;
      },
      onToolStart: (toolName, toolCallId) => {
        if (executingConfirmedPlan) {
          updateTask(contextKey, {
            status: "running",
            currentStep: `正在执行：${toolName}`,
            progress: Math.max(taskStates.get(contextKey)?.progress ?? 0, 1),
          });
        }
        if (toolVerbosity === "summary") {
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
          return;
        }
        if (toolVerbosity === "none") return;
        toolStates.set(toolCallId, { toolName, partialResult: "" });
      },
      onToolUpdate: (toolCallId, partialResult) => {
        const state = toolStates.get(toolCallId);
        if (state) state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
      },
      onToolEnd: (toolCallId, isError) => {
        if (executingConfirmedPlan) {
          const currentProgress = taskStates.get(contextKey)?.progress ?? 0;
          updateTask(contextKey, {
            currentStep: isError ? "工具执行失败" : "正在整理执行结果",
            progress: Math.min(99, Math.max(currentProgress, currentProgress + 5)),
          });
        }
        const state = toolStates.get(toolCallId);
        if (!state || toolVerbosity === "none" || toolVerbosity === "summary") return;
        const rendered = renderToolEndMessage(state.toolName, state.partialResult, isError);
        void sendTextMessage(bot.api, chatId, rendered.text, {
          parseMode: rendered.parseMode,
          fallbackText: rendered.fallbackText,
          messageThreadId,
        }).catch((error) => console.error("发送 Plan Mode 工具结果失败", error));
      },
      onPlanUpdate: updatePlan,
      onUserInputRequest: (request) => requestPlanUserInput(ctx, contextKey, chatId, messageThreadId, request),
      onApprovalRequest: (request) => requestPlanApproval(ctx, contextKey, chatId, messageThreadId, request),
      onTurnComplete: (usage) => {
        lastTurnUsage = usage;
        if (executingConfirmedPlan) {
          updateTask(contextKey, { usage, progress: 100 });
        }
      },
      onTurnStatus: (status) => {
        if (status === "reconnecting") {
          updateTask(contextKey, { status: "reconnecting", currentStep: "正在重新连接 Codex" });
        }
      },
      onAgentEnd: () => {},
    };

    const finalizePlanView = async (): Promise<void> => {
      await (planRenderQueues.get(contextKey) ?? Promise.resolve());
      if (!receivedPlanContent) {
        await renderPlanDraft(
          contextKey,
          chatId,
          messageThreadId,
          lastPlanAgentMessage,
          buildPlanActions(Boolean(lastPlanAgentMessage?.trim())),
        );
      }
      await (planRenderQueues.get(contextKey) ?? Promise.resolve());
      if (!executingConfirmedPlan) {
        updateTask(contextKey, {
          status: "awaitingConfirmation",
          currentStep: "等待确认后执行计划",
          progress: 0,
        });
        recordTaskUsage(contextKey);
      }
      updateSessionMetadata(contextKey, session);
    };

    try {
      const authStatus = await checkAuthStatus(config.codexApiKey);
      if (!authStatus.authenticated) {
        await safeReply(ctx, "<b>⚠️ Codex 尚未认证。</b>\n\n请使用 /login 开始认证，或在主机上设置 CODEX_API_KEY。", {
          fallbackText: "⚠️ Codex 尚未认证。\n\n请使用 /login 开始认证，或在主机上设置 CODEX_API_KEY。",
        });
        return;
      }

      if (!(await ensureActiveThread(ctx, contextKey, session))) {
        return;
      }

      beginTask(contextKey, chatId, messageThreadId, "plan", "planning");
      await captureTaskGitBaseline(contextKey);
      if (mode === "start") {
        await session.promptPlan(userInput, callbacks);
      } else {
        await session.continuePlan(userInput, callbacks);
      }
      await finalizePlanView();
      finalized = true;
    } catch (error) {
      if (!finalized) {
        const task = taskStates.get(contextKey);
        if (task?.cancellationRequested) {
          await sendTaskNotification(contextKey, "cancelled");
        } else {
          await safeReply(ctx, renderPromptFailure(error), {
            fallbackText: renderPromptFailure(error).replace(/<[^>]+>/g, ""),
          }).catch((telegramError) => console.error("向 Telegram 发送 Plan Mode 错误失败", telegramError));
          await sendTaskNotification(contextKey, "failed", friendlyErrorText(error));
        }
      }
    } finally {
      stopTyping();
      busyState.processing = false;
    }
  };

  const deliverArtifacts = async (
    ctx: Context,
    chatId: TelegramChatId,
    outDir: string,
    messageThreadId?: number,
  ): Promise<void> => {
    const { artifacts, skippedCount } = await collectArtifactReport(outDir);

    if (artifacts.length === 0 && skippedCount === 0) {
      return;
    }

    await ctx.api
      .sendChatAction(chatId, "upload_document", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {});

    let failedCount = 0;
    for (const artifact of artifacts) {
      try {
        await ctx.api.sendDocument(chatId, new InputFile(artifact.localPath, artifact.name), {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        });
      } catch (error) {
        failedCount += 1;
          console.error(`发送文件 ${artifact.name} 失败：`, error);
      }
    }

    const summary = formatArtifactSummary(artifacts, skippedCount + failedCount);
    if (summary) {
      await safeReply(ctx, escapeHTML(summary), { fallbackText: summary });
    }
  };

  const sendGitDiffReport = async (ctx: Context, workspace: string): Promise<void> => {
    const report = await getGitDiffReport(workspace);
    if (!report.repository) {
      await safeReply(ctx, "ℹ️ 当前工作区不是 Git 仓库。", { fallbackText: "ℹ️ 当前工作区不是 Git 仓库。" });
      return;
    }
    if (report.files.length === 0) {
      await safeReply(ctx, `✅ <b>Git 工作区干净。</b>\n<b>分支：</b><code>${escapeHTML(report.branch)}</code>`, {
        fallbackText: `✅ Git 工作区干净。\n分支：${report.branch}`,
      });
      return;
    }

    const keyboard = new InlineKeyboard();
    const htmlLines = [
      "🧾 <b>Git diff 摘要</b>",
      `<b>分支：</b><code>${escapeHTML(report.branch)}</code>`,
      `<b>文件：</b>${report.files.length} 个 · <b>新增：</b>${report.additions} 行 · <b>删除：</b>${report.deletions} 行`,
      "",
    ];
    const plainLines = [
      "🧾 Git diff 摘要",
      `分支：${report.branch}`,
      `文件：${report.files.length} 个 · 新增：${report.additions} 行 · 删除：${report.deletions} 行`,
      "",
    ];
    for (const file of report.files.slice(0, 20)) {
      const callbackId = randomUUID().slice(0, 12);
      pendingGitDiffs.set(callbackId, {
        workspace,
        filePath: file.path,
        chatId: ctx.chat?.id ?? 0,
        messageThreadId: parseContextKey(contextKeyFromCtx(ctx) ?? "0").messageThreadId,
      });
      htmlLines.push(`${formatGitChangeIcon(file.kind)} <code>${escapeHTML(file.path)}</code> · +${file.additions} -${file.deletions}`);
      plainLines.push(`${formatGitChangeIcon(file.kind)} ${file.path} · +${file.additions} -${file.deletions}`);
      keyboard.text(`查看 ${trimLine(file.path, 32)}`, `git_diff_file:${callbackId}`).row();
    }
    if (report.files.length > 20) {
      htmlLines.push(`……还有 ${report.files.length - 20} 个文件未显示。`);
      plainLines.push(`……还有 ${report.files.length - 20} 个文件未显示。`);
    }
    await safeReply(ctx, htmlLines.join("\n"), {
      fallbackText: plainLines.join("\n"),
      replyMarkup: keyboard,
    });
  };

  const sendGitView = async (
    ctx: Context,
    workspace: string,
    view: "status" | "diff" | "log" | "remotes",
  ): Promise<void> => {
    if (view === "diff") {
      await sendGitDiffReport(ctx, workspace);
      return;
    }

    if (view === "status") {
      const status = await getGitStatus(workspace);
      if (!status.repository) {
        await safeReply(ctx, "ℹ️ 当前工作区不是 Git 仓库。", { fallbackText: "ℹ️ 当前工作区不是 Git 仓库。" });
        return;
      }
      const lines = [
        "📋 <b>Git 状态</b>",
        `<b>分支：</b><code>${escapeHTML(status.branch)}</code>`,
        "",
        ...(status.status.length > 0 ? status.status.map((line) => `<code>${escapeHTML(line)}</code>`) : ["✅ 工作区干净"]),
      ];
      await safeReply(ctx, lines.join("\n"), { fallbackText: lines.join("\n").replace(/<[^>]+>/g, "") });
      return;
    }

    if (view === "log") {
      const entries = await getGitLog(workspace);
      if (entries.length === 0) {
        await safeReply(ctx, "ℹ️ 当前工作区不是 Git 仓库，或还没有提交记录。", {
          fallbackText: "ℹ️ 当前工作区不是 Git 仓库，或还没有提交记录。",
        });
        return;
      }
      const lines = ["🕘 <b>最近提交</b>", ""];
      for (const entry of entries) {
        const [hash, date, author, subject] = entry.split("|");
        lines.push(`<code>${escapeHTML(hash ?? "")}</code> ${escapeHTML(date ?? "")} · ${escapeHTML(subject ?? "")} <i>(${escapeHTML(author ?? "")})</i>`);
      }
      await safeReply(ctx, lines.join("\n"), { fallbackText: lines.join("\n").replace(/<[^>]+>/g, "") });
      return;
    }

    const remotes = await getGitRemotes(workspace);
    const lines = ["🌐 <b>Git 远程仓库</b>", "", ...(remotes.length > 0 ? remotes.map((remote) => `<code>${escapeHTML(remote)}</code>`) : ["（未配置远程仓库）"])];
    await safeReply(ctx, lines.join("\n"), { fallbackText: lines.join("\n").replace(/<[^>]+>/g, "") });
  };

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId || !config.telegramAllowedUserIdSet.has(fromId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "未授权" }).catch(() => {});
      } else if (ctx.chat) {
        await safeReply(ctx, escapeHTML("未授权"), { fallbackText: "未授权" });
      }
      return;
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const authStatus = await checkAuthStatus(config.codexApiKey);
    const authWarning = authStatus.authenticated ? undefined : "尚未认证。请使用 /login，或设置 CODEX_API_KEY。";
    const isReturning = registry.hasMetadata(contextKey);

    if (isReturning) {
      const info = session.getInfo();
      const welcome = renderWelcomeReturning(
        renderSessionInfoHTML(info),
        renderSessionInfoPlain(info),
        isTopicContext(contextKey),
        authWarning,
      );
      await safeReply(ctx, welcome.html, { fallbackText: welcome.plain });
    } else {
      const welcome = renderWelcomeFirstTime(authWarning);
      const info = session.getInfo();
      await safeReply(ctx, [welcome.html, "", renderLaunchSummaryHTML(info)].join("\n"), {
        fallbackText: [welcome.plain, "", renderLaunchSummaryPlain(info)].join("\n"),
      });
    }
  });

  bot.command("help", async (ctx) => {
    const help = renderHelpMessage();
    await safeReply(ctx, help.html, { fallbackText: help.plain });
  });

  bot.command("status", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const status = formatTaskStatusMessage(taskStates.get(contextSession.contextKey));
    await safeReply(ctx, status.html, { fallbackText: status.plain });
  });

  bot.command("security", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) return;
    const report = renderSecurityReport(config, contextSession.session.getInfo());
    const keyboard = new InlineKeyboard().text("⚙️ 启动配置", "security_launch_profiles");
    await safeReply(ctx, report.html, { fallbackText: report.plain, replyMarkup: keyboard });
  });

  bot.command("usage", async (ctx) => {
    const argument = (ctx.message?.text ?? "").replace(/^\/usage(?:@\w+)?/i, "").trim().toLowerCase();
    const period = argument === "week" || argument === "周" ? "week" : "day";
    const since = Date.now() - (period === "week" ? 7 : 1) * 24 * 60 * 60 * 1000;
    const label = period === "week" ? "最近 7 天" : "最近 24 小时";
    const text = formatUsageSummary(label, usageStore.summarizeSince(since));
    const keyboard = new InlineKeyboard()
      .text("📅 最近 24 小时", "usage_view:day")
      .text("🗓️ 最近 7 天", "usage_view:week");
    await safeReply(ctx, formatTelegramHTML(text), { fallbackText: text, replyMarkup: keyboard });
  });

  bot.command("git", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) return;
    const argument = (ctx.message?.text ?? "").replace(/^\/git(?:@\w+)?/i, "").trim().toLowerCase();
    const view = argument === "status" || argument === "diff" || argument === "log" || argument === "remotes"
      ? argument
      : undefined;
    if (view) {
      await sendGitView(ctx, contextSession.session.getCurrentWorkspace(), view);
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("📋 状态", "git_view:status")
      .text("🧾 Diff", "git_view:diff")
      .row()
      .text("🕘 提交记录", "git_view:log")
      .text("🌐 远程仓库", "git_view:remotes");
    await safeReply(ctx, [
      "<b>Git 控制面板</b>",
      "",
      "查看当前工作区的状态、文件 diff、提交记录和远程仓库。",
      "也可以使用：<code>/git status</code>、<code>/git diff</code>、<code>/git log</code>、<code>/git remotes</code>。",
    ].join("\n"), {
      fallbackText: "Git 控制面板\n\n查看当前工作区的状态、文件 diff、提交记录和远程仓库。\n也可以使用：/git status、/git diff、/git log、/git remotes。",
      replyMarkup: keyboard,
    });
  });

  bot.command("auth", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    const icon = authStatus.authenticated ? "✅" : "❌";
    const html = [
      `<b>${icon} 认证状态：</b>${authStatus.authenticated ? "已认证" : "未认证"}`,
      `<b>方式：</b><code>${escapeHTML(authStatus.method)}</code>`,
      `<b>详情：</b><code>${escapeHTML(authStatus.detail)}</code>`,
    ].join("\n");
    const plain = [
      `${icon} 认证状态：${authStatus.authenticated ? "已认证" : "未认证"}`,
      `方式：${authStatus.method}`,
      `详情：${authStatus.detail}`,
    ].join("\n");

    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("login", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.method === "config") {
      await safeReply(
        ctx,
        [
            "<b>本机已配置自定义 Codex 服务商。</b>",
          "",
            "请在主机的 <code>~/.codex/config.toml</code> 中管理其凭据。",
        ].join("\n"),
        {
          fallbackText: [
            "本机已配置自定义 Codex 服务商。",
            "",
            "请在主机的 ~/.codex/config.toml 中管理其凭据。",
          ].join("\n"),
        },
      );
      return;
    }

    if (authStatus.authenticated) {
      await safeReply(ctx, `<b>✅ 已通过 <code>${escapeHTML(authStatus.method)}</code> 完成认证。</b>`, {
        fallbackText: `✅ 已通过 ${authStatus.method} 完成认证。`,
      });
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(
        ctx,
        [
          "<b>已禁用从 Telegram 发起登录。</b>",
          "",
          "请在主机运行 <code>codex login</code>，或在 .env 中设置 CODEX_API_KEY。",
        ].join("\n"),
        {
          fallbackText: [
            "已禁用从 Telegram 发起登录。",
            "",
            "请在主机运行 'codex login'，或在 .env 中设置 CODEX_API_KEY。",
          ].join("\n"),
        },
      );
      return;
    }

    const result = await startLogin();
    if (result.success) {
      await safeReply(ctx, `<b>🔑 已开始登录。</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
        fallbackText: `🔑 已开始登录。\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ 登录失败。</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ 登录失败。\n\n${result.message}`,
    });
  });

  bot.command("logout", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.method === "api-key" || authStatus.method === "config") {
      await safeReply(
        ctx,
        [
          `<b>使用 ${authStatus.method === "api-key" ? "CODEX_API_KEY" : "自定义 Codex 服务商"} 时，无法通过 Telegram 退出登录。</b>`,
          "",
          authStatus.method === "api-key"
            ? "请从 .env 中移除 CODEX_API_KEY，以改用 CLI 认证。"
            : "请在主机的 ~/.codex/config.toml 中管理其凭据。",
        ].join("\n"),
        {
          fallbackText: [
            `使用 ${authStatus.method === "api-key" ? "CODEX_API_KEY" : "自定义 Codex 服务商"} 时，无法通过 Telegram 退出登录。`,
            "",
            authStatus.method === "api-key"
              ? "请从 .env 中移除 CODEX_API_KEY，以改用 CLI 认证。"
              : "请在主机的 ~/.codex/config.toml 中管理其凭据。",
          ].join("\n"),
        },
      );
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(ctx, [
        "<b>已禁用从 Telegram 管理认证。</b>",
        "",
        "请在主机运行 <code>codex logout</code>。",
      ].join("\n"), {
        fallbackText: [
          "已禁用从 Telegram 管理认证。",
          "",
          "请在主机运行 'codex logout'。",
        ].join("\n"),
      });
      return;
    }

    if (!authStatus.authenticated) {
      await safeReply(ctx, escapeHTML("当前未认证。"), {
        fallbackText: "当前未认证。",
      });
      return;
    }

    const result = await startLogout();
    if (result.success) {
      await safeReply(ctx, `<b>🔓 已退出登录。</b>\n\n${escapeHTML(result.message)}`, {
        fallbackText: `🔓 已退出登录。\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ 退出登录失败。</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ 退出登录失败。\n\n${result.message}`,
    });
  });

  bot.command("voice", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const backends = await getAvailableBackends().catch(() => []);

    if (backends.length === 0) {
      await safeReply(
        ctx,
        [
          "<b>语音转写不可用。</b>",
          "",
          "请安装 <code>parakeet-coreml</code> 和 ffmpeg，或设置 <code>OPENAI_API_KEY</code>。",
          "<i>注意：语音转写使用 OPENAI_API_KEY，而不是 CODEX_API_KEY。</i>",
        ].join("\n"),
        {
          fallbackText: [
            "语音转写不可用。",
            "",
            "请安装 parakeet-coreml 和 ffmpeg，或设置 OPENAI_API_KEY。",
            "注意：语音转写使用 OPENAI_API_KEY，而不是 CODEX_API_KEY。",
          ].join("\n"),
        },
      );
      return;
    }

    const joined = backends.join(" + ");
    await safeReply(ctx, `<b>语音后端：</b><code>${escapeHTML(joined)}</code>`, {
      fallbackText: `语音后端：${joined}`,
    });
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("当前提问仍在处理中，无法新建会话。"), {
        fallbackText: "当前提问仍在处理中，无法新建会话。",
      });
      return;
    }

    const workspaces = session.listWorkspaces();
    pendingWorkspacePicks.set(contextKey, workspaces);
    const currentWorkspace = session.getCurrentWorkspace();
    const workspaceButtons: KeyboardItem[] = [
      { label: "✍️ 输入文件夹路径", callbackData: "ws_new_path" },
      ...workspaces.map((workspace, index) => ({
      label: `${workspace === currentWorkspace ? "📂" : "📁"} ${getWorkspaceShortName(workspace)}`,
      callbackData: `ws_${index}`,
      })),
    ];
    pendingWorkspaceButtons.set(contextKey, workspaceButtons);
    const keyboard = paginateKeyboard(workspaceButtons, 0, "ws");

    await safeReply(ctx, "<b>请选择新会话的工作目录，或输入一个新路径：</b>", {
      fallbackText: "请选择新会话的工作目录，或输入一个新路径：",
      replyMarkup: keyboard,
    });
  });

  bot.command("abort", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    try {
      const cancellation = markTaskCancelled(contextKey);
      await session.abort();
      clearPlanInteractionState(contextKey, new Error("操作已取消。"));
      await cancellation;
      await safeReply(ctx, escapeHTML("已取消当前操作。"), {
        fallbackText: "已取消当前操作。",
      });
    } catch (error) {
      await safeReply(ctx, `<b>失败：</b>${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `失败：${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("retry", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const cached = lastPromptInput.get(contextKey);
    if (!cached) {
      await safeReply(ctx, escapeHTML("没有可重试的内容，请先发送一条消息。"), {
        fallbackText: "没有可重试的内容，请先发送一条消息。",
      });
      return;
    }

    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, cached);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.command("session", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const contextLabel = isTopicContext(contextKey) ? "话题会话" : "聊天会话";

    const plainLines = [`${contextLabel}:`, renderSessionInfoPlain(info)];
    const htmlLines = [`<b>${escapeHTML(contextLabel)}:</b>`, renderSessionInfoHTML(info)];

    await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
  });

  const openLaunchProfilesPicker = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("当前提问仍在处理中，无法切换启动配置。"), {
        fallbackText: "当前提问仍在处理中，无法切换启动配置。",
      });
      return;
    }

    const info = session.getInfo();
    const selectedLaunchProfile = session.getSelectedLaunchProfile();
    const launchButtons = config.launchProfiles.map((profile, index) => ({
      label: formatLaunchProfileLabel(profile, profile.id === selectedLaunchProfile.id),
      callbackData: `launch_${index}`,
    }));

    pendingLaunchPicks.set(
      contextKey,
      config.launchProfiles.map((profile) => profile.id),
    );
    pendingLaunchButtons.set(contextKey, launchButtons);
    pendingUnsafeLaunchConfirmations.delete(contextKey);

    const keyboard = paginateKeyboard(launchButtons, 0, "launch");
    const htmlLines = [
      `<b>当前启动配置：</b><code>${escapeHTML(selectedLaunchProfile.label)}</code>`,
      `<b>行为：</b><code>${escapeHTML(formatLaunchProfileBehavior(selectedLaunchProfile))}</code>`,
      "",
      "请选择用于新建或重新绑定会话的配置：",
    ];
    const plainLines = [
      `当前启动配置：${selectedLaunchProfile.label}`,
      `行为：${formatLaunchProfileBehavior(selectedLaunchProfile)}`,
      "",
      "请选择用于新建或重新绑定会话的配置：",
    ];

    if (selectedLaunchProfile.unsafe) {
      htmlLines.splice(2, 0, "⚠️ <i>当前配置使用 danger-full-access。</i>");
      plainLines.splice(2, 0, "⚠️ 当前配置使用 danger-full-access。" );
    }

    if (info.nextLaunchProfileId) {
      htmlLines.splice(2, 0, `<b>当前活动会话仍使用：</b><code>${escapeHTML(info.launchProfileLabel)}</code>`);
      plainLines.splice(2, 0, `当前活动会话仍使用：${info.launchProfileLabel}`);
    }

    await safeReply(ctx, htmlLines.join("\n"), {
      fallbackText: plainLines.join("\n"),
      replyMarkup: keyboard,
    });
  };

  bot.command(["launch", "launch_profiles"], openLaunchProfilesPicker);
  bot.hears(/^\/launch-profiles(?:@\w+)?$/i, openLaunchProfilesPicker);

  bot.command("plan", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) return;

    const { contextKey, session } = contextSession;
    const commandText = ctx.message?.text ?? "";
    const argument = commandText.replace(/^\/plan(?:@\w+)?/i, "").trim();
    const normalized = argument.toLowerCase();

    if (!argument) {
      const enabled = planModeContexts.has(contextKey);
      if (enabled) {
        planModeContexts.delete(contextKey);
        const cancellation = markTaskCancelled(contextKey);
        await session.abort();
        clearPlanInteractionState(contextKey, new Error("Plan Mode 已关闭。"));
        await cancellation;
      } else {
        planModeContexts.add(contextKey);
      }
      const nowEnabled = !enabled;
      await safeReply(ctx, nowEnabled
        ? "🧭 <b>Plan Mode 已开启。</b>发送下一条消息即可进入计划模式。\n使用 /plan off 关闭。"
        : "🧭 <b>Plan Mode 已关闭。</b>", {
        fallbackText: nowEnabled
          ? "🧭 Plan Mode 已开启。发送下一条消息即可进入计划模式。\n使用 /plan off 关闭。"
          : "🧭 Plan Mode 已关闭。",
      });
      return;
    }

    if (normalized === "status" || normalized === "状态") {
      const enabled = planModeContexts.has(contextKey);
      await safeReply(ctx, enabled
        ? "🧭 <b>Plan Mode 已开启。</b>发送下一条消息即可进入计划模式。\n使用 /plan off 关闭。"
        : "🧭 <b>Plan Mode 当前未开启。</b>使用 /plan 开启，或使用 /plan on 开启。", {
        fallbackText: enabled
          ? "🧭 Plan Mode 已开启。发送下一条消息即可进入计划模式。\n使用 /plan off 关闭。"
          : "🧭 Plan Mode 当前未开启。使用 /plan 开启，或使用 /plan on 开启。",
      });
      return;
    }

    if (normalized === "on" || normalized === "开启") {
      planModeContexts.add(contextKey);
      await safeReply(ctx, "🧭 <b>Plan Mode 已开启。</b>", { fallbackText: "🧭 Plan Mode 已开启。" });
      return;
    }

    if (normalized === "off" || normalized === "关闭") {
      planModeContexts.delete(contextKey);
      const cancellation = markTaskCancelled(contextKey);
      await session.abort();
      clearPlanInteractionState(contextKey, new Error("Plan Mode 已关闭。"));
      await cancellation;
      await safeReply(ctx, "🧭 <b>Plan Mode 已关闭。</b>", { fallbackText: "🧭 Plan Mode 已关闭。" });
      return;
    }

    planModeContexts.add(contextKey);
    lastPromptInput.set(contextKey, argument);
    await handlePlanPrompt(ctx, contextKey, ctx.chat?.id ?? 0, session, argument, "start");
  });

  bot.command("handback", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("当前提问仍在处理中，无法交还会话。请先使用 /abort。"), {
        fallbackText: "当前提问仍在处理中，无法交还会话。请先使用 /abort。",
      });
      return;
    }

    if (!session.hasActiveThread()) {
      await safeReply(ctx, escapeHTML("没有可交还的活动会话。"), {
        fallbackText: "没有可交还的活动会话。",
      });
      return;
    }

    try {
      const info = session.handback();
      updateSessionMetadata(contextKey, session);

      if (!info.threadId) {
        await safeReply(
          ctx,
          escapeHTML(
            "该会话尚未开始，因此没有可恢复的会话 ID。请发送一条消息创建会话，或使用 /new 新建会话。",
          ),
          {
            fallbackText:
              "该会话尚未开始，因此没有可恢复的会话 ID。请发送一条消息创建会话，或使用 /new 新建会话。",
          },
        );
        return;
      }

      const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
      const resumeCommand = `cd ${shellEscape(info.workspace)} && codex resume ${shellEscape(info.threadId)}`;

      let copiedToClipboard = false;
      if (process.platform === "darwin") {
        try {
          const { spawnSync } = await import("node:child_process");
          const result = spawnSync("pbcopy", [], {
            input: resumeCommand,
            timeout: 2000,
            stdio: ["pipe", "ignore", "ignore"],
          });
          copiedToClipboard = result.status === 0;
        } catch {
          // Ignore clipboard failures.
        }
      }

      const plainText = [
        "🔄 会话已交还给 Codex CLI。",
        "",
        "请在终端运行：",
        resumeCommand,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 命令已复制到剪贴板！" : undefined,
        "",
        "在这里发送任意消息即可开始新的 TeleCodex 会话。",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      const html = [
        "<b>🔄 会话已交还给 Codex CLI。</b>",
        "",
        "请在终端运行：",
        `<pre>${escapeHTML(resumeCommand)}</pre>`,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 <i>命令已复制到剪贴板！</i>" : undefined,
        "",
        "在这里发送任意消息即可开始新的 TeleCodex 会话。",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>失败：</b>${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `失败：${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("attach", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("当前提问仍在处理中，无法绑定会话。"), {
        fallbackText: "当前提问仍在处理中，无法绑定会话。",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/attach(?:@\w+)?\s*/, "").trim();

    if (!threadId) {
      await safeReply(ctx, escapeHTML("用法：/attach <会话 ID>"), {
        fallbackText: "用法：/attach <会话 ID>",
      });
      return;
    }

    if (!getThread(threadId)) {
      await safeReply(ctx, `<b>失败：</b>${escapeHTML(`未知的 Codex 会话：${threadId}`)}`, {
        fallbackText: `失败：未知的 Codex 会话：${threadId}`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const html = `<b>已绑定到会话。</b>\n\n${renderSessionInfoHTML(info)}`;
      const plain = `已绑定到会话。\n\n${renderSessionInfoPlain(info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>失败：</b>${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `失败：${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command(["sessions", "switch"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("当前提问仍在处理中，无法切换会话。"), {
        fallbackText: "当前提问仍在处理中，无法切换会话。",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/(?:sessions|switch)(?:@\w+)?\s*/, "").trim();

    if (threadId) {
      const busyState = getBusyState(contextKey);
      busyState.switching = true;
      try {
        const info = await session.switchSession(threadId);
        updateSessionMetadata(contextKey, session);
        const html = `<b>已切换会话。</b>\n\n${renderSessionInfoHTML(info)}`;
        const plain = `已切换会话。\n\n${renderSessionInfoPlain(info)}`;
        await safeReply(ctx, html, { fallbackText: plain });
      } catch (error) {
        await safeReply(ctx, `<b>失败：</b>${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `失败：${friendlyErrorText(error)}`,
        });
      } finally {
        busyState.switching = false;
      }
      return;
    }

    const sessions = session.listAllSessions(50);
    if (sessions.length === 0) {
      await safeReply(ctx, escapeHTML("未找到最近的会话。"), {
        fallbackText: "未找到最近的会话。",
      });
      return;
    }

    const groupedSessions = new Map<string, typeof sessions>();
    for (const listedSession of sessions) {
      const workspaceSessions = groupedSessions.get(listedSession.cwd);
      if (workspaceSessions) {
        workspaceSessions.push(listedSession);
      } else {
        groupedSessions.set(listedSession.cwd, [listedSession]);
      }
    }

    const orderedSessions: typeof sessions = [];

    for (const workspaceSessions of groupedSessions.values()) {
      orderedSessions.push(...workspaceSessions);
    }

    pendingSessionPicks.set(
      contextKey,
      orderedSessions.map((listedSession) => listedSession.id),
    );

    const activeThreadId = session.getInfo().threadId;
    const sessionButtons = orderedSessions.map((listedSession, index) => {
      return {
        label: formatSessionLabel({
          workspace: listedSession.cwd,
          title: listedSession.title || listedSession.firstUserMessage || "",
          relativeTime: formatRelativeTime(listedSession.updatedAt),
          model: listedSession.model || undefined,
          isActive: listedSession.id === activeThreadId,
        }),
        callbackData: `sess_${index}`,
      };
    });
    pendingSessionButtons.set(contextKey, sessionButtons);
    const keyboard = paginateKeyboard(sessionButtons, 0, "sess");

    await safeReply(ctx, `<b>最近会话</b>（${orderedSessions.length} 个）：\n点击即可切换。`, {
      fallbackText: `最近会话（${orderedSessions.length} 个）：\n点击即可切换。`,
      replyMarkup: keyboard,
    });
  });

  bot.command("model", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("当前提问仍在处理中，无法切换模型。"), {
        fallbackText: "当前提问仍在处理中，无法切换模型。",
      });
      return;
    }

    const models = session.listModels();
    if (models.length === 0) {
      await safeReply(ctx, escapeHTML("没有可用模型。"), {
        fallbackText: "没有可用模型。",
      });
      return;
    }

    const currentModel = session.getInfo().model ?? "（默认）";
    const modelButtons = models.map((model) => ({
      label: `${model.displayName}${model.slug === currentModel ? " ✓" : ""}`,
      callbackData: `model_${model.slug}`,
    }));
    pendingModelButtons.set(contextKey, modelButtons);
    const keyboard = paginateKeyboard(modelButtons, 0, "model");

    await safeReply(
      ctx,
      [`<b>当前模型：</b><code>${escapeHTML(currentModel)}</code>`, "", "请选择用于新会话的模型："].join("\n"),
      {
        fallbackText: [`当前模型：${currentModel}`, "", "请选择用于新会话的模型："].join("\n"),
        replyMarkup: keyboard,
      },
    );
  });

  bot.command("effort", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const efforts: ModelReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
    const current = session.getInfo().reasoningEffort;
    const effortButtons = efforts.map((effort) => ({
      label: effort === current ? `${effort} ✓` : effort,
      callbackData: `effort_${effort}`,
    }));
    pendingEffortButtons.set(contextKey, effortButtons);
    const keyboard = paginateKeyboard(effortButtons, 0, "effort");
    const text = current
      ? `<b>推理强度：</b><code>${escapeHTML(current)}</code>\n\n请选择用于新会话的推理强度：`
      : "<b>推理强度：</b>未设置（使用模型默认值）\n\n请选择用于新会话的推理强度：";
    await safeReply(ctx, text, {
      fallbackText: text.replace(/<[^>]+>/g, ""),
      replyMarkup: keyboard,
    });
  });

  bot.callbackQuery(NOOP_PAGE_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
  });
  handlePageCallback(/^sess_page_(\d+)$/, "sess", pendingSessionButtons, "已过期，请重新运行 /sessions");
  handlePageCallback(/^ws_page_(\d+)$/, "ws", pendingWorkspaceButtons, "已过期，请重新运行 /new");
  handlePageCallback(
    /^launch_page_(\d+)$/,
    "launch",
    pendingLaunchButtons,
    `已过期，请重新运行 ${LAUNCH_PROFILES_COMMAND}`,
  );
  handlePageCallback(/^model_page_(\d+)$/, "model", pendingModelButtons, "已过期，请重新运行 /model");
  handlePageCallback(/^effort_page_(\d+)$/, "effort", pendingEffortButtons, "已过期，请重新运行 /effort");

  bot.callbackQuery(/^git_view:(status|diff|log|remotes)$/, async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    const view = ctx.match?.[1] as "status" | "diff" | "log" | "remotes" | undefined;
    if (!contextSession || !view) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    await sendGitView(ctx, contextSession.session.getCurrentWorkspace(), view);
  });

  bot.callbackQuery(/^usage_view:(day|week)$/, async (ctx) => {
    const period = ctx.match?.[1] as "day" | "week" | undefined;
    if (!period) {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();
    const since = Date.now() - (period === "week" ? 7 : 1) * 24 * 60 * 60 * 1000;
    const label = period === "week" ? "最近 7 天" : "最近 24 小时";
    const text = formatUsageSummary(label, usageStore.summarizeSince(since));
    const keyboard = new InlineKeyboard()
      .text("📅 最近 24 小时", "usage_view:day")
      .text("🗓️ 最近 7 天", "usage_view:week");
    const messageId = ctx.callbackQuery.message?.message_id;
    if (ctx.chat && messageId) {
      await safeEditMessage(bot, ctx.chat.id, messageId, formatTelegramHTML(text), {
        fallbackText: text,
        replyMarkup: keyboard,
      });
    }
  });

  bot.callbackQuery("security_launch_profiles", async (ctx) => {
    await ctx.answerCallbackQuery();
    await openLaunchProfilesPicker(ctx);
  });

  bot.callbackQuery(/^git_diff_file:([\w-]+)$/, async (ctx) => {
    const id = ctx.match?.[1];
    const pending = id ? pendingGitDiffs.get(id) : undefined;
    if (!pending || pending.chatId !== ctx.chat?.id) {
      await ctx.answerCallbackQuery({ text: "diff 已过期，请重新运行 /git diff" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `正在读取 ${trimLine(pending.filePath, 32)} 的 diff……` });
    const diff = await getGitFileDiff(pending.workspace, pending.filePath)
      .catch((error) => `读取 diff 失败：${friendlyErrorText(error)}`);
    const maxLength = 24_000;
    const displayed = diff.length > maxLength ? `${diff.slice(0, maxLength)}\n\n……diff 过长，已截断。` : diff;
    for (const chunk of splitTelegramText(displayed)) {
      await sendTextMessage(bot.api, pending.chatId, chunk, {
        parseMode: undefined,
        fallbackText: chunk,
        ...(pending.messageThreadId ? { messageThreadId: pending.messageThreadId } : {}),
      });
    }
  });

  bot.callbackQuery(/^codex_abort:(.+)$/, async (ctx) => {
    const contextKey = ctx.match?.[1];
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }

    const session = registry.get(contextKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "没有可取消的操作" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "正在取消……" });
    const cancellation = markTaskCancelled(contextKey);
    await session.abort();
    clearPlanInteractionState(contextKey, new Error("操作已取消。"));
    await cancellation;
  });

  bot.callbackQuery("ws_new_path", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) return;

    const { contextKey } = contextSession;
    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "请等待当前提问完成" });
      return;
    }

    pendingWorkspacePathRequests.add(contextKey);
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);
    await ctx.answerCallbackQuery({ text: "请发送文件夹绝对路径" });
    await safeReply(ctx, [
      "<b>请发送新工作区的绝对路径：</b>",
      "例如：<code>C:\\Projects\\demo</code>、<code>D:\\</code>、<code>/workspace/demo</code> 或 <code>/</code>。",
      "路径不存在时会自动创建。",
    ].join("\n"), {
      fallbackText: "请发送新工作区的绝对路径，例如 C:\\Projects\\demo、D:\\、/workspace/demo 或 /。路径不存在时会自动创建。",
    });
  });

  bot.callbackQuery(/^plan_confirm:([\w-]+)$/, async (ctx) => {
    const actionId = ctx.match?.[1];
    const action = actionId ? pendingPlanActions.get(actionId) : undefined;
    if (!action) {
      await ctx.answerCallbackQuery({ text: "计划已更新，请使用最新的按钮" });
      return;
    }
    if (!action.confirm) {
      await ctx.answerCallbackQuery({ text: "当前没有可确认的计划，请重新生成" });
      return;
    }

    const busyState = getBusyState(action.contextKey);
    if (busyState.processing) {
      await ctx.answerCallbackQuery({ text: "计划仍在生成中，请稍候再确认" });
      return;
    }

    pendingPlanActions.delete(actionId!);
    planMessages.delete(action.contextKey);
    await ctx.answerCallbackQuery({ text: "正在执行此计划……" });
    await bot.api.editMessageReplyMarkup(ctx.chat!.id, action.messageId, { reply_markup: new InlineKeyboard() }).catch(() => {});
    busyState.processing = true;
    void action.confirm()
      .catch((error) => console.error("确认 Plan Mode 计划失败", error))
      .finally(() => {
        busyState.processing = false;
      });
  });

  bot.callbackQuery(/^plan_regenerate:([\w-]+)$/, async (ctx) => {
    const actionId = ctx.match?.[1];
    const action = actionId ? pendingPlanActions.get(actionId) : undefined;
    if (!action?.regenerate) {
      await ctx.answerCallbackQuery({ text: "计划已更新，请使用最新的按钮" });
      return;
    }

    const busyState = getBusyState(action.contextKey);
    if (busyState.processing) {
      await ctx.answerCallbackQuery({ text: "计划仍在生成中，请稍候再试" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "正在重新生成计划……" });
    busyState.processing = true;
    void action.regenerate()
      .catch((error) => console.error("重新生成 Plan Mode 计划失败", error))
      .finally(() => {
        busyState.processing = false;
      });
  });

  bot.callbackQuery(/^plan_steer:([\w-]+)$/, async (ctx) => {
    const actionId = ctx.match?.[1];
    const action = actionId ? pendingPlanActions.get(actionId) : undefined;
    if (!action) {
      await ctx.answerCallbackQuery({ text: "计划已更新，请使用最新的按钮" });
      return;
    }

    if (getBusyState(action.contextKey).processing) {
      await ctx.answerCallbackQuery({ text: "计划仍在生成中，请稍候再修改" });
      return;
    }

    pendingPlanSteers.set(action.contextKey, action);
    pendingPlanTextRequests.set(action.contextKey, actionId!);
    await ctx.answerCallbackQuery({ text: "请发送要修改或补充的内容" });
    await safeReply(ctx, "请发送对计划的修改或补充内容。", {
      fallbackText: "请发送对计划的修改或补充内容。",
    });
  });

  bot.callbackQuery(/^plan_cancel:([\w-]+)$/, async (ctx) => {
    const actionId = ctx.match?.[1];
    const action = actionId ? pendingPlanActions.get(actionId) : undefined;
    if (!action) {
      await ctx.answerCallbackQuery({ text: "计划已结束或已更新" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "正在取消……" });
    const cancellation = markTaskCancelled(action.contextKey);
    clearPlanInteractionState(action.contextKey, new Error("Plan Mode 已取消。"));
    planModeContexts.delete(action.contextKey);
    await action.cancel().catch((error) => console.error("取消 Plan Mode 失败", error));
    await cancellation;
    await bot.api.editMessageReplyMarkup(ctx.chat!.id, action.messageId, { reply_markup: new InlineKeyboard() }).catch(() => {});
  });

  bot.callbackQuery(/^plan_answer:([\w-]+):(\d+)$/, async (ctx) => {
    const requestId = ctx.match?.[1];
    const optionIndex = Number.parseInt(ctx.match?.[2] ?? "", 10);
    const pending = requestId ? pendingPlanInputs.get(requestId) : undefined;
    const option = pending?.question.options?.[optionIndex];
    if (!pending || !option) {
      await ctx.answerCallbackQuery({ text: "问题已过期，请等待下一步" });
      return;
    }

    pendingPlanInputs.delete(requestId!);
    await ctx.answerCallbackQuery({ text: "已记录" });
    pending.resolve(option.label);
    const messageId = ctx.callbackQuery.message?.message_id;
    if (ctx.chat?.id && messageId) {
      await safeEditMessage(bot, ctx.chat.id, messageId, `<b>已选择：</b>${escapeHTML(option.label)}`, {
        fallbackText: `已选择：${option.label}`,
      }).catch(() => {});
    }
  });

  bot.callbackQuery(/^plan_other:([\w-]+)$/, async (ctx) => {
    const requestId = ctx.match?.[1];
    const pending = requestId ? pendingPlanInputs.get(requestId) : undefined;
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "问题已过期，请等待下一步" });
      return;
    }

    pendingPlanTextRequests.set(pending.contextKey, requestId!);
    await ctx.answerCallbackQuery({ text: "请发送自定义回答" });
    await safeReply(ctx, "请发送你的自定义回答。", { fallbackText: "请发送你的自定义回答。" });
  });

  bot.callbackQuery(/^plan_approve:([\w-]+):(accept|acceptForSession|decline)$/, async (ctx) => {
    const actionId = ctx.match?.[1];
    const decision = ctx.match?.[2];
    const pending = actionId ? pendingPlanDecisions.get(actionId) : undefined;
    if (!pending || !decision) {
      await ctx.answerCallbackQuery({ text: "审批已过期" });
      return;
    }

    pendingPlanDecisions.delete(actionId!);
    await ctx.answerCallbackQuery({ text: decision === "decline" ? "已拒绝" : "已允许" });
    if (pending.request.kind === "permissions") {
      pending.resolve({
        permissions: decision === "decline" ? {} : pending.request.permissions,
        scope: decision === "acceptForSession" ? "session" : "turn",
      });
    } else {
      pending.resolve({ decision });
    }
    const messageId = ctx.callbackQuery.message?.message_id;
    if (ctx.chat?.id && messageId) {
      const label = decision === "decline" ? "❌ 已拒绝" : decision === "acceptForSession" ? "✅ 已允许本次会话" : "✅ 已允许一次";
      await safeEditMessage(bot, ctx.chat.id, messageId, label, { fallbackText: label }).catch(() => {});
    }
  });

  bot.callbackQuery(/^sess_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const threadIds = pendingSessionPicks.get(contextKey);
    const threadId = threadIds?.[index];
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: "会话列表已过期，请重新运行 /sessions" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "请等待当前提问完成" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "正在切换……" });
    pendingSessionPicks.delete(contextKey);
    pendingSessionButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const plainText = `已切换会话。\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>已切换会话。</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>失败：</b>${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `失败：${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^ws_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const workspaces = pendingWorkspacePicks.get(contextKey);
    const workspace = workspaces?.[index];
    if (!workspace) {
      await ctx.answerCallbackQuery({ text: "操作已过期，请重新运行 /new" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "请等待当前提问完成" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "正在创建会话……" });
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.newThread(workspace);
      updateSessionMetadata(contextKey, session);
      const label = isTopicContext(contextKey) ? "已为当前话题新建会话。" : "已新建会话。";
      const plainText = `${label}\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>失败：</b>${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `失败：${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^launch_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const launchProfileIds = pendingLaunchPicks.get(contextKey);
    const profileId = launchProfileIds?.[index];
    if (!profileId) {
      await ctx.answerCallbackQuery({ text: `操作已过期，请重新运行 ${LAUNCH_PROFILES_COMMAND}` });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "请等待当前提问完成" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "启动配置已不存在" });
      return;
    }

    if (profile.unsafe) {
      pendingUnsafeLaunchConfirmations.set(contextKey, profile.id);
      pendingLaunchPicks.delete(contextKey);
      pendingLaunchButtons.delete(contextKey);

      await ctx.answerCallbackQuery({ text: "请确认 danger-full-access" });
      const confirmKeyboard = new InlineKeyboard()
        .text("启用 danger-full-access", `launchconfirm_yes:${profile.id}`)
        .row()
        .text("取消", `launchconfirm_no:${profile.id}`);
      const html = [
        `<b>确认启动配置：</b><code>${escapeHTML(profile.label)}</code>`,
        `<b>行为：</b><code>${escapeHTML(formatLaunchProfileBehavior(profile))}</code>`,
        "",
        "⚠️ <b>此配置使用 danger-full-access。</b>",
        "它将应用于当前 Telegram 上下文中新建或重新绑定的会话。",
      ].join("\n");
      const plain = [
        `确认启动配置：${profile.label}`,
        `行为：${formatLaunchProfileBehavior(profile)}`,
        "",
        "警告：此配置使用 danger-full-access。",
        "它将应用于当前 Telegram 上下文中新建或重新绑定的会话。",
      ].join("\n");

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      } else {
        await safeReply(ctx, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: `已设置启动配置：${profile.label}` });
    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);

    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedProfile))}</code>`,
      "",
      "Applies to new or reattached threads.",
    ].join("\n");
    const plain = [
      `Launch profile set to ${selectedProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedProfile)}`,
      "",
      "Applies to new or reattached threads.",
    ].join("\n");

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
    } else {
      await safeReply(ctx, html, { fallbackText: plain });
    }
  });

  bot.callbackQuery(/^launchconfirm_(yes|no):([a-z0-9_-]+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const action = ctx.match?.[1];
    const confirmedProfileId = ctx.match?.[2];

    if (!chatId || !messageId || !action || !confirmedProfileId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const profileId = pendingUnsafeLaunchConfirmations.get(contextKey);
    if (!profileId || profileId !== confirmedProfileId) {
      await ctx.answerCallbackQuery({ text: `操作已过期，请重新运行 ${LAUNCH_PROFILES_COMMAND}` });
      return;
    }

    if (action === "no") {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "已取消" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>已取消启动配置更改。</b>\n\n请重新运行 ${LAUNCH_PROFILES_COMMAND} 选择其他配置。`,
        {
          fallbackText: `已取消启动配置更改。\n\n请重新运行 ${LAUNCH_PROFILES_COMMAND} 选择其他配置。`,
        },
      );
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "请等待当前提问完成" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "启动配置已不存在" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>启动配置已过期。</b>\n\n请重新运行 ${LAUNCH_PROFILES_COMMAND}。`,
        {
          fallbackText: `启动配置已过期。\n\n请重新运行 ${LAUNCH_PROFILES_COMMAND}。`,
        },
      );
      return;
    }

    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);
    await ctx.answerCallbackQuery({ text: `已设置启动配置：${selectedProfile.label}` });

    const html = [
      `<b>已设置启动配置：</b><code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>行为：</b><code>${escapeHTML(formatLaunchProfileBehavior(selectedProfile))}</code>`,
      "",
      "⚠️ <i>已确认对新建或重新绑定的会话使用 danger-full-access。</i>",
    ].join("\n");
    const plain = [
      `已设置启动配置：${selectedProfile.label}`,
      `行为：${formatLaunchProfileBehavior(selectedProfile)}`,
      "",
      "已确认对新建或重新绑定的会话使用 danger-full-access。",
    ].join("\n");

    await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
  });

  bot.callbackQuery(/^model_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const slug = ctx.match?.[1];

    if (!chatId || !slug) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingModelButtons.get(contextKey);
    if (!buttons) {
      await ctx.answerCallbackQuery({ text: "操作已过期，请重新运行 /model" });
      return;
    }

    const modelExists = buttons.some((button) => button.callbackData === `model_${slug}`);
    if (!modelExists) {
      await ctx.answerCallbackQuery({ text: "操作已过期，请重新运行 /model" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "请等待当前提问完成" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "正在设置模型……" });
    pendingModelButtons.delete(contextKey);

    try {
      const model = session.setModel(slug);
      updateSessionMetadata(contextKey, session);
      const html = `<b>已设置模型：</b><code>${escapeHTML(model)}</code>（对新会话生效）。`;
      const plainText = `已设置模型：${model}（对新会话生效）。`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>失败：</b>${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `失败：${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    }
  });

  bot.callbackQuery(/^effort_(minimal|low|medium|high|xhigh)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const effort = ctx.match?.[1] as ModelReasoningEffort | undefined;

    if (!chatId || !messageId || !effort) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingEffortButtons.get(contextKey);
    if (!buttons || !buttons.some((button) => button.callbackData === `effort_${effort}`)) {
      await ctx.answerCallbackQuery({ text: "操作已过期，请重新运行 /effort" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `已设置推理强度：${effort}` });
    pendingEffortButtons.delete(contextKey);
    session.setReasoningEffort(effort);
    updateSessionMetadata(contextKey, session);
    const html = `⚡ 已设置推理强度：<code>${escapeHTML(effort)}</code>（对新会话生效）。`;
    await safeEditMessage(bot, chatId, messageId, html, {
      fallbackText: `⚡ 已设置推理强度：${effort}（对新会话生效）。`,
    });
  });

  bot.on("message:text", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const userText = ctx.message.text.trim();
    if (!userText) {
      return;
    }

    const { contextKey, session } = contextSession;

    if (pendingWorkspacePathRequests.has(contextKey)) {
      if (isBusy(contextKey)) {
        await sendBusyReply(ctx);
        return;
      }

      const busyState = getBusyState(contextKey);
      busyState.switching = true;
      try {
        const workspace = await ensureWorkspaceDirectory(userText);
        const info = await session.newThread(workspace);
        pendingWorkspacePathRequests.delete(contextKey);
        clearPlanInteractionState(contextKey, new Error("已新建工作区会话。"));
        updateSessionMetadata(contextKey, session);
        const label = isTopicContext(contextKey) ? "已为当前话题新建会话。" : "已新建会话。";
        await safeReply(ctx, `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`, {
          fallbackText: `${label}\n\n${renderSessionInfoPlain(info)}`,
        });
      } catch (error) {
        await safeReply(ctx, `<b>无法创建工作区：</b>${escapeHTML(friendlyErrorText(error))}\n\n请重新发送绝对路径，或使用 /new 重新选择。`, {
          fallbackText: `无法创建工作区：${friendlyErrorText(error)}\n\n请重新发送绝对路径，或使用 /new 重新选择。`,
        });
      } finally {
        busyState.switching = false;
      }
      return;
    }

    if (userText.startsWith("/")) {
      return;
    }

    const pendingTextRequest = pendingPlanTextRequests.get(contextKey);
    if (pendingTextRequest) {
      const pendingInput = pendingPlanInputs.get(pendingTextRequest);
      if (pendingInput) {
        pendingPlanTextRequests.delete(contextKey);
        pendingPlanInputs.delete(pendingTextRequest);
        pendingInput.resolve(userText);
        await safeReply(ctx, "<b>已记录你的回答。</b>", { fallbackText: "已记录你的回答。" });
        return;
      }

      const steer = pendingPlanSteers.get(contextKey);
      if (steer) {
        pendingPlanTextRequests.delete(contextKey);
        pendingPlanSteers.delete(contextKey);
        await safeReply(ctx, "<b>正在根据你的补充更新计划……</b>", { fallbackText: "正在根据你的补充更新计划……" });
        void steer.steer(userText).catch((error) => console.error("更新 Plan Mode 计划失败", error));
        return;
      }

      pendingPlanTextRequests.delete(contextKey);
    }

    const promptInput = withReplyContext(
      userText,
      formatReplyContext(ctx.message.reply_to_message as ReferencedTelegramMessage | undefined),
    );
    lastPromptInput.set(contextKey, promptInput);
    await setReaction(ctx, "👀");
    try {
      if (planModeContexts.has(contextKey)) {
        await handlePlanPrompt(ctx, contextKey, ctx.chat.id, session, promptInput, "start");
      } else {
        await handleUserPrompt(ctx, contextKey, ctx.chat.id, session, promptInput);
      }
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;
    let transcript: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId);

      const result = await transcribeAudio(tempFilePath);
      transcript = result.text.trim();
      if (!transcript) {
        await safeReply(ctx, escapeHTML("未识别到语音内容。请重试，或直接发送文字。"), {
          fallbackText: "未识别到语音内容。请重试，或直接发送文字。",
        });
        return;
      }

      const preview = trimLine(transcript.replace(/\s+/g, " "), 100);
      await safeReply(
        ctx,
        `🎙️ <b>转写结果：</b>${escapeHTML(preview)} <i>（通过 ${escapeHTML(result.backend)}）</i>`,
        { fallbackText: `🎙️ 转写结果：${preview}（通过 ${result.backend}）` },
      );
    } catch (error) {
      const note = "提示：语音转写使用 OPENAI_API_KEY，而不是 CODEX_API_KEY。";
      await safeReply(ctx, `<b>语音转写失败：</b>\n${escapeHTML(friendlyErrorText(error))}\n\n<i>${escapeHTML(note)}</i>`, {
        fallbackText: `语音转写失败：\n${friendlyErrorText(error)}\n\n${note}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    if (!transcript) {
      return;
    }

    const promptInput = withReplyContext(
      transcript,
      formatReplyContext(ctx.message.reply_to_message as ReferencedTelegramMessage | undefined),
    );
    lastPromptInput.set(contextKey, promptInput);
    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, promptInput);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.on("message:photo", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (!photo) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "upload_photo");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, photo.file_id, 20 * 1024 * 1024);
    } catch (error) {
      await safeReply(ctx, `<b>下载图片失败：</b>${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `下载图片失败：${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (!tempFilePath) {
        // Download failed — nothing to clean up further
      }
    }

    const caption = ctx.message.caption?.trim();
    const promptInput: { text?: string; imagePaths: string[] } = { imagePaths: [tempFilePath] };
    if (caption) {
      promptInput.text = caption;
    }
    const contextualPrompt = withReplyContext(
      promptInput,
      formatReplyContext(ctx.message.reply_to_message as ReferencedTelegramMessage | undefined),
    );
    lastPromptInput.set(contextKey, contextualPrompt);
    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, contextualPrompt);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    } finally {
      await unlink(tempFilePath).catch(() => {});
    }
  });

  bot.on("message:document", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const doc = ctx.message.document;
    if (!doc) {
      return;
    }

    if (doc.file_size && doc.file_size > config.maxFileSize) {
      const sizeMB = Math.round(doc.file_size / 1024 / 1024);
      const maxMB = Math.round(config.maxFileSize / 1024 / 1024);
      await safeReply(ctx, `<b>文件过大</b>（${sizeMB} MB，最大 ${maxMB} MB）`, {
        fallbackText: `文件过大（${sizeMB} MB，最大 ${maxMB} MB）`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, doc.file_id, config.maxFileSize);
    } catch (error) {
      await safeReply(ctx, `<b>下载文件失败：</b>${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `下载文件失败：${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
    }

    const turnId = randomUUID().slice(0, 12);
    const workspace = session.getCurrentWorkspace();
    const originalName = doc.file_name ?? "document";
    const mimeType = doc.mime_type ?? "application/octet-stream";

    let stagedFile: StagedFile;
    try {
      const buffer = await readFile(tempFilePath);
      stagedFile = await stageFile(buffer, originalName, mimeType, {
        workspace,
        turnId,
        maxFileSize: config.maxFileSize,
      });
    } catch (error) {
      await safeReply(ctx, `<b>暂存文件失败：</b>${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `暂存文件失败：${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    await safeReply(ctx, `📎 <b>已收到：</b><code>${escapeHTML(stagedFile.safeName)}</code>`, {
      fallbackText: `📎 已收到：${stagedFile.safeName}`,
    });

    // Keep typing visible during the gap between staging and prompt execution
    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

    const outDir = outboxPath(workspace, turnId);
    await ensureOutDir(outDir);

    const promptInput: CodexPromptInput = {
      stagedFileInstructions: buildFileInstructions([stagedFile], outDir),
    };
    const caption = ctx.message.caption?.trim();
    if (caption) {
      promptInput.text = caption;
    }
    const contextualPrompt = withReplyContext(
      promptInput,
      formatReplyContext(ctx.message.reply_to_message as ReferencedTelegramMessage | undefined),
    );
    lastPromptInput.set(contextKey, contextualPrompt);

    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, contextualPrompt);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    } finally {
      try {
        await deliverArtifacts(ctx, chatId, outDir, parseContextKey(contextKey).messageThreadId);
      } catch (artifactError) {
        console.error("Failed to deliver artifacts:", artifactError);
      } finally {
        await cleanupInbox(workspace, turnId);
        // TODO: prune old outbox turn folders by age or count to avoid unbounded growth
      }
    }
  });

  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    console.error("Telegram bot error:", message);
  });

  return bot;
}

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "欢迎与状态" },
    { command: "help", description: "命令说明" },
    { command: "new", description: "新建会话" },
    { command: "plan", description: "切换 Plan Mode" },
    { command: "session", description: "当前会话详情" },
    { command: "status", description: "查看当前任务状态" },
    { command: "security", description: "查看安全配置" },
    { command: "sessions", description: "浏览并切换会话" },
    { command: "retry", description: "重新发送上一条提问" },
    { command: "abort", description: "取消当前操作" },
    { command: "launch_profiles", description: "选择启动配置" },
    { command: "model", description: "查看并切换模型" },
    { command: "effort", description: "设置推理强度" },
    { command: "auth", description: "检查认证状态" },
    { command: "login", description: "开始认证" },
    { command: "logout", description: "退出登录" },
    { command: "voice", description: "语音转写状态" },
    { command: "git", description: "查看 Git 状态和 diff" },
    { command: "usage", description: "查看 token 用量" },
    { command: "handback", description: "将会话交还给 Codex CLI" },
    { command: "attach", description: "将 Codex 会话绑定到当前话题" },
    { command: "switch", description: "按 ID 切换会话" },
  ]);
}

function renderSessionInfoPlain(info: CodexSessionInfo): string {
  return [
    `会话 ID：${info.threadId ?? "（尚未启动）"}`,
    `工作区：${info.workspace}`,
    `启动配置：${info.launchProfileLabel}（${info.launchProfileBehavior}）${info.unsafeLaunch ? " [不安全]" : ""}`,
    info.nextLaunchProfileId
      ? `下次启动配置：${info.nextLaunchProfileLabel}（${info.nextLaunchProfileBehavior}）${info.nextUnsafeLaunch ? " [不安全]" : ""}`
      : undefined,
    info.model ? `模型：${info.model}` : undefined,
    info.reasoningEffort ? `推理强度：${info.reasoningEffort}` : undefined,
    info.sessionTokens ? formatSessionTokensPlain(info.sessionTokens) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderSessionInfoHTML(info: CodexSessionInfo): string {
  return [
    `<b>会话 ID：</b><code>${escapeHTML(info.threadId ?? "（尚未启动）")}</code>`,
    `<b>工作区：</b><code>${escapeHTML(info.workspace)}</code>`,
    `<b>启动配置：</b><code>${escapeHTML(info.launchProfileLabel)}</code>`,
    `<b>启动行为：</b><code>${escapeHTML(info.launchProfileBehavior)}</code>${info.unsafeLaunch ? " ⚠️" : ""}`,
    info.nextLaunchProfileId
      ? `<b>下次启动配置：</b><code>${escapeHTML(info.nextLaunchProfileLabel ?? "")}</code> <i>（${escapeHTML(info.nextLaunchProfileBehavior ?? "")}）</i>${info.nextUnsafeLaunch ? " ⚠️" : ""}`
      : undefined,
    info.model ? `<b>模型：</b><code>${escapeHTML(info.model)}</code>` : undefined,
    info.reasoningEffort ? `<b>推理强度：</b><code>${escapeHTML(info.reasoningEffort)}</code>` : undefined,
    info.sessionTokens ? `<b>会话 Token：</b><code>${escapeHTML(formatSessionTokensValue(info.sessionTokens))}</code>` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderLaunchSummaryPlain(info: CodexSessionInfo): string {
  return `启动配置：${info.launchProfileLabel}（${info.launchProfileBehavior}）${info.unsafeLaunch ? " [不安全]" : ""}`;
}

function renderLaunchSummaryHTML(info: CodexSessionInfo): string {
  const suffix = info.unsafeLaunch ? " ⚠️" : "";
  return `<b>启动配置：</b><code>${escapeHTML(info.launchProfileLabel)}</code> <i>（${escapeHTML(info.launchProfileBehavior)}）</i>${suffix}`;
}

function renderToolStartMessage(toolName: string): RenderedText {
  return {
    text: `<b>🔧 正在运行：</b><code>${escapeHTML(toolName)}</code>`,
    fallbackText: `🔧 正在运行：${toolName}`,
    parseMode: "HTML",
  };
}

function renderToolEndMessage(toolName: string, partialResult: string, isError: boolean): RenderedText {
  const preview = summarizeToolOutput(partialResult);
  const icon = isError ? "❌" : "✅";
  const htmlLines = [`<b>${icon}</b> <code>${escapeHTML(toolName)}</code>`];
  const plainLines = [`${icon} ${toolName}`];

  if (preview) {
    if (isExpandableTool(toolName)) {
      htmlLines.push(`<blockquote expandable>${escapeHTML(preview)}</blockquote>`);
    } else {
      htmlLines.push(`<pre>${escapeHTML(preview)}</pre>`);
    }
    plainLines.push(preview);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

function isExpandableTool(toolName: string): boolean {
  return (
    !toolName.startsWith("🔍 ") &&
    toolName !== "file_change" &&
    toolName !== "⚠️ error" &&
    !toolName.startsWith("mcp:")
  );
}

export function formatToolSummaryLine(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) {
    return "";
  }

  const summarizedCounts = new Map<string, number>();
  for (const [toolName, count] of toolCounts.entries()) {
    const summaryName = summarizeToolName(toolName);
    summarizedCounts.set(summaryName, (summarizedCounts.get(summaryName) ?? 0) + count);
  }

  const entries = [...summarizedCounts.entries()].sort((left, right) => {
    const countDelta = right[1] - left[1];
    return countDelta !== 0 ? countDelta : left[0].localeCompare(right[0]);
  });
  const tools = entries
    .map(([name, count]) => formatSummaryEntry(name, count))
    .join(", ");
  return `已使用工具：${tools}`;
}

function renderTodoList(items: Array<{ text: string; completed: boolean }>): string {
  const lines = items.map((item) => {
    const icon = item.completed ? "✅" : "⬜";
    return `${icon} ${escapeHTML(item.text)}`;
  });
  return `📋 <b>计划</b>\n${lines.join("\n")}`;
}

export function formatTurnUsageLine(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): string {
  return `🪙 输入：${usage.inputTokens} · 缓存：${usage.cachedInputTokens} · 输出：${usage.outputTokens}`;
}

export function summarizeToolName(toolName: string): string {
  if (toolName.startsWith("🔍 ")) {
    return "web_fetch";
  }

  if (toolName === "file_change") {
    return "file_change";
  }

  if (toolName === "⚠️ error") {
    return "error";
  }

  if (toolName.startsWith("mcp:")) {
    const tool = toolName.split("/").at(-1) ?? toolName;
    if (SUBAGENT_TOOL_NAMES.has(tool)) {
      return "subagent";
    }
    return tool;
  }

  return "bash";
}

function formatSummaryEntry(name: string, count: number): string {
  if (count <= 1) {
    return name;
  }

  const label = name === "subagent" ? "subagents" : name;
  return `${count}x ${label}`;
}

const SUBAGENT_TOOL_NAMES = new Set(["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"]);

function formatSessionTokensValue(tokens: { input: number; cached: number; output: number }): string {
  return `输入：${tokens.input} · 缓存：${tokens.cached} · 输出：${tokens.output}`;
}

function formatSessionTokensPlain(tokens: { input: number; cached: number; output: number }): string {
  return `会话 Token：${formatSessionTokensValue(tokens)}`;
}

async function safeReply(ctx: Context, text: string, options: TextOptions = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  const parseMode = options.parseMode !== undefined ? options.parseMode : ("HTML" as TelegramParseMode);
  const messageThreadId =
    options.messageThreadId ?? ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;

  const chunks = splitTelegramText(text);
  const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, chatId, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
      messageThreadId,
    });
  }
}

async function sendTextMessage(
  api: Context["api"],
  chatId: TelegramChatId,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    return await api.sendMessage(chatId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      return await api.sendMessage(chatId, options.fallbackText, {
        ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
        reply_markup: options.replyMarkup,
      });
    }
    throw error;
  }
}

async function safeEditMessage(
  bot: Bot<Context>,
  chatId: TelegramChatId,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    await bot.api.editMessageText(chatId, messageId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      await bot.api.editMessageText(chatId, messageId, options.fallbackText, {
        reply_markup: options.replyMarkup,
      });
      return;
    }

    throw error;
  }
}

async function downloadTelegramFile(
  api: Context["api"],
  token: string,
  fileId: string,
  maxBytes = MAX_AUDIO_FILE_SIZE,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram 未返回文件路径");
  }

  if (file.file_size && file.file_size > maxBytes) {
    throw new Error(
      `Telegram 文件过大（${Math.round(file.file_size / 1024 / 1024)} MB，最大 ${Math.round(maxBytes / 1024 / 1024)} MB）`,
    );
  }

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载 Telegram 文件失败：${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(file.file_path) || ".bin";
  const tempPath = path.join(tmpdir(), `telecodex-file-${randomUUID()}${extension}`);
  await writeFile(tempPath, buffer);
  return tempPath;
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

function splitMarkdownForTelegram(markdown: string): RenderedChunk[] {
  if (!markdown) {
    return [];
  }

  const chunks: RenderedChunk[] = [];
  let remaining = markdown;

  while (remaining) {
    const maxLength = Math.min(remaining.length, FORMATTED_CHUNK_TARGET);
    const initialCut = findPreferredSplitIndex(remaining, maxLength);
    const candidate = remaining.slice(0, initialCut) || remaining.slice(0, 1);
    const rendered = renderMarkdownChunkWithinLimit(candidate);

    chunks.push(rendered);
    remaining = remaining.slice(rendered.sourceText.length).trimStart();
  }

  return chunks;
}

function renderMarkdownChunkWithinLimit(markdown: string): RenderedChunk {
  if (!markdown) {
    return {
      text: "",
      fallbackText: "",
      parseMode: "HTML",
      sourceText: "",
    };
  }

  let sourceText = markdown;
  let rendered = formatMarkdownMessage(sourceText);

  while (rendered.text.length > TELEGRAM_MESSAGE_LIMIT && sourceText.length > 1) {
    const nextLength = Math.max(1, sourceText.length - Math.max(100, Math.ceil(sourceText.length * 0.1)));
    sourceText = sourceText.slice(0, nextLength).trimEnd() || sourceText.slice(0, nextLength);
    rendered = formatMarkdownMessage(sourceText);
  }

  return {
    ...rendered,
    sourceText,
  };
}

function formatMarkdownMessage(markdown: string): RenderedText {
  try {
    return {
      text: formatTelegramHTML(markdown),
      fallbackText: markdown,
      parseMode: "HTML",
    };
  } catch (error) {
    console.error("格式化 Telegram HTML 失败，改用纯文本", error);
    return {
      text: markdown,
      fallbackText: markdown,
      parseMode: undefined,
    };
  }
}

function findPreferredSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return Math.max(1, text.length);
  }

  const newlineIndex = text.lastIndexOf("\n", maxLength);
  if (newlineIndex >= maxLength * 0.5) {
    return Math.max(1, newlineIndex);
  }

  const spaceIndex = text.lastIndexOf(" ", maxLength);
  if (spaceIndex >= maxLength * 0.5) {
    return Math.max(1, spaceIndex);
  }

  return Math.max(1, maxLength);
}

function appendWithCap(base: string, addition: string, cap: number): string {
  const combined = `${base}${addition}`;
  return combined.length <= cap ? combined : combined.slice(-cap);
}

function summarizeToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= TOOL_OUTPUT_PREVIEW_LIMIT ? trimmed : `${trimmed.slice(-TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`;
}

function trimLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

function formatRelativeTime(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1000));

  if (deltaSeconds < 60) {
    return "刚刚";
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes} 分钟前`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours} 小时前`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 14) {
    return `${deltaDays} 天前`;
  }

  const deltaWeeks = Math.floor(deltaDays / 7);
  return `${deltaWeeks} 周前`;
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
}

function isTelegramParseError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes("unsupported start tag") ||
    message.includes("unexpected end tag") ||
    message.includes("entity name") ||
    message.includes("parse entities")
  );
}

function renderPromptFailure(error: unknown): string {
  const message = friendlyErrorText(error);
  return `⚠️ ${message}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
