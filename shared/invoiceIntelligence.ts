export const TONE_TIERS = ["friendly", "firm", "final"] as const;
export type ToneTier = (typeof TONE_TIERS)[number];

export const REPLY_INTENTS = ["promise_to_pay", "dispute", "question", "ignore"] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export const PAYMENT_CADENCES = ["weekly", "monthly"] as const;
export type PaymentCadence = (typeof PAYMENT_CADENCES)[number];

export type DraftInput = {
  clientName: string;
  invoiceNumber: string;
  amountCents: number;
  currency: string;
  dueDate: string;
  daysOverdue: number;
  tone?: ToneTier;
};

export type DraftResult = {
  tone: ToneTier;
  subject: string;
  body: string;
  provider: "local";
  errors: string[];
};

export type ReplyClassification = {
  intent: ReplyIntent;
  confidence: "high" | "medium" | "low";
  source: "local" | "provider" | "fallback";
  errors: string[];
};

export type PaymentPlanProposal = {
  installments: number;
  cadence: PaymentCadence;
  nextDueDate: string;
  amountCents: number;
};

export type PaymentPlanValidation = {
  valid: boolean;
  errors: string[];
  normalized?: PaymentPlanProposal;
};

export type AccountHealthInput = {
  invoices: Array<{
    amountCents: number;
    status: "draft" | "sent" | "overdue" | "paid";
    dueDate: string;
  }>;
  asOfDate: string;
};

export type AccountHealthSummary = {
  asOfDate: string;
  invoiceCount: number;
  outstandingCents: number;
  overdueCents: number;
  paidCents: number;
  overdueCount: number;
  risk: "healthy" | "watch" | "at_risk";
  errors: string[];
};

export function toneForDaysOverdue(daysOverdue: number): ToneTier {
  if (!Number.isFinite(daysOverdue) || daysOverdue <= 0) return "friendly";
  if (daysOverdue <= 7) return "friendly";
  if (daysOverdue <= 30) return "firm";
  return "final";
}

/** Stable, provider-neutral input shaping for an eventual draft adapter. */
export function buildDraftPrompt(input: DraftInput): string {
  const tone = input.tone ?? toneForDaysOverdue(input.daysOverdue);
  return JSON.stringify({
    task: "invoice_payment_reminder",
    tone,
    clientName: input.clientName.trim(),
    invoiceNumber: input.invoiceNumber.trim(),
    amountCents: input.amountCents,
    currency: input.currency.trim(),
    dueDate: input.dueDate,
  });
}

function money(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

export function buildDraft(input: DraftInput): DraftResult {
  const errors: string[] = [];
  const tone = input.tone ?? toneForDaysOverdue(input.daysOverdue);
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) errors.push("amountCents must be a positive integer");
  if (!input.clientName.trim()) errors.push("clientName is required");
  if (!input.invoiceNumber.trim()) errors.push("invoiceNumber is required");
  if (!input.currency.trim()) errors.push("currency is required");
  const amount = money(Number.isSafeInteger(input.amountCents) ? input.amountCents : 0, input.currency.trim());
  const subjects: Record<ToneTier, string> = {
    friendly: `Friendly reminder: invoice ${input.invoiceNumber}`,
    firm: `Payment needed: invoice ${input.invoiceNumber}`,
    final: `Final notice: invoice ${input.invoiceNumber}`,
  };
  const openings: Record<ToneTier, string> = {
    friendly: `I hope you are well. This is a friendly reminder that invoice ${input.invoiceNumber} for ${amount} was due on ${input.dueDate}.`,
    firm: `Invoice ${input.invoiceNumber} for ${amount} remains unpaid and was due on ${input.dueDate}. Please arrange payment or let us know if there is an issue.`,
    final: `This is a final reminder that invoice ${input.invoiceNumber} for ${amount}, due on ${input.dueDate}, remains unpaid. Please respond promptly to avoid further action.`,
  };
  return {
    tone,
    subject: subjects[tone],
    body: `Hi ${input.clientName.trim()},\n\n${openings[tone]}\n\nThank you,`,
    provider: "local",
    errors,
  };
}

