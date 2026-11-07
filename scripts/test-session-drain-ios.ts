import { nativeMain } from "waffle/testing/page-runner";
import { sessionDrainAdapter } from "../tests/ios/session-drain";

process.exit(await nativeMain(sessionDrainAdapter, process.argv.slice(2)));
