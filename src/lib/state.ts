import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from './logger.js';

/**
 * Persistent JSON state under data/state/ (gitignored via data/).
 * Used for the 4h macro-regime cache and per-ticker cooldown timers.
 * Mirrors the file-write pattern in lib/cache.ts.
 */
const STATE_DIR = join(process.cwd(), 'data', 'state');

export function statePath(file: string): string {
  return join(STATE_DIR, file);
}

export async function readState<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(statePath(file), 'utf8')) as T;
  } catch {
    return null; // missing or unreadable → treat as no state
  }
}

export async function writeState(file: string, value: unknown): Promise<void> {
  const p = statePath(file);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(value, null, 2), 'utf8');
  logger.debug({ file }, 'state written');
}

/** True if the given ISO-8601 timestamp is still in the future (not expired). */
export function isFresh(validUntilIso: string, now: number = Date.now()): boolean {
  const t = new Date(validUntilIso).getTime();
  return Number.isFinite(t) && t > now;
}
