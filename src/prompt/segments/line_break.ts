import type { LineBreakConfig } from "../types";
import type { SegmentRenderer } from "./types";

export const renderLineBreak: SegmentRenderer<LineBreakConfig> = (_input, config) =>
  config.disabled ? undefined : [{ text: "\n" }];
