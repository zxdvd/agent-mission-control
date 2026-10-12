# Verification report

Updated 2026-10-12 for independent password authentication and fixed per-host tokens. Development and testing were confined to y's cloud workspace; no user computer, real Agent configuration or real credential was used.

## Current implementation

- Cloudflare Access authentication is removed. The dashboard uses a shared administrator password verifier, signed secure sessions with D1 revocation, strict same-origin CSRF checks and D1 transactional login limits.
- Worker Secrets are the authoritative password/session/per-host credential configuration. Fixed per-host SHA-256 token digests are checked on every ingest; previous database credentials cannot grant access.
- Login is public; dashboard data/assets are protected. Config failures are closed. All signed-in humans have administrator privileges; no individual accounts, reader role, MFA or per-user attribution is claimed.
- New migration removes the obsolete host_credentials table and adds short-lived session and login-rate state. Monitoring history remains intact.
- Codex-first/Claude adapters remain observational. Task outcome, activity, connection and attention remain independent. No remote execution, reply, approval or retry-command endpoint exists.

A single fixed username is required in DASHBOARD_USERNAME, supplied by the GitHub production variable to the Worker. Missing configuration fails closed; username/password errors are generic and username changes invalidate sessions. Existing password verifier format is unchanged; this authentication upgrade invalidates old sessions.

Password minimum is eight characters in the helper, server validation and login form; PBKDF2 iterations, session-key requirements and per-host token strength are unchanged. Seven-character rejection and eight-character success are covered, including native Worker login. Existing valid verifiers for passwords of at least eight characters remain usable.

## Current validation

Final local checks passed: **117 automated tests** (26 backend projections, 23 auth/security, 8 full native Worker, 20 frontend DOM/API, 9 deployment guards, 3 credential utilities, 24 adapter/fixture tests, and 4 migration-compatibility tests). Typecheck, ESLint and production build passed. Exact publication CI is checked separately. Automated checks cover password/session/CSRF/host isolation, real Miniflare D1 state and event ordering, frontend DOM/API behavior, deployment configuration guards, credential helper safety and adapter/fixture contracts. Typecheck, lint and production build are run against the final source. Runtime dependency audit reported zero known vulnerabilities at check time.

Local Wrangler applied both SQL migrations successfully to a separate synthetic test database. However, the current cloud execution environment blocks Wrangler's network-interface enumeration (`uv_interface_addresses` system error), including one supported escalation attempt. Therefore the updated integration/simulation/live-adapter scripts could not execute against a listening HTTP server in this run. The isolated scripts are supplied for a supported environment; they are not presented as passing HTTP tests.

A bundled Worker regression also executes startup and authentication in native workerd. Its explicitly supported compatibility date is 2026-08-01 because the installed local workerd supports dates only through 2026-08-06; this does not certify the production configuration’s 2026-10-01 compatibility date.

The previous Access-based revision had passed 25 real HTTP assertions, live fixture-to-Worker ingestion, Cron invocation and restart persistence. Those historical results do **not** validate the newly changed authentication paths. The initial source publication also passed [GitHub CI](https://github.com/zxdvd/agent-mission-control/actions/runs/38200756620); final password-version CI is checked separately after publication.

## Not verified or deployed

- No actual Cloudflare deployment, remote migration, real Secret generation/configuration, account upgrade or production authentication was performed.
- Workers Free's 10ms CPU limit may be too low for 100,000-iteration PBKDF2 login. A successful local check does not establish production CPU headroom. Actual account/plan acceptance must test login; no automatic paid upgrade or password-strength reduction is implemented.
- Desktop/mobile visual-browser acceptance remains incomplete: Chromium had socket permission errors, and the official cloud browser cannot map this namespace's localhost. No alternate route was used to bypass restrictions. DOM tests do not verify pixels or CSS layout.
- The Playwright script is supplied, not certified as passing. It requires a supported browser (`npx playwright install chromium` or CHROMIUM_PATH), plus the synthetic local fixture setup.
- Native Codex/Claude sessions were not launched. Earlier read-only detection found Codex 0.159.2 and no Claude CLI. Official-event-shaped fixtures establish adapter behavior, not every installed version's actual hooks.
- Production Cron scheduling, secret propagation/rotation, secure browser-cookie behavior, deployed CPU headroom and real mobile layout remain production acceptance items.

## Operational limits

- Everyone knowing the shared dashboard password has administrator access. Use a strong unique long password and share only with fully trusted people.
- Password/session-key rotation invalidates existing sessions; logout revokes the current session. Fixed host-token deletion/rotation preserves history and applies after configuration propagation.
- Login limits can intentionally deny further attempts temporarily; a distributed attacker can consume the shared global budget. This is a small personal service, not an enterprise identity system.
- Notify-only Codex cannot reliably observe starts, approvals or process crashes. Enhanced lifecycle hooks require explicit local trust.
- Adapter queues are bounded and fail-open; pressure/network failures can drop excess/old records. There is no always-running monitoring daemon or guaranteed-lossless audit log.
- Without a wrapper or explicit OS heartbeat schedule, silence means inferred stale/offline, not failure. Host clocks must be reasonably accurate.
- Personal-scale list limits apply: 500 tasks/hosts and 200 overview attention items, with paginated task event history. No retention deletion is automatic.
- Source archives contain only tracked source/templates/synthetic fixtures; private configs, database state, dependencies, logs, screenshots and real credentials are excluded.


## Initial remote migration repair (2026-10-12)

The user's first manual deployment of commit 31cc3207 reached remote D1 migration 0001, returned `incomplete input` (7500), and skipped the Worker deployment step. Local Wrangler uses its client-side statement splitter; the remote migration path sends joined SQL and a ledger INSERT to `/query`. The exact server-side parser implementation is not available here, so a historical CASE/END compatibility model is not presented as a reproduction of the current service.

The repair changes only the initial migration's two triggers to single lines with parenthesized CASE expressions, plus LF normalization. Migration 0002, table definitions, constraints and projection logic are unchanged. An independent SQLite comparison found identical execution opcodes except Trace fields carrying reformatted SQL, matching representative state projections and identity rejection. Tests now use the actual installed Wrangler splitter rather than a bespoke parser; additional native workerd tests exercise complete trigger statements through D1 exec and migration-ledger-shaped batches. The real exec multiline incompatibility is explicitly distinguished from remote `/query` behavior.

No remote database was reset, edited or queried with newly obtained credentials during this repair. The user supplied separate read-only results: only platform/migration metadata tables were present, and d1_migrations had no rows. No project tables/triggers or applied migrations were shown; no database reset is needed for the pending initial migration retry. Publication/CI does not itself rerun production migrations or certify remote acceptance.
