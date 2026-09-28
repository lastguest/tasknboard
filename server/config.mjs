import { resolve } from "node:path";
export const dbPath = resolve(process.env.TASKNBOARD_DB || "data/tasknboard.sqlite");
export const localActor = { id: "you", kind: "human" };
export function tokensFromEnvironment() {
  const records = JSON.parse(process.env.TASKNBOARD_TOKENS || "{}");
  for (const [token, actor] of Object.entries(records))
    if (
      token.length < 24 ||
      !actor.id ||
      !["human", "agent"].includes(actor.kind)
    )
      throw new Error("TASKNBOARD_TOKENS must map tokens (24+ chars) to {id,kind}");
  return records;
}
