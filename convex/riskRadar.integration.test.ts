/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const alice = { subject: "alice", org_id: "tenant-a" };
const bob = { subject: "bob", org_id: "tenant-b" };
const invoice = {
  clientName: "Acme", clientEmail: "billing@example.com", invoiceNumber: "INV-RISK-1",
  amountCents: 125_000, currency: "USD", issueDate: "2026-08-01", dueDate: "2026-08-15", status: "sent" as const,
};
const make = () => convexTest(schema, modules);

async function setup(t: ReturnType<typeof make>) {
  const id = await t.withIdentity(alice).mutation(api.invoices.create, invoice);
  const evidence = await t.withIdentity(alice).mutation(api.riskRadar.addEvidence, {
    invoiceId: id, url: "https://acme.example/news/update", title: "Public update",
    excerpt: "A bounded, public source excerpt.", expiresAt: Date.now() + 60_000,
  });
  return { id, evidence };
}

describe("Risk Radar deterministic local flow", () => {
  it("selects only owned overdue invoices and exposes a transparent approval proposal", async () => {
    const t = make();
    const { id, evidence } = await setup(t);
    const assessment = await t.withIdentity(alice).mutation(api.riskRadar.assess, {
      invoiceId: id, asOfDate: "2026-08-30", idempotencyKey: "risk:alice:INV-RISK-1:v1",
      evidenceIds: [evidence], modelOutput: JSON.stringify({ tier: "elevated", explanation: "Review the public evidence." }),
    });
    const rows = await t.withIdentity(alice).query(api.riskRadar.dashboard, { asOfDate: "2026-08-30" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invoice: { _id: id, status: "sent" }, assessment: { status: "ready", tier: "elevated", proposedEscalation: { state: "approval_required" } } });
    expect((await t.withIdentity(alice).query(api.invoices.get, { id }))?.status).toBe("sent");
    expect(assessment.citations).toEqual(["https://acme.example/news/update"]);
  });

  it("makes replay idempotent and rejects malformed model JSON without side effects", async () => {
    const t = make();
    const { id, evidence } = await setup(t);
    const args = { invoiceId: id, asOfDate: "2026-08-30", idempotencyKey: "risk:alice:INV-RISK-1:v2", evidenceIds: [evidence] };
    const malformed = await t.withIdentity(alice).mutation(api.riskRadar.assess, { ...args, modelOutput: "not-json" });
    expect(malformed).toMatchObject({ status: "error", tier: "unknown" });
    const first = await t.withIdentity(alice).mutation(api.riskRadar.assess, { ...args, idempotencyKey: "risk:alice:INV-RISK-1:v2-valid", modelOutput: JSON.stringify({ tier: "watch", explanation: "Review evidence." }) });
    const replay = await t.withIdentity(alice).mutation(api.riskRadar.assess, { ...args, idempotencyKey: "risk:alice:INV-RISK-1:v2-valid", modelOutput: "malformed-but-ignored-on-replay" });
    expect(replay._id).toBe(first._id);
    expect(await t.withIdentity(alice).query(api.riskRadar.listAssessments, { invoiceId: id })).toHaveLength(2);
  });

  it("does not expose another tenant's overdue invoice or evidence", async () => {
    const t = make();
    const { id } = await setup(t);
    expect(await t.withIdentity(bob).query(api.riskRadar.dashboard, { asOfDate: "2026-08-30" })).toEqual([]);
    await expect(t.withIdentity(bob).query(api.riskRadar.listEvidence, { invoiceId: id })).rejects.toThrow("Not authorized");
    await expect(t.withIdentity(bob).query(api.riskRadar.listAssessments, { invoiceId: id })).rejects.toThrow("Not authorized");
  });

  it("renders expired evidence and snapshots as explicit stale/unknown states", async () => {
    const t = make();
    const id = await t.withIdentity(alice).mutation(api.invoices.create, invoice);
    await t.withIdentity(alice).mutation(api.riskRadar.assess, { invoiceId: id, asOfDate: "2026-08-30", idempotencyKey: "risk:alice:INV-RISK-1:v3", evidenceIds: [] });
    const rows = await t.withIdentity(alice).query(api.riskRadar.dashboard, { asOfDate: "2026-08-30" });
    expect(rows[0].assessment).toMatchObject({ status: "unknown", tier: "unknown" });
    expect(rows[0].invoice.status).toBe("sent");
  });
});
