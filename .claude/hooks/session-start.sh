#!/bin/bash
# SessionStart hook: prepares a cloud session so `check` can run
# (AGENTS.md "Commands"). Runs only in Claude Code on the web; a local machine
# is set up by hand (CONTRIBUTING.md).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# Core is a git dependency that the lockfile names over ssh; a cloud session
# fetches it over https.
git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# `npm install` rather than `npm ci`: the container is cached once this hook
# completes, and install reuses what's already there.
npm install --no-audit --no-fund

# The browser tests need the Chromium build that the pinned Playwright
# expects. A no-op when it's already installed.
npx playwright install chromium
