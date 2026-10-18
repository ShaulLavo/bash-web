import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
let text = await readFile(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
for (const [label, directory] of [
  ["Ghostty terminal", ".sources/ghostty-webgpu"],
  ["Waffle runtime", "node_modules/waffle"],
  ["Hotkeys", "node_modules/@fregat/hotkeys"],
  ["Remix component", "node_modules/remix"],
]) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && /license|notice/i.test(entry.name))
    .map((entry) => entry.name);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^licenses$/i.test(entry.name)) continue;
    const children = await readdir(resolve(root, directory, entry.name), { withFileTypes: true });
    for (const child of children) if (child.isFile()) names.push(`${entry.name}/${child.name}`);
  }
  names.sort();
  if (names.length === 0) throw new Error(`No license notices found for ${label}`);
  for (const name of names) {
    text += `\n## ${label} / ${name}\n\n${await readFile(resolve(root, directory, name), "utf8")}\n`;
  }
}
await mkdir(resolve(root, "public"), { recursive: true });
await writeFile(resolve(root, "public/THIRD_PARTY_NOTICES.txt"), text);
