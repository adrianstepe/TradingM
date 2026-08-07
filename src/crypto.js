import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

export function deriveKey(masterPassword, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  return crypto.scryptSync(masterPassword, salt, 32);
}

export function newSalt() {
  return crypto.randomBytes(16).toString("hex");
}

export function encryptSecret(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

export function decryptSecret({ ciphertext, iv, authTag }, key) {
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(authTag, "hex"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "hex")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}
