import type { StatusConfig } from "../types";
import type { SegmentRenderer } from "./types";

export const renderStatus: SegmentRenderer<StatusConfig> = (input, config) => {
  if (config.disabled || input.context.status === 0) return undefined;
  return [{ text: `${config.prefix}${input.context.status}${config.suffix}`, style: config.style }];
};
