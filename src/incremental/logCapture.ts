import { logger } from '../utils/FSHLogger';

const LEVEL = Symbol.for('level');

/**
 * Copies a log entry as plain data, so it can be stored and written again later with the same
 * result. Returns null if the entry is not plain data.
 */
export function copyLogInfo(info: any): any {
  if (info == null || typeof info.message !== 'string' || typeof info.level !== 'string') {
    return null;
  }
  const copy: any = {};
  for (const key of Object.keys(info)) {
    if (info[key] !== undefined) {
      copy[key] = info[key];
    }
  }
  try {
    return JSON.parse(JSON.stringify(copy));
  } catch {
    return null;
  }
}

/** Writes a copied log entry again, through the logger's formats (counting, ignoring, printing). */
export function emitLogInfo(copy: any): void {
  logger.write({ ...copy, [LEVEL]: copy.level });
}

/**
 * Runs fn and returns copies of the log entries it wrote, or null for logs if any entry could not
 * be copied. With mute, the entries are not written at all. Entries written while the importer
 * collects messages from a generated document (when the logger level is raised to "emerg") are not
 * printed or kept, so they are neither copied nor muted.
 */
export function captureLogs<T>(fn: () => T, mute: boolean): { result: T; logs: any[] | null } {
  const ownWrite = Object.getOwnPropertyDescriptor(logger, 'write');
  const write = logger.write;
  let logs: any[] = [];
  Object.defineProperty(logger, 'write', {
    value: function (info: any, ...rest: any[]) {
      if (logger.level === 'emerg') {
        return write.call(logger, info, ...rest);
      }
      if (logs != null) {
        const copy = copyLogInfo(info);
        if (copy == null) {
          logs = null;
        } else {
          logs.push(copy);
        }
      }
      return mute ? true : write.call(logger, info, ...rest);
    },
    configurable: true,
    writable: true
  });
  try {
    return { result: fn(), logs };
  } finally {
    if (ownWrite != null) {
      Object.defineProperty(logger, 'write', ownWrite);
    } else {
      delete (logger as any).write;
    }
  }
}
