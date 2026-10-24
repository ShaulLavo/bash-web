# Getting started

In this tutorial you build the bash-web shell engine, run scripts on it, and see where its edges are. You need `git` and Rust through [rustup](https://rustup.rs). It takes a few minutes, most of it compiling.

The engine runs natively here, so you can try it without a browser. Putting the shell in a web page is the next step, after this one.

## Build the engine

First, clone the repository and build the engine. rustup reads `rust-toolchain.toml` and installs Rust 1.98.1 the first time, which adds download time.

```sh
git clone https://github.com/ShaulLavo/bash-web.git
cd bash-web
cargo build --release --locked --manifest-path shell/Cargo.toml -p shell-engine --bin shell-engine
```

The build ends with a line like this:

```text
    Finished `release` profile [optimized] target(s) in 1m 30s
```

The binary is `shell/target/release/shell-engine`. It runs one script from `-c`, with empty standard input.

## Run a script

Now run something small and check the exit status.

```sh
shell/target/release/shell-engine -c 'echo hello; exit 7'
echo "shell exit: $?"
```

```text
hello
shell exit: 7
```

The shell's exit status is the script's status. Next, try functions, arrays, quoting, arithmetic, and conditionals:

```sh
shell/target/release/shell-engine -c '
greet() { echo "hello, $1"; }
for name in web wasm; do greet "$name"; done
words=(a b c)
echo "${#words[@]} words, first is ${words[0]}"
printf "%q\n" "two words"
echo $((6 * 7))
if [[ -z "$NOT_SET" ]]; then echo "unset"; fi
'
```

```text
hello, web
hello, wasm
3 words, first is a
two\ words
42
unset
```

## See what the core does not include

The engine has no external commands. Run one and look at the status.

```sh
shell/target/release/shell-engine -c 'seq 3; echo "seq exited $?"'
```

```text
seq exited 127
/usr/bin/bash: seq: command not found
```

Status 127 is what any shell reports for a command it cannot find. In a page, you install `cat`, `grep`, `mkdir`, and `seq` as separate programs when you need them. This binary has no way to install them, so the next step builds a second binary that links them in.

## Run a pipeline

Build `shell-cli`. It is the engine composed with the four utilities, the harness the repository's fuzzers use.

```sh
cargo build --release --locked --manifest-path shell/Cargo.toml -p shell-compat-fixtures --bin shell-cli
shell/target/release/shell-cli -c 'seq 1 100000 | grep -c 9999'
```

```text
19
```

Each pipeline stage is a task on the engine's single thread. The pipe between them holds a bounded amount of data, so a fast `seq` waits for `grep` instead of filling memory. Files go to an in-memory filesystem that exists for one run:

```sh
shell/target/release/shell-cli -c 'mkdir -p /tmp/demo/a; echo hi > /tmp/demo/a/f; cat /tmp/demo/a/f'
ls /tmp/demo
```

```text
hi
ls: /tmp/demo: No such file or directory
```

The script saw its `/tmp/demo`. Your disk never did.

## Where to go next

- Put the shell in a web page: [Embed a shell in a page](guides/embed-in-a-page.md). That path needs the WASI build, so check [Development](development.md#prerequisites) first.
- Learn how the pieces fit: [How bash-web works](concepts/architecture.md).
- See what works and what does not: [Status and limits](status.md).
- Run the test suite: `npm ci && npm run test:rust` ([Development](development.md#build-and-test)).
