const pad = (value) => String(value).padStart(2, '0');

// "YYYY-MM-DD HH:mm:ss" in UTC for a time in ms (the config pins the browser's timezone to UTC): the form of the
// from and to parameters of the Observability pages.
export function stamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// "2026-09-19 12:00:00.010000000" for an offset in ms from baseMs: a DateTime64(9) text, exact to the nanosecond.
export function stampNs(baseMs, offsetMs) {
  const totalNs = BigInt(baseMs) * 1000000n + BigInt(Math.round(offsetMs * 1e6));
  const iso = new Date(Number(totalNs / 1000000n)).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${String(totalNs % 1000000000n).padStart(9, '0')}`;
}
