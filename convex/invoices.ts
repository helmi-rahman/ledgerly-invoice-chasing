import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertOwned, requireIdentity } from "./auth";
import { INVOICE_STATUSES, isOverdue } from "../shared/invoiceStatus";

const status = v.union(...INVOICE_STATUSES.map((value) => v.literal(value)));

const paymentPlan = v.object({
  installments: v.number(),
  cadence: v.union(v.literal("weekly"), v.literal("monthly")),
  nextDueDate: v.string(),
});

const invoiceFields = {
  clientName: v.string(),
  clientEmail: v.string(),
  invoiceNumber: v.string(),
  amountCents: v.number(),
  currency: v.string(),
  issueDate: v.string(),
  dueDate: v.string(),
  status,
  notes: v.optional(v.string()),
  paymentPlan: v.optional(paymentPlan),
  lastContactedAt: v.optional(v.string()),
};

type PaymentPlan = { installments: number; cadence: "weekly" | "monthly"; nextDueDate: string };

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Optional contact time: a calendar date or an ISO-8601 UTC timestamp. */
function isUtcDateOrTimestamp(value: string): boolean {
  if (isDateOnly(value)) return true;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
}

function validatePaymentPlan(plan: PaymentPlan, issueDate: string): void {
  if (!Number.isFinite(plan.installments) || !Number.isInteger(plan.installments) || plan.installments <= 0) {
    throw new Error("Payment plan installments must be a positive integer");
  }
  if (!isDateOnly(plan.nextDueDate) || plan.nextDueDate < issueDate) throw new Error("Payment plan next due date is invalid");
}

function validateInvoiceFields(fields: {
  clientName: string; clientEmail: string; invoiceNumber: string; amountCents: number;
  currency: string; issueDate: string; dueDate: string; paymentPlan?: PaymentPlan; lastContactedAt?: string;
}): void {
  for (const [name, value] of [["Client name", fields.clientName], ["Client email", fields.clientEmail], ["Invoice number", fields.invoiceNumber], ["Currency", fields.currency]] as const) {
    if (!value.trim()) throw new Error(`${name} is required`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.clientEmail)) throw new Error("Client email is invalid");
  if (!Number.isFinite(fields.amountCents) || !Number.isInteger(fields.amountCents) || fields.amountCents <= 0) throw new Error("Amount must be a positive integer number of cents");
  if (!isDateOnly(fields.issueDate) || !isDateOnly(fields.dueDate) || fields.dueDate < fields.issueDate) throw new Error("Invoice dates are invalid or out of order");
  if (fields.paymentPlan) validatePaymentPlan(fields.paymentPlan, fields.issueDate);
  if (fields.lastContactedAt !== undefined && !isUtcDateOrTimestamp(fields.lastContactedAt)) throw new Error("lastContactedAt must be a UTC date or timestamp");
}

const invoiceReturn = v.object({
  _id: v.id("invoices"),
  _creationTime: v.number(),
  // Legacy rows may predate tenant isolation; indexed tenant reads never return them.
  ownerId: v.optional(v.string()),
  tenantId: v.optional(v.string()),
  ...invoiceFields,
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const get = query({
  args: { id: v.id("invoices") },
  returns: v.union(invoiceReturn, v.null()),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) return null;
    assertOwned(invoice, identity);
    return invoice;
  },
});

export const list = query({
  args: { status: v.optional(status) },
  returns: v.array(invoiceReturn),
  handler: async (ctx, args) => {
    const { userId, tenantId } = await requireIdentity(ctx);
    if (args.status !== undefined && args.status !== "overdue") {
      return await ctx.db
        .query("invoices")
        .withIndex("by_owner_tenant_status", (q) => q.eq("ownerId", userId).eq("tenantId", tenantId).eq("status", args.status!))
        .order("desc")
        .take(200);
    }
    const invoices = await ctx.db
      .query("invoices")
      .withIndex("by_owner_tenant_due_date", (q) => q.eq("ownerId", userId).eq("tenantId", tenantId))
      .order("asc")
      .take(200);
    return args.status === "overdue"
      ? invoices.filter((invoice) => isOverdue(invoice.dueDate, invoice.status))
      : invoices;
  },
});

export const listOverdue = query({
  args: {},
  returns: v.array(invoiceReturn),
  handler: async (ctx) => {
    const { userId, tenantId } = await requireIdentity(ctx);
    const invoices = await ctx.db
      .query("invoices")
      .withIndex("by_owner_tenant_due_date", (q) => q.eq("ownerId", userId).eq("tenantId", tenantId))
      .order("asc")
      .take(200);
    return invoices.filter((invoice) => isOverdue(invoice.dueDate, invoice.status));
  },
});

