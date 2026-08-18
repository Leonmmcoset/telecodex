import { AsyncLocalStorage } from "node:async_hooks";

export type LogFields = Record<string, boolean | number | string | null | undefined>;

const logContext = new AsyncLocalStorage<LogFields>();
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};
const ANSI_ENABLED = !process.env.NO_COLOR;

/**
 * Emits readable runtime logs without serializing message bodies,
 * authorization values, or other user-provided secrets.
 */
export function logInfo(event: string, fields: LogFields = {}): void {
  writeLog("info", event, fields);
}

export function logWarn(event: string, fields: LogFields = {}): void {
  writeLog("warn", event, fields);
}

export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  writeLog("error", event, {
    ...fields,
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Runs an asynchronous operation with fields automatically attached to its logs. */
export function withLogContext<T>(fields: LogFields, callback: () => T): T {
  return logContext.run(fields, callback);
}

function writeLog(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  const mergedFields = { ...(logContext.getStore() ?? {}), ...fields };
  const details = Object.entries(mergedFields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${color(ANSI.cyan, key)}=${formatLogValue(value!)}`)
    .join(" · ");
  const timestamp = new Date().toISOString().replace("T", " ");
  const line = [
    `[${color(ANSI.gray, timestamp)}]`,
    `[${color(levelColor(level), level.toUpperCase())}]`,
    color(ANSI.magenta, event),
    details ? `${color(ANSI.dim, "|")} ${details}` : "",
  ].filter(Boolean).join(" ");
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function formatLogValue(value: Exclude<LogFields[string], undefined>): string {
  if (typeof value !== "string") return color(ANSI.green, String(value));
  const normalized = value.replace(/[\r\n\t]+/g, " ");
  return color(ANSI.green, /[\s·|=]/.test(normalized) ? JSON.stringify(normalized) : normalized);
}

function levelColor(level: "info" | "warn" | "error"): string {
  if (level === "warn") return ANSI.yellow;
  if (level === "error") return ANSI.red;
  return ANSI.green;
}

function color(code: string, value: string): string {
  return ANSI_ENABLED ? `${code}${value}${ANSI.reset}` : value;
}
