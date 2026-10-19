// Read-only selection rules. Date filtering happens in SQLite before pagination.
export const HISTORY_PAGE_SIZE = 20;
export type HistoryQuery = {
  day?: string;
  region?: string;
  resolvedOnly?: boolean;
};
export function historyPage(value: unknown): number {
  return typeof value === 'string' && /^[1-9]\d{0,5}$/.test(value)
    ? Number(value)
    : 1;
}
export function chinaDayRange(day: string): [string, string] {
  const start = Date.parse(`${day}T00:00:00+08:00`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(start) ||
    new Date(start + 8 * 3600000).toISOString().slice(0, 10) !== day
  )
    throw new Error('invalid_history_date');
  return [
    new Date(start).toISOString(),
    new Date(start + 86400000).toISOString(),
  ];
}
export function predictionSelection(query: HistoryQuery = {}) {
  const clauses = ["p.source LIKE 'system%'"];
  const values: string[] = [];
  if (query.resolvedOnly) clauses.push("p.status='resolved'");
  if (query.day) {
    clauses.push(
      'datetime(p.scheduled_at)>=datetime(?)',
      'datetime(p.scheduled_at)<datetime(?)',
    );
    values.push(...chinaDayRange(query.day));
  }
  if (query.region) {
    if (
      !['CN', 'EMEA', 'AMERICAS', 'PACIFIC', 'INTERNATIONAL'].includes(
        query.region,
      )
    )
      throw new Error('invalid_history_region');
    clauses.push('p.region=?');
    values.push(query.region);
  }
  return { where: clauses.join(' AND '), values };
}
