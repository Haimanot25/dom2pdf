/**
 * Minimal structured logger.
 *
 * The library never writes conversion artifacts or credentials to logs;
 * `sanitizeUrl` (utils/url.ts) must be applied to any URL before logging.
 * Callers can plug in their own sink (the CLI writes to stderr).
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LogRecord {
  level: Exclude<LogLevel, "silent">;
  /** Hierarchical scope, e.g. `convert:browser`. */
  scope: string;
  message: string;
  context: Record<string, unknown> | undefined;
  /** ISO timestamp. */
  time: string;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  /** Returns a logger that prefixes its scope with `scope`. */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  /** Minimum level to emit. Defaults to `warn`. */
  level?: LogLevel;
  /** Where records go. Defaults to the console (warn/error only at default level). */
  sink?: (record: LogRecord) => void;
}

const LEVEL_ORDER: Record<Exclude<LogLevel, "silent">, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// The default sink is the only place in the core library permitted to touch stdio.
/* eslint-disable no-console */
function defaultSink(record: LogRecord): void {
  const line = `[pageforge] ${record.scope}: ${record.message}`;
  const context = record.context !== undefined && Object.keys(record.context).length > 0
    ? record.context
    : undefined;
  switch (record.level) {
    case "debug":
    case "info":
      console.log(line, context ?? "");
      break;
    case "warn":
      console.warn(line, context ?? "");
      break;
    case "error":
      console.error(line, context ?? "");
      break;
  }
}
/* eslint-enable no-console */

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "warn";
  const sink = options.sink ?? defaultSink;

  const build = (scope: string): Logger => {
    const emit = (recordLevel: Exclude<LogLevel, "silent">, message: string, context?: Record<string, unknown>): void => {
      if (level === "silent" || LEVEL_ORDER[recordLevel] < LEVEL_ORDER[level as Exclude<LogLevel, "silent">]) {
        return;
      }
      sink({
        level: recordLevel,
        scope,
        message,
        context,
        time: new Date().toISOString(),
      });
    };

    return {
      debug: (message, context) => emit("debug", message, context),
      info: (message, context) => emit("info", message, context),
      warn: (message, context) => emit("warn", message, context),
      error: (message, context) => emit("error", message, context),
      child: (childScope) => build(scope.length > 0 ? `${scope}:${childScope}` : childScope),
    };
  };

  return build("");
}

/** A logger that drops everything; convenient default for tests. */
export function createSilentLogger(): Logger {
  return createLogger({ level: "silent" });
}
