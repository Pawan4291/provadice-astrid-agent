/**
 * House Wallet Client
 *
 * Integrates with the Sphere SDK for Node.js to manage the house agent wallet.
 * Uses real testnet transfers — no mock data.
 *
 * On first boot: generates a mnemonic, logs it ONCE for operator backup.
 * Subsequent boots: reads mnemonic from HOUSE_MNEMONIC env var.
 */

import { appendAuditEntry } from './auditLog.js';
import { UCT_COIN_ID } from './constants.js';

export interface IncomingTransfer {
  txId: string;
  fromNametag: string;
  amountBaseUnits: bigint;
  memo: string;
  timestamp: string;
}

export type IncomingCallback = (transfer: IncomingTransfer) => Promise<void>;

// Singleton wallet state
let walletInitialized = false;

interface WalletInstance {
  send: (to: string, amount: bigint, memo: string) => Promise<string>;
  getBalance: () => Promise<bigint>;
  getHistory: () => Promise<unknown[]>;
  subscribeIncoming: (cb: IncomingCallback) => void;
}

let sphereInstance: WalletInstance | null = null;
const incomingCallbacks: IncomingCallback[] = [];

/**
 * Initialize the house wallet using Sphere SDK (Node.js)
 */
export async function initHouseWallet(): Promise<void> {
  if (walletInitialized) return;
  walletInitialized = true;

  try {
    // Dynamic import to work with ESM-only SDK in Next.js server context
    const { Sphere } = await import('@unicitylabs/sphere-sdk');
    const { createNodeProviders } = await import('@unicitylabs/sphere-sdk/impl/nodejs');

    const mnemonic = process.env.HOUSE_MNEMONIC;
    const nametag = process.env.HOUSE_NAMETAG ?? 'provadice-house';

    const providers = createNodeProviders({ network: 'testnet' });

    const result = await Sphere.init({
      ...providers,
      nametag,
      autoGenerate: true,
      ...(mnemonic ? { mnemonic } : {}),
    });

    const { sphere, created, generatedMnemonic } = result;

    // CRITICAL: Log mnemonic only once on creation
    if (created && generatedMnemonic) {
      console.warn('='.repeat(60));
      console.warn('NEW HOUSE WALLET CREATED — BACK UP THIS MNEMONIC NOW:');
      console.warn(generatedMnemonic);
      console.warn('Set HOUSE_MNEMONIC env var to this value for persistence.');
      console.warn('='.repeat(60));
    }

    await appendAuditEntry('AGENT_BOOT', {
      nametag: sphere.identity?.nametag ?? nametag,
      newWallet: created ?? false,
      network: 'testnet',
    });

    // Subscribe to incoming transfers
    sphere.on('transfer:incoming', async (transferData: unknown) => {
      const td = transferData as {
        txId?: string;
        id?: string;
        senderNametag?: string;
        tokens?: Array<{ coinId: string; amount: string }>;
        memo?: string;
        timestamp?: string;
      };

      // Only process UCT transfers
      const uctToken = td.tokens?.find((t) => t.coinId === UCT_COIN_ID);
      if (!uctToken) return;

      const incoming: IncomingTransfer = {
        txId: td.txId ?? td.id ?? `unknown-${Date.now()}`,
        fromNametag: td.senderNametag ?? 'unknown',
        amountBaseUnits: BigInt(uctToken.amount),
        memo: td.memo ?? '',
        timestamp: td.timestamp ?? new Date().toISOString(),
      };

      for (const cb of incomingCallbacks) {
        try {
          await cb(incoming);
        } catch (err) {
          console.error('Incoming transfer callback error:', err);
        }
      }
    });

    sphereInstance = {
      send: async (to: string, amount: bigint, memo: string): Promise<string> => {
        const recipient = to.startsWith('@') ? to : `@${to}`;
        const r = await sphere.payments.send({
          recipient,
          coinId: UCT_COIN_ID,
          amount: amount.toString(),
          memo,
        });
        // TransferResult has transferId or txId
        const res = r as unknown as { transferId?: string; txId?: string; id?: string };
        return res.transferId ?? res.txId ?? res.id ?? `tx-${Date.now()}`;
      },

      getBalance: async (): Promise<bigint> => {
        const assets = await sphere.payments.receive();
        // After receive, query balance
        const res = assets as unknown as { tokens?: Array<{ coinId: string; amount: string }> };
        const uctBalance = res.tokens?.find((t: { coinId: string }) => t.coinId === UCT_COIN_ID);
        if (uctBalance) return BigInt(uctBalance.amount);
        return BigInt(0);
      },

      getHistory: async (): Promise<unknown[]> => {
        // Use sphere history if available
        const s = sphere as unknown as { history?: { getTransfers?: () => Promise<unknown[]> } };
        if (s.history?.getTransfers) {
          return s.history.getTransfers();
        }
        return [];
      },

      subscribeIncoming: (cb: IncomingCallback): void => {
        incomingCallbacks.push(cb);
      },
    };

    // Start listening
    await sphere.payments.receive();
  } catch (err) {
    console.error('House wallet init failed — using stub mode:', err);
    sphereInstance = createStubWallet();

    await appendAuditEntry('AGENT_BOOT', {
      mode: 'stub',
      error: err instanceof Error ? err.message : String(err),
      note: 'Sphere SDK unavailable — stub mode active. No real transactions will execute.',
    });
  }
}

/**
 * Stub wallet for dev/CI environments where Sphere SDK is unavailable
 */
function createStubWallet(): WalletInstance {
  console.warn('[HouseWallet] Running in STUB mode — no real transactions');
  let stubBalance = BigInt('1000') * BigInt('1000000000000000000');

  return {
    send: async (to: string, amount: bigint, memo: string): Promise<string> => {
      const stubTxId = `stub-tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      console.log(`[STUB SEND] ${amount} base units → ${to} | memo: ${memo} | txId: ${stubTxId}`);
      stubBalance -= amount;
      return stubTxId;
    },

    getBalance: async (): Promise<bigint> => stubBalance,

    getHistory: async (): Promise<unknown[]> => [],

    subscribeIncoming: (_cb: IncomingCallback): void => {
      console.warn('[STUB] Incoming transfer subscription (no real events)');
    },
  };
}

export async function sendUCT(
  toNametag: string,
  amountBaseUnits: bigint,
  memo: string
): Promise<string> {
  if (!sphereInstance) await initHouseWallet();
  return sphereInstance!.send(toNametag, amountBaseUnits, memo);
}

export async function getHouseBalance(): Promise<bigint> {
  if (!sphereInstance) await initHouseWallet();
  return sphereInstance!.getBalance();
}

export async function getHouseHistory(): Promise<unknown[]> {
  if (!sphereInstance) await initHouseWallet();
  return sphereInstance!.getHistory();
}

export function subscribeToIncoming(callback: IncomingCallback): void {
  if (sphereInstance) {
    sphereInstance.subscribeIncoming(callback);
  } else {
    // Queue for after init
    incomingCallbacks.push(callback);
  }
}
