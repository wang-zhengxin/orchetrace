const TERMINAL_KINDS = new Set(["outcome", "error"]);

export function timelineBounds(snapshot) {
  const values = [];
  collectTime(values, snapshot?.started_at);
  collectTime(values, snapshot?.last_activity_at);
  for (const item of snapshot?.timeline ?? []) collectTime(values, item.at);
  for (const agent of snapshot?.agents ?? []) {
    collectTime(values, agent.started_at);
    collectTime(values, agent.last_activity_at);
    for (const activation of agent.activations ?? []) {
      collectTime(values, activation.started_at);
      collectTime(values, activation.ended_at);
    }
    for (const tool of agent.tools ?? []) {
      collectTime(values, tool.started_at);
      collectTime(values, tool.ended_at);
    }
  }
  if (values.length === 0) return { start: 0, end: 1, span: 1 };
  const start = Math.min(...values);
  const end = Math.max(...values);
  return { start, end, span: Math.max(1, end - start) };
}

export function snapshotAtTime(snapshot, requestedCursor) {
  if (!snapshot) return null;
  const bounds = timelineBounds(snapshot);
  const cursor = clamp(Number(requestedCursor), bounds.start, bounds.end);
  const timeline = (snapshot.timeline ?? []).filter((item) => at(item.at) <= cursor);
  const eventsByAgent = new Map();
  for (const item of timeline) {
    const items = eventsByAgent.get(item.session_id) ?? [];
    items.push(item);
    eventsByAgent.set(item.session_id, items);
  }

  const agents = (snapshot.agents ?? [])
    .filter((agent) => {
      const started = at(agent.started_at);
      return agent.id === snapshot.root_session_id || !Number.isFinite(started) || started <= cursor;
    })
    .map((agent) => agentAtTime(agent, eventsByAgent.get(agent.id) ?? [], cursor, bounds.end));
  populateSubtreeTokenUsage(agents);
  const visible = new Set(agents.map((agent) => agent.id));

  return {
    ...snapshot,
    last_activity_at: new Date(cursor).toISOString(),
    observed_event_count: timeline.length,
    agents,
    edges: (snapshot.edges ?? []).filter(
      (edge) => visible.has(edge.parent_id) && visible.has(edge.child_id),
    ),
    timeline,
  };
}

export function populateSubtreeTokenUsage(agents) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  for (const agent of agents) agent.subtree_token_usage = { ...emptyTokenUsage(), ...agent.token_usage };
  for (let index = agents.length - 1; index >= 0; index -= 1) {
    const agent = agents[index];
    const parent = agent.parent_id ? byId.get(agent.parent_id) : null;
    if (parent) parent.subtree_token_usage = mergeTokenUsage(parent.subtree_token_usage, agent.subtree_token_usage);
  }
  return agents;
}

export function agentEventsAtTime(snapshot, agentId, requestedCursor) {
  if (!snapshot) return [];
  const bounds = timelineBounds(snapshot);
  const cursor = clamp(Number(requestedCursor), bounds.start, bounds.end);
  const agent = snapshot.agents?.find((item) => item.id === agentId);
  if (!agent) return [];
  const tools = agent.tools ?? [];

  return (snapshot.timeline ?? [])
    .filter((item) => item.session_id === agentId && at(item.at) <= cursor)
    .map((item) => {
      const tool = item.kind.startsWith("tool")
        ? closestTool(tools, item.label, item.at)
        : null;
      return {
        ...item,
        input_summary: item.kind === "tool" ? tool?.input_summary ?? null : null,
        output_summary: item.kind === "tool-result" ? tool?.output_summary ?? null : null,
        duration_ms: item.kind === "tool-result" ? tool?.duration_ms ?? null : null,
      };
    });
}

function agentAtTime(agent, events, cursor, runEnd) {
  const activations = (agent.activations ?? [])
    .filter((activation) => at(activation.started_at) <= cursor)
    .map((activation) => {
      if (at(activation.ended_at) <= cursor) return { ...activation };
      return { ...activation, ended_at: null, end_status: null };
    });
  const tools = (agent.tools ?? [])
    .filter((tool) => {
      const started = at(tool.started_at ?? tool.ended_at ?? agent.started_at);
      return !Number.isFinite(started) || started <= cursor;
    })
    .map((tool) => {
      if (at(tool.ended_at) <= cursor) return { ...tool };
      return { ...tool, ended_at: null, outcome: null, duration_ms: null, output_summary: null };
    });
  const activeTool = [...tools].reverse().find((tool) => !tool.ended_at);
  const activeActivation = [...activations].reverse().find((activation) => !activation.ended_at);
  const outcomeEvent = [...events].reverse().find((item) => TERMINAL_KINDS.has(item.kind));
  const settled = cursor >= runEnd || at(agent.last_activity_at) <= cursor;
  const tokenUsage = settled
    ? agent.token_usage ?? emptyTokenUsage()
    : events.reduce((total, item) => mergeTokenUsage(total, item.token_usage), emptyTokenUsage());
  const lastActivation = activations.at(-1);
  let status = "unknown";

  if (activeTool || activeActivation) status = "running";
  else if (lastActivation?.ended_at) status = lastActivation.end_status ?? "inactive";
  else if (events.some((item) => item.kind === "spawn")) status = "ready";
  else if (events.some((item) => ["prompt", "turn", "message", "tool", "tool-result"].includes(item.kind))) status = "running";
  else if (settled) status = agent.status;

  const activityTimes = [agent.started_at, ...events.map((item) => item.at)];
  for (const activation of activations) activityTimes.push(activation.started_at, activation.ended_at);
  for (const tool of tools) activityTimes.push(tool.started_at, tool.ended_at);
  const lastActivity = Math.max(
    ...activityTimes.map(at).filter(Number.isFinite),
    at(agent.started_at),
  );

  return {
    ...agent,
    status,
    outcome: outcomeEvent?.outcome ?? (settled ? agent.outcome : null),
    outcome_evidence: outcomeEvent ? agent.outcome_evidence : settled ? agent.outcome_evidence : null,
    current_tool: activeTool?.name ?? null,
    tool_count: tools.length,
    failed_tool_count: tools.filter((tool) => tool.outcome === "failed").length,
    token_usage: tokenUsage,
    last_activity_at: Number.isFinite(lastActivity)
      ? new Date(activeTool || activeActivation ? cursor : Math.min(lastActivity, cursor)).toISOString()
      : agent.started_at,
    activations,
    tools,
  };
}

function emptyTokenUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    reports: 0,
  };
}

function mergeTokenUsage(total, usage) {
  if (!usage) return total;
  for (const key of Object.keys(total)) {
    total[key] += Number(usage[key]) || 0;
  }
  return total;
}

function closestTool(tools, name, eventTime) {
  const target = at(eventTime);
  return tools
    .filter((tool) => tool.name === name)
    .map((tool) => ({
      tool,
      distance: Math.min(
        Math.abs(at(tool.started_at) - target),
        Math.abs(at(tool.ended_at) - target),
      ),
    }))
    .sort((left, right) => left.distance - right.distance)[0]?.tool;
}

function collectTime(values, value) {
  const parsed = at(value);
  if (Number.isFinite(parsed)) values.push(parsed);
}

function at(value) {
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return max;
  return Math.min(max, Math.max(min, value));
}
