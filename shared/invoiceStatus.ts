export const INVOICE_STATUSES = ["draft", "sent", "overdue", "paid"] as const;

/** Stored statuses include overdue for backwards compatibility; new overdue state is derived. */
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type InvoiceDisplayStatus = InvoiceStatus;

/** Due dates are date-only values and use an exclusive boundary: due today is not overdue. */
export function isOverdue(dueDate: string, status: string, today = new Date().toISOString().slice(0, 10)): boolean {
  return status !== "paid" && dueDate < today;
}

export function displayStatus(dueDate: string, status: string, today?: string): InvoiceDisplayStatus {
  return isOverdue(dueDate, status, today) ? "overdue" : (status as InvoiceStatus);
}
