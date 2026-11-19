import { randomUUID } from "node:crypto";
import { demoProjects, type FixtureProject } from "@/db/fixtures/cadence-demo";
import { canWrite } from "@/lib/authz";
import type { ObjectStorage } from "@/lib/services/storage";
import { DELIVERABLE_TYPES, MAX_FILE_BYTES, safeFilename, sniffFamily } from "@/lib/validation/files";
import { recordEvent } from "@/server/events";
import { getStudioMembership } from "@/server/studio";

/**
 * Deliverable files. Flow: the studio asks for an upload URL, the browser PUTs the file to object storage,
 * the studio confirms. Confirmation checks the stored size and the real file signature before the file
 * becomes ready. Downloads are presigned for five minutes, and only project contacts and studio members get one.
 *
 * DEVELOPMENT STORE. File records live in memory. The bytes live in object storage.
 */

const UPLOAD_TTL_SEC = 15 * 60;
const DOWNLOAD_TTL_SEC = 5 * 60;

type FileRecord = {
  id: string;
  projectId: string;
  position: number;
  key: string;
  filename: string;
  contentType: string;
  size: number;
  status: "pending" | "ready";
  createdAt: string;
};

const records: FileRecord[] = [];

export type FileResult = { ok: true } | { ok: false; message: string };

function keyFor(projectId: string, position: number, fileId: string): string {
  return `projects/${projectId}/milestones/${position}/${fileId}`;
}

function findProject(studioId: string, projectId: string): FixtureProject | null {
  return demoProjects.find((p) => p.id === projectId && p.studioId === studioId) ?? null;
}

/** Contacts see a project's files, and so do studio members. Anyone else gets nothing. */
async function canSee(userId: string, project: FixtureProject): Promise<boolean> {
  if (project.contactUserIds.includes(userId)) return true;
  const membership = await getStudioMembership(userId);
  return membership !== null && membership.studioId === project.studioId;
}

export type UploadIntent = { ok: true; fileId: string; url: string } | { ok: false; message: string };

