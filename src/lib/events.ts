import fs from "node:fs";
import path from "node:path";

/**
 * Community calendar events live in `content/events.json` as a simple array.
 * Each event looks like:
 *
 *   {
 *     "title": "Monthly Board Meeting",
 *     "date": "2026-07-14",
 *     "time": "7:00 PM",
 *     "location": "Clubhouse",
 *     "description": "Open to all residents."
 *   }
 *
 * To add an event, append another object to the array. `time`, `location`, and
 * `description` are optional.
 */

const EVENTS_FILE = path.join(process.cwd(), "content", "events.json");

export type CommunityEvent = {
  title: string;
  date: string; // ISO date (YYYY-MM-DD)
  time?: string;
  location?: string;
  description?: string;
};

function readAll(): CommunityEvent[] {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  const raw = fs.readFileSync(EVENTS_FILE, "utf8");
  const parsed = JSON.parse(raw) as CommunityEvent[];
  return parsed
    .filter((e) => e && e.title && e.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** All events, chronological. */
export function getEvents(): CommunityEvent[] {
  return readAll();
}

/** Events today or in the future (relative to `now`), soonest first. */
export function getUpcomingEvents(now: Date = new Date()): CommunityEvent[] {
  const today = now.toISOString().slice(0, 10);
  return readAll().filter((e) => e.date >= today);
}
