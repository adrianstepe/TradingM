import { Telegraf, Markup } from "telegraf";
import {
  addWallet,
  listWallets,
  getWallet,
  getWalletById,
  getKeypairFor,
  removeWallet,
  setWalletAmount,
  parseSecretKey,
  nextAutoLabel,
} from "./wallets.js";
import { getSolBalance, getTokenBalance, getMintDecimals, isLikelyMint } from "./solana.js";
import { getTokenInfo, SOL_MINT } from "./jupiter.js";
import { executeSwap } from "./swap.js";
import { recordBuy, clearPosition, getPositionsGroupedByMint } from "./positions.js";
import { 
  startPumpFunSniper, 
  stopPumpFunSniper, 
  isSniperRunning,
  getSnipedTokens,
  cancelAutoSell 
} from "./pumpfun-snipe.js";

const OWNER_ID = Number(process.env.OWNER_ID);
const BUY_SLIPPAGE_BPS = Number(process.env.BUY_SLIPPAGE_BPS || 2500);
const SELL_SLIPPAGE_BPS = Number(process.env.SELL_SLIPPAGE_BPS || 4200);
const QUICK_AMOUNTS = [0.05, 0.1, 0.25, 0.5, 1, 2];

// Headroom left unspent per buy for the base fee, priority fee, and the ~0.002
// SOL rent deposit charged the first time a wallet holds a given token.
const FEE_RESERVE_SOL = 0.01;

const bot = new Telegraf(process.env.BOT_TOKEN);

// Single-owner session state, keyed by chat id.
const sessions = new Map();
function session(ctx) {
  const id = ctx.chat.id;
  if (!sessions.has(id)) sessions.set(id, { mode: null, pendingBuy: null });
  return sessions.get(id);
}

const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== "private" || ctx.from?.id !== OWNER_ID) return;
  return next();
});

bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  ctx.reply(`⚠️ Error: ${err.message || err}`).catch(() => {});
});

bot.start((ctx) =>
  ctx.reply(
    "Phantom multi-wallet trading bot.\n\n" +
      "⚠️ Adding a wallet here means this bot process holds its private key " +
      "in encrypted local storage and can move funds without further confirmation " +
      "beyond what you approve in chat. Use dedicated/burner wallets, not your main savings.\n\n" +
      "Commands:\n" +
      "/addwallet — add a wallet by pasting its private key\n" +
      "/wallets — list wallets and SOL balances\n" +
      "/removewallet <label> — forget a wallet (does not move funds)\n" +
      "/amounts — show each wallet's Quick Buy size\n" +
      "/setamount <label> <sol> — set one wallet's Quick Buy size\n" +
      "/positions — show tracked token positions, with one-tap Sell All\n" +
      "/sellall — instantly sell every tracked position, every wallet\n\n" +
      "🎯 Sniper Commands:\n" +
      "/snipestart — start auto-buying your pump.fun launches\n" +
      "/snipestop — stop the sniper\n" +
      "/snipestatus — check sniper status and sniped tokens\n" +
      "/cancelsell <mint> — cancel scheduled auto-sell\n\n" +
      "To buy: paste a token mint address, then either tap ⚡ Quick Buy " +
      "(uses each wallet's preset) or type per-wallet amounts like `1:0.04 2:0.12`.\n" +
      "Selling always converts the full token balance back to SOL."
  )
);

bot.command("addwallet", (ctx) => {
  session(ctx).mode = "awaiting_privkey";
  return ctx.reply(
    "Send the wallet's private key (base58, from Phantom: Settings → " +
      "Manage Wallets → select wallet → Export Private Key).\n\n" +
      "I'll delete your message immediately after reading it — but please also " +
      "delete it yourself and clear this chat afterward as a precaution."
  );
});

bot.command("wallets", async (ctx) => {
  const wallets = listWallets();
  if (wallets.length === 0) return ctx.reply("No wallets added yet. Use /addwallet.");
  const lines = await Promise.all(
    wallets.map(async (w) => {
      let bal = "?";
      try {
        bal = (await getSolBalance(w.pubkey)).toFixed(4);
      } catch {}
      return `• ${w.label} — ${shortAddr(w.pubkey)} — ${bal} SOL`;
    })
  );
  ctx.reply(lines.join("\n"));
});

bot.command("removewallet", (ctx) => {
  const label = ctx.message.text.split(/\s+/)[1];
  if (!label) return ctx.reply("Usage: /removewallet <label>");
  const row = getWallet(label);
  if (!row) return ctx.reply(`No wallet named "${label}".`);
  removeWallet(label);
  ctx.reply(
    `Forgot wallet "${label}" (${shortAddr(row.pubkey)}). This did not move any funds — ` +
      "transfer them out separately if needed."
  );
});

