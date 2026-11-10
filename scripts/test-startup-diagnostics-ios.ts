import { nativeMainWithDiagnostics } from "../tests/ios/host-diagnostic-delivery";
import { createStartupAdapter } from "../tests/ios/startup-diagnostics";

const args = process.argv.slice(2);
process.exitCode = await nativeMainWithDiagnostics(
  await createStartupAdapter(args[1] ?? ""),
  args,
  (value) =>
    value !== null && typeof value === "object" && "diagnostic" in value
      ? value.diagnostic
      : undefined,
);
