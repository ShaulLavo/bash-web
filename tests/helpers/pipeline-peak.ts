import type { runtimeSnapshot } from "../../src/runtime/diagnostics";

export type ProcessRoot = ReturnType<typeof runtimeSnapshot>["roots"][number];

export function pipelinePeak(peak: ProcessRoot, sample: ProcessRoot): ProcessRoot {
  if (sample.retainedSlots < peak.retainedSlots) return peak;
  if (sample.retainedSlots === peak.retainedSlots && sample.records.length <= peak.records.length)
    return peak;
  return sample;
}
