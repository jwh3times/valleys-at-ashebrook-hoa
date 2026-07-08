# ADR 0004: Deployment via Cloudflare Workers Builds

**Status:** Accepted
**Date:** 2026-07-08

## Context

The improvement list proposed a GitHub deploy workflow so production would track
`main`. The repository is already connected to Cloudflare Workers Builds, and CI
in GitHub verifies format, types, unit tests, Worker/D1 tests, and production
builds.

## Decision

Keep production deploys on Cloudflare Workers Builds instead of adding a duplicate
GitHub Actions deploy workflow. GitHub Actions remains the verification gate.
Cloudflare handles the deploy from `main`.

## Consequences

- There is one deploy owner rather than two competing deployment systems.
- Cloudflare API deploy tokens are not needed in GitHub secrets for normal
  production deploys.
- If the project later moves away from Workers Builds, add a dedicated ADR and a
  GitHub deploy workflow in the same change.
