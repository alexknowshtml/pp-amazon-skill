// cart.mjs — read the cart page and the default address / card shown on
// cart and order-review pages. Both run inside the page (page.evaluate).

export async function readCart(page) {
  return await page.evaluate(() => {
    function txt(el) { return (el && (el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim(); }
    // Amazon often renders titles twice (visible + screen-reader copy);
    // collapse "X X" into "X" when both halves are equal.
    function dedupTitle(t) {
      if (!t) return t;
      // Only an exact repeat counts. The old second clause matched any title
      // with a space near its midpoint ("Mead #10 Envelopes" -> "Mead #10").
      const half = Math.floor(t.length / 2);
      const left = t.slice(0, half).trim();
      const right = t.slice(half).trim();
      if (left.length > 5 && left === right) return left;
      return t;
    }
    const items = [];
    // Find a saved-for-later boundary by document position. Any .sc-list-item
    // that appears AFTER this point is excluded. This works even if Amazon
    // changes the data-name attribute or class structure, because the boundary
    // text is the actual user-visible heading.
    const savedBoundary = (() => {
      // Restrict to actual section headings — links and small divs elsewhere
      // can contain "Saved for later" too (sidebar nav, account menu), and
      // those would incorrectly exclude active items that follow them.
      const candidates = [
        ...document.querySelectorAll("h1,h2,h3,h4"),
        ...document.querySelectorAll('[data-name*="Saved" i]'),
      ];
      for (const el of candidates) {
        const t = (el.innerText || el.textContent || "").trim();
        if (/^Saved for later(?:\s|$|\()/i.test(t) && t.length < 60) return el;
      }
      return null;
    })();
    const isAfterBoundary = (el) =>
      savedBoundary && (savedBoundary.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);

    const ASIN_RE = /^[A-Z0-9]{10}$/;
    const asinOf = (el) => {
      const a = el && el.getAttribute && el.getAttribute("data-asin");
      return a && ASIN_RE.test(a) ? a : "";
    };
    const asinFromHref = (href) => {
      const m = (href || "").match(/\/(?:gp\/product|dp)\/([A-Z0-9]{10})/);
      return m ? m[1] : "";
    };

    // Row discovery. Each active cart item is one [data-asin] element under
    // #sc-active-cart that carries data-quantity/data-price. Only the
    // OUTERMOST [data-asin] element counts — nested ones are add-ons,
    // "compare similar" widgets, or recommendations rendered inside the row,
    // and reading fields from them is how the Tork-towel title ended up
    // paired with the envelopes ASIN (Oct 9 2026).
    const cartRoot = document.querySelector("#sc-active-cart") || document.querySelector('[data-name="Active Items"]');
    let rows = [];
    if (cartRoot) {
      rows = [...cartRoot.querySelectorAll("[data-asin]")].filter((el) => {
        if (!asinOf(el)) return false;
        const outer = el.parentElement && el.parentElement.closest("[data-asin]");
        return !outer || !cartRoot.contains(outer);
      });
    }
    if (rows.length === 0) {
      // Legacy fallback: class-based rows. .sc-list-item-content sits INSIDE
      // .sc-list-item, so keep only the outermost match to avoid doubles.
      rows = [...document.querySelectorAll(".sc-list-item, .sc-list-item-content")]
        .filter((el) => !(el.parentElement && el.parentElement.closest(".sc-list-item, .sc-list-item-content")));
    }
    // Active-cart positive identification: a row only counts as an actual cart
    // item if it has at least one of the controls that ONLY active cart rows
    // expose — a quantity selector, a delete action, or a "Save for later"
    // action. Recommendations, items-of-interest, buy-it-again, and
    // saved-for-later rows can share the same .sc-list-item-content class but
    // never have all of these.
    function isActiveCartRow(row) {
      const hasQtySelect = !!row.querySelector('select[name^="quantity"], .sc-quantity-textfield, [data-feature-id="quantity"] select');
      const hasDelete = !!row.querySelector('input[data-action="delete"], [data-action="delete-active"], [aria-label*="Delete" i], [value="Delete"]');
      const hasSaveForLater = !!row.querySelector('input[data-action="save-for-later"], [data-action="save-for-later"], [aria-label*="Save for later" i], [value*="Save for later" i]');
      return hasQtySelect || hasDelete || hasSaveForLater || row.hasAttribute("data-quantity");
    }

    const seen = new Set();
    rows.forEach((row) => {
      if (isAfterBoundary(row)) return;
      // Also reject if any ancestor's data-name says "Saved..."
      let p = row;
      while (p && p !== document.body) {
        const name = p.getAttribute && p.getAttribute("data-name");
        if (name && /saved/i.test(name)) return;
        p = p.parentElement;
      }
      if (row.getAttribute("data-itemtype") && row.getAttribute("data-itemtype") !== "active") return;
      // POSITIVE check: must look like an active-cart row.
      if (!isActiveCartRow(row)) return;

      // Every field below is read from THIS row only. No ancestor walks: an
      // ancestor can belong to a different item (or the whole cart).
      let asin = asinOf(row);
      const links = [...row.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')];
      if (!asin) {
        // No data-asin on the row: take the ASIN from the first product link.
        asin = links.length ? asinFromHref(links[0].getAttribute("href") || links[0].href) : "";
      }
      if (asin && seen.has(asin)) return;
      if (asin) seen.add(asin);

      // Title: the product link that points at THIS row's ASIN, then the
      // row's own .sc-product-title. Never a link to a different ASIN.
      let title = "";
      const ownLink = links.find((a) => asinFromHref(a.getAttribute("href") || a.href) === asin);
      if (ownLink) title = txt(ownLink.querySelector(".sc-product-title, .a-truncate-full") || ownLink);
      if (!title) {
        const titleEl = row.querySelector(".sc-product-title, .a-truncate-full, .a-truncate-cut");
        title = txt(titleEl);
      }
      title = dedupTitle(title);

      const dataPrice = row.getAttribute("data-price");
      const price = dataPrice && /^\d+(\.\d+)?$/.test(dataPrice)
        ? `$${parseFloat(dataPrice).toFixed(2)}`
        : txt(row.querySelector('.sc-product-price, [data-action="show-price-details"] .a-color-price'));

      // Qty parsing — authoritative sources first. S&S items show frequency
      // ("2 months") in a separate dropdown-prompt, so a naive \d+ is unsafe.
      const qty = (() => {
        const dq = row.getAttribute("data-quantity");
        if (dq && /^\d+$/.test(dq)) return parseInt(dq, 10);
        let el = row.querySelector('.sc-quantity-textfield, .sc-product-quantity');
        if (el) {
          const v = el.value || el.innerText || el.textContent || "";
          const m = v.match(/^\s*(\d+)/);
          if (m) return parseInt(m[1], 10);
        }
        el = row.querySelector('select[name^="quantity"]');
        if (el && el.value && /^\d+$/.test(el.value)) return parseInt(el.value, 10);
        el = row.querySelector('input[type="hidden"][name^="quantity"]');
        if (el && el.value && /^\d+$/.test(el.value)) return parseInt(el.value, 10);
        // Aria-label "Quantity 3" — REQUIRE the word "Quantity".
        const ariaEl = row.querySelector('[aria-label*="Quantity" i]');
        if (ariaEl) {
          const m = (ariaEl.getAttribute("aria-label") || "").match(/Quantity[^0-9]*(\d+)/i);
          if (m) return parseInt(m[1], 10);
        }
        el = row.querySelector('[data-feature-id="quantity"] .a-dropdown-prompt');
        if (el) {
          const m = (el.innerText || "").match(/^\s*(\d+)\s*$/);
          if (m) return parseInt(m[1], 10);
        }
        return -1;
      })();
      if (title || asin) items.push({ asin, title, quantity: qty, price });
    });

    // Subtotal — try the dedicated subtotal IDs in priority order. Never fall
    // back to .sc-price (which is the first item's price, not the cart total).
    let subtotal = "";
    for (const sel of [
      '#sc-subtotal-amount-buybox',
      '#sc-subtotal-amount-activecart',
      '[data-feature-id="proceed-to-checkout-buybox"] .a-price',
      '[data-feature-id="proceed-to-checkout-action"] .a-price-whole',
    ]) {
      const el = document.querySelector(sel);
      if (el && txt(el)) { subtotal = txt(el); break; }
    }
    return { items, subtotal };
  });
}

export async function readDefaults(page) {
  // On checkout / order review page, the default address and payment are shown.
  return await page.evaluate(() => {
    function txt(el) { return (el && (el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim(); }
    const addr = txt(document.querySelector('[data-testid="default-shipping-address"], .ship-to-this-address, .displayAddressDiv, #addressChangeLinkId'));
    // Card last-4 lives in patterns like "····1234" or "ending in 1234"
    const bodyText = document.body.innerText || "";
    let cardLast4 = "";
    const m1 = bodyText.match(/(?:ending in|·{2,}|⋯|•+)\s*(\d{4})/);
    if (m1) cardLast4 = m1[1];
    return { address: addr, card_last4: cardLast4 };
  });
}
