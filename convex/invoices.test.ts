/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { normalizeAgentMailWebhook } from "./webhooks";

const modules = import.meta.glob("./**/*.ts");
const invoice = (invoiceNumber: string, status: "draft" | "sent" | "overdue" | "paid" = "sent") => ({
  clientName: "Acme",
  clientEmail: "billing@example.com",
  invoiceNumber,
  amountCents: 12500,
  currency: "USD",
  issueDate: "2026-08-01",
  dueDate: "2026-08-15",
  status,
});

const make = () => convexTest(schema, modules);
const alice = { subject: "alice", org_id: "tenant-a" };
const bob = { subject: "bob", org_id: "tenant-b" };

describe("invoice authorization and status semantics", () => {
  it("rejects unauthenticated reads, writes, and actions", async () => {
    const t = make();
    await expect(t.query(api.invoices.list, {})).rejects.toThrow("Unauthenticated");
    await expect(t.mutation(api.invoices.create, invoice("INV-1"))).rejects.toThrow("Unauthenticated");
    await expect(t.action(api.llm.generate, { prompt: "hello" })).rejects.toThrow("Unauthenticated");
  });

  it("isolates invoices across users and tenants", async () => {
    const t = make();
    const id = await t.withIdentity(alice).mutation(api.invoices.create, invoice("INV-1"));
    expect(await t.withIdentity(bob).query(api.invoices.list, {})).toEqual([]);
    await expect(t.withIdentity(bob).query(api.invoices.get, { id })).rejects.toThrow("Not authorized");
    await expect(t.withIdentity(bob).mutation(api.invoices.update, { id, patch: { notes: "stolen" } })).rejects.toThrow("Not authorized");
    await expect(t.withIdentity(bob).mutation(api.invoices.remove, { id })).rejects.toThrow("Not authorized");
    expect((await t.withIdentity(alice).query(api.invoices.get, { id }))?.invoiceNumber).toBe("INV-1");
  });

  it("rejects duplicate invoice numbers within an owner tenant but permits another tenant", async () => {
    const t = make();
    const first = await t.withIdentity(alice).mutation(api.invoices.create, invoice("INV-1"));
    await expect(t.withIdentity(alice).mutation(api.invoices.create, invoice("INV-1"))).rejects.toThrow("Invoice number already exists");
    const second = await t.withIdentity(alice).mutation(api.invoices.create, invoice("INV-2"));
    await expect(t.withIdentity(alice).mutation(api.invoices.update, { id: second, patch: { invoiceNumber: "INV-1" } })).rejects.toThrow("Invoice number already exists");
    expect((await t.withIdentity(alice).query(api.invoices.get, { id: first }))?.invoiceNumber).toBe("INV-1");
    const other = await t.withIdentity(bob).mutation(api.invoices.create, invoice("INV-1"));
    expect(other).toBeTruthy();
  });

  it("rejects illegal state transitions and permits monotonic transitions", async () => {
    const t = make();
    const id = await t.withIdentity(alice).mutation(api.invoices.create, invoice("INV-1", "draft"));
    await expect(t.withIdentity(alice).mutation(api.invoices.update, { id, patch: { status: "paid" } })).rejects.toThrow("Invalid invoice status transition");
    await t.withIdentity(alice).mutation(api.invoices.update, { id, patch: { status: "sent" } });
    await t.withIdentity(alice).mutation(api.invoices.update, { id, patch: { status: "overdue" } });
    await t.withIdentity(alice).mutation(api.invoices.update, { id, patch: { status: "paid" } });
    await expect(t.withIdentity(alice).mutation(api.invoices.update, { id, patch: { status: "sent" } })).rejects.toThrow("Invalid invoice status transition");
  });

  it("rejects invalid money, dates, required strings, and payment plans", async () => {
    const t = make();
    await expect(t.withIdentity(alice).mutation(api.invoices.create, { ...invoice("BAD-1"), amountCents: 0 })).rejects.toThrow("Amount");
    await expect(t.withIdentity(alice).mutation(api.invoices.create, { ...invoice("BAD-2"), amountCents: 1.5 })).rejects.toThrow("Amount");
    await expect(t.withIdentity(alice).mutation(api.invoices.create, { ...invoice("BAD-3"), issueDate: "2026-02-30" })).rejects.toThrow("dates");
    await expect(t.withIdentity(alice).mutation(api.invoices.create, { ...invoice("BAD-4"), dueDate: "2026-07-31" })).rejects.toThrow("dates");
    await expect(t.withIdentity(alice).mutation(api.invoices.create, { ...invoice("BAD-5"), paymentPlan: { installments: 0, cadence: "monthly", nextDueDate: "2026-08-20" } })).rejects.toThrow("installments");
    const id = await t.withIdentity(alice).mutation(api.invoices.create, invoice("VALID-1"));
    await expect(t.withIdentity(alice).mutation(api.invoices.update, { id, patch: { amountCents: Number.NaN } })).rejects.toThrow("Amount");
    await expect(t.withIdentity(alice).mutation(api.invoices.create, { ...invoice("BAD-6"), lastContactedAt: "2026-08-20 12:00:00" })).rejects.toThrow("lastContactedAt");
    await expect(t.withIdentity(alice).mutation(api.invoices.create, { ...invoice("BAD-7"), lastContactedAt: "2026-02-30T12:00:00Z" })).rejects.toThrow("lastContactedAt");
    await expect(t.withIdentity(alice).mutation(api.invoices.update, { id, patch: { lastContactedAt: "2026-08-20T12:00:00+08:00" } })).rejects.toThrow("lastContactedAt");
    await t.withIdentity(alice).mutation(api.invoices.update, { id, patch: { lastContactedAt: "2026-08-20T12:00:00Z" } });
  });

  it("includes legacy overdue rows in dashboard totals", async () => {
    const t = make();
    await t.withIdentity(alice).mutation(api.invoices.create, invoice("OVERDUE-1", "overdue"));
    expect(await t.withIdentity(alice).query(api.invoices.dashboard, {})).toMatchObject({ total: 1, outstandingCents: 12500, overdueCents: 12500, overdueCount: 1 });
  });
});

