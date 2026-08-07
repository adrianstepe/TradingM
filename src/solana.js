import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

export const connection = new Connection(
  process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
  "confirmed"
);

export async function getSolBalance(pubkeyStr) {
  const lamports = await connection.getBalance(new PublicKey(pubkeyStr));
  return lamports / LAMPORTS_PER_SOL;
}

const mintDecimalsCache = new Map();

// Authoritative decimals, read from the mint account itself. Jupiter's token
// index omits brand-new mints, and its quote response carries no decimals at
// all, so this is the only reliable source. Doubles as validation that the
// address really is an SPL mint (works for Token-2022 mints too).
export async function getMintDecimals(mintStr) {
  if (mintDecimalsCache.has(mintStr)) return mintDecimalsCache.get(mintStr);
  const info = await connection.getParsedAccountInfo(new PublicKey(mintStr));
  const parsed = info.value?.data?.parsed;
  if (!parsed || parsed.type !== "mint") {
    throw new Error("That address is not an SPL token mint.");
  }
  const decimals = parsed.info.decimals;
  mintDecimalsCache.set(mintStr, decimals);
  return decimals;
}

// Filtering by mint alone (rather than by programId) matches the token account
// regardless of whether the mint uses the classic Token program or Token-2022.
export async function getTokenBalance(ownerPubkeyStr, mintStr) {
  const resp = await connection.getParsedTokenAccountsByOwner(new PublicKey(ownerPubkeyStr), {
    mint: new PublicKey(mintStr),
  });
  if (resp.value.length === 0) return null;

  // A wallet can hold more than one account for a mint; trade the fullest.
  let best = null;
  for (const { account } of resp.value) {
    const amt = account.data.parsed.info.tokenAmount;
    if (!best || BigInt(amt.amount) > BigInt(best.raw)) {
      best = { raw: amt.amount, decimals: amt.decimals, uiAmount: amt.uiAmount };
    }
  }
  return best;
}

export function isLikelyMint(text) {
  const t = text.trim();
  if (t.length < 32 || t.length > 44) return false;
  try {
    // Rejects valid base58 that isn't a real curve point / 32-byte key.
    new PublicKey(t);
    return true;
  } catch {
    return false;
  }
}
