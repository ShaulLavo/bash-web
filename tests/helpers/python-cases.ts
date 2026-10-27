export const pythonVersion = "Python 3.15.2\n";
export const pythonArgv0 = "/cross-build/wasm32-wasip1/python.wasm";
export const pythonDirectory = "/tmp/python-spec";
export const pythonEnvironment = {
  PATH: "/bin",
  HOME: "/home/guest",
  LC_ALL: "C.UTF-8",
  LANG: "C.UTF-8",
  TZ: "UTC",
  PYTHONDONTWRITEBYTECODE: "1",
};

export const pythonFiles: Record<string, string> = {
  "script.py":
    'import json, os, sys\nprint(json.dumps([os.path.basename(__file__), sys.argv[1:]], ensure_ascii=False))\n',
  "input.txt": "alpha\nβeta\n",
};

export interface PythonCase {
  readonly name: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

function command(name: string, code: string, stdout: string): PythonCase {
  return { name, args: ["-c", code], stdin: "", stdout, stderr: "", status: 0 };
}

export const pythonCases: readonly PythonCase[] = [
  command("-c runs real arithmetic", "print(sum(i*i for i in range(1000)))", "332833500\n"),
  command(
    "imports json, os, sys and generated sysconfig",
    'import json, os, sys, sysconfig; print(json.dumps([json.loads(\'{"n": 7}\')["n"], os.getcwd().rsplit("/", 1)[-1], sys.implementation.name, isinstance(sysconfig.get_paths(), dict), isinstance(sysconfig.get_config_var("prefix"), str)]))',
    '[7, "python-spec", "cpython", true, true]\n',
  ),
  {
    name: "-c keeps empty, spaced, Unicode and option-like arguments",
    args: ["-c", "import json, sys; print(json.dumps(sys.argv, ensure_ascii=False))", "", "two words", "β", "--flag"],
    stdin: "",
    stdout: '["-c", "", "two words", "β", "--flag"]\n',
    stderr: "",
    status: 0,
  },
  {
    name: "script file and its arguments",
    args: ["script.py", "one", "two words", "", "β"],
    stdin: "",
    stdout: '["script.py", ["one", "two words", "", "β"]]\n',
    stderr: "",
    status: 0,
  },
  {
    name: "stdin contains a Python script",
    args: ["-", "argument"],
    stdin: 'import json, sys\nprint(json.dumps(sys.argv))\nprint("stdin script")\n',
    stdout: '["-", "argument"]\nstdin script\n',
    stderr: "",
    status: 0,
  },
  {
    name: "-c reads stdin through EOF",
    args: ["-c", "import sys; data = sys.stdin.buffer.read(); sys.stdout.buffer.write(data.upper())"],
    stdin: "alpha\nbeta\n",
    stdout: "ALPHA\nBETA\n",
    stderr: "",
    status: 0,
  },
  command(
    "reads a UTF-8 file from the caller filesystem",
    'from pathlib import Path; print(Path("input.txt").read_text(encoding="utf-8"), end="")',
    "alpha\nβeta\n",
  ),
  command(
    "writes, renames and reads binary files",
    'from pathlib import Path; p = Path("created.bin"); p.write_bytes(bytes([0, 255, 10, 195, 169])); p.rename("renamed.bin"); print(list(Path("renamed.bin").read_bytes()))',
    "[0, 255, 10, 195, 169]\n",
  ),
  command(
    "os environment and cwd reach the guest",
    'import os; print(os.environ["HOME"]); print(os.path.basename(os.getcwd()))',
    "/home/guest\npython-spec\n",
  ),
  {
    name: "stdout, stderr and exit 7 remain separate",
    args: ["-c", 'import sys; print("out"); print("err", file=sys.stderr); sys.exit(7)'],
    stdin: "",
    stdout: "out\n",
    stderr: "err\n",
    status: 7,
  },
  command("stdout drains beyond the terminal ring", 'import sys; sys.stdout.write("0123456789" * 40000)', "0123456789".repeat(40000)),
  {
    name: "stderr drains beyond a pipe buffer",
    args: ["-c", 'import sys; sys.stderr.write("diagnostic\\n" * 10000); sys.exit(7)'],
    stdin: "",
    stdout: "",
    stderr: "diagnostic\n".repeat(10000),
    status: 7,
  },
];

export function pythonShellCommand(example: Pick<PythonCase, "args">): string {
  const args = example.args.map((argument) => `'${argument.replaceAll("'", "'\\''")}'`);
  return `python ${args.join(" ")} < ${pythonDirectory}/stdin`;
}
