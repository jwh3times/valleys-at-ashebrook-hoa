import { describe, it, expect } from 'vitest';
import {
  sealRefreshToken,
  unsealRefreshToken,
} from '../../src/server/drive/seal';

// #290 slice 2 (ADR 0027): the refresh token is the site's one stored
// third-party credential. It is sealed with AES-256-GCM under DRIVE_TOKEN_KEY,
// with the Google account it belongs to bound in as additional data.

// 32 bytes of 0x01 and 0x02, base64 — synthetic test keys, not real ones.
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const ACCOUNT = { googleSub: 'google-sub-1', keyVersion: 1 };

describe('sealing the Drive refresh token', () => {
  it('unseals what it sealed', async () => {
    const sealed = await sealRefreshToken(KEY, 'refresh-token-value', ACCOUNT);
    expect(sealed).not.toContain('refresh-token-value');
    expect(await unsealRefreshToken(KEY, sealed, ACCOUNT)).toBe(
      'refresh-token-value',
    );
  });

  it('never seals the same token to the same text twice', async () => {
    const a = await sealRefreshToken(KEY, 'same', ACCOUNT);
    const b = await sealRefreshToken(KEY, 'same', ACCOUNT);
    expect(a).not.toBe(b);
  });

  it('refuses a token sealed for a different Google account', async () => {
    const sealed = await sealRefreshToken(KEY, 'token', ACCOUNT);
    await expect(
      unsealRefreshToken(KEY, sealed, {
        ...ACCOUNT,
        googleSub: 'google-sub-2',
      }),
    ).rejects.toThrow();
  });

  it('refuses a token sealed under a different key version', async () => {
    const sealed = await sealRefreshToken(KEY, 'token', ACCOUNT);
    await expect(
      unsealRefreshToken(KEY, sealed, { ...ACCOUNT, keyVersion: 2 }),
    ).rejects.toThrow();
  });

  it('refuses a token sealed under a different key', async () => {
    const sealed = await sealRefreshToken(KEY, 'token', ACCOUNT);
    await expect(
      unsealRefreshToken(OTHER_KEY, sealed, ACCOUNT),
    ).rejects.toThrow();
  });

  it('refuses a tampered token', async () => {
    const sealed = await sealRefreshToken(KEY, 'token', ACCOUNT);
    // Flip one character in the middle of the ciphertext segment, where every
    // bit counts (the final base64 character can carry only padding bits).
    const [version, iv, body] = sealed.split('.');
    const mid = Math.floor(body.length / 2);
    const flipped = body[mid] === 'A' ? 'B' : 'A';
    const tampered = [
      version,
      iv,
      body.slice(0, mid) + flipped + body.slice(mid + 1),
    ].join('.');
    await expect(unsealRefreshToken(KEY, tampered, ACCOUNT)).rejects.toThrow();
  });
});
