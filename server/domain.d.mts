import type { ZodType } from "zod";
export const schemas: Record<string, ZodType>;
export const epicColors: string[];
export type BoardId = `BOARD-${number}`;
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
  /** Active tasks In progress on this board. */
  inProgress: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};
