#!/usr/bin/env bash
#
# Install dependencies from an internal registry (Artifactory, Nexus, Verdaccio
# — anything that speaks the npm registry API).
#
# Two things make this more than `npm config set registry`:
#
#   1. The token is never written to disk. The .npmrc gets `${VAR}`, which npm
#      expands when it reads the file, so the secret lives only in the
#      environment. The catch is that npm leaves an *unset* variable as the
#      literal string `${VAR}` rather than failing — which reaches the registry
#      as a garbage credential and comes back as a 401 that blames your token.
#      So this script checks the variable is set before it runs anything.
#
#   2. Electron does not come from the npm registry. Its postinstall downloads
#      the binary from github.com/electron/electron/releases, and
#      electron-builder pulls its own toolchain from GitHub too. On a network
#      that only allows the internal mirror, pointing npm at Artifactory gets
#      you a successful metadata fetch and then a failed install. --electron-
#      mirror and --electron-builder-mirror cover that; both are written into
#      the .npmrc so later installs keep working without re-running this.
#
# Bash, not TypeScript, because this has to run before node_modules exists —
# the repo's other scripts are bundled with esbuild, which is a devDependency.
#
# Usage:
#   scripts/install.sh --registry https://artifactory.example.com/artifactory/api/npm/npm-virtual/
#
set -euo pipefail

SELF="$(basename "$0")"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REGISTRY="${NPM_REGISTRY:-}"
SCOPE=""
AUTH_TYPE="token"
TOKEN_ENV="${NPM_TOKEN_ENV:-ARTIFACTORY_TOKEN}"
USERNAME="${NPM_USERNAME:-}"
PASSWORD_ENV="ARTIFACTORY_PASSWORD"
EMAIL="${NPM_EMAIL:-}"
ELECTRON_MIRROR_URL="${ELECTRON_MIRROR:-}"
BUILDER_MIRROR_URL="${ELECTRON_BUILDER_BINARIES_MIRROR:-}"
CAFILE=""
STRICT_SSL="true"
NO_AUTH=0
USE_CI=0
DO_INSTALL=1
DRY_RUN=0
FORCE=0
SKIP_PING=0
NPMRC="$ROOT/.npmrc"

die() { printf '%s: %s\n' "$SELF" "$1" >&2; exit 1; }
note() { printf '  %s\n' "$1"; }

usage() {
  cat <<EOF
$SELF — install dependencies from an internal registry.

  --registry URL              Registry to install from.        [\$NPM_REGISTRY]
  --scope @name               Route only this scope to it; the public registry
                              keeps serving everything else.

Auth (the secret stays in the environment — only its *name* is written):
  --token-env VAR             Env var holding a bearer token.  [$TOKEN_ENV]
  --username NAME             Use basic auth instead.          [\$NPM_USERNAME]
  --password-env VAR          Env var holding the password.    [$PASSWORD_ENV]
  --email ADDR                Some registries require it.      [\$NPM_EMAIL]
  --no-auth                   Anonymous / IP-allowlisted registry.

Binaries that do not come from the npm registry:
  --electron-mirror URL       Replaces github.com/electron/electron/releases/download/
  --electron-builder-mirror URL   Replaces electron-builder's GitHub downloads.

TLS (corporate interception):
  --cafile PATH               CA bundle; also sets NODE_EXTRA_CA_CERTS so the
                              binary downloads trust it too.
  --insecure                  Disable certificate verification. Last resort.

  --ci                        npm ci (needs a lockfile) instead of npm install.
  --no-install                Write the config, install nothing.
  --dry-run                   Print the .npmrc, write nothing.
  --force                     Overwrite an existing .npmrc without backing up.
  --skip-ping                 Skip the reachability check.
  -h, --help

Example:
  export ARTIFACTORY_TOKEN=...
  scripts/install.sh --registry https://artifactory.corp/artifactory/api/npm/npm-virtual/ \\
                     --electron-mirror https://artifactory.corp/artifactory/github/electron/electron/releases/download/
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -r|--registry)  REGISTRY="${2:-}"; shift 2 ;;
    -s|--scope)     SCOPE="${2:-}"; shift 2 ;;
    -t|--token-env) TOKEN_ENV="${2:-}"; AUTH_TYPE="token"; shift 2 ;;
    -u|--username)  USERNAME="${2:-}"; AUTH_TYPE="basic"; shift 2 ;;
    --password-env) PASSWORD_ENV="${2:-}"; AUTH_TYPE="basic"; shift 2 ;;
    --email)        EMAIL="${2:-}"; shift 2 ;;
    --no-auth)      NO_AUTH=1; shift ;;
    --electron-mirror)          ELECTRON_MIRROR_URL="${2:-}"; shift 2 ;;
    --electron-builder-mirror)  BUILDER_MIRROR_URL="${2:-}"; shift 2 ;;
    --cafile)       CAFILE="${2:-}"; shift 2 ;;
    --insecure)     STRICT_SSL="false"; shift ;;
    --ci)           USE_CI=1; shift ;;
    --no-install)   DO_INSTALL=0; shift ;;
    --dry-run)      DRY_RUN=1; DO_INSTALL=0; shift ;;
    --force)        FORCE=1; shift ;;
    --skip-ping)    SKIP_PING=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unknown argument: $1  (try --help)" ;;
  esac
