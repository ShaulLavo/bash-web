import type { EnvVarConfig } from "../types";
import type { SegmentRenderer } from "./types";

export const renderEnvVar: SegmentRenderer<EnvVarConfig> = (input, config) => {
  if (config.disabled || !config.variable) return undefined;
  const value = input.context.variables.get(config.variable) ?? config.default;
  if (!value) return undefined;
  return [{ text: `${config.prefix}${value}${config.suffix}`, style: config.style }];
};
