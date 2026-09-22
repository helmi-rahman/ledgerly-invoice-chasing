# Hackathon log

- **Project:** Ledgerly / Invoice Chasing
- **Event:** Convex All Gas Hackathon
- **What it does:** Authenticated accounts-receivable workspace for creating, tracking, and updating invoices, with deterministic payment-chase previews, reply-intent classification, account-health summaries, and an optional provider-backed reminder flow.
- **Live app:** not deployed
- **Repo:** none
- **Frontend:** not deployed
- **Convex deployment:** not deployed
- **Components:** none
- **Convex features:** schema, tables, indexes, queries, mutations, actions, HTTP actions, realtime subscriptions
- **Auth:** Clerk production path with a local JWT development gate
- **AI models:** gpt-4o-mini optional provider path; deterministic local fallback
- **Started:** 2026-08-29T02:20:31Z
- **Last updated:** 2026-08-29T18:52:35Z
- **Build-log rule:** update this file after each meaningful implementation or verification milestone; mark proposed, implemented, live-verified, and blocked work separately.

## Log

### 2026-08-29 - source-evidence backfill
Created a Vite + React + TypeScript frontend and Convex application structure. The workspace contains a local Convex deployment, generated Convex bindings, Clerk and Convex dependencies, Vitest/convex-test setup, and the initial Ledgerly invoice-management surface. No Git history is available, so this backfill uses source files, checked-in documentation, and local project artifacts rather than commits.

### 2026-08-29 - invoice domain and data model
Defined `invoices`, `chaseEvents`, and `webhookEvents` tables in `convex/schema.ts`, with invoice status and payment-plan validators plus tenant-, owner-, status-, due-date-, and provider-event indexes. Added authenticated invoice queries and mutations for listing, dashboard totals, creation, editing, deletion, status transitions, payment plans, and chase-event history (`convex/invoices.ts`).

### 2026-08-29 - authorization and validation
Added identity enforcement and ownership checks for reads, writes, and actions. Invoice operations validate required fields, email format, positive integer-cent amounts, date ordering, payment-plan values, UTC contact timestamps, duplicate invoice numbers, legal status transitions, and tenant isolation (`convex/auth.ts`, `convex/invoices.ts`, `convex/invoices.test.ts`).

### 2026-08-29 - deterministic invoice intelligence
Added local, deterministic intelligence for overdue-message drafting, inbound-reply intent parsing, payment-plan validation, and account-health summaries. The preview queries are authenticated, use owned invoice data, return bounded closed-domain results, and do not persist or send preview content (`convex/invoiceIntelligence.ts`, `shared/invoiceIntelligence.ts`).

### 2026-08-29 - optional provider-backed actions
Added an authenticated action path that can call the OpenAI Responses API using a configured model, validate structured draft output, and fall back to local deterministic behavior when the local provider is selected. Added an explicit confirmation boundary and idempotency key before sending an actual reminder through AgentMail (`convex/llm.ts`). Provider credentials are runtime configuration and are not recorded here.

### 2026-08-29 - protected AgentMail webhook
Added `POST /agentmail/webhook` as a Convex HTTP action. The endpoint enforces a one-megabyte body limit, validates timestamped Svix signatures, accepts only `message.received`, normalizes the nested AgentMail payload, claims provider events, classifies replies, and completes processing idempotently. Invalid, stale, oversized, unsupported, and replayed requests are handled explicitly (`convex/http.ts`, `convex/webhooks.ts`, `convex/invoices.ts`).

### 2026-08-29 - frontend experience
Built the Ledgerly interface in `src/App.tsx` and `src/styles.css`: invoice dashboard totals, live invoice list, status filters, invoice creation/editing/deletion, payment-plan fields, overdue handling, deterministic intelligence previews, reply classification, account-health display, and an explicit send-reminder confirmation flow. Convex React queries and mutations keep the dashboard live through subscriptions.

### 2026-08-29 - authentication paths
Added Clerk browser authentication for the production path, wired to request a `convex` JWT template, and a local-only short-lived JWT gate for development. The template itself remains required deployment configuration rather than repository content. The frontend rejects local Convex URLs outside development, and the authentication requirements and deployment setup are documented in `AUTH.md`.

