import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { getState, saveState, getSalt } from "./store.js";
import { deriveKey, encryptSecret, decryptSecret } from "./crypto.js";

let cachedKey = null;

function encKey() {
  if (cachedKey) return cachedKey;
  const master = process.env.MASTER_PASSWORD;
  if (!master) throw new Error("MASTER_PASSWORD is not set");
  cachedKey = deriveKey(master, getSalt());
  return cachedKey;
}

// Accepts either a base58-encoded secret key (Phantom's "Export Private Key")
// or a JSON array of bytes (e.g. from a Solana CLI keypair file).
export function parseSecretKey(input) {
  const trimmed = input.trim();
  try {
    if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    return Keypair.fromSecretKey(bs58.decode(trimmed));
  } catch {
    throw new Error(
      "Could not parse that as a private key. Export it from Phantom as " +
        "base58 (Settings > Manage Wallets > select wallet > Export Private Key)."
    );
  }
}

export function addWallet(label, keypair) {
  const state = getState();
  const secretB58 = bs58.encode(keypair.secretKey);
  const { ciphertext, iv, authTag } = encryptSecret(secretB58, encKey());
  const id = state.nextWalletId++;
  state.wallets.push({
    id,
    label,
    pubkey: keypair.publicKey.toBase58(),
    ciphertext,
    iv,
    authTag,
    // Per-wallet default buy size, used by the one-tap Quick Buy. null = skip
    // this wallet unless it is picked explicitly.
    defaultBuySol: null,
    createdAt: Date.now(),
  });
  saveState();
  return id;
}

// `sol` of null or 0 clears the default, excluding the wallet from Quick Buy.
export function setWalletAmount(label, sol) {
  const w = getWallet(label);
  if (!w) return false;
  w.defaultBuySol = sol && sol > 0 ? sol : null;
  saveState();
  return true;
}

export function listWallets() {
  return getState().wallets.slice().sort((a, b) => a.id - b.id);
}

export function getWallet(label) {
  return getState().wallets.find((w) => w.label === label);
}

export function getWalletById(id) {
  return getState().wallets.find((w) => w.id === id);
}

export function getKeypairFor(walletRow) {
  const secretB58 = decryptSecret(
    { ciphertext: walletRow.ciphertext, iv: walletRow.iv, authTag: walletRow.authTag },
    encKey()
  );
  return Keypair.fromSecretKey(bs58.decode(secretB58));
}

export function removeWallet(label) {
  const state = getState();
  const idx = state.wallets.findIndex((w) => w.label === label);
  if (idx === -1) return false;
  const [removed] = state.wallets.splice(idx, 1);
  state.positions = state.positions.filter((p) => p.walletId !== removed.id);
  saveState();
  return true;
}

export function nextAutoLabel() {
  const wallets = listWallets();
  const taken = new Set(wallets.map((w) => w.label));
  let n = wallets.length + 1;
  while (taken.has(`Wallet${n}`)) n++;
  return `Wallet${n}`;
}