export const dashboard = query({
  args: {},
  returns: v.object({
    total: v.number(),
    outstandingCents: v.number(),
    overdueCents: v.number(),
    overdueCount: v.number(),
    paidCents: v.number(),
  }),
  handler: async (ctx) => {
    const { userId, tenantId } = await requireIdentity(ctx);
    const [draft, sent, overdueStored, paid] = await Promise.all([
      ctx.db.query("invoices").withIndex("by_owner_tenant_status", (q) => q.eq("ownerId", userId).eq("tenantId", tenantId).eq("status", "draft")).take(500),
      ctx.db.query("invoices").withIndex("by_owner_tenant_status", (q) => q.eq("ownerId", userId).eq("tenantId", tenantId).eq("status", "sent")).take(500),
      ctx.db.query("invoices").withIndex("by_owner_tenant_status", (q) => q.eq("ownerId", userId).eq("tenantId", tenantId).eq("status", "overdue")).take(500),
      ctx.db.query("invoices").withIndex("by_owner_tenant_status", (q) => q.eq("ownerId", userId).eq("tenantId", tenantId).eq("status", "paid")).take(500),
    ]);
    const outstanding = [...draft, ...sent, ...overdueStored];
    const overdue = outstanding.filter((invoice) => isOverdue(invoice.dueDate, invoice.status));
    return {
      total: outstanding.length + paid.length,
      outstandingCents: outstanding.reduce((sum, invoice) => sum + invoice.amountCents, 0),
      overdueCents: overdue.reduce((sum, invoice) => sum + invoice.amountCents, 0),
      overdueCount: overdue.length,
      paidCents: paid.reduce((sum, invoice) => sum + invoice.amountCents, 0),
    };
  },
});

export const create = mutation({
  args: invoiceFields,
  returns: v.id("invoices"),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    validateInvoiceFields(args);
    const existing = await ctx.db.query("invoices")
      .withIndex("by_owner_tenant_invoice_number", (q) => q.eq("ownerId", identity.userId).eq("tenantId", identity.tenantId).eq("invoiceNumber", args.invoiceNumber))
      .first();
    if (existing) throw new Error("Invoice number already exists");
    const now = Date.now();
    return await ctx.db.insert("invoices", { ...args, ownerId: identity.userId, tenantId: identity.tenantId, createdAt: now, updatedAt: now });
  },
});

const allowedTransitions: Record<string, readonly string[]> = {
  draft: ["draft", "sent"],
  sent: ["sent", "overdue", "paid"],
  overdue: ["overdue", "paid"],
  paid: ["paid"],
};

