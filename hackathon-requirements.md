# Convex All Gas Hackathon — Requirements and Compliance

**Recovered:** 2026-09-22
**Project:** Ledgerly / Invoice Chasing

## Official sources

- Luma event page: https://luma.com/convex-allgas-hackathon
- Convex hackathon page: https://www.convex.dev/hackathons/all-gas
- Required submission link: https://vibeapps.dev/judging/convex-all-gas-hackathon-openai/submit

## Core requirements

- Build a **new app** started on or after **August 25, 2026**.
- Convex must be the backend: database, functions, and realtime sync run on Convex.
- Build with Codex or another agent/IDE using the Convex plugin.
- Deploy a public app.
- Official Luma wording requires the frontend to use Convex static hosting with a `convex.site` URL or ChatGPT Sites with a `chatgpt.site` URL.
- Maintain a live URL in the repository hackathon build log.
- Use a public GitHub repository; private repositories are not allowed.
- Submit through the exact Vibe Apps judging link before **September 22, 2026 at 12:00 PM PT**.
- Include a video demo; the Convex page describes a three-minute video.
- The Convex page requires Convex plus a hackathon cohost or partner integration.
- The Luma page identifies the sponsors/partners as OpenAI, Firecrawl, and AgentMail.

## Participation steps listed by Luma

1. Register on Luma.
2. Use the hackathon setup prompt.
3. Build the new Convex-backed app.
4. Deploy the public app.
5. Share the app and tag Convex, OpenAI, Firecrawl, and AgentMail on X or LinkedIn.
6. Submit the app and video through the exact Vibe Apps judging URL.

## Eligibility and rules surfaced by the official pages

- Participants must be at least 18 years old.
- Teams may have no more than four people.
- Only one team member needs to register on Luma.
- Employees of Convex, OpenAI, Firecrawl, AgentMail, and immediate family members are not eligible.
- Restricted jurisdictions listed by the event rules are excluded.
- The project must be original work and must not violate intellectual-property or other rights.
- Submission materials must be in English, or include English translations.
- No localhost submission.

## Judging criteria

The Convex judging page lists:

- Creativity and usefulness
- Sponsor stack
- Live URL
- Social proof
- Video demo

## Ledgerly status

### Satisfied or substantially evidenced

- New project timing is recorded as 2026-08-29, after the August 25 start date.
- Convex is the production backend: https://necessary-mammoth-771.convex.cloud
- Public GitHub repository: https://github.com/helmi-rahman/ledgerly-invoice-chasing
- Live production frontend: https://invoice-chasing.vercel.app
- Authenticated production flow verified through Clerk, Convex JWT validation, dashboard loading, invoice creation/editing, live updates, previews, and reply classification.
- Build log exists in `hackathon.md` and records the live URLs and implementation evidence.
- Agent-based development and Convex tooling were used.

### Open or potentially non-compliant

- **Hosting:** current frontend is on Vercel, while the official Luma requirement says Convex static hosting (`convex.site`) or ChatGPT Sites (`chatgpt.site`). Confirm whether an exception exists before treating the current Vercel deployment as submission-compliant.
- **Exact Vibe Apps submission:** not yet verified in this project record.
- **Video demo:** not yet produced or verified.
- **Social sharing/tagging:** not yet recorded.
- **AgentMail:** production outbound delivery is not live; Convex still needs `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID`. Inbound processing additionally needs `AGENTMAIL_WEBHOOK_SECRET` and webhook configuration.
- **Firecrawl/OpenAI:** provider paths exist, but they must not be described as live unless externally configured and verified.

## Important submission rule

Do not claim Ledgerly satisfies the full hackathon requirements until the hosting requirement, exact Vibe Apps submission, video, and any required sponsor integration are verified. The current Vercel deployment is live and useful for testing, but it may not satisfy the event's stated hosting requirement.
