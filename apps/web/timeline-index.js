const EVENT_PRIORITY = new Map([
  ["error", 6],
  ["outcome", 5],
  ["tool-result", 4],
  ["tool", 3],
  ["spawn", 2],
]);

/** Builds the lane lookup once so rendering remains O(agents + events). */
export function indexTimelineBySession(timeline = []) {
  const indexed = new Map();
  for (const event of timeline) {
    const events = indexed.get(event.session_id) ?? [];
    events.push(event);
    indexed.set(event.session_id, events);
  }
  return indexed;
}

/**
 * Collapses only markers that would occupy the same horizontal pixel bucket.
 * The full event list remains in the snapshot and inspector; each marker keeps
 * the most significant event plus the number and time range it represents.
 */
export function compactTimelineMarkers(events, start, span, maxMarkers) {
  if (!Number.isSafeInteger(maxMarkers) || maxMarkers <= 0 || events.length <= maxMarkers) {
    return events.map((event) => ({ event, count: 1, from: event.at, to: event.at }));
  }
  const buckets = new Map();
  for (const event of events) {
    const timestamp = Date.parse(event.at);
    const ratio = Number.isFinite(timestamp) ? (timestamp - start) / Math.max(1, span) : 0;
    const bucket = Math.min(maxMarkers - 1, Math.max(0, Math.floor(ratio * maxMarkers)));
    const current = buckets.get(bucket);
    if (!current) {
      buckets.set(bucket, { event, count: 1, from: event.at, to: event.at });
      continue;
    }
    current.count += 1;
    if (Date.parse(event.at) < Date.parse(current.from)) current.from = event.at;
    if (Date.parse(event.at) > Date.parse(current.to)) current.to = event.at;
    if (eventPriority(event) >= eventPriority(current.event)) current.event = event;
  }
  return [...buckets.values()].sort((left, right) => Date.parse(left.event.at) - Date.parse(right.event.at));
}

function eventPriority(event) {
  const base = EVENT_PRIORITY.get(event.kind) ?? 1;
  return event.outcome === "failed" ? base + 10 : base;
}
