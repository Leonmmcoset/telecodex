import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const mockState = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockState.spawn,
}));

import {
  CodexAppServerClient,
  type AppServerCallbacks,
} from "../src/codex-app-server.js";

type FakeProcess = {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: { writable: boolean; write: (chunk: string) => boolean };
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
} & EventEmitter;

const writeJson = (process: FakeProcess, value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const createCallbacks = (): AppServerCallbacks => ({
  onAgentMessage: vi.fn(),
  onToolStart: vi.fn(),
  onToolUpdate: vi.fn(),
  onToolEnd: vi.fn(),
  onPlanUpdate: vi.fn(),
  onTurnStatus: vi.fn(),
  onAgentEnd: vi.fn(),
});

describe("CodexAppServerClient", () => {
  let fakeProcess: FakeProcess;
  let requests: any[];

  beforeEach(() => {
    requests = [];
    fakeProcess = new EventEmitter() as FakeProcess;
    fakeProcess.stdout = new PassThrough();
    fakeProcess.stderr = new PassThrough();
    fakeProcess.killed = false;
    fakeProcess.kill = vi.fn(() => {
      fakeProcess.killed = true;
      return true;
    });

    let buffer = "";
    fakeProcess.stdin = {
      writable: true,
      write: vi.fn((chunk: string) => {
        buffer += String(chunk);
        while (buffer.includes("\n")) {
          const newlineIndex = buffer.indexOf("\n");
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.trim()) continue;

          const request = JSON.parse(line);
          requests.push(request);
          if (request.method === "initialize") {
            writeJson(fakeProcess, { jsonrpc: "2.0", id: request.id, result: {} });
          } else if (request.method === "thread/start") {
            writeJson(fakeProcess, {
              jsonrpc: "2.0",
              id: request.id,
              result: { thread: { id: "thread-1" }, model: request.params.model },
            });
          } else if (request.method === "turn/start") {
            const turnId = requests.filter((item) => item.method === "turn/start").length === 1
              ? "plan-turn"
              : "default-turn";
            writeJson(fakeProcess, {
              jsonrpc: "2.0",
              id: request.id,
              result: { turn: { id: turnId } },
            });
          }
        }
        return true;
      }),
    };
    mockState.spawn.mockReturnValue(fakeProcess);
  });

  afterEach(() => {
    mockState.spawn.mockReset();
  });

  it("uses plan collaboration mode only for Plan turns", async () => {
    const client = new CodexAppServerClient();
    const callbacks = createCallbacks();
    await client.startThread({
      workspace: "/workspace/test",
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    });

    const planPromise = client.runPlan(
      [{ type: "text", text: "先制定计划", text_elements: [] }],
      callbacks,
      "gpt-5.4",
      "high",
    );
    await vi.waitFor(() => expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(1));
    const planRequest = requests.find((request) => request.method === "turn/start");
    expect(planRequest.params.collaborationMode).toEqual({
      mode: "plan",
      settings: {
        model: "gpt-5.4",
        reasoning_effort: "high",
        developer_instructions: "只分析和制定计划，不执行文件修改或命令。输出清晰的编号计划，并在计划完成前发送结构化计划更新。等待用户确认后再执行。",
      },
    });
    writeJson(fakeProcess, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { id: "plan-turn", status: "completed" } },
    });
    await planPromise;

    const defaultPromise = client.runDefault(
      [{ type: "text", text: "执行已确认计划", text_elements: [] }],
      callbacks,
      "gpt-5.4",
      "high",
    );
    await vi.waitFor(() => expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(2));
    const defaultRequest = requests.filter((request) => request.method === "turn/start")[1];
    expect(defaultRequest.params).not.toHaveProperty("collaborationMode");
    writeJson(fakeProcess, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { id: "default-turn", status: "completed" } },
    });
    await defaultPromise;
    expect(callbacks.onAgentEnd).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("clears the active turn when a turn fails", async () => {
    const client = new CodexAppServerClient();
    const callbacks = createCallbacks();
    await client.startThread({
      workspace: "/workspace/test",
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    });

    const turnPromise = client.runDefault(
      [{ type: "text", text: "执行", text_elements: [] }],
      callbacks,
    );
    await vi.waitFor(() => expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(1));
    writeJson(fakeProcess, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { id: "plan-turn", status: "failed", error: { message: "执行失败" } } },
    });
    await expect(turnPromise).rejects.toThrow("执行失败");
    expect(client.isTurnActive()).toBe(false);
    client.dispose();
  });

  it("forwards structured plan updates before completing a Plan turn", async () => {
    const client = new CodexAppServerClient();
    const callbacks = createCallbacks();
    await client.startThread({
      workspace: "/workspace/test",
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    });

    const turnPromise = client.runPlan(
      [{ type: "text", text: "先制定计划", text_elements: [] }],
      callbacks,
    );
    await vi.waitFor(() => expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(1));

    writeJson(fakeProcess, {
      jsonrpc: "2.0",
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "plan-turn",
        explanation: "先确认范围。",
        plan: [{ step: "检查现有实现", status: "pending" }],
      },
    });
    await vi.waitFor(() => expect(callbacks.onPlanUpdate).toHaveBeenCalledWith({
      threadId: "thread-1",
      turnId: "plan-turn",
      explanation: "先确认范围。",
      plan: [{ step: "检查现有实现", status: "pending" }],
    }));

    writeJson(fakeProcess, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { id: "plan-turn", status: "completed" } },
    });
    await turnPromise;
    client.dispose();
  });

  it("does not finish a turn while Codex reports inProgress during reconnecting", async () => {
    const client = new CodexAppServerClient();
    const callbacks = createCallbacks();
    await client.startThread({
      workspace: "/workspace/test",
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    });

    const turnPromise = client.runDefault(
      [{ type: "text", text: "continue", text_elements: [] }],
      callbacks,
    );
    await vi.waitFor(() => expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(1));

    writeJson(fakeProcess, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { id: "plan-turn", status: "inProgress" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.isTurnActive()).toBe(true);
    expect(callbacks.onAgentEnd).not.toHaveBeenCalled();
    expect(callbacks.onTurnStatus).toHaveBeenCalledWith("reconnecting");

    writeJson(fakeProcess, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { id: "plan-turn", status: "completed" } },
    });
    await turnPromise;
    expect(callbacks.onAgentEnd).toHaveBeenCalledTimes(1);
    expect(callbacks.onTurnStatus).toHaveBeenLastCalledWith("completed");
    expect(client.isTurnActive()).toBe(false);
    client.dispose();
  });

  it("rejects a pending turn when disposed", async () => {
    const client = new CodexAppServerClient();
    const callbacks = createCallbacks();
    await client.startThread({
      workspace: "/workspace/test",
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    });

    const turnPromise = client.runDefault(
      [{ type: "text", text: "等待", text_elements: [] }],
      callbacks,
    );
    await vi.waitFor(() => expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(1));
    client.dispose();
    await expect(turnPromise).rejects.toThrow("Codex app-server 已关闭。");
  });
});
