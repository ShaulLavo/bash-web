import { nativeMainWithDiagnostics } from "../tests/ios/host-diagnostic-delivery.ts";
import { createPromptHookAdapter } from "../tests/ios/prompt-hook-adapter.ts";

const args = process.argv.slice(2);
process.exitCode = await nativeMainWithDiagnostics(
  createPromptHookAdapter(args[1] ?? ""),
  args,
  (result) => result,
);
