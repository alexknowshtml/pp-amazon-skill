#!/usr/bin/env node
// scrub-fixture.mjs — turn a raw page capture into a test fixture
// with no personal identifiers. Purchases stay visible, so fixtures remain
// local (test/fixtures/ is gitignored).
//
// Usage: node tools/scrub-fixture.mjs <raw.html> <out.html> --pii "Name,Street,..."
//
// What it does, inside a JS-disabled browser page:
//   - drops scripts, styles, iframes, images, comments and popover preloads
//     (the Ship-to popovers carry the full address)
//   - keeps only attributes the parsers read; hrefs keep their path and the
//     orderID param only (no session or tracking params)
//   - remaps order numbers to fake ones, consistently across text and hrefs
//   - replaces every --pii term, email, phone and "ST 12345" zip in text
// Then it re-reads the output and refuses to write if any of those survive.

import fs from "node:fs";
import { chromium } from "playwright";

const [, , rawPath, outPath, ...rest] = process.argv;
const piiIdx = rest.indexOf("--pii");
const pii = piiIdx >= 0 ? rest[piiIdx + 1].split(",").map((s) => s.trim()).filter(Boolean) : [];
if (!rawPath || !outPath || !pii.length) {
  console.error('usage: scrub-fixture.mjs <raw.html> <out.html> --pii "Name,Street,..."');
  process.exit(2);
}

const raw = fs.readFileSync(rawPath, "utf8");
const urlComment = (raw.match(/^<!-- (\S+) -->/) || [])[1] || "";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ javaScriptEnabled: false });
const page = await context.newPage();
await page.setContent(raw, { waitUntil: "domcontentloaded" });

const html = await page.evaluate((pii) => {
  const KEEP_ATTRS = new Set([
    "id", "class", "name", "type", "role", "aria-label", "aria-hidden",
    "data-asin", "data-quantity", "data-price", "data-itemtype", "data-name",
    "data-component", "data-yo-orders-order-id", "data-feature-id", "data-action",
    "href", "value", "selected",
  ]);
  document.querySelectorAll("script, style, link, noscript, iframe, img, svg, video, template, meta, .a-popover-preload, [id^='a-popover']")
    .forEach((el) => el.remove());
  // Structural scrub: whole regions that hold names and addresses, so we
  // never depend on knowing every name (Ship-to can be anyone on the account).
  const nav = document.querySelector("#navbar, #nav-belt, header");
  if (nav) {
    const count = (document.querySelector("#nav-cart-count")?.textContent || "0").trim();
    const stub = document.createElement("div");
    stub.id = "navbar";
    stub.innerHTML = `<span id="nav-link-accountList-nav-line-1">Hello, REDACTED</span>` +
      `<span id="nav-cart-count" class="nav-cart-count">${count.replace(/\D/g, "") || "0"}</span>`;
    nav.replaceWith(stub);
  }
  document.querySelectorAll("#nav-flyout-anchor, [id^='nav-flyout'], #nav-global-location-slot, #glow-ingress-block")
    .forEach((el) => el.remove());
  document.querySelectorAll("[id*='FilterDropdown' i], [id*='paidBy' i], [id*='orderedBy' i], [class*='recipient' i]")
    .forEach((el) => { el.textContent = "REDACTED"; });
  const PERSON_LABEL = /^(ship to|placed by|paid by|ordered by|recipient)\b/i;
  document.querySelectorAll("#orderCardHeader .a-column, li.order-header__header-list-item, .order-header .a-column").forEach((col) => {
    const rows = [...col.querySelectorAll(".a-row")];
    const label = (rows[0]?.textContent || col.textContent || "").replace(/\s+/g, " ").trim();
    if (!PERSON_LABEL.test(label)) return;
    if (rows.length > 1) rows.slice(1).forEach((r) => { r.textContent = "REDACTED"; });
    else col.textContent = label.split(/\s+/).slice(0, 2).join(" ") + " REDACTED";
  });
  // Any remaining "Ship to X" / "Placed by X" text runs.
  const tw0 = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  while (tw0.nextNode()) {
    const n = tw0.currentNode;
    n.nodeValue = n.nodeValue.replace(/[\u200b-\u200f\ufeff]/g, "")
      .replace(/\b(Ship to|Placed by|Paid by|Ordered by)\b\s*:?\s*[^\n]+/gi, "$1 REDACTED");
  }

  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.remove());

  // Fake order numbers, stable per real number.
  const idMap = new Map();
  const fakeId = (real) => {
    if (!idMap.has(real)) idMap.set(real, `111-0000000-${String(idMap.size + 1).padStart(7, "0")}`);
    return idMap.get(real);
  };
  const ORDER_RE = /\b\d{3}-\d{7}-\d{7}\b/g;
  // Customer and seller ids (A + 11-14 caps/digits). ATVPDKIKX0DER is the
  // public amazon.com marketplace id; ASINs are 10 chars and never match.
  const ACCT_RE = /A[0-9A-Z]{11,14}(?=[^0-9A-Z]|$)/g;
  const scrubIds = (v) => v.replace(ORDER_RE, fakeId)
    .replace(ACCT_RE, (m) => (m === "ATVPDKIKX0DER" || !/\d/.test(m) ? m : "A0000000000000"));

  for (const el of document.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const n = attr.name;
      if (!KEEP_ATTRS.has(n)) { el.removeAttribute(n); continue; }
      if (n === "value" && el.tagName === "INPUT" && !/quantity/i.test(el.getAttribute("name") || "")) {
        el.removeAttribute(n); continue;
      }
      if (n === "href") {
        const h = attr.value;
        let kept = "#";
        try {
          const u = new URL(h, "https://www.amazon.com");
          const oid = u.searchParams.get("orderID") || u.searchParams.get("orderId");
          kept = u.pathname.replace(/\/ref=[^/]*$/, "") + (oid ? `?orderID=${oid}` : "");
        } catch (e) { /* keep "#" */ }
        el.setAttribute("href", scrubIds(kept));
        continue;
      }
      // Random-looking values (render instance ids, possible tokens) go.
      // The parsers never read them.
      const v = scrubIds(attr.value);
      const looksRandom = (w) => w.length >= 20 && /[A-Z]/.test(w) && /[a-z]/.test(w) && (w.match(/\d/g) || []).length >= 3;
      el.setAttribute(n, v.split(/(\s+)/).map((w) => (looksRandom(w.replace(/A0{13}/g, "")) ? "scrubbed" : w)).join(""));
    }
  }

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const termRes = pii.map((t) => new RegExp(`\\b${esc(t)}\\b`, "gi"));
  const tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) {
    const node = tw.currentNode;
    let t = node.nodeValue;
    t = scrubIds(t);
    for (const re of termRes) t = t.replace(re, "REDACTED");
    t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, "redacted@example.com");
    t = t.replace(/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, "555-555-0100");
    t = t.replace(/\b([A-Z]{2}) \d{5}(-\d{4})?\b/g, "$1 00000");
    node.nodeValue = t;
  }
  return "<!doctype html>\n" + document.documentElement.outerHTML;
}, pii);
await browser.close();

