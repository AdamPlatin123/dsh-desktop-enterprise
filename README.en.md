![DSH Desktop Enterprise](assets/enterprise/hero-banner.svg)

# DSH Desktop Enterprise

The official desktop client for the **DSH Enterprise** platform — a self-hosted, multi-tenant agent runtime for enterprise intranets. Agents execute on the user's own machine; model access is governed centrally by the enterprise gateway.

![MIT](https://img.shields.io/badge/License-MIT-green) ![Platforms](https://img.shields.io/badge/Platforms-Windows%20x64%20%7C%20macOS%20%7C%20Linux-blue) ![Zero Telemetry](https://img.shields.io/badge/Telemetry-Zero%20by%20Default-teal) ![OAuth2](https://img.shields.io/badge/Auth-OAuth2%20%2B%20PKCE-orange)

This is an enterprise fork of [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop). **It requires a privately deployed DSH Enterprise gateway — it is not a standalone public model client.**

## Highlights

- **Keys never leave the gateway.** The desktop holds only 10-minute, revocable generation-bound tokens. Model whitelist, quota, and auditing are enforced server-side.
- **Local execution, governed egress.** Files, terminal, and tools run on the user's machine; model calls go through the gateway's egress proxy.
- **Enterprise sign-in without touching passwords.** OAuth 2.0 / OIDC authorization-code flow with PKCE, completed in the system browser; tokens stored in the OS keychain (`safeStorage`).
- **Zero outbound by default.** Update checks, community market, and telemetry are off; self-hosted update sources are supported (the upstream public update domain is hard-rejected).

## Architecture

![Architecture and trust boundaries](assets/enterprise/architecture.svg)

## Sign-in flow

![OAuth sign-in and token renewal](assets/enterprise/oauth-flow.svg)

## Quick start

Requires Node.js 22.19+/24+, Corepack (Yarn 4.18.0), a desktop session, and OS secure storage. An administrator must provision a gateway URL and a registered OAuth client id:

```bash
git clone --recurse-submodules https://github.com/AdamPlatin123/dsh-desktop-enterprise.git
cd dsh-desktop-enterprise
corepack yarn install --immutable
export DSH_ENTERPRISE_GATEWAY_URL="https://gateway.corp.example"
export DSH_ENTERPRISE_OAUTH_CLIENT_ID="your-registered-desktop-client-id"
corepack yarn dev
```

## Relationship with upstream

Enterprise login gate, credential protection, short-lived model tokens with hot renewal, default-off egress policy, self-hosted update constraints, and the admin entry were added on top of upstream. **This is not an official Anywhere Labs enterprise release.** Kudos to the Anywhere Labs and DeepSeek Harness communities for the desktop and agent runtime foundations.

Upgrades follow the [fork SOP](./docs/fork-sop.md): re-apply registered patches against anchor strings, re-run the hot-reload security regression, commit pin changes separately, and halt on unexplained failures.

## License

[MIT](./LICENSE) — retaining Copyright © 2026 Anywhere Labs and Copyright © 2026 DSH Desktop Enterprise contributors.

---

中文版（主文档）见 [README.md](./README.md)。