export const update = mutation({
  args: {
    id: v.id("invoices"),
    patch: v.object({
      clientName: v.optional(v.string()),
      clientEmail: v.optional(v.string()),
      invoiceNumber: v.optional(v.string()),
      amountCents: v.optional(v.number()),
      currency: v.optional(v.string()),
      issueDate: v.optional(v.string()),
      dueDate: v.optional(v.string()),
      status: v.optional(status),
      notes: v.optional(v.string()),
      paymentPlan: v.optional(paymentPlan),
      lastContactedAt: v.optional(v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new Error("Invoice not found");
    assertOwned(invoice, identity);
    validateInvoiceFields({ ...invoice, ...args.patch });
    if (args.patch.invoiceNumber && args.patch.invoiceNumber !== invoice.invoiceNumber) {
      const existing = await ctx.db.query("invoices")
        .withIndex("by_owner_tenant_invoice_number", (q) => q.eq("ownerId", identity.userId).eq("tenantId", identity.tenantId).eq("invoiceNumber", args.patch.invoiceNumber!))
        .first();
      if (existing) throw new Error("Invoice number already exists");
    }
    if (args.patch.status && !allowedTransitions[invoice.status]?.includes(args.patch.status)) {
      throw new Error("Invalid invoice status transition");
    }
    await ctx.db.patch(args.id, { ...args.patch, updatedAt: Date.now() });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("invoices") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new Error("Invoice not found");
    assertOwned(invoice, identity);
    await ctx.db.delete(args.id);
    return null;
  },
});

export const recordChaseEvent = mutation({
  args: {
    invoiceId: v.id("invoices"),
    kind: v.union(v.literal("draft"), v.literal("sent"), v.literal("reply"), v.literal("classification")),
    summary: v.string(),
    provider: v.optional(v.string()),
  },
  returns: v.id("chaseEvents"),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    assertOwned(invoice, identity);
    return await ctx.db.insert("chaseEvents", { ...args, ownerId: identity.userId, tenantId: identity.tenantId, createdAt: Date.now() });
  },
});

export const events = query({
  args: { invoiceId: v.id("invoices") },
  returns: v.array(v.object({
    _id: v.id("chaseEvents"), _creationTime: v.number(), invoiceId: v.id("invoices"),
    ownerId: v.optional(v.string()), tenantId: v.optional(v.string()),
    kind: v.union(v.literal("draft"), v.literal("sent"), v.literal("reply"), v.literal("classification")),
    summary: v.string(), provider: v.optional(v.string()), createdAt: v.number(),
  })),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    assertOwned(invoice, identity);
    return await ctx.db.query("chaseEvents").withIndex("by_owner_tenant_invoice", (q) => q.eq("ownerId", identity.userId).eq("tenantId", identity.tenantId).eq("invoiceId", args.invoiceId)).order("desc").take(100);
  },
});

// Reply classification is deliberately provider-agnostic: an external adapter can
// normalize any model's output before calling this mutation.
export const receiveReply = mutation({
  args: {
    invoiceId: v.id("invoices"),
    messageId: v.string(),
    body: v.string(),
    intent: v.union(
      v.literal("promise_to_pay"),
      v.literal("dispute"),
      v.literal("question"),
      v.literal("ignore"),
    ),
    provider: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    assertOwned(invoice, identity);
    await ctx.db.insert("chaseEvents", {
      invoiceId: args.invoiceId,
      ownerId: identity.userId,
      tenantId: identity.tenantId,
      kind: "classification",
      summary: `${args.intent}: ${args.body.slice(0, 240)}`,
      provider: args.provider ?? "model-agnostic",
      createdAt: Date.now(),
    });
    return null;
  },
});

/**
 * Adapter-only webhook ingress. The HTTP action authenticates AgentMail with
 * AGENTMAIL_WEBHOOK_SECRET before invoking this internal mutation. Ownership is
 * copied from the invoice rather than accepted from the webhook payload.
 */
export const receiveReplyFromWebhook = internalMutation({
  args: {
    eventId: v.string(),
    invoiceId: v.id("invoices"),
    messageId: v.string(),
    body: v.string(),
    intent: v.union(
      v.literal("promise_to_pay"),
      v.literal("dispute"),
      v.literal("question"),
      v.literal("ignore"),
    ),
    provider: v.optional(v.string()),
    tenantId: v.optional(v.string()),
  },
  returns: v.union(v.literal("processed"), v.literal("duplicate"), v.literal("ignored")),
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice?.ownerId || !invoice.tenantId || (args.tenantId && args.tenantId !== invoice.tenantId)) return "ignored";
    const provider = args.provider ?? "agentmail";
    const prior = await ctx.db.query("webhookEvents").withIndex("by_provider_event", (q) => q.eq("provider", provider).eq("eventId", args.eventId)).first();
    if (prior) return "duplicate";
    const priorMessage = await ctx.db.query("webhookEvents").withIndex("by_provider_message", (q) => q.eq("provider", provider).eq("messageId", args.messageId)).first();
    if (priorMessage) return "duplicate";
    await ctx.db.insert("webhookEvents", { provider, eventId: args.eventId, messageId: args.messageId, invoiceId: args.invoiceId, tenantId: invoice.tenantId, receivedAt: Date.now() });
    await ctx.db.insert("chaseEvents", {
      invoiceId: args.invoiceId, ownerId: invoice.ownerId, tenantId: invoice.tenantId,
      kind: "classification", summary: `${args.intent}: ${args.body.slice(0, 240)}`,
      provider, createdAt: Date.now(),
    });
    return "processed";
  },
});

const webhookClaimResult = v.union(v.literal("claimed"), v.literal("duplicate"), v.literal("ignored"));

