# Agent Mission Control

A self-hosted, monitoring-only console for Codex (primary) and Claude Code. React + TypeScript + Tailwind/Radix shadcn-style UI, Hono on Cloudflare Workers Static Assets, D1, and Cron. No Durable Objects, Redis, Kubernetes, or monitoring daemon.

## Data boundary

Only host/task/run/session identifiers and explicitly allowed metadata reach the server. Adapters discard prompt contents, assistant responses, tool inputs, commands, transcript paths, code, and credentials. The console never executes commands, sends replies, or grants approvals. Explicitly supplied task names, summaries, repository names and URLs are metadata you choose to share; avoid secrets in these fields.

Connection, activity, attention and task outcome are independent. A turn ending is idle, not task completion. No events is unknown/stale, not failure. An agent process exiting is not proof that its task passed. Inferred alerts are visibly different from directly observed requests/errors. Codex notify-only cannot report approvals or the start of a turn; lifecycle hooks provide greater coverage only after explicit local trust.

## Local development

Requires Node.js 22 or newer and npm.

```sh
npm ci
cp .env.example .dev.vars
npm run db:migrate
npm run build
npm run dev:worker
```

Open http://127.0.0.1:8787. Local development authorization is deliberately restricted to loopback and must never be exposed through a tunnel or deployed. `.dev.vars` is ignored by Git and not shipped in the source archive. For hot reload, run `npm run dev` in a second terminal; Vite forwards `/api` to port 8787.

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

D1 persists beneath `.wrangler/state`. Reloading the browser or restarting Wrangler preserves data. To start a fresh test database, stop Wrangler and remove only the disposable local state after confirming you no longer need it. Never use local deletion instructions against production.

## Architecture

- `src/`: dashboard, attention inbox, task/run timeline, hosts, filters, rename/archive, dark/light and mobile layouts.
- `worker/`: authorization, validation, event ingestion, read/write API and cron maintenance.
- `migrations/`: D1 schema and projection invariants.
- `adapters/`: Codex and Claude installation, observation and bounded delivery.
- `scripts/`: repeatable local scenario and integration checks.
- `tests/`: validation, state, security and adapter regression tests.

The browser polls every seven seconds. SQLite/D1 is the source of truth; demo scenarios write through the same authenticated ingestion API. Production never substitutes mocked data. Attention read/ignore controls organize notifications only; they cannot approve an agent action. Task archive is reversible and does not delete event history. A new run records a retry; it does not remotely restart an agent.

## Security model

The entire Worker, including static assets, authenticates Cloudflare Access JWTs server-side. Configure issuer/audience and the admin email allowlist. Dashboard read access does not confer host token administration. Agent ingestion uses a separate, per-host bearer credential; only its SHA-256 digest is stored. Credentials are revocable, cannot read the dashboard, and cannot impersonate another host. Event validation, bounded requests, rate limiting, event-id deduplication, identity checks and chronological projection protect the ingestion boundary. Browser state changes use same-origin protections. Do not log Authorization headers or host credentials.

Production is fail-closed when Access settings are absent. Do not deploy with `LOCAL_DEV=true`. Access must cover the dashboard and admin/read APIs. Agent ingestion cannot perform browser login, so deploy an explicit Access bypass only for the exact `/api/events` path; that endpoint still requires the Worker’s host credential. Do not bypass `/api/*` broadly. Alternatively use a separate ingestion hostname routed to the same Worker with equivalent exact-path restrictions.

## Cloudflare deployment

For the recommended private GitHub repository + manual Actions path, follow [中文 GitHub Actions 部署步骤](DEPLOY.zh-CN.md). CI does not deploy; production uses explicit workflow_dispatch, main-only guards, a protected production environment, and an opt-in migration step.

Deployment was not performed as part of this source delivery unless explicitly stated in the verification report. You need your own Cloudflare account, Workers/D1 permission and a configured Access application. Creating credentials, expanding Access permissions or accepting costs requires your approval.

