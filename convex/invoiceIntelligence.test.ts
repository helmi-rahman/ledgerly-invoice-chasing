/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { buildDraft, parseReplyIntent, summarizeAccountHealth, toneForDaysOverdue, validatePaymentPlan } from "../shared/invoiceIntelligence";

const modules = import.meta.glob("./**/*.ts");
const alice = { subject: "alice", org_id: "tenant-a" };

describe("deterministic invoice intelligence contract", () => {
  it("selects all overdue tiers and produces stable drafts", () => {
    expect([toneForDaysOverdue(0), toneForDaysOverdue(15), toneForDaysOverdue(31)]).toEqual(["friendly", "firm", "final"]);
    const input = { clientName: "Acme", invoiceNumber: "INV-1", amountCents: 12500, currency: "USD", dueDate: "2026-08-15", daysOverdue: 15 } as const;
    expect(buildDraft(input)).toEqual(buildDraft(input));
    expect(buildDraft(input)).toMatchObject({ tone: "firm", provider: "local", subject: "Payment needed: invoice INV-1" });
  });

  it("parses provider output, falls back safely, and sanitizes invalid output", () => {
    expect(parseReplyIntent('{"intent":"promise-to-pay"}').intent).toBe("promise_to_pay");
    expect(parseReplyIntent("I will pay next week")).toMatchObject({ intent: "promise_to_pay", source: "fallback" });
    expect(parseReplyIntent({ intent: "unexpected-provider-value" })).toMatchObject({ intent: "ignore", confidence: "low" });
  });

  it("validates payment plans and uses date-only integer-cent health math", () => {
    expect(validatePaymentPlan({ installments: 0, cadence: "weekly", nextDueDate: "2026-08-20", amountCents: 100 }, "2026-08-01").valid).toBe(false);
    expect(validatePaymentPlan({ installments: 2, cadence: "yearly", nextDueDate: "2026-07-20", amountCents: 100 }, "2026-08-01").errors).toEqual(expect.arrayContaining(["cadence is unsupported", "nextDueDate cannot be before issueDate"]));
    expect(validatePaymentPlan({ installments: 2, cadence: "monthly", nextDueDate: "2026-08-20", amountCents: 100 }, "2026-08-01")).toMatchObject({ valid: true, normalized: { amountCents: 100 } });
    expect(summarizeAccountHealth({ asOfDate: "2026-08-20", invoices: [{ amountCents: 1001, status: "sent", dueDate: "2026-08-19" }, { amountCents: 999, status: "paid", dueDate: "2026-08-01" }] })).toMatchObject({ outstandingCents: 1001, overdueCents: 1001, paidCents: 999, overdueCount: 1, risk: "at_risk" });
    expect(summarizeAccountHealth({ asOfDate: "2026-08-20", invoices: [{ amountCents: 100, status: "sent", dueDate: "2026-02-30" }] })).toMatchObject({ risk: "at_risk", errors: ["invoice dueDate must be a valid UTC date"] });
  });

  it("keeps preview classification unaffiliated with persistence and protects invoice previews", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.invoiceIntelligence.classifyPreview, { text: "What is the balance?" })).rejects.toThrow("Unauthenticated");
    await expect(t.query(api.invoiceIntelligence.paymentPlanPreview, { issueDate: "2026-08-01", installments: 2, cadence: "monthly", nextDueDate: "2026-09-01", amountCents: 100 })).rejects.toThrow("Unauthenticated");
    await expect(t.query(api.invoiceIntelligence.accountHealthPreview, { asOfDate: "2026-08-20" })).rejects.toThrow("Unauthenticated");
    await expect(t.query(api.invoiceIntelligence.draftPreview, { invoiceId: "j5723g6q7n9m3x8z4s5f6h7j8k9l0m1n" as never, asOfDate: "2026-08-20" })).rejects.toThrow();
    expect(await t.withIdentity(alice).query(api.invoiceIntelligence.classifyPreview, { text: "What is the balance?" })).toMatchObject({ intent: "question", source: "fallback" });
    const invoice = { clientName: "Alice Co.", clientEmail: "alice@example.com", invoiceNumber: "ALICE-1", amountCents: 1001, currency: "USD", issueDate: "2026-08-01", dueDate: "2026-08-19", status: "sent" as const };
    await t.withIdentity(alice).mutation(api.invoices.create, invoice);
    const bob = { subject: "bob", org_id: "tenant-b" };
    await t.withIdentity(bob).mutation(api.invoices.create, { ...invoice, invoiceNumber: "BOB-1", amountCents: 999 });
    expect(await t.withIdentity(alice).query(api.invoiceIntelligence.accountHealthPreview, { asOfDate: "2026-08-20" })).toMatchObject({ invoiceCount: 1, outstandingCents: 1001, overdueCents: 1001, paidCents: 0 });
    await expect(t.withIdentity(alice).query(api.invoiceIntelligence.accountHealthPreview, { asOfDate: "2026-08-20", invoices: [{ amountCents: 999999, status: "paid", dueDate: "2026-08-01" }] } as never)).rejects.toThrow();
  });
});
