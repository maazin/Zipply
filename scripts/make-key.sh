#!/bin/sh
# Create a signing key so the extension ID stays the same on every machine
# (Google's OAuth client is tied to that ID). Writes zipply.pem (keep it secret,
# it's gitignored) and sets VITE_EXTENSION_KEY in .env, then prints the ID.
set -e
cd "$(dirname "$0")/.."
[ -f zipply.pem ] || openssl genrsa -out zipply.pem 2048 2>/dev/null
KEY=$(openssl rsa -in zipply.pem -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')
# shasum on macOS, sha256sum on Linux and Git Bash for Windows.
if command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"; else SHA="sha256sum"; fi
ID=$(openssl rsa -in zipply.pem -pubout -outform DER 2>/dev/null | $SHA | head -c 32 | tr '0-9a-f' 'a-p')
touch .env
grep -v '^VITE_EXTENSION_KEY=' .env > .env.tmp || true
echo "VITE_EXTENSION_KEY=$KEY" >> .env.tmp
mv .env.tmp .env
echo "Extension ID: $ID"
