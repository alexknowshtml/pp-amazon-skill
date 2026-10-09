// orders.mjs — order-history card parsing, the thank-you page reader, and
// the order-history fallback used when the thank-you page shows no numbers.

import { detectManualGate } from "./browser.mjs";

// Order-history card parsing, shared by history-sync and the checkout
// confirmation fallback. Handles both modern and legacy DOM shapes.
export async function parseOrderCards(page, sourceTag) {
  return await page.evaluate((src) => {
    function text(el) { return (el && (el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim(); }
    function findHeaderValue(card, captionRegex) {
      const lis = card.querySelectorAll("li.order-header__header-list-item, [class*='order-header']");
      for (const li of lis) {
        const cap = li.querySelector(".a-color-secondary.a-text-caps") || li.querySelector(".a-row.a-size-mini");
        if (cap && captionRegex.test(text(cap))) {
          const rows = li.querySelectorAll(".a-row");
          for (const row of rows) {
            const t = text(row);
            if (t && !captionRegex.test(t) && !row.querySelector(".a-color-secondary.a-text-caps")) {
              return t;
            }
          }
        }
      }
      // Modern shape: look for label/value spans.
      const labels = card.querySelectorAll(".a-size-mini.a-color-secondary, [class*='date-label']");
      for (const lbl of labels) {
        if (captionRegex.test(text(lbl))) {
          const sibling = lbl.parentElement?.querySelector(".a-size-base, [class*='value']");
          if (sibling && sibling !== lbl) {
            const t = text(sibling);
            if (t) return t;
          }
        }
      }
      // Oct 2026 shape: #orderCardHeader .a-column, each holding a label
      // row ("Order placed") and a value row ("October 9, 2026").
      for (const col of card.querySelectorAll("#orderCardHeader .a-column")) {
        const rows = col.querySelectorAll(".a-row");
        if (rows.length >= 2 && captionRegex.test(text(rows[0]))) {
          const t = text(rows[1]);
          if (t) return t;
        }
      }
      return "";
    }
    const out = [];
    // Match legacy (.order-card), modern card shells (after hydration), and
    // the Oct 2026 shape where each card is div#orderCard (id repeats per
    // card). Keep only the outermost match so nested shells parse once.
    const CARD_SEL = ".order-card, [data-component='order-card'], [data-yo-orders-order-id], [id='orderCard']";
    const cards = [...document.querySelectorAll(CARD_SEL)]
      .filter((el) => !(el.parentElement && el.parentElement.closest(CARD_SEL)));
    cards.forEach((card) => {
      // Skip skeleton placeholders.
      if (card.querySelector("[class*='Skeleton']") && !card.querySelector("a[href*='/dp/'], a[href*='/gp/product/']")) {
        return;
      }
      const idText = text(card.querySelector("#orderIdField, .yohtmlc-order-id, [class*='order-id'], bdi"));
      const dataOrderId = card.getAttribute && card.getAttribute("data-yo-orders-order-id");
      const detailHref = card.querySelector("a[href*='order-details?orderID=']")?.getAttribute("href") || "";
      const idMatch = (dataOrderId || idText || detailHref).match(/(\d{3}-\d{7}-\d{7})/);
      const orderId = idMatch ? idMatch[1] : "";
      const placedAt = findHeaderValue(card, /Order\s*placed|placed/i);
      const total = findHeaderValue(card, /^Total$/i);
      const items = [];
      const seenAsins = new Set();
      const itemContainers = card.querySelectorAll(".a-fixed-left-grid, .item-box, .yohtmlc-item, [class*='product-image-container']");
      itemContainers.forEach((row) => {
        const link = row.querySelector("a[href*='/dp/'], a[href*='/gp/product/']");
        if (!link) return;
        const href = link.getAttribute("href") || link.href || "";
        const m = href.match(/\/(?:gp\/product|dp)\/([A-Z0-9]{10})/);
        const asin = m ? m[1] : "";
        if (!asin || seenAsins.has(asin)) return;
        seenAsins.add(asin);
        let title = "";
        row.querySelectorAll("a").forEach((a) => {
          if (!title) {
            const t = text(a);
            if (t && t.length > 3) title = t;
          }
        });
        items.push({ asin, title, quantity: 1 });
      });
      if (!items.length) {
        // Oct 2026 shape has no per-item grid wrapper; read the product
        // links directly. The image link carries a bare-number quantity
        // badge ("2"); that is the quantity, never the title.
        card.querySelectorAll("a[href*='/dp/'], a[href*='/gp/product/']").forEach((a) => {
          const m = (a.getAttribute("href") || "").match(/\/(?:gp\/product|dp)\/([A-Z0-9]{10})/);
          if (!m) return;
          let item = items.find((it) => it.asin === m[1]);
          if (!item) { item = { asin: m[1], title: "", quantity: 1 }; items.push(item); }
          const t = text(a);
          if (/^\d+$/.test(t)) item.quantity = parseInt(t, 10);
          else if (t.length > item.title.length) item.title = t;
        });
      }
      if (orderId) out.push({ order_id: orderId, placed_at: placedAt, total, items, _source: src });
    });
    return out;
  }, sourceTag);
}

export async function waitForOrderCards(page) {
  // The modern /your-orders page renders ~1100 skeleton placeholders, then
  // JS replaces them with real cards. Wait for either real cards to appear
  // or the skeleton count to drop to ~zero.
  try {
    await page.waitForFunction(() => {
      const hasRealCard = !!document.querySelector(".order-card a[href*='/dp/'], [data-component='order-card'] a[href*='/dp/'], [data-yo-orders-order-id], [id='orderCard'] a[href*='/dp/']");
      const skeletons = document.querySelectorAll("[class*='Skeleton']").length;
      return hasRealCard || skeletons < 10;
    }, { timeout: 30000 });
  } catch (e) { /* fall through with whatever we have */ }
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

// Read every order number off the thank-you page. Amazon splits one checkout
// into several orders (different sellers or ship dates) and the page then
// lists each one. The URL's purchaseId has the same ###-#######-####### shape
// but is NOT an order number, so it is dropped. The page hydrates late, so
// poll briefly before giving up.
export async function readConfirmation(page) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const res = await page.evaluate(() => {
      const url = window.location.href;
      let purchaseId = "";
      try { purchaseId = new URL(url).searchParams.get("purchaseId") || ""; } catch (e) { /* keep empty */ }
      const ids = new Set();
      document.querySelectorAll("a[href]").forEach((a) => {
        const m = (a.getAttribute("href") || "").match(/order_?id=(\d{3}-\d{7}-\d{7})/i);
        if (m) ids.add(m[1]);
      });
      const body = (document.body && document.body.innerText) || "";
      for (const m of body.matchAll(/\b(\d{3}-\d{7}-\d{7})\b/g)) ids.add(m[1]);
      if (purchaseId) ids.delete(purchaseId);
      return { order_ids: [...ids], purchase_id: purchaseId, url };
    });
    if (res.order_ids.length || Date.now() > deadline) return res;
    await page.waitForTimeout(1500);
  }
}

// Fallback when the thank-you page shows no order numbers: open order history
// and take today's orders that contain an ASIN from the cart we just bought.
// Amazon sometimes bounces this page to /ap/signin even with working cookies
// (seen once Oct 2026, cleared on its own within ~15 min). Report that as its
// own outcome instead of an empty list, so the caller knows the check never ran.
export async function findPlacedOrders(page, asins) {
  if (!asins.length) return { ids: [], history_check: "no_asins" };
  try {
    await page.goto("https://www.amazon.com/your-orders/orders", { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    process.stderr.write(`order-history fallback navigation failed: ${e.message}\n`);
    return { ids: [], history_check: "navigation_failed" };
  }
  const gate = await detectManualGate(page);
  if (gate) return { ids: [], history_check: `blocked_${gate.kind}` };
  await waitForOrderCards(page);
  const orders = await parseOrderCards(page, "checkout-fallback").catch(() => []);
  const ids = matchPlacedOrders(orders, asins);
  return { ids, history_check: ids.length ? "found" : (orders.length ? "no_match" : "no_orders_parsed") };
}

// Today's orders (America/New_York) that contain at least one of the ASINs.
export function matchPlacedOrders(orders, asins, now = new Date()) {
  const today = now.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" });
  const want = new Set(asins);
  return orders
    .filter((o) => (o.placed_at || "").includes(today))
    .filter((o) => (o.items || []).some((it) => want.has(it.asin)))
    .map((o) => o.order_id);
}
