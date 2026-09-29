import type { ZodType } from "zod";
export const schemas: Record<string, ZodType>;
export const epicColors: string[];
export type BoardId = `BOARD-${number}`;
export type Board = {
  id: BoardId;
  name: string;
  prefix: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
