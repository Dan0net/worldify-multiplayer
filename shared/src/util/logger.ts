/**
 * Simple logger utility with log levels.
 * Set LOG_LEVEL env var or use logger.setLevel() to control verbosity.
 * 
 * Levels: 'debug' | 'info' | 'warn' | 'error' | 'none'
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

// Default to 'info' in production, 'debug' in development
let currentLevel: LogLevel = 
  (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') ? 'info' : 'debug';

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function formatPrefix(tag: string): string {
  return tag ? `[${tag}]` : '';
}

/**
 * Create a tagged logger instance.
 * @param tag Optional prefix tag (e.g., 'net', 'room', 'voxel')
 */
export function createLogger(tag: string = '') {
  const prefix = formatPrefix(tag);
  
  return {
    debug: (...args: unknown[]) => {
      if (shouldLog('debug')) {
        // eslint-disable-next-line no-console
        console.log(prefix, ...args);
      }
    },
    
    info: (...args: unknown[]) => {
      if (shouldLog('info')) {
        // eslint-disable-next-line no-console
        console.log(prefix, ...args);
      }
    },
    
    warn: (...args: unknown[]) => {
      if (shouldLog('warn')) {
        // eslint-disable-next-line no-console
        console.warn(prefix, ...args);
      }
    },
    
    error: (...args: unknown[]) => {
      if (shouldLog('error')) {
        // eslint-disable-next-line no-console
        console.error(prefix, ...args);
      }
    },
  };
}

/**
 * Set the global log level.
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Get the current log level.
 */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

// Default logger (no tag)
export const logger = createLogger();
