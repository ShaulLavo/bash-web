import { readGuest, shell } from "./own-shell-waffle-fixture.ts";

export { api, directory, nodeDirectory } from "./own-shell-waffle-fixture.ts";

export const readWasiSource = readGuest;

export async function readShell() {
  return shell;
}
