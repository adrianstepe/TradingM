/**
 * Pump.fun Auto-Sniper Module
 * 
 * Monitors Solana blockchain for new token creations from your dev wallet
 * on pump.fun and automatically executes buys across configured bot wallets.
 * 
 * This is completely separate from manual trading — it runs in parallel.
 */

import { PublicKey } from "@solana/web3.js";
import { connection } from "./solana.js";
import { getState, saveState } from "./store.js";
import { listWallets, getWalletById, getKeypairFor } from "./wallets.js";
import { executeSwap } from "./swap.js";
import { recordBuy } from "./positions.js";
import { getMintDecimals } from "./solana.js";
import { getTokenInfo, SOL_MINT } from "./jupiter.js";

// Pump.fun program ID
const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJJ14rZ4F3g6R");

// Config from environment
const DEV_WALLET = process.env.PUMPFUN_DEV_WALLET; // Your pump.fun dev wallet pubkey
const BOT_WALLET_IDS = (process.env.PUMPFUN_BOT_WALLET_IDS || "2,3,4,5")
  .split(",")
  .map(s => Number(s.trim())); // Default: wallets 2,3,4,5 (your 4 bot wallets)
const BUY_AMOUNT_SOL = Number(process.env.PUMPFUN_BUY_AMOUNT_SOL || 0.05); // SOL per wallet
const BUY_SLIPPAGE_BPS = Number(process.env.PUMPFUN_SNIPER_SLIPPAGE_BPS || 3000);
const AUTO_SELL_ENABLED = process.env.PUMPFUN_AUTO_SELL === "true";
const AUTO_SELL_DELAY_MS = Number(process.env.PUMPFUN_AUTO_SELL_DELAY_MS || 30000); // 30s default
const FEE_RESERVE_SOL = 0.01; // Leave for fees

// In-memory tracking to prevent double-buys
const snipedMints = new Set();
const activeAutoSells = new Map(); // mint -> timeoutId

let isRunning = false;
let subscriptionId = null;

/**
 * Start monitoring for new pump.fun tokens from dev wallet
 */
export function startPumpFunSniper(sendNotification) {
  if (isRunning) {
    console.log("[Sniper] Already running");
    return;
  }

  if (!DEV_WALLET) {
    console.log("[Sniper] PUMPFUN_DEV_WALLET not set — sniper disabled");
    return;
  }

  console.log(`[Sniper] Starting monitor for dev wallet: ${DEV_WALLET}`);
  console.log(`[Sniper] Will buy with wallets: ${BOT_WALLET_IDS.join(", ")}`);
  console.log(`[Sniper] Buy amount: ${BUY_AMOUNT_SOL} SOL per wallet`);

  // Load previously sniped tokens from state to avoid re-buying
  const state = getState();
  state.snipedMints?.forEach(m => snipedMints.add(m));

  // Subscribe to logs from pump.fun program
  subscriptionId = connection.onLogs(
    PUMPFUN_PROGRAM_ID,
    (logs) => handlePumpFunLogs(logs, sendNotification),
    "confirmed"
  );

  isRunning = true;
  console.log("[Sniper] Subscription active — waiting for new tokens...");
}

/**
 * Stop the sniper
 */
export function stopPumpFunSniper() {
  if (!isRunning || subscriptionId === null) return;
  
  connection.removeOnLogsListener(subscriptionId);
  subscriptionId = null;
  isRunning = false;
  
  // Clear any pending auto-sells
  activeAutoSells.forEach((timeoutId) => clearTimeout(timeoutId));
  activeAutoSells.clear();
  
  console.log("[Sniper] Stopped");
}

/**
 * Check if sniper is running
 */
export function isSniperRunning() {
  return isRunning;
}

/**
 * Get list of sniped tokens
 */
export function getSnipedTokens() {
  return [...snipedMints];
}

/**
 * Parse pump.fun logs to detect new token creation and buys
 */
