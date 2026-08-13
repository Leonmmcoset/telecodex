import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";

export type AppServerRequestId = number | string;

export type AppServerInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string };

export type PlanStepStatus = "pending" | "inProgress" | "completed";

export interface AppServerPlanStep {
  step: string;
  status: PlanStepStatus;
}

export interface AppServerPlanUpdate {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: AppServerPlanStep[];
}

export interface AppServerUserInputOption {
  label: string;
  description: string;
}

export interface AppServerUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: AppServerUserInputOption[] | null;
}

export interface AppServerUserInputRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: AppServerUserInputQuestion[];
}

export interface AppServerCommandApprovalRequest {
  kind: "command";
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
}

export interface AppServerFileApprovalRequest {
  kind: "file";
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

export interface AppServerPermissionApprovalRequest {
  kind: "permissions";
  threadId: string;
  turnId: string;
  itemId: string;
  reason: string | null;
  permissions: unknown;
}

export type AppServerApprovalRequest =
  | AppServerCommandApprovalRequest
  | AppServerFileApprovalRequest
  | AppServerPermissionApprovalRequest;

export interface AppServerCallbacks {
  onAgentMessage: (text: string) => void;
  onToolStart: (toolName: string, toolCallId: string) => void;
  onToolUpdate: (toolCallId: string, partialResult: string) => void;
  onToolEnd: (toolCallId: string, isError: boolean) => void;
  onPlanUpdate?: (update: AppServerPlanUpdate) => void;
  onUserInputRequest?: (
    request: AppServerUserInputRequest,
  ) => Promise<{ answers: Record<string, { answers: string[] }> }>;
  onApprovalRequest?: (
    request: AppServerApprovalRequest,
  ) => Promise<unknown>;
  onTurnComplete?: (usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  }) => void;
  onAgentEnd: () => void;
}

interface JsonRpcResponse {
  id?: AppServerRequestId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface ServerRequest {
  id: AppServerRequestId;
  method: string;
  params?: any;
}

interface AppServerThread {
  id: string;
  model: string;
}

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<
    AppServerRequestId,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private activeTurnId: string | null = null;
  private activeThreadId: string | null = null;
  private threadModel: string | undefined;
  private initialized = false;
  private stopping = false;
  private readonly pendingTurnEvents = new Map<string, Array<{ method: string; params: any }>>();
  private readonly agentMessageDeltas = new Map<string, string>();

