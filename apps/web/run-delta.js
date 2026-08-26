export function applyRunSnapshotDelta(snapshot, delta) {
  if (
    !snapshot ||
    !delta ||
    delta.schema_version !== 1 ||
    delta.base_event_count !== snapshot.event_count ||
    !Number.isSafeInteger(delta.target_event_count) ||
    !Array.isArray(snapshot.agents) ||
    !Array.isArray(snapshot.edges) ||
    !Array.isArray(snapshot.timeline) ||
    !Array.isArray(delta.upserted_agents) ||
    !Array.isArray(delta.removed_agent_ids)
  ) {
    return null;
  }

  const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  for (const agentId of delta.removed_agent_ids) {
    if (typeof agentId !== "string") return null;
    agents.delete(agentId);
  }
  for (const agent of delta.upserted_agents) {
    if (!agent || typeof agent.id !== "string") return null;
    agents.set(agent.id, agent);
  }

  let agentOrder;
  if (delta.agent_order == null) {
    agentOrder = snapshot.agents.map((agent) => agent.id).filter((agentId) => agents.has(agentId));
    for (const agent of delta.upserted_agents) {
      if (!agentOrder.includes(agent.id)) return null;
    }
  } else {
    if (!Array.isArray(delta.agent_order) || new Set(delta.agent_order).size !== agents.size) {
      return null;
    }
    agentOrder = delta.agent_order;
  }
  if (agentOrder.some((agentId) => !agents.has(agentId))) return null;

  let timeline = snapshot.timeline;
  if (delta.timeline != null) {
    const { replace_from: replaceFrom, entries } = delta.timeline;
    if (
      !Number.isSafeInteger(replaceFrom) ||
      replaceFrom < 0 ||
      replaceFrom > timeline.length ||
      !Array.isArray(entries)
    ) {
      return null;
    }
    timeline = [...timeline.slice(0, replaceFrom), ...entries];
  }

  if (delta.edges != null && !Array.isArray(delta.edges)) return null;
  return {
    ...snapshot,
    root_session_id: delta.root_session_id,
    runtimes: delta.runtimes,
    event_count: delta.target_event_count,
    started_at: delta.started_at,
    last_activity_at: delta.last_activity_at,
    agents: agentOrder.map((agentId) => agents.get(agentId)),
    edges: delta.edges ?? snapshot.edges,
    timeline,
  };
}
