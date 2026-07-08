import { pgTable, text, bigint, integer, timestamp, boolean, jsonb, serial } from 'drizzle-orm/pg-core';

// Rounds table - tracks each 60-second game round
export const rounds = pgTable('rounds', {
  id: serial('id').primaryKey(),
  roundId: text('round_id').notNull().unique(),
  status: text('status').notNull().default('open'), // open | settling | settled | cancelled
  startTime: timestamp('start_time').notNull().defaultNow(),
  endTime: timestamp('end_time').notNull(),
  commitHash: text('commit_hash').notNull(),
  revealSeed: text('reveal_seed'),
  finalHash: text('final_hash'),
 winnerNametag: text('winner_nametag'),
  winningNumber: integer('winning_number'),
  totalPotBaseUnits: text('total_pot_base_units').notNull().default('0'),
  payoutTxId: text('payout_tx_id'),
  playerCount: integer('player_count').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Bets table - each confirmed incoming transfer for a round
export const bets = pgTable('bets', {
  id: serial('id').primaryKey(),
  roundId: text('round_id').notNull(),
  nametag: text('nametag').notNull(),
  amountBaseUnits: text('amount_base_units').notNull(),
  txId: text('tx_id').notNull().unique(),
  pickedNumber: integer('picked_number'),
  confirmedAt: timestamp('confirmed_at').notNull().defaultNow(),
  refunded: boolean('refunded').notNull().default(false),
  refundTxId: text('refund_tx_id'),
  memo: text('memo'),
});

// Audit log table - Astrid-compatible hash-chained audit entries
export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  prevHash: text('prev_hash').notNull(),
  timestamp: text('timestamp').notNull(),
  eventType: text('event_type').notNull(),
  data: jsonb('data').notNull(),
  hash: text('hash').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Leaderboard cache (computed from audit events, never manually set)
export const leaderboardCache = pgTable('leaderboard_cache', {
  id: serial('id').primaryKey(),
  nametag: text('nametag').notNull().unique(),
  totalWins: integer('total_wins').notNull().default(0),
  totalWonBaseUnits: text('total_won_base_units').notNull().default('0'),
  totalBetsPlaced: integer('total_bets_placed').notNull().default(0),
  totalBetBaseUnits: text('total_bet_base_units').notNull().default('0'),
  lastWinAt: timestamp('last_win_at'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
