import type { Wasi } from "waffle/core/wasi";

const names = ["access_start", "access_take", "access_cancel", "poll"] as const;
let queryModule: WebAssembly.Module | undefined;

function encodedName(value: string): number[] {
  return [value.length].concat(Array.from(value, (character) => character.charCodeAt(0)));
}

function importsModule(): WebAssembly.Module {
  // Import-only declarations: (i32 x5)->i32, (i32)->i32, (i32 x4)->i32.
  // These fixed sections are shorter than 128 bytes, so their lengths use one byte.
  const types = [
    3, 0x60, 5, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 4, 0x7f, 0x7f,
    0x7f, 0x7f, 1, 0x7f,
  ];
  const signatures = [0, 1, 1, 2];
  const imports = Array.of<number>(names.length).concat(
    names.flatMap((name, index) =>
      encodedName("runtime_proc").concat(encodedName(name), [0, signatures[index]]),
    ),
  );
  const bytes = [0, 97, 115, 109, 1, 0, 0, 0].concat(
    [1, types.length],
    types,
    [2, imports.length],
    imports,
  );
  // Use only the public import resolver. No instance, candidate code, descriptors,
  // or private Waffle bootstrap state belongs to this declaration module.
  queryModule ??= new WebAssembly.Module(Uint8Array.from(bytes));
  return queryModule;
}

/** Ordinary guests cannot import runtime_proc themselves. This lookup-only
 * namespace forwards to Waffle's own guarded functions, without replacing them. */
export function createExecutableQuery() {
  let bound: WebAssembly.ModuleImports | undefined;
  const namespace = Object.fromEntries(
    names.map((name) => [
      name,
      (...args: number[]) => {
        const call = bound?.[name];
        if (typeof call !== "function")
          throw new TypeError(`Waffle executable query requires ${name}`);
        return call(...args);
      },
    ]),
  );
  return {
    namespace,
    bind(wasi: Pick<Wasi, "imports">) {
      bound = wasi.imports(importsModule()).runtime_proc;
      for (const name of names)
        if (typeof bound?.[name] !== "function")
          throw new TypeError(`Waffle executable query requires ${name}`);
    },
  };
}
