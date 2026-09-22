import { v } from "convex/values";

export const webhookIntent = v.union(
  v.literal("promise_to_pay"),
  v.literal("dispute"),
  v.literal("question"),
  v.literal("ignore"),
);

export type NormalizedAgentMailWebhook = {
  eventId: string;
  invoiceId: string;
  messageId: string;
  body: string;
  intent: "promise_to_pay" | "dispute" | "question" | "ignore";
  provider: string;
  tenantId?: string;
};

const intents = new Set<NormalizedAgentMailWebhook["intent"]>([
  "promise_to_pay",
  "dispute",
  "question",
  "ignore",
]);

const supportedAgentMailEventTypes = new Set(["message.received"]);

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 4096 ? value.trim() : undefined;
}

/**
 * Accepts AgentMail's nested message shape only for the message.received event.
 * AgentMail event example:
 * { event_type: "message.received", message: { id, text, metadata: { invoiceId } } }
 */
export function normalizeAgentMailWebhook(value: unknown):
  | { ok: true; value: NormalizedAgentMailWebhook }
  | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Payload must be an object" };
  const payload = value as Record<string, unknown>;
  if (typeof payload.event_type !== "string" || !supportedAgentMailEventTypes.has(payload.event_type)) {
    return { ok: false, error: "Unsupported event type" };
  }
  const message = payload.message && typeof payload.message === "object"
    ? payload.message as Record<string, unknown>
    : {};
  const metadata = message.metadata && typeof message.metadata === "object"
    ? message.metadata as Record<string, unknown>
    : payload.metadata && typeof payload.metadata === "object"
      ? payload.metadata as Record<string, unknown>
      : {};

  const invoiceId = stringValue(payload.invoiceId) ?? stringValue(metadata.invoiceId);
  const messageId = stringValue(payload.messageId) ?? stringValue(message.id);
  const eventId = stringValue(payload.eventId) ?? stringValue(payload.id) ?? messageId;
  const body = stringValue(payload.body) ?? stringValue(payload.text) ?? stringValue(message.text) ?? stringValue(message.body);
  const rawIntent = stringValue(payload.intent) ?? stringValue(message.intent) ?? "ignore";

  if (!invoiceId) return { ok: false, error: "Missing invoiceId" };
  if (!messageId) return { ok: false, error: "Missing messageId" };
  if (!eventId) return { ok: false, error: "Missing eventId" };
  if (!body) return { ok: false, error: "Missing body or text" };
  if (!intents.has(rawIntent as NormalizedAgentMailWebhook["intent"])) {
    return { ok: false, error: "Invalid intent" };
  }

  return {
    ok: true,
    value: {
      eventId,
      invoiceId,
      messageId,
      body,
      intent: rawIntent as NormalizedAgentMailWebhook["intent"],
      provider: stringValue(payload.provider) ?? "agentmail",
      tenantId: stringValue(payload.tenantId) ?? stringValue(metadata.tenantId),
    },
  };
}
