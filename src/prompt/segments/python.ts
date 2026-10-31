import type { PythonConfig } from "../types";
import type { SegmentRenderer } from "./types";

export const renderPython: SegmentRenderer<PythonConfig> = (input, config) => {
  if (config.disabled) return undefined;
  const virtualenv = input.context.variables.get("VIRTUAL_ENV");
  if (!virtualenv) return undefined;
  const name = virtualenv.slice(virtualenv.lastIndexOf("/") + 1);
  const version = input.versions.python;
  return [
    { text: config.prefix },
    {
      text: `${config.symbol}${name}${version ? ` v${version}` : ""}${config.suffix}`,
      style: config.style,
    },
  ];
};
