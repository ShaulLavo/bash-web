import type { PackageConfig } from "../types";
import type { SegmentRenderer } from "./types";

export const renderPackage: SegmentRenderer<PackageConfig> = (input, config) => {
  if (
    config.disabled ||
    !input.manifest?.version ||
    (input.manifest.private && !config.showPrivate)
  )
    return undefined;
  return [
    { text: config.prefix },
    { text: `${config.symbol}v${input.manifest.version}`, style: config.style },
    { text: config.suffix },
  ];
};
