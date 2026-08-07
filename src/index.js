import "dotenv/config";
import "./store.js";
import { launchBot, stopBot } from "./bot.js";

for (const key of ["BOT_TOKEN", "OWNER_ID", "MASTER_PASSWORD"]) {
  if (!process.env[key]) {
    console.error(`Missing required env var ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

launchBot().then(() => console.log("Bot running."));

process.once("SIGINT", () => stopBot("SIGINT"));
process.once("SIGTERM", () => stopBot("SIGTERM"));
