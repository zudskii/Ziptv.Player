/** Structured logger port (pino satisfies it). Application code never imports pino directly. */
export interface LogFn {
  (message: string): void;
  (context: object, message?: string): void;
}

export interface Logger {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child(bindings: Record<string, unknown>): Logger;
}
