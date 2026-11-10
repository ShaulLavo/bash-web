import { nativeMain } from "waffle/testing/page-runner";
import { createPythonAdapter } from "../tests/ios/python-adapter";

const args = process.argv.slice(2);
process.exitCode = await nativeMain(await createPythonAdapter(args[1] ?? ""), args);