async function handlePumpFunLogs(logs, sendNotification) {
  try {
    // Check if this log contains a create event from our dev wallet
    const createMatch = logs.logs.find(log => 
      log.includes("Create") && log.includes(DEV_WALLET.slice(0, 16))
    );
    
    if (!createMatch) return;

    // Extract mint from logs (pump.fun logs contain the mint address)
    const mintMatch = logs.logs.find(log => {
      // Look for a base58 mint address pattern in the logs
      const match = log.match(/[A-HJ-NP-Za-km-z1-9]{32,44}/);
      return match && match[0] !== DEV_WALLET && match[0].length === 44;
    });

    if (!mintMatch) return;

    const mint = mintMatch.match(/[A-HJ-NP-Za-km-z1-9]{32,44}/)[0];
    
    // Skip if already sniped
    if (snipedMints.has(mint)) return;

    // Verify this is actually a new token mint (not some other address)
    try {
      new PublicKey(mint);
    } catch {
      return;
    }

    console.log(`[Sniper] 🎯 NEW TOKEN DETECTED: ${mint}`);
    
    // Add to sniped immediately to prevent race conditions
    snipedMints.add(mint);
    
    // Persist to state
    const state = getState();
    if (!state.snipedMints) state.snipedMints = [];
    state.snipedMints.push(mint);
    saveState();

    // Execute buys across bot wallets
    await executeSniperBuy(mint, sendNotification);

  } catch (err) {
    console.error("[Sniper] Error handling logs:", err);
  }
}

/**
 * Execute buy across all configured bot wallets
 */
async function executeSniperBuy(mint, sendNotification) {
  const startTime = Date.now();
  const wallets = listWallets().filter(w => BOT_WALLET_IDS.includes(w.id));
  
  if (wallets.length === 0) {
    console.error("[Sniper] No bot wallets found with IDs:", BOT_WALLET_IDS);
    sendNotification?.("❌ Sniper: No bot wallets found. Check PUMPFUN_BOT_WALLET_IDS.");
    return;
  }

  // Get token info and decimals
  let decimals, symbol;
  try {
    decimals = await getMintDecimals(mint);
    const info = await getTokenInfo(mint);
    symbol = info.symbol || "UNKNOWN";
  } catch (err) {
    console.error("[Sniper] Failed to get token info:", err);
    // Continue anyway — decimals will be fetched during swap
  }

  sendNotification?.(`🎯 SNIPER TRIGGERED\nToken: ${symbol || "New Token"}\nMint: ${mint.slice(0, 8)}...${mint.slice(-8)}\nBuying with ${wallets.length} wallets...`);

  // Execute buys in parallel across all bot wallets
  const results = await Promise.allSettled(
    wallets.map(async (wallet) => {
      try {
        const solBal = await getSolBalanceWithConnection(wallet.pubkey);
        if (solBal < BUY_AMOUNT_SOL + FEE_RESERVE_SOL) {
          throw new Error(
            `Insufficient SOL: has ${solBal.toFixed(4)}, needs ${(BUY_AMOUNT_SOL + FEE_RESERVE_SOL).toFixed(4)}`
          );
        }

        const { signature, quote, attempts } = await executeSwap({
          keypair: getKeypairFor(wallet),
          inputMint: SOL_MINT,
          outputMint: mint,
          amount: Math.round(BUY_AMOUNT_SOL * 1e9),
          maxSlippageBps: BUY_SLIPPAGE_BPS,
        });

        // Record position
        recordBuy({
          walletId: wallet.id,
          mint,
          symbol,
          decimals,
          boughtRaw: quote.outAmount,
          solSpent: BUY_AMOUNT_SOL,
        });

        const received = Number(quote.outAmount) / 10 ** (decimals || 9);
        const retried = attempts > 1 ? ` (retried ${attempts}x)` : "";
        
        return {
          success: true,
          wallet: wallet.label,
          received,
          signature,
          retried,
        };

      } catch (err) {
        return {
          success: false,
          wallet: wallet.label,
          error: err.message,
        };
      }
    })
  );

  // Compile results
  const duration = Date.now() - startTime;
  const successes = results.filter(r => r.value?.success);
  const failures = results.filter(r => !r.value?.success);

  // Build report
  const lines = [
    `✅ SNIPER COMPLETE in ${duration}ms`,
    `Token: ${symbol || "Unknown"}`,
    "",
    `Success: ${successes.length}/${wallets.length} wallets`,
  ];

  successes.forEach(r => {
    const v = r.value;
    lines.push(`✓ ${v.wallet}: +${v.received.toLocaleString()} tokens${v.retried}`);
  });

  failures.forEach(r => {
    const v = r.value;
    lines.push(`✗ ${v.wallet}: ${v.error}`);
  });

  const totalSolSpent = successes.length * BUY_AMOUNT_SOL;
  lines.push("", `Total SOL spent: ${totalSolSpent}`);

  console.log("[Sniper]", lines.join("\n"));
  sendNotification?.(lines.join("\n"));

  // Schedule auto-sell if enabled
  if (AUTO_SELL_ENABLED && successes.length > 0) {
    scheduleAutoSell(mint, sendNotification);
  }
}

