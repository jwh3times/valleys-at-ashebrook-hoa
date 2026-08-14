import { useEffect, useState } from 'react';

// ADR 0022 phase 2: the read-only roster surfaces (issue #210).
//
// READ-ONLY IS THE POINT, not an unfinished state. The phase-2 backfill is an
// idempotent clean-replace, so anything written here would be silently erased
// by the next rehearsal run and again by the authoritative run inside the
// write-freeze. Legacy stays the only roster editor until the phase-3 flip,
// when these become writable.
//
// Five sections, matching the surfaces the privacy-boundary decision fixed:
// Roster, Board, Access, Review, and Compliance. Compliance is
// System-Administrator-only from phase 3; it cannot be restricted that way yet,
// because capabilities do not become authoritative until the flip, so for now
// the whole panel is board-only — the more restrictive of the two.

interface CountRow {
  label: string;
  n: number;
}

const SECTION_LABELS: Record<string, { title: string; blurb: string }> = {
  roster: {
    title: 'Roster',
    blurb:
      'Durable Lots, parties, ownerships, contacts and representations. One Party per legacy owner row — duplicates are never merged automatically.',
  },
  board: {
    title: 'Board',
    blurb:
      'Board service terms and office assignments. A current term needs a qualifying Lot, which legacy never recorded.',
  },
  access: {
    title: 'Access',
    blurb:
      'Stored Board and System Administration grants, and the Person Links they hang off. Member access is derived and has no rows.',
  },
  review: {
    title: 'Review',
    blurb:
      'Open review flags and the immutable audit ledger behind them. A flag never invalidates the action it references.',
  },
  compliance: {
    title: 'Compliance',
    blurb:
      'Integrity checks, redaction evidence, and cutover shadow mismatches. Restricted to System Administration Access from phase 3.',
  },
};

export default function RosterPreview() {
  const [sections, setSections] = useState<Record<string, CountRow[]> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/roster-preview')
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json() as Promise<{ sections: Record<string, CountRow[]> }>;
      })
      .then((data) => {
        if (!cancelled) setSections(data.sections);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!sections) return <p>Loading…</p>;

  return (
    <section>
      <h2>New roster (read-only)</h2>
      <p>
        A preview of the ADR 0022 tables during migration phase 2. Nothing here
        is editable, and nothing on the site reads these tables yet — the
        existing roster remains authoritative. The backfill clean-replaces these
        tables on every rehearsal run, so any edit would be erased.
      </p>
      {Object.entries(SECTION_LABELS).map(([key, meta]) => {
        const rows = sections[key] ?? [];
        return (
          <article key={key}>
            <h3>{meta.title}</h3>
            <p>{meta.blurb}</p>
            <table>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td>{row.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        );
      })}
    </section>
  );
}
