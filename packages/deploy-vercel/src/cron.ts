const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 6 },
] as const;

function checkValue(text: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(text)) {
    return false;
  }
  const value = Number(text);
  return value >= min && value <= max;
}

function checkPart(part: string, min: number, max: number): boolean {
  const slash = part.indexOf('/');
  const range = slash === -1 ? part : part.slice(0, slash);
  if (slash !== -1) {
    const step = part.slice(slash + 1);
    if (!/^\d+$/.test(step) || Number(step) === 0) {
      return false;
    }
  }
  if (range === '*') {
    return true;
  }
  const dash = range.indexOf('-');
  if (dash === -1) {
    return checkValue(range, min, max);
  }
  const from = range.slice(0, dash);
  const to = range.slice(dash + 1);
  return checkValue(from, min, max) && checkValue(to, min, max) && Number(from) <= Number(to);
}

/**
 * Why Vercel Cron Jobs would reject an expression, or undefined when it accepts it.
 * Vercel takes five numeric fields with `*`, `,`, `-` and `/`; day of week runs
 * 0-6 from Sunday. It has no names such as `MON` or `JAN`, and day of month and
 * day of week cannot both be set.
 */
export function vercelCronError(expression: string): string | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== FIELDS.length) {
    return `expected 5 fields (minute, hour, day of month, month, day of week), got ${fields.length}`;
  }
  for (let i = 0; i < FIELDS.length; i++) {
    const { name, min, max } = FIELDS[i]!;
    const field = fields[i]!;
    if (!field.split(',').every((part) => checkPart(part, min, max))) {
      return `invalid ${name} "${field}": use numbers from ${min} to ${max} with *, ",", "-" or "/"`;
    }
  }
  if (fields[2] !== '*' && fields[4] !== '*') {
    return 'day of month and day of week cannot both be set; use * for one of them';
  }
  return undefined;
}
