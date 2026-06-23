#!/usr/bin/env bash
# PP2-049 validation: symbol verify + agent-chat benchmark Q1–Q10.
# Run on Replit after repairing diagrams on the PP2-049 manual.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PATTERN="${BENCHMARK_MANUAL_PATTERN:-P2-049|PP2 049}"
export VERIFY_MANUAL_PATTERN="$PATTERN"
export BENCHMARK_MANUAL_PATTERN="$PATTERN"

echo "=== PP2-049 validation ==="
echo "Manual pattern: $PATTERN"
echo ""

echo "--- Step 1: verify manual symbols + page types ---"
pnpm verify:manual-symbol

echo ""
echo "--- Step 2: agent-chat benchmark Q1–Q10 ---"
pnpm benchmark:agent-chat

echo ""
echo "=== PP2-049 validation complete ==="
