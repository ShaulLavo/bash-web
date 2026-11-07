import { nativeMainWithDiagnostics } from "../tests/ios/host-diagnostic-delivery.ts";
import { sessionDrainAdapter } from "../tests/ios/session-drain";
import { selectSessionDrainDiagnostic } from "../tests/ios/session-drain-support";

process.exitCode = await nativeMainWithDiagnostics(
  sessionDrainAdapter,
  process.argv.slice(2),
  selectSessionDrainDiagnostic,
);
