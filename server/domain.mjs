import { z } from "zod";
import {
  viewFields,
  viewOps,
  viewLayouts,
  viewGroups,
  viewOrders,
  ME,
} from "./views.mjs";
/** 5 MB of image bytes, base64-encoded inside a data URL. */
export const imageBytesLimit = 5 * 1024 * 1024;
export const imageDataUrlLimit = Math.ceil(imageBytesLimit / 3) * 4 + 32;
/** What a lane means to the agent and review workflow. See docs/contracts/lanes.md. */
export const laneRoles = ["todo", "in_progress", "in_review", "done"];
/** At most this many lanes on one board. */
export const laneLimit = 13;
const text = z.string().trim().min(1).max(300);
const long = z.string().max(20000);
const version = z.number().int().positive();
/** Task and epic keys are "<PREFIX>-<n>". */
const key = z.string().regex(/^[A-Z][A-Z0-9]{0,9}-\d+$/, "Key like ABC-12 required");
const id = key;
const epicId = key;
const boardId = z.string().regex(/^BOARD-\d+$/);
const laneId = z.string().regex(/^LANE-\d+$/, "Lane ID like LANE-3 required");
const laneRole = z.enum(laneRoles);
const laneName = z.string().trim().min(1).max(40);
const lanePosition = z.number().int().min(0);
/** 2–10 letters or digits, starting with a letter. Entered case is ignored. */
export const keyPrefix = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "2–10 letters or digits, starting with a letter")
  .refine((v) => !["EPIC", "VIEW", "BOARD"].includes(v), "EPIC, VIEW, and BOARD are reserved");
const boardName = z.string().trim().min(1).max(80);
/** Plain text shown under the board title; "" means none. */
const boardDescription = z.string().trim().max(500);
/** Absolute folder where agents assigned a task on this board start work; "" means none. */
const boardRepository = z
  .string()
  .trim()
  .max(1000)
  .refine(
    (v) => v === "" || v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v),
    "Enter an absolute folder path",
  );
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
const viewId = z.string().regex(/^VIEW-\d+$/);
/** Valid values per view field; "" means none (unassigned, no epic, no labels). */
const viewValue = {
  role: laneRole,
  lane: laneId,
  priority: z.enum(["low", "medium", "high"]),
  assignee: z.union([z.literal(ME), z.string().max(80)]),
  label: z.union([z.literal(""), z.string().trim().min(1).max(40)]),
  epic: taskEpic,
  delegated: z.enum(["true","false"]),
};
const viewCondition = z
  .object({
    field: z.enum(viewFields),
    op: z.enum(viewOps),
    values: z.array(z.string()).min(1).max(50),
  })
  .strict()
  .superRefine((condition, ctx) => {
    condition.values.forEach((value, index) => {
      if (!viewValue[condition.field].safeParse(value).success)
        ctx.addIssue({
          code: "custom",
          path: ["values", index],
          message: `Not a valid ${condition.field} value`,
        });
    });
  })
  .transform((condition) => ({
    ...condition,
    values: [
      ...new Set(
        condition.values.map((value) => viewValue[condition.field].parse(value)),
      ),
    ],
  }));
const viewFilters = z
  .object({
    query: z.string().trim().max(300).default(""),
    conditions: z.array(viewCondition).max(20).default([]),
  })
  .strict();
const viewDisplay = z
  .object({
    layout: z.enum(viewLayouts).default("board"),
    groupBy: z.enum(viewGroups).default("lane"),
    orderBy: z.enum(viewOrders).default("created"),
  })
  .strict();
const viewName = z.string().trim().min(1).max(80);
/** How a task relates to another, read from the first task's side. */
export const linkTypes = [
  "blocks",
  "blocked_by",
  "relates",
  "duplicates",
  "duplicated_by",
];
/** At most this many pull requests link to one task. */
export const pullRequestLimit = 20;
/**
 * A GitHub pull request from its URL or `owner/repo#123`, stored as
 * `{ repository, number, url }` with the canonical URL.
 */
