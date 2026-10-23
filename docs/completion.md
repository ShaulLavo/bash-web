# Non-interactive completion commands

`compgen` generates candidates without an interactive editor. `complete` stores completion rules, and `compopt` changes a stored rule's options.

## Completion rules

`complete` accepts clustered action flags, `-A`, `-o`, and attached or separate text arguments. It retains `-G`, `-W`, `-P`, `-S`, `-X`, `-C`, and `-F`. `complete -p` prints reusable shell commands, and `complete -r` removes rules. The `-D`, `-E`, and `-I` selectors address distinct special rules. When combined, `-D` wins over `-E`, which wins over `-I`.

`compopt -o option name` enables an option. `compopt +o option name` disables it. A disabled option wins if the same invocation also enables it. Without changes, `compopt name` prints every enabled and disabled option. Without a name, it fails outside a running completion callback.

Rules belong to shell state. Isolated shells share immutable rule storage until a change creates an admitted replacement. Failed admission or cancellation leaves the previous table intact.

## Candidate generation

`compgen -W` splits the supplied text at unquoted IFS characters before brace expansion. It then performs parameter, arithmetic, and command substitution and field splitting. It does not expand filename patterns in the word list. Word order and repetitions survive.

`-P` and `-S` add a prefix and suffix after filtering. `-X` removes matching candidates, or keeps matching candidates when its pattern starts with `!`. An unescaped `&` in the pattern expands to the completion word.

File and directory candidates use the runtime's directory reader. Command candidates combine the shell's actual keywords, functions, builtins, and executable registrations on PATH. A readable file is not necessarily executable. User, group, host, and service candidates read the runtime's `/etc/passwd`, `/etc/group`, `/etc/hosts`, and `/etc/services`. Missing databases produce no candidates.

`-o default`, `-o dirnames`, and `-o plusdirs` enable the corresponding file or directory fallback. Formatting options are stored and printed but do not affect newline-separated output.

## Remaining limits

Completion callbacks supplied by `-F` and `-C` can be registered and printed, but `compgen` cannot execute them yet. Alias generation has no candidates until alias state exists. Readline binding and job-command generators return an unsupported status. No interactive line editing is implemented.

The recorded Bash controls and runtime-backed filesystem checks run with `node --test scripts/test-own-shell-completion.ts` after the normal shell and Node-harness builds. The fixture records GNU Bash 5.3.15 output and does not invoke the CI host's Bash.
