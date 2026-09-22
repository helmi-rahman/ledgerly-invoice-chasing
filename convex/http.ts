import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { normalizeAgentMailWebhook } from "./webhooks";
import type { GenericId } from "convex/values";

const http = httpRouter();
const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function readWebhookBody(request: Request): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength.trim()) || Number(contentLength) > MAX_WEBHOOK_BODY_BYTES)) {
    throw new Error("Webhook request body is too large or has an invalid Content-Length");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WEBHOOK_BODY_BYTES) throw new Error("Webhook request body is too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function validSignature(body: string, request: Request): Promise<boolean> {
  const secret = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.AGENTMAIL_WEBHOOK_SECRET;
  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signatures = request.headers.get("svix-signature");
  // Require Svix's timestamped, event-bound signature. Body-only HMAC is
  // intentionally unsupported because it permits unlimited replay.
  if (!id || !timestamp || !signatures || !secret || !/^\d+$/.test(timestamp)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;
  const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let secretBytes: Uint8Array;
  try { secretBytes = Uint8Array.from(atob(encodedSecret), (char) => char.charCodeAt(0)); } catch { return false; }
  const key = await crypto.subtle.importKey("raw", secretBytes as unknown as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signedPayload = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  for (const candidate of signatures.split(" ")) {
    if (!candidate.startsWith("v1,")) continue;
    let signatureBytes: Uint8Array;
    try { signatureBytes = Uint8Array.from(atob(candidate.slice(3)), (char) => char.charCodeAt(0)); } catch { continue; }
    if (await crypto.subtle.verify("HMAC", key, signatureBytes as unknown as BufferSource, signedPayload)) return true;
  }
  return false;
}

http.route({ path: "/agentmail/webhook", method: "POST", handler: httpAction(async (ctx, request) => {
  try {
    let rawBody: string;
    try {
      rawBody = await readWebhookBody(request);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : "Invalid webhook request body" }, 413);
    }
    if (!await validSignature(rawBody, request)) return json({ ok: false, error: "Invalid webhook authentication" }, 401);
    let payload: unknown;
    try { payload = JSON.parse(rawBody); } catch { return json({ ok: false, error: "Malformed webhook" }, 400); }
    const normalized = normalizeAgentMailWebhook(payload);
    if (!normalized.ok) return json({ ok: false, error: normalized.error }, 400);
    const invoiceId = normalized.value.invoiceId as GenericId<"invoices">;
    const claimToken = crypto.randomUUID();
    const claim = await ctx.runMutation(internal.invoices.claimWebhookEvent, {
      eventId: normalized.value.eventId,
      invoiceId,
      messageId: normalized.value.messageId,
      provider: normalized.value.provider,
      tenantId: normalized.value.tenantId,
      claimToken,
    });
    if (claim === "duplicate") return json({ ok: true, result: claim }, 200);
    const intent = await ctx.runAction(internal.llm.classifyInbound, { body: normalized.value.body, hintedIntent: normalized.value.intent });
    const result = await ctx.runMutation(internal.invoices.completeWebhookEvent, { ...normalized.value, intent, invoiceId, claimToken });
    return json({ ok: true, result }, 200);
  } catch {
    return json({ ok: false, error: "Invalid webhook" }, 400);
  }
}) });
export default http;
