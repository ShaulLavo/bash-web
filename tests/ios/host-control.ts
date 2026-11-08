import type { HostCase } from "waffle/testing/page-runner";

export const unusedHostCapabilities: Pick<HostCase, "holdAsset" | "openPeer" | "setTimeout"> = {
  holdAsset() {
    throw new Error("This host control does not hold assets");
  },
  async openPeer() {
    throw new Error("This host control does not open peers");
  },
  setTimeout() {
    throw new Error("This host control does not mutate body deadlines");
  },
};
