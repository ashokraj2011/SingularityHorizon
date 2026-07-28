#!/usr/bin/env bash
#
# Verifies scripts/install.sh.
#
# The assertions worth having here are the ones about the failure modes that
# are silent: a token written into a file, an auth line that does not match the
# registry npm will actually contact, and an unset variable that npm passes
# through verbatim. Each of those produces a working-looking config that fails
# later and blames something else.
#
# Run with: npm run install:check
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/install.sh"
PASS=0
FAIL=0

ok() {
  if [ "$2" = "0" ]; then
    printf '✓ %s\n' "$1"; PASS=$((PASS + 1))
  else
    printf '✗ %s\n' "$1"; [ $# -gt 2 ] && printf '    %s\n' "$3"; FAIL=$((FAIL + 1))
  fi
}
has()  { grep -qF "$2" <<<"$1" && echo 0 || echo 1; }
lacks() { grep -qF "$2" <<<"$1" && echo 1 || echo 0; }
# Line-anchored: a scoped install must not also set the *default* registry,
# and "registry=" appears as a substring of "@acme:registry=".
no_line() { grep -qE "$2" <<<"$1" && echo 1 || echo 0; }

REG="https://artifactory.example.com/artifactory/api/npm/npm-virtual"
SECRET="s3cr3t-do-not-write-me"

# --- the .npmrc it composes --------------------------------------------------

OUT="$(ARTIFACTORY_TOKEN="$SECRET" bash "$SCRIPT" --registry "$REG" --dry-run)"

ok "writes the registry"           "$(has "$OUT" "registry=$REG/")"
ok "appends the trailing slash npm matches on" "$(has "$OUT" "registry=$REG/")"
ok "derives the auth key from the registry path" \
   "$(has "$OUT" "//artifactory.example.com/artifactory/api/npm/npm-virtual/:_authToken=")"
ok "references the token by variable"  "$(has "$OUT" '_authToken=${ARTIFACTORY_TOKEN}')"
# The whole point of the indirection.
ok "NEVER writes the token itself"     "$(lacks "$OUT" "$SECRET")" "the secret appeared in the output"
ok "sets always-auth"                  "$(has "$OUT" "always-auth=true")"
ok "says not to commit it"             "$(has "$OUT" "do not commit")"

# --- scoped form -------------------------------------------------------------

OUT="$(ARTIFACTORY_TOKEN=x bash "$SCRIPT" --registry "$REG" --scope @acme --dry-run)"
ok "scoped install routes only that scope" "$(has "$OUT" "@acme:registry=$REG/")"
ok "and leaves the default registry alone" "$(no_line "$OUT" '^registry=')"
OUT="$(ARTIFACTORY_TOKEN=x bash "$SCRIPT" --registry "$REG" --scope acme --dry-run)"
ok "a scope missing its @ is accepted"     "$(has "$OUT" "@acme:registry=")"

# --- binaries that bypass the npm registry -----------------------------------

MIRROR="https://artifactory.example.com/artifactory/github/electron/electron/releases/download/"
OUT="$(ARTIFACTORY_TOKEN=x bash "$SCRIPT" --registry "$REG" --electron-mirror "$MIRROR" \
        --electron-builder-mirror "https://artifactory.example.com/artifactory/builder/" --dry-run)"
# Verified against @electron/get: it reads npm_config_electron_mirror first.
ok "electron mirror lands under the key @electron/get reads" "$(has "$OUT" "electron_mirror=$MIRROR")"
ok "electron-builder mirror is written" \
   "$(has "$OUT" "electron_builder_binaries_mirror=https://artifactory.example.com/artifactory/builder/")"

# --- auth variants -----------------------------------------------------------

OUT="$(ARTIFACTORY_PASSWORD="$SECRET" bash "$SCRIPT" --registry "$REG" --username ci-bot --dry-run)"
ok "basic auth writes the username"  "$(has "$OUT" ":username=ci-bot")"
ok "basic auth references the password variable" "$(has "$OUT" '_password=${ARTIFACTORY_PASSWORD}')"
ok "basic auth never writes the password"        "$(lacks "$OUT" "$SECRET")"

OUT="$(bash "$SCRIPT" --registry "$REG" --no-auth --dry-run)"
ok "anonymous install needs no token" "$(has "$OUT" "registry=")"
ok "and writes no auth line"          "$(lacks "$OUT" "_authToken")"

OUT="$(MY_TOKEN=abc bash "$SCRIPT" --registry "$REG" --token-env MY_TOKEN --dry-run)"
ok "a custom token variable is honoured" "$(has "$OUT" '_authToken=${MY_TOKEN}')"

# --- refusals ----------------------------------------------------------------

ERR="$(bash "$SCRIPT" --registry "$REG" 2>&1; echo "rc=$?")"
ok "an unset token variable is refused" "$(has "$ERR" "rc=1")"
# npm leaves ${VAR} literal when unset, so this must be caught here or not at all.
ok "and the refusal explains why, not just that" "$(has "$ERR" "literal string")"

ERR="$(bash "$SCRIPT" 2>&1; echo "rc=$?")"
ok "a missing registry is refused" "$(has "$ERR" "rc=1")"

ERR="$(ARTIFACTORY_TOKEN=x bash "$SCRIPT" --registry "artifactory.example.com" --dry-run 2>&1; echo "rc=$?")"
ok "a registry without a scheme is refused" "$(has "$ERR" "rc=1")"
ok "and says what was wrong with it"        "$(has "$ERR" "http(s)")"

ERR="$(ARTIFACTORY_TOKEN=x bash "$SCRIPT" --registry "$REG" --cafile /nope/missing.pem --dry-run 2>&1; echo "rc=$?")"
ok "a missing CA file is refused" "$(has "$ERR" "rc=1")"

ERR="$(bash "$SCRIPT" --registry "$REG" --username bot --dry-run 2>&1; echo "rc=$?")"
ok "basic auth without a password variable is refused" "$(has "$ERR" "rc=1")"

ERR="$(bash "$SCRIPT" --frobnicate 2>&1; echo "rc=$?")"
ok "an unknown flag is refused rather than ignored" "$(has "$ERR" "rc=1")"

# --- what it does to the working tree ----------------------------------------

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts"
cp "$SCRIPT" "$TMP/scripts/install.sh"
printf 'node_modules/\n' > "$TMP/.gitignore"
printf '{"name":"t","version":"1.0.0"}\n' > "$TMP/package.json"
printf 'registry=https://registry.npmjs.org/\n' > "$TMP/.npmrc"

ARTIFACTORY_TOKEN="$SECRET" bash "$TMP/scripts/install.sh" --registry "$REG" --no-install >/dev/null 2>&1

ok "an existing .npmrc is backed up, not clobbered" \
   "$([ -f "$TMP/.npmrc.bak" ] && grep -q "registry.npmjs.org" "$TMP/.npmrc.bak" && echo 0 || echo 1)"
ok "the new .npmrc is written"      "$(has "$(cat "$TMP/.npmrc")" "$REG/")"
ok "the token is not in the file on disk" "$(lacks "$(cat "$TMP/.npmrc")" "$SECRET")"
ok ".npmrc is added to .gitignore"  "$(has "$(cat "$TMP/.gitignore")" ".npmrc")"
ok ".npmrc.bak is ignored too"      "$(has "$(cat "$TMP/.gitignore")" ".npmrc.bak")"
ok "the file is not world-readable" \
   "$([ "$(stat -f '%Lp' "$TMP/.npmrc" 2>/dev/null || stat -c '%a' "$TMP/.npmrc")" = "600" ] && echo 0 || echo 1)"

# Running twice must not append a second copy of the ignore rule.
ARTIFACTORY_TOKEN="$SECRET" bash "$TMP/scripts/install.sh" --registry "$REG" --no-install >/dev/null 2>&1
ok "re-running does not duplicate the ignore rule" \
   "$([ "$(grep -cxF '.npmrc' "$TMP/.gitignore")" = "1" ] && echo 0 || echo 1)"

# --- npm actually reads what was written -------------------------------------
# Composing a plausible file is not the same as npm agreeing with it.

REAL="$(cd "$TMP" && npm config get registry 2>/dev/null)"
ok "npm resolves the registry from the generated file" \
   "$([ "$REAL" = "$REG/" ] && echo 0 || echo 1)" "npm reported: $REAL"

ARTIFACTORY_TOKEN="$SECRET" bash "$TMP/scripts/install.sh" --registry "$REG" \
  --electron-mirror "$MIRROR" --no-install >/dev/null 2>&1
SEEN="$(cd "$TMP" && npm exec --offline -- node -e 'process.stdout.write(process.env.npm_config_electron_mirror||"ABSENT")' 2>/dev/null)"
ok "npm passes the electron mirror to postinstall" \
   "$([ "$SEEN" = "$MIRROR" ] && echo 0 || echo 1)" "postinstall would see: $SEEN"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "all $PASS passed"
else
  echo "$FAIL FAILED"
fi
exit $((FAIL > 0))
