[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/inisejarahabsurd-eng/makefun-agent1-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/inisejarahabsurd-eng/makefun-agent1-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint — Momentum Sniper

A paper-trading bot entry for the **Pump.fun Paper Sprint: Any Bot Can Win** bounty.
One file (`main.ts`), Node 22, zero runtime dependencies, pure strategy.

## Strategy

Short forward windows with unknown start punish clever, overfit strategies and
reward simple, adaptive ones. This entry is deliberately conservative:

1. **Trade little.** Fees and slippage destroy marginal trades, so every entry
   must clear a high bar. One open position at a time, at most 25% of bankroll
   per trade, at most 2 entries per mint ever.
2. **Momentum only.** Enter only when a token shows a clear, sustained uptrend
   (>= +18% over the last 6 ticks, minimum 3 ticks of data) and the most recent
   tick is not itself a dump (>= -8% single-tick drop blocks entry).
3. **Cut losers fast.** Hard stop at -12%, trailing stop giving back at most
   15% from peak.
4. **Take profit quickly.** +35% closes the position; stale positions (25 min,
   no trigger hit) exit on time.
5. **Never re-chase.** A stop-out puts the mint on a 60-second cooldown, and a
   mint can be re-bought at most twice total.

The design goal is a **non-negative floor first, upside second**: a handful of
high-conviction trades with asymmetric exits (small capped loss, larger capped
win) beats dozens of coin-flip trades in a 6-hour window.

## I/O Contract

The bot is harness-agnostic and tolerant of common replay formats.

**Input** — newline-delimited JSON market events, read from `stdin` (or from a
file passed as `argv[2]`):

```json
{"type":"trade","mint":"ABC...","price":0.00012,"ts":1730000000}
{"mint":"ABC...","price_sol":0.00015,"timestamp":1730000060}
{"mint":"ABC...","marketCapSol":45.2,"ts":1730000120}
```

Accepted price field names: `price`, `priceUsd`, `price_sol`, `priceSol`,
`sol_price`, `marketCapSol`, `market_cap_sol`, `marketCap`, `vSol`,
`virtualSolReserve` (and nested under `trade` / `data` / `token` / `swap` /
`event`). Timestamps accept seconds or milliseconds and are normalized.
Unknown fields and unknown event shapes are ignored silently.

**Output** — newline-delimited JSON trades on `stdout`:

```json
{"action":"buy","mint":"ABC...","amountSol":2.5,"reason":"momentum +21.4%/6t","ts":1730000061000}
{"action":"sell","mint":"ABC...","amountSol":3.1,"reason":"take-profit +35.0%","ts":1730000300000}
```

Human-readable diagnostics (final bankroll summary) go to **stderr only**, so
`stdout` is always clean, parseable JSON — one trade per line.

## Running

```bash
# Pipe market data
cat events.jsonl | node --experimental-strip-types main.ts

# Or pass a file
node --experimental-strip-types main.ts events.jsonl

# Type-check
npm run check
```

## Robustness / Edge Cases

- **Never crashes.** Every event is parsed in a try/catch; malformed lines,
  unknown shapes, zero/negative prices, and non-finite numbers are ignored.
  A top-level catch exits 0 with no stack trace on stdout.
- **Timestamp normalization.** Seconds vs milliseconds auto-detected.
- **Duplicate tick suppression.** Same price within 500 ms is ignored so
  momentum math stays meaningful under chatty feeds.
- **Graceful shutdown.** `SIGINT`/`SIGTERM` and stream close flatten any open
  position and emit a window-end sell, so the house never sees dangling state.
- **Array input tolerated.** If the harness emits JSON arrays, elements are
  processed individually.
- **TTY guard.** Running interactively with no input prints a usage hint and
  exits instead of hanging.
- **Bounded memory.** Tick history per mint is capped (64 ticks); maps grow
  only with distinct mints seen.

## Configuration

All knobs live in the `CFG` constant at the top of `main.ts` with comments.
Defaults favor safety: sparse entries, tight losses, generous wins.

## License

MIT.