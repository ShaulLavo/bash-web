import { build } from "esbuild";

const fixtureSource = `
import { BrowserSession } from "bash-web/session";
import { SharedBridge } from "./src/bridge";
const output = [], states = [], consumed = [];
let turns = 0, disposed = 0, maximumDelivery = 0, acknowledgements = 0, terminalBytes = -1;
const drain = SharedBridge.prototype.drain;
SharedBridge.prototype.drain = function(...args) { turns++; return drain.apply(this,args); };
const session = await BrowserSession.create({
  runtime: {filesystem:{state:{status:"ready"}}}, cols:80, rows:24,
  onOutput(bytes) { maximumDelivery = Math.max(maximumDelivery,bytes.length); for(const byte of bytes) output.push(byte); },
  onState(state) { states.push(state); if(state === "exited" || state === "failed") terminalBytes = output.length; }
});
const workerURL = URL.createObjectURL(new Blob([PRODUCER], {type:"text/javascript"}));
const worker = new Worker(workerURL,{type:"module"});
worker.onmessage = ({data}) => { acknowledgements++; if(data.bytes) consumed.push(...data.bytes); };
worker.postMessage({kind:"init",buffer:globalThis.drainBridge.buffer});
window.sessionDrain = {
  output, states, consumed,
  get turns() { return turns; }, get disposed() { return disposed; },
  get terminalBytes() {return terminalBytes;},
  race() {
    const wait = Atomics.waitAsync;
    Atomics.waitAsync = (...args) => {
      Atomics.waitAsync = wait;
      globalThis.drainBridge.tryWrite([Uint8Array.of(77)]);
      return wait(...args);
    };
    globalThis.drainBridge.signal();
  },
  get maximumDelivery() { return maximumDelivery; }, get acknowledgements() { return acknowledgements; },
  input(bytes) {session.input(new Uint8Array(bytes));},
  action(kind,bytes) {worker.postMessage({kind,bytes});},
  async dispose() {await session.dispose(); disposed++; worker.terminate(); URL.revokeObjectURL(workerURL);}
};
`;

const stub = `
export { SharedBridge } from "./src/bridge";
export { TerminalNewlines } from "./src/shell-terminal-output";
import { waitForPrompt } from "./src/shell-prompt";
export function runtimeSnapshot() { return {}; }
export async function createShell({terminal}) {
  globalThis.drainBridge = terminal;
  terminal.publishPrompt(0);
  return {process:{wasmBytes:0},done:new Promise(()=>{}),waitForPrompt(options) {return waitForPrompt(terminal, options);},interrupt(){},async dispose(){}};
}
`;

const producerSource = `
import { SharedBridge, control } from "./src/bridge";
import { shellTerminalImports } from "./src/runtime/guest-imports";
let bridge;
onmessage = ({data}) => {
  if(data.kind === "init") {bridge = new SharedBridge(data.buffer); postMessage({}); return;}
  if(data.kind === "write") bridge.write(new Uint8Array(data.bytes));
  if(data.kind === "burst") for(let i=0;i<1000;i++) bridge.tryWrite([Uint8Array.of(32+i%200)]);
  if(data.kind === "phase") shellTerminalImports(bridge.buffer).phase(data.bytes[0], 0);
  if(data.kind === "consume") {const bytes = new Uint8Array(65536);const count = bridge.tryRead([bytes]);postMessage({bytes:Array.from(bytes.subarray(0,Math.max(0,count)))});return;}
  if(data.kind === "receive") {postMessage({bytes:Array.from(bridge.receive(65536))}); return;}
  if(data.kind === "lock") Atomics.store(bridge.state,control.inputLock,1);
  if(data.kind === "unlock") {Atomics.store(bridge.state,control.inputLock,0);bridge.signal();}
  if(data.kind === "exit" || data.kind === "fail") {
    bridge.write(new Uint8Array(data.bytes));
    Atomics.store(bridge.state,control.phase,data.kind === "exit" ? 3 : 4);
    bridge.signal();
  }
  postMessage({});
};
`;

export async function prepareSessionDrainFixture() {
  const worker = await build({
    stdin: { contents: producerSource, resolveDir: process.cwd(), sourcefile: "drain-producer.js" },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const producer = worker.outputFiles[0].text;
  const output = await build({
    stdin: {
      contents: fixtureSource.replace("PRODUCER", JSON.stringify(producer)),
      resolveDir: process.cwd(),
      sourcefile: "drain-fixture.js",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    plugins: [
      {
        name: "shell-admission-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/index$/ }, () => ({
            path: "shell-admission-fixture",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: stub,
            resolveDir: process.cwd(),
          }));
        },
      },
    ],
  });
  const fixture = output.outputFiles[0].text;
  return { fixture, producer };
}
