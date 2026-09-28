import { z } from "zod";
export const statuses = ["backlog", "in_progress", "in_review", "done"];
const text = z.string().trim().min(1).max(300);
const long = z.string().max(20000);
const version = z.number().int().positive();
const id = z.string().regex(/^TNB-\d+$/);
const patch = z
  .object({
    title: text.optional(),
    description: long.optional(),
    acceptance: long.optional(),
    status: z.enum(statuses).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    assignee: z.string().max(80).optional(),
    label: z.string().max(40).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Empty patch");
export const schemas = {
  list_tasks: z
    .object({
      query: z.string().max(300).optional(),
      status: z.enum(statuses).optional(),
      assignee: z.string().max(80).optional(),
      limit: z.number().int().min(1).max(100).default(100),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  get_task: z.object({ id }).strict(),
  create_task: z
    .object({
      title: text,
      description: long.default(""),
      acceptance: long.default(""),
      priority: z.enum(["low", "medium", "high"]).default("medium"),
      assignee: z.string().max(80).default(""),
      label: z.string().max(40).default("Product"),
    })
    .strict(),
  update_task: z.object({ id, expectedVersion: version, patch }).strict(),
  set_standup_notes: z
    .object({
      id,
      expectedVersion: version,
      highlight: z.string().trim().max(500),
      blocker: z.string().trim().max(500),
    })
    .strict(),
  claim_task: z.object({ id, expectedVersion: version }).strict(),
  heartbeat: z.object({ id, expectedVersion: version }).strict(),
  release_task: z.object({ id, expectedVersion: version }).strict(),
  add_comment: z
    .object({
      id,
      expectedVersion: version,
      body: z.string().trim().min(1).max(10000),
    })
    .strict(),
  submit_review: z
    .object({
      id,
      expectedVersion: version,
      summary: z.string().trim().min(1).max(10000),
      artifactUrl: z
        .union([
          z.literal(""),
          z.url().refine((s) => /^https?:\/\//.test(s), "HTTP(S) URL required"),
        ])
        .default(""),
    })
    .strict(),
  archive_task: z.object({ id, expectedVersion: version }).strict(),
  workspace_info: z.object({}).strict(),
  export_workspace: z.object({}).strict(),
};
export class DomainError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const fail = (code, message, status) => {
  throw new DomainError(code, message, status);
};