done

[ -n "$REGISTRY" ] || { usage >&2; die "a --registry is required"; }

case "$REGISTRY" in
  http://*|https://*) ;;
  *) die "--registry must be an http(s) URL, got: $REGISTRY" ;;
esac

# npm matches credentials against the registry path without its scheme, and
# only with a trailing slash. Getting this wrong authenticates nothing and
# fails as an anonymous 401, which reads like a bad token.
[ "${REGISTRY: -1}" = "/" ] || REGISTRY="$REGISTRY/"
AUTH_KEY="${REGISTRY#http://}"
AUTH_KEY="//${AUTH_KEY#https://}"

if [ -n "$SCOPE" ]; then
  case "$SCOPE" in
    @*) ;;
    *) SCOPE="@$SCOPE" ;;
  esac
fi

# --- the check that earns this script its keep -------------------------------
# npm expands ${VAR} when it reads .npmrc, but leaves it *verbatim* when the
# variable is unset. The literal "${ARTIFACTORY_TOKEN}" then travels to the
# registry as your credential. Catch it here, where the message can be honest.
if [ "$NO_AUTH" -eq 0 ]; then
  if [ "$AUTH_TYPE" = "token" ]; then
    [ -n "$TOKEN_ENV" ] || die "--token-env needs a variable name"
    if [ -z "${!TOKEN_ENV:-}" ]; then
      die "\$$TOKEN_ENV is not set.
  The token is deliberately never written to .npmrc — only its name is, and npm
  expands it at read time. An unset variable would reach the registry as the
  literal string \"\${$TOKEN_ENV}\" and come back as a 401 blaming your token.

  Set it first:   export $TOKEN_ENV=<token>
  Or install anonymously with --no-auth."
    fi
  else
    [ -n "$USERNAME" ] || die "basic auth needs --username"
    if [ -z "${!PASSWORD_ENV:-}" ]; then
      die "\$$PASSWORD_ENV is not set (holds the password for --username $USERNAME)."
    fi
  fi
fi

if [ -n "$CAFILE" ] && [ ! -f "$CAFILE" ]; then
  die "--cafile does not exist: $CAFILE"
fi

# --- compose the file --------------------------------------------------------
compose() {
  echo "# Generated by scripts/install.sh — do not commit."
  echo "# Secrets are referenced by environment variable, never stored here."
  echo
  if [ -n "$SCOPE" ]; then
    echo "$SCOPE:registry=$REGISTRY"
  else
    echo "registry=$REGISTRY"
  fi

  if [ "$NO_AUTH" -eq 0 ]; then
    if [ "$AUTH_TYPE" = "token" ]; then
      echo "${AUTH_KEY}:_authToken=\${$TOKEN_ENV}"
    else
      echo "${AUTH_KEY}:username=$USERNAME"
      echo "${AUTH_KEY}:_password=\${$PASSWORD_ENV}"
    fi
    [ -n "$EMAIL" ] && echo "${AUTH_KEY}:email=$EMAIL"
    echo "always-auth=true"
  fi

  if [ -n "$CAFILE" ]; then
    echo "cafile=$CAFILE"
  fi
  if [ "$STRICT_SSL" = "false" ]; then
    echo "strict-ssl=false"
  fi

  # Read by @electron/get as npm_config_electron_mirror, and by
  # app-builder-lib as npm_config_electron_builder_binaries_mirror. Writing
  # them here rather than exporting means a plain `npm install` later still
  # resolves them.
  if [ -n "$ELECTRON_MIRROR_URL" ]; then
    echo
    echo "electron_mirror=$ELECTRON_MIRROR_URL"
  fi
  if [ -n "$BUILDER_MIRROR_URL" ]; then
    echo "electron_builder_binaries_mirror=$BUILDER_MIRROR_URL"
  fi
}

