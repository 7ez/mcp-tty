#!/usr/bin/env bash
set -e

if ! command -v npx >/dev/null 2>&1; then
  echo "Node.js is required but wasn't found. Install it from https://nodejs.org (LTS) and re-run this script." >&2
  exit 1
fi

npx --yes github:7ez/mcp-tty setup
