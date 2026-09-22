import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const invoiceStatus = v.union(
  v.literal("draft"),
  v.literal("sent"),
  v.literal("overdue"),
  v.literal("paid"),
);

const paymentPlan = v.object({
  installments: v.number(),
  cadence: v.union(v.literal("weekly"), v.literal("monthly")),
  nextDueDate: v.string(),
});

export default defineSchema({
  invoices: defineTable({
    ownerId: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    clientName: v.string(),
    clientEmail: v.string(),
    invoiceNumber: v.string(),
    amountCents: v.number(),
    currency: v.string(),
    issueDate: v.string(),
    dueDate: v.string(),
    status: invoiceStatus,
    notes: v.optional(v.string()),
    paymentPlan: v.optional(paymentPlan),
    lastContactedAt: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_due_date", ["dueDate"])
    .index("by_invoice_number", ["invoiceNumber"])
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_status", ["tenantId", "status"])
    .index("by_tenant_due_date", ["tenantId", "dueDate"])
    .index("by_tenant_invoice_number", ["tenantId", "invoiceNumber"])
    .index("by_owner_tenant_invoice_number", ["ownerId", "tenantId", "invoiceNumber"])
    .index("by_owner_tenant_status", ["ownerId", "tenantId", "status"])
    .index("by_owner_tenant_due_date", ["ownerId", "tenantId", "dueDate"]),
  chaseEvents: defineTable({
    ownerId: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    invoiceId: v.id("invoices"),
    kind: v.union(
      v.literal("draft"),
      v.literal("sent"),
      v.literal("reply"),
      v.literal("classification"),
    ),
    summary: v.string(),
    provider: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_invoice", ["invoiceId"])
    .index("by_tenant_invoice", ["tenantId", "invoiceId"])
    .index("by_owner_tenant_invoice", ["ownerId", "tenantId", "invoiceId"]),
  webhookEvents: defineTable({
    provider: v.string(),
    eventId: v.string(),
    messageId: v.optional(v.string()),
    invoiceId: v.id("invoices"),
    tenantId: v.string(),
    receivedAt: v.number(),
    status: v.optional(v.union(v.literal("processing"), v.literal("processed"))),
    processingStartedAt: v.optional(v.number()),
    claimToken: v.optional(v.string()),
  })
    .index("by_provider_event", ["provider", "eventId"])
    .index("by_provider_message", ["provider", "messageId"]),
  sourceEvidence: defineTable({
    ownerId: v.string(),
    tenantId: v.string(),
    invoiceId: v.id("invoices"),
    url: v.string(),
    title: v.string(),
    excerpt: v.string(),
    publishedAt: v.optional(v.string()),
    retrievedAt: v.number(),
    expiresAt: v.number(),
    provider: v.union(v.literal("local"), v.literal("firecrawl")),
    contentHash: v.string(),
  })
    .index("by_owner_tenant_invoice", ["ownerId", "tenantId", "invoiceId"])
    .index("by_owner_tenant_url", ["ownerId", "tenantId", "url"]),
  riskAssessments: defineTable({
    ownerId: v.string(),
    tenantId: v.string(),
    invoiceId: v.id("invoices"),
    idempotencyKey: v.string(),
    inputFingerprint: v.string(),
    assessedAt: v.number(),
    validUntil: v.number(),
    status: v.union(v.literal("ready"), v.literal("unknown"), v.literal("error"), v.literal("stale")),
    tier: v.union(v.literal("unknown"), v.literal("watch"), v.literal("elevated")),
    explanation: v.string(),
    citations: v.array(v.string()),
    evidenceIds: v.array(v.id("sourceEvidence")),
    provider: v.string(),
    model: v.string(),
    errors: v.array(v.string()),
  })
    .index("by_owner_tenant_invoice", ["ownerId", "tenantId", "invoiceId"])
    .index("by_owner_tenant_idempotency", ["ownerId", "tenantId", "idempotencyKey"]),
});