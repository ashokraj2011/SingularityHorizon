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

# The core must not know about any particular workflow system. Providers are
# registered by the host; a core import would re-couple the standalone tool to
# something it should work perfectly well without.
hits=$(grep -rn "providers/singularityFlow\|providers/singularity-flow" \
  src/main src/shared src/renderer --include='*.ts' --include='*.tsx' \
  | grep -v '^src/main/providers/' || true)
if [ -n "$hits" ]; then
  echo "✗ core imports a concrete provider:"; echo "$hits"; fail=1
else
  echo "✓ no concrete provider imported by core"
fi

# Functional coupling only — the brand name is fine (Event Horizon *is* a
# Singularity tool). What must not appear in core is a dependency on the
# workflow CLI or its on-disk conventions.
hits=$(grep -rn "singularity-flow\|work-items\|wm compose\|wm check" \
  src/main src/shared src/renderer --include='*.ts' --include='*.tsx' \
  | grep -v '^src/main/providers/' || true)
if [ -n "$hits" ]; then
  echo "✗ core depends on a specific workflow system:"; echo "$hits"; fail=1
else
  echo "✓ core is workflow-agnostic"
fi

# The headless harnesses bundle AgentSession and run it in plain Node against a
# real agent. Anything it imports transitively must therefore avoid electron —
# an import there fails at load, turning every such suite red at once.
hits=$(grep -rn "from 'electron'" \
  src/main/acp src/main/store src/main/ast src/main/workflow src/shared \
  --include='*.ts' || true)
if [ -n "$hits" ]; then
  echo "✗ a module used by the headless harnesses imports electron:"; echo "$hits"; fail=1
else
  echo "✓ session/store/ast layers are runnable outside electron"
fi

# 7. Every bundled harness must keep TypeScript external.
#
# esbuild inlines the compiler into an ESM bundle, where its internal
# require("fs") throws "Dynamic require of 'fs' is not supported" at import
# time — before a single assertion runs. The suite then reports nothing rather
# than failing, which is how profile:check sat broken while the harnesses I ran
# individually stayed green.
missing=$(node -e '
const s = require("./package.json").scripts;
process.stdout.write(Object.entries(s)
  .filter(([, v]) => v.includes("esbuild") && v.includes("--format=esm") && !v.includes("--external:typescript"))
  .map(([k]) => k).join(", "));
')
if [ -n "$missing" ]; then
  echo "✗ esm harness missing --external:typescript: $missing"; fail=1
else
  echo "✓ every esm harness keeps typescript external"
fi

exit $fail
