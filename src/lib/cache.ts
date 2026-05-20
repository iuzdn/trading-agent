import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from './logger.js';

const CACHE_DIR = join(process.cwd(), 'data', 'cache');

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

function keyHash(tool: string, args: unknown): string {
  const norm = JSON.stringify(args, Object.keys(args as object).sort());
  return createHash('sha1').update(`${tool}:${norm}`).digest('hex').slice(0, 16);
}

function pathFor(tool: string, hash: string): string {
  return join(CACHE_DIR, tool, `${hash}.json`);
}

export async function withCache<T>(
  tool: string,
  args: unknown,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  if (ttlMs <= 0) return fetcher();

  const hash = keyHash(tool, args);
  const file = pathFor(tool, hash);

  try {
    const raw = await readFile(file, 'utf8');
    const entry = JSON.parse(raw) as CacheEntry<T>;
    if (entry.expiresAt > Date.now()) {
      logger.debug({ tool, hash }, 'cache hit');
      return entry.value;
    }
  } catch {
    // miss or stale → fall through to fetcher
  }

  const value = await fetcher();
  await mkdir(dirname(file), { recursive: true });
  const entry: CacheEntry<T> = { value, expiresAt: Date.now() + ttlMs };
  await writeFile(file, JSON.stringify(entry));
  logger.debug({ tool, hash, ttlMs }, 'cache write');
  return value;
}

export const TTL = {
  MINUTE: 60_000,
  FIFTEEN_MIN: 15 * 60_000,
  HOUR: 60 * 60_000,
  SIX_HOUR: 6 * 60 * 60_000,
  DAY: 24 * 60 * 60_000,
} as const;