bot.command("amounts", (ctx) => {
  const wallets = listWallets();
  if (wallets.length === 0) return ctx.reply("No wallets yet. Use /addwallet.");
  const lines = wallets.map(
    (w) => `• ${w.label} (id ${w.id}) — ${w.defaultBuySol ? `${w.defaultBuySol} SOL` : "not set"}`
  );
  const total = wallets.reduce((sum, w) => sum + (w.defaultBuySol || 0), 0);
  ctx.reply(
    `Quick Buy amounts:\n${lines.join("\n")}\n\nTotal per Quick Buy: ${total} SOL\n\n` +
      "Change one with: /setamount <label> <sol>   (0 to exclude)"
  );
});

bot.command("setamount", (ctx) => {
  const [, label, raw] = ctx.message.text.split(/\s+/);
  if (!label || raw === undefined) {
    return ctx.reply("Usage: /setamount <label> <sol>\nExample: /setamount Wallet1 0.04");
  }
  const sol = Number(raw.replace(",", "."));
  if (!Number.isFinite(sol) || sol < 0) return ctx.reply("That's not a valid SOL amount.");
  if (!setWalletAmount(label, sol)) return ctx.reply(`No wallet named "${label}".`);
  ctx.reply(sol > 0 ? `${label} → ${sol} SOL per Quick Buy.` : `${label} excluded from Quick Buy.`);
});

bot.command("positions", async (ctx) => {
  const groups = getPositionsGroupedByMint();
  if (groups.length === 0) return ctx.reply("No tracked positions.");
  for (const g of groups) {
    const info = await getTokenInfo(g.mint);
    // Positions recorded before decimals were read on-chain may have stored 0.
    const decimals = g.decimals || info.decimals || (await getMintDecimals(g.mint));
    const ui = Number(g.totalRaw) / 10 ** decimals;
    const label = g.symbol || info.symbol || shortAddr(g.mint);
    await ctx.reply(
      `${label} — ${ui.toLocaleString()} across ${g.wallets.length} wallet(s)\n${g.mint}`,
      Markup.inlineKeyboard([Markup.button.callback("🔴 Sell ALL (all wallets)", `sell:${g.mint}`)])
    );
  }
});

bot.command("sellall", async (ctx) => {
  const groups = getPositionsGroupedByMint();
  if (groups.length === 0) return ctx.reply("No tracked positions to sell.");
  await ctx.reply(`Panic-selling ${groups.length} token(s) across all wallets...`);
  for (const g of groups) {
    await sellMintAcrossWallets(ctx, g.mint);
  }
});

// Pump.fun Sniper Commands
bot.command("snipestart", (ctx) => {
  if (isSniperRunning()) {
    return ctx.reply("🎯 Sniper is already running.");
  }
  
  if (!process.env.PUMPFUN_DEV_WALLET) {
    return ctx.reply("❌ PUMPFUN_DEV_WALLET not set in .env");
  }
  
  startPumpFunSniper((msg) => ctx.reply(msg));
  ctx.reply(
    "🎯 Pump.fun Sniper STARTED\n\n" +
    `Monitoring dev wallet: ${process.env.PUMPFUN_DEV_WALLET.slice(0, 12)}...\n` +
    `Auto-buy wallets: ${process.env.PUMPFUN_BOT_WALLET_IDS || "2,3,4,5"}\n` +
    `Buy amount: ${process.env.PUMPFUN_BUY_AMOUNT_SOL || 0.05} SOL per wallet\n\n` +
    "I'll notify you instantly when a new token is detected and bought."
  );
});

bot.command("snipestop", (ctx) => {
  if (!isSniperRunning()) {
    return ctx.reply("Sniper is not running.");
  }
  stopPumpFunSniper();
  ctx.reply("🛑 Sniper stopped.");
});

bot.command("snipestatus", (ctx) => {
  const running = isSniperRunning();
  const sniped = getSnipedTokens();
  
  ctx.reply(
    `🎯 Sniper Status: ${running ? "RUNNING ✅" : "STOPPED ❌"}\n\n` +
    `Dev Wallet: ${process.env.PUMPFUN_DEV_WALLET?.slice(0, 16) || "Not set"}...\n` +
    `Bot Wallets: ${process.env.PUMPFUN_BOT_WALLET_IDS || "2,3,4,5"}\n` +
    `Buy Amount: ${process.env.PUMPFUN_BUY_AMOUNT_SOL || 0.05} SOL\n` +
    `Auto-sell: ${process.env.PUMPFUN_AUTO_SELL === "true" ? "ENABLED" : "disabled"}\n\n` +
    `Tokens sniped this session: ${sniped.length}\n` +
    (sniped.length > 0 ? sniped.slice(-5).map(m => `• ${m.slice(0, 8)}...`).join("\n") : "")
  );
});

