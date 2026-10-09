#!/usr/bin/env node
// amazon-checkout.mjs — Playwright-driven cart view + place-order for amazon-pp-cli.
//
// Why: the static-HTTP cart path doesn't render Amazon's JS-decrypted cart cells,
// and the static place-order POST trips robot-check. This shells out from the Go
// CLI to a real browser, runs JS, and reads the same DOM the user would see.
//
// Exit codes (must match the Go CLI's internal/cli/root.go):
//   0   success — JSON payload on stdout
//   2   usage error
//   7   transient/network failure
//   9   manual required (CAPTCHA, sign-in challenge, etc.) — JSON has deeplink
//
// Args: <action> <cookies.json> [--place-order]
//   action: "cart-show" | "checkout"
//   --place-order: only honored for action=checkout; clicks the actual button.
//                  Without it, checkout stops at the order-review page.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchSession, detectManualGate, manualExit, transientExit } from "./lib/browser.mjs";
import { readCart, readDefaults } from "./lib/cart.mjs";
import { parseOrderCards, waitForOrderCards, readConfirmation, findPlacedOrders } from "./lib/orders.mjs";

const [, , action, cookiesPath, ...rest] = process.argv;
const wantPlace = rest.includes("--place-order");

// add-to-cart args: <action> <cookies.json> <ASIN> [--quantity N]
const addAsin = action === "add-to-cart" ? rest.find((a) => /^[A-Z0-9]{10}$/.test(a)) : null;
const qtyArg = (() => {
  const i = rest.indexOf("--quantity");
  if (i >= 0 && rest[i + 1]) return parseInt(rest[i + 1], 10);
  return 1;
})();

if (!action || !cookiesPath) {
  console.error("usage: amazon-checkout.mjs <cart-show|checkout|add-to-cart|history-sync> <cookies.json> [<ASIN>] [--place-order] [--quantity N]");
  process.exit(2);
}
if (!["cart-show", "checkout", "add-to-cart", "history-sync"].includes(action)) {
  console.error(`unknown action: ${action}`);
  process.exit(2);
}
if (action === "add-to-cart" && !addAsin) {
  console.error("add-to-cart requires an ASIN as a positional arg (10 uppercase letters/digits)");
  process.exit(2);
}

async function captureThankYou(page) {
  try {
    const dir = path.join(path.dirname(cookiesPath), "captures");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (f.startsWith("thankyou-") && fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    }
    const file = path.join(dir, `thankyou-${new Date().toISOString().replace(/[:.]/g, "-")}.html`);
    fs.writeFileSync(file, `<!-- ${page.url()} -->\n` + (await page.content()), { mode: 0o600 });
    return file;
  } catch (e) {
    process.stderr.write(`thank-you capture failed: ${e.message}\n`);
    return "";
  }
}

