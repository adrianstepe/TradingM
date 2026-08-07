// Jupiter's older quote-api.jup.ag/v6 host is retired. Free tier is lite-api;
// a paid API key routes to api.jup.ag instead.
const API_BASE = process.env.JUPITER_API_KEY
  ? "https://api.jup.ag"
  : "https://lite-api.jup.ag";

const QUOTE_URL = `${API_BASE}/swap/v1/quote`;
const SWAP_URL = `${API_BASE}/swap/v1/swap`;
const TOKEN_SEARCH_URL = `${API_BASE}/tokens/v2/search`;

export const SOL_MINT = "So11111111111111111111111111111111111111112";

// Ceiling on the priority fee Jupiter may attach per swap. Higher lands faster
// when the network is congested; this caps what a single trade can burn on fees.
const MAX_PRIORITY_FEE_LAMPORTS = Number(process.env.MAX_PRIORITY_FEE_LAMPORTS || 2_000_000);

function authHeaders() {
  return process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {};
}

export async function getQuote({ inputMint, outputMint, amount, slippageBps }) {
  const url = new URL(QUOTE_URL);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", String(amount));
  url.searchParams.set("slippageBps", String(slippageBps));
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter quote failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function getSwapTransaction({ quoteResponse, userPublicKey, maxSlippageBps }) {
  const res = await fetch(SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel: "high",
          maxLamports: MAX_PRIORITY_FEE_LAMPORTS,
        },
      },
      // Let Jupiter compute the slippage actually needed from live market
      // conditions, capped at maxSlippageBps, instead of always spending
      // the full allowance.
      dynamicSlippage: { maxBps: maxSlippageBps },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter swap build failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.swapTransaction) throw new Error("Jupiter returned no swap transaction");
  return data.swapTransaction;
}

const tokenInfoCache = new Map();

// Best-effort metadata lookup. Brand-new tokens are often absent from Jupiter's
// index, so callers must not depend on this for decimals — use the on-chain
// mint account (getMintDecimals) when correctness matters.
export async function getTokenInfo(mint) {
  if (tokenInfoCache.has(mint)) return tokenInfoCache.get(mint);
  const empty = { symbol: null, name: null, decimals: null, tokenProgram: null };
  try {
    const url = new URL(TOKEN_SEARCH_URL);
    url.searchParams.set("query", mint);
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error("lookup failed");
    const results = await res.json();
    const hit = Array.isArray(results) ? results.find((t) => t.id === mint) : null;
    if (!hit) throw new Error("not indexed");
    const info = {
      symbol: hit.symbol ?? null,
      name: hit.name ?? null,
      decimals: hit.decimals ?? null,
      tokenProgram: hit.tokenProgram ?? null,
    };
    tokenInfoCache.set(mint, info);
    return info;
  } catch {
    // Not cached: a token missing from the index today may be listed later.
    return empty;
  }
}
