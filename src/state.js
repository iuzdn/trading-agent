// Persistent state for the agent — high-water marks per held symbol,
// used by the trailing-stop monitor. Stored as a JSON file at the project
// root so a process restart doesn't lose mid-trade context.

import fs from 'fs';
import path from 'path';

const STATE_PATH = process.env.AGENT_STATE_PATH || path.resolve('./state.json');

export function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { highWaterMarks: {}, ...parsed };
  } catch {
    return { highWaterMarks: {} };
  }
}

export function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