bot.command("cancelsell", (ctx) => {
  const mint = ctx.message.text.split(/\s+/)[1];
  if (!mint) return ctx.reply("Usage: /cancelsell <mint_address>");
  
  if (cancelAutoSell(mint)) {
    ctx.reply(`⏱️ Auto-sell cancelled for ${mint.slice(0, 8)}...`);
  } else {
    ctx.reply("No auto-sell scheduled for that token.");
  }
});

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery().catch(() => {});

  if (data.startsWith("sell:")) {
    const mint = data.slice("sell:".length);
    return sellMintAcrossWallets(ctx, mint);
  }

  const s = session(ctx);

  if (data === "bcancel") {
    s.pendingBuy = null;
    s.mode = null;
    return ctx.editMessageText("Cancelled.");
  }

  // One tap: load every wallet's configured default amount.
  if (data === "bquick") {
    if (!s.pendingBuy) return;
    const withDefaults = listWallets().filter((w) => w.defaultBuySol > 0);
    if (withDefaults.length === 0) {
      return ctx.reply("No Quick Buy amounts set yet. Use /setamount <label> <sol>.");
    }
    s.pendingBuy.amounts = new Map(withDefaults.map((w) => [w.id, w.defaultBuySol]));
    return showBuyConfirmation(ctx, s);
  }

  if (data === "bmanual") {
    if (!s.pendingBuy) return;
    return ctx.editMessageText("Select wallet(s):", walletSelectKeyboard(s.pendingBuy));
  }

  if (data.startsWith("bw:")) {
    if (!s.pendingBuy) return;
    const rest = data.slice("bw:".length);
    if (rest === "all") {
      const wallets = listWallets();
      const allSelected = wallets.every((w) => s.pendingBuy.selected.has(w.id));
      if (allSelected) s.pendingBuy.selected.clear();
      else wallets.forEach((w) => s.pendingBuy.selected.add(w.id));
    } else {
      const id = Number(rest);
      if (s.pendingBuy.selected.has(id)) s.pendingBuy.selected.delete(id);
      else s.pendingBuy.selected.add(id);
    }
    return ctx.editMessageReplyMarkup(walletSelectKeyboard(s.pendingBuy).reply_markup);
  }

  if (data === "bcontinue") {
    if (!s.pendingBuy || s.pendingBuy.selected.size === 0) {
      return ctx.reply("Select at least one wallet first.");
    }
    return ctx.editMessageText("Amount to spend from EACH selected wallet:", amountKeyboard());
  }

  if (data.startsWith("bamt:")) {
    if (!s.pendingBuy) return;
    const val = data.slice("bamt:".length);
    if (val === "custom") {
      s.mode = "awaiting_custom_amount";
      return ctx.editMessageText("Send the SOL amount to spend per wallet (e.g. 0.3):");
    }
    applyUniformAmount(s.pendingBuy, Number(val));
    return showBuyConfirmation(ctx, s);
  }

  if (data === "bconfirm") {
    if (!s.pendingBuy) return;
    return executeBuy(ctx, s);
  }
});

