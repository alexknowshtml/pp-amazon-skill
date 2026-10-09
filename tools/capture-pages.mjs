#!/usr/bin/env node
// capture-pages.mjs — save live Amazon pages as raw HTML for building test
// fixtures. Read-only: it only loads pages, never clicks.
//
// Usage: node tools/capture-pages.mjs <cookies.json> <out-dir> [cart|orders ...]
// Raw captures hold your name, address and session tokens. Keep <out-dir>
// private (outside this repo); run tools/scrub-fixture.mjs before committing.

import fs from "node:fs";
import path from "node:path";
import { launchSession } from "../lib/browser.mjs";
import { waitForOrderCards } from "../lib/orders.mjs";

const [, , cookiesPath, outDir, ...which] = process.argv;
if (!cookiesPath || !outDir) {
  console.error("usage: capture-pages.mjs <cookies.json> <out-dir> [cart|orders ...]");
  process.exit(2);
}
const targets = which.length ? which : ["cart", "orders"];
const PAGES = {
  cart: { url: "https://www.amazon.com/gp/cart/view.html", settle: async (p) => { await p.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}); await p.waitForTimeout(1500); } },
  orders: { url: "https://www.amazon.com/your-orders/orders", settle: (p) => waitForOrderCards(p) },
};

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const { browser, page } = await launchSession(cookiesPath);
for (const t of targets) {
  const spec = PAGES[t];
  if (!spec) { console.error(`unknown page: ${t}`); continue; }
  await page.goto(spec.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await spec.settle(page);
  const file = path.join(outDir, `${t}-${new Date().toISOString().replace(/[:.]/g, "-")}.html`);
  fs.writeFileSync(file, `<!-- ${page.url()} -->\n` + (await page.content()), { mode: 0o600 });
  console.log(file);
}
await browser.close();
