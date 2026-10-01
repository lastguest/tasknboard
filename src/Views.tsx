import { useState } from "react";
import { ME } from "../server/views.mjs";
import {
  columns,
  epicColor,
  epicPalette,
  labelTone,
  priorities,
  statusTitle,
  type Epic,
  type SavedView,
  type Status,
  type Task,
  type ViewCondition,
  type ViewDisplay,
  type ViewField,
  type ViewFilters,
  type ViewGroup,
  type ViewOrder,
} from "./types";
import { ApiError, command, errorOf } from "./api";
import {
  Dialog,
  ErrorNote,
  SearchableChoiceDialog,
  type ChoiceOption,
} from "./Dialogs";
import { ColorField } from "./Epics";
import { StatusIcon } from "./Board";
import { Icon } from "./Icons";
import { Avatar, displayName, usePeople } from "./People";
import { Markdown, MarkdownEditor, plainText } from "./Markdown";

export const fieldTitles: Record<ViewField, string> = {
  status: "Status",
  priority: "Priority",
  assignee: "Assignee",
  label: "Label",
  epic: "Epic",
};

/** What a filter can offer: the workspace's people, labels and epics. */
export type FilterContext = {
  assignees: string[];
  agents: Set<string>;
  me: string;
  labels: string[];
  epics: Epic[];
};

/** The value "" means none: unassigned, no labels, or no epic. */
function valueLabel(
  field: ViewField,
  value: string,
  context: FilterContext,
  people: ReturnType<typeof usePeople>,
) {
  if (field === "status") return statusTitle(value as Status);
  if (field === "priority")
    return priorities.find((p) => p.id === value)?.title ?? value;
  if (field === "assignee")
    return value === ME
      ? "Me"
      : value
        ? displayName(people, value)
        : "Unassigned";
  if (field === "label") return value || "No labels";
  if (!value) return "No epic";
  return context.epics.find((e) => e.id === value)?.title ?? "Unavailable epic";
}

function valueChoices(
  field: ViewField,
  context: FilterContext,
  people: ReturnType<typeof usePeople>,
  selected: string[],
): ChoiceOption[] {
  if (field === "status")
    return columns.map((c) => ({
      value: c.id,
      label: c.title,
      icon: <StatusIcon status={c.id} />,
    }));
  if (field === "priority")
    return [...priorities].reverse().map((p) => ({ value: p.id, label: p.title }));
  if (field === "assignee") {
    // Keep chosen people listed even when no task has them any more.
    const ids = [
      ...new Set([
        ...context.assignees,
        ...selected.filter((v) => v && v !== ME),
      ]),
    ].sort((a, b) =>
      displayName(people, a).localeCompare(displayName(people, b)),
    );
    return [
      {
        value: ME,
        label: "Me",
        detail: "Whoever is looking at the view",
        icon: <Avatar name={context.me} agent={false} />,
      },
      ...ids.map((id) => ({
        value: id,
        label: displayName(people, id),
        detail:
          [
            ...(displayName(people, id) !== id ? [id] : []),
            ...(context.agents.has(id) ? ["Agent"] : []),
          ].join(" · ") || undefined,
        icon: <Avatar name={id} agent={context.agents.has(id)} />,
      })),
      { value: "", label: "Unassigned", icon: <Avatar name="" agent={false} /> },
    ];
  }
  if (field === "label")
    return [
      ...[...new Set([...context.labels, ...selected.filter(Boolean)])]
        .sort()
        .map((label) => ({
          value: label,
          label,
          icon: (
            <span
              className={`label-dot tone-${labelTone(label)}`}
              aria-hidden="true"
            />
          ),
        })),
      { value: "", label: "No labels" },
    ];
  return [
    ...context.epics
      .filter((e) => !e.archived || selected.includes(e.id))
      .map((e) => ({
        value: e.id,
        label: e.title,
        detail: e.archived ? `${e.id} · Archived` : e.id,
        icon: (
          <span
            className="epic-glyph"
            style={{ "--epic": epicColor(e) } as React.CSSProperties}
            aria-hidden="true"
          />
        ),
      })),
    { value: "", label: "No epic" },
  ];
}

const opText = (condition: ViewCondition) =>
  condition.op === "is"
    ? condition.values.length > 1
      ? "is any of"
      : "is"
    : condition.values.length > 1
      ? "is none of"
      : "is not";

