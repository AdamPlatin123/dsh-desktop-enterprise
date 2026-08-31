#!/usr/bin/env bash
# Fork upgrade invariant checker (docs/fork-sop.md section 6).
#
# Dry-run by default and in --check mode: verifies that the upstream pin,
# the vendored runtime, the dependency lock, and the enterprise patch
# registry are mutually consistent. Changes nothing. The real upgrade flow
# is intentionally manual (docs/fork-sop.md section 3) so every step stays
# on the record.
set -euo pipefail

mode=check
case "${1:-}" in
  '' | --check) mode=check ;;
  -h | --help)
    sed -n '2,10p' "$0"
    exit 0
    ;;
  *)
    echo "usage: scripts/sync-upstream.sh [--check]" >&2
    exit 2
    ;;
esac

root=$(git rev-parse --show-toplevel)
cd "$root"

status=0
fail() {
  echo "sync-upstream: FAIL $1" >&2
  status=1
}
ok() { echo "sync-upstream: ok  $1"; }

# 1. The deepseek-harness submodule pointer matches upstream.json.
submodule_commit=$(git ls-tree HEAD deepseek-harness | awk '{print $3}')
recorded_commit=$(node -p 'JSON.parse(require("node:fs").readFileSync("upstream.json", "utf8")).commit')
if [ "$submodule_commit" = "$recorded_commit" ]; then
  ok "submodule pointer matches upstream.json ($submodule_commit)"
else
  fail "submodule pointer $submodule_commit != upstream.json commit $recorded_commit"
fi
if git -C deepseek-harness rev-parse -q --verify "${recorded_commit}^{commit}" >/dev/null; then
  ok "recorded pin commit exists in the submodule checkout"
else
  fail "recorded pin commit $recorded_commit is missing from the submodule checkout"
fi

# 2. The vendored runtime materialization is in sync with upstream.json.
if node scripts/sync-vendored-runtime.mjs --check >/dev/null 2>&1; then
  ok "vendored runtime manifest is in sync with upstream.json"
else
  fail "vendored runtime is out of sync (run: node scripts/sync-vendored-runtime.mjs --check for details)"
fi

# 3. Root resolutions pin the @deepseek-ai/dsh* packages to the runtime version.
runtime_version=$(node -p 'JSON.parse(require("node:fs").readFileSync("upstream.json", "utf8")).runtimePackageVersion')
pinned_versions=$(node -p '
  const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
  JSON.stringify(Object.fromEntries(Object.entries(pkg.resolutions ?? {}).filter(([key]) => key.startsWith("@deepseek-ai/dsh"))),)
')
if node -e '
  const [, runtime, pinned] = process.argv;
  const entries = Object.entries(JSON.parse(pinned));
  if (entries.length === 0) process.exit(1);
  for (const [, selector] of entries) {
    // Vendored tarballs (file:vendor/dsh-runtime/<version>/...) or plain
    // version selectors must both name the recorded runtime version.
    if (!selector.includes(runtime)) process.exit(1);
  }
' "$runtime_version" "$pinned_versions"; then
  ok "resolutions pin @deepseek-ai/dsh* to ${runtime_version}"
else
  fail "resolutions do not uniformly pin @deepseek-ai/dsh* to ${runtime_version}: $pinned_versions"
fi

# 4. The enterprise patch registry (docs/fork-sop.md section 2) is complete.
while IFS= read -r relative_path; do
  if [ -e "$relative_path" ]; then
    ok "enterprise file present: $relative_path"
  else
    fail "enterprise file missing: $relative_path"
  fi
done <<'ENTERPRISE_FILES'
FORK.md
docs/fork-sop.md
docs/enterprise-self-hosting.md
PRIVACY.md
PRIVACY.zh.md
PRIVACY.i18n.yaml
dsh-plugin-desktop/src/enterprise-gate.ts
dsh-plugin-desktop/src/enterprise-oauth.ts
dsh-plugin-desktop/src/enterprise-loopback-callback.ts
dsh-plugin-desktop/src/enterprise-login-window.ts
dsh-plugin-desktop/src/enterprise-login-coordinator.ts
dsh-plugin-desktop/src/enterprise-token-store.ts
dsh-plugin-desktop/src/enterprise-token-refresher.ts
dsh-plugin-desktop/src/enterprise-llm-tokens.ts
dsh-plugin-desktop/src/enterprise-llm-token-refresher.ts
dsh-plugin-desktop/src/enterprise-identity.ts
dsh-plugin-desktop/src/enterprise-launch-environment.ts
dsh-plugin-desktop/src/enterprise-gateway-preset.ts
dsh-plugin-desktop/src/enterprise-update-preset.ts
dsh-plugin-desktop/src/enterprise-telemetry.ts
dsh-plugin-desktop/src/enterprise-desktop-routes.ts
dsh-plugin-desktop/src/enterprise-cordis-patch.ts
dsh-plugin-desktop/src/client/enterprise-session-banner.ts
dsh-plugin-desktop/tests/enterprise-launch-environment.spec.ts
dsh-plugin-desktop/tests/enterprise-gate.spec.ts
dsh-plugin-desktop/tests/enterprise-update-preset.spec.ts
dsh-plugin-desktop/tests/enterprise-telemetry.spec.ts
ENTERPRISE_FILES

# 5. The main.ts intrusion anchors are in place (docs/fork-sop.md section 2.2).
main_ts=dsh-plugin-desktop/src/main.ts
while IFS= read -r anchor; do
  if grep -qF -- "$anchor" "$main_ts"; then
    ok "main.ts anchor present: $anchor"
  else
    fail "main.ts anchor missing: $anchor"
  fi
done <<'MAIN_ANCHORS'
from './enterprise-gate.ts'
const updatePreset = resolveEnterpriseUpdatePreset()
const environment = createDesktopEnterpriseLaunchEnvironment(loadLayeredEnv(BIN_NAME, process.cwd()))
const enterprisePreset = resolveEnterpriseGatewayPreset(process.env)
provide('desktopEnterprise'
MAIN_ANCHORS

if [ "$status" -eq 0 ]; then
  echo "sync-upstream: all fork upgrade invariants hold (dry-run, nothing modified)"
else
  echo "sync-upstream: invariants broken; consult docs/fork-sop.md before upgrading" >&2
fi
exit "$status"