export function parsePullRequest(value) {
  const text = String(value).trim();
  const match =
    text.match(
      /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i,
    ) ?? text.match(/^([\w-]+)\/([\w.-]+)#(\d+)$/);
  if (!match || !Number(match[3])) return null;
  const repository = `${match[1]}/${match[2]}`;
  const number = Number(match[3]);
  return { repository, number, url: `https://github.com/${repository}/pull/${number}` };
}
const pullRequest = z
  .string()
  .max(500)
  .transform((value, ctx) => {
    const pr = parsePullRequest(value);
    if (!pr) {
      ctx.addIssue({
        code: "custom",
        message: "GitHub pull request URL or owner/repo#123 required",
      });
      return z.NEVER;
    }
    return pr;
  });
const label = z.string().trim().min(1).max(40);
const labels = z.array(label)
  .transform((values) => [...new Set(values)]);
const artifact = z.string().trim().max(1000).refine((value) => value === "" || /^\/files\/[a-f0-9]{32}$/.test(value) || (/^https?:\/\//.test(value) && z.url().safeParse(value).success) || /^(?:commit:)?[a-f0-9]{7,40}$/i.test(value) || (!/^[a-z]+:/i.test(value) && !/^[\\/]/.test(value) && !value.split(/[\\/]/).includes("..")), "HTTP(S), commit SHA, or repository-relative path required");
const agentReasoning = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
const agentSandbox = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const patch = z
  .object({
    title: text.optional(),
    description: long.optional(),
    acceptance: long.optional(),
    lane: laneId.optional(),
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
      role: laneRole.optional(),
      lane: laneId.optional(),
      assignee: z.string().max(80).optional(),
      owner: z.string().max(80).optional(),
      label: label.optional(),
      compact: z.boolean().default(false),
      archived: z.boolean().default(false),
      epic: z.union([z.literal("none"), epicId]).optional(),
      boardId: boardId.optional(),
      view: viewId.optional(),
      limit: z.number().int().min(1).max(100).default(100),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  get_task: z.object({ id }).strict(),
  find_similar_tasks: z
    .object({
      title: text,
      context: long.optional(),
      boardId: boardId.optional(),
      excludeId: id.optional(),
      limit: z.number().int().min(1).max(20).default(5),
    })
    .strict(),
  get_tasks: z.object({ ids: z.array(id).min(1).max(100) }).strict(),
  create_task: z
    .object({
      boardId,
      lane: laneId.optional(),
      title: text,
      description: long.default(""),
      acceptance: long.default(""),
      priority: z.enum(["low", "medium", "high"]).default("medium"),
      assignee: z.string().max(80).default(""),
      labels: labels.default([]),
      epic: taskEpic.default(""),
      blockedBy: z.array(id).max(100).default([]),
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
  delegate_task: z.object({ id, expectedVersion: version, delegatedTo: text }).strict(),
  reject_task: z.object({ id, expectedVersion: version, reason: z.string().trim().max(10000).default("") }).strict(),
  request_changes: z.object({ id, expectedVersion: version, reason: z.string().trim().min(1).max(10000) }).strict(),
  list_notifications: z.object({ after: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  link_commits: z.object({ id, expectedVersion: version, commits: z.array(z.string().regex(/^[a-f0-9]{7,40}$/i)).min(1).max(100) }).strict(),
  add_comment: z
    .object({
      id,
      expectedVersion: version.optional(),
      body: z.string().trim().min(1).max(10000),
    })
    .strict(),
  submit_review: z
    .object({
      id,
      expectedVersion: version,
      summary: z.string().trim().min(1).max(10000),
      artifactUrl: artifact.default(""),
    })
    .strict(),
  archive_task: z.object({ id, expectedVersion: version }).strict(),
  restore_task: z.object({ id, expectedVersion: version }).strict(),
  link_task: z
    .object({
      id,
      expectedVersion: version,
      type: z.enum(linkTypes),
      target: id,
    })
    .strict(),
  unlink_task: z
    .object({ id, expectedVersion: version, target: id })
    .strict(),
  link_pull_requests: z
    .object({
      id,
      expectedVersion: version,
      pullRequests: z.array(pullRequest).min(1).max(pullRequestLimit),
    })
    .strict(),
  unlink_pull_request: z
    .object({ id, expectedVersion: version, pullRequest })
    .strict(),
  update_profile: z
    .object({
      agentId: z.string().trim().min(1).max(200).optional(),
      role: z.enum(["architect", "worker"]).optional(),
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
      useGravatar: z.boolean().optional(),
      // Omit to keep the saved address. Empty clears it while Gravatar is off.
      gravatarEmail: z
        .string()
        .trim()
        .max(254)
        .pipe(z.union([z.literal(""), z.email().max(254)]))
        .optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, "Empty profile")
    .refine((v) => (v.agentId === undefined) === (v.role === undefined), "agentId and role must be set together")
    .refine((v) => v.agentId === undefined || Object.keys(v).every((key) => ["agentId", "role"].includes(key)), "Agent role updates accept only agentId and role"),
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
    .object({
      includeArchived: z.boolean().default(false),
      boardId: boardId.optional(),
    })
    .strict(),
  create_epic: z
    .object({
      boardId: boardId.optional(),
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
  list_views: z.object({}).strict(),
  create_view: z
    .object({
      name: viewName,
      description: long.default(""),
      color: epicColor.optional(),
      shared: z.boolean().default(false),
      filters: viewFilters.default({ query: "", conditions: [] }),
      display: viewDisplay.default({
        layout: "board",
        groupBy: "lane",
        orderBy: "created",
      }),
    })
    .strict(),
  update_view: z
    .object({
      id: viewId,
      expectedVersion: version,
      patch: z
        .object({
          name: viewName.optional(),
          description: long.optional(),
          color: epicColor.optional(),
          shared: z.boolean().optional(),
          filters: viewFilters.optional(),
          display: viewDisplay.optional(),
        })
        .strict()
        .refine((v) => Object.keys(v).length > 0, "Empty patch"),
    })
    .strict(),
  delete_view: z.object({ id: viewId, expectedVersion: version }).strict(),
  favorite_view: z.object({ id: viewId, favorite: z.boolean() }).strict(),
  list_boards: z.object({}).strict(),
  create_board: z
    .object({
      name: boardName,
      prefix: keyPrefix,
      description: boardDescription.default(""),
      repository: boardRepository.default(""),
      agentReasoning: agentReasoning.default("medium"),
      agentSandbox: agentSandbox.default("workspace-write"),
    })
    .strict(),
  update_board: z
    .object({
      id: boardId,
      expectedVersion: version,
      patch: z
        .object({
          name: boardName.optional(),
          prefix: keyPrefix.optional(),
          description: boardDescription.optional(),
          repository: boardRepository.optional(),
          agentReasoning: agentReasoning.optional(),
          agentSandbox: agentSandbox.optional(),
        })
        .strict()
        .refine((v) => Object.keys(v).length > 0, "Empty patch"),
    })
    .strict(),
  create_lane: z
    .object({
      boardId,
      expectedVersion: version,
      name: laneName,
      role: laneRole,
      position: lanePosition.optional(),
    })
    .strict(),
  update_lane: z
    .object({
      id: laneId,
      expectedVersion: version,
      patch: z
        .object({ name: laneName.optional(), position: lanePosition.optional() })
        .strict()
        .refine((v) => Object.keys(v).length > 0, "Empty patch"),
    })
    .strict(),
  delete_lane: z
    .object({ id: laneId, expectedVersion: version, moveTo: laneId })
    .strict()
    .refine((v) => v.id !== v.moveTo, "moveTo: Choose another lane"),
  set_board_sidebar: z
    .object({ id: boardId, inSidebar: z.boolean() })
    .strict(),
  list_labels: z.object({}).strict(),
  rename_label: z
    .object({ from: label, to: z.union([z.literal(""), label]) })
    .strict()
    .refine((v) => v.from !== v.to, "to: Choose a different label"),
  list_inbox: z
    .object({ limit: z.number().int().min(1).max(100).default(50) })
    .strict(),
  mark_inbox_read: z.object({ upTo: z.number().int().min(0) }).strict(),
  workspace_info: z.object({}).strict(),
  export_workspace: z.object({}).strict(),
};
schemas.bulk_move_tasks = z.object({ tasks: z.array(z.object({ id, expectedVersion: version }).strict()).min(1).max(100), lane: laneId }).strict();
const via = z.string().trim().max(200);
const completionModes = ["human","any_agent","architect","any_agent_other_than_author","auto_on_evidence"];
const completionMode = z.enum(completionModes);
const labelPolicies = z.record(label,completionMode).transform((policies) => {
  const strictness={human:5,any_agent_other_than_author:4,architect:3,auto_on_evidence:2,any_agent:1};const result=Object.create(null);
  for(const [name,mode] of Object.entries(policies)){const key=name.toLowerCase();if(!result[key]||strictness[mode]>strictness[result[key]])result[key]=mode;}
  return result;
});
const taskPath = z.string().trim().max(1000).refine((value) => !value.split(/[\\/]/).includes(".."), "Paths cannot contain parent traversal");
const milestoneId = z.string().regex(/^MILESTONE-\d+$/);
const policy = z.object({ requireBriefForProgress: z.boolean().default(false), requireReviewArtifact: z.boolean().default(false), autoDispatch: z.boolean().default(false), humanCompletionOnly: z.boolean().default(true), completionMode:completionMode.exclude(["human"]).default("any_agent"),labelCompletionPolicies:labelPolicies.default({}) }).strict();
const metadata = { branch: z.string().trim().max(300), briefPath: taskPath, resultPath: taskPath, milestone: z.union([z.literal(""), milestoneId]) };
schemas.create_task = schemas.create_task.extend(Object.fromEntries(Object.entries(metadata).map(([key, schema]) => [key, schema.default("")])));
schemas.update_task = z.object({ id, expectedVersion: version, patch: patch.extend(Object.fromEntries(Object.entries(metadata).map(([key, schema]) => [key, schema.optional()]))) }).strict();
schemas.create_board = schemas.create_board.extend({ policy: policy.default({ requireBriefForProgress: false, requireReviewArtifact: false, autoDispatch: false, humanCompletionOnly: true,completionMode:"any_agent",labelCompletionPolicies:{} }) });
schemas.update_board = schemas.update_board.extend({ patch: schemas.update_board.shape.patch.extend({ policy: z.object({requireBriefForProgress:z.boolean().optional(),requireReviewArtifact:z.boolean().optional(),autoDispatch:z.boolean().optional(),humanCompletionOnly:z.boolean().optional(),completionMode:completionMode.exclude(["human"]).optional(),labelCompletionPolicies:labelPolicies.optional()}).strict().refine((value)=>Object.keys(value).length>0,"Empty policy").optional() }) });
schemas.create_epic = schemas.create_epic.extend({ completionPolicy:z.enum(["inherit",...completionModes]).default("inherit") });
schemas.update_epic = schemas.update_epic.extend({ patch:schemas.update_epic.shape.patch.extend({completionPolicy:z.enum(["inherit",...completionModes]).optional()}) });
schemas.add_comment = schemas.add_comment.extend({ via: via.optional() });
schemas.link_commits = schemas.link_commits.extend({ via: via.optional() });
schemas.submit_review = schemas.submit_review.extend({
  artifacts: z.array(z.object({ title: text, url: artifact.refine((value) => value.length > 0, "Artifact URL required"), mime:z.enum(["image/png","image/jpeg","image/webp","image/gif","text/plain","application/json"]).optional() }).strict()).max(50).default([]),
  commitRange: z.string().trim().max(300).default(""),
  verifiedBy: z.array(z.object({ agent: via.min(1), checks: z.string().trim().min(1).max(5000) }).strict()).max(50).default([]),
  via: via.optional(),
});
schemas.list_tasks = schemas.list_tasks.extend({ fields: z.array(z.enum(["id","title","role","lane","epic","version","boardId","priority","assignee","labels","delegatedTo","delegatedBy","blocked","blockers","branch","briefPath","resultPath","milestone","position","lease","archived","review","url","completionPolicy","completion","autoCompletion"])).min(1).max(30).optional(), delegated: z.boolean().optional() });
schemas.find_similar_tasks = schemas.find_similar_tasks.extend({ includeArchived: z.boolean().default(false), includeDone: z.boolean().default(false) });
schemas.bulk_create_tasks = z.object({ tasks: z.array(schemas.create_task).min(1).max(100) }).strict();
schemas.claim_tasks = z.object({ tasks: z.array(schemas.claim_task).min(1).max(100) }).strict();
schemas.add_comments = z.object({ comments: z.array(schemas.add_comment).min(1).max(100) }).strict();
schemas.submit_reviews = z.object({ reviews: z.array(schemas.submit_review).min(1).max(100) }).strict();
schemas.undo_task = z.object({ id, expectedVersion: version }).strict();
schemas.reorder_task = z.object({ id, expectedVersion: version, position: lanePosition }).strict();
schemas.critical_path = z.object({ id }).strict();
schemas.list_activity = z.object({ hours: z.number().positive().max(8760).default(24), boardId: boardId.optional(), agent: via.optional(), limit: z.number().int().min(1).max(1000).default(100) }).strict();
const criteria = z.array(z.object({ text: text, checked: z.boolean().default(false) }).strict()).max(100);
schemas.list_milestones = z.object({ boardId: boardId.optional(), includeArchived: z.boolean().default(false) }).strict();
schemas.create_milestone = z.object({ boardId, title: text, criteria: criteria.default([]) }).strict();
schemas.update_milestone = z.object({ id: milestoneId, expectedVersion: version, patch: z.object({ title: text.optional(), criteria: criteria.optional() }).strict().refine((value) => Object.keys(value).length > 0, "Empty patch") }).strict();
schemas.archive_milestone = z.object({ id: milestoneId, expectedVersion: version }).strict();
schemas.set_label_color = z.object({ label, color: epicColor }).strict();
schemas.upload_artifact = z.object({ title: text, dataUrl: z.string().max(12 * 1024 * 1024).regex(/^data:(image\/(?:png|jpeg|webp|gif)|text\/plain|application\/json);base64,[A-Za-z0-9+/]+={0,2}$/) }).strict();
export class DomainError extends Error {
  constructor(code, message, status = 409, details) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}
export const fail = (code, message, status, details) => {
  throw new DomainError(code, message, status, details);
};
