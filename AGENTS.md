# Repository Guidelines

## Project Structure & Module Organization

This is an Astro SSR app for the Valleys at Ashebrook neighborhood. Source code lives in `src/`, with pages and API routes in `src/pages/`, shared UI in `src/components/`, layouts in `src/layouts/`, client helpers in `src/lib/`, and server-only logic in `src/server/`. Tests live in `test/`, public static assets in `public/`, automation scripts in `scripts/`, and documentation in `docs/`. The `design/Ashebrook HOA.dc.html` file is reference-only and should not be edited.

## Build, Test, and Development Commands

Use the Node version pinned in `.nvmrc` (`nvm use`) before installing dependencies.

- `npm run dev` or `npm start`: run the local Astro dev server.
- `npm run build`: build the production SSR output.
- `npm run check`: run Astro and TypeScript checks.
- `npm test`: run the Vitest unit/component suite.
- `npm run test:server`: run Worker/D1 integration tests.
- `npm run format` / `npm run format:check`: apply or verify Prettier formatting.
- `npm run deploy`: build and deploy with Wrangler.

## Coding Style & Naming Conventions

Use TypeScript and Astro conventions already present in the repo. Follow the existing Prettier settings, keep indentation consistent with the file’s current style, and prefer descriptive names over abbreviations. Use `*.test.ts` and `*.test.tsx` for tests. Keep server-only code in `src/server/` and avoid importing it into client-side modules.

## Testing Guidelines

Add or update tests alongside behavior changes. Use `npm test` for jsdom-based unit and component tests, and `npm run test:server` for Cloudflare Worker or D1 behavior. Test names should describe visible behavior, e.g. `shows an empty state`. Prefer small focused tests over broad snapshots unless the UI is intentionally static.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries, often lowercase, such as `fix forgot password reset flow`. Keep commit subjects concise and action-oriented. PRs should include a clear description, link related issues when applicable, and mention the commands you ran locally. If a change affects UI or admin workflows, include screenshots or a short note describing the user-visible result.

## Security & Configuration Tips

Do not commit real roster data, secrets, or production credentials. Keep environment examples in `.env.example` and `.dev.vars.example`. Schema changes should go through Drizzle migrations, and access control must stay server-side and fail closed.

Do not commit implementation scratchpads, security reviews, import artifacts, resident-data-derived files, or detailed operational runbooks. Keep those under `private/`; public docs should describe supported architecture and workflows, not exploit analysis, private execution notes, or resident-data handling details.
