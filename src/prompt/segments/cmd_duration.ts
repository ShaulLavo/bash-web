import type { CmdDurationConfig } from "../types";
import type { SegmentRenderer } from "./types";

export const renderCmdDuration: SegmentRenderer<CmdDurationConfig> = (input, config) => {
  const duration = input.context.durationMs;
  if (config.disabled || duration === undefined || duration < config.minTimeMs) return undefined;
  return [
    { text: config.prefix },
    { text: `${Math.floor(duration / 1000)}s`, style: config.style },
    { text: config.suffix },
  ];
};
