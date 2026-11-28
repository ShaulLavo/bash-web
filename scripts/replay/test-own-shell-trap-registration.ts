import { recordedBashTests } from "./recorded-bash-tests.ts";
import rejections from "../owned-fixtures/trap-registration-rejections.json" with { type: "json" };

await recordedBashTests(
  "trap",
  new URL("../fixtures/shell-trap-registration.json", import.meta.url),
  rejections,
);
