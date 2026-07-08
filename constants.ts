// ProvaDice — Non-negotiable constants derived from real testnet transfer data
// DO NOT change UCT_COIN_ID or UCT_DECIMALS — confirmed from real transfer

export const UCT_COIN_ID = "f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0";
export const UCT_SYMBOL = "UCT";
export const UCT_DECIMALS = 18; // 1000000000000000000 base units = 1 UCT (confirmed from testnet)
export const UCT_BASE_UNIT = BigInt("1000000000000000000"); // 1e18

export const ROUND_DURATION_MS = 120_000; // 2min fixed round
export const MIN_PLAYERS_PER_ROUND = 1;
export const MAX_PLAYERS_PER_ROUND = 50;
export const HOUSE_FEE_PCT = 0.02; // 2%
export const MAX_BET_PCT_OF_POT = 0.20; // no single user > 20% of pot
export const TREASURY_LOW_THRESHOLD_UCT = 50; // triggers faucet refill + round pause

export const HOUSE_NAMETAG = process.env.HOUSE_NAMETAG ?? 'provadice-house';
export const TESTNET_AGGREGATOR = 'https://goggregator-test.unicity.network/';
export const FAUCET_URL = 'https://faucet.unicity.network/faucet/';
export const SPHERE_WALLET_URL = 'https://sphere.unicity.network/';

// Convert UCT display amount to base units (BigInt)
export function uctToBaseUnits(uct: number): bigint {
  return BigInt(Math.floor(uct * 1e9)) * BigInt(1e9);
}

// Convert base units (string or bigint) to UCT display amount
export function baseUnitsToUct(baseUnits: string | bigint): number {
  const bi = typeof baseUnits === 'string' ? BigInt(baseUnits) : baseUnits;
  // Divide by 1e18
  const whole = bi / UCT_BASE_UNIT;
  const remainder = bi % UCT_BASE_UNIT;
  return Number(whole) + Number(remainder) / 1e18;
}

// Generate a round ID
export function generateRoundId(): string {
  const now = Date.now();
  const rand = Math.floor(Math.random() * 0xFFFF).toString(16).padStart(4, '0');
  return `round-${now}-${rand}`;
}
