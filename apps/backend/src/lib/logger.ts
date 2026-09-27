import { env } from '../config/env.js';

// Minimal structured logger: one JSON object per line on stdout/stderr.

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[env.NODE_ENV === 'test' ? 'warn' : 'info'];

// Defensive: callers must never pass secrets, but mask them if one slips through.
const SECRET_KEY = /password|secret|token|authorization|encryption_?key|api_?key/i;

function sanitize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) out[key] = '[REDACTED]';
    else if (value instanceof Error) out[key] = { name: value.name, message: value.message };
    else out[key] = value;
  }
  return out;
}

function write(level: Level, msg: string, fields: Fields = {}) {
  if (LEVELS[level] < minLevel) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...sanitize(fields) });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(bindings: Fields): Logger;
}

function createLogger(bindings: Fields = {}): Logger {
  return {
    debug: (msg, fields) => write('debug', msg, { ...bindings, ...fields }),
    info: (msg, fields) => write('info', msg, { ...bindings, ...fields }),
    warn: (msg, fields) => write('warn', msg, { ...bindings, ...fields }),
    error: (msg, fields) => write('error', msg, { ...bindings, ...fields }),
    child: (more) => createLogger({ ...bindings, ...more }),
  };
}

export const logger = createLogger();
