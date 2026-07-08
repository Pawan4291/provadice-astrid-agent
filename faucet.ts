/**
 * Faucet integration for testnet UCT replenishment
 * Polls balance before each round and calls real faucet if below threshold
 */

import { FAUCET_URL, TREASURY_LOW_THRESHOLD_UCT, UCT_BASE_UNIT, HOUSE_NAMETAG } from './constants.js';
import { appendAuditEntry } from './auditLog.js';
import { getHouseBalance } from './houseWallet.js';

let faucetCooldownUntil = 0;
const FAUCET_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between faucet calls

export interface FaucetCheckResult {
  balanceUCT: number;
  sufficient: boolean;
  faucetCalled: boolean;
  faucetResponse?: string;
}

/**
 * Check treasury balance and call faucet if needed
 * Returns whether balance is sufficient to run a round
 */
export async function checkAndRefillTreasury(): Promise<FaucetCheckResult> {
  let balance: bigint;
  try {
    balance = await getHouseBalance();
  } catch (err) {
    console.error('Failed to get house balance:', err);
    balance = BigInt(0);
  }

  const balanceUCT = Number(balance / UCT_BASE_UNIT);
  const sufficient = balanceUCT >= TREASURY_LOW_THRESHOLD_UCT;

  if (sufficient) {
    return { balanceUCT, sufficient: true, faucetCalled: false };
  }

  // Log treasury low event
  await appendAuditEntry('TREASURY_LOW', {
    balanceUCT,
    thresholdUCT: TREASURY_LOW_THRESHOLD_UCT,
    nametag: HOUSE_NAMETAG,
  });

  // Respect cooldown
  if (Date.now() < faucetCooldownUntil) {
    console.warn(`[Faucet] On cooldown until ${new Date(faucetCooldownUntil).toISOString()}`);
    return { balanceUCT, sufficient: false, faucetCalled: false };
  }

  // Call faucet
  let faucetResponse = '';
  try {
    const resp = await fetch(FAUCET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nametag: HOUSE_NAMETAG,
        network: 'testnet',
      }),
    });

    if (resp.ok) {
      faucetResponse = await resp.text();
      faucetCooldownUntil = Date.now() + FAUCET_COOLDOWN_MS;

      await appendAuditEntry('TREASURY_REFILLED', {
        nametag: HOUSE_NAMETAG,
        response: faucetResponse,
        nextAllowedAt: new Date(faucetCooldownUntil).toISOString(),
      });
   } else {
      faucetResponse = `HTTP ${resp.status}: ${await resp.text()}`;
      console.warn(`[Faucet] Request failed: ${faucetResponse}`);
      faucetCooldownUntil = Date.now() + FAUCET_COOLDOWN_MS; // avoid hammering on failure too
    }
  } catch (err) {
    faucetResponse = err instanceof Error ? err.message : String(err);
    console.error('[Faucet] Request error:', err);
  }

  return { balanceUCT, sufficient: false, faucetCalled: true, faucetResponse };
}
