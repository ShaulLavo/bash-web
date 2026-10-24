import { recordedBashTests } from "./recorded-bash-tests.ts";

await recordedBashTests("enable", new URL("fixtures/shell-enable.json", import.meta.url));
