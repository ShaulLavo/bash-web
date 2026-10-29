// Adapted from brush-web runtime/guest-imports.ts at a2a4e96.
// Original adapter helpers: the guest fd namespace and root-only shell phase ownership.
import { SharedBridge, control } from "../bridge";

export function shellTerminalImports(
  buffer?: SharedArrayBuffer,
  inherited: readonly number[] = [0, 1, 2],
) {
  return {
    // Enumerate only the launch bindings, never the root preopen or private fds
    // allocated while the guest bootstraps. Sparse large fd numbers cost one entry.
    inherited_fd(index: number) {
      return inherited[index] ?? -1;
    },
    columns() {
      return buffer ? Math.max(2, Atomics.load(new SharedBridge(buffer).state, control.cols)) : 80;
    },
    rows() {
      return buffer ? Math.max(2, Atomics.load(new SharedBridge(buffer).state, control.rows)) : 24;
    },
    phase(phase: number) {
      if (!buffer) return;
      const bridge = new SharedBridge(buffer);
      if (bridge.closed() || (phase !== 1 && phase !== 2)) return;
      if (Atomics.exchange(bridge.state, control.phase, phase) !== phase) bridge.signal();
    },
  };
}
