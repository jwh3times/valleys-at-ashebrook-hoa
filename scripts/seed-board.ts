// The first-board bootstrap now lives in the Worker at src/server/auth/seed-board.ts
// (and is exposed as the fail-closed POST /api/bootstrap/board endpoint — see SETUP.md §6).
// This re-export is kept for CLI/muscle-memory use.
export { seedBoard } from '../src/server/auth/seed-board';
