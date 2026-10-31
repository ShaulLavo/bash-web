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
  const root = input.repository?.root;
  if (root && (absolute === root || absolute.startsWith(`${root}/`))) {
    const relative = absolute.slice(root.lastIndexOf("/") + 1);
    return [{ text: shorten(relative, config), style: config.style }, { text: config.suffix }];
  }
  const display =
    home && (absolute === home || absolute.startsWith(`${home}/`))
      ? `${config.homeSymbol}${absolute.slice(home.length)}`
      : absolute;
  return [{ text: shorten(display, config), style: config.style }, { text: config.suffix }];
};
