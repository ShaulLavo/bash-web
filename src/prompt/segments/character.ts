import type { CharacterConfig } from "../types";
import type { SegmentRenderer } from "./types";

export const renderCharacter: SegmentRenderer<CharacterConfig> = (input, config) => {
  if (config.disabled) return undefined;
  const failed = input.context.status !== 0;
  return [
    {
      text: failed ? config.errorSymbol : config.successSymbol,
      style: failed ? config.errorStyle : config.successStyle,
    },
    { text: " " },
  ];
};