/** Claims a webhook before any expensive classification work. */
export const claimWebhookEvent = internalMutation({
  args: {
    eventId: v.string(), invoiceId: v.id("invoices"), messageId: v.string(),
    provider: v.optional(v.string()), tenantId: v.optional(v.string()), claimToken: v.string(),
  },
  returns: webhookClaimResult,
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice?.ownerId || !invoice.tenantId || (args.tenantId && args.tenantId !== invoice.tenantId)) return "ignored";
    const provider = args.provider ?? "agentmail";
    const now = Date.now();
    const prior = await ctx.db.query("webhookEvents")
      .withIndex("by_provider_event", (q) => q.eq("provider", provider).eq("eventId", args.eventId)).first();
    const priorMessage = prior ?? await ctx.db.query("webhookEvents")
      .withIndex("by_provider_message", (q) => q.eq("provider", provider).eq("messageId", args.messageId)).first();
    if (priorMessage) {
      const startedAt = priorMessage.processingStartedAt ?? priorMessage.receivedAt;
      if (priorMessage.status === "processing" && priorMessage.eventId === args.eventId && priorMessage.messageId === args.messageId && now - startedAt >= 5 * 60 * 1000) {
        await ctx.db.patch(priorMessage._id, { claimToken: args.claimToken, processingStartedAt: now });
        return "claimed";
      }
      return "duplicate";
    }
    await ctx.db.insert("webhookEvents", {
      provider, eventId: args.eventId, messageId: args.messageId, invoiceId: args.invoiceId,
      tenantId: invoice.tenantId, receivedAt: now, status: "processing", processingStartedAt: now, claimToken: args.claimToken,
    });
    return "claimed";
  },
});

/** Completes a claimed webhook after classification succeeds. */
export const completeWebhookEvent = internalMutation({
  args: {
    eventId: v.string(), invoiceId: v.id("invoices"), messageId: v.string(), body: v.string(),
    intent: v.union(v.literal("promise_to_pay"), v.literal("dispute"), v.literal("question"), v.literal("ignore")),
    provider: v.optional(v.string()), tenantId: v.optional(v.string()), claimToken: v.string(),
  },
  returns: v.union(v.literal("processed"), v.literal("duplicate"), v.literal("ignored")),
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice?.ownerId || !invoice.tenantId || (args.tenantId && args.tenantId !== invoice.tenantId)) return "ignored";
    const provider = args.provider ?? "agentmail";
    const event = await ctx.db.query("webhookEvents")
      .withIndex("by_provider_event", (q) => q.eq("provider", provider).eq("eventId", args.eventId)).first();
    if (!event || event.invoiceId !== args.invoiceId || event.claimToken !== args.claimToken || event.status !== "processing") return "duplicate";
    await ctx.db.patch(event._id, { status: "processed", claimToken: undefined, processingStartedAt: undefined });
    await ctx.db.insert("chaseEvents", {
      invoiceId: args.invoiceId, ownerId: invoice.ownerId, tenantId: invoice.tenantId,
      kind: "classification", summary: `${args.intent}: ${args.body.slice(0, 240)}`,
      provider, createdAt: Date.now(),
    });
    return "processed";
  },
});

/** Internal action lookup; ownership is checked by the calling action. */
export const getForAction = internalQuery({
  args: { invoiceId: v.id("invoices") },
  returns: v.union(invoiceReturn, v.null()),
  handler: async (ctx, args) => await ctx.db.get(args.invoiceId),
});

export const recordSentMessage = internalMutation({
  args: { invoiceId: v.id("invoices"), idempotencyKey: v.string(), provider: v.string() },
  returns: v.union(v.literal("recorded"), v.literal("duplicate")),
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice?.ownerId || !invoice.tenantId) return "duplicate";
    const prior = await ctx.db.query("chaseEvents")
      .withIndex("by_owner_tenant_invoice", (q) => q.eq("ownerId", invoice.ownerId!).eq("tenantId", invoice.tenantId!).eq("invoiceId", args.invoiceId))
      .filter((q) => q.eq(q.field("summary"), args.idempotencyKey))
      .first();
    if (prior) return "duplicate";
    await ctx.db.insert("chaseEvents", { invoiceId: args.invoiceId, ownerId: invoice.ownerId, tenantId: invoice.tenantId, kind: "sent", summary: args.idempotencyKey, provider: args.provider, createdAt: Date.now() });
    if (invoice.status === "draft") await ctx.db.patch(args.invoiceId, { status: "sent", updatedAt: Date.now() });
    return "recorded";
  },
});

export const draftPrompt = query({
  args: {
    invoiceId: v.id("invoices"),
    tone: v.union(v.literal("friendly"), v.literal("firm"), v.literal("final")),
  },
  returns: v.object({ provider: v.string(), prompt: v.string() }),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    assertOwned(invoice, identity);
    return {
      provider: "model-agnostic",
      prompt: `Draft a ${args.tone} payment reminder for ${invoice.clientName} about ${invoice.invoiceNumber}, ${invoice.currency} ${(invoice.amountCents / 100).toFixed(2)}, due ${invoice.dueDate}.`,
    };
  },
});