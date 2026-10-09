// health.mjs — notice when a parser comes back wrong because Amazon changed
// its page markup. A parser that silently returns [] looks the same as an
// empty cart, so each check compares the parse result against what the page
// itself says. Any warning means "the page changed; the parser needs work".

import fs from "node:fs";
import path from "node:path";

// Cart: zero items is only believable when Amazon says the cart is empty.
export async function checkCart(page, cart) {
  const body = await page.evaluate(() => (document.body && document.body.innerText) || "");
  const warnings = [];
  if (!cart.items.length) {
    if (!/your amazon cart is empty/i.test(body)) {
      warnings.push({ code: "cart_parse_empty", detail: "parsed 0 items but the page does not say the cart is empty" });
    }
    return warnings;
  }
  const noTitle = cart.items.filter((it) => !it.title).length;
  const noQty = cart.items.filter((it) => !(it.quantity > 0)).length;
  const noPrice = cart.items.filter((it) => !it.price).length;
  if (noTitle) warnings.push({ code: "cart_missing_title", detail: `${noTitle} of ${cart.items.length} items have no title` });
  if (noQty) warnings.push({ code: "cart_missing_quantity", detail: `${noQty} of ${cart.items.length} items have no quantity` });
  if (noPrice) warnings.push({ code: "cart_missing_price", detail: `${noPrice} of ${cart.items.length} items have no price` });
  if (!cart.subtotal) warnings.push({ code: "cart_missing_subtotal", detail: "items parsed but no subtotal found" });
  return warnings;
}

// Order history: zero orders is only believable when the page shows no order
// numbers. Orders that parse without a date, total or items are partial.
export async function checkOrders(page, orders) {
  const body = await page.evaluate(() => (document.body && document.body.innerText) || "");
  const warnings = [];
  if (!orders.length) {
    const visible = new Set(body.match(/\b\d{3}-\d{7}-\d{7}\b/g) || []).size;
    if (visible) {
      warnings.push({ code: "orders_parse_empty", detail: `parsed 0 orders but the page shows ${visible} order numbers` });
    } else if (!/have not placed any orders|no orders/i.test(body)) {
      warnings.push({ code: "orders_unrecognized", detail: "parsed 0 orders and the page shows neither orders nor an empty message" });
    }
    return warnings;
  }
  const noDate = orders.filter((o) => !o.placed_at).length;
  const noTotal = orders.filter((o) => !o.total).length;
  const noItems = orders.filter((o) => !(o.items || []).length).length;
  if (noDate) warnings.push({ code: "orders_missing_date", detail: `${noDate} of ${orders.length} orders have no date` });
  if (noTotal) warnings.push({ code: "orders_missing_total", detail: `${noTotal} of ${orders.length} orders have no total` });
  if (noItems) warnings.push({ code: "orders_missing_items", detail: `${noItems} of ${orders.length} orders have no items` });
  return warnings;
}

// Save the page that tripped a warning, next to the profile's cookies, so the
// parser can be fixed against the exact markup. Keeps seven days of captures.
// Raw captures hold personal data: they stay private and are scrubbed with
// tools/scrub-fixture.mjs before becoming a test fixture.
export async function captureBrokenPage(page, cookiesPath, kind) {
  try {
    const dir = path.join(path.dirname(cookiesPath), "captures");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (f.startsWith("broken-") && fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    }
    const file = path.join(dir, `broken-${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.html`);
    fs.writeFileSync(file, `<!-- ${page.url()} -->\n` + (await page.content()), { mode: 0o600 });
    return file;
  } catch (e) {
    process.stderr.write(`broken-page capture failed: ${e.message}\n`);
    return "";
  }
}
