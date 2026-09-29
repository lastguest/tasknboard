import { z } from "zod";
/** 5 MB of image bytes, base64-encoded inside a data URL. */
export const imageBytesLimit = 5 * 1024 * 1024;
export const imageDataUrlLimit = Math.ceil(imageBytesLimit / 3) * 4 + 32;
export const statuses = ["backlog", "in_progress", "in_review", "done"];
const text = z.string().trim().min(1).max(300);
const long = z.string().max(20000);
const version = z.number().int().positive();
const id = z.string().regex(/^TNB-\d+$/);
const epicId = z.string().regex(/^EPIC-\d+$/);
/** A task's epic: an epic ID, or "" for none. */
const taskEpic = z.union([z.literal(""), epicId]);
const epicTitle = z.string().trim().min(1).max(120);
/** Named epic colours; the UI owns their hex values (src/types.ts). */
export const epicColors = [
  "aurora",
  "lagoon",
  "cobalt",
  "iris",
  "orchid",
  "flamingo",
  "coral",
  "tangerine",
  "saffron",
  "lime",
  "jade",
  "glacier",
];
/** A palette name, or a custom "#rrggbb" colour (stored lowercase). */
const epicColor = z.union([
  z.enum(epicColors),
  z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Palette name or #rrggbb colour required")
    .transform((hex) => hex.toLowerCase()),
]);
const labels = z.array(z.string().trim().min(1).max(40))
  .transform((values) => [...new Set(values)]);
const patch = z
  .object({
    title: text.optional(),
    description: long.optional(),
    acceptance: long.optional(),
    status: z.enum(statuses).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    assignee: z.string().max(80).optional(),
    labels: labels.optional(),
    epic: taskEpic.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Empty patch");
export const schemas = {
  list_tasks: z
    .object({
      query: z.string().max(300).optional(),
      status: z.enum(statuses).optional(),
      assignee: z.string().max(80).optional(),
      epic: z.union([z.literal("none"), epicId]).optional(),
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
      labels: labels.default(["Product"]),
      epic: taskEpic.default(""),
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
  update_profile: z
    .object({
      name: z.string().trim().max(80).optional(),
      // A small, already-resized picture. Only raster data URLs are accepted.
      avatar: z
        .union([
          z.literal(""),
          z
            .string()
            .max(48000)
            .regex(
              /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
              "PNG, JPEG, or WebP data URL required",
            ),
        ])
        .optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, "Empty profile"),
  // Images pasted into Markdown descriptions. Raster only; SVG can carry script.
  upload_image: z
    .object({
      data: z
        .string()
        .max(imageDataUrlLimit)
        .regex(
          /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/,
          "PNG, JPEG, WebP, or GIF data URL required",
        ),
    })
    .strict(),
  list_epics: z
    .object({ includeArchived: z.boolean().default(false) })
    .strict(),
  create_epic: z
    .object({
      title: epicTitle,
      description: long.default(""),
      color: epicColor.optional(),
    })
    .strict(),
  update_epic: z
    .object({
      id: epicId,
      expectedVersion: version,
      patch: z
        .object({
          title: epicTitle.optional(),
          description: long.optional(),
          color: epicColor.optional(),
        })
        .strict()
        .refine((v) => Object.keys(v).length > 0, "Empty patch"),
    })
    .strict(),
  archive_epic: z.object({ id: epicId, expectedVersion: version }).strict(),
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
