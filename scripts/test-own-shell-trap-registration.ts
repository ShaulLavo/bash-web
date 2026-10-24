import { recordedBashTests } from "./recorded-bash-tests.ts";

await recordedBashTests("trap", new URL("fixtures/shell-trap-registration.json", import.meta.url));
await recordedBashTests("trap action", new URL("fixtures/shell-trap-actions.json", import.meta.url));
