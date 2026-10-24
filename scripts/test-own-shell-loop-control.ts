import { recordedBashTests } from "./recorded-bash-tests.ts";

await recordedBashTests(
  "loop control",
  new URL("observations/shell-loop-control.json", import.meta.url),
);
