import { z } from "zod";
import { isAbsolute, win32 } from "node:path";

/** Settings key that holds one agent identity's launch configuration. */
export const configKey = (identity) => `agent_config.${identity}`;
/** The key plugin installs wrote before configurations existed. */
export const legacyKey = (identity) => `agent_launcher.${identity}`;
export const identityPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

/**
 * The CLIs the app can start headlessly. Each run is full auto: nobody watches
 * it, so it cannot stop for approvals. `profile` names the CLI's own switch
 * for a saved setup; it means something different in each CLI.
 */
export const agentClients = {
  claude: {
    name: "Claude Code",
    executable: "claude",
    model: { hint: "An alias such as sonnet or opus, or a full model ID." },
    profile: { label: "Agent", flag: "--agent", hint: "A Claude Code agent defined in .claude/agents." },
    args: ({ prompt, model, profile }) => [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      ...(model ? ["--model", model] : []),
      ...(profile ? ["--agent", profile] : []),
    ],
  },
  codex: {
    name: "Codex",
    executable: "codex",
    model: { hint: "A model ID such as gpt-5-codex." },
    profile: { label: "Profile", flag: "--profile", hint: "A profile from ~/.codex/config.toml." },
    // The prompt is the last argument, after any extra arguments.
    args: ({ folder, model, profile }) => [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-C",
      folder,
      ...(model ? ["--model", model] : []),
      ...(profile ? ["--profile", profile] : []),
    ],
    promptLast: true,
  },
  opencode: {
    name: "OpenCode",
    executable: "opencode",
    model: { hint: "provider/model, such as anthropic/claude-sonnet-4-5." },
    profile: { label: "Agent", flag: "--agent", hint: "An OpenCode agent, such as build or plan." },
    args: ({ folder, model, profile }) => [
      "run",
      "--auto",
      "--dir",
      folder,
      ...(model ? ["--model", model] : []),
      ...(profile ? ["--agent", profile] : []),
    ],
    promptLast: true,
  },
  pi: {
    name: "Pi",
    executable: "pi",
    model: { hint: "A model pattern or provider/id, optionally with :thinking." },
    profile: { label: "Provider", flag: "--provider", hint: "A Pi provider name, such as anthropic." },
    // --approve trusts the project's .pi folder, where the TasknBoard skill lives.
    args: ({ model, profile }) => [
      "--print",
      "--approve",
      ...(model ? ["--model", model] : []),
      ...(profile ? ["--provider", profile] : []),
    ],
    promptLast: true,
  },
};

/**
 * What can start an agent. `{{name}}` placeholders in a prompt are replaced
 * when the run starts; the fixed safety instructions always come first.
 */
export const agentEvents = [
  {
    id: "task_assigned",
    label: "Task assigned",
    description: "A person assigns a task to this agent, or creates one for it.",
    enabled: true,
    placeholders: ["agent", "task", "title", "board"],
    prompt: [
      "A person assigned task {{task}} to you and started you to work on it now.",
      "Call get_task for {{task}}, then claim_task with its version. Do the work in this folder.",
      "Call heartbeat before the 15-minute lease expires, and add_comment to record progress.",
      "When the acceptance criteria pass, call submit_review with a summary of the change and how you checked it.",
      "If you cannot finish, add_comment with the reason, then release_task.",
    ].join("\n"),
  },
  {
    id: "task_unassigned",
    label: "Task unassigned",
    description:
      "A person assigns this agent's task to someone else. The app stops the run for that task and drops it from the queue. Claimed tasks cannot be reassigned until the claim ends.",
    enabled: true,
    placeholders: [],
    prompt: null,
  },
  {
    id: "changes_requested",
    label: "Changes requested",
    description: "A person sends this agent's task back from review with Needs changes.",
    enabled: true,
    placeholders: ["agent", "task", "title", "board"],
    prompt: [
      "A reviewer sent task {{task}} back to you and asked for changes.",
      "Call get_task for {{task}} and read the review and the latest comments to find what to change, then claim_task with its version.",
      "Make the changes in this folder. Call heartbeat before the 15-minute lease expires.",
      "When they are done, call submit_review with what changed since the last review.",
      "If you cannot finish, add_comment with the reason, then release_task.",
    ].join("\n"),
  },
  {
    id: "mention",
    label: "Mentioned in a comment",
    description:
      "A person writes @identity in a comment. To reply, the agent claims the task, which makes it the assignee.",
    enabled: false,
    placeholders: ["agent", "task", "title", "board", "author", "comment"],
    prompt: [
      "{{author}} mentioned you in a comment on task {{task}}:",
      "",
      "{{comment}}",
      "",
      "Call get_task for {{task}} and read the context. Agents need a claim to comment, so call claim_task, add_comment with your reply, then release_task.",
      "Only change code when the comment asks for it and the task is assigned to you.",
    ].join("\n"),
  },
  {
    id: "standup",
    label: "Stand-up",
    description:
      "A person opens the stand-up presentation and this agent has tasks in progress or in review. The run starts in the folder of its first such task.",
    enabled: false,
    placeholders: ["agent", "tasks", "board"],
    prompt: [
      "The team stand-up just started. Your open tasks: {{tasks}}.",
      "For each in-progress task, call get_task, claim_task if you do not hold its claim, then set_standup_notes with a one-line highlight and any blocker.",
      "Release the claim afterwards with release_task unless you are about to keep working on the task.",
      "Do not change code during a stand-up run.",
    ].join("\n"),
  },
];
const eventIds = agentEvents.map((e) => e.id);

