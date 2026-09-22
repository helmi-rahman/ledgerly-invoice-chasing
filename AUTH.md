# Authentication

The Convex functions require a verified identity and must not be called anonymously. In production, the frontend uses Clerk's browser session and requests the configured `convex` JWT template, so Convex receives a refreshed identity token. It does not manufacture an identity or bypass backend checks.

For local development, create a local `.env.local` (which is gitignored) containing the Convex deployment URL and a short-lived JWT issued by the identity provider:

```text
VITE_CONVEX_URL=http://127.0.0.1:3210
VITE_CONVEX_AUTH_TOKEN=<user-managed JWT>
```

The token is intentionally not included in the repository or in production builds. Production setup requires:

1. Configure a Clerk application and a JWT template named `convex`, with its issuer matching the Convex deployment's auth provider configuration.
2. Set `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_CONVEX_URL` in the hosting environment. The publishable key is safe to expose in the browser; never place secret keys here.
3. Configure the Convex deployment's Clerk issuer and optional `org_id`/tenant claim before serving the app.

When `VITE_CLERK_PUBLISHABLE_KEY` is absent, the app intentionally uses the local-only token gate. A production build without the Clerk key cannot sign in and must not be treated as deployed. Do not replace either path with an anonymous or fake token.