/** A readable sentence for a condition, e.g. "Status is any of Backlog, In review". */
export function conditionDescriber(
  context: FilterContext,
  people: ReturnType<typeof usePeople>,
) {
  return (condition: ViewCondition) =>
    `${fieldTitles[condition.field]} ${opText(condition)} ${condition.values
      .map((value) => valueLabel(condition.field, value, context, people))
      .join(", ")}`;
}

type Picking =
  | null
  | { step: "field" }
  | { step: "values"; field: ViewField; index: number; values: string[] };

/**
 * Linear-style filter chips. Every chip is one condition; all of them must
 * hold. Click the operator to flip is / is not; click the values to edit.
 */
export function FilterBar({
  conditions,
  context,
  onChange,
}: {
  conditions: ViewCondition[];
  context: FilterContext;
  onChange: (conditions: ViewCondition[]) => void;
}) {
  const people = usePeople();
  const [picking, setPicking] = useState<Picking>(null);
  const label = (field: ViewField, value: string) =>
    valueLabel(field, value, context, people);

  function commit() {
    if (picking?.step !== "values") return setPicking(null);
    const { field, index, values } = picking;
    const next = [...conditions];
    if (!values.length) {
      if (index >= 0) next.splice(index, 1);
    } else if (index >= 0) next[index] = { ...next[index], values };
    else next.push({ field, op: "is", values });
    onChange(next);
    setPicking(null);
  }

  return (
    <div className="filter-bar" role="group" aria-label="Filters">
      {conditions.map((condition, index) => {
        const field = fieldTitles[condition.field];
        const values = condition.values.map((v) => label(condition.field, v));
        return (
          <span
            className="filter-chip"
            key={`${condition.field}-${index}`}
            role="group"
            aria-label={`${field} filter`}
          >
            <span className="filter-chip-field">{field}</span>
            <button
              type="button"
              className="filter-chip-op"
              title="Switch between is and is not"
              aria-label={`${field} ${opText(condition)}. Switch to ${condition.op === "is" ? "is not" : "is"}`}
              onClick={() =>
                onChange(
                  conditions.map((c, i) =>
                    i === index
                      ? { ...c, op: c.op === "is" ? "is_not" : "is" }
                      : c,
                  ),
                )
              }
            >
              {opText(condition)}
            </button>
            <button
              type="button"
              className="filter-chip-values"
              aria-haspopup="dialog"
              aria-label={`${field}: ${values.join(", ")}. Change values`}
              title={values.join(", ")}
              onClick={() =>
                setPicking({
                  step: "values",
                  field: condition.field,
                  index,
                  values: condition.values,
                })
              }
            >
              {values.length > 2
                ? `${values.length} ${condition.field === "status" ? "statuses" : condition.field === "priority" ? "priorities" : condition.field === "assignee" ? "people" : condition.field === "label" ? "labels" : "epics"}`
                : values.join(", ")}
            </button>
            <button
              type="button"
              className="filter-chip-remove"
              aria-label={`Remove ${field} filter`}
              title="Remove filter"
              onClick={() => onChange(conditions.filter((_, i) => i !== index))}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        );
      })}
      <button
        type="button"
        className="secondary small-button filter-add"
        aria-haspopup="dialog"
        disabled={conditions.length >= 20}
        onClick={() => setPicking({ step: "field" })}
      >
        <Icon name="filter" size={14} />
        {conditions.length ? <span className="sr-only">Add filter</span> : "Filter"}
      </button>
      {picking?.step === "field" && (
        <SearchableChoiceDialog
          title="Add filter"
          searchLabel="Filter by…"
          options={(Object.keys(fieldTitles) as ViewField[]).map((field) => ({
            value: field,
            label: fieldTitles[field],
          }))}
          selected={[]}
          onSelect={(field) =>
            setPicking({
              step: "values",
              field: field as ViewField,
              index: -1,
              values: [],
            })
          }
          onToggle={() => {}}
          onClose={() => setPicking(null)}
        />
      )}
      {picking?.step === "values" && (
        <SearchableChoiceDialog
          title={`${fieldTitles[picking.field]} filter`}
          searchLabel={`Search ${fieldTitles[picking.field].toLowerCase()}`}
          options={valueChoices(picking.field, context, people, picking.values)}
          selected={picking.values}
          multiple
          onSelect={() => {}}
          onToggle={(value) =>
            setPicking({
              ...picking,
              values: picking.values.includes(value)
                ? picking.values.filter((v) => v !== value)
                : [...picking.values, value],
            })
          }
          onClose={commit}
        />
      )}
    </div>
  );
}

