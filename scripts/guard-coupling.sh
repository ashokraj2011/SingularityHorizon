#!/bin/sh
# The UI must reach its host only through the injected AcpStudioApi.
# A stray window.acp / electron / node import re-welds it to Electron and
# silently breaks every non-Electron host, so fail the build instead.
set -e
fail=0

hits=$(grep -rn "window\.acp" src/renderer/src --include='*.ts' --include='*.tsx' \
  | grep -v 'src/renderer/src/api.ts' || true)
if [ -n "$hits" ]; then
  echo "✗ renderer reaches window.acp outside api.ts:"; echo "$hits"; fail=1
else
  echo "✓ no direct window.acp use outside api.ts"
fi

hits=$(grep -rn "from 'electron'\|from \"electron\"\|from 'node:\|require('node:" \
  src/renderer/src --include='*.ts' --include='*.tsx' || true)
if [ -n "$hits" ]; then
  echo "✗ renderer imports electron or node:"; echo "$hits"; fail=1
else
  echo "✓ renderer imports no electron and no node builtins"
fi

hits=$(grep -rn "from 'electron'" src/shared --include='*.ts' || true)
if [ -n "$hits" ]; then
  echo "✗ shared/ imports electron:"; echo "$hits"; fail=1
else
  echo "✓ shared/ is host-independent"
fi

exit $fail
