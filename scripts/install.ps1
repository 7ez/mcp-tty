if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required but wasn't found. Install it from https://nodejs.org (LTS) and re-run this script."
    exit 1
}

npx --yes github:7ez/mcp-tty setup
