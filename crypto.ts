import { createHash, randomBytes } from 'crypto';

/**
 * SHA-256 hash of a string, returns hex string
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * SHA-256 hash of a Buffer
 */
export function sha256Buffer(input: Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Generate a cryptographically secure 32-byte random seed
 * Returns hex string (64 chars)
 */
export function generateSeed(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Compute commit hash from seed (what's shown before round starts)
 */
export function computeCommitHash(seed: string): string {
  return sha256(`provadice-commit:${seed}`);
}

/**
 * Compute final reveal hash from seed + last tx hash
 * This is the entropy source for winner selection
 */
export function computeRevealHash(seed: string, lastTxHash: string): string {
  return sha256(`provadice-reveal:${seed}:${lastTxHash}`);
}

/**
 * Map a hex hash to a winner index using weighted ranges.
 *
 * Algorithm:
 * 1. Convert finalHash to a BigInt (256-bit number)
 * 2. Mod by totalPot (in base units) to get a value in [0, totalPot)
 * 3. Walk cumulative bet ranges:
 *    - If value < cumulativeBet, that bettor wins
 *    - This gives each bettor probability = bet / totalPot
 *
 * @param finalHash - hex string (64 chars) result of computeRevealHash
 * @param bets - array of { nametag, amountBaseUnits } in stable order
 * @param totalPotBaseUnits - total pot as BigInt
 * @returns winning nametag
 */
export function selectWinner(
  finalHash: string,
  bets: Array<{ nametag: string; amountBaseUnits: bigint }>,
  totalPotBaseUnits: bigint
): string {
  if (bets.length === 0) throw new Error('No bets to select winner from');
  if (totalPotBaseUnits === BigInt(0)) throw new Error('Total pot is zero');

  // Convert hash to BigInt
  const hashBigInt = BigInt('0x' + finalHash);

  // Modulo total pot — maps hash uniformly into [0, totalPot)
  const randomValue = hashBigInt % totalPotBaseUnits;

  // Walk cumulative ranges
  let cumulative = BigInt(0);
  for (const bet of bets) {
    cumulative += bet.amountBaseUnits;
    if (randomValue < cumulative) {
      return bet.nametag;
    }
  }

  // Fallback (should never happen if bets sum == totalPot)
  return bets[bets.length - 1].nametag;
}

/**
 * Compute an Astrid-style audit hash
 */
export function computeAuditHash(
  prevHash: string,
  timestamp: string,
  eventType: string,
  data: unknown
): string {
  const payload = prevHash + timestamp + eventType + JSON.stringify(data);
  return sha256(payload);
}