/**
 * Get SOL balance with retry
 */
async function getSolBalanceWithConnection(pubkeyStr) {
  const { Connection, PublicKey, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
  const lamports = await connection.getBalance(new PublicKey(pubkeyStr));
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Schedule automatic sell after delay
 */
function scheduleAutoSell(mint, sendNotification) {
  if (activeAutoSells.has(mint)) {
    clearTimeout(activeAutoSells.get(mint));
  }

  sendNotification?.(`⏱️ Auto-sell scheduled in ${AUTO_SELL_DELAY_MS/1000}s...`);

  const timeoutId = setTimeout(async () => {
    await executeAutoSell(mint, sendNotification);
    activeAutoSells.delete(mint);
  }, AUTO_SELL_DELAY_MS);

  activeAutoSells.set(mint, timeoutId);
}

/**
 * Execute sell across all wallets holding this token
 */
async function executeAutoSell(mint, sendNotification) {
  const wallets = listWallets().filter(w => BOT_WALLET_IDS.includes(w.id));
  
  sendNotification?.(`🔄 AUTO-SELL triggered for ${mint.slice(0, 8)}...`);

  const results = await Promise.allSettled(
    wallets.map(async (wallet) => {
      try {
        // Check if wallet actually holds this token
        const { getTokenBalance } = await import("./solana.js");
        const bal = await getTokenBalance(wallet.pubkey, mint);
        
        if (!bal || BigInt(bal.raw) === 0n) {
          return { success: true, wallet: wallet.label, skipped: true };
        }

        const { signature, quote } = await executeSwap({
          keypair: getKeypairFor(wallet),
          inputMint: mint,
          outputMint: SOL_MINT,
          amount: bal.raw,
          maxSlippageBps: BUY_SLIPPAGE_BPS + 1000, // Higher slippage for sells
        });

        const solOut = Number(quote.outAmount) / 1e9;
        
        return {
          success: true,
          wallet: wallet.label,
          solOut,
          signature,
        };

      } catch (err) {
        return {
          success: false,
          wallet: wallet.label,
          error: err.message,
        };
      }
    })
  );

  const successes = results.filter(r => r.value?.success && !r.value?.skipped);
  const skipped = results.filter(r => r.value?.skipped);
  const failures = results.filter(r => !r.value?.success);

  const lines = [
    "✅ AUTO-SELL COMPLETE",
    `Sold: ${successes.length} | Skipped (no balance): ${skipped.length} | Failed: ${failures.length}`,
  ];

  successes.forEach(r => {
    const v = r.value;
    lines.push(`✓ ${v.wallet}: ~${v.solOut.toFixed(4)} SOL`);
  });

  failures.forEach(r => {
    const v = r.value;
    lines.push(`✗ ${v.wallet}: ${v.error}`);
  });

  sendNotification?.(lines.join("\n"));
}

/**
 * Manual trigger to stop auto-sell for a specific token
 */
export function cancelAutoSell(mint) {
  if (activeAutoSells.has(mint)) {
    clearTimeout(activeAutoSells.get(mint));
    activeAutoSells.delete(mint);
    return true;
  }
  return false;
}