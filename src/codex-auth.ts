import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface AuthStatus {
  authenticated: boolean;
  method: "api-key" | "cli" | "config" | "none";
  detail: string;
}

export interface LoginResult {
  success: boolean;
  message: string;
}

const CODEX_CLI = "codex";
const COMMAND_TIMEOUT_MS = 10_000;
const AUTH_CACHE_TTL_MS = 30_000;

let cachedAuthStatus: { status: AuthStatus; expiresAt: number } | undefined;

/**
 * Check whether Codex is currently authenticated.
 *
 * Priority:
 * 1. If CODEX_API_KEY is set in the environment, report authenticated via API key.
 * 2. Otherwise, detect a configured custom provider in ~/.codex/config.toml.
 * 3. Otherwise, shell out to `codex login status` to check CLI auth.
 * 4. Otherwise, report unauthenticated.
 *
 * Results are cached for 30 seconds to avoid per-message CLI invocations.
 */
export async function checkAuthStatus(apiKey?: string): Promise<AuthStatus> {
  if (apiKey) {
    return {
      authenticated: true,
      method: "api-key",
      detail: "已通过 CODEX_API_KEY 认证",
    };
  }

  if (cachedAuthStatus && Date.now() < cachedAuthStatus.expiresAt) {
    return cachedAuthStatus.status;
  }

  const customProvider = getConfiguredCustomProvider();
  if (customProvider) {
    const status: AuthStatus = {
      authenticated: true,
      method: "config",
      detail: `已在 ~/.codex/config.toml 中配置自定义服务商“${customProvider}”。`,
    };
    cachedAuthStatus = { status, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
    return status;
  }

  try {
    const { stdout } = await runCodexCommand(["login", "status"]);
    const output = stdout.trim();
    const status: AuthStatus = {
      authenticated: true,
      method: "cli",
      detail: output || "已通过 Codex CLI 认证",
    };
    cachedAuthStatus = { status, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
    return status;
  } catch (error) {
    const status = parseCommandError(error);
    cachedAuthStatus = { status, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
    return status;
  }
}

/**
 * Detects the active custom provider without inspecting any credential values.
 * Codex CLI login state does not apply to providers that authenticate in config.toml.
 */
function getConfiguredCustomProvider(): string | undefined {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
  const configPath = path.join(codexHome, "config.toml");
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    const contents = readFileSync(configPath, "utf8");
    const providerMatch = contents.match(/^\s*model_provider\s*=\s*["']([^"']+)["']\s*$/m);
    if (!providerMatch?.[1]) {
      return undefined;
    }

    const providerId = providerMatch[1];
    const escapedProviderId = escapeRegExp(providerId);
    const providerSection = new RegExp(`^\\s*\\[model_providers\\.${escapedProviderId}\\]\\s*$`, "m");
    return providerSection.test(contents) ? providerId : undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Clear the cached auth status so the next check hits the CLI.
 */
export function clearAuthCache(): void {
  cachedAuthStatus = undefined;
}

/**
 * Attempt to start a login flow via the Codex CLI.
 * Uses --device-auth to get a device code flow suitable for headless/remote hosts.
 */
export async function startLogin(): Promise<LoginResult> {
  clearAuthCache();

  try {
    const { stdout } = await runCodexCommand(["login", "--device-auth"]);
    const output = stdout.trim();
    return {
      success: true,
      message: output || "已开始登录。请在终端或浏览器中完成下一步。",
    };
  } catch (error) {
    const detail = extractErrorMessage(error);
    return {
      success: false,
      message: detail || "登录命令失败。请尝试在主机上运行“codex auth login”。",
    };
  }
}

/**
 * Attempt to logout via the Codex CLI.
 */
export async function startLogout(): Promise<LoginResult> {
  clearAuthCache();

  try {
    const { stdout } = await runCodexCommand(["logout"]);
    const output = stdout.trim();
    return {
      success: true,
      message: output || "已成功退出登录。",
    };
  } catch (error) {
    const detail = extractErrorMessage(error);
    return {
      success: false,
      message: detail || "退出登录命令失败。请尝试在主机上运行“codex auth logout”。",
    };
  }
}

function runCodexCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      CODEX_CLI,
      args,
      {
        timeout: COMMAND_TIMEOUT_MS,
        env: { ...process.env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          // Attach stdout/stderr to the error for richer diagnostics
          const enriched = error as Error & { stdout?: string; stderr?: string };
          enriched.stdout = typeof stdout === "string" ? stdout : "";
          enriched.stderr = typeof stderr === "string" ? stderr : "";
          reject(enriched);
          return;
        }
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

function parseCommandError(error: unknown): AuthStatus {
  const errno = (error as NodeJS.ErrnoException)?.code;
  if (errno === "ENOENT") {
    return {
      authenticated: false,
      method: "none",
      detail: "未找到 Codex CLI。请安装它，或设置 CODEX_API_KEY。",
    };
  }

  const detail = extractErrorMessage(error) || "未认证";
  return {
    authenticated: false,
    method: "none",
    detail,
  };
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const enriched = error as { stderr?: string; stdout?: string; message?: string; signal?: string };
    const stderr = enriched.stderr?.trim();
    if (stderr) {
      return stderr;
    }
    const stdout = enriched.stdout?.trim();
    if (stdout) {
      return stdout;
    }
    if (enriched.signal) {
      return `Command terminated with signal ${enriched.signal}.`;
    }
    if (enriched.message) {
      return enriched.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
