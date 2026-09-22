/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const alice = { subject: "alice", org_id: "tenant-a" };
const bob = { subject: "bob", org_id: "tenant-b" };
const originalAllowedHosts = process.env.RISK_RADAR_ALLOWED_HOSTS;

afterEach(() => {
  if (originalAllowedHosts === undefined) delete process.env.RISK_RADAR_ALLOWED_HOSTS;
  else process.env.RISK_RADAR_ALLOWED_HOSTS = originalAllowedHosts;
});

async function invoice(t: ReturnType<typeof convexTest>, identity = alice) {
  return await t.withIdentity(identity).mutation(api.invoices.create, {
    clientName: "Acme", clientEmail: "billing@acme.example", invoiceNumber: `INV-${identity.subject}`,
    amountCents: 12500, currency: "USD", issueDate: "2026-08-01", dueDate: "2026-08-15", status: "sent",
  });
}

describe("risk radar contracts", () => {
  it("persists an owner-scoped local assessment and is idempotent", async () => {
    const t = convexTest(schema, modules);
    const invoiceId = await invoice(t);
    const evidenceId = await t.withIdentity(alice).mutation(api.riskRadar.addEvidence, {
      invoiceId, url: "https://acme.example/news/update", title: "Update", excerpt: "Bounded evidence excerpt.", expiresAt: Date.now() + 60_000,
    });
    const args = { invoiceId, asOfDate: "2026-08-20", idempotencyKey: "assessment-1", evidenceIds: [evidenceId] };
    const first = await t.withIdentity(alice).mutation(api.riskRadar.assess, args);
    const second = await t.withIdentity(alice).mutation(api.riskRadar.assess, args);
    expect(second._id).toBe(first._id);
    expect(first).toMatchObject({ status: "ready", tier: "watch", citations: ["https://acme.example/news/update"], provider: "local" });
    expect(await t.withIdentity(alice).query(api.invoices.get, { id: invoiceId })).toMatchObject({ status: "sent" });
  });

  it("fails closed for malformed model output, stale/missing evidence, and cross-owner IDs", async () => {
    const t = convexTest(schema, modules);
    const invoiceId = await invoice(t);
    const missing = await t.withIdentity(alice).mutation(api.riskRadar.assess, { invoiceId, asOfDate: "2026-08-20", idempotencyKey: "missing", evidenceIds: [] });
    expect(missing).toMatchObject({ status: "unknown", tier: "unknown" });
    const evidenceId = await t.withIdentity(alice).mutation(api.riskRadar.addEvidence, { invoiceId, url: "https://acme.example/news/update", title: "Update", excerpt: "Excerpt", expiresAt: Date.now() + 60_000 });
    const malformed = await t.withIdentity(alice).mutation(api.riskRadar.assess, { invoiceId, asOfDate: "2026-08-20", idempotencyKey: "malformed", evidenceIds: [evidenceId], modelOutput: "not-json" });
    expect(malformed).toMatchObject({ status: "error", tier: "unknown" });
    const bobInvoice = await invoice(t, bob);
    await expect(t.withIdentity(alice).mutation(api.riskRadar.assess, { invoiceId: bobInvoice, asOfDate: "2026-08-20", idempotencyKey: "cross", evidenceIds: [] })).rejects.toThrow("Not authorized");
  });

  it("rejects disallowed, private, and non-HTTPS evidence before persistence", async () => {
    const t = convexTest(schema, modules);
    const invoiceId = await invoice(t);
    for (const url of [
      "https://untrusted.example/news",
      "https://127.0.0.1/private",
      "http://acme.example/news",
      "https://acme.example:8443/news",
    ]) {
      await expect(t.withIdentity(alice).mutation(api.riskRadar.addEvidence, {
        invoiceId, url, title: "Update", excerpt: "Bounded excerpt", expiresAt: Date.now() + 60_000,
      })).rejects.toThrow("allowed public HTTPS source");
    }
    expect(await t.withIdentity(alice).query(api.riskRadar.listEvidence, { invoiceId })).toEqual([]);
  });

  it("persists a canonical URL only for an exact allowlisted host", async () => {
    const t = convexTest(schema, modules);
    const invoiceId = await invoice(t);
    const id = await t.withIdentity(alice).mutation(api.riskRadar.addEvidence, {
      invoiceId, url: "https://ACME.example/news/update", title: "Update", excerpt: "Bounded excerpt", expiresAt: Date.now() + 60_000,
    });
    expect((await t.withIdentity(alice).query(api.riskRadar.listEvidence, { invoiceId }))[0]).toMatchObject({ _id: id, url: "https://acme.example/news/update" });
  });

  it("rejects private IPv6 and IPv4-mapped IPv6 even when allowlisted", async () => {
    process.env.RISK_RADAR_ALLOWED_HOSTS = "[::1],[fd00::1],[::ffff:c0a8:101],acme.example";
    const t = convexTest(schema, modules);
    const invoiceId = await invoice(t);
    for (const url of ["https://[::1]/private", "https://[fd00::1]/private", "https://[::ffff:192.168.1.1]/private"]) {
      await expect(t.withIdentity(alice).mutation(api.riskRadar.addEvidence, {
        invoiceId, url, title: "Update", excerpt: "Bounded excerpt", expiresAt: Date.now() + 60_000,
      })).rejects.toThrow("allowed public HTTPS source");
    }
    const valid = await t.withIdentity(alice).mutation(api.riskRadar.addEvidence, {
      invoiceId, url: "https://ACME.example/news/update", title: "Update", excerpt: "Bounded excerpt", expiresAt: Date.now() + 60_000,
    });
    expect((await t.withIdentity(alice).query(api.riskRadar.listEvidence, { invoiceId }))[0]).toMatchObject({ _id: valid, url: "https://acme.example/news/update" });
  });
});