function intentValue(value: unknown): ReplyIntent | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (REPLY_INTENTS as readonly string[]).includes(normalized) ? normalized as ReplyIntent : undefined;
}

export function parseReplyIntent(input: unknown): ReplyClassification {
  let candidate: unknown = input;
  const errors: string[] = [];
  if (typeof input === "string") {
    try { candidate = JSON.parse(input); } catch { candidate = input; }
  }
  const fromObject = typeof candidate === "object" && candidate !== null
    ? (candidate as Record<string, unknown>).intent ?? (candidate as Record<string, unknown>).replyIntent
    : candidate;
  const parsed = intentValue(fromObject);
  if (parsed) return { intent: parsed, confidence: "high", source: "provider", errors };
  if (typeof input === "string") {
    const text = input.toLowerCase();
    if (/\b(pay|payment|settle|transfer)\b/.test(text)) return { intent: "promise_to_pay", confidence: "medium", source: "fallback", errors: ["Provider intent was not valid; inferred from text"] };
    if (/\b(dispute|wrong|incorrect|not owe|already paid)\b/.test(text)) return { intent: "dispute", confidence: "medium", source: "fallback", errors: ["Provider intent was not valid; inferred from text"] };
    if (/\b(what|which|clarify|question|how much|when)\b/.test(text)) return { intent: "question", confidence: "medium", source: "fallback", errors: ["Provider intent was not valid; inferred from text"] };
  }
  errors.push("Invalid provider classification; defaulted to ignore");
  return { intent: "ignore", confidence: "low", source: "fallback", errors };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validatePaymentPlan(plan: { installments?: unknown; cadence?: unknown; nextDueDate?: unknown; amountCents?: unknown }, issueDate: string): PaymentPlanValidation {
  const errors: string[] = [];
  if (typeof plan.installments !== "number" || !Number.isSafeInteger(plan.installments) || plan.installments <= 0) errors.push("installments must be a positive integer");
  if (!PAYMENT_CADENCES.includes(plan.cadence as PaymentCadence)) errors.push("cadence is unsupported");
  if (typeof plan.nextDueDate !== "string" || !validDate(plan.nextDueDate)) errors.push("nextDueDate must be a valid date");
  else if (!validDate(issueDate) || plan.nextDueDate < issueDate) errors.push("nextDueDate cannot be before issueDate");
  if (typeof plan.amountCents !== "number" || !Number.isSafeInteger(plan.amountCents) || plan.amountCents <= 0) errors.push("amountCents must be a positive integer");
  if (errors.length) return { valid: false, errors };
  return { valid: true, errors: [], normalized: { installments: plan.installments as number, cadence: plan.cadence as PaymentCadence, nextDueDate: plan.nextDueDate as string, amountCents: plan.amountCents as number } };
}

export function summarizeAccountHealth(input: AccountHealthInput): AccountHealthSummary {
  const errors: string[] = [];
  if (!validDate(input.asOfDate)) errors.push("asOfDate must be a valid date");
  let outstandingCents = 0, overdueCents = 0, paidCents = 0, overdueCount = 0, malformedDateCount = 0;
  for (const invoice of input.invoices) {
    if (!validDate(invoice.dueDate)) {
      malformedDateCount++;
      errors.push("invoice dueDate must be a valid UTC date");
    }
    if (!Number.isSafeInteger(invoice.amountCents) || invoice.amountCents < 0) { errors.push("invoice amounts must be non-negative integer cents"); continue; }
    if (invoice.status === "paid") paidCents += invoice.amountCents;
    else {
      outstandingCents += invoice.amountCents;
      if (validDate(invoice.dueDate) && invoice.dueDate < input.asOfDate) { overdueCents += invoice.amountCents; overdueCount++; }
    }
  }
  const risk = malformedDateCount > 0 || !validDate(input.asOfDate)
    ? "at_risk"
    : overdueCount === 0 ? "healthy" : overdueCents >= outstandingCents / 2 || overdueCount >= 3 ? "at_risk" : "watch";
  return { asOfDate: input.asOfDate, invoiceCount: input.invoices.length, outstandingCents, overdueCents, paidCents, overdueCount, risk, errors };
}
