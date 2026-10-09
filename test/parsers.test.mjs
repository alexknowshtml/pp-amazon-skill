// Parser tests. Run with: npm test
//
// Synthetic pages in test/synthetic/ are hand-built and committed. Scrubbed
// captures of real pages live in test/fixtures/ and stay out of git (they
// still list what was bought); those tests skip when the files are absent.
// Make them with tools/capture-pages.mjs, then tools/scrub-fixture.mjs.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { readCart } from "../lib/cart.mjs";
import { parseOrderCards, matchPlacedOrders } from "../lib/orders.mjs";
import { checkCart, checkOrders } from "../lib/health.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const synthetic = (f) => path.join(here, "synthetic", f);
const fixture = (f) => path.join(here, "fixtures", f);

let browser, page;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox"],
  });
  // Page scripts stay off: the parsers must work on the saved DOM alone.
  page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
});
after(async () => { await browser?.close(); });

async function load(file) {
  await page.setContent(fs.readFileSync(file, "utf8"), { waitUntil: "domcontentloaded" });
}

// ----- cart -----

test("cart: reads each row's own fields and skips saved-for-later", async () => {
  await load(synthetic("cart-two-items.html"));
  const cart = await readCart(page);
  assert.deepEqual(cart.items, [
    { asin: "B0ENVELOPE", title: "Mead #10 Envelopes", quantity: 2, price: "$12.49" },
    { asin: "B0MARKERSX", title: "EXPO Dry Erase Markers", quantity: 1, price: "$8.00" },
  ]);
  assert.equal(cart.subtotal, "$32.98");
  assert.deepEqual(await checkCart(page, cart), []);
});

test("cart health: flags a page whose items the parser cannot see", async () => {
  await load(synthetic("cart-renamed.html"));
  const cart = await readCart(page);
  assert.equal(cart.items.length, 0);
  const codes = (await checkCart(page, cart)).map((w) => w.code);
  assert.deepEqual(codes, ["cart_parse_empty"]);
});

test("cart health: flags items missing fields", async () => {
  await load(synthetic("cart-two-items.html"));
  const codes = (await checkCart(page, {
    items: [{ asin: "B0ENVELOPE", title: "", quantity: -1, price: "" }],
    subtotal: "",
  })).map((w) => w.code);
  assert.deepEqual(codes, ["cart_missing_title", "cart_missing_quantity", "cart_missing_price", "cart_missing_subtotal"]);
});

test("cart (live capture): empty cart parses as empty with no warning",
  { skip: !fs.existsSync(fixture("cart-empty-2026-10.html")) && "fixture not present" }, async () => {
    await load(fixture("cart-empty-2026-10.html"));
    const cart = await readCart(page);
    assert.deepEqual(cart, { items: [], subtotal: "" });
    assert.deepEqual(await checkCart(page, cart), []);
  });

// ----- order history -----

test("orders (live capture): Oct 2026 card layout",
  { skip: !fs.existsSync(fixture("order-history-2026-10.html")) && "fixture not present" }, async () => {
    await load(fixture("order-history-2026-10.html"));
    const orders = await parseOrderCards(page, "test");
    assert.equal(orders.length, 10);
    for (const o of orders) {
      assert.match(o.order_id, /^\d{3}-\d{7}-\d{7}$/);
      assert.match(o.placed_at, /^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
      assert.match(o.total, /^\$\d+\.\d{2}$/);
      assert.ok(o.items.length >= 1);
      for (const it of o.items) {
        assert.match(it.asin, /^[A-Z0-9]{10}$/);
        assert.ok(it.title.length > 3, `title for ${it.asin}`);
        assert.ok(!/^\d+$/.test(it.title), "quantity badge read as title");
      }
    }
    // Multi-item order and quantity badge.
    const six = orders.find((o) => o.order_id === "111-0000000-0000006");
    assert.deepEqual(six.items.map((i) => [i.asin, i.quantity]), [["B0004F7GUI", 2], ["B0CP9H4BDG", 2]]);
    assert.equal(orders.find((o) => o.order_id === "111-0000000-0000009").items[0].quantity, 3);
    assert.deepEqual(await checkOrders(page, orders), []);
  });

test("orders health: flags order numbers the parser cannot see", async () => {
  await load(synthetic("orders-renamed.html"));
  const orders = await parseOrderCards(page, "test");
  assert.equal(orders.length, 0);
  const warnings = await checkOrders(page, orders);
  assert.deepEqual(warnings.map((w) => w.code), ["orders_parse_empty"]);
  assert.match(warnings[0].detail, /shows 1 order numbers/);
});

test("orders health: a real empty history is not a warning", async () => {
  await load(synthetic("orders-empty.html"));
  const orders = await parseOrderCards(page, "test");
  assert.deepEqual(await checkOrders(page, orders), []);
});

test("orders health: flags partial orders", async () => {
  await load(synthetic("orders-empty.html"));
  const codes = (await checkOrders(page, [{ order_id: "111-0000000-0000001", placed_at: "", total: "", items: [] }]))
    .map((w) => w.code);
  assert.deepEqual(codes, ["orders_missing_date", "orders_missing_total", "orders_missing_items"]);
});

// ----- matchPlacedOrders (pure) -----

test("matchPlacedOrders: today's orders holding a cart ASIN", () => {
  const orders = [
    { order_id: "A", placed_at: "October 9, 2026", items: [{ asin: "B0ENVELOPE" }] },
    { order_id: "B", placed_at: "October 9, 2026", items: [{ asin: "B0OTHERXXX" }] },
    { order_id: "C", placed_at: "October 8, 2026", items: [{ asin: "B0ENVELOPE" }] },
    { order_id: "D", placed_at: "October 9, 2026", items: [{ asin: "B0MARKERSX" }] },
  ];
  // 3am UTC on the 10th is still the 9th in New York.
  const now = new Date("2026-10-10T03:00:00Z");
  assert.deepEqual(matchPlacedOrders(orders, ["B0ENVELOPE", "B0MARKERSX"], now), ["A", "D"]);
});
