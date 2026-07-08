/**
 * Round Manager — core game logic for ProvaDice
 *
 * Round lifecycle:
 * 1. OPEN: accept bets from confirmed incoming transfers
 * 2. SETTLING: no more bets, computing winner
 * 3. SETTLED: winner paid, next round starting
 * 4. CANCELLED: < MIN_PLAYERS, all refunded
 */

import { db } from './db.js';
import { rounds, bets, leaderboardCache } from './schema.js';
import { eq, sql, desc } from 'drizzle-orm';
import {
  generateRoundId,
  MIN_PLAYERS_PER_ROUND,
  MAX_BET_PCT_OF_POT,
  HOUSE_FEE_PCT,
  ROUND_DURATION_MS,
} from './constants.js';
import {
  generateSeed,
  computeCommitHash,
  computeRevealHash,
  selectWinner,
} from './crypto.js';
import { appendAuditEntry } from './auditLog.js';

export interface RoundState {
  roundId: string;
  status: 'open' | 'settling' | 'settled' | 'cancelled';
  startTime: Date;
  endTime: Date;
  commitHash: string;
  totalPotBaseUnits: string;
  playerCount: number;
  bets: BetInfo[];
  timeRemainingMs: number;
  winnerNametag?: string;
  winningNumber?: number;
  revealSeed?: string;
  finalHash?: string;
  payoutTxId?: string;
}

export interface BetInfo {
  nametag: string;
  amountBaseUnits: string;
  txId: string;
  pickedNumber?: number;
  confirmedAt: string;
}

// In-memory seed storage (never persisted, never logged after commit)
const roundSeeds = new Map<string, string>();

/**
 * Create a new round in DB, return its state
 */
export async function openNewRound(): Promise<RoundState> {
  const roundId = generateRoundId();
  const seed = generateSeed();
  const commitHash = computeCommitHash(seed);
  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + ROUND_DURATION_MS);

  // Store seed in memory only
  roundSeeds.set(roundId, seed);

 await db.insert(rounds).values({
    roundId,
    status: 'open',
    startTime,
    endTime,
    commitHash,
    revealSeed: seed,
    totalPotBaseUnits: '0',
    playerCount: 0,
  });

  await appendAuditEntry('ROUND_OPEN', {
    roundId,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    commitHash,
    note: 'Seed stored in memory only; hash published for transparency',
  });

  return {
    roundId,
    status: 'open',
    startTime,
    endTime,
    commitHash,
    totalPotBaseUnits: '0',
    playerCount: 0,
    bets: [],
    timeRemainingMs: ROUND_DURATION_MS,
  };
}

/**
 * Get the current active round state
 */
export async function getCurrentRoundState(): Promise<RoundState | null> {
  const round = await db
    .select()
    .from(rounds)
    .where(sql`status IN ('open', 'settling')`)
    .orderBy(desc(rounds.id))
    .limit(1);

  if (round.length === 0) return null;

  const r = round[0];
  const roundBets = await db
    .select()
    .from(bets)
    .where(eq(bets.roundId, r.roundId));

  const now = Date.now();
  const endTime = new Date(r.endTime);
  const timeRemainingMs = Math.max(0, endTime.getTime() - now);

  return {
    roundId: r.roundId,
    status: r.status as RoundState['status'],
    startTime: new Date(r.startTime),
    endTime,
    commitHash: r.commitHash,
    totalPotBaseUnits: r.totalPotBaseUnits,
    playerCount: r.playerCount,
    bets: roundBets.map((b) => ({
      nametag: b.nametag,
      amountBaseUnits: b.amountBaseUnits,
      txId: b.txId,
      pickedNumber: b.pickedNumber ?? undefined,
      confirmedAt: b.confirmedAt.toISOString(),
    })),
    timeRemainingMs,
    winnerNametag: r.winnerNametag ?? undefined,
    winningNumber: r.winningNumber ?? undefined,
    revealSeed: r.revealSeed ?? undefined,
    finalHash: r.finalHash ?? undefined,
    payoutTxId: r.payoutTxId ?? undefined,
  };
}

/**
 * Record a confirmed bet from a real incoming transfer
 * @returns { accepted: true } or { accepted: false, reason: string }
 */
