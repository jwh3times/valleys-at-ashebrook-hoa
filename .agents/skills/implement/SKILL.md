---
name: implement
description: 'Implement a piece of work based on a spec or set of tickets.'
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly (`npm run check`), single test files regularly, and — once at the
end — **both** of this repo's suites: `npm test` (jsdom unit/component) **and**
`npm run test:server` (Workers/D1 integration). One suite alone is not "the full test suite"
here.

Once done, use /code-review to review the work.

Commit your work to the current branch — but never directly on `main`; if you are on `main`,
create a topic branch first (`main` is protected and `/ship` opens the PR).