bot.on("text", async (ctx) => {
  const s = session(ctx);
  const text = ctx.message.text.trim();

  if (s.mode === "awaiting_privkey") {
    await ctx.deleteMessage().catch(() => {});
    try {
      const keypair = parseSecretKey(text);
      const label = nextAutoLabel();
      addWallet(label, keypair);
      s.mode = null;
      return ctx.reply(`✅ Added "${label}" — ${shortAddr(keypair.publicKey.toBase58())}`);
    } catch (err) {
      return ctx.reply(`❌ ${err.message}`);
    }
  }

  if (s.mode === "awaiting_custom_amount") {
    const amount = Number(text.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      return ctx.reply("That's not a valid SOL amount. Try again:");
    }
    s.mode = null;
    applyUniformAmount(s.pendingBuy, amount);
    return showBuyConfirmation(ctx, s);
  }

  // With a token already staged, "1:0.04 2:0.12" sets each wallet's size in a
  // single message — the fastest route to differing amounts per wallet.
  if (s.pendingBuy) {
    const spec = parseAmountSpec(text);
    if (spec) {
      const unknown = [...spec.keys()].filter((id) => !getWalletById(id));
      if (unknown.length) {
        return ctx.reply(`No wallet with id ${unknown.join(", ")}. See /wallets.`);
      }
      s.pendingBuy.amounts = spec;
      return showBuyConfirmation(ctx, s, { asNewMessage: true });
    }
  }

  if (isLikelyMint(text)) {
    const wallets = listWallets();
    if (wallets.length === 0) return ctx.reply("Add a wallet first with /addwallet.");

    // Confirm the address is really a mint before walking through wallet and
    // amount selection, so a mistyped or wrong-type address fails immediately.
    let decimals;
    try {
      decimals = await getMintDecimals(text);
    } catch (err) {
      return ctx.reply(`❌ ${err.message}`);
    }

    const info = await getTokenInfo(text);
    s.pendingBuy = {
      mint: text,
      symbol: info.symbol,
      decimals,
      selected: new Set(),
      amounts: new Map(),
    };

    const presets = listWallets().filter((w) => w.defaultBuySol > 0);
    const presetTotal = presets.reduce((sum, w) => sum + w.defaultBuySol, 0);
    const rows = [];
    if (presets.length > 0) {
      rows.push([
        Markup.button.callback(
          `⚡ Quick Buy — ${presets.map((w) => w.defaultBuySol).join(" + ")} = ${round(presetTotal)} SOL`,
          "bquick"
        ),
      ]);
    }
    rows.push([Markup.button.callback("Choose wallets manually", "bmanual")]);
    rows.push([Markup.button.callback("Cancel", "bcancel")]);

    return ctx.reply(
      `Token: ${info.symbol || "unknown (not in Jupiter's index yet)"}\n${text}\n\n` +
        (presets.length
          ? `Quick Buy uses: ${presets.map((w) => `${w.label} ${w.defaultBuySol}`).join(", ")}\n\n`
          : "No Quick Buy amounts set — /setamount <label> <sol>\n\n") +
        "Or type per-wallet amounts, e.g. `1:0.04 2:0.12`",
      { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }
    );
  }
});

// Accepts "1:0.04 2:0.12", "w1=0.04, w2=0.12", etc. Returns null when the text
// isn't an amount spec at all, so ordinary chat falls through untouched.
export function parseAmountSpec(text) {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const out = new Map();
  for (const part of parts) {
    const m = part.match(/^(?:w(?:allet)?)?(\d+)[:=]([\d.]+)$/i);
    if (!m) return null;
    const sol = Number(m[2]);
    if (!Number.isFinite(sol) || sol <= 0) return null;
    out.set(Number(m[1]), sol);
  }
  return out;
}

function applyUniformAmount(pendingBuy, sol) {
  pendingBuy.amounts = new Map([...pendingBuy.selected].map((id) => [id, sol]));
}

// Trims binary-float noise (0.04 + 0.12 = 0.16000000000000003).
const round = (n) => Math.round(n * 1e9) / 1e9;

function walletSelectKeyboard(pendingBuy) {
  const wallets = listWallets();
  const rows = wallets.map((w) => [
    Markup.button.callback(
      `${pendingBuy.selected.has(w.id) ? "☑️" : "⬜"} ${w.label} (${shortAddr(w.pubkey)})`,
      `bw:${w.id}`
    ),
  ]);
  rows.push([Markup.button.callback("Toggle All", "bw:all")]);
  rows.push([
    Markup.button.callback("Continue ➜", "bcontinue"),
    Markup.button.callback("Cancel", "bcancel"),
  ]);
  return Markup.inlineKeyboard(rows);
}

function amountKeyboard() {
  const rows = [];
  for (let i = 0; i < QUICK_AMOUNTS.length; i += 3) {
    rows.push(
      QUICK_AMOUNTS.slice(i, i + 3).map((a) => Markup.button.callback(`${a} SOL`, `bamt:${a}`))
    );
  }
  rows.push([Markup.button.callback("Custom amount", "bamt:custom")]);
  rows.push([Markup.button.callback("Cancel", "bcancel")]);
  return Markup.inlineKeyboard(rows);
}

function showBuyConfirmation(ctx, s, { asNewMessage = false } = {}) {
  const { amounts, symbol, mint } = s.pendingBuy;
  const lines = [...amounts].map(([id, sol]) => {
    const w = getWalletById(id);
    return `  ${w.label} — ${sol} SOL`;
  });
  const total = round([...amounts.values()].reduce((a, b) => a + b, 0));

  const text =
    `Buy ${symbol || shortAddr(mint)}\n` +
    `${lines.join("\n")}\n` +
    `  Total: ${total} SOL across ${amounts.size} wallet(s)\n` +
    `Slippage cap: ${BUY_SLIPPAGE_BPS / 100}% (dynamic)\n\nConfirm?`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("✅ Confirm", "bconfirm"), Markup.button.callback("Cancel", "bcancel")],
  ]);

  // A typed amount spec arrives as a new message, so there is no prior bot
  // message to edit in that path.
  return asNewMessage
    ? ctx.reply(text, keyboard)
    : ctx.editMessageText(text, keyboard);
}

