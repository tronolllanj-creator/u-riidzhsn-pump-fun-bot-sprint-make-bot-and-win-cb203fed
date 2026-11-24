import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  maxAge: number;
  minBuyers: number;
  maxBuyers: number;
  minDevBuy: number;
  maxDevBuy: number;
  minRealSol: number;
  maxRealSol: number;
  minRunupBps: number;
  maxRunupBps: number;
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  maxSellRatioBps: number;
  maxBigSellBps: number;
  skipDevSold: boolean;
  buySlippageBps: number;
  stakeLamports: number;
  minBuyLamports: number;
  maxAdds: number;
  addStepBps: number;
  addDelay: number;
  addLamports: number;
  addMinFlowLamports: number;
  trailArmBps: number;
  trailBps: number;
  slBps: number;
  maxHold: number;
  exitOnDevSell: boolean;
  staleSlots: number;
  exitFlowLamports: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 3,
  minBuyers: 6,
  maxBuyers: 100,
  minDevBuy: 0,
  maxDevBuy: 500000000,
  minRealSol: 3000000000,
  maxRealSol: 30000000000,
  minRunupBps: 20000,
  maxRunupBps: 1000000,
  flowWindow: 10,
  minFlowLamports: 0,
  minRecentBuyers: 3,
  maxSellRatioBps: 10000,
  maxBigSellBps: 10000,
  skipDevSold: true,
  buySlippageBps: 10000,
  stakeLamports: 50000000,
  minBuyLamports: 5000000,
  maxAdds: 3,
  addStepBps: 3000,
  addDelay: 5,
  addLamports: 50000000, // adds the same size as the first buy
  addMinFlowLamports: 0,
  trailArmBps: 1500, // arms once value is 15% above cost
  trailBps: 3500,
  slBps: 1500,
  maxHold: 50000,
  exitOnDevSell: true,
  staleSlots: 1000000,
  exitFlowLamports: 1000000000000
};

interface TradeTick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: string;
}

interface CoinBook {
  mint: Pubkey;
  createSlot: number;
  creator: string;
  createVq: bigint;
  createVt: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<string>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: number;
  devSold: boolean;
  lastTradeSlot: number;
  ticks: TradeTick[];
  buysSent: number;
  spentSent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  done: boolean;
  complete: boolean;
}

interface HeldPosition {
  mint: Pubkey;
  openedSlot: number;
  feesPaid: bigint;
  bestValue: bigint;
  devSoldAtOpen: boolean;
}

export function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt + tokens <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  const net = (gross * (BPS - 125n)) / BPS;
  return net;
}

