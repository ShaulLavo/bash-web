import { buildWc } from "./build-wc.ts";
import { buildWasiShell } from "./wasi-build.ts";

buildWc();
buildWasiShell(["--workspace", "--exclude", "shell-wc"]);
