/**
 * Round Clock — manages the 60-second round lifecycle
 * Called from the Next.js API route /api/clock (triggered by a periodic fetch)
 * Also handles incoming transfer processing
 */

import { db } from './db.js';
import { rounds } from './schema.js';
import { eq, sql } from 'drizzle-orm';
import {
  openNewRound,
  getCurrentRoundState,
  settleRound,
  getRecentRounds,
} from './roundManager.js';
import { checkAndRefillTreasury } from './faucet.js';
import { sendUCT, initHouseWallet, subscribeToIncoming } from './houseWallet.js';
import { recordBet } from './roundManager.js';
import { appendAuditEntry } from './auditLog.js';
import { UCT_COIN_ID } from './constants.js';

let clockInitialized = false;
let currentRoundId: string | null = null;

/**
 * Initialize the round clock (call once at server boot)
 */
export async function initRoundClock(): Promise<void> {
  if (clockInitialized) return;
  clockInitialized = true;

  // Initialize house wallet first
  await initHouseWallet();

  // Subscribe to incoming transfers — bet processing
  subscribeToIncoming(async (transfer) => {
    if (!currentRoundId) {
      console.warn(`[RoundClock] Incoming transfer with no active round — will refund: ${transfer.txId}`);
      // Refund the transfer
      try {
        await sendUCT(
          transfer.fromNametag,
          transfer.amountBaseUnits,
          'ProvaDice refund — no active round'
        );
        await appendAuditEntry('REFUND_SENT', {
          reason: 'no active round',
          ...transfer,
          amountBaseUnits: transfer.amountBaseUnits.toString(),
        });
      } catch (err) {
        console.error('Refund failed:', err);
      }
      return;
    }

    // Parse round ID from memo if present, otherwise use current round
    let targetRoundId = currentRoundId;
    if (transfer.memo.includes('round-')) {
      const match = transfer.memo.match(/round-\d+-[a-f0-9]+/);
      if (match && match[0] !== currentRoundId) {
        // Transfer is for a different round — refund
        await sendUCT(
          transfer.fromNametag,
          transfer.amountBaseUnits,
          `ProvaDice refund — wrong round (expected ${currentRoundId})`
        );
        return;
      }
      if (match) targetRoundId = match[0];
    }

   const numberMatch = transfer.memo.match(/num:(\d)/);
    const pickedNumber = numberMatch ? parseInt(numberMatch[1], 10) : undefined;

    const result = await recordBet(
      targetRoundId,
      transfer.fromNametag,
      transfer.amountBaseUnits,
      transfer.txId,
      transfer.memo,
      pickedNumber
    );

    if (!result.accepted) {
      // Refund rejected bet
      console.warn(`[RoundClock] Bet rejected (${result.reason}) — refunding ${transfer.fromNametag}`);
      await appendAuditEntry('BET_REJECTED', {
        reason: result.reason,
        nametag: transfer.fromNametag,
        amountBaseUnits: transfer.amountBaseUnits.toString(),
        txId: transfer.txId,
      });
      try {
        await sendUCT(
          transfer.fromNametag,
          transfer.amountBaseUnits,
          `ProvaDice refund — ${result.reason}`
        );
      } catch (err) {
        console.error('Refund failed for rejected bet:', err);
      }
    }
  });

  // Check for any unresolved rounds from before restart
  await recoverFromRestart();

  // Start the first round
  await tickClock();
}

/**
 * Recover unresolved rounds from a previous server instance
 */
async function recoverFromRestart(): Promise<void> {
  const openRounds = await db
    .select()
    .from(rounds)
    .where(sql`status IN ('open', 'settling')`);

  for (const round of openRounds) {
    const now = new Date();
    const endTime = new Date(round.endTime);

    if (now > endTime) {
      // Round expired during downtime — settle or cancel it
      console.log(`[RoundClock] Recovering expired round ${round.roundId}`);
      try {
        await settleRound(round.roundId, sendUCT);
      } catch (err) {
        console.error(`Failed to settle recovered round ${round.roundId}:`, err);
      }
    } else {
      // Round is still within its window — resume it
      currentRoundId = round.roundId;
      console.log(`[RoundClock] Resuming active round ${round.roundId}`);
    }
  }
}

/**
 * Main clock tick — called periodically to check round state
 * Should be called every ~5 seconds from /api/clock
 */
export async function tickClock(): Promise<{ action: string; roundId?: string }> {
  const lockResult = await db.execute(sql`SELECT pg_try_advisory_lock(727271) as locked`);
  const locked = (lockResult as any).rows?.[0]?.locked ?? (lockResult as any)[0]?.locked;
  if (!locked) return { action: 'busy' };
  try {
  const state = await getCurrentRoundState();

  if (!state) {
    // No active round — wait out a 10s cooldown after the last round before opening the next
    const [lastRound] = await getRecentRounds(1);
    if (lastRound) {
      const sinceEnd = Date.now() - new Date(lastRound.endTime).getTime();
      if (sinceEnd < 10_000) {
        return { action: 'cooldown' };
      }
    }

    // No active round — check treasury and open a new one
    const treasury = await checkAndRefillTreasury();

    if (!treasury.sufficient) {
      console.warn('[RoundClock] Treasury low — pausing round creation');
      return { action: 'treasury_low' };
    }

    const newRound = await openNewRound();
    currentRoundId = newRound.roundId;
    console.log(`[RoundClock] Opened new round: ${newRound.roundId}`);
    return { action: 'round_opened', roundId: newRound.roundId };
  }

  currentRoundId = state.roundId;

  if (state.status === 'settling') {
    // Previous settle attempt crashed partway through — retry it
    console.log(`[RoundClock] Retrying stuck settling round ${state.roundId}`);
    try {
      const result = await settleRound(state.roundId, sendUCT);
      currentRoundId = null;
      return { action: result.cancelled ? 'round_cancelled_retry' : 'round_settled_retry', roundId: state.roundId };
    } catch (err) {
      console.error(`Retry settle failed for ${state.roundId}:`, err);
      return { action: 'settle_retry_failed', roundId: state.roundId };
    }
  }

  if (state.status === 'open' && state.timeRemainingMs <= 0) {
    // Round time is up — settle it
    console.log(`[RoundClock] Round ${state.roundId} time up — settling`);
    try {
      const result = await settleRound(state.roundId, sendUCT);
      currentRoundId = null;

      if (result.cancelled) {
        console.log(`[RoundClock] Round ${state.roundId} cancelled (not enough players)`);
        return { action: 'round_cancelled', roundId: state.roundId };
      }

      console.log(`[RoundClock] Round ${state.roundId} settled, winner: ${result.winner}`);
      return { action: 'round_settled', roundId: state.roundId };
    } catch (err) {
      console.error(`Failed to settle round ${state.roundId}:`, err);
      return { action: 'settle_failed', roundId: state.roundId };
    }
  }

return { action: 'round_active', roundId: state.roundId };
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(727271)`);
  }
}

export function getCurrentRoundId(): string | null {
  return currentRoundId;
}

// For use in /api/bet — register a bet that was claimed via frontend
// (This is a fallback for UI-initiated flows; real bets come through subscribeToIncoming)
export async function processManualBet(
  nametag: string,
  amountBaseUnits: bigint,
  txId: string,
  memo: string,
  pickedNumber?: number
): Promise<{ accepted: boolean; reason?: string }> {
  if (!currentRoundId) {
    return { accepted: false, reason: 'No active round' };
  }

  return recordBet(currentRoundId, nametag, amountBaseUnits, txId, memo, pickedNumber);
}
