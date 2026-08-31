# DSH Desktop Enterprise — Privacy Policy

[中文](PRIVACY.zh.md)

- **Version:** 2.0 (enterprise deployment edition)
- **Effective and last updated:** September 1, 2026

This policy describes the DSH Desktop **enterprise build** — an internal, self-hosted deployment of the DSH Enterprise platform's desktop client. It replaces the upstream community privacy policy for this build: the official community distribution and the `dshdesktop.cn` online services are **not** involved in any data flow described here.

In this policy, "we" means the organization that deploys and operates this build (your enterprise platform operator). The personal-data controller for a deployment is that organization; questions and rights requests go to your internal administrator through your organization's own channels, not to any upstream community contact.

## 1. Scope

This policy covers the desktop client built from this repository when it is configured against an organization's self-hosted gateway. It describes:

- the client's **data plane**: what the client exchanges with the enterprise gateway and when;
- the client's **outbound-contact inventory**: every network destination the build can reach and its default state; and
- the **local data** the client stores on the workstation.

## 2. Summary

- All model and tool traffic goes to **your organization's gateway** (the preset `DSH_ENTERPRISE_GATEWAY_URL`). No third-party model service is configured by this build.
- **Update checks are off by default.** No production code path can reach the upstream public update service: the update preset resolver rejects that domain and its subdomains outright, and version checks and installer downloads run only if the deployment presets a self-hosted update origin (`DSH_ENTERPRISE_UPDATE_URL`). Nothing update-related is sent otherwise.
- **Community marketplaces are disabled by default.** The market provider starts in the `disabled` state and contacts nothing until explicitly enabled.
- **Telemetry is off by default.** A minimal privacy-telemetry module (client version, online status, error counts) ships ready but has no call site in this build; if a deployment later enables it, reports go only to the organization gateway.
- The installation UUID is generated and stored locally. In the default configuration it **never leaves the device**; it is only sent to organization-run endpoints (preset update source or enabled telemetry), and never to any public upstream endpoint.
- Sessions, credentials, logs, and crash files remain on the workstation by default; enterprise tokens are sealed in the operating-system keychain.

## 3. Enterprise gateway communication (the data plane)

The client's only always-on network relationship is with the organization gateway:

| Interaction | What is exchanged | Purpose |
| --- | --- | --- |
| Sign-in (OAuth 2.0 + PKCE) | The system browser opens the organization's authorization endpoint; a one-time code returns to a loopback listener on `127.0.0.1`. The client receives OAuth tokens. | Authenticate the employee; no password reaches the client. |
| Token refresh | The client presents its refresh token to the gateway token endpoint on the token half-life. | Keep the session valid without re-prompting. |
| Identity read | The client calls the gateway's identity/userinfo surface. | Render the signed-in account in settings (account, display name, roles). |
| LLM egress token | The client exchanges its session for a short-lived gateway-issued model token, injected into the agent environment (`DSH_LLM_TOKEN`). | Let model and tool calls egress through the gateway without exposing long-lived credentials. |
| Model and tool traffic | Prompts, responses, attachments, and tool inputs/outputs required by the agent session. | Delivered to the gateway's LLM surface, per the organization's platform policy. |

The gateway receives standard network metadata (IP address, time, TLS details) with every request, as any server does. What it can associate with a person is governed by the organization's own server-side policy, which is outside this document's scope.

## 4. Minimal telemetry (default off; endpoint pending server delivery)

The build contains a telemetry reporter with exactly these fields, nothing more:

- `clientVersion` — running client version;
- `online` — whether the client currently reaches the gateway;
- `errorCounts` — bounded per-kind error counters (labels limited to letters, digits, dot, underscore, hyphen; at most 32 kinds, saturating counts);
- plus the installation UUID and a UTC timestamp.

In this build the reporter is **dormant**: no code constructs or configures it, so there is no telemetry egress. The receiving surface (`POST /api/desktop/telemetry` on the gateway) is delivered by the governance server workstream; only after that surface exists and a deployment explicitly wires reporting on would reports start — and they go to the organization gateway only. Upstream session telemetry (`DSH_TELEMETRY_MODE`) remains `DISABLED` in the default composition; if an operator explicitly sets it, that traffic follows the upstream configuration and recipient.

## 5. Update checks and the installation UUID (default off; self-hosted only)