export function createStrategy(params: Params = DEFAULT_PARAMS) {
  const books = new Map<Pubkey, CoinBook>();
  const held = new Map<Pubkey, HeldPosition>();

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const slot = batch.slot;
      const capsMaxOrders = state.hello.caps.max_orders_per_batch;

      // 1. Ingest events
      for (const ev of batch.events) {
        if (ev.event === 'CreateEvent') {
          if (!books.has(ev.mint)) {
            books.set(ev.mint, {
              mint: ev.mint,
              createSlot: ev.slot,
              creator: ev.creator,
              createVq: BigInt(ev.virtual_quote_reserves),
              createVt: BigInt(ev.virtual_token_reserves),
              devBuy: 0n,
              trades: 0,
              buyers: new Set<string>(),
              bought: 0n,
              soldByOthers: 0n,
              bigSellBps: 0,
              devSold: false,
              lastTradeSlot: ev.slot,
              ticks: [],
              buysSent: 0,
              spentSent: 0n,
              lastBuyVq: BigInt(ev.virtual_quote_reserves),
              lastBuyVt: BigInt(ev.virtual_token_reserves),
              lastBuySlot: ev.slot,
              done: false,
              complete: false
            });
          }
        } else if (ev.event === 'TradeEvent') {
          let b = books.get(ev.mint);
          if (!b) {
            b = {
              mint: ev.mint,
              createSlot: ev.slot,
              creator: ev.user,
              createVq: BigInt(ev.virtual_quote_reserves),
              createVt: BigInt(ev.virtual_token_reserves),
              devBuy: 0n,
              trades: 0,
              buyers: new Set<string>(),
              bought: 0n,
              soldByOthers: 0n,
              bigSellBps: 0,
              devSold: false,
              lastTradeSlot: ev.slot,
              ticks: [],
              buysSent: 0,
              spentSent: 0n,
              lastBuyVq: BigInt(ev.virtual_quote_reserves),
              lastBuyVt: BigInt(ev.virtual_token_reserves),
              lastBuySlot: ev.slot,
              done: false,
              complete: false
            };
            books.set(ev.mint, b);
          }

          b.trades++;
          b.lastTradeSlot = Math.max(b.lastTradeSlot, ev.slot);
          const solVal = BigInt(ev.sol_amount);
          const isNonCreator = ev.user !== b.creator;

          if (ev.is_buy) {
            if (isNonCreator) {
              b.buyers.add(ev.user);
              b.bought += solVal;
            }
            if (ev.slot === b.createSlot && ev.user === b.creator) {
              b.devBuy += solVal;
            }
          } else {
            if (ev.user === b.creator) {
              b.devSold = true;
            } else {
              b.soldByOthers += solVal;
              const prevReal = BigInt(ev.real_quote_reserves) + solVal;
              if (prevReal > 0n) {
                const bpsVal = Number((solVal * BPS) / prevReal);
                if (bpsVal > b.bigSellBps) {
                  b.bigSellBps = bpsVal;
                }
              }
            }
          }

          b.ticks.push({
            slot: ev.slot,
            isBuy: ev.is_buy,
            sol: solVal,
            user: ev.user
          });

          const cutoff = ev.slot - params.flowWindow;
          b.ticks = b.ticks.filter(t => t.slot >= cutoff);
        } else if (ev.event === 'CompleteEvent') {
          const b = books.get(ev.mint);
          if (b) {
            b.complete = true;
            b.done = true;
          }
        }
      }

      // 2. Process fills
      for (const fill of batch.fills) {
        if (fill.client_id && fill.client_id.startsWith('_')) {
          held.delete(fill.mint);
          continue;
        }

        const txFee = BigInt(fill.tx_fee_lamports);
        if (fill.side === 'buy' && fill.status === 'filled') {
          let pos = held.get(fill.mint);
          if (!pos) {
            const b = books.get(fill.mint);
            pos = {
              mint: fill.mint,
              openedSlot: fill.slot,
              feesPaid: txFee,
              bestValue: 0n,
              devSoldAtOpen: b ? b.devSold : false
            };
            held.set(fill.mint, pos);
          } else {
            pos.feesPaid += txFee;
          }
        } else if (fill.side === 'sell' && fill.status === 'filled') {
          const pos = held.get(fill.mint);
          if (pos) {
            pos.feesPaid += txFee;
          }
        }
      }

      // Cleanup orphaned held positions
      for (const [mint, pos] of held.entries()) {
        const hasPosInState = state.positions.has(mint);
        let hasPendingOnMint = false;
        for (const pVal of state.pending.values()) {
          if (pVal.order.mint === mint) {
            hasPendingOnMint = true;
            break;
          }
        }
        if (!hasPosInState && !hasPendingOnMint) {
          held.delete(mint);
        }
      }

      // Helper for flow calculation
      const getFlow = (b: CoinBook) => {
        const cutoff = slot - params.flowWindow;
        let net = 0n;
        const recentBuyersSet = new Set<string>();
        for (const t of b.ticks) {
          if (t.slot >= cutoff) {
            if (t.isBuy) {
              net += t.sol;
              if (t.user !== b.creator) recentBuyersSet.add(t.user);
            } else {
              net -= t.sol;
            }
          }
        }
        return { net, buyersCount: recentBuyersSet.size };
      };

      // 3. Exits first
      for (const [mint, pos] of held.entries()) {
        if (orders.length >= capsMaxOrders) break;

        let pendingSell = false;
        for (const p of state.pending.values()) {
          if (p.order.mint === mint && p.order.side === 'sell') {
            pendingSell = true;
            break;
          }
        }
        if (pendingSell) continue;

        const curve = state.curves.get(mint);
        const mark = batch.marks.find(m => m.mint === mint);
        const vq = mark ? BigInt(mark.virtual_quote_reserves) : (curve ? curve.virtual_quote_reserves : 0n);
        const vt = mark ? BigInt(mark.virtual_token_reserves) : (curve ? curve.virtual_token_reserves : 0n);
        const stPos = state.positions.get(mint);
        const tokenAmount = stPos ? stPos.token_amount : 0n;
        const costLamports = stPos ? stPos.cost_lamports : 0n;

        if (tokenAmount <= 0n || vq <= 0n || vt <= 0n) continue;

        const curVal = sellValue(tokenAmount, vq, vt) - state.txFeeLamports();
        const basis = costLamports + pos.feesPaid;

        if (curVal > pos.bestValue) {
          pos.bestValue = curVal;
        }

        const b = books.get(mint);
        const slLimit = basis - (basis * BigInt(params.slBps)) / BPS;
        const armed = pos.bestValue >= basis + (basis * BigInt(params.trailArmBps)) / BPS;
        const trailLimit = pos.bestValue - (pos.bestValue * BigInt(params.trailBps)) / BPS;

        let shouldExit = false;
        if (curVal <= slLimit) shouldExit = true;
        if (armed && curVal <= trailLimit) shouldExit = true;
        if (slot - pos.openedSlot >= params.maxHold) shouldExit = true;
        if (params.exitOnDevSell && b && b.devSold && !pos.devSoldAtOpen) shouldExit = true;
        if (b && slot - b.lastTradeSlot >= params.staleSlots) shouldExit = true;
        if (b) {
          const f = getFlow(b);
          if (f.net < -BigInt(params.exitFlowLamports)) shouldExit = true;
        }

        if (shouldExit) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: tokenAmount,
            max_slippage_bps: 10000
          });
          if (b) b.done = true;
        }
      }

      // 4. Entries and adds
      for (const [mint, b] of books.entries()) {
        if (orders.length >= capsMaxOrders) break;
        if (b.complete || b.done) continue;

        const curve = state.curves.get(mint);
        if (!curve) continue;

        const mark = batch.marks.find(m => m.mint === mint);
        const vq = mark ? BigInt(mark.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mark ? BigInt(mark.virtual_token_reserves) : curve.virtual_token_reserves;
        const realSol = curve.real_quote_reserves;

        const age = slot - b.createSlot;
        const isFirstBuy = b.buysSent === 0;

        if (isFirstBuy) {
          if (age > params.maxAge || age < 0) continue;
          if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;

          // Filter checks
          if (realSol < BigInt(params.minRealSol) || realSol > BigInt(params.maxRealSol)) continue;
          if (b.devBuy < BigInt(params.minDevBuy) || b.devBuy > BigInt(params.maxDevBuy)) continue;
          if (b.buyers.size < params.minBuyers || b.buyers.size > params.maxBuyers) continue;

          if (b.bought > 0n) {
            const maxSoldAllowed = (b.bought * BigInt(params.maxSellRatioBps)) / BPS;
            if (b.soldByOthers > maxSoldAllowed) continue;
          }

          if (b.bigSellBps > params.maxBigSellBps) continue;

          if (b.createVt > 0n && vt > 0n && b.createVq > 0n) {
            const runup = (vq * b.createVt * BPS) / (vt * b.createVq);
            if (runup < BigInt(params.minRunupBps) || runup > BigInt(params.maxRunupBps)) continue;
          } else {
            continue;
          }

          const f = getFlow(b);
          if (f.net < BigInt(params.minFlowLamports)) continue;
          if (f.buyersCount < params.minRecentBuyers) continue;

          if (b.devSold && params.skipDevSold) {
            b.done = true;
            continue;
          }

          const buyAmt = Math.min(params.stakeLamports, Number(state.maxBuyLamports(mint)));
          if (buyAmt < params.minBuyLamports) continue;

          const txFee = state.txFeeLamports();
          if (state.freeCashLamports() < BigInt(buyAmt) + txFee) continue;

          b.buysSent++;
          b.spentSent += BigInt(buyAmt);
          b.lastBuyVq = vq;
          b.lastBuyVt = vt;
          b.lastBuySlot = slot;

          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(buyAmt),
            max_slippage_bps: params.buySlippageBps
          });
        } else {
          // Add buy checks
          if (b.buysSent < 1 || b.buysSent > params.maxAdds) continue;
          const hasPos = state.positions.has(mint);
          if (!hasPos) continue;

          let hasPending = false;
          for (const p of state.pending.values()) {
            if (p.order.mint === mint) {
              hasPending = true;
              break;
            }
          }
          if (hasPending) continue;
          if (slot - b.lastBuySlot < params.addDelay) continue;

          if (b.lastBuyVt > 0n && vt > 0n && b.lastBuyVq > 0n) {
            const priceStep = (vq * b.lastBuyVt * BPS) / (vt * b.lastBuyVq);
            if (priceStep < BPS + BigInt(params.addStepBps)) continue;
          } else {
            continue;
          }

          const f = getFlow(b);
          if (f.net < BigInt(params.addMinFlowLamports)) continue;

          const buyAmt = Math.min(params.addLamports, Number(state.maxBuyLamports(mint)));
          if (buyAmt < params.minBuyLamports) continue;

          const txFee = state.txFeeLamports();
          if (state.freeCashLamports() < BigInt(buyAmt) + txFee) continue;

          b.buysSent++;
          b.spentSent += BigInt(buyAmt);
          b.lastBuyVq = vq;
          b.lastBuyVt = vt;
          b.lastBuySlot = slot;

          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(buyAmt),
            max_slippage_bps: params.buySlippageBps
          });
        }
      }

      return orders;
    }
  };
}
