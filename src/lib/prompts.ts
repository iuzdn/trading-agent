import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(here, '..', 'config', 'prompts');

const cache = new Map<string, string>();

export async function loadPrompt(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;
  const file = join(PROMPTS_DIR, `${name}.md`);
  const text = await readFile(file, 'utf8');
  cache.set(name, text);
  return text;
}
