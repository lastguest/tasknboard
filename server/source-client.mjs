import { connect as connectResident } from "./client.mjs";
import { connect as connectStandalone } from "./standalone-client.mjs";

export function connect({ actor, env = process.env } = {}) {
  if (env.TASKNBOARD_DB && !env.TASKNBOARD_SERVER_URL && !env.TASKNBOARD_RUNTIME_FILE)
    return connectStandalone({ actor, env, database: env.TASKNBOARD_DB });
  return connectResident({ actor, env });
}
