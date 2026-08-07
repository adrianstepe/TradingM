import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newSalt } from "./crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const storePath = path.join(dataDir, "store.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function load() {
  if (!fs.existsSync(storePath)) {
    return { salt: newSalt(), nextWalletId: 1, wallets: [], positions: [] };
  }
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
}

const state = load();

function persist() {
  fs.writeFileSync(storePath, JSON.stringify(state, null, 2));
}
persist(); // ensures the file (and a freshly generated salt) exists on first run

export function getSalt() {
  return state.salt;
}

export function getState() {
  return state;
}

export function saveState() {
  persist();
}
