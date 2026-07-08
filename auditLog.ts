import { db } from './db';
import { auditLog } from './schema';
import { desc } from 'drizzle-orm';
import { computeAuditHash } from './crypto';

export type AuditEventType =
  | 'ROUND_OPEN'
  | 'BET_RECEIVED'
  | 'BET_REJECTED'
  | 'ROUND_SETTLE_START'
  | 'ROUND_REVEAL'
  | 'ROUND_WIN'
  | 'ROUND_PAYOUT'
  | 'ROUND_CANCELLED'
  | 'REFUND_SENT'
  | 'TREASURY_LOW'
  | 'TREASURY_REFILLED'
  | 'AGENT_BOOT';

export interface AuditEntry {
  id: number;
  prevHash: string;
  timestamp: string;
  eventType: string;
  data: unknown;
  hash: string;
  createdAt: Date;
}

// Genesis hash for the first entry in the chain
const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Get the most recent audit entry's hash for chaining
 */
async function getLastHash(): Promise<string> {
  try {
    const last = await db
      .select({ hash: auditLog.hash })
      .from(auditLog)
      .orderBy(desc(auditLog.id))
      .limit(1);

    return last.length > 0 ? last[0].hash : GENESIS_HASH;
  } catch {
    return GENESIS_HASH;
  }
}

/**
 * Append a new entry to the Astrid-style hash-chained audit log
 */
export async function appendAuditEntry(
  eventType: AuditEventType,
  data: unknown
): Promise<AuditEntry> {
  const prevHash = await getLastHash();
  const timestamp = new Date().toISOString();
  const hash = computeAuditHash(prevHash, timestamp, eventType, data);

  const [entry] = await db
    .insert(auditLog)
    .values({
      prevHash,
      timestamp,
      eventType,
      data: data as Record<string, unknown>,
      hash,
    })
    .returning();

  return {
    id: entry.id,
    prevHash: entry.prevHash,
    timestamp: entry.timestamp,
    eventType: entry.eventType,
    data: entry.data,
    hash: entry.hash,
    createdAt: entry.createdAt,
  };
}

/**
 * Get paginated audit entries, newest first
 */
export async function getAuditEntries(
  page: number = 1,
  pageSize: number = 20
): Promise<{ entries: AuditEntry[]; total: number }> {
  const offset = (page - 1) * pageSize;

  const entries = await db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(pageSize)
    .offset(offset);

  // Count total (approximate via a count query)
  const countResult = await db.select({ count: auditLog.id }).from(auditLog);
  const total = countResult.length;

  return {
    entries: entries.map((e) => ({
      id: e.id,
      prevHash: e.prevHash,
      timestamp: e.timestamp,
      eventType: e.eventType,
      data: e.data,
      hash: e.hash,
      createdAt: e.createdAt,
    })),
    total,
  };
}