if [ "$DRY_RUN" -eq 1 ]; then
  compose
  exit 0
fi

if [ -f "$NPMRC" ] && [ "$FORCE" -eq 0 ]; then
  cp "$NPMRC" "$NPMRC.bak"
  note "existing .npmrc backed up to .npmrc.bak"
fi

compose > "$NPMRC"
chmod 600 "$NPMRC"

# A registry URL with an embedded path is not a secret, but this file is the
# natural place for one to end up later. Keeping it out of git is cheap.
IGNORE="$ROOT/.gitignore"
if [ -f "$IGNORE" ] && ! grep -qxF '.npmrc' "$IGNORE"; then
  printf '\n# registry config written by scripts/install.sh\n.npmrc\n.npmrc.bak\n' >> "$IGNORE"
  note ".npmrc added to .gitignore"
fi

echo "$SELF: configured"
note "registry     ${SCOPE:+$SCOPE -> }$REGISTRY"
if [ "$NO_AUTH" -eq 1 ]; then
  note "auth         none (anonymous)"
elif [ "$AUTH_TYPE" = "token" ]; then
  note "auth         bearer token from \$$TOKEN_ENV (set, ${#TOKEN_ENV} char name, value not shown)"
else
  note "auth         basic, $USERNAME / \$$PASSWORD_ENV"
fi
[ -n "$ELECTRON_MIRROR_URL" ] && note "electron     $ELECTRON_MIRROR_URL"
[ -n "$BUILDER_MIRROR_URL" ]  && note "builder      $BUILDER_MIRROR_URL"
[ -n "$CAFILE" ]              && note "cafile       $CAFILE"
[ "$STRICT_SSL" = "false" ]   && note "strict-ssl   DISABLED — certificates are not verified"

# Only worth saying if this project actually pulls electron in — an unconditional
# warning is one people learn to scroll past.
if [ -z "$ELECTRON_MIRROR_URL" ] && [ "$DO_INSTALL" -eq 1 ] &&
   grep -qE '"electron(-builder)?"[[:space:]]*:' "$ROOT/package.json" 2>/dev/null; then
  note ""
  note "note: electron's binary still comes from github.com/electron/electron."
  note "      If this network only allows the internal mirror, that download is"
  note "      what will fail — pass --electron-mirror."
fi

# NODE_EXTRA_CA_CERTS covers the binary downloads, which use Node's https
# stack directly and never see npm's cafile.
if [ -n "$CAFILE" ]; then
  export NODE_EXTRA_CA_CERTS="$CAFILE"
fi

[ "$DO_INSTALL" -eq 1 ] || exit 0

cd "$ROOT"

if [ "$SKIP_PING" -eq 0 ]; then
  echo "$SELF: checking the registry answers…"
  # Retries and the default 5-minute timeout are npm's install defaults, and
  # they are wrong for a reachability probe — an unresolvable host took 70s
  # before these were pinned. The point of the probe is to fail quickly.
  if ! npm ping --registry "$REGISTRY" --fetch-retries=0 --fetch-timeout=10000 >/dev/null 2>&1; then
    die "the registry did not answer: $REGISTRY
  Checked before installing so this fails now rather than part-way through.
  Common causes: VPN not connected, a typo in the path, an expired token, or a
  TLS-intercepting proxy (try --cafile). Re-run with --skip-ping to go ahead
  anyway."
  fi
fi

if [ "$USE_CI" -eq 1 ]; then
  [ -f "$ROOT/package-lock.json" ] || die "--ci needs a package-lock.json"
  echo "$SELF: npm ci"
  npm ci
else
  echo "$SELF: npm install"
  npm install
fi

echo "$SELF: done"
