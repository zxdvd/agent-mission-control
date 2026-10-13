# Agent Mission Control

A self-hosted, monitoring-only console for Codex (primary) and Claude Code. React + TypeScript + Tailwind/Radix shadcn-style UI, Hono on Cloudflare Workers Static Assets, D1, and Cron. No Durable Objects, Redis, Kubernetes, or monitoring daemon.

## Data boundary

Only host/task/run/session identifiers and explicitly allowed metadata reach the server. Adapters discard prompt contents, assistant responses, tool inputs, commands, transcript paths, code, and credentials. The console never executes commands, sends replies, or grants approvals. Explicitly supplied task names, summaries, repository names and URLs are metadata you choose to share; avoid secrets in these fields.

Connection, activity, attention and task outcome are independent. A turn ending is idle, not task completion. No events is unknown/stale, not failure. An agent process exiting is not proof that its task passed. Inferred alerts are visibly different from directly observed requests/errors. Codex notify-only cannot report approvals or the start of a turn; lifecycle hooks provide greater coverage only after explicit local trust.

## Lightweight local adapter install

For Codex App local hooks, see [轻量 curl 安装与验收](INSTALL.zh-CN.md). The fixed-version installer downloads only four Node.js built-in-module adapters, preserves other hooks and existing credentials, and requires local hook review/trust. It does not install Node or a daemon.

## Local development

Requires Node.js 22 or newer and npm.

```sh
npm ci
cp .env.example .dev.vars
npm run db:migrate
npm run build
npm run dev:worker
```

Open http://127.0.0.1:8787. Local development authorization is deliberately restricted to loopback and must never be exposed through a tunnel or deployed. `.dev.vars` is ignored by Git and not shipped in the source archive. Use the Worker URL above for authentication testing; the Vite development server is a UI-only convenience, not the production authentication boundary.

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

The dashboard uses an independent fixed administrator username and shared password; no Cloudflare Access setup or login is required. A PBKDF2 verifier and independent session signing key live in Worker Secrets. Short-lived secure HttpOnly cookies, server-side session revocation, CSRF checks, and login rate limits protect browser operations. Login HTML is public; monitoring data and dashboard assets require authentication. Missing production secrets fail closed. All people sharing the password have the same administrator privileges; there are no separate readers, per-user audit identities or MFA in this personal MVP.

Agent ingestion has a separate fixed per-host token boundary: `AGENT_TOKENS_JSON` is a Worker Secret containing host IDs, names, and SHA-256 token digests. Each request checks the current configured host/token pair. Host tokens cannot sign in or read dashboard data, and browser sessions cannot ingest events. First valid ingestion creates a monitoring host record. No production credentials are minted by the application. Event validation, bounded requests, rate limiting, deduplication and identity guards remain enforced.

Never deploy `LOCAL_DEV=true`, expose local development through a tunnel, log credentials, or commit secrets. Password/session-key changes invalidate old sessions; logout revokes the current session. Removing a host from configured tokens revokes ingestion after configuration propagation; replacing its digest rotates its token without deleting history.

## Cloudflare deployment and host configuration

Follow [中文 GitHub Actions 部署步骤](DEPLOY.zh-CN.md). The public repository supports protected environments on GitHub Free. CI does not deploy; production uses manual workflow_dispatch, main-only guards, a production environment, and an opt-in migration step. Account ID, D1 ID and the chosen `DASHBOARD_USERNAME` are GitHub environment Variables. The deployment workflow writes the username as a non-secret Worker variable (1–64 ASCII letters/digits/underscore/dot/hyphen, beginning with a letter/digit, case-sensitive). `CLOUDFLARE_API_TOKEN` is the environment deployment Secret; `DASHBOARD_PASSWORD_HASH`, `SESSION_SECRET`, and `AGENT_TOKENS_JSON` are separately configured Cloudflare Worker Secrets. They never enter frontend build inputs.

Use `node scripts/password-hash.mjs` to prepare a verifier from a unique password of at least 8 characters (at most 1024 UTF-8 bytes) and `node scripts/token-hash.mjs < /private/path/token` to hash an independently generated high-entropy host token. These utilities do not install or configure credentials for you. Store each plaintext host token only in its corresponding private adapter file. See the deployment guide for exact configuration, rotation and acceptance steps. The old Access configuration and host-registration/revocation API are no longer used.

Cloudflare may charge based on plan and usage. Review account limits before deployment. Cron runs every two minutes; connectivity freshness is also derived during reads. Hooks alone are intermittent: without an explicitly configured OS heartbeat scheduler or foreground wrapper, silence only means last-seen/unknown, not confirmed machine outage.

## Synthetic local integration data

Ordinary local startup above displays an empty dashboard. For isolated synthetic ingestion tests, stop the ordinary Worker and use:

```sh
node scripts/local-fixtures.mjs
npm run db:migrate -- --persist-to .wrangler/test-state
npm run dev:worker -- --env-file .dev.vars.test --persist-to .wrangler/test-state
# In another terminal:
node --env-file=.env.test-hosts scripts/simulate.mjs
node --env-file=.env.test-hosts scripts/integration.mjs
node --env-file=.env.test-hosts tests/adapter-live.mjs
```

The fixture generator refuses to overwrite existing files. Its ignored files contain only explicitly synthetic test tokens, never usable production credentials. The `--env-file` option prevents loading ordinary `.dev.vars`; test data uses a separate local database directory. Backend authentication tests exercise password mode independently of this loopback-only integration identity.

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

A Playwright script is included but was not executed successfully in the restricted cloud runtime. On a supported development machine, start a fresh local database, run the synthetic simulation above, install the official browser with `npx playwright install chromium`, and run `npm run test:browser`. Alternatively set `CHROMIUM_PATH` to an existing supported browser executable. The script checks desktop/mobile interactions and writes synthetic-data screenshots beneath the OS temporary directory. DOM tests in `npm test` exercise application logic with a synthetic API fixture and are not visual-browser acceptance.
