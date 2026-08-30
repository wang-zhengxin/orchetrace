import { GENERATED_RUNTIME_DESCRIPTORS } from "./generated-runtime-registry.js";

const REGISTERED = GENERATED_RUNTIME_DESCRIPTORS.map((descriptor) => Object.freeze({
  ...descriptor,
  sessions: descriptor.sessionDirectory,
}));
const DESCRIPTORS = new Map();
for (const descriptor of REGISTERED) {
  DESCRIPTORS.set(descriptor.id, descriptor);
  for (const alias of descriptor.aliases) DESCRIPTORS.set(alias, descriptor);
}

export function runtimeDescriptor(runtime) {
  if (DESCRIPTORS.has(runtime)) return DESCRIPTORS.get(runtime);
  const label = String(runtime ?? "unknown").replace(/[-_]+/g, " ").trim().toUpperCase() || "UNKNOWN";
  return {
    id: runtime,
    label,
    shortLabel: label.slice(0, 12),
    accent: "#8f9490",
    aliases: [],
    sessions: "—",
    sessionDirectory: "—",
    capabilities: [],
    observer: null,
  };
}

export function registeredRuntimeDescriptors() {
  return [...REGISTERED];
}
