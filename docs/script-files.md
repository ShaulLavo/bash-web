# Named shell scripts

The runtime guest accepts `sh FILE [ARG...]` alongside interactive startup and `-c SCRIPT [NAME [ARG...]]`. The supplied file path becomes `$0`; subsequent operands become literal positional parameters, including empty strings and spaces. Relative paths resolve against the existing working directory. Loading does not change that directory or search `PATH`.

The Session `start_file(name, args)` entry opens and reads through the engine filesystem. The read is cancellable and bounded by `source_bytes`, validates UTF-8, and admits source storage before growth. Name and argument storage use the same checked execution budget as command-string startup. File identity follows ordinary parser/execution diagnostics and stored functions.

Missing files return 127, unreadable files/directories return 126, source/UTF-8/storage failures return 2, and interruption returns 130. Otherwise the script's ordinary status is returned. Syntax diagnostics include the supplied filename and line.

Stdin scripts, login shells and general option parsing are not supported. In particular `-e`, `-`, and `--` are rejected rather than treated as filenames. A path such as `./-e` can name a file normally.

The maintained native and WASI startup tests cover literal arguments, cwd, errors, source limits and cancellation. Direct interpreter argv with a plain `#!/bin/sh` file is tested. Actual browser shebang dispatch remains separately blocked on Waffle r515; these tests do not establish that integration or the independent env/node path.