- With no preset update origin, the client registers no update tray item, no update route, and no background poll — **zero update-related egress**. An invalid preset is treated the same way (disabled, with a logged reason), and a preset naming the upstream public update domain (`dshdesktop.cn` or any of its subdomains) is rejected outright with a dedicated reason. There is no fallback to any public endpoint.
- When a deployment presets a self-hosted origin, the client periodically requests `GET {origin}/api/desktop/version` and, after explicit user confirmation per download, fetches installers from `{origin}/api/downloads/mac` or `/windows`. The version request carries the client version header and the installation UUID; download requests do not. The format is the upstream version-metadata contract (`{"version": "<stable SemVer>"}`, ≤ 4 KiB); signature verification is a planned server-side (T17) extension — the client does not yet require one.
- The installation UUID is a random UUID v4 generated locally, persisted under the Electron user-data directory (`identity/installation-id`, restrictive file permissions), regenerated only if the file is missing or corrupt, and never derived from hardware or account identifiers. It identifies a user-data directory, not a physical machine.

## 6. Outbound-contact inventory (default state)

| Destination | Default | When it could be contacted |
| --- | --- | --- |
| Organization gateway | The data plane above | Always, once the user signs in. |
| Self-hosted update origin | **Off** — not preset | Only if the deployment presets `DSH_ENTERPRISE_UPDATE_URL`. |
| Community market sources (npm registry, GitHub raw, catalog URLs) | **Disabled** — provider starts `disabled` | Only if a user explicitly selects a provider; a deployment can point npm and the catalog at internal mirrors (see `docs/enterprise-self-hosting.md`). |
| `dshdesktop.cn` or any upstream public service | **Never** | No production code path reaches it: the update preset resolver rejects that domain and its subdomains outright, and the runtime refuses to download without a preset origin. |
| Upstream session telemetry endpoint | `DISABLED` | Only if an operator explicitly sets `DSH_TELEMETRY_MODE`. |
| npm registries, dependency hosts, and the Electron Node-headers service (`https://electronjs.org/headers`) | **Runtime on demand** | When profile dependencies are materialized at startup, or when you run pnpm/terminal operations, the bundled package manager may contact them. The Electron headers URL is pinned via `npm_config_disturl`; the Electron binary download itself honors the standard `ELECTRON_MIRROR` environment variable, which a deployment can preset to an internal mirror (the materializer child process inherits the deployment's environment). Not contacted when no profile dependency materialization or package operation runs. |

## 7. Local data

| Data | Location | Notes |
| --- | --- | --- |
| Sessions, prompts, responses, tool records, attachments | `$DSH_HOME/sessions`, `$DSH_HOME/attachments/v1` | Local-first; content is sent to the gateway only when you invoke a model or tool. |
| Profiles, settings, machine patch | `$DSH_HOME` (including `cordis.patch.yml`) | Local configuration; retained until deleted. |
| Enterprise OAuth/LLM tokens | Operating-system keychain via Electron safeStorage | Sealed at rest; not written as plaintext files by this build. |
| Legacy local credentials | `$DSH_HOME/.credentials.yaml` (`0600` file, `0700` directory) | Not encrypted; same-OS-user processes can read it. |
| Installation UUID | `<user data>/identity/installation-id` | Local only, as described in Section 5. |
| Update and market state | `<user data>/updates/state.json`, `desktop-market/state.json` | Bookkeeping (last check, provider selection); the market state starts `disabled`. |
| Logs | Below the Electron user-data directory | 10 MiB rotation, 7-day cleanup, 200 MiB cap; may contain paths, session IDs, commands. |
| Crash files | Local Crashpad store | Collected locally; **no crash upload** is configured. |
| Diagnostic archives | Created only when you export one | May contain logs and identifiers; review before sharing. |

Uninstalling may leave these files behind; remove the DSH home and user-data directory if a workstation is being repurposed.

## 8. Browser and LAN access, and the local HTTP surface

Letting DSH open in a browser lets that browser reach the Host on your machine; loopback is limited to `127.0.0.1` by default. Upstream gates configuration surfaces behind a browser-trust marker plus a persistent browser session cookie. This build additionally layers an **enterprise-session requirement** on top: when an enterprise session exists, configuration and management requests also require a currently valid enterprise session (fail-closed), with sign-out and re-authentication windows exempt as recovery paths. Enabling LAN access still exposes session operation to LAN clients and should be temporary on a trusted network only.

## 9. Your choices

- Sign out to invalidate the local session and clear the signed-in state.
- Update checks stay off unless your deployment presets a source; there is no user-facing switch in this build by design.
- Telemetry is off unless your organization explicitly turns it on after the server side ships.
- Local data is removable per Section 7; deleting the installation UUID causes a new one at next launch.

## 10. Contact and changes

For privacy questions, data-subject requests, or retention inquiries, contact **your organization's deployment administrator** through internal channels. Upstream community contacts and services are not involved in this build and cannot answer on its behalf.

When data categories, recipients, or defaults change materially, this policy is updated with a new version and effective date in the repository history. The Chinese and English versions have equal authority; if they diverge, read them together and report the discrepancy to your administrator.
