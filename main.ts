/**
 * Pump.fun Paper Sprint — Momentum Sniper
 *
 * Strategy: sparse, high-conviction momentum entries with hard stops
 * and quick take-profits. Trade little; fees and slippage kill marginal
 * trades. One position at a time. Cut losers fast.
 *
 * I/O contract (defensive, tolerant of every reasonable house harness):
 *  - Reads market events as newline-delimited JSON on stdin, or from a
 *    file given as argv[2], or (if neither) idles gracefully.
 *  - Emits trades as newline-delimited JSON on stdout:
 *      { "action": "buy" | "sell", "mint": string, "amountSol": number,
 *        "reason": string, "ts": number }
 *  - Never throws. Never writes non-JSON to stdout. Flushes every line.
 *
 * Recognized event shapes (union of common harness formats):
 *  { type: "new_token" | "token" | "trade" | "tick" | "price", mint, ... }
 *  { mint, price | priceUsd | price_sol | marketCapSol, ts | timestamp | time }
 * Unknown fields ignored; unknown event types ignored.
 */

import * as readline from "node:readline";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const CFG = {
  startSol: 10, // notional paper bankroll for sizing math
  maxPctPerTrade: 0.25, // risk at most 25% of bankroll per entry
  minPctPerTrade: 0.05,
  maxOpenPositions: 1, // one at a time: focus, no death by a thousand cuts
  takeProfitPct: 0.35, // +35% -> take profit
  stopLossPct: -0.12, // -12% -> hard stop, no hesitation
  trailingStopPct: 0.15, // give back max 15% from peak
  maxHoldMs: 25 * 60 * 1000, // stale momentum: exit after 25 minutes
  entryMomentumPct: 0.18, // need +18% over lookback to enter
  entryMinAgeMs: 20 * 1000, // skip first seconds (snipe bots, insta-dumps)
  entryMaxAgeMs: 3 * 60 * 60 * 1000, // skip very old tokens
  lookbackTicks: 6, // momentum measured over this many ticks
  minTicks: 3,
  cooldownMs: 60 * 1000, // after a stop-out, cool down before re-entry
  maxRebuysPerMint: 2, // never chase a coin repeatedly
  feePct: 0.01, // assume ~1% round-trip friction; require edge above it
  dumpGuardPct: -0.08, // last tick dropped >8%: don't buy into a dump
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

interface Tick {
  price: number;
  ts: number;
}

interface Position {
  mint: string;
  entryPrice: number;
  entryTs: number;
  sizeSol: number;
  peakPrice: number;
  reason: string;
}

const ticksByMint = new Map<string, Tick[]>();
const firstSeen = new Map<string, number>();
const lastTick = new Map<string, Tick>();
const rebuyCount = new Map<string, number>();
const cooldownUntil = new Map<string, number>();

let bankroll = CFG.startSol;
const positions = new Map<string, Position>();
let lastTradeTs = 0;

let outStream: NodeJS.WritableStream = process.stdout;

function emit(action: "buy" | "sell", mint: string, amountSol: number, reason: string, ts: number): void {
  const line = JSON.stringify({ action, mint, amountSol: round6(amountSol), reason, ts });
  try {
    outStream.write(line + "\n");
  } catch {
    /* stdout gone — keep running, nothing else we can do */
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function safeNum(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : NaN;
}

function pickNum(obj: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const n = safeNum(obj[k]);
    if (!Number.isNaN(n)) return n;
  }
  return NaN;
}

function pickTs(obj: Record<string, unknown>): number {
  const n = pickNum(obj, ["ts", "timestamp", "time", "t", "blockTime"]);
  if (!Number.isNaN(n)) {
    // Heuristic: seconds vs ms. Pump.fun timestamps are seconds.
    return n < 1e12 ? n * 1000 : n;
  }
  return Date.now();
}

function pickMint(obj: Record<string, unknown>): string | null {
  for (const k of ["mint", "mintAddress", "address", "token", "tokenMint", "symbol", "id"]) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Core strategy                                                       */
/* ------------------------------------------------------------------ */

function recordTick(mint: string, price: number, ts: number): void {
  if (!firstSeen.has(mint)) firstSeen.set(mint, ts);
  let arr = ticksByMint.get(mint);
  if (!arr) {
    arr = [];
    ticksByMint.set(mint, arr);
  }
  const last = arr[arr.length - 1];
  // Ignore zero-move duplicates to keep momentum math meaningful.
  if (last && last.price === price && ts - last.ts < 500) return;
  arr.push({ price, ts });
  if (arr.length > 64) arr.shift();
  lastTick.set(mint, { price, ts });
}

function momentum(mint: string): { pct: number; ticks: number; lastDropPct: number } {
  const arr = ticksByMint.get(mint) ?? [];
  if (arr.length < 2) return { pct: 0, ticks: arr.length, lastDropPct: 0 };
  const n = Math.min(CFG.lookbackTicks, arr.length);
  const first = arr[arr.length - n].price;
  const lastPrice = arr[arr.length - 1].price;
  const prev = arr[arr.length - 2].price;
  const pct = (lastPrice - first) / first;
  const lastDropPct = (lastPrice - prev) / prev;
  return { pct, ticks: arr.length, lastDropPct };
}

function positionSize(): number {
  const pct = Math.max(CFG.minPctPerTrade, Math.min(CFG.maxPctPerTrade, CFG.maxPctPerTrade));
  const size = bankroll * pct;
  return Math.max(0.01, Math.min(size, bankroll * 0.5, CFG.startSol * 0.5));
}

function tryEnter(mint: string, price: number, ts: number): void {
  if (positions.size >= CFG.maxOpenPositions) return;
  if (positions.has(mint)) return;
  if ((rebuyCount.get(mint) ?? 0) >= CFG.maxRebuysPerMint) return;
  const cd = cooldownUntil.get(mint) ?? 0;
  if (ts < cd) return;

  const age = ts - (firstSeen.get(mint) ?? ts);
  if (age < CFG.entryMinAgeMs || age > CFG.entryMaxAgeMs) return;

  const m = momentum(mint);
  if (m.ticks < CFG.minTicks) return;
  // Momentum gate: clear uptrend only, and last tick not a dump.
  if (m.pct < CFG.entryMomentumPct || m.lastDropPct < CFG.dumpGuardPct) return;

  // Friction gate: expected move must clear fees/slippage with margin.
  if (m.pct < CFG.feePct * 4) return;

  const size = positionSize();
  if (size < 0.01 || size > bankroll) return;

  positions.set(mint, {
    mint,
    entryPrice: price,
    entryTs: ts,
    sizeSol: size,
    peakPrice: price,
    reason: `momentum +${(m.pct * 100).toFixed(1)}%/${CFG.lookbackTicks}t`,
  });
  bankroll -= size;
  rebuyCount.set(mint, (rebuyCount.get(mint) ?? 0) + 1);
  lastTradeTs = ts;
  emit("buy", mint, size, positions.get(mint)!.reason, ts);
}

function tryExit(pos: Position, price: number, ts: number): void {
  pos.peakPrice = Math.max(pos.peakPrice, price);
  const pnlPct = (price - pos.entryPrice) / pos.entryPrice;
  const trailFromPeak = (price - pos.peakPrice) / pos.peakPrice;
  const held = ts - pos.entryTs;

  let reason: string | null = null;
  if (pnlPct >= CFG.takeProfitPct) reason = `take-profit +${(pnlPct * 100).toFixed(1)}%`;
  else if (pnlPct <= CFG.stopLossPct) reason = `stop-loss ${(pnlPct * 100).toFixed(1)}%`;
  else if (trailFromPeak <= -CFG.trailingStopPct) reason = `trailing-stop ${(trailFromPeak * 100).toFixed(1)}% from peak`;
  else if (held > CFG.maxHoldMs) reason = `time-exit ${Math.round(held / 60000)}m, pnl ${(pnlPct * 100).toFixed(1)}%`;

  if (!reason) return;

  const proceeds = pos.sizeSol * (1 + pnlPct) * (1 - CFG.feePct);
  bankroll += Math.max(0, proceeds);
  positions.delete(pos.mint);
  lastTradeTs = ts;

  // Stop-outs cool the mint down so we don't immediately re-chase.
  if (pnlPct < 0) cooldownUntil.set(pos.mint, ts + CFG.cooldownMs);

  emit("sell", pos.mint, Math.max(0, proceeds), reason, ts);
}

function onTick(mint: string, price: number, ts: number): void {
  recordTick(mint, price, ts);
  const pos = positions.get(mint);
  if (pos) tryExit(pos, price, ts);
  else tryEnter(mint, price, ts);
}

/* ------------------------------------------------------------------ */
/* Event dispatch                                                      */
/* ------------------------------------------------------------------ */

function handleEvent(raw: string): void {
  const s = raw.trim();
  if (!s || s === "[" || s === "]" || s === "," || s === "null") return;
  let ev: Record<string, unknown>;
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === "object") handleEvent(JSON.stringify(item));
      }
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    ev = parsed as Record<string, unknown>;
  } catch {
    return; // malformed line: ignore, never crash
  }

  const mint = pickMint(ev);
  if (!mint) return;

  // Nested payloads (e.g. { trade: {...} } or { data: {...} }).
  let inner: Record<string, unknown> | null = null;
  for (const k of ["trade", "data", "token", "swap", "event"]) {
    const v = ev[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      inner = v as Record<string, unknown>;
      break;
    }
  }
  const merged = inner ? { ...ev, ...inner } : ev;

  const price = pickNum(merged, [
    "price", "priceUsd", "price_sol", "priceSol", "sol_price",
    "marketCapSol", "market_cap_sol", "marketCap", "usd_market_cap", "vSol", "virtualSolReserve",
  ]);
  if (Number.isNaN(price)) return;

  const ts = pickTs(merged);
  try {
    onTick(mint, price, ts);
  } catch {
    /* defensive: strategy bugs must never kill the process */
  }
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

function endOfWindow(): void {
  // If time runs out with an open position, close it (any exit beats none).
  const now = Date.now();
  for (const pos of Array.from(positions.values())) {
    const proceeds = pos.sizeSol * (1 + CFG.feePct * -1);
    bankroll += Math.max(0, proceeds);
    positions.delete(pos.mint);
    emit("sell", pos.mint, Math.max(0, proceeds), "window-end flatten", now);
  }
  // Final summary on stderr so stdout stays clean JSON.
  process.stderr.write(
    JSON.stringify({ summary: "done", bankroll: round6(bankroll), openPositions: positions.size }) + "\n"
  );
}

async function main(): Promise<void> {
  // Optional file input: node main.ts events.jsonl
  const filePath = process.argv[2];
  let input: NodeJS.ReadableStream = process.stdin;

  if (filePath) {
    const fs = await import("node:fs");
    if (fs.existsSync(filePath)) {
      input = fs.createReadStream(filePath, { encoding: "utf8" });
    }
    // Missing file: fall through to stdin; if stdin is a TTY there is
    // simply no data and we exit cleanly below.
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  rl.on("line", handleEvent);
  rl.on("close", endOfWindow);
  rl.on("error", () => endOfWindow());

  process.on("SIGINT", () => {
    endOfWindow();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    endOfWindow();
    process.exit(0);
  });

  // Safety: if input never closes and nothing has happened for a long
  // time, keep waiting — the house owns the window lifecycle. But if
  // stdin is a TTY (manual run), exit immediately with a hint.
  if (!filePath && process.stdin.isTTY) {
    process.stderr.write("No input. Pipe NDJSON market events to stdin or pass a file: node main.ts events.jsonl\n");
    process.exit(0);
  }
}

main().catch(() => {
  // Absolute last resort: never crash with a stack trace on stdout.
  process.exit(0);
});