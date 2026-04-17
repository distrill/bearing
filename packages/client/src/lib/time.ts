const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const WEEK = DAY * 7;
const MONTH = DAY * 30;
const YEAR = DAY * 365;

export function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 1000,
  );

  if (seconds < MINUTE) return "just now";
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return `${m}m`;
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return `${h}h`;
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return `${d}d`;
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return `${w}w`;
  }
  if (seconds < YEAR) {
    const m = Math.floor(seconds / MONTH);
    return `${m}mo`;
  }
  const y = Math.floor(seconds / YEAR);
  const remaining = Math.floor((seconds - y * YEAR) / MONTH);
  return remaining > 0 ? `${y}y ${remaining}mo` : `${y}y`;
}
