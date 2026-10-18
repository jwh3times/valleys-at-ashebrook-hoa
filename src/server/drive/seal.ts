// The Drive connection's stored credential (#290 slice 2, ADR 0027). The
// refresh token is sealed with AES-256-GCM under DRIVE_TOKEN_KEY, a Worker
// secret holding 32 random bytes in base64. The Google account it belongs to
// and the key version are bound in as additional data, so a sealed token cannot
// be replayed onto another account's row or read under the wrong key version.
// Stored form: `v1.<iv>.<ciphertext>`, both base64url.

export interface SealBinding {
  googleSub: string;
  keyVersion: number;
}

const SEAL_FORMAT = 'v1';

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

/** The raw key bytes, or null unless DRIVE_TOKEN_KEY is exactly 32 bytes. */
export function tokenKeyBytes(
  keyBase64: string | undefined,
): Uint8Array<ArrayBuffer> | null {
  if (!keyBase64) return null;
  try {
    const bytes = base64ToBytes(keyBase64.trim());
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

async function aesKey(keyBase64: string): Promise<CryptoKey> {
  const bytes = tokenKeyBytes(keyBase64);
  if (!bytes) throw new Error('DRIVE_TOKEN_KEY must be 32 bytes of base64');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

function additionalData({ googleSub, keyVersion }: SealBinding) {
  return new TextEncoder().encode(
    `drive_connection:${googleSub}:${keyVersion}`,
  );
}

export async function sealRefreshToken(
  keyBase64: string,
  refreshToken: string,
  binding: SealBinding,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(binding) },
    await aesKey(keyBase64),
    new TextEncoder().encode(refreshToken),
  );
  return [
    SEAL_FORMAT,
    toBase64Url(iv),
    toBase64Url(new Uint8Array(ciphertext)),
  ].join('.');
}

/** Throws when the value was not sealed by this key for this binding. */
export async function unsealRefreshToken(
  keyBase64: string,
  sealed: string,
  binding: SealBinding,
): Promise<string> {
  const [format, iv, body] = sealed.split('.');
  if (format !== SEAL_FORMAT || !iv || !body)
    throw new Error('Unrecognized sealed token format');
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(iv),
      additionalData: additionalData(binding),
    },
    await aesKey(keyBase64),
    fromBase64Url(body),
  );
  return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// The OAuth state cookie. Connect stores { state, codeVerifier, accountId,
// intent, exp } in a cookie signed with HMAC-SHA-256 under a key derived from
// DRIVE_TOKEN_KEY by HKDF, so the callback can trust it without storage — KV
// could read stale at another location seconds later (spec decision 1).

export interface OAuthState {
  state: string;
  codeVerifier: string;
  accountId: string;
  intent: 'connect' | 'reconnect';
  /** The connection's revision when the reconnect began; null for a connect. */
  revision: number | null;
  /** Epoch milliseconds after which the callback refuses it. */
  exp: number;
}

async function stateKey(keyBase64: string): Promise<CryptoKey> {
  const bytes = tokenKeyBytes(keyBase64);
  if (!bytes) throw new Error('DRIVE_TOKEN_KEY must be 32 bytes of base64');
  const master = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('drive-oauth-state'),
    },
    master,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

export async function signOAuthState(
  keyBase64: string,
  payload: OAuthState,
): Promise<string> {
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign(
    'HMAC',
    await stateKey(keyBase64),
    new TextEncoder().encode(body),
  );
  return `${body}.${toBase64Url(new Uint8Array(mac))}`;
}

/** The payload, or null when the signature or shape is wrong or it expired. */
export async function verifyOAuthState(
  keyBase64: string,
  token: string,
  now: number = Date.now(),
): Promise<OAuthState | null> {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await stateKey(keyBase64),
      fromBase64Url(mac),
      new TextEncoder().encode(body),
    );
    if (!valid) return null;
    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64Url(body)),
    ) as OAuthState;
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

/** A random URL-safe token of `bytes` random bytes. */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The PKCE S256 challenge for a code verifier. */
export async function pkceChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier),
  );
  return toBase64Url(new Uint8Array(digest));
}
