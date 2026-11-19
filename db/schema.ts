import { user as users } from "./auth-schema";
/**
 * Cadence data model (PostgreSQL, Drizzle ORM). See docs/adr/0002-data-layer.md.
 *
 * Conventions:
 * - Money is stored as integer minor units (cents, kobo). Never floats.
 * - A project has one currency. Milestones and payments inherit it.
 * - IDs are text, generated in application code (ULID-style strings).
 * - Status values come from the Stitch designs. Do not add values without a design.
 */
import {
  bigint,
  date,
  integer,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const membershipRole = pgEnum("membership_role", ["owner", "admin", "member", "viewer"]);
export const currency = pgEnum("currency", ["USD", "NGN"]);
/** Six stages from DESIGN.md: Proposal, Signed, In progress, Review, Completed, Closed. */
export const projectStage = pgEnum("project_stage", [
  "proposal",
  "signed",
  "in_progress",
  "review",
  "completed",
  "closed",
]);
export const milestoneStatus = pgEnum("milestone_status", [
  "upcoming",
  "payment_due",
  "in_progress",
  "delivered",
  "approved",
]);
export const paymentStatus = pgEnum("payment_status", [
  "pending",
  "processing",
  "paid",
  "failed",
  "refunded",
]);
export const paymentProvider = pgEnum("payment_provider", ["paystack", "flutterwave"]);

export { user as users } from "./auth-schema";

export const studios = pgTable("studios", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const memberships = pgTable("memberships", {
  studioId: text("studio_id").notNull().references(() => studios.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: membershipRole("role").notNull(),
}, (t) => [primaryKey({ columns: [t.studioId, t.userId] })]);

/** A client organisation, for example "Apex Holdings LLC". */
export const clients = pgTable("clients", {
  id: text("id").primaryKey(),
  studioId: text("studio_id").notNull().references(() => studios.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
}, (t) => [index("clients_studio_idx").on(t.studioId)]);

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  studioId: text("studio_id").notNull().references(() => studios.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  reference: text("reference").notNull(),
  title: text("title").notNull(),
  currency: currency("currency").notNull(),
  stage: projectStage("stage").notNull().default("proposal"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("projects_reference_idx").on(t.reference),
  index("projects_studio_idx").on(t.studioId),
]);

/** Users allowed to view a project as the client. Scope is per project, never per studio. */
export const projectContacts = pgTable("project_contacts", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.projectId, t.userId] })]);

export const milestones = pgTable("milestones", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  position: bigint("position", { mode: "number" }).notNull(),
  title: text("title").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  status: milestoneStatus("status").notNull().default("upcoming"),
  dueDate: date("due_date", { mode: "string" }),
}, (t) => [
  uniqueIndex("milestones_project_position_idx").on(t.projectId, t.position),
]);

export const payments = pgTable("payments", {
  id: text("id").primaryKey(),
  milestoneId: text("milestone_id").notNull().references(() => milestones.id, { onDelete: "cascade" }),
  provider: paymentProvider("provider").notNull(),
  providerReference: text("provider_reference").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currency: currency("currency").notNull(),
  status: paymentStatus("status").notNull().default("pending"),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // Provider references are unique: a repeated webhook must not create a second payment.
  uniqueIndex("payments_provider_reference_idx").on(t.provider, t.providerReference),
  index("payments_milestone_idx").on(t.milestoneId),
]);

export type MilestoneStatus = (typeof milestoneStatus.enumValues)[number];
export type ProjectStage = (typeof projectStage.enumValues)[number];
export type Currency = (typeof currency.enumValues)[number];

/** One issued version of a proposal. A signed version is never edited; a change is a new version. */
export const proposals = pgTable("proposals", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  version: bigint("version", { mode: "number" }).notNull(),
  status: text("status", { enum: ["draft", "sent", "signed"] }).notNull().default("draft"),
  revisionTerms: text("revision_terms").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }),
}, (t) => [uniqueIndex("proposals_project_version_idx").on(t.projectId, t.version)]);

/**
 * Record of a typed-name sign-off. Stores the signer, the typed name, the UTC
 * time and a SHA-256 digest of the terms signed. It is not a qualified
 * electronic signature. Legal validity needs review (docs/assumptions.md, item 26).
 */
export const signatures = pgTable("signatures", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull().references(() => proposals.id, { onDelete: "cascade" }),
  signerUserId: text("signer_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  typedName: text("typed_name").notNull(),
  documentSha256: text("document_sha256").notNull(),
  signedAt: timestamp("signed_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex("signatures_proposal_idx").on(t.proposalId)]);

export const outboxStatus = pgEnum("outbox_status", ["pending", "sent", "dead"]);

/**
 * Durable email outbox. Writes add a row; a scheduled job sends pending rows with retries.
 * dedupe_key is unique, so one event for one recipient is queued once, even if it is retried.
 * to_address and the bodies are personal data. Purge sent rows after a retention period (docs/assumptions.md).
 */
export const notificationOutbox = pgTable("notification_outbox", {
  id: text("id").primaryKey(),
  dedupeKey: text("dedupe_key").notNull(),
  toAddress: text("to_address").notNull(),
  subject: text("subject").notNull(),
  textBody: text("text_body").notNull(),
  htmlBody: text("html_body").notNull(),
  status: outboxStatus("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("outbox_dedupe_idx").on(t.dedupeKey),
  index("outbox_due_idx").on(t.status, t.nextAttemptAt),
]);