describe("webhook normalization and idempotency", () => {
  it("rejects malformed payloads and accepts nested AgentMail messages", () => {
    expect(normalizeAgentMailWebhook(null)).toMatchObject({ ok: false, error: "Payload must be an object" });
    expect(normalizeAgentMailWebhook({ messageId: "m1", body: "x" })).toMatchObject({ ok: false, error: "Unsupported event type" });
    expect(normalizeAgentMailWebhook({ event_type: "message.sent", invoiceId: "i1", messageId: "m1", body: "x", intent: "promise_to_pay" })).toMatchObject({ ok: false, error: "Unsupported event type" });
    expect(normalizeAgentMailWebhook({ event_type: "message.received", invoiceId: "i1", messageId: "m1", body: "x", intent: "bogus" })).toMatchObject({ ok: false, error: "Invalid intent" });
    expect(normalizeAgentMailWebhook({ event_type: "message.received", message: { id: "m1", text: "paid", metadata: { invoiceId: "i1" } }, intent: "promise_to_pay" })).toMatchObject({ ok: true, value: { invoiceId: "i1", messageId: "m1", eventId: "m1" } });
  });

  it("ignores tenant mismatches and makes duplicate provider events no-ops", async () => {
    const t = make();
    const id = await t.withIdentity(alice).mutation(api.invoices.create, invoice("INV-1"));
    const args = { eventId: "evt-1", invoiceId: id, messageId: "msg-1", body: "I will pay", intent: "promise_to_pay" as const, provider: "agentmail" };
    expect(await t.mutation(internal.invoices.receiveReplyFromWebhook, { ...args, tenantId: "wrong-tenant" })).toBe("ignored");
    expect(await t.mutation(internal.invoices.receiveReplyFromWebhook, { ...args, tenantId: "tenant-a" })).toBe("processed");
    expect(await t.mutation(internal.invoices.receiveReplyFromWebhook, { ...args, tenantId: "tenant-a" })).toBe("duplicate");
    expect((await t.withIdentity(alice).query(api.invoices.events, { invoiceId: id }))).toHaveLength(1);
  });
});


  it("fails closed for missing and malformed signatures", async () => {
    const t = make();
    const body = JSON.stringify({ invoiceId: "bad", messageId: "m1", body: "x" });
    expect((await t.fetch("/agentmail/webhook", { method: "POST", body })).status).toBe(401);
    expect((await t.fetch("/agentmail/webhook", { method: "POST", body, headers: { "x-agentmail-signature": "not-a-digest" } })).status).toBe(401);
  });

  it("rejects invalid and oversized Content-Length before reading the body", async () => {
    const t = make();
    const body = JSON.stringify({ invoiceId: "bad", messageId: "m1", body: "x" });
    expect((await t.fetch("/agentmail/webhook", { method: "POST", body, headers: { "content-length": "not-a-number" } })).status).toBe(413);
    expect((await t.fetch("/agentmail/webhook", { method: "POST", body, headers: { "content-length": "1048577" } })).status).toBe(413);
  });

  it("rejects a body that exceeds the limit when Content-Length is absent", async () => {
    const t = make();
    const body = "x".repeat(1_048_577);
    expect((await t.fetch("/agentmail/webhook", { method: "POST", body })).status).toBe(413);
  });

  it("rejects body-only HMAC even when the legacy flag is enabled", async () => {
    const t = make();
    const id = await t.withIdentity(alice).mutation(api.invoices.create, invoice("WEBHOOK-1"));
    const body = JSON.stringify({ event_type: "message.received", id: "evt-valid", message: { id: "msg-valid", text: "I will pay", metadata: { invoiceId: id } }, intent: "promise_to_pay" });
    const env = globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } };
    env.process ??= { env: {} } as NonNullable<typeof env.process>;
    const previousSecret = env.process.env.AGENTMAIL_WEBHOOK_SECRET;
    const previousLegacy = env.process.env.ALLOW_LEGACY_WEBHOOK_HMAC;
    try {
      env.process.env.AGENTMAIL_WEBHOOK_SECRET = "test-agentmail-secret";
      env.process.env.ALLOW_LEGACY_WEBHOOK_HMAC = "true";
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.process.env.AGENTMAIL_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
      const signature = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const response = await t.fetch("/agentmail/webhook", { method: "POST", body, headers: { "x-agentmail-signature": signature } });
      expect(response.status).toBe(401);
      expect(await t.withIdentity(alice).query(api.invoices.events, { invoiceId: id })).toHaveLength(0);
    } finally {
      if (previousSecret === undefined) delete env.process.env.AGENTMAIL_WEBHOOK_SECRET;
      else env.process.env.AGENTMAIL_WEBHOOK_SECRET = previousSecret;
      if (previousLegacy === undefined) delete env.process.env.ALLOW_LEGACY_WEBHOOK_HMAC;
      else env.process.env.ALLOW_LEGACY_WEBHOOK_HMAC = previousLegacy;
    }
  });

  it("processes a valid Svix-signed AgentMail request", async () => {
    const t = make();
    const id = await t.withIdentity(alice).mutation(api.invoices.create, invoice("SVIX-WEBHOOK-1"));
    const body = JSON.stringify({ event_type: "message.received", id: "evt-svix", message: { id: "msg-svix", text: "I will pay", metadata: { invoiceId: id } }, intent: "promise_to_pay" });
    const env = globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } };
    env.process ??= { env: {} } as NonNullable<typeof env.process>;
    const previousSecret = env.process.env.AGENTMAIL_WEBHOOK_SECRET;
    const previousOpenAiKey = env.process.env.OPENAI_API_KEY;
    const previousFetch = globalThis.fetch;
    let classifierCalls = 0;
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const rawSecret = "test-svix-secret";
      const encodedSecret = btoa(rawSecret);
      env.process.env.AGENTMAIL_WEBHOOK_SECRET = `whsec_${encodedSecret}`;
      env.process.env.OPENAI_API_KEY = "test-openai-key";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (String(input) === "https://api.openai.com/v1/responses") {
          classifierCalls += 1;
          return new Response(JSON.stringify({ output_text: JSON.stringify({ tone: "friendly", subject: "Re: invoice", body: "promise_to_pay" }) }), { status: 200 });
        }
        return previousFetch(input, init);
      });

      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(rawSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`evt-svix.${timestamp}.${body}`)));
      const signature = btoa(String.fromCharCode(...digest));
      const response = await t.fetch("/agentmail/webhook", { method: "POST", body, headers: { "svix-id": "evt-svix", "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` } });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, result: "processed" });
      expect(classifierCalls).toBe(1);
      const replay = await t.fetch("/agentmail/webhook", { method: "POST", body, headers: { "svix-id": "evt-svix", "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` } });
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toEqual({ ok: true, result: "duplicate" });
      expect(classifierCalls).toBe(1);
      expect(await t.withIdentity(alice).query(api.invoices.events, { invoiceId: id })).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      if (previousSecret === undefined) delete env.process.env.AGENTMAIL_WEBHOOK_SECRET;
      else env.process.env.AGENTMAIL_WEBHOOK_SECRET = previousSecret;
      if (previousOpenAiKey === undefined) delete env.process.env.OPENAI_API_KEY;
      else env.process.env.OPENAI_API_KEY = previousOpenAiKey;

    }
  });

  it("rejects unsupported authenticated event types before classification or persistence", async () => {
    const t = make();
    const id = await t.withIdentity(alice).mutation(api.invoices.create, invoice("UNSUPPORTED-EVENT-1"));
    const body = JSON.stringify({ event_type: "message.sent", id: "evt-unsupported", message: { id: "msg-unsupported", text: "I will pay", metadata: { invoiceId: id } }, intent: "promise_to_pay" });
    const env = globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } };
    env.process ??= { env: {} } as NonNullable<typeof env.process>;
    const previousSecret = env.process.env.AGENTMAIL_WEBHOOK_SECRET;
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const rawSecret = "test-svix-secret";
      env.process.env.AGENTMAIL_WEBHOOK_SECRET = `whsec_${btoa(rawSecret)}`;
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(rawSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`evt-unsupported.${timestamp}.${body}`)));
      const signature = btoa(String.fromCharCode(...digest));
      const response = await t.fetch("/agentmail/webhook", { method: "POST", body, headers: { "svix-id": "evt-unsupported", "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` } });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ ok: false, error: "Unsupported event type" });
      expect(await t.withIdentity(alice).query(api.invoices.events, { invoiceId: id })).toHaveLength(0);
    } finally {
      if (previousSecret === undefined) delete env.process.env.AGENTMAIL_WEBHOOK_SECRET;
      else env.process.env.AGENTMAIL_WEBHOOK_SECRET = previousSecret;
    }
  });

  it("rejects a stale Svix timestamp before processing", async () => {
    const t = make();
    const body = JSON.stringify({ id: "evt-stale", message: { id: "msg-stale", text: "I will pay", metadata: { invoiceId: "bad" } }, intent: "promise_to_pay" });
    const env = globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } };
    env.process ??= { env: {} } as NonNullable<typeof env.process>;
    const previousSecret = env.process.env.AGENTMAIL_WEBHOOK_SECRET;
    try {
      const rawSecret = "test-svix-secret";
      const timestamp = String(Math.floor(Date.now() / 1000) - 301);
      env.process.env.AGENTMAIL_WEBHOOK_SECRET = `whsec_${btoa(rawSecret)}`;
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(rawSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`evt-stale.${timestamp}.${body}`)));
      const signature = btoa(String.fromCharCode(...digest));
      const response = await t.fetch("/agentmail/webhook", { method: "POST", body, headers: { "svix-id": "evt-stale", "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` } });
      expect(response.status).toBe(401);
    } finally {
      if (previousSecret === undefined) delete env.process.env.AGENTMAIL_WEBHOOK_SECRET;
      else env.process.env.AGENTMAIL_WEBHOOK_SECRET = previousSecret;
    }
  });

  it("rejects a tampered Svix signature", async () => {
    const t = make();
    const body = JSON.stringify({ event_type: "message.received", id: "evt-tampered", message: { id: "msg-tampered", text: "I will pay", metadata: { invoiceId: "bad" } }, intent: "promise_to_pay" });
    const env = globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } };
    env.process ??= { env: {} } as NonNullable<typeof env.process>;
    const previousSecret = env.process.env.AGENTMAIL_WEBHOOK_SECRET;
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const rawSecret = "test-svix-secret";
      env.process.env.AGENTMAIL_WEBHOOK_SECRET = `whsec_${btoa(rawSecret)}`;
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(rawSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`evt-tampered.${timestamp}.${body}`)));
      const signature = btoa(String.fromCharCode(...digest));
      const tampered = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
      const response = await t.fetch("/agentmail/webhook", { method: "POST", body, headers: { "svix-id": "evt-tampered", "svix-timestamp": timestamp, "svix-signature": `v1,${tampered}` } });
      expect(response.status).toBe(401);
    } finally {
      if (previousSecret === undefined) delete env.process.env.AGENTMAIL_WEBHOOK_SECRET;
      else env.process.env.AGENTMAIL_WEBHOOK_SECRET = previousSecret;
    }
  });
