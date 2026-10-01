import type { ZodType } from "zod";
export const schemas: Record<string, ZodType>;
export const epicColors: string[];
export type BoardId = `BOARD-${number}`;
export type LaneRole = "todo" | "in_progress" | "in_review" | "done";
export const laneRoles: LaneRole[];
export const laneLimit: number;
export type Lane = {
  id: `LANE-${number}`;
  name: string;
  role: LaneRole;
  /** Non-archived tasks in the lane. Derived on every read, not exported. */
  tasks: number;
  /** Archived tasks in the lane. Derived on every read, not exported. */
  archivedTasks: number;
};
export type Board = {
  id: BoardId;
  name: string;
  prefix: string;
  /** Absolute folder where assigned agents start work; "" means none. */
  repository: string;
  /** Retired prefixes whose task keys still resolve on this board. */
  formerPrefixes: string[];
  /** Whether the caller lists this board in the sidebar. Each person sets it. */
  inSidebar: boolean;
  /** The board's lanes in column order. */
  lanes: Lane[];
  /** Non-archived tasks in lanes with role in_progress. */
  inProgress: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};
