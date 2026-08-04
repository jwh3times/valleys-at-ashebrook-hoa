import type { ProxyDetail } from '../../lib/types';

/**
 * The lot + occasion scope rule for proxy pickers, shared by the member
 * attendance/vote editors (MeetingsManager) and the ballots editor
 * (ElectionsManager). A meeting-scoped proxy also covers an election held at
 * that meeting (ADR 0018), which is why an election occasion carries its
 * meetingId. The one-proxy-per-lot-per-occasion unique index means the result
 * has at most one entry for a meeting occasion, and at most two for an
 * election held at a meeting.
 */
export function proxiesForOccasion(
  list: ProxyDetail[],
  propertyId: string,
  occasion:
    | { kind: 'meeting'; meetingId: string }
    | { kind: 'election'; electionId: string; meetingId: string | null },
): ProxyDetail[] {
  return list.filter((px) => {
    if (px.propertyId !== propertyId) return false;
    if (occasion.kind === 'meeting') return px.meetingId === occasion.meetingId;
    return (
      px.electionId === occasion.electionId ||
      (occasion.meetingId !== null && px.meetingId === occasion.meetingId)
    );
  });
}

interface ProxyPickerProps {
  /** Select id and label htmlFor — callers keep their existing id scheme. */
  id: string;
  address: string;
  /** Already scoped via proxiesForOccasion; empty renders nothing. */
  lotProxies: ProxyDetail[];
  /** Selected proxy id; '' = no proxy. */
  value: string;
  /**
   * Callers own the mutual-exclusion state update (picking a proxy clears
   * the owner field of their form row), because each form's row shape
   * differs. The picker only reports the new value.
   */
  onChange: (proxyId: string) => void;
  /** Render without the flex wrapper (ballots editor supplies its own). */
  bare?: boolean;
  /** Wrapper style overrides (indentation differs per editor). */
  style?: React.CSSProperties;
}

export default function ProxyPicker({
  id,
  address,
  lotProxies,
  value,
  onChange,
  bare,
  style,
}: ProxyPickerProps) {
  if (lotProxies.length === 0) return null;
  const inner = (
    <>
      <label htmlFor={id}>Proxy — {address}</label>
      <select
        id={id}
        aria-label={`Proxy — ${address}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">— no proxy —</option>
        {lotProxies.map((px) => (
          <option key={px.id} value={px.id}>
            via proxy: {px.holderName}
          </option>
        ))}
      </select>
    </>
  );
  if (bare) return inner;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginTop: '4px',
        ...style,
      }}
    >
      {inner}
    </div>
  );
}
