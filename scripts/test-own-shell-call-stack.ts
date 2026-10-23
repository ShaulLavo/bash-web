import { recordedBashTests } from "./recorded-bash-tests.ts";

await recordedBashTests("call stack", new URL("fixtures/shell-call-stack.json", import.meta.url));

await recordedBashTests(
  "call stack unset",
  new URL("fixtures/shell-call-stack-unset.json", import.meta.url),
);
