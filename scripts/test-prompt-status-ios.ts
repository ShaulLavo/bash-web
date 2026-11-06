import { nativeMain } from "waffle/testing/page-runner";
import { promptStatusAdapter } from "../tests/ios/prompt-status-adapter.ts";

process.exitCode = await nativeMain(promptStatusAdapter, process.argv.slice(2));
