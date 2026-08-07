import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import type { OpenVotingItem, VotingLot } from '../../lib/types';
import type { AuthContext } from '../authz/guards';
import { getDb } from '../db/client';
import {
  ballots,
  candidates,
  electionEligibility,
  elections,
  meetings,
  memberVotes,
  motionEligibility,
  motions,
  owners,
  properties,
  proxies,
} from '../db/schema';
import { visibleTiers } from './visibility';

interface HeldProxy {
  id: string;
  propertyId: string;
  holderName: string;
  meetingId: string | null;
  electionId: string | null;
}

interface EligibilityRow {
  propertyId: string;
  weight: number;
}

/**
 * Private, caller-specific projection for voting that is currently open.
 * Authority comes from verified lots and active owners of those lots holding
 * an occasion-scoped proxy. Eligibility and weight come only from the frozen
 * snapshots created when voting opened.
 */
export async function fetchOpenVotingFor(
  env: Env,
  ctx: AuthContext,
): Promise<OpenVotingItem[]> {
  if (ctx.propertyIds.length === 0) return [];

  const tiers = visibleTiers(ctx.role);
  if (tiers.length === 0) return [];

  const db = getDb(env);
  const [electionRows, motionRows] = await Promise.all([
    db
      .select({
        id: elections.id,
        meetingId: elections.meetingId,
        title: elections.title,
        date: elections.electionDate,
        seats: elections.seats,
      })
      .from(elections)
      .where(
        and(
          eq(elections.source, 'conducted'),
          eq(elections.status, 'open'),
          inArray(elections.visibility, tiers),
        ),
      )
      .orderBy(desc(elections.electionDate), asc(elections.id)),
    db
      .select({
        id: motions.id,
        text: motions.text,
        meetingId: meetings.id,
        meetingTitle: meetings.title,
        meetingDate: meetings.date,
      })
      .from(motions)
      .innerJoin(meetings, eq(motions.meetingId, meetings.id))
      .where(
        and(
          eq(motions.votingState, 'open'),
          eq(meetings.body, 'member'),
          eq(meetings.status, 'draft'),
          inArray(meetings.visibility, tiers),
        ),
      )
      .orderBy(desc(meetings.date), asc(motions.sequence), asc(motions.id)),
  ]);

  if (electionRows.length === 0 && motionRows.length === 0) return [];

  const ownPropertyIds = new Set(ctx.propertyIds);
  const ownerRows = await db
    .select({
      id: owners.id,
      propertyId: owners.propertyId,
      fullName: owners.fullName,
    })
    .from(owners)
    .where(
      and(
        inArray(owners.propertyId, ctx.propertyIds),
        eq(owners.status, 'active'),
      ),
    )
    .orderBy(asc(owners.id));

  const electionIds = electionRows.map((row) => row.id);
  const motionIds = motionRows.map((row) => row.id);
  const meetingIds = [
    ...new Set([
      ...electionRows.flatMap((row) =>
        row.meetingId === null ? [] : [row.meetingId],
      ),
      ...motionRows.map((row) => row.meetingId),
    ]),
  ];
  const ownerIds = ownerRows.map((row) => row.id);

  let proxyRows: HeldProxy[] = [];
  if (ownerIds.length > 0) {
    const occasionScope =
      electionIds.length > 0 && meetingIds.length > 0
        ? or(
            inArray(proxies.electionId, electionIds),
            inArray(proxies.meetingId, meetingIds),
          )
        : electionIds.length > 0
          ? inArray(proxies.electionId, electionIds)
          : inArray(proxies.meetingId, meetingIds);
    proxyRows = await db
      .select({
        id: proxies.id,
        propertyId: proxies.propertyId,
        holderName: proxies.holderName,
        meetingId: proxies.meetingId,
        electionId: proxies.electionId,
      })
      .from(proxies)
      .where(and(inArray(proxies.holderOwnerId, ownerIds), occasionScope))
      .orderBy(asc(proxies.id));
  }

  const targetPropertyIds = [
    ...new Set([...ctx.propertyIds, ...proxyRows.map((row) => row.propertyId)]),
  ];
  const propertyRows = await db
    .select({ id: properties.id, address: properties.address })
    .from(properties)
    .where(inArray(properties.id, targetPropertyIds));
  const addressByProperty = new Map(
    propertyRows.map((row) => [row.id, row.address]),
  );

  let electionEligibilityRows: Array<EligibilityRow & { electionId: string }> =
    [];
  if (electionIds.length > 0) {
    electionEligibilityRows = await db
      .select({
        electionId: electionEligibility.electionId,
        propertyId: electionEligibility.propertyId,
        weight: electionEligibility.weight,
      })
      .from(electionEligibility)
      .where(
        and(
          inArray(electionEligibility.electionId, electionIds),
          inArray(electionEligibility.propertyId, targetPropertyIds),
        ),
      );
  }

  let motionEligibilityRows: Array<EligibilityRow & { motionId: string }> = [];
  if (motionIds.length > 0) {
    motionEligibilityRows = await db
      .select({
        motionId: motionEligibility.motionId,
        propertyId: motionEligibility.propertyId,
        weight: motionEligibility.weight,
      })
      .from(motionEligibility)
      .where(
        and(
          inArray(motionEligibility.motionId, motionIds),
          inArray(motionEligibility.propertyId, targetPropertyIds),
        ),
      );
  }

  const candidateRows =
    electionIds.length === 0
      ? []
      : await db
          .select({
            id: candidates.id,
            electionId: candidates.electionId,
            fullName: candidates.fullName,
            statementMd: candidates.statementMd,
            sequence: candidates.sequence,
          })
          .from(candidates)
          .where(
            and(
              inArray(candidates.electionId, electionIds),
              eq(candidates.withdrawn, false),
            ),
          )
          .orderBy(asc(candidates.sequence), asc(candidates.id));

  const ballotRows =
    electionIds.length === 0
      ? []
      : await db
          .select({
            electionId: ballots.electionId,
            propertyId: ballots.propertyId,
          })
          .from(ballots)
          .where(
            and(
              inArray(ballots.electionId, electionIds),
              inArray(ballots.propertyId, targetPropertyIds),
            ),
          );
  const voteRows =
    motionIds.length === 0
      ? []
      : await db
          .select({
            motionId: memberVotes.motionId,
            propertyId: memberVotes.propertyId,
          })
          .from(memberVotes)
          .where(
            and(
              inArray(memberVotes.motionId, motionIds),
              inArray(memberVotes.propertyId, targetPropertyIds),
            ),
          );

  const ownersByProperty = new Map<
    string,
    Array<{ id: string; fullName: string }>
  >();
  for (const owner of ownerRows) {
    const list = ownersByProperty.get(owner.propertyId) ?? [];
    list.push({ id: owner.id, fullName: owner.fullName });
    ownersByProperty.set(owner.propertyId, list);
  }

  const ballotReceipts = new Set(
    ballotRows.map((row) => `${row.electionId}\u0000${row.propertyId}`),
  );
  const voteReceipts = new Set(
    voteRows.map((row) => `${row.motionId}\u0000${row.propertyId}`),
  );

  function lotsFor(
    eligibility: EligibilityRow[],
    itemProxies: HeldProxy[],
    receiptKey: (propertyId: string) => string,
    receipts: Set<string>,
  ): VotingLot[] {
    const proxiesByProperty = new Map<string, HeldProxy[]>();
    for (const proxy of itemProxies) {
      const list = proxiesByProperty.get(proxy.propertyId) ?? [];
      list.push(proxy);
      proxiesByProperty.set(proxy.propertyId, list);
    }

    return eligibility
      .flatMap((row): VotingLot[] => {
        const address = addressByProperty.get(row.propertyId);
        const lotProxies = proxiesByProperty.get(row.propertyId) ?? [];
        if (
          address === undefined ||
          (!ownPropertyIds.has(row.propertyId) && lotProxies.length === 0)
        ) {
          return [];
        }
        return [
          {
            propertyId: row.propertyId,
            address,
            weight: row.weight,
            hasCast: receipts.has(receiptKey(row.propertyId)),
            ownerOptions: ownPropertyIds.has(row.propertyId)
              ? (ownersByProperty.get(row.propertyId) ?? [])
              : [],
            proxyOptions: lotProxies.map((proxy) => ({
              id: proxy.id,
              holderName: proxy.holderName,
              grantingAddress: address,
            })),
          },
        ];
      })
      .sort((a, b) => a.address.localeCompare(b.address));
  }

  const items: OpenVotingItem[] = [];
  for (const election of electionRows) {
    const itemProxies = proxyRows.filter(
      (proxy) =>
        proxy.electionId === election.id ||
        (election.meetingId !== null && proxy.meetingId === election.meetingId),
    );
    const lots = lotsFor(
      electionEligibilityRows.filter((row) => row.electionId === election.id),
      itemProxies,
      (propertyId) => `${election.id}\u0000${propertyId}`,
      ballotReceipts,
    );
    if (lots.length === 0) continue;
    items.push({
      kind: 'election',
      id: election.id,
      title: election.title,
      date: election.date,
      seats: election.seats,
      candidates: candidateRows
        .filter((candidate) => candidate.electionId === election.id)
        .map(({ id, fullName, statementMd }) => ({
          id,
          fullName,
          statementMd,
        })),
      lots,
    });
  }

  for (const motion of motionRows) {
    const lots = lotsFor(
      motionEligibilityRows.filter((row) => row.motionId === motion.id),
      proxyRows.filter((proxy) => proxy.meetingId === motion.meetingId),
      (propertyId) => `${motion.id}\u0000${propertyId}`,
      voteReceipts,
    );
    if (lots.length === 0) continue;
    items.push({
      kind: 'motion',
      id: motion.id,
      text: motion.text,
      meetingId: motion.meetingId,
      meetingTitle: motion.meetingTitle,
      meetingDate: motion.meetingDate,
      lots,
    });
  }

  return items;
}
