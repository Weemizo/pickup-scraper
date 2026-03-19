import { chromium } from "playwright";
import fs from "fs-extra";
import * as dotenv from "dotenv";
import { log } from "./utils.js";
dotenv.config();

export async function authenticate() {
  log("🔐", "Uruchamiam zapis logowania...");

  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    log("🌐", `Otwieram: ${process.env.BASE_URL}/login`);
    await page.goto(`${process.env.BASE_URL}/login`, {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    await page.screenshot({ path: "./output/debug-login.png" });
    log("📸", "Screenshot: output/debug-login.png");

    await page.waitForSelector("#email", { timeout: 15000 });
    await page.fill("#email", process.env.PICKUP_EMAIL);
    await page.fill("#password", process.env.PICKUP_PASSWORD);
    await page.click('button[aria-label="Log in"]');

    await page.screenshot({ path: "./output/debug-before-submit.png" });

    await page.waitForURL(/guitar/, { timeout: 30000 });
    log("✅", "Zalogowano pomyślnie!");

    await context.storageState({ path: "./output/storage.json" });
    log("💾", "Sesja zapisana w output/storage.json");
  } catch (err) {
    await page.screenshot({ path: "./output/debug-error.png" });
    log("📸", "Screenshot błędu: output/debug-error.png");
    throw new Error(`Błąd logowania: ${err.message}`);
  } finally {
    await browser.close();
  }
}

export async function createAuthContext(browser) {
  const storageExists = await fs.pathExists("./output/storage.json");
  if (!storageExists) {
    throw new Error("Brak sesji! Uruchom: npm run auth");
  }

  return browser.newContext({
    storageState: "./output/storage.json",
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  });
}
