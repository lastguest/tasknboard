export type ViewField = "role" | "lane" | "priority" | "assignee" | "label" | "epic" | "delegated";
export type ViewOp = "is" | "is_not";
export type ViewCondition = { field: ViewField; op: ViewOp; values: string[] };
export type ViewFilters = { query: string; conditions: ViewCondition[] };
export type ViewLayout = "board" | "list";
export type ViewGroup = "lane" | "assignee" | "priority" | "epic" | "none";
export type ViewOrder = "created" | "updated" | "priority" | "title" | "position";
export type ViewDisplay = {
  layout: ViewLayout;
  groupBy: ViewGroup;
  orderBy: ViewOrder;
};
type Matchable = {
  id: string;
  title: string;
  description: string;
  lane: string;
  role: string;
  priority: string;
  assignee: string;
  labels: string[];
  epic: string;
  updatedAt: string;
  position?: number;
  delegatedTo?: string;
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
