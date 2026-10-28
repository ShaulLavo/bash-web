import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function noticeNames(directory) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  let names = entries
    .filter((entry) => entry.isFile() && /license|notice/i.test(entry.name))
    .map((entry) => entry.name);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^licenses$/i.test(entry.name)) continue;
    const children = await readdir(resolve(root, directory, entry.name), { withFileTypes: true });
    names = names.concat(
      children.filter((child) => child.isFile()).map((child) => `${entry.name}/${child.name}`),
    );
  }
  return names;
}

const root = resolve(import.meta.dirname, "..");
let text = await readFile(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
for (const [label, directory] of [
  ["Ghostty terminal", ".sources/ghostty-webgpu"],
  ["Waffle runtime", "node_modules/waffle"],
  ["Hotkeys", "node_modules/@fregat/hotkeys"],
  ["Remix component", "node_modules/remix"],
  ["Coreutils", "node_modules/waffle-coreutils"],
  ["Findutils", "node_modules/waffle-findutils"],
  ["Grep", "node_modules/waffle-grep"],
  ["Sed", "node_modules/waffle-sed"],
  ["Ripgrep", "node_modules/waffle-ripgrep"],
]) {
  const names = await noticeNames(directory);
  names.sort();
  if (names.length === 0) throw new Error(`No license notices found for ${label}`);
  for (const name of names) {
    text += `\n## ${label} / ${name}\n\n${await readFile(resolve(root, directory, name), "utf8")}\n`;
  }
}
text += `\n${await readFile(resolve(root, "node_modules/waffle-ripgrep/dist/rg.NOTICES.txt"), "utf8")}`;
await mkdir(resolve(root, "public"), { recursive: true });
await writeFile(resolve(root, "public/THIRD_PARTY_NOTICES.txt"), text);
