import { createContext, useContext } from "react";
import type { Actor } from "./types";
import { Icon } from "./Icons";

/** Known actors by ID. Assignees outside the roster stay plain free text. */
export const PeopleContext = createContext<ReadonlyMap<string, Actor>>(
  new Map(),
);

export const usePeople = () => useContext(PeopleContext);

/** The profile name when one is set, otherwise the stored ID. */
export function displayName(people: ReadonlyMap<string, Actor>, id: string) {
  return people.get(id)?.name?.trim() || id;
}

export function usePersonName(id: string) {
  return displayName(usePeople(), id);
}

/** A stable colour slot per identity, like default avatars in issue trackers. */
function avatarTone(id: string) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % 8;
}

export function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0])
    .join("")
    .toUpperCase();
}

export function Avatar({
  name,
  agent,
  size = "small",
}: {
  name: string;
  agent: boolean;
  size?: "small" | "large";
}) {
  const people = usePeople();
  const person = people.get(name);
  const label = displayName(people, name);
  const picture = person?.avatar?.startsWith("data:image/")
    ? person.avatar
    : "";
  const classes = [
    "avatar",
    size === "large" && "large",
    !name && "none",
    name && !picture && (agent ? "bot" : `tone-${avatarTone(name)}`),
    picture && "picture",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} aria-hidden="true">
      {picture ? (
        <img src={picture} alt="" draggable={false} />
      ) : agent && name ? (
        <Icon name="bot" size={size === "large" ? 28 : 15} />
      ) : (
        initialsOf(label) || "—"
      )}
    </span>
  );
}

/** Inline name with avatar, for activity, claims, and review evidence. */
export function Person({ id }: { id: string }) {
  const people = usePeople();
  const label = displayName(people, id);
  return (
    <span className="person" title={label === id ? undefined : id}>
      <Avatar name={id} agent={people.get(id)?.kind === "agent"} />
      <strong>{label}</strong>
    </span>
  );
}

export function PersonName({ id }: { id: string }) {
  return <>{usePersonName(id)}</>;
}