  async startThread(options: {
    workspace: string;
    model?: string;
    sandboxMode: string;
    approvalPolicy: string;
  }): Promise<AppServerThread> {
    if (this.activeThreadId && this.initialized) {
      return { id: this.activeThreadId, model: this.threadModel ?? options.model ?? "" };
    }
    await this.ensureStarted();
    const result = await this.request("thread/start", {
      model: options.model ?? null,
      cwd: options.workspace,
      approvalPolicy: options.approvalPolicy,
      sandbox: options.sandboxMode,
      config: { skip_git_repo_check: true },
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    return this.rememberThread(result);
  }

  async resumeThread(options: {
    threadId: string;
    workspace: string;
    model?: string;
    sandboxMode: string;
    approvalPolicy: string;
  }): Promise<AppServerThread> {
    if (this.activeThreadId === options.threadId && this.initialized) {
      return { id: this.activeThreadId, model: this.threadModel ?? options.model ?? "" };
    }
    await this.ensureStarted();
    const result = await this.request("thread/resume", {
      threadId: options.threadId,
      cwd: options.workspace,
      model: options.model ?? null,
      approvalPolicy: options.approvalPolicy,
      sandbox: options.sandboxMode,
      config: { skip_git_repo_check: true },
      persistExtendedHistory: true,
    });
    return this.rememberThread(result);
  }

  async runPlan(
    input: AppServerInput[],
    callbacks: AppServerCallbacks,
    model?: string,
    reasoningEffort?: string,
  ): Promise<void> {
    await this.runTurn(input, callbacks, {
      model,
      reasoningEffort,
      collaborationMode: {
        mode: "plan",
        settings: {
          model: model ?? this.threadModel ?? "",
          reasoning_effort: reasoningEffort ?? null,
          developer_instructions: "只分析和制定计划，不执行文件修改或命令。输出清晰的编号计划，并在计划完成前发送结构化计划更新。等待用户确认后再执行。",
        },
      },
    });
  }

  async runDefault(
    input: AppServerInput[],
    callbacks: AppServerCallbacks,
    model?: string,
    reasoningEffort?: string,
  ): Promise<void> {
    await this.runTurn(input, callbacks, { model, reasoningEffort });
  }

  private async runTurn(
    input: AppServerInput[],
    callbacks: AppServerCallbacks,
    options: {
      model?: string;
      reasoningEffort?: string;
      collaborationMode?: unknown;
    },
  ): Promise<void> {
    if (!this.activeThreadId) {
      throw new Error("Codex app-server thread is not initialized");
    }

    const turnWaiter = new Promise<void>((resolve, reject) => {
      this.turnWaiters.set("__pending__", { resolve, reject, callbacks });
    });
    let result: any;
    try {
      result = await this.request("turn/start", {
        threadId: this.activeThreadId,
        input,
        ...(options.model ? { model: options.model } : {}),
        ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
        ...(options.collaborationMode ? { collaborationMode: options.collaborationMode } : {}),
      });
    } catch (error) {
      this.turnWaiters.delete("__pending__");
      throw error;
    }
    const turnId = readTurnId(result);
    this.activeTurnId = turnId;
    const pending = this.turnWaiters.get("__pending__");
    this.turnWaiters.delete("__pending__");
    if (pending) this.turnWaiters.set(turnId, pending);
    const queued = this.pendingTurnEvents.get(turnId);
    this.pendingTurnEvents.delete(turnId);
    for (const event of queued ?? []) this.handleNotification(event.method, event.params);
    try {
      await turnWaiter;
    } finally {
      if (this.activeTurnId === turnId) {
        this.activeTurnId = null;
      }
    }
  }

  async steer(input: AppServerInput[]): Promise<void> {
    if (!this.activeThreadId || !this.activeTurnId) {
      throw new Error("当前没有可继续的 Plan Mode 操作。");
    }
    await this.request("turn/steer", {
      threadId: this.activeThreadId,
      input,
      expectedTurnId: this.activeTurnId,
    });
  }

  async interrupt(): Promise<void> {
    if (this.activeThreadId && this.activeTurnId) {
      await this.request("turn/interrupt", {
        threadId: this.activeThreadId,
        turnId: this.activeTurnId,
      }).catch(() => {});
    }
  }

  isTurnActive(): boolean {
    return this.activeTurnId !== null;
  }

  getThreadId(): string | null {
    return this.activeThreadId;
  }

  getThreadModel(): string | undefined {
    return this.threadModel;
  }

  dispose(): void {
    this.stopping = true;
    this.lineReader?.close();
    this.lineReader = null;
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
    this.initialized = false;
    this.activeTurnId = null;
    this.activeThreadId = null;
    this.pendingTurnEvents.clear();
    this.agentMessageDeltas.clear();
    for (const waiter of this.turnWaiters.values()) {
      waiter.reject(new Error("Codex app-server 已关闭。"));
    }
    this.turnWaiters.clear();
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error("Codex app-server 已关闭。"));
    }
    this.pending.clear();
  }

