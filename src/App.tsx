import { ConvexProvider, ConvexReactClient, useAction, useMutation, useQuery } from "convex/react";
import { ClerkProvider, useAuth, useClerk } from "@clerk/clerk-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../convex/_generated/api";
import { displayStatus, INVOICE_STATUSES, type InvoiceDisplayStatus, type InvoiceStatus } from "../shared/invoiceStatus";
import { RiskRadar } from "./RiskRadar";
import "./styles.css";

const configuredConvexUrl = import.meta.env.VITE_CONVEX_URL?.trim();
const localConvexUrl = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i;
const convexUrl = configuredConvexUrl || (import.meta.env.DEV ? "http://127.0.0.1:3210" : undefined);
if (!convexUrl || (!import.meta.env.DEV && localConvexUrl.test(convexUrl))) {
  throw new Error("VITE_CONVEX_URL must point to a production Convex deployment outside local development.");
}
const client = new ConvexReactClient(convexUrl);
const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
// A browser-exposed Vite variable is suitable only for a local, user-managed
// development token. Production uses Clerk's refreshed Convex JWT instead.
const authToken = import.meta.env.DEV ? import.meta.env.VITE_CONVEX_AUTH_TOKEN?.trim() : undefined;
type Invoice = NonNullable<ReturnType<typeof useQuery<typeof api.invoices.list>>>[number];
type FormState = { clientName: string; clientEmail: string; invoiceNumber: string; amount: string; currency: string; issueDate: string; dueDate: string; status: InvoiceStatus; notes: string; hasPlan: boolean; installments: string; cadence: "weekly" | "monthly"; nextDueDate: string };
const statuses: InvoiceDisplayStatus[] = ["draft", "sent", "overdue", "paid"];
const formStatuses: InvoiceStatus[] = ["draft", "sent", "paid"];
const emptyForm = (): FormState => ({ clientName: "", clientEmail: "", invoiceNumber: "", amount: "", currency: "USD", issueDate: today(), dueDate: "", status: "sent", notes: "", hasPlan: false, installments: "2", cadence: "monthly", nextDueDate: "" });
function today() { return new Date().toISOString().slice(0, 10); }
function money(cents: number, currency = "USD") { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100); }
function dateLabel(value: string) { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T00:00:00`)); }

function App() {
  const dashboard = useQuery(api.invoices.dashboard, {});
  const invoices = useQuery(api.invoices.list, {});
  const riskRadarDate = today();
  const riskRadar = useQuery(api.riskRadar.dashboard, { asOfDate: riskRadarDate });
  const create = useMutation(api.invoices.create);
  const update = useMutation(api.invoices.update);
  const remove = useMutation(api.invoices.remove);
  const [filter, setFilter] = useState<InvoiceDisplayStatus | "all">("all");
  const [form, setForm] = useState<FormState | null>(null);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const visible = useMemo(() => invoices?.filter((invoice) => filter === "all" || displayStatus(invoice.dueDate, invoice.status) === filter), [invoices, filter]);
  const openCreate = () => { setError(""); setEditing(null); setForm(emptyForm()); };
  const openEdit = (invoice: Invoice) => { setError(""); setEditing(invoice); setForm({ clientName: invoice.clientName, clientEmail: invoice.clientEmail, invoiceNumber: invoice.invoiceNumber, amount: String(invoice.amountCents / 100), currency: invoice.currency, issueDate: invoice.issueDate, dueDate: invoice.dueDate, status: invoice.status === "overdue" ? "sent" : invoice.status, notes: invoice.notes ?? "", hasPlan: Boolean(invoice.paymentPlan), installments: String(invoice.paymentPlan?.installments ?? 2), cadence: invoice.paymentPlan?.cadence ?? "monthly", nextDueDate: invoice.paymentPlan?.nextDueDate ?? "" }); };
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!form) return; setSaving(true); setError("");
    const paymentPlan = form.hasPlan ? { installments: Math.max(1, Number(form.installments)), cadence: form.cadence, nextDueDate: form.nextDueDate || form.dueDate } : undefined;
    try {
      const values = { clientName: form.clientName.trim(), clientEmail: form.clientEmail.trim(), invoiceNumber: form.invoiceNumber.trim(), amountCents: Math.round(Number(form.amount) * 100), currency: form.currency, issueDate: form.issueDate, dueDate: form.dueDate, status: form.status, notes: form.notes.trim() || undefined, paymentPlan };
      if (editing) {
        // A legacy stored `overdue` invoice cannot transition back to `sent` just
        // because it was edited. Leave its backend status untouched.
        const patch = editing.status === "overdue" ? (({ status: _status, ...rest }) => rest)(values) : values;
        await update({ id: editing._id, patch });
      } else await create(values);
      setForm(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save invoice"); } finally { setSaving(false); }
  }
  async function deleteInvoice(invoice: Invoice) { if (!window.confirm(`Delete ${invoice.invoiceNumber}?`)) return; await remove({ id: invoice._id }); }
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  async function changeStatus(invoice: Invoice, status: InvoiceStatus) {
    setUpdatingId(invoice._id); setActionError("");
    try { await update({ id: invoice._id, patch: { status } }); }
    catch { setActionError("Unable to update invoice status. Please try again."); }
    finally { setUpdatingId(null); }
  }
  return <main>
    <header><div className="brand"><span className="mark">↗</span><span>Ledgerly</span></div><div className="profile">Your workspace <span className="avatar">Y</span></div></header>
    <section className="hero"><div><p className="eyebrow">ACCOUNTS RECEIVABLE</p><h1>Stay on top of<br /><em>every invoice.</em></h1><p className="sub">A calmer way to track what’s owed, what’s late, and what’s next.</p></div><button className="primary" onClick={openCreate}>＋ New invoice</button></section>
    <section className="stats"><Stat label="Outstanding" value={dashboard ? money(dashboard.outstandingCents) : "—"} detail="Draft, sent & overdue" /><Stat label="Overdue" value={dashboard ? money(dashboard.overdueCents) : "—"} detail={dashboard ? `${dashboard.overdueCount} invoice${dashboard.overdueCount === 1 ? "" : "s"} need attention` : "Loading…"} accent /><Stat label="Collected" value={dashboard ? money(dashboard.paidCents) : "—"} detail="Total paid invoices" /><Stat label="All invoices" value={dashboard ? String(dashboard.total) : "—"} detail="Across your workspace" /></section>
    <IntelligencePreview invoices={invoices} />
    <RiskRadar rows={riskRadar} asOfDate={riskRadarDate} />
    <section className="card portfolio"><div className="section-head"><div><p className="eyebrow">INVOICE REGISTER</p><h2>All invoices</h2></div><div className="filters" role="group" aria-label="Filter invoices">{(["all", ...statuses] as const).map((status) => <button className={filter === status ? "active" : ""} onClick={() => setFilter(status)} key={status}>{status === "all" ? "All" : status}</button>)}</div></div>
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {!invoices ? <p className="empty">Loading your invoices…</p> : visible?.length === 0 ? <div className="empty empty-state"><span>◎</span><strong>No invoices here yet</strong><p>{filter === "all" ? "Create your first invoice to start tracking cashflow." : `No ${filter} invoices at the moment.`}</p><button className="secondary" onClick={openCreate}>Create invoice</button></div> : <div className="table"><div className="row heading"><span>CLIENT</span><span>INVOICE</span><span>DUE DATE</span><span>AMOUNT</span><span>STATUS</span><span /></div>{visible?.map((invoice) => <div className="row" key={invoice._id}><span className="client"><strong>{invoice.clientName}</strong><small>{invoice.clientEmail}</small></span><span className="muted">{invoice.invoiceNumber}</span><span className={displayStatus(invoice.dueDate, invoice.status) === "overdue" ? "late" : "muted"}>{dateLabel(invoice.dueDate)}{invoice.paymentPlan && <small className="plan">↳ {invoice.paymentPlan.installments} payments</small>}</span><span><strong>{money(invoice.amountCents, invoice.currency)}</strong></span><span>{displayStatus(invoice.dueDate, invoice.status) === "overdue" ? <span className="status-action"><strong className="late">Overdue</strong><button className="secondary" disabled={updatingId === invoice._id} onClick={() => changeStatus(invoice, "paid")}>{updatingId === invoice._id ? "Saving…" : "Mark paid"}</button></span> : <select aria-label={`Status for ${invoice.invoiceNumber}`} value={invoice.status} disabled={updatingId === invoice._id} onChange={(event) => changeStatus(invoice, event.target.value as InvoiceStatus)}>{formStatuses.map((status) => <option value={status} key={status}>{status[0].toUpperCase() + status.slice(1)}</option>)}</select>}</span><span className="actions"><button onClick={() => openEdit(invoice)} aria-label={`Edit ${invoice.invoiceNumber}`}>Edit</button><button onClick={() => deleteInvoice(invoice)} aria-label={`Delete ${invoice.invoiceNumber}`}>×</button></span></div>)}</div>}
    </section>
    <footer><span className="dot" /> Live updates enabled <span>·</span> Your data stays in sync automatically</footer>
    {form && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setForm(null)}><form className="modal card" onSubmit={save}><div className="modal-head"><div><p className="eyebrow">{editing ? "EDIT INVOICE" : "NEW INVOICE"}</p><h2>{editing ? editing.invoiceNumber : "Create an invoice"}</h2></div><button type="button" className="close" onClick={() => setForm(null)} aria-label="Close">×</button></div>{error && <p className="error">{error}</p>}<div className="form-grid"><Field label="Client name"><input required value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} placeholder="Acme Co." /></Field><Field label="Client email"><input required type="email" value={form.clientEmail} onChange={(e) => setForm({ ...form, clientEmail: e.target.value })} placeholder="accounts@acme.com" /></Field><Field label="Invoice number"><input required value={form.invoiceNumber} onChange={(e) => setForm({ ...form, invoiceNumber: e.target.value })} placeholder="INV-1042" /></Field><Field label={`Amount (${form.currency})`}><input required min="0.01" step="0.01" type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="2,400.00" /></Field><Field label="Issue date"><input required type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} /></Field><Field label="Due date"><input required type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></Field><Field label="Status"><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as InvoiceStatus })}>{formStatuses.map((status) => <option key={status}>{status[0].toUpperCase() + status.slice(1)}</option>)}</select></Field><Field label="Notes" wide><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional context for your team" /></Field></div><div className="plan-toggle"><label><input type="checkbox" checked={form.hasPlan} onChange={(e) => setForm({ ...form, hasPlan: e.target.checked })} /> Add a payment plan</label><span>Split the balance into scheduled installments</span></div>{form.hasPlan && <div className="plan-fields"><Field label="Installments"><input required min="1" type="number" value={form.installments} onChange={(e) => setForm({ ...form, installments: e.target.value })} /></Field><Field label="Cadence"><select value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value as "weekly" | "monthly" })}><option value="monthly">Monthly</option><option value="weekly">Weekly</option></select></Field><Field label="Next payment"><input type="date" value={form.nextDueDate} onChange={(e) => setForm({ ...form, nextDueDate: e.target.value })} /></Field></div>}<div className="modal-actions"><button type="button" className="secondary" onClick={() => setForm(null)}>Cancel</button><button className="primary" disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Create invoice"}</button></div></form></div>}
  </main>;
}
function IntelligencePreview({ invoices }: { invoices: Invoice[] | undefined }) {
  const [invoiceId, setInvoiceId] = useState<string>("");
  const [replyText, setReplyText] = useState("");
  const [tone, setTone] = useState<"friendly" | "firm" | "final">("friendly");
  const [sending, setSending] = useState(false);
  const [sendState, setSendState] = useState<"idle" | "sent" | "error">("idle");
  const sendChase = useAction(api.llm.sendChase);
  const selectedInvoice = invoices?.find((invoice) => invoice._id === invoiceId);
  const todayDate = today();
  const draft = useQuery(api.invoiceIntelligence.draftPreview, selectedInvoice ? { invoiceId: selectedInvoice._id, asOfDate: todayDate } : "skip");
  const classification = useQuery(api.invoiceIntelligence.classifyPreview, replyText.trim() ? { text: replyText } : "skip");
  const health = useQuery(api.invoiceIntelligence.accountHealthPreview, invoices ? { asOfDate: todayDate } : "skip");
  const daysOverdue = selectedInvoice ? Math.max(0, Math.floor((Date.parse(`${todayDate}T00:00:00.000Z`) - Date.parse(`${selectedInvoice.dueDate}T00:00:00.000Z`)) / 86_400_000)) : 0;
  async function send() {
    if (!selectedInvoice || !draft || sending) return;
    if (!window.confirm(`Send this ${tone} payment reminder to ${selectedInvoice.clientEmail}?`)) return;
    setSending(true); setSendState("idle");
    try { await sendChase({ invoiceId: selectedInvoice._id, tone }); setSendState("sent"); }
    catch { setSendState("error"); }
    finally { setSending(false); }
  }
  return <section className="card intelligence" aria-labelledby="intelligence-heading">
    <div className="section-head"><div><p className="eyebrow">LOCAL INTELLIGENCE LAB</p><h2 id="intelligence-heading">Preview and send a chase</h2></div><span className="preview-badge">PREVIEW + LIVE SEND</span></div>
    <p className="preview-note">Drafts, reply intent and account health are computed locally and deterministically from your owned invoice data — these previews send nothing and save nothing. Sending is a separate, confirmed action that delivers a real email through AgentMail.</p>
    <div className="intelligence-grid">
      <div className="preview-panel"><h3>Chase draft</h3><Field label="Owned invoice"><select aria-label="Select an owned invoice" value={invoiceId} onChange={(event) => { setInvoiceId(event.target.value); setSendState("idle"); }}><option value="">Choose an invoice…</option>{invoices?.map((invoice) => <option value={invoice._id} key={invoice._id}>{invoice.invoiceNumber} · {invoice.clientName}</option>)}</select></Field>{selectedInvoice && <div className="derived"><span>{daysOverdue} days overdue</span><span className={`tone tone-${draft?.tone ?? "friendly"}`}>{draft?.tone ?? "friendly"} tone</span></div>}{draft && <div className="result"><strong>{draft.subject}</strong><p>{draft.body}</p>{draft.errors.length > 0 && <ErrorList errors={draft.errors} />}</div>}{selectedInvoice && !draft && <p className="muted-note">Generating safe local preview…</p>}{selectedInvoice && draft && draft.errors.length === 0 && <div className="send-controls"><p className="live-send-note" role="note"><strong>Live send — not a preview.</strong> This delivers a real email through AgentMail to {selectedInvoice.clientEmail}.</p><Field label="Send tone"><select value={tone} onChange={(event) => setTone(event.target.value as typeof tone)}><option value="friendly">Friendly</option><option value="firm">Firm</option><option value="final">Final notice</option></select></Field><button className="primary" disabled={sending} onClick={() => void send()}>{sending ? "Sending…" : "Send actual reminder"}</button>{sendState === "sent" && <p className="success" role="status">Reminder sent through the configured provider.</p>}{sendState === "error" && <p className="error" role="alert">The reminder was not sent. Check provider availability and try again.</p>}</div>}</div>
      <div className="preview-panel"><h3>Reply intent</h3><label>Paste an inbound reply<textarea aria-label="Inbound reply text" rows={5} value={replyText} onChange={(event) => setReplyText(event.target.value)} placeholder="Thanks — we will pay this on Friday." /></label>{classification && <div className="result classification"><div className="intent-row"><strong>{classification.intent.replaceAll("_", " ")}</strong><span>{classification.confidence} confidence</span></div><small>Source: {classification.source}</small>{classification.errors.length > 0 && <><strong className="late">Review required</strong><ErrorList errors={classification.errors} /></>}</div>}{!replyText.trim() && <p className="muted-note">Paste text to classify it deterministically.</p>}</div>
      <div className="preview-panel"><h3>Account health</h3>{health ? <div className="result classification"><div className="intent-row"><strong>{health.risk.replaceAll("_", " ")}</strong><span>{health.overdueCount} overdue</span></div><small>{money(health.outstandingCents)} outstanding · {health.invoiceCount} invoices</small>{health.errors.length > 0 && <ErrorList errors={health.errors} />}</div> : <p className="muted-note">Calculating owned account health…</p>}</div>
    </div>
    <p className="limitation"><strong>Safety boundary:</strong> previews are local and unsaved. Actual sending requires an explicit confirmation and is handled by the authenticated backend; provider payloads and untrusted HTML are never shown.</p>
  </section>;
}
function ErrorList({ errors }: { errors: string[] }) { return <ul className="preview-errors" role="alert">{errors.map((message) => <li key={message}>{message}</li>)}</ul>; }
function Field({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) { return <label className={wide ? "wide" : ""}>{label}{children}</label>; }
function Stat({ label, value, detail, accent = false }: { label: string; value: string; detail: string; accent?: boolean }) { return <div className={`stat ${accent ? "accent" : ""}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }
function LocalAuthGate() {
  const [state, setState] = useState<"checking" | "ready" | "missing" | "invalid">(authToken ? "checking" : "missing");
  useEffect(() => {
    if (!authToken) return;
    client.setAuth(async () => authToken, (isAuthenticated) => setState(isAuthenticated ? "ready" : "invalid"));
  }, []);
  if (state === "ready") return <App />;
  const message = state === "invalid" ? "The configured sign-in token was rejected. Check VITE_CONVEX_AUTH_TOKEN and try again." : "This app requires an authenticated Convex session.";
  return <main className="auth-gate"><section className="card"><p className="eyebrow">LEDGERLY ACCESS</p><h1>{state === "checking" ? "Checking access…" : "Sign in to continue"}</h1><p className="sub">{message}</p>{state === "missing" && <p className="auth-help">Local development only: provide a short-lived, user-managed JWT in <code>VITE_CONVEX_AUTH_TOKEN</code>. Production sign-in is configured separately with Clerk.</p>}</section></main>;
}