/** Studio: reserves a file and returns a presigned PUT URL. Needs a write role and an in-progress milestone. */
export async function createUploadIntent(input: {
  userId: string;
  projectId: string;
  position: number;
  filename: string;
  contentType: string;
  size: number;
  storage: ObjectStorage;
}): Promise<UploadIntent> {
  const membership = await getStudioMembership(input.userId);
  if (!membership) return { ok: false, message: "Studio not found." };
  if (!canWrite(membership.role)) return { ok: false, message: "Your role cannot add deliverables." };

  const project = findProject(membership.studioId, input.projectId);
  const milestone = project?.milestones.find((m) => m.position === input.position);
  if (!project || !milestone) return { ok: false, message: "Milestone not found." };
  if (milestone.status !== "in_progress") {
    return { ok: false, message: "Deliverables can be added while a milestone is in progress." };
  }

  const type = DELIVERABLE_TYPES[input.contentType];
  if (!type) return { ok: false, message: "That file type is not accepted. Use PDF, PNG, JPEG, ZIP or an Office file." };
  if (!Number.isInteger(input.size) || input.size < 1 || input.size > MAX_FILE_BYTES) {
    return { ok: false, message: "The file must be between 1 byte and 50 MB." };
  }
  const filename = safeFilename(input.filename);
  if (!filename) return { ok: false, message: "Give the file a name with letters or numbers." };

  const fileId = randomUUID();
  const key = keyFor(input.projectId, input.position, fileId);
  records.push({
    id: fileId,
    projectId: input.projectId,
    position: input.position,
    key,
    filename,
    contentType: input.contentType,
    size: input.size,
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  const url = await input.storage.presign("PUT", key, UPLOAD_TTL_SEC);
  return { ok: true, fileId, url };
}

/**
 * Studio: confirms an upload. The stored size must match, and the first bytes must match the declared type.
 * A mismatch deletes the object, so a file that lies about its type never becomes a deliverable.
 */
export async function completeUpload(input: { userId: string; fileId: string; storage: ObjectStorage }): Promise<FileResult> {
  const membership = await getStudioMembership(input.userId);
  if (!membership) return { ok: false, message: "Studio not found." };
  if (!canWrite(membership.role)) return { ok: false, message: "Your role cannot add deliverables." };

  const record = records.find((r) => r.id === input.fileId && r.status === "pending");
  const project = record ? findProject(membership.studioId, record.projectId) : null;
  if (!record || !project) return { ok: false, message: "Upload not found." };

  const reject = async (message: string): Promise<FileResult> => {
    await input.storage.remove(record.key);
    records.splice(records.indexOf(record), 1);
    return { ok: false, message };
  };

  const head = await input.storage.head(record.key);
  if (!head || head.size !== record.size) return reject("The upload did not finish. Try again.");

  const bytes = await input.storage.readHead(record.key, 16);
  const family = bytes ? sniffFamily(bytes) : null;
  if (family !== DELIVERABLE_TYPES[record.contentType]?.family) {
    return reject("The file does not match the type it was declared as.");
  }

  record.status = "ready";
  recordEvent({
    projectId: record.projectId,
    kind: "file_added",
    actor: "studio",
    summary: `Deliverable added to milestone ${record.position}`,
  });
  return { ok: true };
}

/** Studio: removes a deliverable. Allowed until the milestone is approved, because approval is the client's record. */
export async function deleteFile(input: {
  userId: string;
  projectId: string;
  fileId: string;
  storage: ObjectStorage;
}): Promise<FileResult> {
  const membership = await getStudioMembership(input.userId);
  if (!membership) return { ok: false, message: "Studio not found." };
  if (!canWrite(membership.role)) return { ok: false, message: "Your role cannot remove deliverables." };

  const project = findProject(membership.studioId, input.projectId);
  const record = records.find((r) => r.id === input.fileId && r.projectId === input.projectId && r.status === "ready");
  if (!project || !record) return { ok: false, message: "File not found." };
  const milestone = project.milestones.find((m) => m.position === record.position);
  if (milestone?.status === "approved") return { ok: false, message: "An approved milestone's files cannot be removed." };

  await input.storage.remove(record.key);
  records.splice(records.indexOf(record), 1);
  recordEvent({ projectId: record.projectId, kind: "file_removed", actor: "studio", summary: `Deliverable removed from milestone ${record.position}` });
  return { ok: true };
}

/**
 * Removes uploads that were requested but never confirmed, and their objects. Run by the scheduled job.
 * Returns how many were removed. Objects that were never uploaded are removed too, which storage accepts.
 */
export async function sweepAbandonedUploads(storage: ObjectStorage, now: Date, maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const stale = records.filter((r) => r.status === "pending" && now.getTime() - new Date(r.createdAt).getTime() > maxAgeMs);
  for (const record of stale) {
    await storage.remove(record.key);
    records.splice(records.indexOf(record), 1);
  }
  return stale.length;
}

export type ReadyFile = { id: string; filename: string; size: number; contentType: string };

/** Ready files for one milestone. The caller has already checked who may see the project. */
export function listMilestoneFiles(projectId: string, position: number): ReadyFile[] {
  return records
    .filter((r) => r.projectId === projectId && r.position === position && r.status === "ready")
    .map((r) => ({ id: r.id, filename: r.filename, size: r.size, contentType: r.contentType }));
}

export type DownloadResult = { ok: true; url: string } | { ok: false; message: string };

/** A short-lived download link. The response forces a download under the stored filename. */
export async function downloadUrl(input: {
  userId: string;
  projectId: string;
  fileId: string;
  storage: ObjectStorage;
}): Promise<DownloadResult> {
  const project = demoProjects.find((p) => p.id === input.projectId);
  if (!project || !(await canSee(input.userId, project))) return { ok: false, message: "File not found." };
  const record = records.find((r) => r.id === input.fileId && r.projectId === input.projectId && r.status === "ready");
  if (!record) return { ok: false, message: "File not found." };
  const url = await input.storage.presign("GET", record.key, DOWNLOAD_TTL_SEC, {
    "response-content-disposition": `attachment; filename="${record.filename}"`,
  });
  return { ok: true, url };
}

/** Test helper: the storage key a file was given, derived the same way as in createUploadIntent. */
export function keyOf(projectId: string, position: number, fileId: string): string {
  return keyFor(projectId, position, fileId);
}

