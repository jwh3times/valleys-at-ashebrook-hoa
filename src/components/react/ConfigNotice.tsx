import { isFirebaseConfigured } from '../../lib/firebase';

/**
 * Renders a friendly setup notice when Firebase has not been configured yet,
 * so the site is usable/visible before env vars are filled in. Returns null
 * once configuration is present.
 */
export default function ConfigNotice() {
  if (isFirebaseConfigured) return null;
  return (
    <div className="notice">
      <strong>Setup needed:</strong> Firebase isn’t configured yet, so live
      content can’t load. Copy <code>.env.example</code> to <code>.env</code> and
      fill in your Firebase project values (see <code>SETUP.md</code>).
    </div>
  );
}
