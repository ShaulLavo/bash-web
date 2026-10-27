# Build the Python assets

Run `node scripts/build-python.ts --output dist` with Node 26, Python 3.11 or newer, a native C compiler, make, wasi-sdk 34.0, and Wasmtime on `PATH`. Set `WASI_SDK_PATH` to the SDK directory. The build uses CPython's official `Platforms/WASI` stages and the existing Waffle patched-libc helper. It does not build the shell or other utilities.

The source is CPython 3.15.2, commit `5e58eaad7c58df58dfa8ea549c87996e01dd1077`. The official source archive SHA-256 is `8b5536d280142ecf6cdfe15d12a21ba1c65e300bbf7b28a8d0cdb849575797de`. The build keeps the upstream sources unchanged, selects the patched sysroot through supported compiler flags, and sets an exact 256 MiB memory maximum. Threads, subprocesses, sockets, and native extension loading are outside this slice.

The output directory contains separate `python.wasm` and `python-stdlib.json` assets. The manifest describes every regular file in the full initial `Lib/` tree, the actual `pybuilddir.txt`, and the full generated sysconfig directory. Each entry records a canonical guest path, a URL relative to the manifest, a byte count, and SHA-256. Empty files remain included. The interpreter is not copied into the guest filesystem.

The interpreter's argv0 must be `/cross-build/wasm32-wasip1/python.wasm`. The marker and generated tree retain CPython's build layout so `sysconfig` discovers the actual WASI configuration. The caller owns the Waffle runtime and first-use loading.

`python-build.json` records source, toolchain, imports, exports, memory, and asset identities. `python.NOTICES.txt` retains the upstream license, incorporated-software notices, and bundled-wheel notices. The full stdlib keeps its embedded notices and test data.

To reuse an already built artifact, run `node scripts/build-python.ts --stage /absolute/artifact --output dist`. Staging validates the artifact before copying and does not compile. Run `node --test scripts/test-python-build.ts` for the build-tool checks. Browser acceptance is a separate consumer of this one artifact.
