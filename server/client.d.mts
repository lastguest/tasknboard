export type Client = {
  mode: "local" | "remote";
  target: string;
  execute(name: string, args?: object): Promise<any>;
  subscribe(listener: () => void): () => void;
  close(): void;
};
export function connect(options?: {
  actor?: { id: string; kind: "human" | "agent"; role?: "architect" | "worker" };
  env?: Record<string, string | undefined>;
}): Client;
