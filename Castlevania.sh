#!/bin/sh
# Double-click (or run) to play. Requires Node.js; run "npm run setup" once first.
cd "$(dirname "$0")" || exit 1
exec npm run play
