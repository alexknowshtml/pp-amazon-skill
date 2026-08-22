# pp-amazon — Amazon CLI + Claude Code skill

A Go CLI + Playwright helper that lets a Claude Code agent order Amazon items — either by repurchasing from history or by searching for something new — with explicit confirmation gates before any money moves.

**History-first, search-capable**: prefers items from purchase history (exact match → add); falls back to live `/s?k=` search when an item has never been ordered. **Full checkout via headless Chromium** so Amazon doesn't see static-POST automation. **Multi-account** via profiles. **Real money — no sandbox.** Read [SKILL.md](SKILL.md) before you let an agent loose with this.

## What you get

- `amazon-pp-cli` — the Go binary
- `amazon-checkout.mjs` — Playwright helper for cart-show / add-to-cart / checkout / history-sync
- `SKILL.md` — the Claude Code skill file (drop into `~/.claude/skills/pp-amazon/`)

## CLI commands

```
amazon-pp-cli add '<item>'          # repurchase from history (strict match required)
amazon-pp-cli search '<query>'      # live Amazon search, returns ASIN + price + stars + reviews
amazon-pp-cli cart view             # inspect current cart
amazon-pp-cli cart checkout --yes   # place the order
amazon-pp-cli history search '...'  # full-text search local order history
amazon-pp-cli history sync          # refresh history from Amazon
amazon-pp-cli doctor                # check session health
amazon-pp-cli profiles list         # show configured accounts
```

### search flags

```
--limit N          Max results (default 10)
--sort             price-asc | price-desc | review | new (default: relevance)
--json             Machine-readable output with results + warnings array
--profile <name>   Profile to use
```

JSON output shape:
```json
{
  "results": [
    {
      "asin": "B0FN5154SV",
      "title": "Sparkle Tear-A-Square Paper Towels, 12 Double Rolls",
      "price": "$12.16",
      "unit_price": "$0.13 / count",
      "prime_eligible": true,
      "stars": 4.5,
      "review_count": 55837
    }
  ],
  "warnings": null
}
```

`warnings` is non-null when the parser detects a structural mismatch (e.g. all prices empty). Each warning has `field`, `symptom`, and `fix` — a self-contained repair instruction the agent can act on directly.

## Requirements

- Go 1.26.3 or newer ([go.dev/dl](https://go.dev/dl/))
- Node 22+ and npm
- Chromium (Playwright downloads one on first run; or supply via `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`)
- A logged-in amazon.com session in Safari/Chrome

## Install (5 minutes)

```bash
# 1. Run the installer — builds the binary, installs the helper, drops SKILL.md.
./install.sh

# 2. Create a profile and paste your Amazon Cookie header.
amazon-pp-cli profiles add indyhall-biz --label "Indy Hall Business"
amazon-pp-cli --profile indyhall-biz auth paste
# (paste your Cookie header from DevTools, press Ctrl+D)

# 3. Verify the session reaches Amazon.
amazon-pp-cli --profile indyhall-biz doctor

# 4. Sync your order history.
amazon-pp-cli --profile indyhall-biz history sync

# 5. Set your default card last-4.
amazon-pp-cli --profile indyhall-biz defaults set --card-last4 NNNN --card-label "Visa"

# 6. Try a dry-run add (no cart write).
amazon-pp-cli --profile indyhall-biz add 'paper towels' --dry-run --json

# 7. Try a live search.
amazon-pp-cli --profile indyhall-biz search 'hand soap' --limit 5
```

## Getting the Cookie header

1. Open amazon.com in your browser (must be logged in)
2. DevTools → Network → click any request → Headers → copy the entire `Cookie:` value
3. Paste into `amazon-pp-cli --profile <name> auth paste`

Cookies expire periodically. If you see exit 9 (`manual_required`), re-paste.

## Skill flow (what the agent does)

**Repurchase (item in history):**
1. `add '<item>' --dry-run` → confirms strict match + last purchase date
2. You confirm
3. `add '<item>'` → Playwright clicks Add to Cart, verifies qty delta
4. `cart view` → shows all line items + card last-4
5. You confirm
6. `cart checkout --yes` → Playwright places the order, returns order ID

**Discovery (item not in history):**
1. `history search '<item>'` returns nothing useful
2. `search '<item>' --json` → live Amazon results with price, stars, review count, unit price
3. Agent presents numbered list, you pick one by ASIN or number
4. Agent treats your selection as a strict match and continues from step 3 above

## Honest caveats

- **No upstream API.** This scrapes amazon.com. Amazon changes their DOM regularly. When cart/checkout selectors break, the helper exits 7 with the stderr reason. When search field parsing breaks, `--json` output includes a `warnings` array with the fix. Update the regex and rebuild.
- **Search has higher bot-detection risk.** `/s?k=` is more aggressively guarded than cart/checkout. If Amazon serves a CAPTCHA, the command returns exit 7 with `ErrRobotCheck`. Don't retry automatically — wait and try again manually.
- **CAPTCHAs on checkout are unavoidable.** The stealth shims help but don't eliminate. Graceful fallback is the exit-9 deeplink path.
- **Loose matches are a real risk.** `match_quality=loose` means only some query tokens matched the title. The CLI requires `--allow-loose` to commit. Don't let an agent rush past this.
- **History is a SQLite snapshot.** Run `history sync` regularly so new orders are visible.

## Repo layout

```
pp-amazon-skill/
├── SKILL.md                 # Claude Code skill (drop into ~/.claude/skills/pp-amazon/)
├── amazon-checkout.mjs      # Playwright helper (cart, add-to-cart, checkout, history-sync)
├── README.md                # This file
├── install.sh               # Build + install script
├── package.json             # npm metadata for Playwright
└── cli/                     # Go source
    ├── cmd/amazon-pp-cli/   # Binary entry point
    ├── internal/amazon/     # HTTP client, HTML parsers (cart + search)
    ├── internal/auth/       # Cookie session management
    ├── internal/cli/        # Cobra commands (add, search, cart, history, ...)
    ├── internal/config/     # Profile config
    ├── internal/history/    # Order history import
    └── internal/store/      # SQLite store + FTS
```

## License

Personal use, no warranty.
