export type Client = {
  mode: "local" | "remote";
  target: string;
  execute(name: string, args?: object): Promise<any>;
  close(): void;
};
export function connect(options?: {
  actor?: { id: string; kind: "human" | "agent" };
  env?: Record<string, string | undefined>;
}): Client;
