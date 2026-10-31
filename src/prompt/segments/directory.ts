import type { DirectoryConfig } from "../types";
import type { SegmentRenderer } from "./types";

function shorten(path: string, config: DirectoryConfig): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= config.truncationLength) return path || "/";
  return `${config.truncationSymbol}${parts.slice(-config.truncationLength).join("/")}`;
}

export const renderDirectory: SegmentRenderer<DirectoryConfig> = (input, config) => {
  if (config.disabled) return undefined;
  const home = input.context.variables.get("HOME");
  const absolute = input.context.cwd;
  const display =
    home && (absolute === home || absolute.startsWith(`${home}/`))
      ? `${config.homeSymbol}${absolute.slice(home.length)}`
      : absolute;
  return [{ text: shorten(display, config), style: config.style }, { text: config.suffix }];
};