  private readonly turnWaiters = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; callbacks: AppServerCallbacks }
  >();

  private async ensureStarted(): Promise<void> {
    if (this.process && this.initialized) {
      return;
    }

    this.stopping = false;
    const child = spawn(resolveCodexBinary(), ["app-server", "--listen", "stdio://", "--session-source", "telecodex"], {
      env: process.env as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    this.lineReader = readline.createInterface({ input: child.stdout });
    this.lineReader.on("line", (line) => this.handleLine(line));
    child.on("error", (error) => this.handleProcessError(error));
    child.on("exit", (code, signal) => {
      if (!this.stopping) {
        this.handleProcessError(new Error(`Codex app-server 退出（code=${code ?? "null"}, signal=${signal ?? "null"}）。`));
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) console.warn("Codex app-server:", text);
    });

    await this.request("initialize", {
      clientInfo: { name: "telecodex", title: "TeleCodex", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.sendNotification("initialized");
    this.initialized = true;
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  private write(message: unknown): void {
    if (!this.process?.stdin.writable) {
      throw new Error("Codex app-server stdin 不可写。 ");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message ?? "Codex app-server 请求失败。"));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message as ServerRequest);
      return;
    }

    if (message.method) {
      this.handleNotification(message.method, message.params);
    }
  }

  private async handleServerRequest(message: ServerRequest): Promise<void> {
    const waiter = this.turnWaiters.get(this.activeTurnId ?? "") ?? this.turnWaiters.get("__pending__");
    const callbacks = waiter?.callbacks;
    try {
      let result: unknown;
      if (message.method === "item/tool/requestUserInput" && callbacks?.onUserInputRequest) {
        result = await callbacks.onUserInputRequest(message.params as AppServerUserInputRequest);
      } else if (message.method === "item/commandExecution/requestApproval" && callbacks?.onApprovalRequest) {
        result = await callbacks.onApprovalRequest({ kind: "command", ...message.params });
      } else if (message.method === "item/fileChange/requestApproval" && callbacks?.onApprovalRequest) {
        result = await callbacks.onApprovalRequest({ kind: "file", ...message.params });
      } else if (message.method === "item/permissions/requestApproval" && callbacks?.onApprovalRequest) {
        result = await callbacks.onApprovalRequest({ kind: "permissions", ...message.params });
      } else {
        this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported Codex app-server request" } });
        return;
      }
      this.write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private handleNotification(method: string, params: any): void {
    const reportedTurnId = params?.turnId ?? params?.turn?.id;
    const turnId = reportedTurnId ?? this.activeTurnId ?? "";
    const waiter = reportedTurnId
      ? this.turnWaiters.get(reportedTurnId) ?? (this.activeTurnId === null ? this.turnWaiters.get("__pending__") : undefined)
      : this.turnWaiters.get(this.activeTurnId ?? "") ?? this.turnWaiters.get("__pending__");
    const callbacks = waiter?.callbacks;
    if (!callbacks) {
      if (reportedTurnId) {
        const events = this.pendingTurnEvents.get(reportedTurnId) ?? [];
        events.push({ method, params });
        this.pendingTurnEvents.set(reportedTurnId, events);
      }
      return;
    }

    switch (method) {
      case "turn/plan/updated":
        callbacks.onPlanUpdate?.(params as AppServerPlanUpdate);
        break;
      case "item/agentMessage/delta":
        if (params.itemId && params.delta) {
          const current = this.agentMessageDeltas.get(params.itemId) ?? "";
          this.agentMessageDeltas.set(params.itemId, `${current}${params.delta}`);
        }
        break;
      case "item/commandExecution/outputDelta":
      case "command/exec/outputDelta":
        callbacks.onToolUpdate(params.itemId, params.delta);
        break;
      case "turn/tokenUsage/updated":
      case "thread/tokenUsage/updated": {
        const usage = params?.tokenUsage?.last ?? params?.usage;
        if (usage) {
          callbacks.onTurnComplete?.({
            inputTokens: usage.inputTokens ?? usage.input_tokens ?? 0,
            cachedInputTokens: usage.cachedInputTokens ?? usage.cached_input_tokens ?? 0,
            outputTokens: usage.outputTokens ?? usage.output_tokens ?? 0,
          });
        }
        break;
      }
      case "item/started":
        this.handleItemStarted(params.item, callbacks);
        break;
      case "item/completed":
        this.handleItemCompleted(params.item, callbacks);
        break;
      case "turn/completed":
        if (params?.turn?.status === "inProgress") {
          // The app-server can emit this notification while Codex is
          // reconnecting. It is not a terminal event and must not release the
          // turn waiter or trigger the Telegram completion message.
          return;
        }
        if (params?.turn?.status === "failed") {
          this.rejectTurn(params.turn.error?.message ?? "Codex app-server 执行失败。", params.turn.id ?? turnId);
          return;
        }
        if (params?.turn?.status === "interrupted") {
          this.rejectTurn("Codex app-server turn 已中断。", params.turn.id ?? turnId);
          return;
        }
        if (params?.turn?.status !== "completed") {
          // Unknown statuses are treated as non-terminal for forward
          // compatibility. Continue waiting for the actual terminal event.
          return;
        }
        for (const [itemId, text] of this.agentMessageDeltas.entries()) {
          if (text.trim()) callbacks.onAgentMessage(text.trim());
          this.agentMessageDeltas.delete(itemId);
        }
        callbacks.onAgentEnd();
        this.resolveTurn(params.turn?.id ?? params.turnId ?? this.activeTurnId ?? "");
        break;
      case "error":
        this.rejectTurn(params?.message ?? "Codex app-server 发生错误。", params?.turnId);
        break;
      default:
        break;
    }
  }

  private handleItemStarted(item: any, callbacks: AppServerCallbacks): void {
    if (!item?.id) return;
    switch (item.type) {
      case "commandExecution":
        callbacks.onToolStart(item.command, item.id);
        break;
      case "webSearch":
        callbacks.onToolStart(`🔍 ${item.query ?? "web search"}`, item.id);
        break;
      case "fileChange":
        callbacks.onToolStart("file_change", item.id);
        break;
      case "mcpToolCall":
        callbacks.onToolStart(`mcp:${item.server}/${item.tool}`, item.id);
        break;
    }
  }

  private handleItemCompleted(item: any, callbacks: AppServerCallbacks): void {
    if (!item?.id) return;
    switch (item.type) {
      case "agentMessage":
        {
          const delta = this.agentMessageDeltas.get(item.id) ?? "";
          const text = item.text?.trim() || delta.trim();
          this.agentMessageDeltas.delete(item.id);
          if (text) callbacks.onAgentMessage(text);
        }
        break;
      case "commandExecution":
        if (item.aggregatedOutput) callbacks.onToolUpdate(item.id, item.aggregatedOutput);
        callbacks.onToolEnd(item.id, item.status === "failed" || item.status === "declined");
        break;
      case "fileChange":
        callbacks.onToolUpdate(item.id, (item.changes ?? []).map((change: any) => `${change.kind} ${change.path}`).join(", "));
        callbacks.onToolEnd(item.id, item.status === "failed" || item.status === "declined");
        break;
      case "mcpToolCall":
        if (item.error?.message) callbacks.onToolUpdate(item.id, item.error.message);
        callbacks.onToolEnd(item.id, item.status === "failed");
        break;
      case "webSearch":
        callbacks.onToolEnd(item.id, false);
        break;
    }
  }

  private resolveTurn(turnId: string): void {
    const key = this.turnWaiters.has(turnId) ? turnId : "__pending__";
    const waiter = this.turnWaiters.get(key);
    if (!waiter) return;
    this.turnWaiters.delete(key);
    waiter.resolve();
  }

  private rejectTurn(message: string, turnId?: string): void {
    const key = turnId ?? this.activeTurnId ?? "";
    const waiterKey = this.turnWaiters.has(key) ? key : "__pending__";
    const waiter = this.turnWaiters.get(waiterKey);
    if (!waiter) return;
    this.turnWaiters.delete(waiterKey);
    waiter.reject(new Error(message));
  }

  private handleProcessError(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) waiter.reject(error);
    this.turnWaiters.clear();
    this.dispose();
  }

  private rememberThread(result: any): AppServerThread {
    const thread = result?.thread ?? result;
    this.activeThreadId = thread?.id ?? result?.threadId;
    this.threadModel = result?.model ?? this.threadModel;
    if (!this.activeThreadId) throw new Error("Codex app-server 未返回 thread id。");
    return { id: this.activeThreadId, model: this.threadModel ?? "" };
  }
}

function readTurnId(result: any): string {
  const turnId = result?.turn?.id ?? result?.turnId ?? result?.id;
  if (typeof turnId !== "string" || !turnId) throw new Error("Codex app-server 未返回 turn id。");
  return turnId;
}

function resolveCodexBinary(): string {
  const override = process.env.CODEX_PATH?.trim();
  if (override) return override;

  const require = createRequire(import.meta.url);
  const packageByTarget: Record<string, string> = {
    "win32-x64": "@openai/codex-win32-x64",
    "win32-arm64": "@openai/codex-win32-arm64",
    "darwin-x64": "@openai/codex-darwin-x64",
    "darwin-arm64": "@openai/codex-darwin-arm64",
    "linux-x64": "@openai/codex-linux-x64",
    "linux-arm64": "@openai/codex-linux-arm64",
  };
  const packageName = packageByTarget[`${process.platform}-${process.arch}`];
  if (packageName) {
    try {
      const packageJson = require.resolve(`${packageName}/package.json`);
      const triple = process.platform === "win32" ? "x86_64-pc-windows-msvc" : undefined;
      if (triple) {
        return path.join(path.dirname(packageJson), "vendor", triple, "codex", "codex.exe");
      }
    } catch {
      // Fall back to PATH below.
    }
  }
  return process.platform === "win32" ? "codex.exe" : "codex";
}
