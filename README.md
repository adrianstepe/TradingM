# Phantom Multi-Wallet Trading Bot

A Telegram bot that lets one authorized user buy a token from selected Solana
wallets and instantly sell a position across every wallet that holds it.
Swaps route through Jupiter's aggregator. Runs locally — nothing is hosted
for you.

## How wallet control actually works

Phantom's own "Connect Wallet" flow is an interactive browser session — it
needs you to approve every transaction by hand, so it can't drive unattended
multi-wallet trades. Instead, this bot holds each wallet's **private key**
directly (encrypted at rest) and signs/sends transactions itself. That's how
every Telegram trading bot (BonkBot, Trojan, etc.) actually works — there is
no way around the bot needing custody of the keys for wallets it trades from.

**Because of that: use dedicated/burner wallets you fund for trading, not a
wallet holding your long-term savings.** If this machine or bot token is ever
compromised, every key it holds is at risk.

## Setup

1. Install [Node.js 18+](https://nodejs.org).
2. `npm install`
3. Copy `.env.example` to `.env` and fill in:
   - `BOT_TOKEN` — create a bot with [@BotFather](https://t.me/BotFather)
   - `OWNER_ID` — your numeric Telegram id from [@userinfobot](https://t.me/userinfobot). The bot ignores everyone else.
   - `MASTER_PASSWORD` — a long random passphrase encrypting stored keys. Generate one:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
   - `RPC_URL` — a Solana RPC endpoint. The public default is rate-limited and unreliable for real trading; get a free key from Helius, QuickNode, or Triton for anything serious.
4. `npm start`

## Using it

- `/addwallet` — bot asks for a private key. In Phantom: Settings → Manage
  Wallets → pick the wallet → **Export Private Key** → paste the base58
  string into the chat. The bot deletes your message immediately after
  reading it (also delete it yourself and clear the chat as a second layer).
- `/wallets` — list wallets with live SOL balances.
- `/removewallet <label>` — forget a wallet (does not move any funds).
- `/setamount <label> <sol>` — set a wallet's Quick Buy size (e.g.
  `/setamount Wallet1 0.04`). `0` excludes that wallet. `/amounts` lists them.
- **To buy:** paste a token's mint address, then either:
  - tap **⚡ Quick Buy** → **Confirm** (two taps) to buy with every wallet at
    its preset size — different amounts per wallet, set once and reused; or
  - type per-wallet amounts in one message, e.g. `1:0.04 2:0.12`, then
    **Confirm** (one tap). The numbers are wallet ids from `/wallets`; only
    the wallets you name are used, so buying the same token again later from
    a different wallet is one message plus one tap.
  - **Choose wallets manually** is still there for the same-amount-each case.
- `/positions` — shows every tracked token with a **Sell ALL (all wallets)**
  button that instantly sells that token's full balance from every wallet
  holding it, concurrently. Proceeds land as SOL in each wallet that sold —
  it never routes to another token.
- `/sellall` — panic button: sells every tracked position from every wallet
  right now.

## Notes and limits

- Slippage is set via `BUY_SLIPPAGE_BPS` / `SELL_SLIPPAGE_BPS` in `.env` and
  used as a cap for Jupiter's dynamic slippage (it computes the slippage
  actually needed from live conditions, up to that cap, rather than always
  spending the full allowance). Whatever the cap is, it's also the most a
  sandwich bot could extract from a single trade — keep it as tight as you
  can tolerate.
- Position tracking is a local ledger (`data/store.json`) used to know what to
  list under `/positions`; sells always re-check the wallet's actual on-chain
  token balance before selling, so it won't try to sell more than the wallet
  holds.
- **`data/store.json` holds your encrypted wallet keys and the encryption
  salt.** Deleting it means re-adding every wallet with `/addwallet` (funds
  are unaffected — the keys originate in Phantom). Back it up alongside your
  `MASTER_PASSWORD`; either one alone is useless.
- Failed swaps are retried up to 3 times with a fresh quote each attempt.
  Transient causes (expired blockhash, slippage, RPC rate limits, network
  drops) retry; permanent ones (insufficient funds, no route) fail fast
  rather than burning fees. Every wallet is reported individually, so a
  partial failure is never silently reported as success.
- No stop-loss / take-profit automation, price alerts, or charting — this is
  a manual-trigger buy/sell control panel, not an autotrader.
- `data/` and `.env` are gitignored; never commit them.