async function main() {
  const { browser, page } = await launchSession(cookiesPath);

  // ===== history-sync action =====
  // Walks Amazon's order-history across multiple year filters and emits JSONL
  // (one order per line) on stdout. Two-pass strategy:
  //   1. Modern URL /your-orders/orders?timeFilter=year-YYYY (year-aware,
  //      JS-rendered — wait for skeletons to clear before parsing).
  //   2. Legacy URL /gp/legacy/order-history (fallback for the current window;
  //      static HTML, but ignores the orderFilter param so it can only return
  //      the default view).
  // Years to walk are passed via --years (comma-separated, e.g. "2026,2025,2024").
  // Default: current year + 2 prior years.
  if (action === "history-sync") {
    const yearsArgIdx = rest.indexOf("--years");
    const yearsArg = yearsArgIdx >= 0 ? rest[yearsArgIdx + 1] : "";
    const now = new Date();
    const defaultYears = [now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2];
    const years = yearsArg
      ? yearsArg.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 2000 && n < 2100)
      : defaultYears;
    process.stderr.write(`history-sync walking years: ${years.join(", ")}\n`);

    const parseOrdersFromPage = (src) => parseOrderCards(page, src);
    const waitForOrdersToHydrate = () => waitForOrderCards(page);

    const allOrders = [];

    for (const year of years) {
      const url = `https://www.amazon.com/your-orders/orders?timeFilter=year-${year}`;
      process.stderr.write(`fetching ${url}\n`);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      } catch (e) {
        process.stderr.write(`navigation to year-${year} failed: ${e.message}\n`);
        continue;
      }
      const gate = await detectManualGate(page);
      if (gate) {
        await browser.close();
        manualExit(gate.kind, gate.deeplink, { stage: `history-sync-year-${year}` });
      }
      await waitForOrdersToHydrate();
      let pageNum = 1;
      while (pageNum <= 30) {
        const got = await parseOrdersFromPage(`modern-year-${year}-p${pageNum}`);
        process.stderr.write(`  page ${pageNum}: ${got.length} orders\n`);
        allOrders.push(...got);
        // Find next page link (modern pagination)
        const nextLink = await page.$(
          "ul.a-pagination li.a-last:not(.a-disabled) a, " +
          "[aria-label='Next page'], " +
          "a[class*='pagination-next']:not([class*='disabled'])"
        );
        if (!nextLink) break;
        try {
          await Promise.all([
            page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
            nextLink.click(),
          ]);
        } catch (e) { break; }
        pageNum += 1;
        await waitForOrdersToHydrate();
      }
    }

    // Also do one legacy-page pass as a safety net for the very recent window
    // — Amazon sometimes shows orders on legacy that aren't yet on modern.
    try {
      await page.goto("https://www.amazon.com/gp/legacy/order-history",
        { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const legacyOrders = await parseOrdersFromPage("legacy-default");
      process.stderr.write(`legacy fallback: ${legacyOrders.length} orders\n`);
      allOrders.push(...legacyOrders);
    } catch (e) {
      process.stderr.write(`legacy fallback failed (non-fatal): ${e.message}\n`);
    }

    // Dedupe by order_id (legacy + multiple year filters may overlap)
    const seen = new Set();
    const uniq = [];
    for (const o of allOrders) {
      if (!o.order_id || seen.has(o.order_id)) continue;
      seen.add(o.order_id);
      // Strip the _source debug tag before emitting
      const { _source, ...clean } = o;
      uniq.push(clean);
    }
    process.stdout.write(JSON.stringify({
      status: "ok",
      orders_count: uniq.length,
      years_walked: years,
      jsonl: uniq.map((o) => JSON.stringify(o)).join("\n"),
    }) + "\n");
    await browser.close();
    process.exit(0);
  }

  // Pre-warm: visit home for a brief touchpoint before /gp/cart.
  try {
    await page.goto("https://www.amazon.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
  } catch (e) {
    // Non-fatal; continue.
  }

  // Navigate to cart.
  try {
    await page.goto("https://www.amazon.com/gp/cart/view.html", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
  } catch (e) {
    await browser.close();
    transientExit(`cart navigation failed: ${e.message}`);
  }

  let gate = await detectManualGate(page);
  if (gate) {
    await browser.close();
    manualExit(gate.kind, gate.deeplink);
  }

  const cart = await readCart(page);
  const defaults = await readDefaults(page);

  if (action === "cart-show") {
    process.stdout.write(JSON.stringify({
      status: "ok",
      items: cart.items,
      subtotal: cart.subtotal,
      default_address: defaults.address,
      default_card_last4: defaults.card_last4,
    }) + "\n");
    await browser.close();
    process.exit(0);
  }

  if (action === "add-to-cart") {
    // Already on /gp/cart from the navigation above; navigate to the product
    // page now and drive the real Add-to-Cart button.
    const beforeAsins = new Set(cart.items.map((it) => it.asin).filter(Boolean));

    try {
      await page.goto(`https://www.amazon.com/dp/${addAsin}?th=1&psc=1`,
        { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
    } catch (e) {
      await browser.close();
      transientExit(`product page navigation failed: ${e.message}`);
    }

    gate = await detectManualGate(page);
    if (gate) {
      await browser.close();
      manualExit(gate.kind, gate.deeplink, { stage: "product-page" });
    }

    // Set quantity if not 1.
    if (qtyArg > 1) {
      try {
        const qtySel = await page.$('#quantity, select[name="quantity"]');
        if (qtySel) {
          await qtySel.selectOption(String(qtyArg)).catch(() => {});
        }
      } catch (e) { /* fall through; default qty 1 */ }
    }

    // Find Add-to-Cart button. Try multiple selectors + role-based fallback.
    let clicked = false;
    const candidates = [
      'input#add-to-cart-button',
      '#add-to-cart-button',
      'input[name="submit.add-to-cart"]',
      '[name="submit.add-to-cart"]',
    ];
    for (const sel of candidates) {
      const el = await page.$(sel);
      if (!el) continue;
      try {
        await Promise.all([
          page.waitForLoadState("domcontentloaded", { timeout: 45000 }),
          el.click(),
        ]);
        clicked = true;
        break;
      } catch (e) {
        process.stderr.write(`add click via ${sel} failed: ${e.message}\n`);
      }
    }
    if (!clicked) {
      try {
        const btn = page.getByRole("button", { name: /add to cart/i });
        if (await btn.count() > 0) {
          await Promise.all([
            page.waitForLoadState("domcontentloaded", { timeout: 45000 }),
            btn.first().click(),
          ]);
          clicked = true;
        }
      } catch (e) {
        process.stderr.write(`role-based add failed: ${e.message}\n`);
      }
    }
    if (!clicked) {
      const shot = `${os.tmpdir()}/amazon-add-fail-${addAsin}-${Date.now()}.png`;
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      const diag = await page.evaluate(() => {
        const t = (s) => (document.querySelector(s)?.innerText || "").replace(/\s+/g, " ").trim();
        return {
          title: t("#productTitle"),
          availability: t("#availability"),
          buyingOptions: !!document.querySelector("#buybox-see-all-buying-choices, a[title*='buying options' i]"),
        };
      }).catch(() => ({}));
      await browser.close();
      transientExit(`could not find Add-to-Cart button for ${addAsin} (url=${page.url()} title="${diag.title || ""}" availability="${diag.availability || ""}" buying_options=${!!diag.buyingOptions} screenshot=${shot})`);
    }

    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);

    gate = await detectManualGate(page);
    if (gate) {
      await browser.close();
      manualExit(gate.kind, gate.deeplink, { stage: "post-add" });
    }

    // Verify by re-reading the cart and confirming the ASIN is now an ACTIVE item.
    try {
      await page.goto("https://www.amazon.com/gp/cart/view.html",
        { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
    } catch (e) {
      await browser.close();
      transientExit(`post-add cart verify navigation failed: ${e.message}`);
    }
    const afterCart = await readCart(page);
    const beforeCount = cart.items.length;
    const afterCount = afterCart.items.length;

    // Per-ASIN quantity delta is the only honest verification. If the ASIN
    // was already in the cart, "presence of row" tells you nothing about
    // whether the click did anything — Amazon's silent-routing bug is
    // structurally indistinguishable from a no-op otherwise.
    const qtyByAsin = (rows) => {
      const m = new Map();
      for (const it of rows) {
        if (!it.asin) continue;
        m.set(it.asin, (m.get(it.asin) || 0) + (it.quantity || 1));
      }
      return m;
    };
    const beforeQty = qtyByAsin(cart.items).get(addAsin) || 0;
    const afterQty = qtyByAsin(afterCart.items).get(addAsin) || 0;
    const wasAlreadyThere = beforeAsins.has(addAsin);
    const expected = qtyArg;

    // Primary signal: per-ASIN qty went up by the requested amount.
    let confirmed = afterQty - beforeQty >= expected;
    let landed = afterCart.items.find((it) => it.asin === addAsin) || null;

    // Fallback: ASIN extraction failed on the freshly-added row. Only trust
    // this if (a) the item was NOT already in cart and (b) cart row count went
    // up by exactly one. Two conditions together prevent the silent-success
    // bug from masquerading as a fallback hit.
    if (!confirmed && !wasAlreadyThere && afterCount === beforeCount + 1) {
      const known = new Set(cart.items.map((it) => it.asin).filter(Boolean));
      const newRow = afterCart.items.find((it) => !it.asin || !known.has(it.asin));
      if (newRow) {
        confirmed = true;
        landed = newRow;
      }
    }

    if (!confirmed) {
      process.stdout.write(JSON.stringify({
        status: "add_failed",
        asin: addAsin,
        reason: wasAlreadyThere
          ? `ASIN was already in cart at qty ${beforeQty}; after click qty is ${afterQty} (Amazon silently dropped the add — likely items-of-interest routing)`
          : "click reported success but cart did not change (Amazon likely routed to items-of-interest)",
        cart_items: afterCount,
        cart_items_before: beforeCount,
        qty_before: beforeQty,
        qty_after: afterQty,
      }) + "\n");
      await browser.close();
      process.exit(7);
    }

    process.stdout.write(JSON.stringify({
      status: "added",
      asin: addAsin,
      title: landed ? landed.title : "",
      quantity: landed ? landed.quantity : qtyArg,
      cart_items: afterCount,
      cart_items_before: beforeCount,
      qty_before: beforeQty,
      qty_after: afterQty,
      was_already_in_cart: wasAlreadyThere,
    }) + "\n");
    await browser.close();
    process.exit(0);
  }

  // action === "checkout"
  // Click "Proceed to checkout" to reach order review. Amazon's cart DOM
  // changes frequently; try selector- and role-based locators in order, and
  // fall back to navigating directly to the SPC URL (works when the button is
  // hidden behind a JS handler we can't reach reliably).
  let proceeded = false;
  const proceedCandidates = [
    'input[name="proceedToRetailCheckout"]',
    '[data-feature-id="proceed-to-checkout-action"] input',
    '[data-feature-id="proceed-to-checkout-action"] button',
    'span#sc-buy-box-ptc-button input',
    'a[href*="/gp/buy/spc/handlers/display.html"]',
    'a[href*="/gp/buy/spc/"]',
  ];
  for (const sel of proceedCandidates) {
    const el = await page.$(sel);
    if (!el) continue;
    try {
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 45000 }),
        el.click(),
      ]);
      proceeded = true;
      break;
    } catch (e) {
      process.stderr.write(`proceed click failed via ${sel}: ${e.message}\n`);
    }
  }
  if (!proceeded) {
    // Try the role-based locator (Playwright walks accessibility tree).
    try {
      const btn = page.getByRole("button", { name: /proceed.*checkout/i });
      if (await btn.count() > 0) {
        await Promise.all([
          page.waitForLoadState("domcontentloaded", { timeout: 45000 }),
          btn.first().click(),
        ]);
        proceeded = true;
      }
    } catch (e) {
      process.stderr.write(`role-based proceed failed: ${e.message}\n`);
    }
  }
  if (!proceeded) {
    // Last resort: navigate directly to the SPC URL.
    try {
      await page.goto("https://www.amazon.com/gp/buy/spc/handlers/display.html?hasWorkingJavascript=1",
        { waitUntil: "domcontentloaded", timeout: 45000 });
      proceeded = true;
    } catch (e) {
      await browser.close();
      transientExit(`proceed-to-checkout failed via all paths: ${e.message}`);
    }
  }

  try {
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
  } catch (e) {
    // Non-fatal
  }

  // BYG / SSD ("Save a trip" grocery upsell) interstitial. When the user's cart
  // has an SSD-eligible item like a grocery good, Amazon routes the
  // proceed-to-checkout click through /checkout/byg/ before the real review
  // page. Detect and click through; gating happens again post-click.
  if (/\/checkout\/byg\//.test(page.url())) {
    process.stderr.write(`BYG interstitial detected at ${page.url()}; clicking through\n`);
    const bygBtn =
      (await page.$('#checkout-byg-ptc-button')) ||
      (await page.$('a[id*="byg-ptc"], a[name*="byg-ptc"]'));
    if (bygBtn) {
      try {
        await Promise.all([
          page.waitForLoadState("domcontentloaded", { timeout: 45000 }),
          bygBtn.click(),
        ]);
        await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);
      } catch (e) {
        process.stderr.write(`BYG click-through failed: ${e.message}\n`);
      }
    } else {
      process.stderr.write("no #checkout-byg-ptc-button found on BYG interstitial\n");
    }
    // Re-check gate after BYG click — Amazon typically routes to /ap/signin
    // with a max_auth_age=900 challenge, which detectManualGate already
    // classifies as kind="sign-in" → exit 9 with deeplink.
    gate = await detectManualGate(page);
    if (gate) {
      await browser.close();
      manualExit(gate.kind, gate.deeplink, { stage: "post-byg" });
    }
  }

  gate = await detectManualGate(page);
  if (gate) {
    await browser.close();
    manualExit(gate.kind, gate.deeplink, { stage: "post-proceed" });
  }

  // Re-read defaults from the more-authoritative order-review page.
  const reviewDefaults = await readDefaults(page);
  const previewCart = await readCart(page).catch(() => ({ items: [], subtotal: "" }));

  if (!wantPlace) {
    process.stdout.write(JSON.stringify({
      status: "review_ready",
      items: previewCart.items.length ? previewCart.items : cart.items,
      subtotal: previewCart.subtotal || cart.subtotal,
      default_address: reviewDefaults.address || defaults.address,
      default_card_last4: reviewDefaults.card_last4 || defaults.card_last4,
      review_url: page.url(),
    }) + "\n");
    await browser.close();
    process.exit(0);
  }

  // Place the order.
  const placeBtn =
    (await page.$('input[name="placeYourOrder1"]')) ||
    (await page.$('#placeYourOrder input')) ||
    (await page.$('input[aria-labelledby*="placeYourOrder"]')) ||
    (await page.$('.place-order-button input'));

  if (!placeBtn) {
    await browser.close();
    transientExit("no place-order button found on review page");
  }

  try {
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: 60000 }),
      placeBtn.click(),
    ]);
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
  } catch (e) {
    await browser.close();
    transientExit(`place-order click failed: ${e.message}`);
  }

  // Check for post-place gate.
  gate = await detectManualGate(page);
  if (gate) {
    await browser.close();
    manualExit(gate.kind, gate.deeplink, { stage: "post-place" });
  }

  // Extract the order ID(s) from the confirmation page.
  const confirmation = await readConfirmation(page);
  let orderIds = confirmation.order_ids;
  let orderIdsSource = "confirmation_page";
  let capturePath = "";
  let historyCheck = "";
  if (!orderIds.length) {
    // Capture BEFORE navigating away to order history.
    capturePath = await captureThankYou(page);
    const asins = [...new Set((previewCart.items.length ? previewCart.items : cart.items).map((i) => i.asin).filter(Boolean))];
    const found = await findPlacedOrders(page, asins);
    orderIds = found.ids;
    historyCheck = found.history_check;
    orderIdsSource = "order_history";
  }

  if (!orderIds.length) {
    // We placed the order but couldn't find an order number anywhere — return
    // the URL and purchase ID so the agent can verify by hand.
    process.stdout.write(JSON.stringify({
      status: "placed_unconfirmed",
      confirmation_url: confirmation.url,
      purchase_id: confirmation.purchase_id || undefined,
      history_check: historyCheck || undefined,
      capture_path: capturePath || undefined,
    }) + "\n");
    await browser.close();
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    status: "placed",
    order_id: orderIds[0],
    order_ids: orderIds,
    order_ids_source: orderIdsSource,
    capture_path: capturePath || undefined,
    purchase_id: confirmation.purchase_id || undefined,
    confirmation_url: confirmation.url,
    default_address: reviewDefaults.address || defaults.address,
    default_card_last4: reviewDefaults.card_last4 || defaults.card_last4,
  }) + "\n");
  await browser.close();
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`unhandled: ${e.stack || e.message}\n`);
  process.exit(7);
});
