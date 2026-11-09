# Native process lifecycle

The shell borrows its page's Waffle runtime. Waffle owns each process's canonical directory outcome and observation token. The shell passes that directory transport to the worker without creating another outcome representation.

## Completion and native return

Logical completion selects an exit, signal, or startup failure. An observer can read that selected result until the native consumer returns from termination. A successful `terminate()` that returns `void` expires the observation immediately. A returned promise expires it on fulfillment. A thrown exception or rejected promise does not certify successful termination.

After that boundary, an existing or newly acquired observer reads `terminated`, not the old exact exit result. A shell captures its native-return callback before asynchronous startup, including before root adoption. Cancellation before a worker exists expires the unlaunched process through the same callback.

The root host joins its terminal fences before stopping the worker. Filesystem cleanup, runtime memory accounting, descendant cleanup, and root retirement keep their own obligations. Observation expiry does not release those obligations. It is not proof that a browser worker has physically closed every reader. `done` remains logical completion; `dispose()` joins the shell's cleanup without disposing the borrowed runtime.

## Late worker startup

The shell worker calls Waffle bootstrap synchronously. Constructing the shell executor can still fail if terminal attachment loses a race with process completion or collection. The entry passes that construction failure into bootstrap's setup hook. Bootstrap captures the canonical observer before deciding whether to report the selected result, stop an expired execution, or report a genuine startup error. Its filesystem cleanup still runs.

The adapter does not add a launch quota, synthesize a signal from an observation error, or support an older lifecycle shape. Child launch and native ownership remain Waffle services.

## Verification scope

`npm run test:runtime:terminal` discovers `src/runtime/native-return.test.ts` in normal CI. Its CPU Workers import the emitted production shell worker, execute a real guest as a positive control, and inspect the canonical observation in the worker context. Controls cover held, void, fulfilled, throwing, rejected, reentrant, pre-adoption, and late-acquisition paths. These CPU checks do not establish native iOS acceptance or physical reader closure.
