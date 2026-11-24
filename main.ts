// TIDE HUNTER
// Bounty slug: u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed
// Design: Momentum-based adaptive liquidity sniper for pump.fun bonding curves

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

async function main() {
  await runBot(createStrategy(DEFAULT_PARAMS)); // TIDE HUNTER runs here
}

main().catch(console.error);
