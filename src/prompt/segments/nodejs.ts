import type { NodejsConfig } from "../types";
import type { SegmentRenderer } from "./types";

export const renderNodejs: SegmentRenderer<NodejsConfig> = (input, config) => {
  if (
    config.disabled ||
    input.directory?.names.has("bun.lock") ||
    input.directory?.names.has("bun.lockb") ||
    !input.manifest
  )
    return undefined;
  const version = input.versions.node;
  return [
    { text: config.prefix },
    {
      text: `${config.symbol}${version ? `v${version}` : ""}${config.suffix}`,
      style: config.style,
    },
  ];
};
