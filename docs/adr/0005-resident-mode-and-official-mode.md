# ADR 0005: Resident Mode and Official Mode

**Status:** Accepted
**Date:** 2026-07-08

## Context

The site is resident-built and resident-operated by default. Some features and
copy are appropriate only if the HOA board formally adopts the site as an
official surface.

## Decision

Default the site to unofficial resident mode. In this mode the public site uses
resident-run branding, shows a disclaimer, and hides official-HOA surfaces such as
dues navigation and board-framed copy.

Keep the official functionality behind an admin-toggleable `officialMode` setting
stored in the D1 site settings blob. The setting is read server-side for page
rendering so the header, footer, metadata, and page copy switch without a client
flash or redeploy.

## Consequences

- The default public presentation matches the site owner's authority.
- The board can adopt the site later without rebuilding the app.
- Resource names such as D1/R2 bucket names do not need to change with public
  branding; those renames remain operator work.
