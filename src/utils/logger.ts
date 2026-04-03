export const enum LogLevel {
  None = 0,
  Error = 1,
  Warn = 2,
  Info = 3,
  Debug = 4,
}

let currentLevel = LogLevel.Warn;
let subscriber: ((level: string, msg: string) => void) | null = null;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setLogSubscriber(fn: ((level: string, msg: string) => void) | null): void {
  subscriber = fn;
}

export function logError(msg: string, ...args: unknown[]): void {
  if (currentLevel >= LogLevel.Error) console.error(`[GBA] ${msg}`, ...args);
  subscriber?.('error', msg);
}

export function logWarn(msg: string, ...args: unknown[]): void {
  if (currentLevel >= LogLevel.Warn) console.warn(`[GBA] ${msg}`, ...args);
  subscriber?.('warn', msg);
}

export function logInfo(msg: string, ...args: unknown[]): void {
  if (currentLevel >= LogLevel.Info) console.info(`[GBA] ${msg}`, ...args);
  subscriber?.('info', msg);
}

export function logDebug(msg: string, ...args: unknown[]): void {
  if (currentLevel >= LogLevel.Debug) console.log(`[GBA] ${msg}`, ...args);
  subscriber?.('debug', msg);
}
