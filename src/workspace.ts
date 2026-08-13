import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Accept both native absolute paths and Windows drive-letter paths. The latter
 * is intentionally recognized even when validation runs on a non-Windows host
 * so that Telegram input can be checked consistently.
 */
export function normalizeWorkspacePath(rawPath: string): string {
  const value = rawPath.trim();
  if (!value) {
    throw new Error("工作区路径不能为空。");
  }

  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(value);
  const isRootAbsolute = value.startsWith("/") || value.startsWith("\\");
  if (!isWindowsAbsolute && !isRootAbsolute && !path.isAbsolute(value)) {
    throw new Error("工作区路径必须是绝对路径，例如 C:\\Projects\\demo 或 /workspace/demo。 ");
  }

  return path.normalize(value);
}

export async function ensureWorkspaceDirectory(rawPath: string): Promise<string> {
  const workspace = normalizeWorkspacePath(rawPath);
  try {
    const existing = await stat(workspace);
    if (!existing.isDirectory()) {
      throw new Error(`工作区路径不是文件夹：${workspace}`);
    }
    return workspace;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("工作区路径不是文件夹：")) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(workspace, { recursive: true });
  const details = await stat(workspace);
  if (!details.isDirectory()) {
    throw new Error(`工作区路径不是文件夹：${workspace}`);
  }
  return workspace;
}
