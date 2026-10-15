# Sourced, hidden, by demo.tape: a small bakery shop in a fresh repository, with lint and test scripts.
DEMO_TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$DEMO_TOOLS/bin:$PATH" PS1='$ ' GIT_AUTHOR_DATE='2026-10-15T09:00:00' GIT_COMMITTER_DATE='2026-10-15T09:00:00'
rm -rf /tmp/resaledger-demo && mkdir -p /tmp/resaledger-demo/bakery && cd /tmp/resaledger-demo/bakery
git init -q -b main && git config user.name alice && git config user.email alice@example.com
mkdir src && echo 'export const loaves = 12' > src/shop.js
printf '{ "name": "bakery", "private": true, "scripts": { "lint": "node --check src/shop.js", "test": "node -e \\"process.exit(0)\\"" } }\n' > package.json
git add -A && git commit -qm "the bakery shop"
