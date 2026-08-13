import { run, type RunnerHandle } from "@grammyjs/runner";
import { createBot, registerCommands } from "./bot.js";
import { checkAuthStatus } from "./codex-auth.js";
import { findLaunchProfile, formatLaunchProfileBehavior } from "./codex-launch.js";
import { loadConfig } from "./config.js";
import { SessionRegistry } from "./session-registry.js";

let registry: SessionRegistry | undefined;
let bot: ReturnType<typeof createBot> | undefined;
let runner: RunnerHandle | undefined;

console.log("正在启动 TeleCodex……");

try {
  const config = loadConfig();
  registry = new SessionRegistry(config);
  bot = createBot(config, registry);

  console.log("正在注册 Telegram 命令……");
  try {
    await registerCommands(bot);
    console.log("Telegram 命令已注册。");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`警告：注册 Telegram 命令失败：${message}`);
  }

  console.log("正在检查 Codex 认证状态……");
  const authStatus = await checkAuthStatus(config.codexApiKey);
  console.log(`认证状态：${authStatus.authenticated ? "已认证" : "未认证"}（${authStatus.method}）`);
  if (!authStatus.authenticated) {
    console.warn("警告：Codex 尚未认证。请使用 /login，或设置 CODEX_API_KEY。");
  }
  console.log(`工作区：${config.workspace}`);
  if (config.codexModel) {
    console.log(`默认模型：${config.codexModel}`);
  }
  const defaultLaunchProfile = findLaunchProfile(config.launchProfiles, config.defaultLaunchProfileId);
  if (defaultLaunchProfile) {
    console.log(
      `默认启动配置：${defaultLaunchProfile.label}（${formatLaunchProfileBehavior(defaultLaunchProfile)}）`,
    );
    if (defaultLaunchProfile.unsafe) {
      console.warn("警告：默认启动配置使用 danger-full-access。");
    }
  }
  console.log("会话模式：每个 Telegram 上下文独立会话");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`启动 TeleCodex 失败：${message}`);
  registry?.disposeAll();
  process.exit(1);
}

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`收到 ${signal}，正在关闭 TeleCodex……`);
  void runner?.stop();

  setTimeout(() => {
    registry?.disposeAll();
    console.log("TeleCodex 已停止。");
    process.exit(0);
  }, 500);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 3000;
let restartAttempts = 0;

async function startPolling(): Promise<void> {
  try {
    console.log("Starting Telegram polling...");
    await bot!.api.deleteWebhook({ drop_pending_updates: true });
    const botInfo = await bot!.api.getMe();
    runner = run(bot!, {
      runner: { retryInterval: 3000 },
      sink: { concurrency: 32 },
    });
    restartAttempts = 0;
    console.log(`TeleCodex is running as @${botInfo.username}.`);
    await runner.task();
  } catch (error) {
    if (shuttingDown) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const is409 = message.includes("409") || message.includes("Conflict");

    if (is409 && restartAttempts < MAX_RESTART_ATTEMPTS) {
      await runner?.stop();
      runner = undefined;
      restartAttempts += 1;
      console.warn(`Polling error (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}): ${message}`);
      console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      return startPolling();
    }

    console.error(`Fatal polling error: ${message}`);
    registry?.disposeAll();
    process.exit(1);
  }
}

await startPolling();
