import { query } from "./_generated/server";
import { v } from "convex/values";
import { assertOwned, requireIdentity } from "./auth";
import {
  buildDraft,
  parseReplyIntent,
  summarizeAccountHealth,
  validatePaymentPlan,
  type ReplyClassification,
} from "../shared/invoiceIntelligence";

const intent = v.union(v.literal("promise_to_pay"), v.literal("dispute"), v.literal("question"), v.literal("ignore"));
const tone = v.union(v.literal("friendly"), v.literal("firm"), v.literal("final"));
const classification = v.object({ intent, confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")), source: v.union(v.literal("local"), v.literal("provider"), v.literal("fallback")), errors: v.array(v.string()) });

function daysBetween(dueDate: string, asOfDate: string): number {
  return Math.max(0, Math.floor((Date.parse(`${asOfDate}T00:00:00.000Z`) - Date.parse(`${dueDate}T00:00:00.000Z`)) / 86_400_000));
}

export const draftPreview = query({
  args: { invoiceId: v.id("invoices"), asOfDate: v.string(), tone: v.optional(tone) },
  returns: v.object({ tone, subject: v.string(), body: v.string(), provider: v.literal("local"), errors: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    assertOwned(invoice, identity);
    return buildDraft({ clientName: invoice.clientName, invoiceNumber: invoice.invoiceNumber, amountCents: invoice.amountCents, currency: invoice.currency, dueDate: invoice.dueDate, daysOverdue: daysBetween(invoice.dueDate, args.asOfDate), tone: args.tone });
  },
});

export const classifyPreview = query({
  args: { text: v.string() },
  returns: classification,
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    const result = parseReplyIntent(args.text);
    if (result.source === "fallback" && result.intent !== "ignore") {
      const localResult: ReplyClassification = { ...result, source: "local", errors: [] };
      return localResult;
    }
    return result;
  },
});

export const paymentPlanPreview = query({
  args: {
    issueDate: v.string(),
    installments: v.number(),
    cadence: v.string(),
    nextDueDate: v.string(),
    amountCents: v.number(),
  },
  returns: v.object({ valid: v.boolean(), errors: v.array(v.string()), normalized: v.optional(v.object({ installments: v.number(), cadence: v.union(v.literal("weekly"), v.literal("monthly")), nextDueDate: v.string(), amountCents: v.number() })) }),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    return validatePaymentPlan(args, args.issueDate);
  },
});

export const accountHealthPreview = query({
  args: {
    asOfDate: v.string(),
  },
  returns: v.object({ asOfDate: v.string(), invoiceCount: v.number(), outstandingCents: v.number(), overdueCents: v.number(), paidCents: v.number(), overdueCount: v.number(), risk: v.union(v.literal("healthy"), v.literal("watch"), v.literal("at_risk")), errors: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const { userId, tenantId } = await requireIdentity(ctx);
    const invoices = await ctx.db
      .query("invoices")
      .withIndex("by_owner_tenant_due_date", (q) => q.eq("ownerId", userId).eq("tenantId", tenantId))
      .order("asc")
      .take(200);
    return summarizeAccountHealth({
      asOfDate: args.asOfDate,
      invoices: invoices.map(({ amountCents, status, dueDate }) => ({ amountCents, status, dueDate })),
    });
  },
});
