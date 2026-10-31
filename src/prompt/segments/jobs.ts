import type { JobsConfig } from "../types";
import type { SegmentRenderer } from "./types";

export const renderJobs: SegmentRenderer<JobsConfig> = (input, config) => {
  if (config.disabled || input.context.jobs < config.threshold) return undefined;
  return [
    { text: `${config.symbol}${input.context.jobs}`, style: config.style },
    { text: config.suffix },
  ];
};
