export type Client = {
  mode: "local" | "remote";
  target: string;
  execute(name: string, args?: object): Promise<any>;
  close(): Promise<void>;
};
export function connect(options?: {
  actor?: { id: string; kind: "human" | "agent"; role?: "architect" | "worker" };
  env?: Record<string, string | undefined>;
}): Client;
