import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertOwned, requireIdentity } from "./auth";
import { assessLocal, isValidDate, parseModelAssessment } from "../shared/riskRadar";
import { isOverdue } from "../shared/invoiceStatus";

const DEFAULT_ALLOWED_HOSTS = ["acme.example", "www.sec.gov", "reuters.com"];

function configuredEvidenceHosts(): Set<string> {
  const configured = process.env.RISK_RADAR_ALLOWED_HOSTS?.split(",")
    .map((host) => normalizeHostname(host.trim().toLowerCase())).filter(Boolean);
  return new Set(configured?.length ? configured : DEFAULT_ALLOWED_HOSTS);
}

function normalizeHostname(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function isPrivateIpv4(host: string): boolean {
  const octets = parseIpv4(host);
  if (!octets) return false;
  const [first, second] = octets;
  return first === 10 || first === 127 || (first === 169 && second === 254) ||
    (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}

function parseIpv6(host: string): number[] | null {
  let value = host;
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    const mappedIpv4 = parseIpv4(value.slice(separator + 1));
    if (separator < 0 || !mappedIpv4) return null;
    const [a, b, c, d] = mappedIpv4;
    value = `${value.slice(0, separator + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  if ((value.match(/::/g) ?? []).length > 1) return null;
  const [left, right] = value.split("::");
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right === undefined || !right ? [] : right.split(":");
  if ([...leftGroups, ...rightGroups].some((group) => !/^[\da-f]{1,4}$/i.test(group))) return null;
  const missing = 8 - leftGroups.length - rightGroups.length;
  if (value.includes("::") ? missing < 1 : missing !== 0) return null;
  return [...leftGroups.map((group) => parseInt(group, 16)), ...Array(missing).fill(0), ...rightGroups.map((group) => parseInt(group, 16))];
}

function isPrivateIpv6(host: string): boolean {
  const groups = parseIpv6(host);
  if (!groups) return false;
  const isMappedIpv4 = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMappedIpv4) return isPrivateIpv4(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`);
  return groups.every((group) => group === 0) || (groups[0] & 0xfe00) === 0xfc00 || (groups[0] & 0xffc0) === 0xfe80 ||
    (groups.length === 8 && groups[7] === 1 && groups.slice(0, 7).every((group) => group === 0));
}

function canonicalEvidenceUrl(value: string): string | null {
  if (value.trim() !== value || !value) return null;
  try {
    const url = new URL(value);
    const host = normalizeHostname(url.hostname.toLowerCase());
    // Never allow credentials, fragments, non-default ports, or private/local
    // destinations, even if an operator accidentally puts them in the allowlist.
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      isPrivateIpv4(host) || isPrivateIpv6(host)) return null;
    if (!configuredEvidenceHosts().has(host)) return null;
    return url.href;
  } catch { return null; }
}

const assessmentReturn = v.object({
  _id: v.id("riskAssessments"), _creationTime: v.number(), ownerId: v.string(), tenantId: v.string(), invoiceId: v.id("invoices"),
  idempotencyKey: v.string(), inputFingerprint: v.string(), assessedAt: v.number(), validUntil: v.number(),
  status: v.union(v.literal("ready"), v.literal("unknown"), v.literal("error"), v.literal("stale")),
  tier: v.union(v.literal("unknown"), v.literal("watch"), v.literal("elevated")), explanation: v.string(), citations: v.array(v.string()),
  evidenceIds: v.array(v.id("sourceEvidence")), provider: v.string(), model: v.string(), errors: v.array(v.string()),
});

function contentFingerprint(url: string, excerpt: string): string { return `${url}\n${excerpt}`.slice(0, 8_000); }

