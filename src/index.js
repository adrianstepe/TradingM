import "dotenv/config";
import "./store.js";
import { launchBot, stopBot } from "./bot.js";
import { startPumpFunSniper, stopPumpFunSniper } from "./pumpfun-snipe.js";

for (const key of ["BOT_TOKEN", "OWNER_ID", "MASTER_PASSWORD"]) {
  if (!process.env[key]) {
    console.error(`Missing required env var ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

// Optional: Auto-start sniper if PUMPFUN_AUTO_START_SNIPER is set
const autoStartSniper = process.env.PUMPFUN_AUTO_START_SNIPER === "true";

launchBot().then(() => {
  console.log("Bot running.");
  
  if (autoStartSniper && process.env.PUMPFUN_DEV_WALLET) {
    startPumpFunSniper((msg) => console.log("[Sniper Notification]", msg));
    console.log("🎯 Auto-sniper started (PUMPFUN_AUTO_START_SNIPER=true)");
  }
});

process.once("SIGINT", () => {
  stopPumpFunSniper();
  stopBot("SIGINT");
});
process.once("SIGTERM", () => {
  stopPumpFunSniper();
  stopBot("SIGTERM");
});