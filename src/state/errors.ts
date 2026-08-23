import { tracked } from '@glimmer/tracking';

/**
 * A readable record of what went wrong.
 *
 * Exists because of a specific failure: "I hit send and it flashed something
 * so fast I couldn't read it, then it did nothing." Inline status is the right
 * place for the CURRENT state and the wrong place for the HISTORY of it — a
 * message that is replaced, cleared on navigation, or overwritten by the next
 * action is unreadable exactly when it matters most.
 *
 * So every error is also recorded here, where it stays until the panel closes.
 * Inline status still says what is happening now; this says what happened.
 *
 * Deliberately in memory only, not chrome.storage. These entries quote page
 * text, hosts and server messages — writing them to disk turns a debugging aid
 * into a durable record of everywhere the user has been, which is not a trade
 * a diagnostic panel gets to make on their behalf.
 */

export interface LogEntry {
  /** Monotonic, so `{{#each}}` has a stable key even for identical messages. */
  id: number;
  at: string;
  /** Where it came from — "send", "link", "track" — so a row is attributable. */
  source: string;
  message: string;
  /** The page it happened on, which is often the whole explanation. */
  host: string;
}

/** Enough to see a sequence, few enough to read. Oldest fall off. */
const MAX_ENTRIES = 25;

let nextId = 1;

class ErrorLog {
  @tracked entries: LogEntry[] = [];

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  record(source: string, message: string, host = ''): void {
    const entry: LogEntry = {
      id: nextId++,
      at: new Date().toLocaleTimeString(),
      source,
      message,
      host,
    };
    // Newest first, and a NEW array — autotracking fires on reassignment, not
    // on mutation, so unshift() alone would record without re-rendering.
    this.entries = [entry, ...this.entries].slice(0, MAX_ENTRIES);
  }

  clear(): void {
    this.entries = [];
  }
}

export const errorLog = new ErrorLog();
