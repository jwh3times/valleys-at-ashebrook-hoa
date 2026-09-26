import { env } from 'cloudflare:test';
import { getDb } from '../../src/server/db/client';
import {
  parties,
  people,
  ownerships,
  contactMethods,
  personLinks,
  personVerifications,
} from '../../src/server/db/roster-schema';

export async function seedRosterOwner(row: {
  id: string;
  propertyId: string;
  fullName: string;
  phone?: string | null;
  email?: string | null;
  status?: string;
  [key: string]: unknown;
}) {
  const db = getDb(env);
  const now = new Date(1);
  await db
    .insert(parties)
    .values({ id: row.id, kind: 'person', createdAt: now, updatedAt: now });
  await db.insert(people).values({
    partyId: row.id,
    partyKind: 'person',
    fullName: row.fullName,
    nameNormalized: row.fullName.toLowerCase(),
    updatedAt: now,
  });
  await db.insert(ownerships).values({
    id: `${row.id}-ownership`,
    ownerPartyId: row.id,
    lotId: row.propertyId,
    endDay: row.status === 'inactive' ? '2000-01-01' : null,
    createdAt: now,
    updatedAt: now,
  });
  for (const channel of ['email', 'phone'] as const) {
    const value = row[channel];
    if (value)
      await db.insert(contactMethods).values({
        id: `${row.id}-${channel}`,
        partyId: row.id,
        partyKind: 'person',
        channel: channel === 'phone' ? 'sms' : 'email',
        value,
        valueNormalized: value.toLowerCase(),
        isPreferred: true,
        createdAt: now,
        updatedAt: now,
      });
  }
}

export async function seedAccountLink(accountId: string, personId: string) {
  const db = getDb(env);
  const now = new Date(1);
  await db.insert(personVerifications).values({
    id: `verification-${accountId}`,
    accountId,
    personId,
    method: 'manual',
    approverAccountId: accountId,
    reason: 'manual_board_decision',
    verifiedAt: now,
  });
  await db.insert(personLinks).values({
    id: `link-${accountId}`,
    accountId,
    personId,
    verificationId: `verification-${accountId}`,
    startedAt: now,
  });
}
