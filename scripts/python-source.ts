export const pythonSource = {
  version: "3.15.2",
  revision: "5e58eaad7c58df58dfa8ea549c87996e01dd1077",
  tag: "v3.15.2",
  tagObject: "a4ed3466611d5941876ff91610601eb29543a5ff",
  archiveUrl: "https://www.python.org/ftp/python/3.15.2/Python-3.15.2.tar.xz",
  archiveSha256: "8b5536d280142ecf6cdfe15d12a21ba1c65e300bbf7b28a8d0cdb849575797de",
  archiveBytes: 27960396,
  argv0: "/cross-build/wasm32-wasip1/python.wasm",
} as const;

export interface PythonPayloadFile {
  readonly path: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PythonPayloadManifest {
  readonly format: 1;
  readonly cpython: typeof pythonSource.revision;
  readonly argv0: typeof pythonSource.argv0;
  readonly files: readonly PythonPayloadFile[];
}
