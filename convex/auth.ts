import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";

type AuthCtx = QueryCtx | MutationCtx | ActionCtx;

export type TenantIdentity = {
  userId: string;
  tenantId: string;
};

/** Require an authenticated Convex identity and derive the tenant boundary. */
export async function requireIdentity(ctx: AuthCtx): Promise<TenantIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error("Unauthenticated");

  // Identity providers may expose an organization/workspace claim. Fall back
  // to the subject so a user still receives an isolated tenant by default.
  const claims = identity as unknown as Record<string, unknown>;
  const tenantClaim = claims.org_id ?? claims.tenant_id ?? claims.organization_id;
  return {
    userId: identity.subject,
    tenantId: typeof tenantClaim === "string" && tenantClaim ? tenantClaim : identity.subject,
  };
}

export function assertOwned(record: { ownerId?: string; tenantId?: string }, identity: TenantIdentity): void {
  if (record.ownerId !== identity.userId || record.tenantId !== identity.tenantId) {
    throw new Error("Not authorized");
  }
}