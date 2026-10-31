import type { BunConfig } from "../types";
import type { SegmentRenderer } from "./types";

export const renderBun: SegmentRenderer<BunConfig> = (input, config) => {
  if (
    config.disabled ||
    (!input.directory?.names.has("bun.lock") && !input.directory?.names.has("bun.lockb"))
  )
    return undefined;
  const version = input.versions.bun;
  return [
    { text: config.prefix },
    {
      text: `${config.symbol}${version ? `v${version}` : ""}${config.suffix}`,
      style: config.style,
    },
  ];
};
