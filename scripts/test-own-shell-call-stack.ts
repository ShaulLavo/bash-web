import { recordedBashTests } from "./recorded-bash-tests.ts";

await recordedBashTests("call stack", new URL("fixtures/shell-call-stack.json", import.meta.url));
