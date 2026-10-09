// browser.mjs — Chromium session setup and the manual-gate / exit helpers
// every action shares. Exit codes must match the Go CLI (see amazon-checkout.mjs).

import { chromium } from "playwright";
import fs from "node:fs";

export const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.6 Safari/605.1.15";

export const STEALTH_INIT = `
  // Hide webdriver
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  // Realistic plugin/MIME types stubs (Safari doesn't expose Chrome's, but Amazon
  // primarily checks for the absence of webdriver and the presence of plausible
  // navigator state).
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  }
  // Permissions API shim
  const _query = window.navigator.permissions?.query;
  if (_query) {
    window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : _query(params);
  }
`;

export function captchaSelectors() {
  return [
    'form[action*="validateCaptcha"]',
    "#captchacharacters",
    'img[src*="captcha"]',
  ];
}

export async function detectManualGate(page) {
  // Returns { kind, deeplink } if a manual gate is up, else null.
  const url = page.url();
  if (/\/ap\/signin/.test(url) || /\/ax\/claim/.test(url)) {
    return { kind: "sign-in", deeplink: "https://www.amazon.com/gp/cart/view.html" };
  }
  for (const sel of captchaSelectors()) {
    const found = await page.$(sel);
    if (found) {
      return { kind: "captcha", deeplink: page.url() };
    }
  }
  // Expired cookies don't redirect to /ap/signin; the page renders as a guest.
  const navGreeting = await page.$eval("#nav-link-accountList-nav-line-1", (el) => el.textContent || "").catch(() => "");
  if (/hello,\s*sign in/i.test(navGreeting)) {
    return { kind: "sign-in", deeplink: "https://www.amazon.com/gp/cart/view.html" };
  }
  const bodyText = (await page.textContent("body")) || "";
  if (/to discuss automated access/i.test(bodyText) ||
      /enter the characters you see below/i.test(bodyText)) {
    return { kind: "captcha", deeplink: page.url() };
  }
  return null;
}

export function manualExit(kind, deeplink, extra = {}) {
  process.stdout.write(JSON.stringify({
    status: "manual_required",
    kind,
    deeplink,
    ...extra,
  }) + "\n");
  process.exit(9);
}

export function transientExit(message) {
  process.stderr.write(message + "\n");
  process.exit(7);
}

// Load a profile's cookies.json into the shape Playwright wants.
export function loadCookies(cookiesPath) {
  const raw = JSON.parse(fs.readFileSync(cookiesPath, "utf8"));
  return raw.cookies.map((c) => {
    const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || "/" };
    if (c.expires && !c.expires.startsWith("0001")) {
      const t = Date.parse(c.expires);
      if (!Number.isNaN(t)) out.expires = Math.floor(t / 1000);
    }
    return out;
  });
}

// Launch headless Chromium with the Safari identity, stealth shims and the
// profile's cookies. Exits 7 if Chromium will not start.
export async function launchSession(cookiesPath) {
  const cookies = loadCookies(cookiesPath);
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });
  } catch (e) {
    transientExit(`failed to launch chromium: ${e.message}`);
  }

  const context = await browser.newContext({
    userAgent: SAFARI_UA,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  await context.addInitScript({ content: STEALTH_INIT });
  await context.addCookies(cookies);

  const page = await context.newPage();
  return { browser, context, page };
}