// Leak check on the final text.
const leaks = [];
for (const t of pii) if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(html)) leaks.push(`term "${t}"`);
if (/[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[a-z]{2,}/.test(html)) leaks.push("email address");
const realIds = (html.match(/\b\d{3}-\d{7}-\d{7}\b/g) || []).filter((id) => !id.startsWith("111-0000000-"));
if (realIds.length) leaks.push(`order number ${realIds[0]}`);
const acct = (html.match(/A[0-9A-Z]{11,14}(?=[^0-9A-Z]|$)/g) || [])
  .filter((m) => m !== "ATVPDKIKX0DER" && m !== "A0000000000000" && /\d/.test(m));
if (acct.length) leaks.push(`account-style id ${acct[0]}`);
// Session tokens are long runs mixing digits and both cases with no
// separators; Amazon's long element ids and class names use hyphens.
const tokenish = [...html.matchAll(/="([A-Za-z0-9+/_=]{32,})"/g)].map((m) => m[1])
  .map((v) => v.replace(/A0{13}/g, ""))
  .filter((v) => /[A-Z]/.test(v) && /[a-z]/.test(v) && (v.match(/\d/g) || []).length >= 4);
if (tokenish.length) leaks.push(`token-like attribute(s) ${[...new Set(tokenish)].slice(0, 5).map((v) => v.slice(0, 30)).join(" ")}`);
if (leaks.length) {
  console.error(`refusing to write ${outPath}; still contains: ${leaks.join(", ")}`);
  process.exit(1);
}
const header = `<!-- scrubbed fixture from ${urlComment.replace(/\?.*$/, "")} captured ${new Date().toISOString().slice(0, 10)} -->\n`;
fs.writeFileSync(outPath, header + html);
console.log(`${outPath} ${Math.round(html.length / 1024)}KB`);