function ClerkAuthGate() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { openSignIn } = useClerk();
  const [state, setState] = useState<"checking" | "ready" | "signed-out" | "invalid">("checking");

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      void client.setAuth(async () => null, () => setState("signed-out"));
      return;
    }
    let cancelled = false;
    void client.setAuth(
      async () => getToken({ template: "convex" }),
      (isAuthenticated) => { if (!cancelled) setState(isAuthenticated ? "ready" : "invalid"); },
    );
    return () => { cancelled = true; };
  }, [getToken, isLoaded, isSignedIn]);

  if (state === "ready") return <App />;
  const message = state === "invalid"
    ? "Your sign-in could not be verified by Convex. Check the Clerk Convex JWT template and try again."
    : "Sign in with your workspace account to continue.";
  return <main className="auth-gate"><section className="card"><p className="eyebrow">LEDGERLY ACCESS</p><h1>{state === "checking" ? "Checking access…" : "Sign in to continue"}</h1><p className="sub">{message}</p>{state === "signed-out" && <button className="primary" onClick={() => void openSignIn()}>Sign in</button>}{state === "invalid" && <p className="auth-help">Your session may have expired. Sign in again after checking the configured Clerk issuer and Convex JWT template.</p>}</section></main>;
}

export default function Root() {
  const content = <ConvexProvider client={client}>{clerkPublishableKey ? <ClerkAuthGate /> : <LocalAuthGate />}</ConvexProvider>;
  return clerkPublishableKey ? <ClerkProvider publishableKey={clerkPublishableKey}>{content}</ClerkProvider> : content;
}