async function executeBuy(ctx, s) {
  const { mint, symbol, amounts } = s.pendingBuy;
  const entries = [...amounts];
  s.pendingBuy = null;
  await ctx.editMessageText(`Buying on ${entries.length} wallet(s)...`);

  // Read from the mint account rather than the quote: Jupiter's quote response
  // carries no decimals, and a wrong value here silently corrupts every
  // position size we display later.
  const decimals = await getMintDecimals(mint);

  const results = await Promise.allSettled(
    entries.map(async ([walletId, amountSol]) => {
      const row = getWalletById(walletId);
      const solBal = await getSolBalance(row.pubkey);
      if (solBal < amountSol + FEE_RESERVE_SOL) {
        throw new Error(
          `${row.label}: needs ${round(amountSol + FEE_RESERVE_SOL)} SOL ` +
            `(has ${solBal.toFixed(4)})`
        );
      }

      const { signature, quote, attempts } = await executeSwap({
        keypair: getKeypairFor(row),
        inputMint: SOL_MINT,
        outputMint: mint,
        amount: Math.round(amountSol * 1e9),
        maxSlippageBps: BUY_SLIPPAGE_BPS,
      });

      recordBuy({
        walletId,
        mint,
        symbol: symbol || null,
        decimals,
        boughtRaw: quote.outAmount,
        solSpent: amountSol,
      });

      const received = (Number(quote.outAmount) / 10 ** decimals).toLocaleString();
      const retried = attempts > 1 ? ` (after ${attempts} attempts)` : "";
      return `✅ ${row.label}: +${received} for ${amountSol} SOL${retried}\n   ${signature}`;
    })
  );

  await reportResults(ctx, results, entries.map(([id]) => getWalletById(id)?.label));
}

// Reports per-wallet outcomes so a partial failure is never mistaken for a
// clean run — every wallet is accounted for, successes and failures alike.
async function reportResults(ctx, results, labels = []) {
  const lines = [];
  let ok = 0;
  let failed = 0;

  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if (r.value === null) return; // nothing to do for this wallet
      ok++;
      lines.push(r.value);
    } else {
      failed++;
      const who = labels[i] ? `${labels[i]}: ` : "";
      lines.push(`❌ ${who}${r.reason?.message || r.reason}`);
    }
  });

  if (lines.length === 0) return ctx.reply("No wallet held this token — nothing to do.");
  if (failed > 0) lines.push(`\n${ok} succeeded, ${failed} failed.`);
  await ctx.reply(lines.join("\n"), { disable_web_page_preview: true });
}

async function sellMintAcrossWallets(ctx, mint) {
  const wallets = listWallets();
  const info = await getTokenInfo(mint);
  await ctx.reply(`Selling ${info.symbol || shortAddr(mint)} across ${wallets.length} wallet(s)...`);

  const results = await Promise.allSettled(
    wallets.map(async (row) => {
      // Always sell the live on-chain balance, never the locally tracked
      // figure — the ledger drifts if tokens moved outside the bot.
      const bal = await getTokenBalance(row.pubkey, mint);
      if (!bal || BigInt(bal.raw) === 0n) {
        clearPosition(row.id, mint); // stale ledger entry
        return null;
      }

      const solBal = await getSolBalance(row.pubkey);
      if (solBal < 0.002) {
        throw new Error(`${solBal.toFixed(5)} SOL left, too little to cover the fee`);
      }

      const { signature, quote, attempts } = await executeSwap({
        keypair: getKeypairFor(row),
        inputMint: mint,
        outputMint: SOL_MINT,
        amount: bal.raw,
        maxSlippageBps: SELL_SLIPPAGE_BPS,
      });

      clearPosition(row.id, mint);
      const solOut = Number(quote.outAmount) / 1e9;
      const retried = attempts > 1 ? ` (after ${attempts} attempts)` : "";
      return `✅ ${row.label}: sold ${bal.uiAmount?.toLocaleString() ?? bal.raw} for ` +
        `~${solOut.toFixed(4)} SOL${retried}\n   ${signature}`;
    })
  );

  await reportResults(ctx, results, wallets.map((w) => w.label));
}

export function launchBot() {
  return bot.launch();
}

export function stopBot(signal) {
  bot.stop(signal);
}