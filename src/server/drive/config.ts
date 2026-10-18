import { tokenKeyBytes } from './seal';

// #290 slice 2: the Drive import appears only when every one of its five Worker
// secrets is set and DRIVE_TOKEN_KEY is exactly 32 bytes. Otherwise every
// /api/admin/drive/* route answers 404 and the keepalive skips. It does not
// depend on officialMode (spec 2026-10-18 decision 7).

export interface DriveConfig {
  clientId: string;
  clientSecret: string;
  pickerApiKey: string;
  projectNumber: string;
  tokenKey: string;
}

export function driveConfig(env: Env): DriveConfig | null {
  const {
    DRIVE_CLIENT_ID: clientId,
    DRIVE_CLIENT_SECRET: clientSecret,
    DRIVE_PICKER_API_KEY: pickerApiKey,
    DRIVE_PROJECT_NUMBER: projectNumber,
    DRIVE_TOKEN_KEY: tokenKey,
  } = env;
  if (
    !clientId ||
    !clientSecret ||
    !pickerApiKey ||
    !projectNumber ||
    !tokenKey
  )
    return null;
  if (!tokenKeyBytes(tokenKey)) return null;
  return { clientId, clientSecret, pickerApiKey, projectNumber, tokenKey };
}

export const notConfigured = () => new Response('Not Found', { status: 404 });
