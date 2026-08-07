import { getState, saveState } from "./store.js";

export function recordBuy({ walletId, mint, symbol, decimals, boughtRaw, solSpent }) {
  const state = getState();
  const pos = state.positions.find((p) => p.walletId === walletId && p.mint === mint);
  if (pos) {
    pos.amountRaw = (BigInt(pos.amountRaw) + BigInt(boughtRaw)).toString();
    pos.solSpent += solSpent;
    pos.updatedAt = Date.now();
  } else {
    state.positions.push({
      walletId,
      mint,
      symbol: symbol || null,
      decimals: decimals || 0,
      amountRaw: boughtRaw.toString(),
      solSpent,
      updatedAt: Date.now(),
    });
  }
  saveState();
}

export function clearPosition(walletId, mint) {
  const state = getState();
  state.positions = state.positions.filter((p) => !(p.walletId === walletId && p.mint === mint));
  saveState();
}

export function reducePosition(walletId, mint, soldRaw) {
  const state = getState();
  const pos = state.positions.find((p) => p.walletId === walletId && p.mint === mint);
  if (!pos) return;
  const remaining = BigInt(pos.amountRaw) - BigInt(soldRaw);
  if (remaining <= 0n) {
    clearPosition(walletId, mint);
  } else {
    pos.amountRaw = remaining.toString();
    pos.updatedAt = Date.now();
    saveState();
  }
}

// Groups positions by mint across all wallets: { mint, symbol, decimals, totalRaw, wallets: [{walletId, amountRaw}] }
export function getPositionsGroupedByMint() {
  const positions = getState().positions;
  const grouped = new Map();
  for (const p of positions) {
    if (!grouped.has(p.mint)) {
      grouped.set(p.mint, {
        mint: p.mint,
        symbol: p.symbol,
        decimals: p.decimals,
        totalRaw: 0n,
        wallets: [],
      });
    }
    const g = grouped.get(p.mint);
    g.totalRaw += BigInt(p.amountRaw);
    g.wallets.push({ walletId: p.walletId, amountRaw: p.amountRaw });
  }
  return [...grouped.values()];
}

export function getPositionsForWallet(walletId) {
  return getState().positions.filter((p) => p.walletId === walletId);
}
