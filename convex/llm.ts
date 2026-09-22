import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { requireIdentity } from "./auth";
import { assertOwned } from "./auth";
import { buildDraft, parseReplyIntent, type DraftResult } from "../shared/invoiceIntelligence";

const provider = v.optional(v.string());
const model = v.optional(v.string());
const draftResult = v.object({
  tone: v.union(v.literal("friendly"), v.literal("firm"), v.literal("final")),
  subject: v.string(), body: v.string(), provider: v.literal("local"), errors: v.array(v.string()),
});

function env(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

function validateDraft(value: unknown): DraftResult {
  if (!value || typeof value !== "object") throw new Error("LLM returned invalid draft");
  const draft = value as Record<string, unknown>;
  if (!["friendly", "firm", "final"].includes(String(draft.tone)) || typeof draft.subject !== "string" || typeof draft.body !== "string") {
    throw new Error("LLM returned invalid draft");
  }
  if (draft.subject.length > 500 || draft.body.length > 20_000) throw new Error("LLM draft exceeds bounds");
  return { tone: draft.tone as DraftResult["tone"], subject: draft.subject, body: draft.body, provider: "local", errors: [] };
}

async function generateOpenAi(prompt: string, selectedModel: string): Promise<DraftResult> {
  const key = env().OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: selectedModel, input: prompt, max_output_tokens: 800,
      text: { format: { type: "json_schema", name: "invoice_draft", strict: true, schema: { type: "object", additionalProperties: false, properties: { tone: { type: "string", enum: ["friendly", "firm", "final"] }, subject: { type: "string" }, body: { type: "string" } }, required: ["tone", "subject", "body"] } } } }),
  });
  if (!response.ok) throw new Error(`LLM provider request failed (${response.status})`);
  const payload = await response.json() as { output_text?: unknown; status?: string; incomplete_details?: unknown };
  if (payload.status === "incomplete" || typeof payload.output_text !== "string") throw new Error("LLM returned incomplete output");
  let parsed: unknown;
  try { parsed = JSON.parse(payload.output_text); } catch { throw new Error("LLM returned malformed JSON"); }
  return validateDraft(parsed);
}

export const generate = action({
  args: { prompt: v.string(), provider, model },
  returns: v.object({ provider: v.string(), model: v.string(), text: v.string(), mode: v.union(v.literal("local"), v.literal("provider")) }),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    const selectedProvider = args.provider ?? env().LLM_PROVIDER ?? "local";
    const selectedModel = args.model ?? env().LLM_MODEL ?? "gpt-4o-mini";
    if (selectedProvider === "local") return { provider: selectedProvider, model: selectedModel, text: "", mode: "local" as const };
    const draft = await generateOpenAi(args.prompt, selectedModel);
    return { provider: selectedProvider, model: selectedModel, text: JSON.stringify(draft), mode: "provider" as const };
  },
});

/** Inbound adapter: provider output is reduced to the closed domain enum. */
export const classifyInbound = internalAction({
  args: { body: v.string(), hintedIntent: v.optional(v.string()) },
  returns: v.union(v.literal("promise_to_pay"), v.literal("dispute"), v.literal("question"), v.literal("ignore")),
  handler: async (_ctx, args) => {
    if (!env().OPENAI_API_KEY) return "ignore";
    const result = await generateOpenAi(JSON.stringify({ task: "classify_invoice_reply", body: args.body, hintedIntent: args.hintedIntent }), env().LLM_MODEL ?? "gpt-4o-mini");
    return parseReplyIntent(result.body).intent;
  },
});

export const sendChase = action({
  args: { invoiceId: v.id("invoices"), tone: v.union(v.literal("friendly"), v.literal("firm"), v.literal("final")) },
  returns: v.object({ ok: v.boolean(), provider: v.string(), idempotencyKey: v.string() }),
  handler: async (ctx, args): Promise<{ ok: boolean; provider: string; idempotencyKey: string }> => {
    const identity = await requireIdentity(ctx);
    const invoice: Awaited<ReturnType<typeof ctx.runQuery>> = await ctx.runQuery(internal.invoices.getForAction, { invoiceId: args.invoiceId });
    if (!invoice) throw new Error("Invoice not found");
    assertOwned(invoice, identity);
    const selectedProvider = env().LLM_PROVIDER ?? "local";
    const draft = selectedProvider === "local"
      ? buildDraft({ clientName: invoice.clientName, invoiceNumber: invoice.invoiceNumber, amountCents: invoice.amountCents, currency: invoice.currency, dueDate: invoice.dueDate, daysOverdue: 0, tone: args.tone })
      : await generateOpenAi(JSON.stringify({ task: "invoice_payment_reminder", tone: args.tone, clientName: invoice.clientName, invoiceNumber: invoice.invoiceNumber, amountCents: invoice.amountCents, currency: invoice.currency, dueDate: invoice.dueDate }), env().LLM_MODEL ?? "gpt-4o-mini");
    const checked = selectedProvider === "local" ? draft : validateDraft(draft);
    if (checked.errors.length) throw new Error("LLM draft failed validation");
    const apiKey = env().AGENTMAIL_API_KEY;
    const inbox = env().AGENTMAIL_INBOX_ID;
    if (!apiKey) throw new Error("Missing AGENTMAIL_API_KEY");
    if (!inbox) throw new Error("Missing AGENTMAIL_INBOX_ID");
    const idempotencyKey = `invoice:${args.invoiceId}:${checked.tone}:${invoice.updatedAt}`;
    const response = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages`, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify({ to: [invoice.clientEmail], subject: checked.subject, text: checked.body }) });
    if (!response.ok) throw new Error(`AgentMail send failed (${response.status})`);
    await ctx.runMutation(internal.invoices.recordSentMessage, { invoiceId: args.invoiceId, idempotencyKey, provider: "agentmail" });
    return { ok: true, provider: "agentmail", idempotencyKey };
  },
});
