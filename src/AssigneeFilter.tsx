import { forwardRef, useState } from "react";
import { SearchableChoiceDialog, type ChoiceOption } from "./Dialogs";
import { Avatar, displayName, usePeople } from "./People";

/** The filter value that matches tasks with no assignee. */
export const UNASSIGNED = "__unassigned__";

const VISIBLE = 5;

/**
 * Jira-style avatar stack: click a face to filter by that person, click it
 * again to clear. People beyond the stack live behind a searchable "+N".
 */
export const AssigneeFilter = forwardRef<
  HTMLButtonElement,
  {
    assignees: string[];
    agents: Set<string>;
    me: string;
    value: string;
    onChange: (value: string) => void;
  }
>(function AssigneeFilter({ assignees, agents, me, value, onChange }, ref) {
  const people = usePeople();
  const [more, setMore] = useState(false);
  const everyone = [
    ...new Set([
      ...(assignees.includes(me) ? [me] : []),
      ...[...assignees].sort((a, b) =>
        displayName(people, a).localeCompare(displayName(people, b)),
      ),
      ...(value && value !== UNASSIGNED ? [value] : []),
    ]),
    UNASSIGNED,
  ];
  let shown = everyone.slice(0, VISIBLE);
  // Keep the active filter visible even when it sorts past the stack.
  if (value && !shown.includes(value))
    shown = [...shown.slice(0, VISIBLE - 1), value];
  const hidden = everyone.filter((id) => !shown.includes(id));
  const label = (id: string) =>
    id === UNASSIGNED ? "Unassigned" : displayName(people, id);
  const toggle = (id: string) => onChange(value === id ? "" : id);
  const options: ChoiceOption[] = everyone.map((id) => {
    const name = label(id);
    const real = id === UNASSIGNED ? "" : id;
    return {
      value: id,
      label: name,
      detail:
        [
          ...(real && name !== real ? [real] : []),
          ...(real === me ? ["You"] : []),
          ...(agents.has(real) ? ["Agent"] : []),
        ].join(" · ") || undefined,
      icon: <Avatar name={real} agent={agents.has(real)} />,
    };
  });

  return (
    <div
      className="assignee-filter"
      role="group"
      aria-label="Filter by assignee"
    >
      {shown.map((id, index) => {
        const real = id === UNASSIGNED ? "" : id;
        const title =
          label(id) + (real === me ? " (you)" : agents.has(real) ? " (agent)" : "");
        return (
          <button
            key={id}
            ref={index === 0 ? ref : undefined}
            type="button"
            className={`avatar-filter${value === id ? " selected" : ""}`}
            style={{ zIndex: shown.length - index }}
            aria-label={label(id)}
            aria-pressed={value === id}
            title={title}
            onClick={() => toggle(id)}
          >
            <Avatar name={real} agent={agents.has(real)} />
          </button>
        );
      })}
      {hidden.length > 0 && (
        <button
          type="button"
          className="avatar-filter more"
          aria-label={`${hidden.length} more assignees`}
          aria-haspopup="dialog"
          title={hidden.map(label).join(", ")}
          onClick={() => setMore(true)}
        >
          +{hidden.length}
        </button>
      )}
      {more && (
        <SearchableChoiceDialog
          title="Filter by assignee"
          searchLabel="Search users"
          options={options}
          selected={value ? [value] : []}
          onSelect={(id) => {
            toggle(id);
            setMore(false);
          }}
          onToggle={() => {}}
          onClose={() => setMore(false)}
        />
      )}
    </div>
  );
});