export const addEvidence = mutation({
  args: { invoiceId: v.id("invoices"), url: v.string(), title: v.string(), excerpt: v.string(), publishedAt: v.optional(v.string()), expiresAt: v.number(), provider: v.optional(v.union(v.literal("local"), v.literal("firecrawl"))) },
  returns: v.id("sourceEvidence"),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    assertOwned(invoice, identity);
    const canonicalUrl = canonicalEvidenceUrl(args.url);
    if (!canonicalUrl) throw new Error("Evidence URL is not an allowed public HTTPS source");
    if (args.title.trim() !== args.title || !args.title.trim() || !args.excerpt.trim() || args.excerpt.trim() !== args.excerpt || args.excerpt.length > 8_000) throw new Error("Evidence text is invalid or too large");
    if (args.publishedAt !== undefined && !isValidDate(args.publishedAt)) throw new Error("publishedAt must be a valid date");
    if (!Number.isSafeInteger(args.expiresAt) || args.expiresAt <= Date.now()) throw new Error("expiresAt must be in the future");
    const provider = args.provider ?? "local";
    return await ctx.db.insert("sourceEvidence", { ...args, url: canonicalUrl, provider, ownerId: identity.userId, tenantId: identity.tenantId, contentHash: contentFingerprint(canonicalUrl, args.excerpt), retrievedAt: Date.now() });
  },
});

export const listEvidence = query({
  args: { invoiceId: v.id("invoices") },
  returns: v.array(v.object({ _id: v.id("sourceEvidence"), _creationTime: v.number(), ownerId: v.string(), tenantId: v.string(), invoiceId: v.id("invoices"), url: v.string(), title: v.string(), excerpt: v.string(), publishedAt: v.optional(v.string()), retrievedAt: v.number(), expiresAt: v.number(), provider: v.union(v.literal("local"), v.literal("firecrawl")), contentHash: v.string() })),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    assertOwned(invoice, identity);
    return await ctx.db.query("sourceEvidence").withIndex("by_owner_tenant_invoice", (q) => q.eq("ownerId", identity.userId).eq("tenantId", identity.tenantId).eq("invoiceId", args.invoiceId)).order("desc").take(100);
  },
});

export const assess = mutation({
  args: { invoiceId: v.id("invoices"), asOfDate: v.string(), idempotencyKey: v.string(), evidenceIds: v.array(v.id("sourceEvidence")), modelOutput: v.optional(v.string()), validForMs: v.optional(v.number()) },
  returns: assessmentReturn,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    assertOwned(invoice, identity);
    if (!isValidDate(args.asOfDate)) throw new Error("asOfDate must be a valid date");
    if (!args.idempotencyKey.trim() || args.idempotencyKey.length > 200) throw new Error("idempotencyKey is invalid");
    const prior = await ctx.db.query("riskAssessments").withIndex("by_owner_tenant_idempotency", (q) => q.eq("ownerId", identity.userId).eq("tenantId", identity.tenantId).eq("idempotencyKey", args.idempotencyKey)).first();
    if (prior) return prior;
    const evidence = await ctx.db.query("sourceEvidence").withIndex("by_owner_tenant_invoice", (q) => q.eq("ownerId", identity.userId).eq("tenantId", identity.tenantId).eq("invoiceId", args.invoiceId)).take(100);
    const selected = evidence.filter((item) => args.evidenceIds.includes(item._id));
    if (selected.length !== args.evidenceIds.length) throw new Error("Evidence is not owned by this invoice");
    const now = Date.now();
    const stale = selected.length === 0 || selected.some((item) => item.expiresAt <= now);
    let status: "ready" | "unknown" | "error" | "stale" = stale ? (selected.length === 0 ? "unknown" : "stale") : "ready";
    let tier: "unknown" | "watch" | "elevated" = "unknown";
    let explanation = stale ? "No fresh source evidence is available; assessment is not reliable." : "";
    const errors: string[] = stale ? [selected.length === 0 ? "missing evidence" : "evidence is stale"] : [];
    if (!stale) {
      try { const result = args.modelOutput ? parseModelAssessment(args.modelOutput) : assessLocal({ amountCents: invoice.amountCents, dueDate: invoice.dueDate, asOfDate: args.asOfDate }); tier = result.tier; explanation = result.explanation; }
      catch (error) { status = "error"; errors.push(error instanceof Error ? error.message : "model assessment failed"); explanation = "Assessment failed safely; no automated action was taken."; }
    }
    const validUntil = now + (args.validForMs !== undefined && Number.isSafeInteger(args.validForMs) && args.validForMs > 0 ? args.validForMs : 86_400_000);
    const id = await ctx.db.insert("riskAssessments", { ownerId: identity.userId, tenantId: identity.tenantId, invoiceId: args.invoiceId, idempotencyKey: args.idempotencyKey, inputFingerprint: `${args.asOfDate}:${selected.map((item) => item.contentHash).sort().join("|")}`, assessedAt: now, validUntil, status, tier, explanation, citations: selected.map((item) => item.url), evidenceIds: selected.map((item) => item._id), provider: args.modelOutput ? "provider" : "local", model: args.modelOutput ? "configured" : "deterministic", errors });
    const created = await ctx.db.get(id);
    if (!created) throw new Error("Assessment could not be persisted");
    return created;
  },
});

