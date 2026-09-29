export type ViewField = "status" | "priority" | "assignee" | "label" | "epic";
export type ViewOp = "is" | "is_not";
export type ViewCondition = { field: ViewField; op: ViewOp; values: string[] };
export type ViewFilters = { query: string; conditions: ViewCondition[] };
export type ViewLayout = "board" | "list";
export type ViewGroup = "status" | "assignee" | "priority" | "epic" | "none";
export type ViewOrder = "created" | "updated" | "priority" | "title";
export type ViewDisplay = {
  layout: ViewLayout;
  groupBy: ViewGroup;
  orderBy: ViewOrder;
};
type Matchable = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee: string;
  labels: string[];
  epic: string;
  updatedAt: string;
};
export const viewFields: ViewField[];
export const viewOps: ViewOp[];
export const ME: "@me";
export const viewLayouts: ViewLayout[];
export const viewGroups: ViewGroup[];
export const viewOrders: ViewOrder[];
export function emptyFilters(): ViewFilters;
export function defaultDisplay(): ViewDisplay;
export function taskMatchesView(
  task: Matchable,
  filters: Partial<ViewFilters>,
  actorId: string,
): boolean;
export function sortTasks<T extends Matchable>(tasks: T[], orderBy: ViewOrder): T[];
