import { createHmac, timingSafeEqual } from "node:crypto";

const identity = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,79}$/;
const equal = (a, b) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Local credentials identify a principal; request arguments never grant roles. */
export function credentialFor(secret, actor) {
  if (!secret || secret.length < 24)
    throw new Error("Local service credential is unavailable.");
  if (!identity.test(actor.id) || !["agent", "app"].includes(actor.kind))
    throw new Error("Invalid local principal.");
  const payload = Buffer.from(JSON.stringify(actor)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `tnb1.${payload}.${signature}`;
}

export function authenticateLocal(presented, secret, tokens = {}) {
  if (!presented) return null;
  if (secret && equal(presented, secret)) return { id: "you", kind: "human" };
  for (const [token, actor] of Object.entries(tokens))
    if (equal(presented, token)) return actor;
  const [prefix, payload, signature, extra] = presented.split(".");
  if (!secret || prefix !== "tnb1" || !payload || !signature || extra)
    return null;
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  if (!equal(signature, expected)) return null;
  try {
    const actor = JSON.parse(Buffer.from(payload, "base64url").toString());
    return identity.test(actor.id) && ["agent", "app"].includes(actor.kind) &&
      (actor.role === undefined || ["architect", "worker"].includes(actor.role))
      ? actor
      : null;
  } catch {
    return null;
  }
}