const radarInvoice = v.object({
  _id: v.id("invoices"), invoiceNumber: v.string(), clientName: v.string(), amountCents: v.number(),
  currency: v.string(), dueDate: v.string(), status: v.union(v.literal("draft"), v.literal("sent"), v.literal("overdue"), v.literal("paid")),
});
const radarAssessment = v.object({
  _id: v.id("riskAssessments"), status: v.union(v.literal("ready"), v.literal("unknown"), v.literal("error"), v.literal("stale")),
  tier: v.union(v.literal("unknown"), v.literal("watch"), v.literal("elevated")), assessedAt: v.number(), validUntil: v.number(),
  explanation: v.string(), citations: v.array(v.string()), errors: v.array(v.string()),
  proposedEscalation: v.optional(v.object({ state: v.literal("approval_required"), summary: v.string() })),
});

export const dashboard = query({
  args: { asOfDate: v.string() },
  returns: v.array(v.object({ invoice: radarInvoice, assessment: v.union(radarAssessment, v.null()) })),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    if (!isValidDate(args.asOfDate)) throw new Error("asOfDate must be a valid date");
    const invoices = await ctx.db.query("invoices")
      .withIndex("by_owner_tenant_due_date", (q) => q.eq("ownerId", identity.userId).eq("tenantId", identity.tenantId))
      .order("asc").take(200);
    const overdue = invoices.filter((invoice) => isOverdue(invoice.dueDate, invoice.status, args.asOfDate));
    const now = Date.now();
    const rows = [];
    for (const invoice of overdue) {
      const snapshots = await ctx.db.query("riskAssessments")
        .withIndex("by_owner_tenant_invoice", (q) => q.eq("ownerId", identity.userId).eq("tenantId", identity.tenantId).eq("invoiceId", invoice._id))
        .order("desc").take(1);
      const latest = snapshots[0];
      const stale = latest !== undefined && latest.validUntil <= now;
      const assessment = latest ? {
        _id: latest._id, status: stale ? "stale" as const : latest.status, tier: stale ? "unknown" as const : latest.tier,
        assessedAt: latest.assessedAt, validUntil: latest.validUntil,
        explanation: stale ? "This assessment has expired; obtain fresh evidence before relying on it." : latest.explanation,
        citations: latest.citations, errors: stale ? [...latest.errors, "assessment is stale"] : latest.errors,
        ...(latest.status === "ready" && latest.tier === "elevated" && !stale
          ? { proposedEscalation: { state: "approval_required" as const, summary: "Human review is required; no message has been sent." } } : {}),
      } : null;
      rows.push({ invoice: { _id: invoice._id, invoiceNumber: invoice.invoiceNumber, clientName: invoice.clientName, amountCents: invoice.amountCents, currency: invoice.currency, dueDate: invoice.dueDate, status: invoice.status }, assessment });
    }
    return rows;
  },
});

export const listAssessments = query({
  args: { invoiceId: v.id("invoices") },
  returns: v.array(assessmentReturn),
  handler: async (ctx, args) => { const identity = await requireIdentity(ctx); const invoice = await ctx.db.get(args.invoiceId); if (!invoice) throw new Error("Invoice not found"); assertOwned(invoice, identity); return await ctx.db.query("riskAssessments").withIndex("by_owner_tenant_invoice", (q) => q.eq("ownerId", identity.userId).eq("tenantId", identity.tenantId).eq("invoiceId", args.invoiceId)).order("desc").take(100); },
});