const groupTitles: Record<ViewGroup, string> = {
  status: "Status",
  assignee: "Assignee",
  priority: "Priority",
  epic: "Epic",
  none: "No grouping",
};
const orderTitles: Record<ViewOrder, string> = {
  created: "Created",
  updated: "Last updated",
  priority: "Priority",
  title: "Title",
};

/** Grouping and ordering. The layout tabs sit beside it in the toolbar. */
export function DisplayOptions({
  display,
  onChange,
}: {
  display: ViewDisplay;
  onChange: (display: ViewDisplay) => void;
}) {
  return (
    <div className="display-options" role="group" aria-label="Display options">
      {display.layout === "list" && (
        <label className="display-option">
          <span>Group</span>
          <select
            aria-label="Group by"
            value={display.groupBy}
            onChange={(e) =>
              onChange({ ...display, groupBy: e.target.value as ViewGroup })
            }
          >
            {(Object.keys(groupTitles) as ViewGroup[]).map((id) => (
              <option key={id} value={id}>
                {groupTitles[id]}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="display-option">
        <span>Order</span>
        <select
          aria-label="Order by"
          value={display.orderBy}
          onChange={(e) =>
            onChange({ ...display, orderBy: e.target.value as ViewOrder })
          }
        >
          {(Object.keys(orderTitles) as ViewOrder[]).map((id) => (
            <option key={id} value={id}>
              {orderTitles[id]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export type TaskGroup = { key: string; label: React.ReactNode; tasks: Task[] };

/**
 * List sections for a grouping. Tasks keep their incoming order inside a
 * group. Empty status and priority groups are left out.
 */
export function groupTasks(
  tasks: Task[],
  groupBy: ViewGroup,
  context: { epics: ReadonlyMap<string, Epic>; name: (id: string) => string },
): TaskGroup[] | undefined {
  if (groupBy === "none") return undefined;
  const buckets = new Map<string, Task[]>();
  const keyOf = (t: Task) =>
    groupBy === "status"
      ? t.status
      : groupBy === "priority"
        ? t.priority
        : groupBy === "assignee"
          ? t.assignee
          : t.epic;
  for (const t of tasks) {
    const key = keyOf(t);
    buckets.set(key, [...(buckets.get(key) ?? []), t]);
  }
  const order =
    groupBy === "status"
      ? columns.map((c) => c.id as string)
      : groupBy === "priority"
        ? ["high", "medium", "low"]
        : groupBy === "assignee"
          ? [...buckets.keys()]
              .filter(Boolean)
              .sort((a, b) => context.name(a).localeCompare(context.name(b)))
              .concat("")
          : [...context.epics.keys()].concat("");
  return order
    .filter((key) => buckets.has(key))
    .map((key) => ({
      key: key || "none",
      tasks: buckets.get(key)!,
      label:
        groupBy === "status" ? (
          <>
            <StatusIcon status={key as Status} /> {statusTitle(key as Status)}
          </>
        ) : groupBy === "priority" ? (
          `${priorities.find((p) => p.id === key)?.title} priority`
        ) : groupBy === "assignee" ? (
          key ? context.name(key) : "Unassigned"
        ) : key ? (
          (context.epics.get(key)?.title ?? "Unavailable epic")
        ) : (
          "No epic"
        ),
    }));
}

/** The glyph for a view: stacked layers tinted with its colour. */
export function ViewGlyph({
  view,
  size = 16,
}: {
  view: Pick<SavedView, "color">;
  size?: number;
}) {
  return (
    <span
      className="view-glyph"
      style={{ "--epic": epicColor(view) } as React.CSSProperties}
      aria-hidden="true"
    >
      <Icon name="layers" size={size} />
    </span>
  );
}

export function FavoriteButton({
  view,
  busy,
  onToggle,
}: {
  view: SavedView;
  busy?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`icon-button favorite-toggle ${view.favorite ? "is-favorite" : ""}`}
      aria-pressed={view.favorite}
      aria-label={`Favorite ${view.name}`}
      title={view.favorite ? "Remove from favorites" : "Add to favorites"}
      disabled={busy}
      onClick={onToggle}
    >
      <Icon name="star" size={16} />
    </button>
  );
}

/** The Views page: workspace views, then the reader's personal views. */
export function ViewsPage({
  views,
  me,
  count,
  describe,
  canManage,
  onOpen,
  onNew,
  onFavorite,
}: {
  views: SavedView[];
  me: string;
  count: (view: SavedView) => number;
  describe: (condition: ViewCondition) => string;
  canManage: boolean;
  onOpen: (view: SavedView) => void;
  onNew: () => void;
  onFavorite: (view: SavedView) => void;
}) {
  const people = usePeople();
  const sections = [
    {
      id: "workspace",
      title: "Workspace views",
      hint: "Shared with everyone in the workspace.",
      views: views.filter((v) => v.shared),
    },
    {
      id: "personal",
      title: "My views",
      hint: "Only you can see these.",
      views: views.filter((v) => !v.shared && v.owner === me),
    },
  ];
  return (
    <div className="views-page">
      <div className="toolbar epics-toolbar">
        <p className="result-summary" role="status">
          {views.length} {views.length === 1 ? "view" : "views"}
        </p>
        {canManage && (
          <button type="button" className="primary" onClick={onNew}>
            <Icon name="plus" size={16} /> New view
          </button>
        )}
      </div>
      {views.length === 0 ? (
        <div className="empty-state">
          <h2>No views yet.</h2>
          <p>
            A view saves filters and display settings under a name, so a list
            like “High priority bugs” or “Waiting for my review” is one click
            away. Filter any board, then choose Save as view.
          </p>
          {canManage && (
            <button type="button" className="primary" onClick={onNew}>
              <Icon name="plus" size={16} /> Create the first view
            </button>
          )}
        </div>
      ) : (
        sections.map(
          (section) =>
            section.views.length > 0 && (
              <section
                key={section.id}
                className="views-section"
                aria-labelledby={`views-${section.id}`}
              >
                <h2 id={`views-${section.id}`} className="section-title">
                  {section.title}
                </h2>
                <p className="small">{section.hint}</p>
                <ul className="view-rows">
                  {section.views.map((view) => {
                    const summary =
                      plainText(view.description) ||
                      [
                        ...(view.filters.query
                          ? [`Search “${view.filters.query}”`]
                          : []),
                        ...view.filters.conditions.map(describe),
                      ].join(" · ") ||
                      "All active tasks";
                    return (
                      <li key={view.id} className="view-row">
                        {canManage && (
                          <FavoriteButton
                            view={view}
                            onToggle={() => onFavorite(view)}
                          />
                        )}
                        <ViewGlyph view={view} />
                        <span className="view-row-copy">
                          <button
                            type="button"
                            className="view-row-open"
                            onClick={() => onOpen(view)}
                          >
                            {view.name}
                          </button>
                          <span className="view-row-summary">{summary}</span>
                        </span>
                        <span className="view-row-meta">
                          <span>
                            {view.display.layout === "list" ? "List" : "Board"}
                          </span>
                          <span className="view-row-count">
                            {count(view)} tasks
                          </span>
                          <span
                            className="view-row-owner"
                            title={`Owner: ${displayName(people, view.owner)}`}
                          >
                            <Avatar name={view.owner} agent={false} />
                            <span className="sr-only">
                              Owner: {displayName(people, view.owner)}
                            </span>
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ),
        )
      )}
    </div>
  );
}

/** The subtitle line of an open view: who can see it, who owns it, which board it counts. */
export function ViewMeta({
  view,
  boardName,
}: {
  view: SavedView;
  boardName: string;
}) {
  const people = usePeople();
  return (
    <p className="view-meta">
      <span className="view-scope">
        <Icon name={view.shared ? "users" : "lock"} size={13} />
        {view.shared ? "Workspace view" : "Personal view"}
      </span>
      <span>Owner: {displayName(people, view.owner)}</span>
      <span>Counts for {boardName}</span>
    </p>
  );
}

/** The description and unsaved-changes bar under an open view's heading. */
export function ViewSummary({
  view,
  dirty,
  canManage,
  saving,
  error,
  onSave,
  onSaveAs,
  onReset,
}: {
  view: SavedView;
  dirty: boolean;
  canManage: boolean;
  saving: boolean;
  error: ApiError | null;
  onSave: () => void;
  onSaveAs: () => void;
  onReset: () => void;
}) {
  const description = view.description.trim();
  if (!description && !(dirty && canManage)) return null;
  return (
    <div className="epic-summary view-summary">
      {description && (
        <Markdown source={view.description} className="epic-description" />
      )}
      {dirty && canManage && (
        <div className="view-dirty" role="region" aria-label="Unsaved view changes">
          <Icon name="info" size={15} />
          <span>
            {error?.code === "VERSION_CONFLICT"
              ? "Someone changed this view after you opened it, so your changes were not saved. Reset to see their version, or save yours as a new view."
              : "You changed this view's filters or display. Save them for everyone who uses it, or reset."}
          </span>
          <button
            type="button"
            className="quiet"
            disabled={saving}
            onClick={onReset}
          >
            Reset
          </button>
          <button
            type="button"
            className="secondary small-button"
            disabled={saving}
            onClick={onSaveAs}
          >
            Save as new view
          </button>
          <button
            type="button"
            className="primary small-button"
            disabled={saving || error?.code === "VERSION_CONFLICT"}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save view"}
          </button>
        </div>
      )}
      {error && error.code !== "VERSION_CONFLICT" && (
        <ErrorNote error={error} kept="Your changes are still here." />
      )}
    </div>
  );
}

const viewErrors: Record<string, string> = {
  VERSION_CONFLICT:
    "This view changed after you opened it, so nothing was saved. Close this dialog and open the view again to see the latest version.",
  NOT_FOUND: "This view no longer exists. Nothing was saved.",
};

/**
 * Create a view from the current filters, or edit a view's name, colour,
 * description and visibility. Only people manage views; the server enforces it.
 */
export function ViewEditor({
  view,
  draft,
  me,
  suggestedColor,
  describe,
  onClose,
  onSaved,
  onDeleted,
}: {
  view: SavedView | null;
  /** Filters and display a new view starts with. */
  draft: { filters: ViewFilters; display: ViewDisplay };
  me: string;
  suggestedColor: string;
  describe: (condition: ViewCondition) => string;
  onClose: () => void;
  onSaved: (view: SavedView, created: boolean) => void;
  onDeleted: (view: SavedView) => void;
}) {
  const [name, setName] = useState(view?.name ?? "");
  const [description, setDescription] = useState(view?.description ?? "");
  const [color, setColor] = useState(view?.color ?? suggestedColor);
  const [shared, setShared] = useState(view?.shared ?? false);
  const [pending, setPending] = useState<null | "save" | "delete">(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [deleteStep, setDeleteStep] = useState(false);
  const [discard, setDiscard] = useState(false);
  const owner = !view || view.owner === me;
  const patch = {
    ...(name.trim() !== (view?.name ?? "") ? { name } : {}),
    ...(description !== (view?.description ?? "") ? { description } : {}),
    ...(color !== (view?.color ?? suggestedColor) ? { color } : {}),
    ...(shared !== (view?.shared ?? false) ? { shared } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  const filters = view?.filters ?? draft.filters;

  function requestClose() {
    if (pending) return;
    if (discard) setDiscard(false);
    else if (dirty) setDiscard(true);
    else onClose();
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!name.trim()) {
      setError(new ApiError("Give the view a name", "VALIDATION", 400));
      return;
    }
    if (view && !dirty) return onClose();
    setPending("save");
    setError(null);
    try {
      const saved = view
        ? await command<SavedView>("update_view", {
            id: view.id,
            expectedVersion: view.version,
            patch,
          })
        : await command<SavedView>("create_view", {
            name,
            description,
            color,
            shared,
            filters: draft.filters,
            display: draft.display,
          });
      onSaved(saved, !view);
    } catch (e) {
      setError(errorOf(e));
      setPending(null);
    }
  }

  async function remove() {
    if (!view || pending) return;
    setPending("delete");
    setError(null);
    try {
      await command("delete_view", {
        id: view.id,
        expectedVersion: view.version,
      });
      onDeleted(view);
    } catch (e) {
      setError(errorOf(e));
      setPending(null);
    }
  }

  const footer = discard ? (
    <div className="discard-bar" role="alertdialog" aria-label="Discard changes">
      <span>Discard your unsaved changes?</span>
      <span className="spacer" />
      <button
        type="button"
        className="secondary"
        autoFocus
        onClick={() => setDiscard(false)}
      >
        Keep editing
      </button>
      <button type="button" className="danger-button" onClick={onClose}>
        Discard
      </button>
    </div>
  ) : (
    <>
      {error &&
        (viewErrors[error.code] ? (
          <div className="inline-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{viewErrors[error.code]}</span>
          </div>
        ) : (
          <ErrorNote
            error={error}
            kept={pending === null && dirty ? "Your draft is still here." : ""}
            busy={Boolean(pending)}
          />
        ))}
      <div className="form-actions">
        <span className="spacer" />
        <button
          type="button"
          className="secondary"
          onClick={requestClose}
          disabled={Boolean(pending)}
        >
          Cancel
        </button>
        <button
          type="submit"
          form="view-form"
          className="primary"
          disabled={Boolean(pending)}
        >
          {pending === "save"
            ? "Saving…"
            : view
              ? "Save changes"
              : "Create view"}
        </button>
      </div>
    </>
  );

  return (
    <Dialog
      title={
        view ? (
          <>
            <span className="task-id">{view.id}</span> Edit view
          </>
        ) : (
          "Save as view"
        )
      }
      onClose={requestClose}
      closeDisabled={Boolean(pending)}
      footer={footer}
      className="epic-dialog view-dialog"
    >
      <form id="view-form" className="task-form" onSubmit={save} noValidate>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="title-input"
            data-autofocus=""
            required
            maxLength={80}
            placeholder="e.g. “High priority bugs”"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset className="field view-visibility">
          <legend className="field-label">Who can see it</legend>
          {(
            [
              [false, "Only me", "A personal view in your list."],
              [true, "Workspace", "Everyone sees it and can edit its filters."],
            ] as const
          ).map(([value, title, hint]) => (
            <label key={title} className="view-visibility-option">
              <input
                type="radio"
                name="view-visibility"
                checked={shared === value}
                disabled={!owner}
                onChange={() => setShared(value)}
              />
              <span>
                <strong>{title}</strong>
                <span className="small">{hint}</span>
              </span>
            </label>
          ))}
          {!owner && (
            <span className="field-hint">
              Only the owner can change who sees this view.
            </span>
          )}
        </fieldset>
        <ColorField
          value={color}
          title={name}
          name="view-color"
          onChange={setColor}
          preview={
            <span className="view-color-preview">
              <ViewGlyph view={{ color }} />
              {name.trim() || "View preview"}
            </span>
          }
        />
        <div className="field">
          <label className="field-label" htmlFor="view-description">
            Description
          </label>
          <MarkdownEditor
            id="view-description"
            rows={3}
            maxLength={20000}
            placeholder="What is this view for? (optional)"
            value={description}
            onChange={setDescription}
          />
        </div>
        <div className="field">
          <span className="field-label">Filters</span>
          <ul className="view-filter-summary">
            {filters.query && <li>Search “{filters.query}”</li>}
            {filters.conditions.map((condition, index) => (
              <li key={index}>{describe(condition)}</li>
            ))}
            {!filters.query && !filters.conditions.length && (
              <li>All active tasks</li>
            )}
          </ul>
          <span className="field-hint">
            {view
              ? "Change filters and display on the view itself, then save them."
              : "The view keeps these filters and the current layout, grouping and order."}
          </span>
        </div>
      </form>
      {view && (
        <section className="side-block epic-archive" aria-label="Delete">
          {!deleteStep ? (
            <button
              type="button"
              className="quiet danger"
              onClick={() => setDeleteStep(true)}
              disabled={Boolean(pending)}
            >
              <Icon name="archive" size={15} /> Delete view…
            </button>
          ) : (
            <div
              className="confirm-archive"
              role="group"
              aria-label="Confirm delete"
            >
              <p>
                Delete {view.name}?{" "}
                {view.shared
                  ? "It disappears for everyone in the workspace. "
                  : ""}
                Tasks are not changed. The deletion is recorded in the activity
                log.
              </p>
              <div className="review-actions">
                <button
                  type="button"
                  className="secondary"
                  autoFocus
                  disabled={pending === "delete"}
                  onClick={() => setDeleteStep(false)}
                >
                  Keep view
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={Boolean(pending)}
                  onClick={remove}
                >
                  {pending === "delete" ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </Dialog>
  );
}

/** The next palette colour for a new view. */
export const nextViewColor = (views: SavedView[]) =>
  epicPalette[(views.length + 3) % epicPalette.length].id;
