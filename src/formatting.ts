export function formatUtcTimestamp(value: string | number | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";

  const pad = (part: number) => String(part).padStart(2, "0");
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  return `${year}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
