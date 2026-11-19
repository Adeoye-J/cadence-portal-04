import { recordEvent } from "@/server/events";
import { randomUUID } from "node:crypto";
import { demoProjects, type FixtureProject } from "@/db/fixtures/cadence-demo";
import type { PaymentCurrency, PaymentProvider } from "@/lib/services/payments";
import { PaymentProviderError } from "@/lib/services/payments";

/**
 * Payment records and settlement.
 *
 * The flow: start (pending, redirect to provider) -> provider webhook -> settlePayment
 * re-verifies the charge with the provider and only then marks it paid. The client
 * redirect never settles a payment.
 *
 * DEVELOPMENT STORE. Payments live in memory and reset on restart. Settlement must run
 * as a transaction with a conditional update (status <> 'paid') before production use.
 */

export type PaymentRecord = {
  reference: string;
  projectId: string;
  milestonePosition: number;
  provider: string;
  amountMinor: number;
  currency: PaymentCurrency;
  status: "pending" | "paid" | "failed";
  createdAt: string;
  settledAt?: string;
};

export type SettleOutcome =
  | "settled"
  | "already_settled"
  | "unknown_reference"
  | "amount_mismatch"
  | "not_successful";

const payments = new Map<string, PaymentRecord>();

function authorise(viewerUserId: string, projectId: string): FixtureProject | null {
  const project = demoProjects.find((p) => p.id === projectId);
  if (!project || !project.contactUserIds.includes(viewerUserId)) return null;
  return project;
}

export type StartResult =
  | { ok: true; authorizationUrl: string; reference: string }
  | { ok: false; message: string };

export async function startMilestonePayment(input: {
  viewerUserId: string;
  viewerEmail: string;
  projectId: string;
  position: number;
  provider: PaymentProvider;
  appUrl: string;
}): Promise<StartResult> {
  const project = authorise(input.viewerUserId, input.projectId);
  if (!project) return { ok: false, message: "Project not found." };

  const milestone = project.milestones.find((m) => m.position === input.position);
  if (!milestone) return { ok: false, message: "Milestone not found." };
  if (milestone.status !== "payment_due") {
    return { ok: false, message: "This milestone is not ready for payment." };
  }

  const reference = `${project.reference}-M${milestone.position}-${randomUUID().slice(0, 8)}`.toUpperCase();
  try {
    const { authorizationUrl } = await input.provider.initiate({
      reference,
      email: input.viewerEmail,
      amountMinor: milestone.amountMinor,
      currency: project.currency,
      callbackUrl: `${input.appUrl}/projects/${project.id}/payments/${reference}`,
      metadata: { projectId: project.id, milestonePosition: String(milestone.position) },
    });
    payments.set(reference, {
      reference,
      projectId: project.id,
      milestonePosition: milestone.position,
      provider: input.provider.name,
      amountMinor: milestone.amountMinor,
      currency: project.currency,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    recordEvent({ projectId: input.projectId, kind: "payment_started", actor: "client", summary: `Payment started for milestone ${input.position}` });
    return { ok: true, authorizationUrl: authorizationUrl, reference };
  } catch (err) {
    if (err instanceof PaymentProviderError) return { ok: false, message: err.message };
    return { ok: false, message: "We could not start the payment. Try again." };
  }
}

/**
 * Settles one payment from a provider event. Idempotent: a repeat event returns
 * already_settled and changes nothing. The amount and currency must match what we
 * stored. A provider lookup failure throws, so the webhook handler returns 500
 * and the provider retries.
 */
export async function settlePayment(reference: string, provider: PaymentProvider): Promise<SettleOutcome> {
  const record = payments.get(reference);
  if (!record) return "unknown_reference";
  if (record.status === "paid") return "already_settled";

  const charge = await provider.verify(reference);
  if (charge.status !== "success") {
    if (charge.status === "failed" || charge.status === "abandoned") record.status = "failed";
    return "not_successful";
  }
  if (charge.amountMinor !== record.amountMinor || charge.currency !== record.currency) {
    return "amount_mismatch";
  }

  const project = demoProjects.find((p) => p.id === record.projectId);
  const milestone = project?.milestones.find((m) => m.position === record.milestonePosition);
  if (!project || !milestone) return "unknown_reference";

  record.status = "paid";
  record.settledAt = new Date().toISOString();
  milestone.status = "in_progress";
  project.stage = "in_progress";
  recordEvent({ projectId: project.id, kind: "payment_settled", actor: "system", summary: `Milestone ${milestone.position} payment settled` });
  return "settled";
}

/** The payment for a reference, only if the viewer is a contact on that project. */
export async function getPaymentForViewer(
  viewerUserId: string,
  projectId: string,
  reference: string,
): Promise<PaymentRecord | null> {
  if (!authorise(viewerUserId, projectId)) return null;
  const record = payments.get(reference);
  if (!record || record.projectId !== projectId) return null;
  return record;
}

/** Payments for a set of projects, newest first. The caller has already checked access. */
export function listPaymentsForProjects(projectIds: readonly string[]): PaymentRecord[] {
  return [...payments.values()]
    .filter((p) => projectIds.includes(p.projectId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