/** Keys the app sets itself: the agent's identity and the user's login stay as they are. */
const reservedEnv = /^(HOME|USERPROFILE|TASKNBOARD_.*)$/i;
const client = z.enum(Object.keys(agentClients));
const short = z.string().trim().max(200);
const binding = z
  .object({ enabled: z.boolean(), prompt: z.string().max(4000).optional() })
  .strict();
export const agentConfigSchema = z
  .object({
    enabled: z.boolean(),
    client,
    command: z
      .string()
      .trim()
      .max(1000)
      .refine(
        (v) => !v || isAbsolute(v) || win32.isAbsolute(v),
        "Enter an absolute path to the executable, or leave it empty to find it on PATH",
      ),
    model: short.regex(/^[^\s]*$/, "Model must not contain spaces"),
    profile: short.regex(/^[^\s]*$/, "Profile must not contain spaces"),
    args: z.array(z.string().max(1000)).max(40),
    env: z.record(z.string(), z.string().max(4000)).superRefine((env, ctx) => {
      const keys = Object.keys(env);
      if (keys.length > 40) ctx.addIssue({ code: "custom", message: "Up to 40 environment variables" });
      for (const key of keys)
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
          ctx.addIssue({ code: "custom", path: [key], message: "Environment names use letters, digits, and underscores" });
        else if (reservedEnv.test(key))
          ctx.addIssue({ code: "custom", path: [key], message: "HOME, USERPROFILE, and TASKNBOARD_ variables are set by the app" });
    }),
    // An enum-keyed record needs a binding for every event.
    events: z.record(z.enum(eventIds), binding),
  })
  .strict();

export function defaultConfig(clientId = "claude") {
  return {
    enabled: true,
    client: clientId,
    command: "",
    model: "",
    profile: "",
    args: [],
    env: {},
    events: Object.fromEntries(
      agentEvents.map((e) => [
        e.id,
        e.prompt === null
          ? { enabled: e.enabled }
          : { enabled: e.enabled, prompt: e.prompt },
      ]),
    ),
  };
}

/** Validates a saved or submitted configuration; throws a 400 error on bad input. */
export function parseConfig(value) {
  const result = agentConfigSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw Object.assign(
      new Error(`${issue.path.join(".") || "config"}: ${issue.message}`),
      { code: "VALIDATION", status: 400 },
    );
  }
  return result.data;
}

/** The stored configuration, the one a plugin install implied, or null. */
export function readConfig(store, identity) {
  const stored = store.setting(configKey(identity));
  if (stored) {
    try {
      const saved = JSON.parse(stored);
      // Events added after the configuration was saved get their defaults.
      return parseConfig({
        ...saved,
        events: { ...defaultConfig().events, ...saved.events },
      });
    } catch {
      return null;
    }
  }
  const legacy = store.setting(legacyKey(identity));
  return agentClients[legacy] ? defaultConfig(legacy) : null;
}

export function writeConfig(store, identity, config) {
  if (!identityPattern.test(identity))
    throw Object.assign(new Error("Enter a valid agent identity."), {
      code: "VALIDATION",
      status: 400,
    });
  const parsed = parseConfig(config);
  store.setSettings({
    [configKey(identity)]: JSON.stringify(parsed),
    [legacyKey(identity)]: "",
  });
  return parsed;
}

/** Every configured identity, including ones only a plugin install recorded. */
export function listConfigs(store) {
  const ids = new Set(
    store
      .settingKeys("agent_")
      .map((key) => key.replace(/^agent_(config|launcher)\./, ""))
      .filter((id) => identityPattern.test(id)),
  );
  return Object.fromEntries(
    [...ids]
      .sort()
      .map((id) => [id, readConfig(store, id)])
      .filter(([, config]) => config),
  );
}

/** Fills `{{name}}` placeholders; unknown names stay as written. */
export const renderPrompt = (template, values) =>
  template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );

/** Identities written as @identity in a comment, in order, without duplicates. */
export function mentionedIdentities(body) {
  const found = new Set();
  for (const match of String(body).matchAll(
    /(^|[^\w@.-])@([a-zA-Z0-9][a-zA-Z0-9._-]{0,79})/g,
  ))
    found.add(match[2].replace(/[.]+$/, ""));
  return [...found];
}
