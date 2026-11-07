import { nativeMainWithDiagnostics } from "../tests/ios/host-diagnostic-delivery.ts";
import { promptStatusAdapter } from "../tests/ios/prompt-status-adapter.ts";

process.exitCode = await nativeMainWithDiagnostics(
  promptStatusAdapter,
  process.argv.slice(2),
  (result) => result,
);