### 2026-08-29 - tests and security coverage
Added `convex-test` and Vitest coverage for unauthenticated access, user and tenant isolation, duplicate invoice numbers, legal status transitions, invalid money/date/payment-plan inputs, deterministic intelligence contracts, webhook normalization, tenant mismatch handling, duplicate-event idempotency, Svix signature validation, stale timestamps, body-size limits, unsupported event types, and protected provider-backed processing (`convex/invoices.test.ts`, `convex/invoiceIntelligence.test.ts`).

### Proposed hackathon scope — Collections Risk Radar

Add a manually triggered, source-cited risk-signal workflow for overdue client accounts:

- Firecrawl searches and extracts public company signals such as insolvency/restructuring notices, adverse business news, billing-process changes, and other relevant public updates.
- OpenAI may summarize and classify the retrieved evidence, but must not invent facts or produce an opaque credit score.
- Convex stores the assessment, source URLs, publication/retrieval timestamps, signal categories, and review state.
- The dashboard can prioritize accounts with **high-attention signals** alongside invoice exposure, age, missed promises, disputes, and reply responsiveness.
- AgentMail remains responsible for user-approved reminders or escalations; risk findings never send email or change invoice status automatically.

This is **risk-signal monitoring**, not a credit bureau or formal credit decision. Public findings are advisory, source-linked, time-bounded, and marked unknown when evidence is missing or stale. The feature must not scrape private data, bypass access controls, infer personal email addresses, or make automated adverse decisions.

### Risk Radar research seam

The deterministic contract lives in `shared/riskRadar.ts` and is intentionally provider-neutral. Evidence is accepted only from exact HTTPS hostnames in the configured allowlist (`official`, `regulator`, or `reputable_news`); each accepted item carries a canonical URL, title, bounded excerpt (600 characters), an explicitly supplied `publishedAt` when available, the caller-supplied `observedAt`, freshness (`fresh|stale|unknown`), and retrieval provenance. Missing dates remain `unknown`; invalid, private, non-HTTPS, unlisted, or incomplete results become structured errors rather than signals. Fixtures and tests are in `shared/riskRadar.test.ts`.

The documented Firecrawl v2 seam is `POST https://api.firecrawl.dev/v2/search` with `query`, `limit`, exact `includeDomains`, and optional `scrapeOptions.formats: ["markdown"]`; a single-page fallback is `POST https://api.firecrawl.dev/v2/scrape` with `url` and markdown format. Both endpoints use `Authorization: Bearer <token>` when credentials are configured. The adapter must not make a live call without an explicitly configured credential. Sources: [Firecrawl Search API](https://docs.firecrawl.dev/api-reference/endpoint/search), [Firecrawl Scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape).

## Current state and known gaps

- Current implementation is **AgentMail-heavy**: outbound reminders and inbound signed webhook processing are core product paths. Collections Risk Radar is now a proposed Firecrawl scope addition; it is not implemented or live-verified yet.

- The project is **not publicly deployed**. No public frontend URL or Convex cloud deployment URL is recorded in the workspace.
- The project directory has no Git repository, so commit-level chronology cannot be recovered from local history.
- Production use still requires Clerk configuration, a Convex deployment auth issuer/JWT template, hosting environment variables, AgentMail/Svix configuration, provider credentials, and authenticated live end-to-end verification.
- Deterministic local previews are the current safe baseline. Provider-backed AI and outbound email are optional runtime paths and must not be treated as live merely because their code exists.
- This file is an evidence-based build log, not a deployment or hackathon-submission claim.

### 2026-09-22 - risk-radar backend verification blocker resolved
The local Convex push initially exposed a missing `@types/node` dependency for the `RISK_RADAR_ALLOWED_HOSTS` environment-variable access in `convex/riskRadar.ts` and its tests. Added the development type dependency and declared Node types in `convex/tsconfig.json`. Verified that `CONVEX_AGENT_MODE=anonymous npx convex dev --once` now completes with `Convex functions ready`, all 29 tests pass, and the production Vite build passes. Exercised the live local `riskRadar:dashboard` HTTP endpoint and confirmed unauthenticated access is rejected by the backend; no production deployment or external Firecrawl call was claimed.
