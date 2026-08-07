import { VersionedTransaction } from "@solana/web3.js";
import { connection } from "./solana.js";
import { getQuote, getSwapTransaction } from "./jupiter.js";

// Jupiter's swap program raises 6001 when the trade would settle worse than the
// quoted slippage bound. That means the market moved, not that the request was
// invalid, so it is worth retrying against a freshly fetched quote.
const SLIPPAGE_ERROR_CODE = 6001;

const RETRYABLE_PATTERNS = [
  /blockhash not found/i,
  /block height exceeded/i,
  /transaction was not confirmed/i,
  /timed? ?out/i,
  /slippage/i,
  /fetch failed/i,
  /network|socket|econnreset|etimedout|enotfound/i,
  /\b(429|502|503|504)\b/,
  /node is behind|rate limit/i,
];

const FATAL_PATTERNS = [
  /insufficient (lamports|funds)/i,
  /not an spl token mint/i,
  /could not find any route|no routes found/i,
  /attempt to debit an account but found no record/i,
];

function isRetryable(message) {
  if (FATAL_PATTERNS.some((re) => re.test(message))) return false;
  return RETRYABLE_PATTERNS.some((re) => re.test(message));
}

// Turns web3.js's structured on-chain error into something a human can read.
function describeTxError(err) {
  const custom = err?.InstructionError?.[1]?.Custom;
  if (custom === SLIPPAGE_ERROR_CODE) {
    return "slippage tolerance exceeded (price moved during execution)";
  }
  if (custom !== undefined) return `on-chain program error ${custom}`;
  return `transaction failed on-chain: ${JSON.stringify(err)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Quote, build, sign, send and confirm a swap, retrying transient failures.
 *
 * Each attempt re-quotes from scratch: a Jupiter swap transaction embeds both a
 * route and a recent blockhash, and both go stale within roughly a minute, so
 * reusing the previous attempt's transaction would simply fail again.
 *
 * Resolves only once the network confirms the transaction with no error.
 */
export async function executeSwap({
  keypair,
  inputMint,
  outputMint,
  amount,
  maxSlippageBps,
  attempts = 3,
}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const quote = await getQuote({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: maxSlippageBps,
      });

      const swapTxB64 = await getSwapTransaction({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        maxSlippageBps,
      });

      const tx = VersionedTransaction.deserialize(Buffer.from(swapTxB64, "base64"));
      tx.sign([keypair]);

      // Preflight is left on deliberately. Skipping it shaves latency but sends
      // doomed transactions and reports failures as opaque timeouts; here a
      // clear error is worth more than the milliseconds.
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 0, // retries are driven by this loop, with fresh quotes
      });

      const { lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const result = await connection.confirmTransaction(
        { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
        "confirmed"
      );

      // Confirmation only means the network reached consensus on the
      // transaction — including consensus that it failed.
      if (result.value.err) throw new Error(describeTxError(result.value.err));

      return { signature, quote, attempts: attempt };
    } catch (err) {
      lastError = err;
      const message = err?.message || String(err);
      if (attempt === attempts || !isRetryable(message)) break;
      await sleep(400 * attempt); // brief backoff, then re-quote
    }
  }

  throw lastError;
}
