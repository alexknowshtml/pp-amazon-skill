#!/usr/bin/env bash
# pp-amazon installer.
# Builds the Go CLI from your printing-press-library checkout, installs the
# Playwright helper to /usr/local/lib/amazon-pp-cli/, and drops SKILL.md into
# ~/.claude/skills/pp-amazon/.
#
# Usage:
#   ./install.sh                                  # uses default printing-press-library path
#   PP_LIB=/path/to/printing-press-library ./install.sh   # override source path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$SCRIPT_DIR/cli"
SKILLS_DIR="$HOME/.claude/skills/pp-amazon"
HELPER_DIR="/usr/local/lib/amazon-pp-cli"

echo "==> pp-amazon installer"
echo "    CLI source: $CLI_DIR"
echo "    Skill:      $SKILLS_DIR"
echo "    Helper:     $HELPER_DIR"
echo

# ---------- Preflight ----------
echo "==> Checking prerequisites..."

if ! command -v go >/dev/null 2>&1; then
  echo "ERROR: Go not found. Install Go 1.26.3+ from https://go.dev/dl/" >&2
  exit 1
fi
GO_VERSION="$(go version | awk '{print $3}' | sed 's/go//')"
echo "    Go: $GO_VERSION"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node not found. Install Node 22+ from https://nodejs.org/" >&2
  exit 1
fi
echo "    Node: $(node --version)"

if [ ! -d "$CLI_DIR" ] || [ ! -f "$CLI_DIR/go.mod" ]; then
  echo "ERROR: cli/ directory not found at $CLI_DIR" >&2
  echo "       Are you running install.sh from the repo root?" >&2
  exit 1
fi
echo "    Found CLI source at $CLI_DIR"

# ---------- Build CLI ----------
echo
echo "==> Building amazon-pp-cli..."
cd "$CLI_DIR"
go install ./cmd/amazon-pp-cli/
CLI_PATH="$(go env GOPATH)/bin/amazon-pp-cli"
if [ ! -x "$CLI_PATH" ]; then
  echo "ERROR: build succeeded but $CLI_PATH not executable" >&2
  exit 1
fi
echo "    Installed: $CLI_PATH"
"$CLI_PATH" --version

# ---------- Install Playwright helper ----------
echo
echo "==> Installing Playwright helper to $HELPER_DIR..."
if [ ! -w "$(dirname "$HELPER_DIR")" ]; then
  echo "    /usr/local/lib needs sudo — prompting..."
  sudo mkdir -p "$HELPER_DIR"
  sudo cp "$SCRIPT_DIR/amazon-checkout.mjs" "$HELPER_DIR/amazon-checkout.mjs"
  sudo chmod +x "$HELPER_DIR/amazon-checkout.mjs"
  sudo cp "$SCRIPT_DIR/package.json" "$HELPER_DIR/package.json"
  sudo rm -rf "$HELPER_DIR/lib" && sudo cp -r "$SCRIPT_DIR/lib" "$HELPER_DIR/lib"
  cd "$HELPER_DIR" && sudo npm install --no-audit --no-fund
else
  mkdir -p "$HELPER_DIR"
  cp "$SCRIPT_DIR/amazon-checkout.mjs" "$HELPER_DIR/amazon-checkout.mjs"
  chmod +x "$HELPER_DIR/amazon-checkout.mjs"
  cp "$SCRIPT_DIR/package.json" "$HELPER_DIR/package.json"
  rm -rf "$HELPER_DIR/lib" && cp -r "$SCRIPT_DIR/lib" "$HELPER_DIR/lib"
  cd "$HELPER_DIR" && npm install --no-audit --no-fund
fi
echo "    Helper installed."

# Download chromium if needed
echo
echo "==> Ensuring Chromium is available for Playwright..."
if [ -n "${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}" ] && [ -x "$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH" ]; then
  echo "    Using PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"
else
  npx --yes playwright install chromium
fi

# ---------- Install SKILL.md ----------
echo
echo "==> Installing SKILL.md to $SKILLS_DIR..."
mkdir -p "$SKILLS_DIR"
cp "$SCRIPT_DIR/SKILL.md" "$SKILLS_DIR/SKILL.md"
echo "    SKILL installed."

# ---------- Done ----------
echo
echo "==> Install complete!"
echo
echo "Next steps:"
echo "  1. Create a profile:"
echo "       amazon-pp-cli profiles add personal --label 'Personal'"
echo
echo "  2. Paste your Amazon Cookie header (DevTools → Network → any request → Cookie):"
echo "       amazon-pp-cli --profile personal auth paste"
echo
echo "  3. Verify reachability:"
echo "       amazon-pp-cli --profile personal doctor"
echo
echo "  4. Sync your order history:"
echo "       amazon-pp-cli --profile personal history sync"
echo
echo "  5. (Optional) Set your default card last-4 for confirmations:"
echo "       amazon-pp-cli --profile personal defaults set --card-last4 NNNN --card-label 'Visa'"
echo
echo "  6. Test a dry-run add (no cart write):"
echo "       amazon-pp-cli --profile personal add 'something you bought before' --dry-run --json"
echo
echo "Read SKILL.md before letting an agent place real orders. Real money, no sandbox."
