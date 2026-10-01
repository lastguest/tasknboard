import { Icon } from "./Icons";
import { Avatar, usePeople, displayName } from "./People";
import { relativeTime } from "./formatting";
import type { Inbox, InboxItem } from "./types";

const action: Record<InboxItem["reason"], string> = {
  mention: "mentioned you on",
  review: "submitted for review",
  comment: "commented on",
};

/**
 * Comments, mentions and reviews from others on your tasks. Opening the page
 * marks nothing read; only Mark all read moves the read position.
 */
export function InboxPage({
  inbox,
  marking,
  onOpen,
  onMarkRead,
}: {
  inbox: Inbox;
  marking: boolean;
  onOpen: (taskId: string) => void;
  onMarkRead: () => void;
}) {
  const people = usePeople();
  return (
    <div className="views-page">
      <div className="toolbar epics-toolbar">
        <p className="result-summary" role="status">
          {inbox.unread} unread
        </p>
        <button
          type="button"
          className="secondary"
          disabled={!inbox.unread || marking}
          onClick={onMarkRead}
        >
          <Icon name="check" size={16} /> Mark all read
        </button>
      </div>
      {inbox.items.length === 0 ? (
        <div className="empty-state">
          <Icon name="inbox" size={26} />
          <h2>Nothing here yet.</h2>
          <p>
            Comments on your tasks, mentions of you, and work submitted for
            your review appear here.
          </p>
        </div>
      ) : (
        <ul className="view-rows inbox-rows">
          {inbox.items.map((item, index) => {
            const unread = index < inbox.unread;
            const who = displayName(people, item.actor);
            return (
              <li
                key={item.sequence}
                className={`inbox-row ${unread ? "unread" : ""}`}
              >
                <Avatar
                  name={item.actor}
                  agent={people.get(item.actor)?.kind === "agent"}
                />
                <span className="inbox-row-copy">
                  <button
                    type="button"
                    className="inbox-row-open"
                    onClick={() => onOpen(item.taskId)}
                  >
                    {unread && <span className="sr-only">Unread: </span>}
                    <strong>{who}</strong> {action[item.reason]}{" "}
                    <span className="inbox-row-task">{item.taskId}</span>{" "}
                    {item.taskTitle}
                  </button>
                  <span className="inbox-row-excerpt">{item.excerpt}</span>
                </span>
                <time
                  dateTime={item.createdAt}
                  title={new Date(item.createdAt).toUTCString()}
                >
                  {relativeTime(item.createdAt)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