1. Authenticate your own deployment CLI: `npx wrangler login`.
2. Create D1: `npx wrangler d1 create mission-control`. Copy the returned database ID into `wrangler.jsonc`.
3. In Cloudflare Zero Trust, configure a self-hosted Access application for the dashboard hostname, an explicit allow policy for intended users, and the narrowly scoped ingestion exception described above. Do not publish the app before protection is ready.
4. Set `ACCESS_TEAM_DOMAIN` to the team’s `*.cloudflareaccess.com` domain, `ACCESS_AUD` to the application audience, `ADMIN_EMAILS` to the comma-separated trusted operators; retain `LOCAL_DEV=false` in `wrangler.jsonc`.
5. Apply production schema: `npx wrangler d1 migrations apply mission-control --remote`.
6. Build and publish: `npm run build && npx wrangler deploy`.
7. Verify unauthenticated dashboard/read/admin requests are rejected; verify valid Access identity works, an ordinary reader cannot administer hosts, and a host token can only ingest for its own host.
8. Register each host as an authenticated admin, copy its one-time returned token into the host’s private adapter config, and test revocation. Never put tokens in Git, shell history, screenshots or chat.

Cloudflare may charge based on plan and usage. Review the current account limits before deployment. Cron runs every two minutes; dashboard connectivity freshness is also derived during reads. Hooks alone are intermittent: without an explicitly configured OS heartbeat scheduler or a foreground wrapper, silence only means last-seen/unknown, not a confirmed machine outage.

## Register or revoke a host (administrator API)

The Hosts page is observational; this MVP exposes registration/revocation through the authenticated API. Sign in to your protected dashboard as an email listed in `ADMIN_EMAILS`, then run the following in that dashboard's browser developer console. Only do this on your own verified dashboard origin:

```js
await fetch('/api/admin/hosts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ host_id: 'my-mac', name: 'My Mac' })
}).then(response => response.json())
```

The returned `token` is shown once. Transfer it directly into the private local adapter setup; never send it in chat or commit it. An existing host ID is rejected rather than silently rotating credentials. To revoke that host immediately:

```js
await fetch('/api/admin/hosts/my-mac/credential', {
  method: 'DELETE'
}).then(response => response.json())
```

This preserves monitoring history. Re-register with a new host ID for a replacement credential. Ordinary readers cannot create/revoke credentials or change tasks/inbox state.

## Adapter installation and limitations

See [adapter instructions](adapters/README-adapters.md) for exact isolated install/uninstall commands, Codex notify and opt-in lifecycle-hook setup, and Claude hooks. No installer was run against a real user configuration during development.

- Codex legacy notify reports `agent-turn-complete` via argv JSON only. It does not cover turn start, approvals, crashes or exits.
- Current Codex lifecycle hooks are version/capability-dependent and require `/hooks` review and trust; no trust bypass is installed.
- Claude `Stop` means the response stopped. It is not a Mission completion signal.
- Native hook coverage is limited. Pending approval observations cannot be automatically declared resolved without a matching explicit resolution signal.
- OpenCode is intentionally deferred for this Codex-first MVP. The ingestion contract retains an agent type boundary for future adapters, not a claim of tested OpenCode support.
- Explicit task completion/failure events are the only terminal evidence. A wrapper's zero exit code is not acceptance of a task.

## Official interface references

- [Codex notify](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)
- [Codex lifecycle hooks and trust](https://learn.chatgpt.com/docs/hooks)
- [Codex non-interactive JSON events](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)

Adapters are monitoring integrations, not approval agents. See [VERIFICATION.md](VERIFICATION.md) for what was actually exercised and what requires a real installed CLI/Cloudflare account.

## Browser verification script

A Playwright script is included but was not executed successfully in the restricted cloud runtime. On a supported development machine, start a fresh local database, run `npm run simulate`, install the official browser with `npx playwright install chromium`, and run `npm run test:browser`. Alternatively set `CHROMIUM_PATH` to an existing supported browser executable. The script checks desktop/mobile interactions and writes synthetic-data screenshots beneath the OS temporary directory. DOM tests in `npm test` exercise application logic with a synthetic API fixture and are not visual-browser acceptance.
