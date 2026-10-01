export function formatUtcTimestamp(value: string | number | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";

  const pad = (part: number) => String(part).padStart(2, "0");
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  return `${year}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** A short age such as "now", "5m", "3h" or "2w". */
export function relativeTime(value: string, now = Date.now()) {
  const seconds = Math.max(0, (now - Date.parse(value)) / 1000);
  if (seconds < 60) return "now";
  const steps: [number, string][] = [
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [4.35, "w"],
    [12, "mo"],
    [Infinity, "y"],
  ];
  let n = seconds / 60;
  for (const [size, unit] of steps) {
    if (n < size) return `${Math.floor(n)}${unit}`;
    n /= size;
  }
  return "";
}