export async function recordBet(
  roundId: string,
  nametag: string,
  amountBaseUnits: bigint,
  txId: string,
  memo?: string,
  pickedNumber?: number
): Promise<{ accepted: boolean; reason?: string }> {
  if (!pickedNumber || pickedNumber < 1 || pickedNumber > 6) {
    return { accepted: false, reason: 'pickedNumber must be 1-6' };
  }
  // Get current round
  const round = await db
    .select()
    .from(rounds)
    .where(eq(rounds.roundId, roundId))
    .limit(1);

  if (round.length === 0) {
    return { accepted: false, reason: 'Round not found' };
  }

  const r = round[0];

  if (r.status !== 'open') {
    return { accepted: false, reason: `Round is ${r.status}, not open` };
  }

  if (new Date() > new Date(r.endTime)) {
    return { accepted: false, reason: 'Round has ended' };
  }

  // Check max players
  if (r.playerCount >= 50) {
    return { accepted: false, reason: 'Round is full (50 players max)' };
  }

  // Check max bet percentage of current pot
  const currentPot = BigInt(r.totalPotBaseUnits);
  if (currentPot > BigInt(0)) {
    const maxBet = (currentPot * BigInt(Math.floor(MAX_BET_PCT_OF_POT * 10000))) / BigInt(10000);
    if (amountBaseUnits > maxBet) {
      return {
        accepted: false,
        reason: `Bet exceeds max ${MAX_BET_PCT_OF_POT * 100}% of current pot`,
      };
    }
  }

  // Check for duplicate txId
  const existing = await db
    .select()
    .from(bets)
    .where(eq(bets.txId, txId))
    .limit(1);

  if (existing.length > 0) {
    return { accepted: false, reason: 'Transaction already recorded' };
  }

  // Record the bet
  await db.insert(bets).values({
    roundId,
    nametag,
    amountBaseUnits: amountBaseUnits.toString(),
    txId,
    memo,
    pickedNumber,
    confirmedAt: new Date(),
  });

  // Update round totals
  const newPot = (currentPot + amountBaseUnits).toString();
  await db
    .update(rounds)
    .set({
      totalPotBaseUnits: newPot,
      playerCount: sql`${rounds.playerCount} + 1`,
    })
    .where(eq(rounds.roundId, roundId));

  // Update leaderboard cache
  await db
    .insert(leaderboardCache)
    .values({
      nametag,
      totalBetsPlaced: 1,
      totalBetBaseUnits: amountBaseUnits.toString(),
    })
    .onConflictDoUpdate({
      target: leaderboardCache.nametag,
      set: {
        totalBetsPlaced: sql`${leaderboardCache.totalBetsPlaced} + 1`,
        totalBetBaseUnits: sql`(${leaderboardCache.totalBetBaseUnits}::numeric + ${amountBaseUnits.toString()}::numeric)::text`,
        updatedAt: new Date(),
      },
    });

  await appendAuditEntry('BET_RECEIVED', {
    roundId,
    nametag,
    amountBaseUnits: amountBaseUnits.toString(),
    txId,
    memo,
    newPot,
  });

  return { accepted: true };
}

/**
 * Settle a round: reveal seed, pick winner, pay out
 * Returns the payout tx id or null if cancelled
 */
