// Tenant Access (ADR 0028, #294; spec docs/specs/2026-10-20-tenant-access-design.md).
//
// Slice 1 holds only the gate. The Tenancy fact, its currency rule and its
// consequences join this module in slice 2.

/**
 * Both gates, inside SQL: `officialMode` AND `tenantAccessEnabled`, each a
 * literal JSON `true`. A copy of `LOT_RECORDS_ENABLED_SQL` (see
 * `lot-records/gate.ts` for why `json_type` and not `json_extract`). A missing
 * row, a missing key or malformed JSON all read as off.
 *
 * Every tenant mutation re-checks it inside its own statement, and the
 * document predicate embeds it, so a tenant stops seeing Tenant-Visible
 * documents on the first request after either gate turns off. Ending or
 * voiding a Tenancy never checks it: ending access must not wait on a gate.
 */
export const TENANT_ACCESS_ENABLED_SQL = `
  EXISTS (
    SELECT 1 FROM settings
    WHERE key = 'site'
      AND CASE WHEN json_valid(value)
        THEN json_type(value, '$.officialMode') = 'true'
         AND json_type(value, '$.tenantAccessEnabled') = 'true'
        ELSE 0
      END
  )
` as const;
