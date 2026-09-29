import type { ZodType } from "zod";
export const schemas: Record<string, ZodType>;
export const epicColors: string[];
export type BoardId = `BOARD-${number}`;
export type Board = {
  id: BoardId;
  name: string;
  prefix: string;
  /** Retired prefixes whose task keys still resolve on this board. */
  formerPrefixes: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};