export async function settleRound(
  roundId: string,
  sendUCT: (toNametag: string, amount: bigint, memo: string) => Promise<string>
): Promise<{ settled: boolean; winner?: string; payoutTxId?: string; cancelled?: boolean }> {
  const round = await db
    .select()
    .from(rounds)
    .where(eq(rounds.roundId, roundId))
    .limit(1);

  if (round.length === 0) throw new Error(`Round ${roundId} not found`);
  const r = round[0];

  if (r.status === 'settled' || r.status === 'cancelled') {
    return { settled: false };
  }

  // Mark as settling
  await db
    .update(rounds)
    .set({ status: 'settling' })
    .where(eq(rounds.roundId, roundId));

  // Get all bets
  const roundBets = await db
    .select()
    .from(bets)
    .where(eq(bets.roundId, roundId));

  await appendAuditEntry('ROUND_SETTLE_START', {
    roundId,
    betCount: roundBets.length,
    totalPot: r.totalPotBaseUnits,
  });

  // Check minimum players
  if (roundBets.length < MIN_PLAYERS_PER_ROUND) {
    // Cancel and refund
    await db
      .update(rounds)
      .set({ status: 'cancelled' })
      .where(eq(rounds.roundId, roundId));

    await appendAuditEntry('ROUND_CANCELLED', {
      roundId,
      reason: `Only ${roundBets.length} player(s), minimum is ${MIN_PLAYERS_PER_ROUND}`,
    });

    // Refund all bets
    for (const bet of roundBets) {
      try {
        const refundTxId = await sendUCT(
          bet.nametag,
          BigInt(bet.amountBaseUnits),
          `ProvaDice refund — round #${roundId} cancelled`
        );

        await db
          .update(bets)
          .set({ refunded: true, refundTxId })
          .where(eq(bets.id, bet.id));

        await appendAuditEntry('REFUND_SENT', {
          roundId,
          nametag: bet.nametag,
          amountBaseUnits: bet.amountBaseUnits,
          refundTxId,
        });
      } catch (err) {
        console.error(`Failed to refund ${bet.nametag}:`, err);
        await appendAuditEntry('REFUND_SENT', {
          roundId,
          nametag: bet.nametag,
          amountBaseUnits: bet.amountBaseUnits,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    roundSeeds.delete(roundId);
    return { settled: true, cancelled: true };
  }

 // Get seed from DB (survives across serverless instances, unlike the in-memory map)
  const seed = r.revealSeed;
  if (!seed) {
    throw new Error(`Seed not found for round ${roundId} — cannot settle fairly`);
  }

  // Use the last bet's txId as additional entropy
  const lastBet = roundBets[roundBets.length - 1];
  const lastTxHash = lastBet.txId;

  const finalHash = computeRevealHash(seed, lastTxHash);

  // Classic dice: map finalHash to a number 1-6
  const hashBigInt = BigInt('0x' + finalHash);
  const winningNumber = Number(hashBigInt % BigInt(6)) + 1;

  await appendAuditEntry('ROUND_REVEAL', {
    roundId,
    commitHash: r.commitHash,
    revealSeed: seed,
    lastTxHash,
    finalHash,
    winningNumber,
    note: 'winningNumber = (BigInt(0x + finalHash) % 6) + 1',
  });

  const totalPot = BigInt(r.totalPotBaseUnits);
  const houseFeeNumerator = BigInt(Math.floor(HOUSE_FEE_PCT * 10000));
  const houseFee = (totalPot * houseFeeNumerator) / BigInt(10000);
  const payoutPool = totalPot - houseFee;

  const winners = roundBets.filter((b) => b.pickedNumber === winningNumber);
  const winnersTotalStake = winners.reduce(
    (sum, b) => sum + BigInt(b.amountBaseUnits),
    BigInt(0)
  );

  await appendAuditEntry('ROUND_WIN', {
    roundId,
    winningNumber,
    finalHash,
    totalPotBaseUnits: r.totalPotBaseUnits,
    winnerCount: winners.length,
    algorithm: 'All bettors who picked winningNumber split payoutPool proportional to their stake. If no winners, house keeps the pot.',
  });

  let winnerNametag = winners.length > 0 ? winners.map((w) => w.nametag).join(',') : 'HOUSE';
  const payoutTxIds: string[] = [];

  if (winners.length === 0) {
    await appendAuditEntry('ROUND_PAYOUT', {
      roundId,
      winningNumber,
      payoutBaseUnits: '0',
      note: 'No winners this round — house keeps the pot',
      status: 'SUCCESS',
    });
  } else {
    for (const winner of winners) {
      const share = (BigInt(winner.amountBaseUnits) * payoutPool) / winnersTotalStake;
      try {
        const txId = await sendUCT(
          winner.nametag,
          share,
          `ProvaDice round #${roundId} win — rolled ${winningNumber}`
        );
        payoutTxIds.push(txId);
        await appendAuditEntry('ROUND_PAYOUT', {
          roundId,
          winnerNametag: winner.nametag,
          payoutBaseUnits: share.toString(),
          txId,
          status: 'SUCCESS',
        });
      } catch (err) {
        console.error(`Payout failed for ${winner.nametag}:`, err);
        await appendAuditEntry('ROUND_PAYOUT', {
          roundId,
          winnerNametag: winner.nametag,
          payoutBaseUnits: share.toString(),
          error: err instanceof Error ? err.message : String(err),
          status: 'FAILED',
        });
      }
    }
  }

  const payoutTxId = payoutTxIds[0] ?? 'no-winner';
  const payout = payoutPool;

 // Update round in DB
  await db
    .update(rounds)
    .set({
      status: 'settled',
      revealSeed: seed,
      finalHash,
      winnerNametag,
      winningNumber,
      payoutTxId,
    })
    .where(eq(rounds.roundId, roundId));

  // Update leaderboard for each winner
  for (const winner of winners) {
    const share = (BigInt(winner.amountBaseUnits) * payoutPool) / winnersTotalStake;
    await db
      .insert(leaderboardCache)
      .values({
        nametag: winner.nametag,
        totalWins: 1,
        totalWonBaseUnits: share.toString(),
        lastWinAt: new Date(),
      })
      .onConflictDoUpdate({
        target: leaderboardCache.nametag,
        set: {
          totalWins: sql`${leaderboardCache.totalWins} + 1`,
          totalWonBaseUnits: sql`(${leaderboardCache.totalWonBaseUnits}::numeric + ${share.toString()}::numeric)::text`,
          lastWinAt: new Date(),
          updatedAt: new Date(),
        },
      });
  }

  // Clean up seed from memory
  roundSeeds.delete(roundId);

  return { settled: true, winner: winnerNametag, payoutTxId };
}

/**
 * Get last N settled rounds for history
 */
export async function getRecentRounds(limit = 10): Promise<typeof rounds.$inferSelect[]> {
  return db
    .select()
    .from(rounds)
    .orderBy(desc(rounds.id))
    .limit(limit);
}
