---
name: pp-amazon
description: Amazon CLI for history-first reorders + full checkout. Use whenever the user mentions ordering anything from Amazon ("order X", "add X to my cart", "restock the usual"). REFUSES to add anything not in their purchase history — that's the safety feature. Multi-account via --profile.
allowed-tools: Bash(amazon-pp-cli:*)
---

# Amazon (pp-amazon)

A Go CLI + Playwright helper that talks to amazon.com using the user's Safari session cookies. Local SQLite mirror of their purchase history. **Repurchase-only** by design — `add` refuses queries that don't match past purchases. Checkout uses the default shipping address + default payment method on file for each account.

## ⚠️ This places real orders with real money

The CLI uses the default card on file for whichever Amazon account is active. Every `checkout --yes` charges that card. There's no sandbox. Follow the order flow below exactly — every step exists because a previous version of this skill made the wrong purchase.

## When to use

- Ordering / reordering / restocking ("order paper towels", "add bath tissue", "restock the usual")
- What was bought before ("did I order Charmin last time?")
- Cart state ("what's in my Amazon cart?")
- Placing an order ("checkout", "place the order")

## Multi-account profiles

The CLI supports multiple Amazon accounts via `--profile`. Default profile names suggested in `install.sh`: `personal` and `work`. The user can name them anything (`amazon-pp-cli profiles add <name> --label "<description>"`).

**Always pass `--profile` explicitly.** If the user's request is ambiguous ("add X to my Amazon"), **ask which account before any CLI call**. Do not guess.

## Required order flow (don't skip steps)

When the user says "order X" or equivalent, you MUST run this sequence:

1. **Identify the account.** If unclear, ask: "Which profile — personal or work?" — wait for an answer before any CLI call.

2. **Preview the match with `--dry-run`.**
   ```bash
   amazon-pp-cli --profile <slug> add '<query>' --dry-run --json
   ```
   Present matched ASIN, title, last-purchased date, purchase count. Format: *"Found: [title] (last bought [date], ordered [N]× before). Look right?"*

   **Check `match_quality` in the JSON:**
   - `"strict"` → all tokens matched. Present normally.
   - `"loose"` → only some tokens matched (FTS fallback). Add a warning: *"⚠️ Loose match — please confirm this is what you want before I commit."*

3. **Wait for the user's confirmation** ("yep", "yes", "that's it"). Never proceed without explicit yes.

4. **Add to cart for real.**
   ```bash
   amazon-pp-cli --profile <slug> add '<query>' --json
   ```
   If `match_quality=loose`, the CLI refuses with exit 11 unless you pass `--allow-loose`. Only pass `--allow-loose` AFTER step-3 confirmation explicitly named the matched title back to you (so you know the user saw it).

   **CRITICAL — handling `add_failed`:** If JSON returns `"added": false` with reason mentioning "items-of-interest" or "silently dropped" — **DO NOT retry. DO NOT proceed.** Amazon's bot detection just blocked it. Tell the user: *"Amazon refused to add [title] to the cart — open https://www.amazon.com/dp/<ASIN> in Safari and tap Add to Cart there. Once it lands, I can take over for checkout."*

5. **Show the cart, itemized.**
   ```bash
   amazon-pp-cli --profile <slug> cart show --json
   ```
   **List every line item by title and quantity** — don't summarize as "N items, $X". The cart may contain things added in prior sessions the user has forgotten about. Format:
   ```
   Cart on [personal/work]:
     - Bounty Paper Towels 12-pack × 1     $28.99
     - Cuisinart Espresso Machine × 1      $399.99    ← already in cart from earlier
   Total: $428.98 • Ships to: [address] • Card: ····[last4]
   ```

   **DO NOT speculate about missing cart contents.** If subtotal seems higher than `sum(items × ~unit-price)` OR any item's `quantity = -1` (unknown), say honestly: *"Cart shows N row(s), subtotal $X — qty parser may have undercounted. Want me to dump raw?"* NEVER reintroduce items from earlier turns as "hidden cart items."

   **If `cart show` exits 9 (`manual_required`):** Amazon hit a CAPTCHA or sign-in gate. Skip steps 6–8. Tell the user: *"Amazon needs you to finish at <deeplink from JSON>."* Don't retry programmatically.

6. **Ask for placement confirmation.** "Ready to place this on [personal/work]? Total $X — charging ····[last4]."

7. **Wait for explicit yes in the current turn, AFTER seeing the itemized cart from step 5.** A "yes" said before the cart was shown does not count.

8. **Place the order.**
   ```bash
   amazon-pp-cli --profile <slug> checkout --yes --json
   ```
   On success: `status: "placed"`, `order_id`, `order_ids`, `confirmation_url`. Amazon can split one checkout into several orders; `order_ids` lists all of them, so report every one. `order_ids_source: "order_history"` means the thank-you page showed no numbers and they came from today's order history instead.

   If `status: "placed_unconfirmed"`, the order went through but no order number was found. Check the order history before telling the user anything.

   **If exit 9 (`manual_required`):** Amazon flagged the place-order request. Tell the user: *"Amazon needs you to finish at <deeplink>. Items are already in your cart — just tap 'Place order' in Safari."* Don't retry — CAPTCHA will re-trigger.

**Hard rules:**
- **Whenever the user asks "what's in my cart" or you need cart state, ALWAYS run `cart show` fresh. NEVER quote contents from earlier in the session.**
- Never run `checkout --yes` unless the user confirmed *after* seeing the itemized cart from step 5 in the current turn.
- Never skip step 2 (preview) or step 5's itemization.
- Never guess the account.
- Never bundle confirmations. "Yes order paper towels and place it" does not count as both step-3 and step-7 — you must show the cart and ask again.
- If `checkout --yes` returns exit 7 (transient), re-run `cart show` and ask for a fresh yes before retrying. Original consent attaches to the original cart state.
- **If a prior turn in this session returned exit 127 ("command not found") but the binary is now installed (e.g. fresh install), retry `which amazon-pp-cli` once before declaring missing.**

## Keeping history current

If the user mentions an item that should be in history but isn't found:
```bash
amazon-pp-cli --profile <slug> history sync
```
Walks `/your-orders` across recent years, imports new orders. Run this whenever a known purchase comes up missing.

## Common commands

```bash
# History
amazon-pp-cli --profile <slug> history search '<query>'
amazon-pp-cli --profile <slug> history list --limit 20
amazon-pp-cli --profile <slug> history stats
amazon-pp-cli --profile <slug> history sync               # refresh from Amazon

# Auth
amazon-pp-cli --profile <slug> auth paste                 # paste Cookie header
amazon-pp-cli --profile <slug> auth status
amazon-pp-cli --profile <slug> doctor                     # reachability check

# Defaults (manual config for card last-4)
amazon-pp-cli --profile <slug> defaults set --card-last4 NNNN --card-label "Visa"
amazon-pp-cli --profile <slug> defaults show

# Cart + checkout
amazon-pp-cli --profile <slug> cart show --json
amazon-pp-cli --profile <slug> checkout --dry-run         # reaches review page, stops before clicking
amazon-pp-cli --profile <slug> checkout --yes             # places the order
```

## Exit codes

- `0` — success
- `2` — usage error
- `3` — auth (cookies missing / expired)
- `4` — no match in history (repurchase-only refusal)
- `7` — transient (network, timeout, selector miss — stderr included in error message)
- `9` — manual gate required (CAPTCHA / sign-in); JSON has a `deeplink` field
- `10` — checkout invoked without `--yes`
- `11` — loose match without `--allow-loose`
